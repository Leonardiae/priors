// ERC-8004 credit profile reader (docs/ERC-8004-CREDIT.md): an agent's credit history from any lender that writes
// "erc8004-credit/v1" entries, checked against the chain. Lender-neutral: it knows nothing about Priors beyond what
// each file declares (its sources: contract, events, field names), or what the reader's own manifest says.
//
//   readCredit(provider, agentId, { writers, fromBlock, mode: "light" | "full", funds, manifest, locate })
//
// Entries come from a scan of the registry's NewFeedback logs from `fromBlock`, or, with `locate`, from the receipts
// of entries the caller located (an indexer), checked complete against the registry's getLastIndex.
//
// What it checks:
//   every entry   its URI is data:application/json;base64, (canonical base64); its feedbackHash is keccak256 of those
//                 bytes; the bytes are canonical JSON of a file that passes the v1 schema; the file's spec fields are
//                 the entry's; it is not revoked (a credit entry is never revoked: a revoked one is reported);
//   every chain   statements of one (writer, agent) run seq 1, 2, 3 ... with prev = the previous feedbackHash and
//                 windows back to back; each declared source is covered from its first block; one asset throughout;
//                 each window ends before the block its statement was posted in, at the time it says;
//   light         a sample: each statement's anchors and each default entry's leaf against the source's logs (the
//                 closing log, the opening log's dueAt, the close block's time, the outcome) and, with `funds`, the
//                 asset that moved for those loans. It does not check that a root covers every loan of its window or
//                 the totals: a light result is the writer's claim ("sampled") and is never counted. It does not read
//                 the sources past the last statement: it reports where the statements end (`after`);
//   full          every statement rebuilt from the sources' logs: its leaves, root, leaf count, totals, what was opened
//                 in the window and what was outstanding at its end. Fund movement stays sampled (anchors, defaults).
//                 The sources are also scanned past the last statement, to the block read at: what closed and opened
//                 there is reported (`after`, not counted), and a default there that no default entry of the writer
//                 reports fails the writer, so a writer that stops posting cannot leave a later default out.
// Not checked: the class split (the lender's claim), the lender's honesty about whom it lends to, and, unless the reader
// gives a `manifest` naming the writer, which contracts are the lender's: without one, a source the writer never
// declares is not seen, and a source it declares is rebuilt as it stands, so a writer key can declare a contract of
// its own whose logs record loans that never happened (with money moved for the anchors only) and its statements
// rebuild exactly. A reader chooses which writers it trusts (`writers`), as ERC-8004's getSummary requires; with a
// manifest, a trusted writer the manifest does not name fails. `counted` adds up, by asset, only trusted writers
// whose chains were rebuilt against the reader's manifest (each writer's `manifest` says whether one named it).
import { ethers } from "ethers";
import * as P from "./credit-profile.mjs";
import { REPUTATION_REGISTRY, REGISTRY_ABI, NEW_FEEDBACK } from "./attestation.mjs";

export const TRANSFER = "event Transfer(address indexed from, address indexed to, uint256 value)";
const ERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
/** The reader's budgets: entries read per writer, log queries per full rebuild of one writer's chain, and RPC requests
 *  per read (readCredit), every writer and both endpoints together. Anyone can post credit entries about an agent, and
 *  checking a statement costs up to 2 requests plus 3 per anchor (16 at most): the last budget bounds what a read that
 *  names no writers pays, whatever was planted. */
export const LIMITS = { entries: 1000, queries: 5000, requests: 20_000 };
const nf = new ethers.Interface([NEW_FEEDBACK]);
const tf = new ethers.Interface([TRANSFER]);
const lc = (a) => String(a || "").toLowerCase();
const big = (v) => BigInt(String(v ?? 0));
// an error's text, without any URL: a paid node's URL carries its key, and an error that is not ethers' own (a fetch
// failure) quotes it in its message; what is left goes into problems a reader may show anyone
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>),\]]+/gi;
const msg = (x) => String(x?.shortMessage || x?.message || x).replace(URL_RE, "<url>").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);
const keyOf = (s) => `${Number(s.chainId)}:${lc(s.contract)}`;
const zero = () => ({ count: 0, amount: "0" });

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/** An answer, not a busy endpoint: a revert, data that does not decode or a spent budget is not worth a second try. */
const settled = (e) => ["CALL_EXCEPTION", "BAD_DATA", "INVALID_ARGUMENT", "NUMERIC_FAULT", "BUDGET"].includes(e?.code);
const spent = (e) => e?.code === "BUDGET";

/** `provider` for one read, its requests counted in `budget` ({ max, used }, shared by every endpoint of the read):
 *  each call the reader makes is one request, and a call past `max` throws instead of reaching the endpoint. */
function metered(provider, budget) {
  const go = (f) => async (...a) => {
    if (++budget.used > budget.max) throw Object.assign(new Error(`the reader's budget of ${budget.max} RPC requests for one read is spent`), { code: "BUDGET" });
    return provider[f](...a);
  };
  const m = { getNetwork: go("getNetwork"), getBlockNumber: go("getBlockNumber"), getBlock: go("getBlock"), getTransactionReceipt: go("getTransactionReceipt"), getLogs: go("getLogs"), call: go("call") };
  m.provider = m;
  return m;
}
/** Public endpoints answer "busy" under load: back off (0.5 s, 1, 2, 4, 8) before giving up. */
async function retry(fn, tries = 6) {
  let e;
  for (let k = 0; k < tries; k++) { try { return await fn(); } catch (x) { e = x; if (settled(x)) throw x; if (k < tries - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** k)); } }
  throw e;
}

/** A block number argument: a non-negative safe integer, as a Number, a bigint or a decimal string. */
function blockArg(v, what) {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${what} must be a block number, not ${String(v)}: the block to read from (for the registry, its deployment block)`);
  return n;
}

/** getLogs over [from, to] in chunks of `span` blocks (public endpoints cap the range). */
export async function logsIn(provider, filter, from, to, span = 100_000) {
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(to)) throw new TypeError(`logsIn needs block numbers, not ${from}..${to}`);
  if (!Number.isSafeInteger(span) || span < 1) throw new TypeError(`span must be a positive integer, not ${span}`);
  const out = [];
  for (let a = from; a <= to; a += span) {
    const b = Math.min(to, a + span - 1);
    out.push(...await retry(() => provider.getLogs({ ...filter, fromBlock: a, toBlock: b })));
  }
  return out;
}

/** The asset's token address from its CAIP-19 id ("eip155:4663/erc20:0x…"); null when the id is malformed or, given
 *  `chainId`, names another chain. */
export const assetAddress = (asset, chainId = null) => { const a = P.parseAsset(asset); return a && (chainId == null || a.chainId === Number(chainId)) ? a.address : null; };

/** A NewFeedback log as an entry. */
const entryOf = (a, l) => ({ agentId: a.agentId.toString(), client: ethers.getAddress(a.clientAddress), index: Number(a.feedbackIndex), value: a.value.toString(), valueDecimals: Number(a.valueDecimals), tag1: a.tag1, tag2: a.tag2, uri: a.feedbackURI, feedbackHash: a.feedbackHash, block: l.blockNumber, tx: l.transactionHash });

/**
 * One writer's entries for one agent from a list the caller located (an indexer, a cache), for a reader that cannot
 * scan the registry's logs: each { txHash, blockNumber?, logIndex? } is read from its receipt, and must hold the
 * registry's NewFeedback log for this agent from this writer. Completeness is the registry's own count: the located
 * entries, credit or not, must be feedbackIndex 1 to getLastIndex(agentId, writer), none missing. Returns
 * { entries (credit entries, as findEntries gives them, by index), problems, last }.
 */
export async function locatedEntries(provider, { agentId, writer, located, registry = REPUTATION_REGISTRY, tags = P.TAGS, max = LIMITS.entries }) {
  const id = P.toId(agentId, "agentId");
  const w = ethers.getAddress(writer);
  if (!Array.isArray(located)) throw new TypeError("located entries are a list of { txHash, blockNumber?, logIndex? }");
  if (located.length > max) throw new RangeError(`${located.length} located entries, over the reader's limit of ${max}`);
  const topic = nf.getEvent("NewFeedback").topicHash;
  const problems = [], byIndex = new Map();
  for (const [i, loc] of located.entries()) {
    const tx = loc?.txHash;
    const where = `located entry ${i + 1}`;
    if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) { problems.push(`${where}: no transaction hash`); continue; }
    const rc = await retry(() => provider.getTransactionReceipt(tx));
    if (!rc || rc.status !== 1) { problems.push(`${where}: transaction ${tx} not found or failed`); continue; }
    if (loc.blockNumber != null && Number(loc.blockNumber) !== rc.blockNumber) problems.push(`${where}: transaction ${tx} is in block ${rc.blockNumber}, not ${loc.blockNumber}`);
    const logs = [];
    for (const l of rc.logs) {
      if (lc(l.address) !== lc(registry) || l.topics[0] !== topic || (loc.logIndex != null && l.index !== Number(loc.logIndex))) continue;
      try { logs.push({ l, a: nf.parseLog(l).args }); } catch (_) { /* not a NewFeedback log after all */ }
    }
    const mine = logs.filter(({ a }) => a.agentId === id && ethers.getAddress(a.clientAddress) === w);
    if (!mine.length) {
      const agent = logs.find(({ a }) => a.agentId !== id), from = logs.find(({ a }) => a.agentId === id);
      problems.push(`${where}: transaction ${tx} ${!logs.length ? `holds no NewFeedback log of the registry ${registry}` : from ? `is from writer ${ethers.getAddress(from.a.clientAddress)}, not ${w}` : `names agent ${agent.a.agentId}, not ${id}`}`);
      continue;
    }
    for (const { l, a } of mine) {
      const e = entryOf(a, l);
      const was = byIndex.get(e.index);
      if (was && (was.tx !== e.tx || was.feedbackHash !== e.feedbackHash)) problems.push(`entry ${e.index}: located twice, in ${was.tx} and ${e.tx}`);
      else byIndex.set(e.index, e);
    }
  }
  const last = Number(await retry(() => new ethers.Contract(registry, REGISTRY_ABI, provider).getLastIndex(id, w)));
  for (let k = 1; k <= last; k++) if (!byIndex.has(k)) problems.push(`entry ${k} of ${last} (getLastIndex): an entry the index did not give`);
  for (const k of byIndex.keys()) if (k < 1 || k > last) problems.push(`entry ${k}: past the registry's last index (${last})`);
  const entries = [...byIndex.values()].filter((e) => tags.includes(e.tag1)).sort((a, b) => a.index - b.index);
  return { entries, problems, last };
}

/**
 * Every credit entry for `agentId` on the registry (optionally only from `writers`), oldest first. `fromBlock` is
 * required (the registry's deployment block, say): without it nothing would be read and nothing reported.
 * Each entry: { agentId (decimal string), client, index, value, valueDecimals, tag1, tag2, uri, feedbackHash, block, tx }.
 * With `located` ({ "<writer>": [{ txHash, blockNumber?, logIndex? }] }) no log is scanned: each writer's entries are
 * read from their receipts (locatedEntries), and an incomplete or wrong list throws.
 */
export async function findEntries(provider, { agentId, writers = null, fromBlock, toBlock = null, span = 100_000, registry = REPUTATION_REGISTRY, tags = P.TAGS, located = null } = {}) {
  if (located != null) {
    if (typeof located !== "object" || Array.isArray(located)) throw new TypeError('located is { "<writer>": [{ txHash, blockNumber?, logIndex? }] }');
    const out = [];
    for (const [w, list] of Object.entries(located)) {
      const r = await locatedEntries(provider, { agentId, writer: w, located: list, registry, tags });
      if (r.problems.length) throw new Error(`writer ${ethers.getAddress(w)}: ${r.problems.join("; ")}`);
      out.push(...r.entries);
    }
    return out.sort((a, b) => a.block - b.block || a.index - b.index);
  }
  const id = P.toId(agentId, "agentId");
  const from = blockArg(fromBlock, "fromBlock");
  const to = toBlock == null ? await provider.getBlockNumber() : blockArg(toBlock, "toBlock");
  if (from > to) throw new RangeError(`fromBlock ${from} is after toBlock ${to}: nothing would be read`);
  const only = writers && writers.length ? writers.map((w) => ethers.getAddress(w)) : null;
  const topics = [nf.getEvent("NewFeedback").topicHash, ethers.toBeHex(id, 32), only ? only.map((w) => ethers.zeroPadValue(w, 32)) : null, tags.map((t) => ethers.id(t))];
  const out = [];
  for (const l of await logsIn(provider, { address: registry, topics }, from, to, span)) {
    let a = null;
    try { a = nf.parseLog(l)?.args; } catch (_) { /* not a NewFeedback log: the endpoint answered off-filter */ }
    if (!a || a.agentId !== id || (only && !only.includes(ethers.getAddress(a.clientAddress))) || !tags.includes(a.tag1)) continue;
    out.push(entryOf(a, l));
  }
  return out;
}

const URI_LIMIT = P.DATA_URI_PREFIX.length + Math.ceil(P.FILE_LIMIT / 3) * 4;
/** Decode and shape-check one entry: { entry, file, feedbackHash, problems }. Never throws; `file` is null unless the
 *  bytes are a canonical v1 file that passes the schema. */
export function openEntry(entry) {
  try {
    const uri = entry?.uri;
    if (typeof uri !== "string" || !uri.startsWith(P.DATA_URI_PREFIX)) return { entry, file: null, problems: [`the feedbackURI is not ${P.DATA_URI_PREFIX}…`] };
    if (uri.length > URI_LIMIT) return { entry, file: null, problems: [`the file is more than ${P.FILE_LIMIT} bytes, the limit`] };
    const bytes = P.decodeDataURI(uri);
    if (!bytes) return { entry, file: null, problems: ["the feedbackURI's base64 is not canonical (RFC 4648, padded, nothing else)"] };
    if (ethers.keccak256(bytes) !== lc(entry.feedbackHash)) return { entry, file: null, problems: ["feedbackHash is not keccak256 of the file"] };
    const { file, problems } = P.parseFile(bytes);
    if (!file) return { entry, file: null, problems };
    const shape = P.validateFile(file);
    if (shape.length) return { entry, file: null, problems: shape };
    return { entry, file, feedbackHash: entry.feedbackHash, problems: P.checkFile(file, entry) };
  } catch (x) {
    return { entry, file: null, problems: [`the entry could not be read: ${msg(x)}`] };
  }
}

/**
 * A reader's manifest: the sources it trusts each writer to have, from somewhere other than the writer's files,
 * { "<writer address>": { "sources": [source, ...] } } with sources as files write them (chainId, contract, blocks,
 * events, fields). A Map of lowercase writer address to { sources }. Throws on a malformed manifest.
 */
export function readManifest(manifest) {
  if (manifest == null) return null;
  if (typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError('the manifest is { "<writer address>": { "sources": [ ... ] } }');
  const out = new Map();
  for (const [w, v] of Object.entries(manifest)) {
    let addr;
    try { addr = ethers.getAddress(w); } catch (_) { throw new TypeError(`manifest: ${JSON.stringify(w.slice(0, 50))} is not a writer address`); }
    if (!v || !Array.isArray(v.sources) || !v.sources.length || v.sources.length > P.MAX_SOURCES) throw new TypeError(`manifest ${addr}: sources is a list of 1 to ${P.MAX_SOURCES} sources`);
    const sources = v.sources.map((s, i) => {
      const where = `manifest ${addr} source ${i}`;
      if (!Array.isArray(s?.blocks) || !s?.events) throw new TypeError(`${where}: needs chainId, contract, blocks, events and fields`);
      let out;
      try { out = P.sourceOut(s); } catch (x) { throw new TypeError(`${where}: ${msg(x)}`); }
      const p = P.validateSource(out, where);
      if (p.length) throw new TypeError(p.join("; "));
      return out;
    });
    out.set(lc(addr), { sources });
  }
  return out;
}

/** A per-run cache of block times, receipts and tokens, and the source events parsed once. `provider` reads the
 *  lenders' history (logs, receipts, block times): an archive endpoint when the registry's endpoint keeps little. */
export function context(provider) {
  const times = new Map(), receipts = new Map(), events = new Map(), tokens = new Map();
  return {
    provider,
    async time(block) {
      if (!times.has(block)) times.set(block, retry(() => provider.getBlock(block)).then((b) => { if (!b) throw new Error(`block ${block} not found`); return Number(b.timestamp); }));
      return times.get(block);
    },
    async receipt(tx) { if (!receipts.has(tx)) receipts.set(tx, retry(() => provider.getTransactionReceipt(tx))); return receipts.get(tx); },
    ev(sig) { if (!events.has(sig)) events.set(sig, P.eventInfo(sig)); return events.get(sig); },
    /** An ERC-20's decimals() and symbol(), each null when it cannot be read. */
    async token(address) {
      if (!tokens.has(address)) tokens.set(address, (async () => {
        const t = new ethers.Contract(address, ERC20, provider);
        let decimals = null, symbol = null;
        try { decimals = Number(await retry(() => t.decimals())); } catch (x) { if (spent(x)) throw x; /* else reported by the caller */ }
        try { const s = await retry(() => t.symbol()); if (/^[\x21-\x7e]{1,16}$/.test(s)) symbol = s; } catch (x) { if (spent(x)) throw x; /* else display only */ }
        return { address, decimals, symbol };
      })());
      return tokens.get(address);
    },
  };
}

const fieldsOf = (src) => ({ amount: src.fields?.amount || "amount", dueAt: src.fields?.dueAt || "dueAt" });

/** A decoded log of `sig`, or null when the log is not that event of that contract. */
function decode(ctx, src, sig, log) {
  if (!log || lc(log.address) !== lc(src.contract)) return null;
  const e = ctx.ev(sig);
  if (log.topics[0] !== e.topic0) return null;
  try { return e.iface.parseLog(log).args; } catch (_) { return null; }
}

/** Whether `rc` moved at least `amount` of `asset` out of (`dir` "out") or into ("in") `contract`. */
function moved(rc, asset, contract, dir, amount) {
  const topic = tf.getEvent("Transfer").topicHash;
  let sum = 0n;
  for (const l of rc.logs) {
    if (lc(l.address) !== lc(asset) || l.topics[0] !== topic) continue;
    let a;
    try { a = tf.parseLog(l).args; } catch (_) { continue; } // an ERC-721 Transfer has the same topic0
    if (dir === "out" ? lc(a.from) === lc(contract) : lc(a.to) === lc(contract)) sum += a.value;
  }
  return sum >= big(amount);
}

/**
 * Check one written leaf (an anchor, or a default entry's leaf) against the chain. Returns a list of problems.
 * Needs the opening log's place (openBlock, openTx, openLog) for dueAt, which written leaves carry. With `asset` (the
 * token's address), also that the lender paid out at least the principal when the loan opened and, for a repayment,
 * that at least the principal came back.
 */
export async function verifyLeaf(ctx, src, agentId, leaf, { asset = null } = {}) {
  const p = [];
  const id = P.toId(agentId, "agentId");
  const f = fieldsOf(src);
  const isDefault = Number(leaf.outcome) === P.DEFAULTED;
  const rc = await ctx.receipt(leaf.tx);
  if (!rc || rc.status !== 1) return [`loan ${leaf.loan}: closing transaction ${leaf.tx} not found or failed`];
  if (rc.blockNumber !== Number(leaf.block)) p.push(`loan ${leaf.loan}: closing transaction is in block ${rc.blockNumber}, not ${leaf.block}`);
  const close = decode(ctx, src, isDefault ? src.events.defaulted : src.events.repaid, rc.logs.find((l) => l.index === Number(leaf.log)));
  if (!close) return [...p, `loan ${leaf.loan}: log ${leaf.log} of ${leaf.tx} is not the lender's ${isDefault ? "default" : "repayment"}`];
  if (big(close.loanId) !== big(leaf.loan) || big(close.agentId) !== id) p.push(`loan ${leaf.loan}: the closing log names loan ${close.loanId} of agent ${close.agentId}`);
  if (big(close[f.amount]) !== big(leaf.amount)) p.push(`loan ${leaf.loan}: amount ${close[f.amount]} on chain, ${leaf.amount} in the file`);
  if ((await ctx.time(rc.blockNumber)) !== Number(leaf.closedAt)) p.push(`loan ${leaf.loan}: closedAt is not the closing block's time`);
  if (leaf.openTx == null) p.push(`loan ${leaf.loan}: no opening log named, dueAt unchecked`);
  else {
    const orc = await ctx.receipt(leaf.openTx);
    const open = orc && orc.status === 1 ? decode(ctx, src, src.events.open, orc.logs.find((l) => l.index === Number(leaf.openLog))) : null;
    if (!open || big(open.loanId) !== big(leaf.loan) || big(open.agentId) !== id || (leaf.openBlock != null && orc.blockNumber !== Number(leaf.openBlock))) p.push(`loan ${leaf.loan}: the opening log is not this loan's`);
    else {
      if (big(open[f.dueAt]) !== big(leaf.dueAt)) p.push(`loan ${leaf.loan}: dueAt ${open[f.dueAt]} on chain, ${leaf.dueAt} in the file`);
      if (asset && !moved(orc, asset, src.contract, "out", leaf.amount)) p.push(`loan ${leaf.loan}: the lender paid out less than the principal in ${asset}`);
    }
  }
  const want = isDefault ? P.DEFAULTED : P.outcomeOf({ closedAt: leaf.closedAt, dueAt: leaf.dueAt });
  if (Number(leaf.outcome) !== want) p.push(`loan ${leaf.loan}: outcome ${leaf.outcome}, the dates say ${want}`);
  if (asset && !isDefault && !moved(rc, asset, src.contract, "in", leaf.amount)) p.push(`loan ${leaf.loan}: less than the principal was paid back into the lender in ${asset}`);
  return p;
}

/** The getLogs queries one source's rebuild makes over [a, b]: one per chunk, per group of events indexing agentId at
 *  the same topic. */
function queriesOf(ctx, src, a, b, span) {
  if (a > b) return 0;
  const at = new Set(["open", "repaid", "defaulted"].map((k) => ctx.ev(src.events[k]).topicOf.agentId || 0));
  return at.size * Math.ceil((b - a + 1) / span);
}

/**
 * Every loan of `agentId` at `src` closed in [from, to], rebuilt from the lender's logs: leaves (sorted, with dueAt
 * from the opening log and closedAt from the block), and the opens by block, for the opened/outstanding checks.
 * Opens are read from `openFrom` (the chain's first window start): a loan opened earlier is reported. The scan covers
 * [max(openFrom, lo), min(to, hi)]: pass a source's range only when the reader trusts it (a manifest); a writer's
 * declared `blocks` could end early to hide later loans.
 */
export async function rebuild(ctx, src, agentId, { from, to, openFrom = from, span = 100_000, lo = 0, hi = Infinity }) {
  const id = P.toId(agentId, "agentId");
  const ev = { open: ctx.ev(src.events.open), repaid: ctx.ev(src.events.repaid), defaulted: ctx.ev(src.events.defaulted) };
  const f = fieldsOf(src);
  const agentTopic = ethers.toBeHex(id, 32);
  const a0 = Math.max(openFrom, lo), b0 = Math.min(to, hi);
  const all = [], problems = [];
  if (a0 <= b0) {
    // one query per chunk when the three events index agentId at the same topic, else one per event
    const groups = new Map();
    for (const [k, e] of Object.entries(ev)) { const at = e.topicOf.agentId || 0; if (!groups.has(at)) groups.set(at, []); groups.get(at).push([k, e]); }
    for (const [at, list] of groups) {
      const topics = [list.map(([, e]) => e.topic0)];
      if (at) { while (topics.length < at) topics.push(null); topics[at] = agentTopic; }
      for (const l of await logsIn(ctx.provider, { address: src.contract, topics }, a0, b0, span)) {
        if (lc(l.address) !== lc(src.contract)) continue;
        const hit = list.find(([, x]) => x.topic0 === l.topics[0]);
        if (!hit) continue;
        let a;
        try { a = hit[1].iface.parseLog(l).args; } catch (_) { problems.push(`source ${src.contract}: log ${l.index} of ${l.transactionHash} does not decode as its ${hit[0]} event`); continue; }
        if (big(a.agentId) === id) all.push({ k: hit[0], l, a });
      }
    }
  }
  const opens = all.filter((x) => x.k === "open");
  const openOf = new Map(opens.map((o) => [String(o.a.loanId), o]));
  const closes = all.filter((x) => x.k !== "open" && x.l.blockNumber >= from).map((x) => ({ ...x, d: x.k === "defaulted" }));
  const leaves = await pool(closes, 4, async (c) => {
    const o = openOf.get(String(c.a.loanId));
    if (!o) { problems.push(`loan ${c.a.loanId}: closed in the window but no opening log from block ${openFrom}`); return null; }
    const closedAt = await ctx.time(c.l.blockNumber);
    const dueAt = o.a[f.dueAt].toString();
    return { loan: c.a.loanId.toString(), amount: c.a[f.amount].toString(), dueAt, closedAt, outcome: P.outcomeOf({ defaulted: c.d, closedAt, dueAt }), block: c.l.blockNumber, tx: c.l.transactionHash, log: c.l.index };
  });
  return {
    leaves: P.sortLeaves(leaves.filter(Boolean)),
    opens: opens.map((o) => ({ loan: o.a.loanId.toString(), amount: o.a[f.amount].toString(), block: o.l.blockNumber })),
    closedAt: new Map(closes.map((c) => [String(c.a.loanId), c.l.blockNumber])),
    problems,
  };
}

/**
 * Full check of one chain against rebuilt leaves: root, leaf count, totals, opened, outstanding and the anchors, per
 * statement. Every source the chain declares is scanned over the whole chain (its declared blocks are the writer's
 * claim); a manifest's sources are scanned over their trusted range, with the manifest's events. The scan runs on past
 * the last window, to `asOf` (the block read at): what closed and opened there is returned as `after`, and a default
 * there that none of the writer's default entries (`defaults`) reports is a problem, so a writer that stops posting
 * cannot leave a later default out. Returns { problems, after: { closed, opened } | null }.
 */
async function fullCheck(ctx, chain, agentId, { span, manifest = null, maxQueries = LIMITS.queries, asOf = null, defaults = [] }) {
  const problems = [];
  const first = chain[0].file.credit, last = chain.at(-1).file.credit;
  const from = Number(first.window.fromBlock), to = Number(last.window.toBlock);
  const end = Math.max(to, asOf?.block ?? to);
  const srcs = new Map();
  for (const s of chain) for (const x of s.file.credit.sources) srcs.set(keyOf(x), { src: x, lo: 0, hi: Infinity });
  for (const m of manifest || []) srcs.set(keyOf(m), { src: m, lo: Number(m.blocks[0]), hi: m.blocks[1] == null ? Infinity : Number(m.blocks[1]) });
  const net = Number((await ctx.provider.getNetwork()).chainId);
  let queries = 0;
  for (const { src, lo, hi } of srcs.values()) if (Number(src.chainId) === net) queries += queriesOf(ctx, src, Math.max(from, lo), Math.min(end, hi), span);
  if (queries > maxQueries) return { problems: [`a full rebuild needs ${queries} log queries, over the reader's limit of ${maxQueries}: not rebuilt`], after: null };
  const built = [];
  for (const [k, { src, lo, hi }] of srcs) {
    if (Number(src.chainId) !== net) { problems.push(`source ${k}: on another chain, not rebuilt`); continue; }
    const r = await rebuild(ctx, src, agentId, { from, to: end, openFrom: from, span, lo, hi });
    problems.push(...r.problems);
    built.push({ src, ...r });
  }
  for (const s of chain) {
    const c = s.file.credit;
    const a = Number(c.window.fromBlock), b = Number(c.window.toBlock);
    const leaves = [];
    let opened = { count: 0, amount: 0n }, out = { count: 0, amount: 0n };
    for (const r of built) {
      for (const l of r.leaves) if (l.block >= a && l.block <= b) leaves.push({ ...l, srcObj: r.src });
      for (const o of r.opens) {
        if (o.block >= a && o.block <= b) { opened.count++; opened.amount += big(o.amount); }
        const cb = r.closedAt.get(o.loan);
        if (o.block <= b && !(cb != null && cb <= b)) { out.count++; out.amount += big(o.amount); }
      }
    }
    const sorted = P.sortLeaves(leaves);
    const hashes = sorted.map((l) => P.leafHash(l, l.srcObj, agentId));
    const root = P.merkleRoot(hashes);
    const tag = `seq ${c.seq}`;
    if (root !== c.root) problems.push(`${tag}: root rebuilt from the chain is ${root.slice(0, 10)}…, the statement says ${String(c.root).slice(0, 10)}… (${sorted.length} loans on chain, ${c.leaves} in the statement)`);
    else if (sorted.length !== Number(c.leaves)) problems.push(`${tag}: ${sorted.length} loans on chain, ${c.leaves} in the statement`);
    const t = P.totalsOf(sorted);
    for (const k of ["onTime", "late", "defaulted", "recovered"]) if (t[k].count !== Number(c.closed[k].count) || t[k].amount !== String(c.closed[k].amount)) problems.push(`${tag}: ${k} ${t[k].count} / ${t[k].amount} on chain, ${c.closed[k].count} / ${c.closed[k].amount} in the statement`);
    if (opened.count !== Number(c.opened.count) || opened.amount.toString() !== String(c.opened.amount)) problems.push(`${tag}: opened ${opened.count} / ${opened.amount} on chain, ${c.opened.count} / ${c.opened.amount} in the statement`);
    if (out.count !== Number(c.outstanding.count) || out.amount.toString() !== String(c.outstanding.amount)) problems.push(`${tag}: outstanding ${out.count} / ${out.amount} on chain, ${c.outstanding.count} / ${c.outstanding.amount} in the statement`);
    const anchors = c.anchors.map((x) => P.leafHash(x, c.sources[x.src], agentId));
    if (anchors.join() !== hashes.slice(hashes.length - anchors.length).join()) problems.push(`${tag}: the anchors are not the window's latest loans`);
  }
  // after the last window: in no statement yet, so not counted; an unreported default there is the writer's omission
  const later = [], opened = { count: 0, amount: 0n };
  for (const r of built) {
    for (const l of r.leaves) if (l.block > to) later.push({ ...l, srcObj: r.src });
    for (const o of r.opens) if (o.block > to) { opened.count++; opened.amount += big(o.amount); }
  }
  const reported = new Set(defaults.map((d) => `${keyOf(d.file.credit.sources[0])}:${d.file.credit.leaf.loan}`));
  const awaiting = [];
  for (const l of P.sortLeaves(later)) {
    if (l.outcome !== P.DEFAULTED || reported.has(`${keyOf(l.srcObj)}:${l.loan}`)) continue;
    const age = asOf ? asOf.time - l.closedAt : null;
    // the writer has DEFAULT_ENTRY_S to post a default entry: a younger default with none yet is awaited, not a failure
    if (age != null && age < DEFAULT_ENTRY_S) { awaiting.push({ source: ethers.getAddress(l.srcObj.contract), loan: String(l.loan), block: l.block, closedAt: l.closedAt }); continue; }
    const ago = asOf ? `, ${hours(age)} before the block read at; the profile asks for a default entry within 24 hours` : "";
    problems.push(`loan ${l.loan} at source ${ethers.getAddress(l.srcObj.contract)} defaulted in block ${l.block}, after the last statement (to block ${to}), and no default entry of this writer reports it${ago}`);
  }
  return { problems, after: { closed: P.totalsOf(later), opened: { count: opened.count, amount: opened.amount.toString() }, awaiting } };
}
const DEFAULT_ENTRY_S = 24 * 3600; // docs/ERC-8004-CREDIT.md: a writer SHOULD post a default entry within 24 hours of the default
const hours = (s) => (s < 48 * 3600 ? `${(Math.max(0, s) / 3600).toFixed(1)} hours` : `${(s / 86400).toFixed(1)} days`);

const sumInto = (t, x) => { for (const k of ["onTime", "late", "defaulted", "recovered"]) { t[k].count += x[k].count; t[k].amount = (big(t[k].amount) + big(x[k].amount)).toString(); } };

/** A trusted writer the reader's manifest does not name: read as it declares its sources, it would quietly lose every
 *  manifest check, so it fails. */
const notNamed = (writer) => `the reader's manifest does not name writer ${writer}: its sources cannot be checked against the manifest`;

/** One writer's entries for one agent, checked. `asOf`: () => the block read at, { block, time }. `manifest`: the
 *  reader's manifest entry for this writer, or null; `unnamed`: the reader has a manifest that does not name this
 *  writer, and trusts it. */
async function readWriter(ctx, reg, { writer, list, id, mode, funds, span, net, manifest, unnamed = false, maxEntries, maxQueries, located = [], asOf }) {
  const checked = mode === "full" ? "rebuilt" : "sampled";
  const result = (o) => ({ writer, lender: null, asset: null, decimals: null, token: null, statements: 0, defaults: 0, window: null, after: null, checked, manifest: Boolean(manifest), claimed: P.chainTotals([]), anchorsChecked: 0, ...o });
  if (list.length > maxEntries) return result({ status: "failed", ok: false, problems: [`${list.length} credit entries, over the reader's limit of ${maxEntries}: not checked`] });
  const problems = [...(unnamed ? [notNamed(writer)] : []), ...located];
  const opened = list.map((e) => openEntry(e));
  for (const o of opened) {
    const fb = await retry(() => reg.readFeedback(id, o.entry.client, o.entry.index));
    if (fb.isRevoked) o.problems.push(`entry ${o.entry.index} (${o.entry.tag1}) was revoked: a credit entry is never revoked`);
  }
  for (const o of opened) for (const x of o.problems) problems.push(`entry ${o.entry.index}: ${x}`);
  const good = opened.filter((o) => o.file && !o.problems.length);
  const chain = good.filter((o) => o.file.tag1 === P.TAG_STATEMENT).sort((a, b) => a.file.credit.seq - b.file.credit.seq);
  const defaults = good.filter((o) => o.file.tag1 === P.TAG_DEFAULTED);
  const ref = chain[0]?.file.credit || defaults[0]?.file.credit || null;
  // one writer, one asset per agent: the default entries too
  for (const d of defaults) {
    const c = d.file.credit;
    if (c.asset !== ref.asset || c.decimals !== ref.decimals) problems.push(`default entry ${d.entry.index}: asset ${c.asset} (${c.decimals} decimals) differs from the chain's ${ref.asset} (${ref.decimals} decimals)`);
    // held to the manifest as a statement's sources are, events and fields too: with its own, a default entry could cite
    // a repayment's log, or read another parameter of the same types as its amount (GHSA-6rpg)
    const m = manifest?.sources.find((x) => keyOf(x) === keyOf(c.sources[0]));
    if (manifest && !m) problems.push(`default entry ${d.entry.index}: source ${c.sources[0].contract} is not in the reader's manifest`);
    else if (m && !P.sameEvents(c.sources[0], m)) problems.push(`default entry ${d.entry.index}: source ${c.sources[0].contract}'s events or fields are not the reader's manifest's`);
  }
  problems.push(...P.checkChain(chain, { manifest: manifest?.sources || null }));
  // a statement describes the past: its window ends before the block it was posted in, at the time it says
  for (const s of chain) {
    const c = s.file.credit;
    if (c.window.toBlock >= Number(s.entry.block)) problems.push(`seq ${c.seq}: its window ends at block ${c.window.toBlock}, not before the block it was posted in (${s.entry.block})`);
    else if ((await ctx.time(c.window.toBlock)) !== c.window.toTime) problems.push(`seq ${c.seq}: toTime is not block ${c.window.toBlock}'s time`);
  }
  for (const d of defaults) if (d.file.credit.leaf.block >= Number(d.entry.block)) problems.push(`default entry ${d.entry.index}: its loan closes at or after the block it was posted in`);
  // funds: the asset is an ERC-20 on this chain whose decimals are the files'
  let token = null, fundsAsset = null;
  if (funds && ref) {
    const a = P.parseAsset(ref.asset);
    if (a.chainId !== net) problems.push(`asset ${ref.asset} is on chain ${a.chainId}, not on this chain (${net}): funds cannot be checked`);
    else {
      token = await ctx.token(a.address);
      if (token.decimals === null) problems.push(`asset ${ref.asset}: decimals() cannot be read, so the decimals cannot be checked`);
      else if (token.decimals !== ref.decimals) problems.push(`asset ${ref.asset}: the token has ${token.decimals} decimals, the files say ${ref.decimals}`);
      fundsAsset = a.address;
    }
  }
  // the sample: anchors and default leaves
  const checks = [];
  for (const s of chain) for (const x of s.file.credit.anchors) checks.push({ src: s.file.credit.sources[x.src], leaf: x, where: `seq ${s.file.credit.seq}` });
  for (const d of defaults) checks.push({ src: d.file.credit.sources[0], leaf: d.file.credit.leaf, where: `default entry ${d.entry.index}` });
  // the asset and its decimals are the files' word until a sampled loan shows that token moving at a source (the
  // manifest pins sources, not the asset): with no anchor and no default entry, any token at any decimals would stand
  // for the amounts the sources' logs give (GHSA-6rpg)
  if (funds && ref && !checks.length && chain.some((s) => s.file.credit.leaves > 0)) problems.push(`asset ${ref.asset}: its statements close loans but carry no anchor, and there is no default entry: the asset's movement cannot be checked, so the asset and its decimals are not tied to the sources`);
  const res = await pool(checks, 6, (c) => verifyLeaf(ctx, c.src, id, c.leaf, { asset: fundsAsset }).then((p) => p.map((x) => `${c.where}: ${x}`)));
  problems.push(...res.flat());
  // a default entry must be covered by a statement that counts it, once one covers its block
  for (const d of defaults) {
    const b = d.file.credit.leaf.block;
    const s = chain.find((x) => b >= x.file.credit.window.fromBlock && b <= x.file.credit.window.toBlock);
    if (s && s.file.credit.closed.defaulted.count < 1) problems.push(`default of loan ${d.file.credit.leaf.loan}: statement seq ${s.file.credit.seq} covers it and counts no default`);
  }
  // where the statements end: what lies after them, to the block read at, is in no statement (full mode reads it)
  let after = null;
  if (chain.length) {
    const end = chain.at(-1).file.credit.window, at = await asOf();
    after = { fromBlock: end.toBlock + 1, toBlock: at.block, since: end.toTime, closed: null, opened: null };
    if (mode === "full") {
      const f = await fullCheck(ctx, chain, id, { span, manifest: manifest?.sources || null, maxQueries, asOf: at, defaults });
      problems.push(...f.problems);
      if (f.after) Object.assign(after, f.after);
    }
  }
  const claimed = P.chainTotals(chain);
  const status = problems.length ? "failed" : !chain.length ? "no-data" : checked;
  return result({
    lender: ref?.lender || null, asset: ref?.asset ?? null, decimals: ref?.decimals ?? null, token,
    statements: chain.length, defaults: defaults.length, window: chain.length ? [chain[0].file.credit.window.fromBlock, claimed.toBlock] : null, after,
    status, ok: status === "rebuilt" || status === "sampled", claimed, problems, anchorsChecked: checks.length,
  });
}

/** A read-only JSON-RPC provider for `readCredit` (one request at a time, the chain fixed): for a caller that has a
 *  node's URL and no ethers of its own, such as a Worker. It holds no key and can sign nothing. */
export function readProvider(url, chainId = 4663) {
  return new ethers.JsonRpcProvider(String(url), ethers.Network.from(Number(chainId)), { staticNetwork: true, batchMaxCount: 1 });
}

/**
 * An agent's credit history, by writer, checked. `writers`: the lenders' writer addresses the reader trusts (null:
 * every writer found is reported, none is trusted). `fromBlock`: required, the block to read the registry from.
 * `mode`: "light" samples (anchors and defaults), "full" rebuilds every statement from its sources' logs. `funds`: also
 * check the asset moved for the sampled loans, and the token's decimals. `manifest`: the sources the reader trusts each
 * writer to have ({ "<writer>": { sources } }, see readManifest): a writer it names is checked against those sources
 * (they pin its sources); a trusted writer it does not name fails; any other writer is read as it declares its
 * sources. `provider` reads the registry; `history` (default: the same) reads the lenders' logs, receipts, block times
 * and the token.
 * `locate`: for a reader that cannot scan the registry's logs, each writer's entries as the caller located them,
 * { "<writer>": [{ txHash, blockNumber?, logIndex? }] } or async (agentId as a decimal string, writer) => that list.
 * Needs `writers`; `fromBlock` is then unused. Each entry is read from its receipt and the list must be complete
 * against getLastIndex (locatedEntries); a wrong or missing one is a problem of that writer. Every other check is
 * the same.
 * `toBlock`: the block to read at (default: the latest the endpoints have). `maxRequests`: the RPC requests one read
 * may make, every writer and both endpoints together (LIMITS.requests): a writer checked past it fails, not checked.
 *
 * Returns { agentId (decimal string), mode, funds, manifest (whether the reader gave one), asOf, writers: [...],
 * counted, totals }. `asOf`: the block read at, { block, time }, or null when no writer has a statement. Each writer:
 * { writer, lender, asset, decimals, token, statements, defaults, window, after, checked, manifest, status, ok,
 * claimed, problems, anchorsChecked }, where `manifest` is true when the reader's manifest names this writer (its
 * sources were the manifest's) and false when its sources are the ones it declares; `status` is "rebuilt" (full mode,
 * nothing wrong: the statements match the logs of the sources checked, which without a manifest are the writer's
 * choice), "sampled" (light mode, nothing wrong in what it checked: the totals are the writer's claims), "failed" (a
 * problem) or "no-data" (no statement; `writers` lists every requested writer, found or not), and `claimed` holds the
 * writer's totals, up to its last statement. `after`: what lies after the last
 * statement, in no statement and never counted, { fromBlock, toBlock (asOf's), since (the last window's toTime),
 * closed, opened }: `closed` ({ onTime, late, defaulted, recovered }) and `opened` ({ count, amount }) as rebuilt from
 * the sources' logs in full mode, null in light mode (not read); `after` is null without a statement. A default there
 * that no default entry of the writer reports is a problem (full mode). `counted`: { [asset]: totals } over trusted
 * writers whose chains were rebuilt against the reader's manifest; light mode counts nothing, and neither does a read
 * without a manifest naming the writer (a writer key can declare a contract of its own). `totals`:
 * `counted`'s one asset (zeros when nothing is counted), or null when the counted writers lend in different assets.
 */
export async function readCredit(provider, agentId, { writers = null, fromBlock, toBlock = null, mode = "light", funds = true, span = 100_000, registry = REPUTATION_REGISTRY, history = provider, log = () => {}, manifest = null, maxEntries = LIMITS.entries, maxQueries = LIMITS.queries, maxRequests = LIMITS.requests, locate = null } = {}) {
  if (mode !== "light" && mode !== "full") throw new TypeError(`mode is "light" or "full", not ${mode}`);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new TypeError(`maxRequests must be a positive integer, not ${maxRequests}`);
  const id = P.toId(agentId, "agentId");
  const trusted = writers ? [...new Set(writers.map((w) => ethers.getAddress(w)))] : null;
  if (locate != null && !trusted?.length) throw new TypeError("locate needs writers: entries are located writer by writer");
  if (locate != null && typeof locate !== "function" && (typeof locate !== "object" || Array.isArray(locate))) throw new TypeError('locate is { "<writer>": [{ txHash, blockNumber?, logIndex? }] } or async (agentId, writer) => that list');
  const from = locate == null ? blockArg(fromBlock, "fromBlock") : null;
  let head = toBlock == null ? null : blockArg(toBlock, "toBlock");
  const man = readManifest(manifest);
  // every request of this read, on either endpoint, counts against one budget
  const budget = { max: maxRequests, used: 0 };
  const rp = metered(provider, budget), hp = history === provider ? rp : metered(history, budget);
  const ctx = context(hp);
  // the block read at: the latest both endpoints have, unless `toBlock` names one
  const latest = async () => { const a = await retry(() => rp.getBlockNumber()); return hp === rp ? a : Math.min(a, await retry(() => hp.getBlockNumber())); };
  let at = null;
  const asOf = () => (at ??= (async () => { const block = head ?? (head = await latest()); return { block, time: await ctx.time(block) }; })());
  const byWriter = new Map(), early = new Map();
  if (locate == null) {
    head ??= await latest();
    const entries = await findEntries(rp, { agentId: id, writers: trusted, fromBlock: from, toBlock: head, span, registry });
    log(`${entries.length} credit entries for agent #${id}`);
    for (const e of entries) { if (!byWriter.has(e.client)) byWriter.set(e.client, []); byWriter.get(e.client).push(e); }
  } else {
    const given = typeof locate === "function" ? null : new Map(Object.entries(locate).map(([k, v]) => [lc(k), v]));
    for (const w of trusted) {
      try {
        const list = given ? given.get(lc(w)) ?? [] : await locate(id.toString(), w);
        const r = await locatedEntries(rp, { agentId: id, writer: w, located: list, registry, max: maxEntries });
        if (r.entries.length || r.problems.length) { byWriter.set(w, r.entries); early.set(w, r.problems); }
      } catch (x) {
        byWriter.set(w, []);
        early.set(w, [`its entries could not be located: ${msg(x)}`]);
      }
    }
    log(`${[...byWriter.values()].flat().length} located credit entries for agent #${id}`);
  }
  const net = Number((await hp.getNetwork()).chainId);
  const reg = new ethers.Contract(registry, REGISTRY_ABI, rp);
  const trust = new Set((trusted || []).map(lc));
  // with a manifest, a trusted writer it does not name fails: read as it declares its sources, it would lose every
  // manifest check without a word
  const unnamed = (w) => Boolean(man) && trust.has(lc(w)) && !man.has(lc(w));
  const out = [];
  for (const [writer, list] of byWriter) {
    try {
      out.push(await readWriter(ctx, reg, { writer, list, id, mode, funds, span, net, manifest: man?.get(lc(writer)) || null, unnamed: unnamed(writer), maxEntries, maxQueries, located: early.get(writer) || [], asOf }));
    } catch (x) {
      out.push({ writer, lender: null, asset: null, decimals: null, token: null, statements: 0, defaults: 0, window: null, after: null, checked: mode === "full" ? "rebuilt" : "sampled", manifest: Boolean(man?.has(lc(writer))), status: "failed", ok: false, claimed: P.chainTotals([]), problems: [...(unnamed(writer) ? [notNamed(writer)] : []), `could not be checked: ${msg(x)}`], anchorsChecked: 0 });
    }
  }
  for (const w of trusted || []) {
    if (byWriter.has(w)) continue;
    const no = unnamed(w);
    out.push({ writer: w, lender: null, asset: null, decimals: null, token: null, statements: 0, defaults: 0, window: null, after: null, checked: null, manifest: Boolean(man?.has(lc(w))), status: no ? "failed" : "no-data", ok: false, claimed: P.chainTotals([]), problems: no ? [notNamed(w)] : [], anchorsChecked: 0 });
  }
  const counted = {};
  for (const w of out) {
    // trusted, rebuilt, and against the reader's own sources: a writer's declared sources are its key's word
    if (!trust.has(lc(w.writer)) || w.status !== "rebuilt" || !w.manifest) continue;
    const t = (counted[w.asset] ||= { asset: w.asset, decimals: w.decimals, symbol: w.token?.symbol ?? null, writers: 0, onTime: zero(), late: zero(), defaulted: zero(), recovered: zero() });
    t.writers++;
    sumInto(t, w.claimed);
  }
  const assets = Object.values(counted);
  const totals = assets.length > 1 ? null : assets[0] || { asset: null, decimals: null, symbol: null, writers: 0, onTime: zero(), late: zero(), defaulted: zero(), recovered: zero() };
  return { agentId: id.toString(), mode, funds: Boolean(funds), manifest: Boolean(man), asOf: at ? await at.catch(() => null) : null, writers: out, counted, totals };
}
