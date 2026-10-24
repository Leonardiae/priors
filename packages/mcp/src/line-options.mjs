// line_options (LINE_OPTIONS: the test server only until the owner's go; docs/growth/line-options.md): which routes to a
// line are open to an ERC-8004 identity right now, how big each line would be, and the next step for each, as a link or
// the tool to call. Each route is read from what already says it:
//   treasury_invite  treasury v4's first line by invite: its rules, epochRoom, epochStart and firstLined, InviteBond's
//                    amount; the invite page (web/invite.js) and Builder mode's first line (web/wallet.js)
//   ethos_lane       the Ethos lane's GET /ethos/status and its rule for a new agent (ethos-worker/lane.mjs)
//   stock_line       /api/stocks (the vault's maxLine, the week's room, the tokens that take a new line now) and
//                    stock_line_request's rules for an agent (sdk/stock-line.mjs)
//   own_priors       SeatVaultV5: V5Lens.needed (minA, fullLine, capA, its price and k), the book (latestGen, getGen),
//                    its stops, and the owner's $PRIORS (balanceOf), valued with V5's own math (src/v5/V5Math.sol line,
//                    as web/account-v5-core.js openLine): a quote, never a promise
// and, for an identity with a line, what grows it next. The chain is read in one eth_call to Multicall3's aggregate3 of
// views (two for an agent with a book on V5), each allowed to fail on its own: a fact that is not read is said so, never
// filled in. Nothing here signs, sends or writes.
// Two servers give this answer, from one computation (lineOptionsAnswer, below): the hosted MCP's line_options
// (tools.mjs) and the data Worker's GET /api/line-options?id=N (data-worker/line-options.mjs), which the agent page of an
// identity with no Priors record reads (docs/growth/bring-your-agent.md). Each makes the same reads its own way (the MCP
// through the data Worker's routes, the data Worker from its own store) and hands them to it.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import DEP from "../deployments/4663.v2.json" with { type: "json" };

// Multicall3, at its canonical address on Robinhood Chain (bot/worker.mjs reads through it too)
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const A = { treasury: DEP.treasuryV4, bond: DEP.inviteBond, treasuryV5: DEP.treasuryV5, pool: DEP.pool, priors: DEP.priors, v5: DEP.seatVaultV5 };
// the roots a line can come from, by their agent ids (deployments/4663.v2.json): the words for a line's source
const ROOTS = { treasury: DEP.treasuryV4AgentId, treasuryV5: DEP.treasuryV5AgentId, v5: DEP.seatVaultV5AgentId, stock: DEP.stockVaultAgentId, ethos: DEP.ethosRoot };
const ABI = parseAbi([
  "function epochRoom() view returns (uint256)", "function epochStart() view returns (uint64)", "function firstLined(uint256) view returns (bool)",
  "function rules() view returns (uint256 reserveBps, uint256 firstLine, uint256 secondLine, uint256 epochCap, uint64 epochLength, uint64 minSeasoning, uint256 minQualified, uint256 minScore, uint64 idleAfter)",
  "function amount() view returns (uint256)", "function ownerDefaults(address) view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function needed(uint256 id, uint256 tokens, bool asOwner) view returns ((uint256 minA, uint256 fullLine, uint256 capA, uint160 sqrtP, uint8 k, uint8 kCached, bool depthGuard, uint256 line, uint256 ownerA, uint256 ownBacking, uint256 roomB, uint256 lineIfAdded, uint256 weekAfter))",
  "function latestGen(uint256 id) view returns (uint32)", "function paused() view returns (bool)", "function breakerTripped() view returns (bool)", "function spotGuardOn() view returns (bool)",
  "function settings() view returns (bool openBacking, uint256 premiumCap, uint256 maxSwapUsdg, uint256 openRoom, uint256 raiseRoom, uint256 vouchCap, uint8 minDrawK, bool premiumCheck, uint64 pausedUntil)",
  // V5's Gen is all static words: its answer is read by word (bookOf)
  "function getGen(uint256 id, uint32 gen) view",
]);
const MC_ABI = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);

/** One aggregate3 of `calls` ({ key, to, fn, args, raw }): { key: value } with null for a call that failed or did not
 *  decode. Throws when the read itself fails. */
async function aggregate(client, calls) {
  const data = encodeFunctionData({ abi: MC_ABI, functionName: "aggregate3", args: [calls.map((c) => ({ target: c.to, allowFailure: true, callData: encodeFunctionData({ abi: ABI, functionName: c.fn, args: c.args || [] }) }))] });
  const res = decodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", data: await client.request({ method: "eth_call", params: [{ to: MULTICALL3, data }, "latest"] }) });
  const got = {};
  calls.forEach((c, i) => {
    got[c.key] = null;
    const r = res[i];
    if (!r || !r.success) return;
    try { got[c.key] = c.raw ? r.returnData : decodeFunctionResult({ abi: ABI, functionName: c.fn, data: r.returnData }); } catch (_) { /* not its shape: not read */ }
  });
  return got;
}

const V5_STATUS = ["none", "open", "closing", "settled"];
/** An agent's book on V5 from getGen's answer (V5Storage's Gen, by word): its status, tier, the loans counted at this
 *  tier and since when it is at this tier; null when the answer is not that shape. */
function bookOf(hex) {
  const h = String(hex || "").slice(2);
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length < 64 * 18) return null;
  const w = (i) => BigInt("0x" + h.slice(64 * i, 64 * i + 64));
  return { status: V5_STATUS[Number(w(2))] || "none", tier: Number(w(12)), countedAtTier: Number(w(13)), tierSince: Number(w(16)) };
}

/** What the chain says for line_options, through `client` (an EIP-1193 `request`; null: no RPC on this server): { read,
 *  room, rules, epochStart, lined, bond, rulesV5, needed, gen, paused, breaker, spotGuard, settings, ownerDefaults,
 *  holding (the owner's $PRIORS), book (null: none; undefined: not read), neededH (needed with the holding) }, each
 *  null when not read; { read: false } when nothing could be. */
export async function readLineFacts(client, { agentId, owner }) {
  if (!client) return { read: false };
  const id = BigInt(agentId), own = /^0x[0-9a-fA-F]{40}$/.test(String(owner || "")) ? String(owner) : null;
  const c = (key, to, fn, args, raw = false) => ({ key, to, fn, args, raw });
  let f;
  try {
    f = await aggregate(client, [
      c("room", A.treasury, "epochRoom"), c("rules", A.treasury, "rules"), c("epochStart", A.treasury, "epochStart"), c("lined", A.treasury, "firstLined", [id]),
      c("bond", A.bond, "amount"), c("rulesV5", A.treasuryV5, "rules"),
      c("needed", A.v5, "needed", [id, 0n, true]), c("gen", A.v5, "latestGen", [id]),
      c("paused", A.v5, "paused"), c("breaker", A.v5, "breakerTripped"), c("spotGuard", A.v5, "spotGuardOn"), c("settings", A.v5, "settings"),
      ...(own ? [c("ownerDefaults", A.pool, "ownerDefaults", [own]), c("holding", A.priors, "balanceOf", [own])] : []),
    ]);
  } catch (_) { return { read: false }; } // the node's own text can carry its URL (a secret): never shown
  f.read = true;
  f.book = f.gen == null ? undefined : null;
  f.neededH = null;
  if (f.gen != null && Number(f.gen) > 0) {
    try {
      const more = await aggregate(client, [c("gen", A.v5, "getGen", [id, Number(f.gen)], true), ...(f.holding > 0n ? [c("neededH", A.v5, "needed", [id, f.holding, true])] : [])]);
      f.book = more.gen ? bookOf(more.gen) || undefined : undefined;
      f.neededH = more.neededH;
    } catch (_) { f.book = undefined; }
  }
  return f;
}

// ---- V5's own math (src/v5/V5Math.sol, V5Types.sol): the line the owner's $PRIORS opens, as open() opens it ----------
const Q96 = 1n << 96n, STEP = 5_000_000n, MIN_LINE = 25_000_000n;
/** V5's ceilings by tier (C.ceiling): 50, 100, 175, 300 and 500 USDG. */
export const V5_CEILINGS = Object.freeze([50_000_000n, 100_000_000n, 175_000_000n, 300_000_000n, 500_000_000n]);
const ceilingOf = (tier) => V5_CEILINGS[Math.min(Math.max(Number(tier) || 1, 1), 5) - 1];
const v5Value = (tokens, sqrtP) => (sqrtP === 0n ? 0n : (((tokens * Q96) / sqrtP) * Q96) / sqrtP);
/** V5Math.line: floor to $5 of min(ceiling, value(tokens) ÷ k), with k doubled (`kx2`). */
export function v5Line(tokens, sqrtP, ceiling, kx2) {
  if (!Number(kx2)) return 0n;
  const v = (v5Value(BigInt(tokens), BigInt(sqrtP)) * 2n) / BigInt(kx2);
  const l = v < ceiling ? v : ceiling;
  return l - (l % STEP);
}
/** What V5's open() does with `tokens` of the owner's $PRIORS at needed()'s price and k: { line, counted (at most capA
 *  counts for the line), small (under the least line, 25 USDG: LineTooSmall) }. */
export function v5Opens(n, tokens) {
  const t = BigInt(tokens), capA = BigInt(n.capA);
  const counted = capA > 0n && t > capA ? capA : t;
  const line = v5Line(counted, n.sqrtP, V5_CEILINGS[0], n.k);
  return { line, counted, small: line < MIN_LINE };
}

// ---- words ------------------------------------------------------------------------------------------------------------
const T18 = 10n ** 18n;
/** USDG units (6 decimals) in dollars and cents, rounded down: "969.51". */
const usd = (u) => { const c = BigInt(u) / 10_000n; return `${c / 100n}.${String(c % 100n).padStart(2, "0")}`; };
/** $PRIORS (18 decimals) in whole tokens: held, rounded down ("64,203"); what it takes, rounded up (tokUp). */
const tok = (v) => (BigInt(v) / T18).toLocaleString("en-US");
const tokUp = (v) => ((BigInt(v) + T18 - 1n) / T18).toLocaleString("en-US");
const whole = (v) => (BigInt(v) / T18).toString(), wholeUp = (v) => ((BigInt(v) + T18 - 1n) / T18).toString();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const iso = (t) => new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");
const units = (v) => (/^\d{1,30}$/.test(String(v ?? "")) ? BigInt(String(v)) : null);
const count = (v, max = 1e9) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : null);

/** Where a line comes from, by its backer's agent id: { agentId, kind, words }; null without one. */
function backerOf(rec) {
  if (!rec || !rec.sponsor) return null;
  const s = rec.sponsor;
  const kind = rec.stockLine || s === ROOTS.stock ? "stock" : s === ROOTS.treasury ? "treasury" : s === ROOTS.treasuryV5 ? "treasury_v5" : s === ROOTS.v5 ? "own_priors" : s === ROOTS.ethos ? "ethos" : "backer";
  const words = { stock: "the stock vault", treasury: "the treasury", treasury_v5: "the treasury that gives raises", own_priors: "its owner's own $PRIORS on backing", ethos: "the Ethos lane", backer: null }[kind];
  return { agentId: s, kind, words: words ? `${words} (root #${s})` : `backer #${s}` };
}

const STEPS_RULE = "A bigger line comes by steps: 3 loans of at least half the line, each for 8 to 10 days, kept a week or more and repaid on time, and 14 days at the line, up to 500.00 USDG.";
const BURN = "If the agent misses a payment, three quarters of its owner's $PRIORS behind it burns.";
const QUOTE_ONLY = "This quote moves nothing and touches no score.";
const RECORD_UNREAD = "its Priors record could not be read just now; agent_record shows it";

/**
 * line_options' answer, { text, data }, from what was read. In:
 *   agentId; owner (lower case, null when not known);
 *   record: the snapshot's agent as { loansRepaid, volumeRepaid, line, available (USDG units, bigints), defaulted,
 *     frozen, isRoot, sponsor, activeLoans, qualifiedRepaid, score, enrolledAt, stockLine }, null without a Priors
 *     record; recordRead (false: the snapshot could not be read);
 *   chain (readLineFacts'); stocks (/api/stocks, null when not read); lane (/ethos/status, null when not read, { off:
 *     true } when the site answered 404); minLoan (the pool's, USDG units);
 *   links: { invite, builder, agentPage, start, seats, stocks }; asOf: { snapshot, stocks, directoryBlock }; now
 *     (seconds: the snapshot's time when it was read, the clock for days and dates).
 */
export function lineOptions(o) {
  const id = o.agentId, rec = o.recordRead ? o.record : null, ch = o.chain && o.chain.read ? o.chain : { read: false }, L = o.links, now = o.now;
  const backer = backerOf(rec);
  const marked = ch.read && ch.ownerDefaults != null ? ch.ownerDefaults > 0n : null; // null: not read, or no owner known
  // the stops for every route, in their order
  const common = rec && rec.defaulted ? "it has defaulted" : rec && rec.isRoot ? "it is a backer (root), which lends its stake" : marked ? "a default is marked on its owner's account" : rec && rec.frozen ? "its line is frozen" : null;
  const who = `Agent #${id} (${o.owner ? `owner ${o.owner}` : "owner not known"})`;
  const lines = [
    !o.recordRead ? `${who}: its Priors record could not be read just now (the Priors snapshot is unavailable), so whether it already has a line is not checked here.`
      : !rec ? `${who} is an ERC-8004 identity on Robinhood Chain with no Priors record yet.`
        : rec.isRoot ? `${who} is a backer (root) on Priors: it lends its stake, it does not borrow.`
          : `${who} has a Priors record: ${plural(rec.loansRepaid, "loan")} repaid (${usd(rec.volumeRepaid)} USDG), ${rec.defaulted ? "has DEFAULTED on a loan" : "never defaulted"}; ${rec.line > 0n && backer ? `line ${usd(rec.line)} USDG from ${backer.words}, ${usd(rec.available)} USDG available` : "no line now"}.`,
  ];
  if (rec && rec.defaulted) lines.push("It has DEFAULTED: a default is permanent, so no new line opens for it by any route.");
  if (marked) lines.push("A default is marked on its owner's account: no new line opens for any agent of that owner.");
  else if (marked === null && !common) lines.push("Whether its owner's account has a default could not be read just now: each place below checks it before anything is sent.");
  lines.push("Its routes to a line now, as Priors reads them. A reading, not an offer: each place checks again before anything is sent, and nothing moves here.");

  const routes = [];
  const close = (r, why) => { r.open = false; r.why = why; };
  const unknown = (r, why) => { r.open = null; r.why = why; };
  // one line a route; a link only ever ends a line (no full stop after it, nothing after it)
  const say = (n, title, r, body = "", state = null) => {
    routes.push(r);
    const s = state || (r.open === true ? "open now" : r.open === false ? `closed: ${r.why}` : `not known: ${r.why}`);
    lines.push(`${n}. ${title}: ${s}${/https:\/\/\S+$/.test(s) ? "" : "."}${body ? ` ${body}` : ""}`);
  };

  // 1. the treasury's first line, by invite
  {
    const r = { route: "treasury_invite", open: null, why: null, line: null, bond: null, room: null, firstLines: null, refillsAt: null, next: null };
    const fl = ch.rules ? ch.rules[1] : null, epochLength = ch.rules ? ch.rules[4] : null;
    let body = "";
    if (common) close(r, common);
    else if (ch.lined === true) close(r, "the treasury lined it before, and it gives one first line per identity");
    else if (!o.recordRead) unknown(r, RECORD_UNREAD);
    else if (rec && rec.sponsor) close(r, `it has a line from ${backer.words} now; the treasury's first line is for an identity with no line`);
    else if (ch.room == null || fl == null || ch.lined == null) unknown(r, `the treasury's room could not be read from the chain just now; Builder mode reads it live: ${L.builder}`);
    else {
      r.line = usd(fl); r.room = usd(ch.room); r.firstLines = fl > 0n ? Number(ch.room / fl) : 0;
      const refill = ch.epochStart != null && epochLength != null ? Number(ch.epochStart + epochLength) : null;
      if (ch.room < fl) {
        r.refillsAt = refill ? iso(refill) : null;
        close(r, `this week's first lines are taken (${r.room} USDG of room left, a first line is ${r.line} USDG); the room fills again ${refill && refill > now ? `after ${r.refillsAt}` : "with the next week"}`);
      } else {
        r.open = true; r.bond = ch.bond != null ? usd(ch.bond) : null; r.next = { url: L.invite, builder: L.builder };
        body = `A ${r.line} USDG line, for ${r.bond ? `a ${r.bond} USDG bond` : "a bond (its amount could not be read just now)"} its owner posts first: it comes back once the line is closed with no loan open, or 4 days after it was posted if the agent never takes a line, and a default forfeits it. This week's room: ${r.room} USDG, ${plural(r.firstLines, "first line")}. The invite service applies its own limits too (first lines per owner, a daily cap). Next: the wallet that owns agent #${id} asks at ${L.invite} (it proves it owns it, posts the bond and gets an invite), then takes the line in Builder mode with its pool consent: ${L.builder}`;
      }
    }
    say(1, "The treasury's first line, by invite", r, body);
  }

  // 2. the Ethos lane: a new agent only (ethos-worker/lane.mjs agentRules), the root's room and the day's cap
  {
    const r = { route: "ethos_lane", open: null, why: null, line: null, bond: null, rootId: null, minScore: null, today: null, dailyCap: null, rootFree: null, next: null };
    const lane = o.lane, laneLine = lane ? count(lane.line, 1000) : null, free = lane && Number.isFinite(Number(lane.freeBacking)) && Number(lane.freeBacking) >= 0 ? BigInt(Math.floor(Number(lane.freeBacking) * 1e6)) : null;
    const shape = lane && !lane.off && laneLine && count(lane.rootId) && count(lane.minScore, 2800) && count(lane.dailyCap) && count(lane.today) != null && free != null;
    let body = "";
    if (common) close(r, common);
    else if (!o.recordRead) unknown(r, RECORD_UNREAD);
    else if (rec) close(r, `the lane lines new agents only, and agent #${id} has a Priors record`);
    else if (lane && (lane.off || lane.on === false)) close(r, "the Ethos lane is not open on this site right now");
    else if (!shape || lane.on !== true) unknown(r, `the lane's status could not be read just now; Go mode's Start page shows it: ${L.start}`);
    else {
      const lineUnits = BigInt(laneLine) * 1_000_000n;
      Object.assign(r, { line: usd(lineUnits), rootId: Number(lane.rootId), minScore: Number(lane.minScore), today: Number(lane.today), dailyCap: Number(lane.dailyCap), rootFree: usd(free) });
      if (free < lineUnits) close(r, `the Ethos root has no room for another ${r.line} USDG line right now`);
      else if (r.today >= r.dailyCap) close(r, `today's ${r.dailyCap} lines are taken; it opens again after 00:00 UTC`);
      else {
        r.open = true; r.next = { url: L.start };
        body = `A ${r.line} USDG line from Priors' Ethos root (#${r.rootId}), with no bond, for a new agent whose owner shows a wallet linked to an Ethos profile that scores ${r.minScore} or more (the lane reads that score from Ethos when the owner asks; it is not read here). Today: ${r.today} of ${r.dailyCap} lines; the root has ${r.rootFree} USDG free. Next: Go mode's Start page, signed in with the account that owns agent #${id}: ${L.start}`;
      }
    }
    say(2, "The Ethos lane", r, body);
  }

  // 3. a stock line: stock_line_request's rules for an agent (sdk/stock-line.mjs), the vault's caps and the week's room
  {
    const r = { route: "stock_line", open: null, why: null, upTo: null, maxLine: null, weekLeft: null, tokens: null, next: null };
    const S = o.stocks && Array.isArray(o.stocks.assets) ? o.stocks : null;
    let body = "";
    if (common) close(r, common);
    else if (!o.recordRead) unknown(r, RECORD_UNREAD);
    else if (rec && rec.stockLine) close(r, "it has a stock line already; its owner adds stock to it in Go mode");
    else if (rec && rec.sponsor && backer.kind !== "stock" && rec.activeLoans > 0) close(r, `${plural(rec.activeLoans, "loan")} open on its line from ${backer.words} ${rec.activeLoans === 1 ? "is" : "are"} repaid first, as a stock line takes over the agent's backing`);
    else if (!S) unknown(r, `the stock vault could not be read just now; stock_assets, or Go mode's Stocks tab, shows it: ${L.stocks}`);
    else {
      const p = S.params || {}, maxLine = units(p.maxLine), week = units(p.epochRoom);
      const left = (a) => (a.lineCap == null ? null : (units(a.lineCap) ?? 0n) - (units(a.openLines) ?? 0n));
      const lending = S.assets.filter((a) => a && a.usable && !Number(a.hold || 0) && (a.lineCap == null || left(a) > 0n));
      const tokenLeft = lending.some((a) => a.lineCap == null) ? null : lending.reduce((m, a) => (left(a) > m ? left(a) : m), 0n);
      const caps = [maxLine, week, tokenLeft].filter((x) => x != null);
      const upTo = caps.length ? caps.reduce((m, x) => (x < m ? x : m)) : null;
      Object.assign(r, { maxLine: maxLine != null ? usd(maxLine) : null, weekLeft: week != null ? usd(week) : null, tokens: { lending: lending.length, of: S.assets.length } });
      const least = o.minLoan != null ? BigInt(o.minLoan) : 1n;
      if (!lending.length) close(r, "no stock token takes a new line right now");
      else if (week != null && week < least) close(r, `this week's new stock lines are taken (${r.weekLeft} USDG left)`);
      else if (upTo == null) unknown(r, `the stock vault's caps could not be read just now; stock_assets, or Go mode's Stocks tab, shows them: ${L.stocks}`);
      else if (upTo < least) close(r, "no stock token has room for a new line right now");
      else {
        r.open = true; r.upTo = usd(upTo); r.next = { tool: "stock_line_request", arguments: rec ? { agent_id: id } : {} };
        const facts = [maxLine != null ? `the vault's cap is ${r.maxLine} USDG a line` : "", week != null ? `${r.weekLeft} USDG of new lines are left this week` : "", `${lending.length} of its ${S.assets.length} stock tokens take a new line now (stock_assets lists them)`].filter(Boolean);
        body = `Up to ${r.upTo} USDG, backed by stock tokens its owner deposits: ${facts.slice(0, -1).join(", ")}${facts.length > 1 ? ", and " : ""}${facts[facts.length - 1]}.${rec && backer && rec.line > 0n ? ` Its current ${usd(rec.line)} USDG line moves to the stock vault when this one opens.` : ""} Next: stock_line_request (${rec ? `agent_id ${id}, a symbol and line_usd` : "a symbol and line_usd, and no agent_id: it has no Priors record yet"}) sizes the deposit for the line wanted and gives the Go mode link where its owner deposits${rec ? "" : `, choosing agent #${id} on the sheet`}.`;
      }
    }
    say(3, "A stock line", r, body);
  }

  // 4. a line from its owner's own $PRIORS on V5 (Go mode's Back agents): a quote at today's values, never a promise
  let book = null;
  {
    const r = { route: "own_priors", open: null, why: null, line: null, holding: null, least: null, full: null, more: null, quoteOnly: true, next: null };
    const n = ch.needed;
    let body = "", state = null;
    if (common) close(r, common);
    else if (!o.recordRead) unknown(r, RECORD_UNREAD);
    else if (!n || ch.book === undefined) unknown(r, `V5 could not be read from the chain just now; Go mode's Back agents shows it: ${L.seats}`);
    else {
      book = ch.book;
      r.least = wholeUp(n.minA); r.full = wholeUp(n.fullLine);
      if (book && book.status === "open") { r.open = false; r.why = "its line is on backing already"; state = "its line is on backing already (what grows it is below)"; }
      else if (book && book.status === "settled") close(r, "it missed a payment on backing");
      else if (book && book.status === "closing") close(r, "its line on backing is closing");
      else {
        // V5's stops before any amount (web/account-v5-core.js halted, agentStop)
        const pausedUntil = ch.settings ? Number(ch.settings[8]) : null;
        if (ch.paused === true || ch.breaker === true || (pausedUntil != null && pausedUntil > now)) close(r, "backing is paused for now");
        else if (ch.spotGuard === true || n.depthGuard === true) close(r, "new backing is on hold for now, an automatic safety stop that lifts by itself");
        else if (ch.paused == null || ch.breaker == null || ch.spotGuard == null || pausedUntil == null) unknown(r, "V5's pause and guards could not be read just now");
        else if (rec && rec.activeLoans > 0) close(r, "repay its open loan first; V5 opens no line while a loan is out");
        const said = [];
        if (ch.holding == null) {
          if (r.open === null && !r.why) unknown(r, "its owner's $PRIORS could not be read just now");
          said.push(`At today's values ${tokUp(n.minA)} $PRIORS opens a 25.00 USDG line and ${tokUp(n.fullLine)} the full 50.00 USDG first line; ${STEPS_RULE[0].toLowerCase()}${STEPS_RULE.slice(1)}`);
        } else {
          const H = ch.holding, q = v5Opens(n, H);
          r.holding = whole(H);
          if (q.small) {
            r.more = { least: wholeUp(n.minA - H), full: wholeUp(n.fullLine - H) };
            if (r.open === null && !r.why) close(r, `its owner's wallet holds ${tok(H)} $PRIORS, under the ${tokUp(n.minA)} $PRIORS that opens the least line`);
            said.push(`${tokUp(n.minA - H)} more would open a 25.00 USDG line, and ${tokUp(n.fullLine - H)} more the full 50.00 USDG line.`);
          } else {
            r.line = usd(q.line);
            if (r.open === null && !r.why) r.open = true;
            said.push(`Its owner's wallet holds ${tok(H)} $PRIORS: at today's values that would open a ${r.line} USDG line.`);
            if (q.line < V5_CEILINGS[0] && n.fullLine > H) said.push(`${tokUp(n.fullLine - H)} more would open the full 50.00 USDG line.`);
          }
          said.push(STEPS_RULE);
        }
        said.push(BURN);
        if (rec && rec.line > 0n) said.push(`Its current ${usd(rec.line)} USDG line ends as this one opens.`);
        r.next = { url: L.seats };
        said.push(QUOTE_ONLY, `Next: Go mode's Back agents, signed in with the account that owns agent #${id}, shows the exact line before the owner's click: ${L.seats}`);
        body = said.join(" ");
      }
    }
    say(4, "A line from its owner's own $PRIORS (Back agents)", r, body, state);
  }

  // what grows a line it has
  let grows = null;
  if (rec && !common && rec.line > 0n && backer) {
    const days = (t) => Math.max(0, Math.floor((now - Number(t)) / 86_400));
    const t5 = ch.rulesV5;
    const raiseRule = t5 ? `after ${t5[6]} qualified loans (it has ${rec.qualifiedRepaid}), ${Number(t5[5]) / 86_400} days on the ledger (it has ${days(rec.enrolledAt)}) and an on-chain score of ${t5[7]} (it has ${rec.score ?? "none"})` : null;
    const replace = "Routes 3 and 4 can replace it with a bigger line.";
    let text = null, next = null;
    if (backer.kind === "treasury") {
      next = L.agentPage;
      text = raiseRule ? `the treasury that gives raises (root #${ROOTS.treasuryV5}) raises a first line to ${usd(t5[2])} USDG ${raiseRule}; its line moves there first, with a new bond from its owner. ${replace} Builder mode runs the move and the raise once its record qualifies: ${L.agentPage}`
        : `the treasury that gives raises (root #${ROOTS.treasuryV5}) raises a first line by rules that could not be read just now. ${replace} Builder mode shows them: ${L.agentPage}`;
    } else if (backer.kind === "treasury_v5") {
      next = L.agentPage;
      text = !t5 ? `the treasury that gives raises raises its line by rules that could not be read just now. ${replace} Builder mode shows them: ${L.agentPage}`
        : rec.line < t5[2] ? `the treasury that gives raises lifts it to ${usd(t5[2])} USDG ${raiseRule}; anyone may send the raise once it qualifies. ${replace} Builder mode: ${L.agentPage}`
          : `it has the treasury's top line (${usd(t5[2])} USDG). ${replace}`;
    } else if (backer.kind === "own_priors") {
      next = L.seats;
      const n = ch.needed;
      if (!n || !book || book.status !== "open") text = `its line is on backing; V5's book could not be read just now. Go mode's Back agents shows it: ${L.seats}`;
      else {
        const ceil = ceilingOf(book.tier), said = [`V5 counts its owner's ${tok(n.ownerA)} $PRIORS behind it for a ${usd(n.line)} USDG line${n.line > rec.line ? `; its line at the pool is ${usd(rec.line)} USDG now, and its owner's refresh in Go mode raises it toward that` : ""}.`];
        const h = ch.neededH;
        if (ch.holding > 0n && h) said.push(`Its owner's wallet holds ${tok(ch.holding)} more $PRIORS: added, they would count for a ${usd(h.lineIfAdded)} USDG line${h.weekAfter < h.lineIfAdded ? ` (${usd(h.weekAfter)} USDG of it this week)` : ""}.`);
        if (book.tier >= 5) said.push(`It is at the top step (${usd(ceil)} USDG).`);
        else said.push(`Next step: a ${usd(ceilingOf(book.tier + 1))} USDG line, after 3 loans of at least ${usd(ceil / 2n)} USDG, each for 8 to 10 days, kept a week or more and repaid on time, and 14 days at ${usd(ceil)} USDG (it has ${Math.min(book.countedAtTier, 3)} of 3 loans and ${Math.min(days(book.tierSince), 14)} of 14 days). A late repayment moves the line down one step and starts the count again.`);
        said.push(`Go mode's Back agents: ${L.seats}`);
        text = said.join(" ");
      }
    } else if (backer.kind === "ethos") {
      text = `its ${usd(rec.line)} USDG line is from the Ethos lane; a bigger line comes from route 3 or 4, which take over its backing.`;
    } else if (backer.kind === "stock") {
      next = L.stocks;
      const cap = o.stocks && units(o.stocks.params && o.stocks.params.maxLine);
      text = `its owner adds stock to it in Go mode (Add stock, on its stock line) to raise what it can draw, up to the vault's ${cap != null ? `${usd(cap)} USDG ` : ""}cap per line: ${L.stocks}`;
    } else {
      text = `its line is vouched by backer #${backer.agentId} (desk_record shows that backer's record); a bigger line needs that backer to vouch more of its stake, or route 3 or 4, which take over its backing.`;
    }
    grows = { kind: backer.kind, text: `What grows its line next: ${text}`, next };
    lines.push(grows.text);
  }

  const a = o.asOf || {};
  lines.push(`(${[a.snapshot ? `Priors snapshot as of ${a.snapshot}` : "", a.stocks ? `stock vault as of ${a.stocks}` : "", a.directoryBlock ? `Directory as of block ${a.directoryBlock}` : "", "the chain and the Ethos lane read now"].filter(Boolean).join("; ")}.)`);
  const data = {
    agentId: id, owner: o.owner || null, recordRead: !!o.recordRead,
    record: rec ? { loansRepaid: rec.loansRepaid, volumeRepaid: usd(rec.volumeRepaid), defaulted: rec.defaulted, isRoot: rec.isRoot, line: usd(rec.line), available: usd(rec.available), backer: backer ? { agentId: backer.agentId, kind: backer.kind } : null, openLoans: rec.activeLoans } : null,
    ownerDefaulted: marked, routes, grows, asOf: { snapshot: a.snapshot || null, stocks: a.stocks || null, directoryBlock: a.directoryBlock || null },
  };
  return { text: lines.join("\n"), data };
}

// ---- the reads both servers hand over (the MCP's line_options, the data Worker's /api/line-options) --------------------
/** What an agent can draw now (atomic USDG): the pool's figure, capped by the stock vault's borrowRoom on a stock line
 *  (0 when the vault could not be read). tools.mjs re-exports it for its other tools. */
export function availableOf(a) {
  const av = Math.max(0, Math.trunc(Number(a.available) || 0));
  const c = a.collateral;
  if (!c) return av;
  if (c.error) return 0;
  return Math.min(av, Math.max(0, Math.trunc(Number(c.borrowRoom) || 0)));
}
/** The fields of a snapshot's agent that line_options reads (recordOf, and its owner), with a stock line's collateral
 *  cut to what availableOf and recordOf read: what the data Worker's lines index keeps of each agent
 *  (data-worker/line-options.mjs), so that both servers read the same record. */
export function lineFields(a) {
  const c = a.collateral;
  return {
    id: a.id, owner: a.owner, loansRepaid: a.loansRepaid, volumeRepaid: a.volumeRepaid, capacity: a.capacity, available: a.available, defaulted: a.defaulted,
    frozen: a.frozen, isRoot: a.isRoot, sponsor: a.sponsor, activeLoans: a.activeLoans, qualifiedRepaid: a.qualifiedRepaid, score: a.score, enrolledAt: a.enrolledAt,
    collateral: c ? (c.error ? { error: true } : { borrowRoom: c.borrowRoom }) : null,
  };
}
/** lineOptions' `record` from the snapshot's agent (or its lineFields), null without one. */
export function recordOf(a) {
  if (!a) return null;
  const atomic = (v) => BigInt(Math.max(0, Math.trunc(Number(v) || 0)));
  return {
    loansRepaid: Number(a.loansRepaid) || 0, volumeRepaid: atomic(a.volumeRepaid), line: atomic(a.capacity), available: BigInt(availableOf(a)),
    defaulted: !!a.defaulted, frozen: !!a.frozen, isRoot: !!a.isRoot, sponsor: Number(a.sponsor) || 0, activeLoans: Number(a.activeLoans) || 0,
    qualifiedRepaid: Number(a.qualifiedRepaid) || 0, score: a.score ?? null, enrolledAt: Number(a.enrolledAt) || 0, stockLine: !!a.collateral && !a.collateral.error,
  };
}
/** Its links: the invite page and Builder mode on `builderUrl`'s site (https://priors.trade/agent), Go mode's Start, Back
 *  agents and Stocks on `appUrl`'s (https://go.priors.trade/account). */
export function linksOf(builderUrl, appUrl, id) {
  const link = (base, path, set = {}, hash = "") => { const u = new URL(path, base); for (const [k, v] of Object.entries(set)) u.searchParams.set(k, String(v)); if (hash) u.hash = hash; return u.href; };
  return {
    invite: link(builderUrl, "/invite", { id }), builder: builderUrl, agentPage: link(builderUrl, builderUrl, { id }),
    start: link(appUrl, "/start"), seats: link(appUrl, appUrl, {}, "ac-seats"), stocks: link(appUrl, appUrl, {}, "ac-stocks"),
  };
}
const addrOf = (v) => { const a = String(v ?? "").toLowerCase(); return /^0x[0-9a-f]{40}$/.test(a) ? a : null; };
const isoOrNull = (t) => (t ? iso(t) : null);
/**
 * line_options' whole answer from the reads: { answer: { text, data } }, or { error, status } when it does not answer
 * (404: no such identity; 503: neither the Directory nor a record to say whether it exists). In:
 *   agentId; reg: the Directory's answer for ?id= (/api/registry), null or undefined when it could not be read (or is
 *     off); snap: the snapshot (its meta's takenAt and timestamp, its params' minLoan), null when it could not be read;
 *   agent: the snapshot's agent with this id (or its lineFields), null without one; stocks: /api/stocks, null when not
 *   read; lane: the Ethos lane's status (null when not read, { off: true } when its site answered 404); client: the
 *   chain (an EIP-1193 `request`; null: none); builderUrl, appUrl (linksOf).
 */
export async function lineOptionsAnswer({ agentId, reg, snap, agent, stocks, lane, client, builderUrl, appUrl }) {
  const regRead = !!(reg && typeof reg === "object" && !reg.__status);
  if (regRead && !reg.item && !agent) return { status: 404, error: `No identity #${agentId} in the ERC-8004 registry on Robinhood Chain (the Directory knows ${Number(reg.n) || 0}, ids 0 to ${Math.max(0, (Number(reg.n) || 0) - 1)}).` };
  if (!regRead && !agent) return { status: 503, error: `Agent #${agentId}: the ERC-8004 registry (the Priors Directory) could not be read just now${snap ? "" : ", nor the Priors snapshot"}, so whether this identity exists is not known: try again in a minute.` };
  const owner = (regRead && reg.item ? addrOf(reg.item.owner) : null) || (agent ? addrOf(agent.owner) : null);
  const chain = await readLineFacts(client, { agentId, owner });
  const meta = (snap && snap.meta) || {};
  return {
    answer: lineOptions({
      agentId, owner, record: recordOf(agent), recordRead: !!snap, chain, stocks, lane, minLoan: snap && snap.params && snap.params.minLoan != null ? Number(snap.params.minLoan) : null,
      links: linksOf(builderUrl, appUrl, agentId),
      asOf: { snapshot: snap ? isoOrNull(meta.takenAt ?? meta.timestamp) : null, stocks: stocks ? isoOrNull(stocks.updatedAt) : null, directoryBlock: regRead ? Number(reg.block) || null : null },
      now: Number(meta.timestamp) || Math.floor(Date.now() / 1000),
    }),
  };
}
