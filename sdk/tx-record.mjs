// Records of transactions whose outcome is not known yet (GHSA-g5cv-cpwp-756w): for each, its hash, the nonce it was
// signed with, the block before it was sent and the exact signed bytes. The CLI records every write it signs in two
// phases, each durable (file and directory synced): an INTENT (`<address>-<hash>.intent`: signed, never broadcast)
// before it checks its lock, then, once the check passed and right before its one broadcast, SENDING (the same file
// linked to `<address>-<hash>.json`). An INTENT is never resent; `tx` drops one whose writer can no longer send it
// (not running, or the key's lock is not the one it recorded). A SENDING record is removed only on a conclusive
// answer (the receipt read, or a refusal) or once `tx` finds it final. While either is there, the commands that could
// repeat it refuse. A SENDING record decides its own fate, whatever the lock says: whoever acts on it first renames it
// to a name of its own (claim by rename: of two renames of one path, exactly one succeeds). Settling it renames it to
// a tombstone and deletes that; `tx --resend` renames it to `<address>-<hash>.resending-<pid>-<birth>-<token>` for its
// one broadcast and back to SENDING after it. A claimed name is still SENDING to everyone else (also after a crash).
// An owner (a lock's holder, an INTENT's writer, a claim's or tombstone's maker) is its pid AND its process's start
// time (birthTag), so a pid reused by an unrelated process is not taken for it.
// A command of one key holds that key's lock (`<address>.lock`, see lockKey) from its check of the records to its
// last send, and each write checks, after recording itself and right before its broadcast, that it still holds it
// (keyJournal), so two commands of one key never both send a borrow or a join. `tx` keeps what it observed about a record's nonce
// next to it (`<address>-<hash>.seen`), since the node can drop that state before the deciding block is finalized.
// No hash is ever typed: a 64-hex argument is always refused as a possible private key, so a key pasted by mistake
// never reaches a node. The signed bytes let `tx --resend` send the very same transaction again (same hash and nonce:
// it cannot make a second one).
//
// One file per transaction, `<address>-<hash>.json`, never rewritten: it is written to a private temporary name and
// linked into place (link fails if the name exists), so two processes never lose each other's record and nobody reads
// half a record. Only the user can read or change them: the directory is 0700 and each file 0600, the user's own and
// never a link (opened with O_NOFOLLOW and checked on the open descriptor); anything else is refused, never read, and
// a record must hold a transaction its address signed at its nonce. They live in $XDG_STATE_HOME/priors/unconfirmed,
// else ~/.local/state/priors/unconfirmed.
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";

/** The directory of the records. */
export function recordDir(env = process.env) {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "priors", "unconfirmed");
}

const NOFOLLOW = constants.O_NOFOLLOW || 0;
const untrusted = (msg) => Object.assign(new Error(msg), { code: "RECORD_UNTRUSTED" });
const owns = typeof process.getuid === "function"; // POSIX: owner and mode are checked; elsewhere the OS's own ACLs
const isHash = (h) => /^0x[0-9a-fA-F]{64}$/.test(String(h));
const fileOf = (dir, address, hash, ext = ".json") => join(dir, `${String(address).toLowerCase()}-${String(hash).toLowerCase()}${ext}`);
const lockFileOf = (dir, address) => join(dir, `${String(address).toLowerCase()}.lock`);

/** A plain directory or file of this user's, closed to everyone else. */
function check(st, path, dir) {
  if (dir ? !st.isDirectory() : !st.isFile()) throw untrusted(`${path} is not a plain ${dir ? "directory" : "file"}`);
  if (owns && st.uid !== process.getuid()) throw untrusted(`${path} belongs to another user`);
  if (owns && (st.mode & 0o077) !== 0) throw untrusted(`${path} is open to other users (mode ${(st.mode & 0o777).toString(8)}; it must be ${dir ? "700" : "600"})`);
}

/** The directory, created private if missing and checked. */
function openDir(env) {
  const dir = recordDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  check(lstatSync(dir), dir, true);
  return dir;
}

/** Make the directory's entries (a file linked, renamed or removed) durable, as fsync does a file's bytes. */
function syncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (e) {
    if (!["EISDIR", "EINVAL", "EPERM", "EBADF"].includes(e.code)) throw e; // a platform that cannot sync a directory
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/** `body` written and synced under a private temporary name in `dir`; returns that name. */
function writeTemp(dir, body) {
  const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** Record `rec` ({ hash, nonce, raw, sentBlock, command }) signed by `address`, durably (file and directory synced)
 *  before it returns. A record of the same hash is kept as it is. Returns true when this call created the record,
 *  false when it was already there. */
export function saveUnconfirmed(address, rec, env = process.env) {
  return saveAs(address, rec, ".json", env);
}

/** Record `rec` as an INTENT: signed, not broadcast. Returns true when this call created it, false when a record of
 *  this very transaction (an INTENT or a SENDING one) was already there. */
export function saveIntent(address, rec, env = process.env) {
  if (existsSync(fileOf(recordDir(env), address, rec.hash))) return false;
  return saveAs(address, rec, ".intent", env);
}

function saveAs(address, rec, ext, env) {
  if (!isHash(rec.hash)) throw new Error("saveUnconfirmed: not a transaction hash");
  const dir = openDir(env);
  const f = fileOf(dir, address, rec.hash, ext);
  const tmp = writeTemp(dir, JSON.stringify({ ...rec, address, at: new Date().toISOString() }, null, 1));
  let created = false;
  try {
    linkSync(tmp, f);
    created = true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e; // already recorded: the same transaction
  } finally {
    unlinkSync(tmp);
  }
  syncDir(dir);
  return created;
}

/** A private file's text, read from the descriptor it was opened with (never through a link); null if it is gone. */
function readPrivate(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    if (e.code === "ELOOP" || e.code === "EMLINK") throw untrusted(`${path} is a link`);
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    check(fstatSync(fd), path, false);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** One record, read without following a link, and checked against its name; null if it was removed meanwhile. */
function readRecord(path, address, hash) {
  const text = readPrivate(path);
  if (text == null) return null;
  let rec, tx;
  try {
    rec = JSON.parse(text);
    tx = ethers.Transaction.from(rec.raw);
  } catch (_) {
    throw untrusted(`${path} is not a record this tool wrote`);
  }
  if (tx.hash.toLowerCase() !== hash || String(rec.hash).toLowerCase() !== hash || tx.nonce !== rec.nonce || String(tx.from).toLowerCase() !== String(address).toLowerCase()) {
    throw untrusted(`${path} does not hold a transaction ${address} signed`);
  }
  return rec;
}

/** A record file's name: its hash and suffix (".json", ".intent", or a claimed ".resending-<pid>-<birth>-<token>",
 *  whose `claimedBy` and `claimedBirth` are its claimer's); null for anything else (observations, tombstones, temporary
 *  files, locks). A claim name without a birth (as round 10 wrote them) is judged by its pid alone. */
function kindOf(name, prefix) {
  if (!name.startsWith(prefix)) return null;
  const hash = name.slice(prefix.length, prefix.length + 66);
  if (!isHash(hash)) return null;
  const suffix = name.slice(prefix.length + 66);
  if (suffix === ".json" || suffix === ".intent") return { hash, suffix };
  const m = /^\.resending-(\d+)(?:-([0-9a-f]{8}))?-[0-9a-f]+$/.exec(suffix);
  return m ? { hash, suffix, claimedBy: Number(m[1]), claimedBirth: m[2] && m[2] !== NO_BIRTH ? m[2] : null } : null;
}

/** Every unresolved record of `address`, by nonce, each with its `phase`: "intent" (signed, never broadcast) or
 *  "sending". Throws RECORD_UNTRUSTED rather than read one it cannot trust. */
export function listUnconfirmed(address, env = process.env) {
  const dir = recordDir(env);
  try {
    check(lstatSync(dir), dir, true);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const prefix = `${String(address).toLowerCase()}-`;
  const byHash = new Map();
  for (const name of readdirSync(dir)) {
    const kind = kindOf(name, prefix);
    if (!kind) continue;
    const rec = readRecord(join(dir, name), address, kind.hash);
    if (!rec) continue;
    const phase = kind.suffix === ".intent" ? "intent" : "sending";
    if (phase === "sending" || !byHash.has(kind.hash)) byHash.set(kind.hash, { ...rec, phase, ...(kind.claimedBy ? { claimedBy: kind.claimedBy } : {}) }); // SENDING wins
  }
  return [...byHash.values()].sort((a, b) => a.nonce - b.nonce);
}

/** Remove the record of `hash` (and what was observed about it) once its outcome is conclusive. */
export function removeUnconfirmed(address, hash, env = process.env) {
  const dir = recordDir(env);
  for (const ext of [".json", ".seen", ".intent"]) {
    try {
      unlinkSync(fileOf(dir, address, hash, ext));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  syncDir(dir);
}

/**
 * Claim the SENDING record of `hash` by renaming it to a name of this process's own: for "resend", a
 * `.resending-<pid>-<token>` name (still SENDING to everyone else); for "settle", a tombstone. It takes `<hash>.json`,
 * or a `.resending-` name whose claimer is no longer running (a crash mid-resend). Returns the new name, or null when
 * another process claimed it first (or none is left): then this one must not act on it.
 */
export function claimSending(address, hash, purpose, env = process.env) {
  const dir = recordDir(env);
  const prefix = `${String(address).toLowerCase()}-`;
  const own = `${process.pid}-${ownBirth() || NO_BIRTH}-${randomBytes(6).toString("hex")}`;
  const to = purpose === "resend" ? fileOf(dir, address, hash, `.resending-${own}`) : join(dir, `.tomb-${own}`);
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const candidates = [fileOf(dir, address, hash)];
  for (const name of names) {
    const k = kindOf(name, prefix);
    if (k && k.hash === String(hash).toLowerCase() && k.claimedBy && !ownerAlive(k.claimedBy, k.claimedBirth)) candidates.push(join(dir, name));
  }
  for (const from of candidates) {
    try {
      renameSync(from, to);
    } catch (e) {
      if (e.code === "ENOENT") continue; // claimed by someone else first
      throw e;
    }
    syncDir(dir);
    return to;
  }
  return null;
}

/** After a resend: the claimed name back to SENDING (if that fails the claimed name stays, which is SENDING too). */
export function releaseResend(address, hash, claimed, env = process.env) {
  const dir = recordDir(env);
  try {
    renameSync(claimed, fileOf(dir, address, hash));
    syncDir(dir);
  } catch (_) { /* kept under its claimed name: still SENDING */ }
}

/** Remove the SENDING record of `hash` on a conclusive answer, by claiming it first (claimSending "settle"): false,
 *  and nothing removed, when another process holds it (a resend in progress, or a settlement already done). */
export function settleRecord(address, hash, env = process.env) {
  const tomb = claimSending(address, hash, "settle", env);
  if (!tomb) return false;
  unlinkSync(tomb);
  const dir = recordDir(env);
  for (const ext of [".seen", ".intent"]) { // what was observed about it, and any INTENT name a crash left
    try {
      unlinkSync(fileOf(dir, address, hash, ext));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  syncDir(dir);
  return true;
}

/** Remove only the INTENT of `hash` (never a SENDING record): bytes that were never broadcast. */
export function removeIntent(address, hash, env = process.env) {
  const dir = recordDir(env);
  try {
    unlinkSync(fileOf(dir, address, hash, ".intent"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  syncDir(dir);
}

/**
 * Mark the INTENT of `hash` SENDING, durably, right before its broadcast: the same file linked to the SENDING name
 * (link fails if that name exists; the directory synced), then the INTENT name removed. "sending" once done; "gone"
 * when the INTENT is no longer there (`tx` dropped it: this command no longer holds the lock); "exists" when a
 * SENDING record of these very bytes is already there (another command is sending them).
 */
export function markSending(address, hash, env = process.env) {
  const dir = recordDir(env);
  const intent = fileOf(dir, address, hash, ".intent");
  try {
    linkSync(intent, fileOf(dir, address, hash));
  } catch (e) {
    if (e.code === "ENOENT") return "gone";
    if (e.code === "EEXIST") return "exists";
    throw e;
  }
  syncDir(dir);
  try {
    unlinkSync(intent);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  syncDir(dir);
  return "sending";
}

/** Whether the writer of INTENT `rec` can no longer send it: it is not running (its pid gone, or now another
 *  process's), or the key's lock does not hold the token it recorded (another command took the lock since). Such bytes
 *  were never broadcast: `tx` drops them. */
export function intentAbandoned(address, rec, env = process.env) {
  if (!ownerAlive(Number(rec.writer), rec.writerBirth ?? null)) return true;
  const holder = lockHolder(lockFileOf(recordDir(env), address));
  return !holder || !rec.lockToken || holder.token !== rec.lockToken;
}

const isObs = (o) => o != null && Number.isSafeInteger(o.block) && isHash(o.blockHash) && (o.hash === undefined || isHash(o.hash));

/** What `tx` observed about the nonce of `hash` (txStatus's `seen`), or null. Read as the records are. */
export function loadObservation(address, hash, env = process.env) {
  const path = fileOf(recordDir(env), address, hash, ".seen");
  const text = readPrivate(path);
  if (text == null) return null;
  let seen;
  try {
    seen = JSON.parse(text);
  } catch (_) {
    throw untrusted(`${path} is not an observation this tool wrote`);
  }
  const out = {};
  for (const k of ["consumedBy", "consumedAt"]) if (seen?.[k] !== undefined) { if (!isObs(seen[k])) throw untrusted(`${path} is not an observation this tool wrote`); out[k] = seen[k]; }
  return out;
}

/** Keep `seen` for the record of `hash` (replaced whole: written to a temporary name, synced, renamed over it). */
export function saveObservation(address, hash, seen, env = process.env) {
  if (!isHash(hash)) throw new Error("saveObservation: not a transaction hash");
  const dir = openDir(env);
  const tmp = writeTemp(dir, JSON.stringify(seen));
  try {
    renameSync(tmp, fileOf(dir, address, hash, ".seen"));
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
  syncDir(dir);
}

const NO_BIRTH = "00000000";

/**
 * A short tag of process `pid`'s start time (8 hex digits of its hash), which a reused pid does not share: on Linux
 * /proc/<pid>/stat field 22 (start time after boot, in clock ticks), elsewhere on Unix `ps -o lstart= -p <pid>`. null
 * when it cannot be read (no such process, or no way to read it here, e.g. on Windows): then an owner is judged by its
 * pid alone, which a reused pid can fool (a lock or claim then waits until that process ends, or is removed by hand).
 */
export function birthTag(pid) {
  let birth = null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null; // fields from the 3rd on: index 19 is the 22nd
  } catch (_) {
    if (process.platform !== "win32" && process.platform !== "linux") {
      try {
        birth = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || null;
      } catch (_) {
        birth = null;
      }
    }
  }
  return birth ? createHash("sha256").update(String(birth)).digest("hex").slice(0, 8) : null;
}

let ownBirthTag;
const ownBirth = () => (ownBirthTag === undefined ? (ownBirthTag = birthTag(process.pid)) : ownBirthTag);

/** Whether the owner `pid` (with start-time tag `birth`, or null when none was recorded) is still running: its pid
 *  exists AND, when both tags can be read, its start time matches. Without a tag, the pid alone decides. */
function ownerAlive(pid, birth) {
  if (!alive(pid)) return false;
  if (!birth) return true;
  const now = birthTag(pid);
  return now == null || now === birth;
}

/** `tx`: remove tombstones (`.tomb-<pid>-<birth>-<token>`) whose maker is gone: one crashed between claiming a record
 *  and deleting it. Returns how many were removed. */
export function sweepTombs(env = process.env) {
  const dir = recordDir(env);
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  let n = 0;
  for (const name of names) {
    const m = /^\.tomb-(\d+)(?:-([0-9a-f]{8}))?-[0-9a-f]+$/.exec(name);
    if (!m || ownerAlive(Number(m[1]), m[2] && m[2] !== NO_BIRTH ? m[2] : null)) continue;
    try {
      unlinkSync(join(dir, name));
      n++;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (n) syncDir(dir);
  return n;
}

/** Whether process `pid` exists here (one this user cannot signal still counts). */
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** A lock file's holder ({ pid, token, at }), or null if gone; RECORD_UNTRUSTED unless it is a private file. */
function lockHolder(path) {
  const text = readPrivate(path);
  if (text == null) return null;
  try {
    const h = JSON.parse(text);
    return { pid: Number(h.pid), token: String(h.token), at: h.at, birth: typeof h.birth === "string" ? h.birth : null };
  } catch (_) {
    return { pid: 0, token: "", at: null }; // not a lock this tool wrote (it links only complete ones): stale
  }
}

/**
 * Hold `address`'s lock: `<address>.lock` in the records' directory, holding this process's pid and a random token,
 * written under a private temporary name and linked into place (link fails if the name exists, so only one process
 * takes it, and nobody ever reads a lock half written). Returns { path, held(), release() }: held() re-reads the file
 * at its path and says whether it is still this one (same inode, same pid and token); release removes it only then.
 * A lock whose holder is no longer running (killed: it never released it; its pid gone, or now another process's, by
 * its start time) is recovered: moved aside under a unique name, and removed if what moved is still that stale lock,
 * else put back. Throws LOCK_HELD (with the holder) while a
 * running process holds it, RECORD_UNTRUSTED for a directory or lock it cannot trust.
 * node:fs has no flock, so that recovery can still race: a contender holding a stale read can move a fresh lock aside,
 * and a third can take the name before it is put back, leaving two commands that each took the lock. That cannot send
 * twice: every write records its INTENT, checks held(), and only then marks it SENDING and broadcasts (keyJournal); a
 * command that takes the name later checks the records only after taking it, so it finds the earlier one's record and
 * refuses, and `tx` never resends an INTENT (it drops one whose writer no longer holds the lock, which makes that
 * writer's mark fail: it sends nothing). A repay or a `tx --resend` of a SENDING record, which do not refuse on
 * records, can still overlap another command then; neither can repeat a borrow or a join.
 */
export function lockKey(address, env = process.env) {
  const dir = openDir(env);
  const path = lockFileOf(dir, address);
  const token = randomBytes(12).toString("hex");
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = writeTemp(dir, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString(), birth: ownBirth() }));
    const { ino, dev } = lstatSync(tmp); // the lock's inode, once linked
    let taken = false;
    try {
      linkSync(tmp, path);
      taken = true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    } finally {
      unlinkSync(tmp);
    }
    if (taken) {
      syncDir(dir);
      const held = () => {
        let fd;
        try {
          fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
          const st = fstatSync(fd);
          if (st.ino !== ino || st.dev !== dev) return false;
          const h = JSON.parse(readFileSync(fd, "utf8"));
          return h.token === token && h.pid === process.pid;
        } catch (_) {
          return false; // gone, moved, or not a lock: not ours
        } finally {
          if (fd != null) closeSync(fd);
        }
      };
      return {
        path,
        token,
        held,
        release() {
          try {
            if (held()) unlinkSync(path);
          } catch (_) { /* already gone */ }
        },
      };
    }
    const holder = lockHolder(path);
    if (holder == null) continue; // released meanwhile
    if (ownerAlive(holder.pid, holder.birth)) throw Object.assign(new Error(`another command of ${address} is running (pid ${holder.pid}, since ${holder.at}): wait for it to finish; if no such command is running, remove ${path}`), { code: "LOCK_HELD", holder, path });
    const aside = join(dir, `.stale-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      renameSync(path, aside);
    } catch (e) {
      if (e.code === "ENOENT") continue; // someone else recovered it
      throw e;
    }
    const moved = lockHolder(aside);
    if (moved && moved.token !== holder.token) {
      try { linkSync(aside, path); } catch (_) { /* a third took the name meanwhile: see above */ }
    }
    unlinkSync(aside);
  }
  throw Object.assign(new Error(`could not take the lock ${path}: try again`), { code: "LOCK_HELD", path });
}

/**
 * The journal (PriorsV2's `journal` option) of a command of `address` that holds the key's lock; `held()` (lockKey's,
 * may be async) says whether it still does. `before` records the signed transaction as an INTENT (synced, with this
 * process's pid and the lock's token), checks the lock, and only then marks it SENDING (synced), right before the one
 * broadcast. The lock no longer held: it removes its own INTENT (never broadcast, never resent by `tx`) and throws
 * LOCK_LOST; its INTENT gone by then (`tx` dropped it): LOCK_LOST too; a record of these very bytes already there
 * (another command signed the same bytes, or an earlier one recorded them): ALREADY_RECORDED, and it is left alone.
 * Nothing is sent after any of these. `settled` removes the record once the outcome is conclusive, by claiming it
 * (settleRecord): if another process claimed it first (a resend), it keeps it and answers false; for a refusal at the
 * broadcast, it also keeps it once the lock is no longer held.
 */
export function keyJournal(address, held, command, env = process.env) {
  const lost = (why) => Object.assign(new Error(`another command of ${address} is running: ${why}`), { code: "LOCK_LOST" });
  const already = (hash) => Object.assign(new Error(`this very transaction (${hash}) is already recorded: another command of ${address} is sending it, or an earlier one recorded it (\`tx\` settles it)`), { code: "ALREADY_RECORDED" });
  return {
    async before(t) {
      let created;
      try {
        const lockToken = lockHolder(lockFileOf(recordDir(env), address))?.token ?? null;
        created = saveIntent(address, { hash: t.hash, nonce: t.nonce, raw: t.raw, sentBlock: t.sentBlock ?? null, command, writer: process.pid, writerBirth: ownBirth(), lockToken }, env);
      } catch (e) {
        throw Object.assign(new Error(`the signed transaction could not be recorded (${e.message})`), { cause: e });
      }
      if (!created) throw already(t.hash);
      if (!(await held())) {
        removeIntent(address, t.hash, env);
        throw lost("it holds this key's lock now");
      }
      const mark = markSending(address, t.hash, env);
      if (mark === "gone") throw lost("it took this key's lock and cleared this unsent transaction");
      if (mark === "exists") {
        removeIntent(address, t.hash, env);
        throw already(t.hash);
      }
    },
    // the record is removed only by claiming it (settleRecord): if `tx --resend` claimed it first, it stays and this
    // answers false (the transaction is then unconfirmed). A refusal also keeps it once the lock is no longer held.
    async settled(hash, { refusal = false } = {}) {
      if (refusal && !(await held())) return false;
      return settleRecord(address, hash, env);
    },
  };
}
