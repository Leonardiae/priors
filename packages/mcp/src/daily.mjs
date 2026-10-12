// Daily limits that survive a restart (0.8.0): PRIORS_MAX_SPEND_DAY_USD (what pay_url may sign) and
// PRIORS_MAX_BORROW_DAY_USD (what borrow, pay_url and fund_base may borrow), per agent and per UTC day, counted across
// every process that shares PRIORS_STATE_DIR. The per-run limits (PRIORS_MAX_SPEND_USD, PRIORS_MAX_BORROW_TOTAL_USD)
// start again from zero whenever the server restarts, and an agent's runtime restarts it as often as it likes; these
// do not.
//
// A ledger is a directory per owner and day, <state dir>/daily-<owner>/<YYYY-MM-DD>/, holding one empty file per
// money call whose NAME is the call's amounts: `<signed>-<borrowed>-<pid>-<random>.r`, in USDG base units. A call
// reserves the most it may sign and borrow BEFORE its check passes (its file is created first, then the directory is
// listed and every file in it summed, its own included), and once it ends its file is renamed to what it really did
// (removed when that is nothing). Two processes on one state dir can never both pass a limit together: whichever
// creates its file second lists both files. Both may refuse when they race for the last room, which is the safe
// direction. Creating a file (O_EXCL) and renaming one are atomic on every local file system, and a name is never
// half-written, so there is no lock to go stale and nothing to parse. A process that dies in the middle of a call
// leaves its reservation at its most, counted for the rest of that day (as a borrow whose answer was lost stays counted).
//
// Every call counts in two ledgers and must fit in both. The agent's, "agent-<id>", from PRIORS_AGENT_ID, which a
// daily limit requires: every key and every process acting for that agent shares one count, whichever client it runs
// in (a count named after the wallet when the id was left out split one agent's day in two). And the wallet's,
// "wallet-<address>": a key run under another agent id, by mistake or for a second agent it controls, still shares
// one count of the money it holds. All of a call's files are created before any ledger is listed, so the argument
// above holds in each. Money counts in the UTC day it lands (GHSA-266h). A call reserves in the day it starts, and also
// leaves a marker in <owner>/pending/, named after that day and its amounts, which every process counts in each day
// after it (up to PENDING_DAYS) for as long as the call is in flight, however long its transaction takes to mine. Once
// it ends, its entry becomes what it did, filed in the day it ended (never in a day before the one it started: a
// clock set back moves nothing back), and only then does its marker go. So a borrow sent before 00:00 UTC that lands
// after counts in the new day, and while it is still in flight a call another process makes after midnight already
// sees it. A process that dies mid-call leaves its entry at its most in the day it started and its marker counted
// PENDING_DAYS days more, the safe direction. Days before yesterday, and markers older than that count, are deleted as
// new days begin. A file whose name is not a ledger entry is left alone and not counted.
// SHORTCUT: a call still in flight more than PENDING_DAYS days after the day it started stops counting in later days.
// Ceiling: none on this chain, whose sequencer includes or refuses a transaction within seconds and whose forced
// inclusion is bounded to 24 h. Upgrade trigger: a money call that can stay in flight longer.
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ENTRY = /^(\d{1,30})-(\d{1,30})-\d{1,10}-[0-9a-f]{16}\.r$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OWNER = /^(agent-\d{1,78}|wallet-0x[0-9a-f]{40})$/;
const PENDING = "pending";
const MARKER = /^(\d{4}-\d{2}-\d{2})_(\d{1,30})-(\d{1,30})-\d{1,10}-[0-9a-f]{16}\.r$/;
/** The days after the one it started in which a call still in flight is counted. */
export const PENDING_DAYS = 2;

/** The UTC date of `ms` (YYYY-MM-DD). */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayPlus = (day, n) => utcDay(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000);

/** The agent PRIORS_AGENT_ID names, as a BigInt (leading zeros dropped: 007 and 7 are one agent), or null when it is
 *  not a decimal id. */
export function agentOf(agentIdEnv) {
  const s = String(agentIdEnv ?? "").trim();
  return /^\d{1,78}$/.test(s) ? BigInt(s) : null;
}

/** The ledgers a server counts in: ["agent-<id>", "wallet-<address>"] (the address in lowercase), or null when
 *  PRIORS_AGENT_ID is not a decimal agent id (a daily limit then stops the start). */
export function ledgerOwners(agentIdEnv, walletAddress) {
  const id = agentOf(agentIdEnv);
  if (id === null) return null;
  return [`agent-${id}`, `wallet-${String(walletAddress).toLowerCase()}`];
}

/** What is counted today: { signed, borrowed } in base units, summed over every entry of `dir`. */
function sum(dir, fs) {
  let signed = 0n, borrowed = 0n;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e?.code === "ENOENT") return { signed, borrowed }; throw e; }
  for (const n of names) { const m = ENTRY.exec(n); if (m) { signed += BigInt(m[1]); borrowed += BigInt(m[2]); } }
  return { signed, borrowed };
}

/** What calls started in the PENDING_DAYS days before `day` and still in flight hold: their markers in `pdir`. */
function inFlight(pdir, day, fs) {
  let signed = 0n, borrowed = 0n;
  let names;
  try { names = fs.readdirSync(pdir); } catch (e) { if (e?.code === "ENOENT") return { signed, borrowed }; throw e; }
  const oldest = dayPlus(day, -PENDING_DAYS);
  for (const n of names) {
    const m = MARKER.exec(n);
    if (m && m[1] < day && m[1] >= oldest) { signed += BigInt(m[2]); borrowed += BigInt(m[3]); }
  }
  return { signed, borrowed };
}

/**
 * A daily ledger under `stateDir` that counts in every one of `owners` (ledgerOwners; or `owner`, one name).
 * `caps.signed` / `caps.borrowed` are base units, or null for no limit of that kind; each holds in every owner's
 * ledger. `now` and `fs` are replaceable for tests.
 */
export function dailyLedger({ stateDir, owners, owner, caps, now = () => Date.now(), fs = { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, unlinkSync } }) {
  const list = owners ?? [owner];
  if (!list.length || !list.every((o) => OWNER.test(String(o)))) throw new Error(`not a daily ledger owner: ${list.join(", ")}`);
  const rootOf = (o) => join(stateDir, `daily-${o}`);
  const swept = new Map();
  /** Days before yesterday, and markers no day counts any more, go, once per owner and new day (best effort: a leftover
   *  is never read again). */
  function sweep(o, today) {
    if (swept.get(o) === today) return;
    swept.set(o, today);
    const yesterday = dayPlus(today, -1), oldest = dayPlus(today, -PENDING_DAYS);
    try { for (const d of fs.readdirSync(rootOf(o))) if (DAY.test(d) && d < yesterday) fs.rmSync(join(rootOf(o), d), { recursive: true, force: true }); } catch (_) { /* best effort */ }
    try {
      for (const n of fs.readdirSync(join(rootOf(o), PENDING))) {
        const m = MARKER.exec(n);
        if (m && m[1] < oldest) fs.unlinkSync(join(rootOf(o), PENDING, n));
      }
    } catch (_) { /* best effort */ }
  }
  const entryName = (s, b) => `${s}-${b}-${process.pid}-${randomBytes(8).toString("hex")}.r`;
  /** Takes a call's files back (a refusal, or a ledger that could not be written): best effort, since one left behind
   *  only counts too much, the safe direction. */
  const drop = (files) => { for (const f of files) { try { fs.unlinkSync(join(f.dir, f.name)); } catch (_) { /* counted */ } } };
  /** What an owner's ledger holds on `day`: that day's entries, and the calls started before it still in flight. */
  const totalOn = (o, day) => {
    const a = sum(join(rootOf(o), day), fs), p = inFlight(join(rootOf(o), PENDING), day, fs);
    return { signed: a.signed + p.signed, borrowed: a.borrowed + p.borrowed };
  };
  return {
    caps,
    owners: list,
    /** Today's totals: for each kind, the most any of the owners' ledgers holds (what the limits are held against). */
    used() {
      const day = utcDay(now());
      const out = { signed: 0n, borrowed: 0n };
      for (const o of list) {
        const t = totalOn(o, day);
        if (t.signed > out.signed) out.signed = t.signed;
        if (t.borrowed > out.borrowed) out.borrowed = t.borrowed;
      }
      return out;
    },
    /**
     * Reserve `signed` and `borrowed` (base units) for one call in every owner's ledger, or throw { code: "DAY_LIMIT",
     * kind, owner, used, cap, want } when either would pass its limit in any of them (nothing is then kept), or the file
     * system's error when a ledger cannot be written (nothing is then kept, and nothing may be signed or borrowed: the
     * limit could not be kept).
     */
    reserve(signed, borrowed) {
      const day = utcDay(now());
      const files = [];
      try {
        for (const o of list) {
          sweep(o, day);
          const dir = join(rootOf(o), day), pdir = join(rootOf(o), PENDING);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.mkdirSync(pdir, { recursive: true, mode: 0o700 });
          const name = entryName(signed, borrowed);
          fs.closeSync(fs.openSync(join(dir, name), "wx", 0o600));
          files.push({ owner: o, day, dir, name });
          // in flight: counted in the days after this one until it ends (GHSA-266h)
          fs.closeSync(fs.openSync(join(pdir, `${day}_${name}`), "wx", 0o600));
          files.push({ owner: o, day, dir: pdir, name: `${day}_${name}`, marker: true });
        }
      } catch (e) { drop(files); throw e; }
      // each ledger is listed only once all of this call's files exist: a racing process sees them, or this one sees its.
      // A reservation that straddled 00:00 UTC is held against the new day too (its marker counts there).
      const after = utcDay(now());
      const days = after > day ? [day, after] : [day];
      for (const o of list) {
        for (const d of days) {
          let total;
          try { total = totalOn(o, d); } catch (e) { drop(files); throw e; }
          for (const [kind, want] of [["signed", signed], ["borrowed", borrowed]]) {
            const cap = caps[kind];
            if (cap === null || cap === undefined || want === 0n || total[kind] <= cap) continue;
            drop(files);
            throw Object.assign(new Error(`daily ${kind} limit`), { code: "DAY_LIMIT", kind, owner: o, used: total[kind] - want, cap, want });
          }
        }
      }
      return { files, signed, borrowed };
    },
    /** Once the call has ended: in each owner's ledger its entry becomes what it really did (signed, borrowed: what the
     *  server counted, which includes anything that may have happened, like a payment signed before the request failed),
     *  filed in the UTC day it ends but never in a day before the one it started (GHSA-266h), or goes when that is
     *  nothing; then its in-flight marker goes. Best effort: an entry that cannot be moved stays at its most, and its
     *  marker stays too, so the days after still count it. */
    settle(r, signed, borrowed) {
      if (!r) return;
      const s = signed < 0n ? 0n : signed, b = borrowed < 0n ? 0n : borrowed;
      const today = utcDay(now());
      for (const o of list) {
        const entry = r.files.find((f) => f.owner === o && !f.marker), marker = r.files.find((f) => f.owner === o && f.marker);
        if (!entry) continue;
        const start = entry.day ?? entry.dir.slice(-10);
        const day = today > start ? today : start;
        const dir = join(rootOf(o), day);
        let done = true;
        try {
          if (s === 0n && b === 0n) fs.unlinkSync(join(entry.dir, entry.name));
          else if (entry.dir !== dir || s !== r.signed || b !== r.borrowed) {
            if (entry.dir !== dir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.renameSync(join(entry.dir, entry.name), join(dir, entryName(s, b)));
          }
        } catch (_) { done = false; /* stays counted at its most */ }
        // the entry is final first: a crash between the two leaves the marker counted, never nothing
        if (done && marker) drop([marker]);
      }
    },
  };
}
