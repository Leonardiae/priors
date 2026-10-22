// ERC-8004 credit profile ("erc8004-credit/v1", docs/ERC-8004-CREDIT.md): credit history written as ordinary
// ERC-8004 reputation entries, lender-neutral. Pure, no network: the writer builds leaves, roots and files here; the
// reader (sdk/credit-reader.mjs) decodes and checks them against the chain.
//
// One idea carries it: a credit event is only worth what the chain can prove. Every closed loan is a leaf that names
// the lender's own log (tx hash and log index) that closed it; a statement commits to all of an agent's closed loans in
// a block window with a Merkle root, and any reader can rebuild that root from the lender's logs alone. Statements of
// one (writer, agent) are chained by hash and windows are contiguous, so a lender cannot drop a default from a source it
// declares without leaving a gap or a mismatch anyone can see.
//
// Entries (tag1, value with valueDecimals = the asset's decimals, tag2 = the class):
//   credit.statement  value = principal repaid on time in the window; file = the statement
//   credit.defaulted  value = principal defaulted; one entry per default, posted when it happens; file = its leaf
// Classes: "unsecured", "secured:<kind>" (stock, pt, lst, stable, nft, other). A statement's tag2 is its loans' class,
// or "mixed" when the window holds more than one; the per-class split is in the file. The class is the lender's claim
// (a lender's logs do not say it in a standard way); everything else in a statement is rebuilt from the chain.
//
// Files are canonical JSON (RFC 8785 for the values used here: keys sorted, no whitespace, integers only), so one file
// has one byte string and one meaning. Ids (agentId, loan) and amounts are decimal strings: they are uint256.
import { ethers } from "ethers";

export const PROFILE = "erc8004-credit/v1";
export const TAG_STATEMENT = "credit.statement";
export const TAG_DEFAULTED = "credit.defaulted";
export const TAGS = [TAG_STATEMENT, TAG_DEFAULTED];
/** Leaf outcomes. RECOVERED is reserved: a v1 file never carries it. */
export const ON_TIME = 1, LATE = 2, DEFAULTED = 3, RECOVERED = 4;
export const OUTCOMES = { [ON_TIME]: "onTime", [LATE]: "late", [DEFAULTED]: "defaulted", [RECOVERED]: "recovered" };
export const ANCHORS = 5; // the latest leaves a statement carries in full, so a light reader can check without a log scan
export const MAX_FILE_BYTES = 4096; // the writer's target: anchors are dropped (oldest first, never a total or the root) to fit
export const FILE_LIMIT = 8192; // no v1 file is larger; a reader rejects one that is
export const MAX_SOURCES = 16, MAX_ANCHORS = 16;
export const DATA_URI_PREFIX = "data:application/json;base64,";
export const MIXED = "mixed";
export const CLASSES = ["unsecured", "secured:stock", "secured:pt", "secured:lst", "secured:stable", "secured:nft", "secured:other"];

const abi = ethers.AbiCoder.defaultAbiCoder();
const big = (v) => BigInt(String(v ?? 0));
const lc = (a) => String(a || "").toLowerCase();
const UINT256_MAX = 2n ** 256n - 1n, INT128_MAX = 2n ** 127n - 1n, UINT32_MAX = 2 ** 32 - 1;
const DEC = /^(0|[1-9][0-9]{0,77})$/;

/**
 * A uint256 (an agent id, a loan id, an amount) as a BigInt, from a bigint, a decimal string or a Number that is an
 * exact integer. A Number past 2^53 has already lost digits, so it is refused rather than rounded.
 */
export function toId(v, what = "id") {
  if (typeof v === "number") {
    if (Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    throw new RangeError(`${what} ${v} is not an exact integer: pass it as a decimal string or a bigint`);
  }
  if (typeof v === "bigint" && v >= 0n && v <= UINT256_MAX) return v;
  if (typeof v === "string" && DEC.test(v) && BigInt(v) <= UINT256_MAX) return BigInt(v);
  throw new TypeError(`${what} must be a uint256 (a bigint or a decimal string), not ${typeof v === "string" ? JSON.stringify(v.slice(0, 40)) : String(v).slice(0, 40)}`);
}
const dec = (v, what) => toId(v, what).toString();

/** Leaf fields, as committed: (chainId, contract, agentId, loanId, amount, dueAt, closedAt, outcome, txHash, logIndex). */
export const LEAF_TYPES = ["uint256", "address", "uint256", "uint256", "uint256", "uint64", "uint64", "uint8", "bytes32", "uint32"];

/**
 * A leaf's hash: keccak256(bytes.concat(keccak256(abi.encode(...)))), the double hash OpenZeppelin's MerkleProof
 * expects (a leaf can never be mistaken for an inner node). `src` is the leaf's source ({ chainId, contract }).
 */
export function leafHash(leaf, src, agentId) {
  const inner = ethers.keccak256(abi.encode(LEAF_TYPES, [
    big(src.chainId), ethers.getAddress(src.contract), toId(agentId, "agentId"), toId(leaf.loan, "loan"), toId(leaf.amount, "amount"),
    toId(leaf.dueAt, "dueAt"), toId(leaf.closedAt, "closedAt"), Number(leaf.outcome), leaf.tx, Number(leaf.log),
  ]));
  return ethers.keccak256(inner);
}

/** Commutative pair hash (OpenZeppelin MerkleProof._hashPair). */
const pair = (a, b) => (BigInt(a) < BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));

/** Merkle levels over leaf hashes in leaf order; an odd node is carried up unchanged. levels[0] = leaves. */
function levels(hashes) {
  const out = [hashes.slice()];
  while (out.at(-1).length > 1) {
    const cur = out.at(-1), next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? pair(cur[i], cur[i + 1]) : cur[i]);
    out.push(next);
  }
  return out;
}

/** The root of a list of leaf hashes; ZeroHash for none. */
export function merkleRoot(hashes) {
  if (!hashes.length) return ethers.ZeroHash;
  return levels(hashes).at(-1)[0];
}

/** The proof for leaf `i` (verifies with OpenZeppelin MerkleProof.verify(proof, root, leafHash)). */
export function merkleProof(hashes, i) {
  const proof = [];
  let idx = i;
  for (const lvl of levels(hashes).slice(0, -1)) {
    const sib = idx ^ 1;
    if (sib < lvl.length) proof.push(lvl[sib]);
    idx >>= 1;
  }
  return proof;
}

export function verifyProof(proof, root, leaf) {
  let h = leaf;
  for (const p of proof) h = pair(h, p);
  return h === root;
}

/** Leaves in their committed order: by close block, then log index (then source, for two sources in one block). */
export function sortLeaves(leaves) {
  return leaves.slice().sort((a, b) => Number(a.block) - Number(b.block) || Number(a.log) - Number(b.log) || Number(a.src || 0) - Number(b.src || 0));
}

/** Root over leaves (already sorted) given the statement's sources. */
export function rootOf(leaves, sources, agentId) {
  return merkleRoot(leaves.map((l) => leafHash(l, sources[Number(l.src || 0)], agentId)));
}

/** The outcome a leaf must carry, from what the chain says: a default, or a repayment on time or late. */
export const outcomeOf = ({ defaulted, closedAt, dueAt }) => (defaulted ? DEFAULTED : Number(closedAt) <= Number(dueAt) ? ON_TIME : LATE);

const zero = () => ({ count: 0, amount: "0" });
const add = (t, amount) => { t.count++; t.amount = (big(t.amount) + big(amount)).toString(); };

/** Totals by outcome over leaves: { onTime, late, defaulted, recovered }, each { count, amount } (base units). */
export function totalsOf(leaves) {
  const t = { onTime: zero(), late: zero(), defaulted: zero(), recovered: zero() };
  for (const l of leaves) { const k = OUTCOMES[Number(l.outcome)]; if (k) add(t[k], l.amount); }
  return t;
}

/** A leaf as written in a file (anchors, a default entry): every committed field, plus its class, its block and the
 *  opening log (openBlock, openTx, openLog) a light reader reads dueAt from. */
export const leafOut = (l) => ({
  src: Number(l.src || 0), cls: l.cls || "unsecured", loan: dec(l.loan, "loan"), amount: dec(l.amount, "amount"), dueAt: Number(l.dueAt), closedAt: Number(l.closedAt), outcome: Number(l.outcome), block: Number(l.block), tx: lc(l.tx), log: Number(l.log),
  ...(l.openTx ? { openBlock: Number(l.openBlock), openTx: lc(l.openTx), openLog: Number(l.openLog) } : {}),
});

const iso = (t) => new Date(Number(t) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The spec's MUST fields of an ERC-8004 feedback file. agentId and value are decimal strings (uint256, int128). */
function head({ chainId, identityRegistry, agentId, writer, createdAt, value, decimals, tag1, tag2 }) {
  return {
    agentRegistry: `eip155:${chainId}:${ethers.getAddress(identityRegistry)}`,
    agentId: dec(agentId, "agentId"),
    clientAddress: `eip155:${chainId}:${ethers.getAddress(writer)}`,
    createdAt: iso(createdAt),
    value: String(value), valueDecimals: Number(decimals),
    tag1, tag2,
  };
}

/** A source as a file names it: chain, contract, the blocks it was active in ([first, last], last null while it
 *  lends), the events a reader rebuilds leaves from, and their field names. */
export function sourceOut(s) {
  return {
    chainId: Number(s.chainId), contract: ethers.getAddress(s.contract),
    blocks: [Number(s.blocks?.[0] ?? 0), s.blocks?.[1] == null ? null : Number(s.blocks[1])],
    events: { open: s.events.open, repaid: s.events.repaid, defaulted: s.events.defaulted },
    fields: { amount: s.fields?.amount || "amount", dueAt: s.fields?.dueAt || "dueAt" },
  };
}

/** A statement's tag2: its leaves' one class, "mixed" for several, `fallback` (the line's class) for none. */
export function classOf(leaves, fallback = "unsecured") {
  const set = [...new Set(leaves.map((l) => l.cls || "unsecured"))];
  return set.length === 0 ? fallback : set.length === 1 ? set[0] : MIXED;
}

/**
 * A statement: every loan of `agentId` with this lender closed in [fromBlock, toBlock], committed by `root`, with
 * totals (all, and by class), what was opened and what is outstanding at toBlock, and the latest leaves in full.
 * `prev` is the previous statement's feedbackHash in the same (writer, agent) chain (null for seq 1); fromBlock must be
 * its toBlock + 1. `cls` is the class of the agent's line, used as tag2 when the window closed no loan. `agentId`: a
 * bigint, a decimal string, or a Number below 2^53.
 */
export function statementFile({ chainId, identityRegistry, writer, agentId, cls = "unsecured", asset, decimals, sources, seq, prev, window, leaves, opened, outstanding, createdAt, lender = null, anchors = ANCHORS }) {
  const sorted = sortLeaves(leaves);
  if (sorted.some((l) => !sources[Number(l.src || 0)])) throw new Error("a leaf names a source the statement does not carry");
  const totals = totalsOf(sorted);
  const byClass = {};
  for (const k of [...new Set(sorted.map((l) => l.cls || "unsecured"))].sort()) byClass[k] = totalsOf(sorted.filter((l) => (l.cls || "unsecured") === k));
  const f = head({ chainId, identityRegistry, agentId, writer, createdAt, value: totals.onTime.amount, decimals, tag1: TAG_STATEMENT, tag2: classOf(sorted, cls) });
  f.credit = {
    v: PROFILE,
    ...(lender ? { lender } : {}),
    asset, decimals: Number(decimals),
    sources: sources.map(sourceOut),
    seq: Number(seq), prev: prev ? lc(prev) : null,
    window: { fromBlock: Number(window.fromBlock), toBlock: Number(window.toBlock), toTime: Number(window.toTime) },
    opened: { count: Number(opened.count), amount: dec(opened.amount, "opened.amount") },
    closed: totals,
    classes: byClass,
    outstanding: { count: Number(outstanding.count), amount: dec(outstanding.amount, "outstanding.amount") },
    leaves: sorted.length,
    root: rootOf(sorted, sources, agentId),
    anchors: sorted.slice(-anchors).map(leafOut),
  };
  return f;
}

/** A default, posted when it happens (it is also a leaf of the next statement). */
export function defaultFile({ chainId, identityRegistry, writer, agentId, asset, decimals, source, leaf, createdAt, lender = null }) {
  if (Number(leaf.outcome) !== DEFAULTED) throw new Error("a default entry carries a defaulted leaf");
  const f = head({ chainId, identityRegistry, agentId, writer, createdAt, value: dec(leaf.amount, "amount"), decimals, tag1: TAG_DEFAULTED, tag2: leaf.cls || "unsecured" });
  f.credit = { v: PROFILE, ...(lender ? { lender } : {}), asset, decimals: Number(decimals), sources: [sourceOut(source)], leaf: leafOut({ ...leaf, src: 0 }) };
  return f;
}

/**
 * A file's canonical JSON: RFC 8785 (JCS) for the values this profile uses. Object keys sorted by UTF-16 code units, no
 * whitespace, strings as JSON.stringify writes them, numbers only as safe integers. Throws on anything else.
 */
export function canonicalJSON(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") {
    if (!v.isWellFormed()) throw new TypeError("a string with a lone surrogate is not I-JSON");
    return JSON.stringify(v);
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new TypeError(`${v} is not a safe integer: write it as a decimal string`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(",")}]`;
  if (typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${canonicalJSON(k)}:${canonicalJSON(v[k])}`).join(",")}}`;
  }
  throw new TypeError(`a ${typeof v} is not JSON`);
}

/**
 * Bytes, data: URI and keccak256 of a file, in canonical JSON; the oldest anchors are dropped until it fits in `max`
 * bytes. Throws if the file is not a valid v1 file: a writer never posts what a reader rejects.
 */
export function encodeFile(file, { max = MAX_FILE_BYTES } = {}) {
  const cap = Math.min(max, FILE_LIMIT);
  let f = file;
  let bytes = ethers.toUtf8Bytes(canonicalJSON(f));
  while (bytes.length > cap && f.credit?.anchors?.length) {
    f = { ...f, credit: { ...f.credit, anchors: f.credit.anchors.slice(1) } };
    bytes = ethers.toUtf8Bytes(canonicalJSON(f));
  }
  if (bytes.length > cap) throw new Error(`the file is ${bytes.length} bytes, over ${cap}`);
  const problems = validateFile(f);
  if (problems.length) throw new Error(`not a valid ${PROFILE} file: ${problems.join("; ")}`);
  return { file: f, bytes, size: bytes.length, feedbackURI: DATA_URI_PREFIX + ethers.encodeBase64(bytes), feedbackHash: ethers.keccak256(bytes) };
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The bytes a credit entry's URI carries: exactly "data:application/json;base64," then canonical base64 (RFC 4648,
 *  padded, nothing else); null for anything else. */
export function decodeDataURI(uri) {
  if (typeof uri !== "string" || !uri.startsWith(DATA_URI_PREFIX)) return null;
  const b64 = uri.slice(DATA_URI_PREFIX.length);
  if (!B64.test(b64)) return null;
  const bytes = ethers.decodeBase64(b64);
  return ethers.encodeBase64(bytes) === b64 ? bytes : null;
}

/**
 * A file from its bytes, read strictly: at most FILE_LIMIT bytes, UTF-8, JSON, and exactly its own canonical encoding.
 * The last check rejects duplicate keys (a parser keeps one of them), whitespace, and any other way to write a number.
 * Returns { file, problems }; file is null when the bytes are not a canonical JSON file.
 */
export function parseFile(bytes) {
  if (!(bytes instanceof Uint8Array)) return { file: null, problems: ["the file is not bytes"] };
  if (bytes.length > FILE_LIMIT) return { file: null, problems: [`the file is ${bytes.length} bytes, over the ${FILE_LIMIT}-byte limit`] };
  let text, file, again = null;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch (_) { return { file: null, problems: ["the file is not UTF-8"] }; }
  try { file = JSON.parse(text); } catch (_) { return { file: null, problems: ["the file is not JSON"] }; }
  try { again = canonicalJSON(file); } catch (_) { /* not canonical */ }
  if (again !== text) return { file: null, problems: ["the file is not canonical JSON (RFC 8785: keys sorted, no whitespace, no duplicate key, integers only)"] };
  return { file, problems: [] };
}

// ---- the schema --------------------------------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, max = Number.MAX_SAFE_INTEGER, min = 0) => Number.isSafeInteger(v) && v >= min && v <= max;
const isDec = (v, max = UINT256_MAX) => typeof v === "string" && DEC.test(v) && BigInt(v) <= max;
const isHash = (v) => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && ethers.getAddress(v) === v;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max && v.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const CAIP10 = /^eip155:([1-9][0-9]{0,15}):(0x[0-9a-fA-F]{40})$/;
const CAIP19 = /^eip155:([1-9][0-9]{0,15})\/erc20:(0x[0-9a-fA-F]{40})$/;
const chainOf = (re, v) => { const m = typeof v === "string" ? re.exec(v) : null; return m && Number.isSafeInteger(Number(m[1])) && isAddr(m[2]) ? { chainId: Number(m[1]), address: m[2] } : null; };
const isTime = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && Number.isFinite(Date.parse(v)) && iso(Date.parse(v) / 1000) === v;
const show = (v) => JSON.stringify(String(v).slice(0, 40));

/** A v1 asset: a CAIP-19 ERC-20 id, "eip155:<chainId>/erc20:<checksummed address>". { chainId, address } or null. */
export const parseAsset = (asset) => chainOf(CAIP19, asset);

/** Problems with `o`'s keys: a missing required key, or one the schema does not have. */
function keysOf(o, allowed, where, p, optional = []) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) p.push(`${where}: unknown field ${show(k)}`);
  for (const k of allowed) if (!optional.includes(k) && !Object.hasOwn(o, k)) p.push(`${where}: no ${k}`);
}
const HEAD = ["agentRegistry", "agentId", "clientAddress", "createdAt", "value", "valueDecimals", "tag1", "tag2", "credit"];
const STATEMENT = ["v", "lender", "asset", "decimals", "sources", "seq", "prev", "window", "opened", "closed", "classes", "outstanding", "leaves", "root", "anchors"];
const DEFAULT = ["v", "lender", "asset", "decimals", "sources", "leaf"];
const LEAF = ["src", "cls", "loan", "amount", "dueAt", "closedAt", "outcome", "block", "tx", "log", "openBlock", "openTx", "openLog"];
const KINDS = ["onTime", "late", "defaulted", "recovered"];

function tally(t, where, p) {
  if (!isObj(t)) return p.push(`${where} is not { count, amount }`);
  keysOf(t, ["count", "amount"], where, p);
  if (!isInt(t.count)) p.push(`${where}.count is not a count`);
  if (!isDec(t.amount)) p.push(`${where}.amount is not a decimal string of base units`);
}
function byOutcome(t, where, p) {
  if (!isObj(t)) return p.push(`${where} is not { onTime, late, defaulted, recovered }`);
  keysOf(t, KINDS, where, p);
  for (const k of KINDS) if (Object.hasOwn(t, k)) tally(t[k], `${where}.${k}`, p);
}
function leafShape(l, nSources, where, p) {
  if (!isObj(l)) return p.push(`${where} is not a leaf`);
  keysOf(l, LEAF, where, p);
  if (!isInt(l.src, nSources - 1)) p.push(`${where}: src does not name one of the file's sources`);
  if (!CLASSES.includes(l.cls)) p.push(`${where}: cls ${show(l.cls)} is not a class`);
  if (!isDec(l.loan)) p.push(`${where}: loan is not a uint256 decimal string`);
  if (!isDec(l.amount)) p.push(`${where}: amount is not a decimal string of base units`);
  for (const k of ["dueAt", "closedAt", "block", "openBlock"]) if (Object.hasOwn(l, k) && !isInt(l[k])) p.push(`${where}: ${k} is not an integer`);
  if (![ON_TIME, LATE, DEFAULTED].includes(l.outcome)) p.push(`${where}: outcome is not 1, 2 or 3 (4, recovered, is reserved in v1)`);
  for (const k of ["tx", "openTx"]) if (Object.hasOwn(l, k) && !isHash(l[k])) p.push(`${where}: ${k} is not a transaction hash`);
  for (const k of ["log", "openLog"]) if (Object.hasOwn(l, k) && !isInt(l[k], UINT32_MAX)) p.push(`${where}: ${k} is not a log index`);
  if (isInt(l.openBlock) && isInt(l.block) && l.openBlock > l.block) p.push(`${where}: opened after it closed`);
}
/** Problems with one declared event; its topic0, or null when it is not a usable event. */
function eventShape(sig, kind, fields, where, p) {
  const fail = (m) => { p.push(`${where}: events.${kind} ${m}`); return null; };
  if (!isText(sig, 512)) return fail("is not a signature");
  let frag;
  try { frag = ethers.EventFragment.from(`event ${sig}`); } catch (_) { return fail("is not an event signature"); }
  if (frag.anonymous) return fail("is anonymous");
  const names = frag.inputs.map((i) => i.name);
  if (new Set(names).size !== names.length) p.push(`${where}: events.${kind} repeats a parameter name`);
  const need = ["loanId", "agentId", fields?.amount, ...(kind === "open" ? [fields?.dueAt] : [])];
  for (const n of need) if (typeof n === "string" && !frag.inputs.some((i) => i.name === n && /^uint\d*$/.test(i.type))) p.push(`${where}: events.${kind} has no uint parameter ${show(n)}`);
  return frag.topicHash;
}

/** Problems with a source as a file (or a reader's manifest) declares it. */
export function validateSource(s, where = "source") {
  const p = [];
  if (!isObj(s)) return [`${where} is not a source`];
  keysOf(s, ["chainId", "contract", "blocks", "events", "fields"], where, p);
  if (!isInt(s.chainId, Number.MAX_SAFE_INTEGER, 1)) p.push(`${where}: chainId is not a chain id`);
  if (!isAddr(s.contract)) p.push(`${where}: contract is not a checksummed address`);
  const b = s.blocks;
  if (!Array.isArray(b) || b.length !== 2 || !isInt(b[0]) || !(b[1] === null || (isInt(b[1]) && b[1] >= b[0]))) p.push(`${where}: blocks is not [first block, last block or null]`);
  const fieldsOk = isObj(s.fields) && Object.keys(s.fields).length === 2 && ["amount", "dueAt"].every((k) => typeof s.fields[k] === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s.fields[k]));
  if (!fieldsOk) p.push(`${where}: fields is not { amount, dueAt } (parameter names)`);
  if (!isObj(s.events)) p.push(`${where}: events is not { open, repaid, defaulted }`);
  else {
    keysOf(s.events, ["open", "repaid", "defaulted"], `${where}.events`, p);
    const topics = ["open", "repaid", "defaulted"].map((k) => eventShape(s.events[k], k, fieldsOk ? s.fields : null, where, p));
    if (topics.every(Boolean) && new Set(topics).size !== 3) p.push(`${where}: two of its events are the same event`);
  }
  return p;
}

/**
 * The strict, bounded schema of a v1 file, and what a file must say about itself: the value is the on-time principal,
 * the outcome counts add up to the leaves, recovery is zero (reserved), the classes add up to the totals, the root fits
 * the leaf count, the anchors are leaves of the window in leaf order whose outcomes fit their dates. Never throws:
 * returns a list of problems, empty for a valid file.
 */
export function validateFile(f) {
  if (!isObj(f) || !isObj(f.credit) || f.credit.v !== PROFILE) return [`not an ${PROFILE} file`];
  const c = f.credit;
  const isStatement = f.tag1 === TAG_STATEMENT;
  if (!isStatement && f.tag1 !== TAG_DEFAULTED) return [`unknown tag1 ${show(f.tag1)}`];
  const p = [];
  keysOf(f, HEAD, "the file", p);
  const reg = chainOf(CAIP10, f.agentRegistry), client = chainOf(CAIP10, f.clientAddress);
  if (!reg) p.push("agentRegistry is not eip155:<chainId>:<checksummed address>");
  if (!client) p.push("clientAddress is not eip155:<chainId>:<checksummed address>");
  else if (reg && reg.chainId !== client.chainId) p.push("clientAddress and agentRegistry name different chains");
  if (!isDec(f.agentId)) p.push("agentId is not a uint256 decimal string");
  if (!isTime(f.createdAt)) p.push("createdAt is not a UTC time (YYYY-MM-DDTHH:MM:SSZ)");
  if (!isDec(f.value, INT128_MAX)) p.push("value is not a decimal string of base units (int128)");
  if (!isInt(f.valueDecimals, 255)) p.push("valueDecimals is not 0 to 255");
  if (!(CLASSES.includes(f.tag2) || (isStatement && f.tag2 === MIXED))) p.push(`tag2 ${show(f.tag2)} is not a class`);
  keysOf(c, isStatement ? STATEMENT : DEFAULT, "credit", p, ["lender"]);
  if (Object.hasOwn(c, "lender")) {
    const l = c.lender;
    if (!isObj(l) || !isText(l.name, 64) || Object.keys(l).some((k) => !["name", "about"].includes(k)) || (Object.hasOwn(l, "about") && !isText(l.about, 256))) p.push("lender is not { name (1 to 64 characters), about (optional, 1 to 256) } without control characters");
  }
  if (!parseAsset(c.asset)) p.push(`asset ${show(c.asset)} is not a CAIP-19 ERC-20 id (eip155:<chainId>/erc20:<checksummed address>)`);
  if (!isInt(c.decimals, 255)) p.push("decimals is not 0 to 255");
  else if (c.decimals !== f.valueDecimals) p.push("valueDecimals is not the asset's decimals");
  const nMax = isStatement ? MAX_SOURCES : 1;
  if (!Array.isArray(c.sources) || c.sources.length < 1 || c.sources.length > nMax) p.push(isStatement ? `sources is not a list of 1 to ${MAX_SOURCES} sources` : "sources is not exactly one source");
  else {
    c.sources.forEach((s, i) => p.push(...validateSource(s, `source ${i}`)));
    const ids = c.sources.map((s) => `${s?.chainId}:${lc(s?.contract)}`);
    if (new Set(ids).size !== ids.length) p.push("two sources are the same contract");
  }
  const n = Array.isArray(c.sources) ? c.sources.length : 0;
  if (!isStatement) {
    leafShape(c.leaf, n, "leaf", p);
    if (p.length) return p;
    if (c.leaf.outcome !== DEFAULTED) p.push("no defaulted leaf");
    else if (c.leaf.amount !== f.value) p.push("value is not the defaulted principal");
    if (c.leaf.cls !== f.tag2) p.push("tag2 is not the leaf's class");
    return p;
  }
  if (!isInt(c.seq, Number.MAX_SAFE_INTEGER, 1)) p.push("seq is not a positive integer");
  if (!(c.prev === null || isHash(c.prev))) p.push("prev is not null or a hash");
  if (!isObj(c.window)) p.push("window is not { fromBlock, toBlock, toTime }");
  else {
    keysOf(c.window, ["fromBlock", "toBlock", "toTime"], "window", p);
    for (const k of ["fromBlock", "toBlock", "toTime"]) if (Object.hasOwn(c.window, k) && !isInt(c.window[k])) p.push(`window.${k} is not an integer`);
  }
  tally(c.opened, "opened", p);
  tally(c.outstanding, "outstanding", p);
  byOutcome(c.closed, "closed", p);
  if (!isObj(c.classes) || Object.keys(c.classes).length > CLASSES.length) p.push("classes is not { <class>: totals }");
  else for (const [k, v] of Object.entries(c.classes)) { if (!CLASSES.includes(k)) p.push(`classes: ${show(k)} is not a class`); byOutcome(v, `classes.${show(k)}`, p); }
  if (!isInt(c.leaves)) p.push("leaves is not a count");
  if (!isHash(c.root)) p.push("root is not a hash");
  if (!Array.isArray(c.anchors) || c.anchors.length > MAX_ANCHORS) p.push(`anchors is not a list of at most ${MAX_ANCHORS} leaves`);
  else c.anchors.forEach((a, i) => leafShape(a, n, `anchor ${i}`, p));
  if (p.length) return p;

  // what the file says about itself
  if (f.value !== c.closed.onTime.amount) p.push("value is not the on-time principal");
  if (KINDS.reduce((s, k) => s + c.closed[k].count, 0) !== c.leaves) p.push("outcome counts do not add up to the leaf count");
  if (c.closed.recovered.count !== 0 || c.closed.recovered.amount !== "0") p.push("recovered is reserved in v1: its count and amount must be 0");
  const cls = Object.keys(c.classes);
  for (const k of KINDS) {
    const count = cls.reduce((s, x) => s + c.classes[x][k].count, 0), amount = cls.reduce((s, x) => s + BigInt(c.classes[x][k].amount), 0n);
    if (count !== c.closed[k].count || amount.toString() !== c.closed[k].amount) { p.push("classes do not add up to closed"); break; }
  }
  if (cls.some((x) => KINDS.every((k) => c.classes[x][k].count === 0))) p.push("a class with no loan");
  if (cls.length && f.tag2 !== (cls.length === 1 ? cls[0] : MIXED)) p.push("tag2 is not the class of the window's loans");
  if (!cls.length && f.tag2 === MIXED) p.push("tag2 is mixed with no loan");
  if (c.leaves === 0 && c.root !== ethers.ZeroHash) p.push("no leaves but a root");
  if (c.leaves > 0 && c.root === ethers.ZeroHash) p.push(`a zero root over ${c.leaves} leaves`);
  if (c.anchors.length > c.leaves) p.push("more anchors than leaves");
  if (!(c.window.fromBlock <= c.window.toBlock)) p.push("window is empty");
  if (c.seq === 1 ? c.prev !== null : c.prev === null) p.push("prev does not fit seq");
  c.anchors.forEach((a, i) => {
    if (a.block < c.window.fromBlock || a.block > c.window.toBlock) p.push(`anchor loan ${a.loan}: closed outside the window`);
    const b = c.anchors[i - 1];
    if (b && !(b.block < a.block || (b.block === a.block && b.log < a.log))) p.push(`anchor loan ${a.loan}: anchors are not in leaf order`);
    if ((a.outcome === ON_TIME || a.outcome === LATE) && a.outcome !== outcomeOf({ closedAt: a.closedAt, dueAt: a.dueAt })) p.push(`anchor loan ${a.loan}: outcome does not fit its dates`);
  });
  return p;
}

/**
 * Shape checks a reader runs on a decoded file before touching the chain: the schema and what the file says about
 * itself (validateFile), then the spec fields against the entry the registry logged. Returns a list of problems.
 */
export function checkFile(f, entry) {
  const p = validateFile(f);
  if (p.length) return p;
  let id = null;
  try { id = toId(entry?.agentId, "agentId"); } catch (_) { /* reported below */ }
  if (id === null || id !== BigInt(f.agentId)) p.push("agentId differs from the entry");
  if (lc(f.clientAddress.split(":")[2]) !== lc(entry?.client)) p.push("clientAddress is not the entry's writer");
  if (f.tag1 !== entry?.tag1 || f.tag2 !== entry?.tag2) p.push("tag1/tag2 differ from the entry");
  if (f.value !== String(entry?.value) || f.valueDecimals !== Number(entry?.valueDecimals)) p.push("value/valueDecimals differ from the entry");
  return p;
}

const keyOf = (s) => `${Number(s.chainId)}:${lc(s.contract)}`;
const reaches = (s, from, to) => Number(s.blocks[0]) <= to && (s.blocks[1] == null || Number(s.blocks[1]) >= from);
/** Whether two declarations of a source read the same events and fields (the signatures exactly, parameter names too). */
export const sameEvents = (a, b) => ["open", "repaid", "defaulted"].every((k) => a.events[k] === b.events[k]) && a.fields.amount === b.fields.amount && a.fields.dueAt === b.fields.dueAt;

/**
 * The sources a chain covers. Each source is covered from its first block: the first statement that declares it starts
 * at or before blocks[0] (for seq 1, at or before every source it declares), and every later statement whose window
 * the source's blocks reach declares it again. A declaration does not change (its end may go from null to a block).
 * With `manifest` (the reader's own list of the writer's sources) every manifest source counts as declared from the
 * chain's start, the files may declare no other source, and their events and fields are the manifest's.
 */
function checkSources(chain, manifest) {
  const p = [];
  const seen = new Map();
  const man = manifest ? new Map(manifest.map((s) => [keyOf(s), s])) : null;
  const start = chain.length ? Number(chain[0].file.credit.window.fromBlock) : 0;
  if (man) for (const m of man.values()) if (Number(m.blocks[0]) < start) p.push(`seq ${chain[0].file.credit.seq} starts at block ${start}, after the first block of source ${m.contract} (${m.blocks[0]}) in the reader's manifest: its loans before ${start} are in no statement`);
  for (const s of chain) {
    const c = s.file.credit, tag = `seq ${c.seq}`;
    const from = Number(c.window.fromBlock), to = Number(c.window.toBlock);
    const here = new Map((c.sources || []).map((x) => [keyOf(x), x]));
    for (const [k, x] of here) {
      const was = seen.get(k);
      if (!was) {
        if (Number(x.blocks[0]) < from && !man?.has(k)) p.push(`${tag} starts at block ${from}, after the first block of source ${x.contract} (${x.blocks[0]}): its loans before ${from} are in no statement`);
        seen.set(k, x);
      } else if (Number(x.blocks[0]) !== Number(was.blocks[0]) || !sameEvents(x, was) || (was.blocks[1] != null && x.blocks[1] !== was.blocks[1])) {
        p.push(`${tag}: source ${x.contract}'s declaration changed (first block, end, events or fields)`);
      } else seen.set(k, x);
      if (man) {
        const m = man.get(k);
        if (!m) p.push(`${tag}: source ${x.contract} is not in the reader's manifest`);
        else if (!sameEvents(x, m)) p.push(`${tag}: source ${x.contract}'s events or fields are not the reader's manifest's`);
      }
    }
    for (const [k, x] of seen) if (!here.has(k) && !man?.has(k) && reaches(x, from, to)) p.push(`${tag} does not declare source ${x.contract}, which an earlier statement declared and whose blocks reach this window`);
    if (man) for (const [k, m] of man) if (!here.has(k) && reaches(m, from, to)) p.push(`${tag} does not declare source ${m.contract} of the reader's manifest, whose blocks reach this window`);
  }
  return p;
}

/**
 * Walk one (writer, agent) chain of statements in seq order: seq starts at 1 and steps by 1, each prev is the
 * previous feedbackHash, each window starts right after the previous one, every source is covered from its first block
 * (checkSources), and the asset and its decimals never change. `manifest`: the sources the reader trusts this writer
 * to have (see checkSources). Returns problems (a gap is a problem).
 */
export function checkChain(statements, { manifest = null } = {}) {
  const p = [];
  let last = null;
  for (const s of statements) {
    const c = s.file.credit;
    if (!last) {
      if (Number(c.seq) !== 1) p.push(`the chain starts at seq ${c.seq}, not 1`);
    } else {
      if (Number(c.seq) !== Number(last.file.credit.seq) + 1) p.push(`seq ${last.file.credit.seq} is followed by ${c.seq}`);
      if (lc(c.prev) !== lc(last.feedbackHash)) p.push(`seq ${c.seq}: prev is not seq ${last.file.credit.seq}'s hash`);
      if (Number(c.window.fromBlock) !== Number(last.file.credit.window.toBlock) + 1) p.push(`seq ${c.seq}: window starts at ${c.window.fromBlock}, not right after ${last.file.credit.window.toBlock}`);
    }
    last = s;
  }
  p.push(...checkSources(statements, manifest));
  const first = statements[0]?.file.credit;
  for (const s of statements.slice(1)) {
    const c = s.file.credit;
    if (c.asset !== first.asset || c.decimals !== first.decimals) p.push(`seq ${c.seq}: asset ${c.asset} (${c.decimals} decimals) differs from seq ${first.seq}'s ${first.asset} (${first.decimals} decimals): one writer, one asset per agent`);
  }
  return p;
}

/** Totals over a chain's statements (the reader adds these up itself: getSummary averages, it does not sum), in the
 *  chain's one asset. */
export function chainTotals(statements) {
  const first = statements[0]?.file.credit;
  const t = { asset: first?.asset ?? null, decimals: first ? Number(first.decimals) : null, statements: statements.length, onTime: zero(), late: zero(), defaulted: zero(), recovered: zero(), opened: zero(), outstanding: zero(), toBlock: 0 };
  for (const s of statements) {
    const c = s.file.credit;
    for (const k of KINDS) { t[k].count += Number(c.closed[k].count); t[k].amount = (big(t[k].amount) + big(c.closed[k].amount)).toString(); }
    t.opened.count += Number(c.opened.count); t.opened.amount = (big(t.opened.amount) + big(c.opened.amount)).toString();
    t.outstanding = { count: Number(c.outstanding.count), amount: String(c.outstanding.amount) };
    t.toBlock = Number(c.window.toBlock);
  }
  return t;
}

/** An event signature's fragment and where its indexed params sit (topics[1..3]). */
export function eventInfo(sig) {
  const frag = ethers.EventFragment.from(sig.startsWith("event ") ? sig : `event ${sig}`);
  const topicOf = {};
  let k = 1;
  for (const inp of frag.inputs) if (inp.indexed) topicOf[inp.name] = k++;
  return { frag, iface: new ethers.Interface([frag]), topic0: frag.topicHash, topicOf };
}
