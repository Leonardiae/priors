// x402 income from the chain, whoever settled it. An x402 "exact" payment in USDG is an EIP-3009
// transferWithAuthorization: the payer signs, a facilitator submits, and USDG emits AuthorizationUsed(payer, nonce)
// followed by Transfer(payer, payTo, amount) in the same transaction. Reading those two events finds every such
// payment on Robinhood Chain, from any facilitator, not only ours.
//
// Signed USDG payments are common on this chain (apps move large amounts this way), so the scan starts from the
// authorizations (cheap to list) and then asks only for the transfers from those payers to agent wallets.
//
// An x402 payment can also be settled through Permit2 (the "upto" scheme, and "exact" on tokens without EIP-3009):
// Permit2 moves the USDG (one Transfer, no event of its own), then the x402 proxy that called it emits Settled() or
// SettledWithPermit() (x402-foundation/x402, contracts/evm/src/x402UptoPermit2Proxy.sol). Those events are rare, so
// the scan lists them first and asks for the transfers to agent wallets only around them.
//
// Everything here reads public data through a provider (ethers v6) and returns plain objects; the scoring itself is
// sdk/score-v2-inputs.mjs + sdk/score-v2.mjs. Amounts are atomic USDG (6 decimals) as decimal strings.
import { ethers } from "ethers";

export const TOPICS = Object.freeze({
  TRANSFER: ethers.id("Transfer(address,address,uint256)"),
  AUTH_USED: ethers.id("AuthorizationUsed(address,bytes32)"),
  REPAID: ethers.id("Repaid(uint256,uint256,uint256,uint256,address)"),
  AUTOREPAID: ethers.id("AutoRepaid(uint256,uint256,address,uint256,uint256,address,uint256,uint256)"),
  SETTLED: ethers.id("Settled()"),
  SETTLED_WITH_PERMIT: ethers.id("SettledWithPermit()"),
});
/** x402ExactPermit2Proxy and x402UptoPermit2Proxy: the same address on every EVM chain (CREATE2), Robinhood Chain included. */
export const PERMIT2_PROXIES = Object.freeze(["0x402085c248eea27d92e8b30b2c58ed07f9e20001", "0x4020a4f3b7b90cca423b9fabcc0ce57c6c240002"]);
/** The two ways an x402 payment reaches a wallet: an EIP-3009 authorization, or a Permit2 transfer by an x402 proxy. */
export const ROUTES = Object.freeze(["eip3009", "permit2"]);
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const lc = (a) => String(a || "").toLowerCase();
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lc(a));
const topicOf = (a) => ethers.zeroPadValue(lc(a), 32);
const addrOf = (t) => ethers.getAddress("0x" + String(t).slice(26));
const uniq = (xs) => [...new Set(xs)];
const batches = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Thrown (and caught by the scans) when a run's time is up: the work done so far is kept and resumed next run. */
export class DeadlineError extends Error {
  constructor() { super("x402 income: out of time for this run"); this.name = "DeadlineError"; }
}
const past = (deadline) => Date.now() > deadline;
// what a node says when a window is too wide or too slow (the official node: "log query timed out")
const RANGE_OR_TIMEOUT = /timed? ?out|timeout|range|too many|limit|exceed|too large|more than|response size|query returned/i;
// a node refusing us for a while (rate limit, busy): splitting the window would only multiply the refused calls, so
// the run stops there and the next one resumes
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|request limit|busy|capacity|throttl/i;
/** What stopped a scan, in a word (never the node's own text, which can carry an endpoint URL). */
const kindOf = (e) => (e instanceof DeadlineError ? "deadline" : RATE_LIMITED.test(errText(e)) ? "rate-limited" : RANGE_OR_TIMEOUT.test(errText(e)) ? "timeout-or-range" : "rpc-error");
const errText = (e) => {
  let t = String((e && (e.shortMessage || e.message)) || e);
  try { t += " " + JSON.stringify((e && (e.error || (e.info && e.info.error))) || ""); } catch { /* not serialisable */ }
  return t;
};

/**
 * getLogs over [fromBlock, toBlock] that survives a node's window limit: a window refused as too wide or too slow is
 * split in two and each half asked again, down to `minSpan` blocks. Any other error is thrown at once, and so is a
 * DeadlineError once `deadline` (ms epoch) has passed. Results come back in block order.
 */
export async function getLogsAdaptive(provider, filter, fromBlock, toBlock, { minSpan = 10_000, deadline = Infinity, seen = null } = {}) {
  if (past(deadline)) throw new DeadlineError();
  try {
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (e) {
    if (seen && !(e instanceof DeadlineError)) seen.split = kindOf(e);
    if (e instanceof DeadlineError || toBlock - fromBlock + 1 <= minSpan || RATE_LIMITED.test(errText(e)) || !RANGE_OR_TIMEOUT.test(errText(e))) throw e;
    const mid = fromBlock + Math.floor((toBlock - fromBlock) / 2);
    const left = await getLogsAdaptive(provider, filter, fromBlock, mid, { minSpan, deadline, seen });
    const right = await getLogsAdaptive(provider, filter, mid + 1, toBlock, { minSpan, deadline, seen });
    return [...left, ...right];
  }
}

/**
 * When each backer id last changed hands: its latest ERC-721 Transfer in the identity registry since `fromBlock`, in
 * seconds (Score v2 counts a backer's 30 days from then when that is later than its enrolment: a bought aged id is a
 * new backer, private report GHSA-6f8j). Incremental: ids already known are read from the cursor on; a new id is read
 * from `fromBlock` in chunks, and a run out of time keeps its progress (`pending`) for the next one. The state is
 * { v: 1, scannedTo, ids, since: { [id]: seconds }, pending: null | { ids, next } }.
 */
export async function updateBackerTenure(provider, prev, { registry, ids, fromBlock, head, deadline = Infinity, chunk = 1_000_000 }) {
  const st = prev?.v === 1
    ? { v: 1, scannedTo: prev.scannedTo, ids: [...prev.ids], since: { ...prev.since }, pending: prev.pending ? { ids: [...prev.pending.ids], next: prev.pending.next } : null }
    : { v: 1, scannedTo: fromBlock - 1, ids: [], since: {}, pending: null };
  const want = [...new Set(ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const fresh = want.filter((id) => !st.ids.includes(id) && !(st.pending?.ids || []).includes(id));
  // a new id joins the scan in progress, which then starts over from fromBlock (rare: a new root)
  if (fresh.length) st.pending = { ids: [...(st.pending?.ids || []), ...fresh], next: fromBlock };
  const idTopics = (list) => list.map((id) => ethers.zeroPadValue(ethers.toBeHex(id), 32));
  const times = new Map();
  const scan = async (list, from, to, progress) => {
    for (let a = from; a <= to;) {
      const b = Math.min(to, a + chunk - 1);
      const logs = await getLogsAdaptive(provider, { address: registry, topics: [TOPICS.TRANSFER, null, null, idTopics(list)] }, a, b, { deadline });
      for (const l of logs) {
        if (l.topics?.length !== 4) continue; // an ERC-721 transfer carries its token id as the fourth topic
        const n = Number(l.blockNumber);
        if (!times.has(n)) times.set(n, Number((await provider.getBlock(n)).timestamp));
        const id = Number(BigInt(l.topics[3]));
        if (!(st.since[id] >= times.get(n))) st.since[id] = times.get(n);
      }
      progress(b);
      a = b + 1;
    }
  };
  try {
    if (st.ids.length) await scan(st.ids, st.scannedTo + 1, head, (b) => { st.scannedTo = b; });
    else st.scannedTo = Math.max(st.scannedTo, head); // nothing known yet: the cursor follows the head
    if (st.pending) {
      await scan(st.pending.ids, st.pending.next, head, (b) => { st.pending.next = b + 1; });
      st.ids.push(...st.pending.ids);
      st.pending = null;
    }
  } catch (e) {
    if (!(e instanceof DeadlineError)) throw e; // out of time: the progress is kept, the next run goes on
  }
  return st;
}

/**
 * Pure: pair each AuthorizationUsed with the USDG Transfer emitted right after it (the next log of the same
 * transaction), sent by the authorizer: USDG's transferWithAuthorization emits exactly that pair, so an unrelated
 * transfer elsewhere in the same transaction is never taken for the payment. A transaction settling several
 * authorizations yields one payment each. Logs are ethers Log objects (or {transactionHash, index, blockNumber,
 * topics, data}).
 */
export function pairPayments(authLogs, transferLogs) {
  const byTx = new Map();
  for (const t of transferLogs) {
    const k = lc(t.transactionHash);
    if (!byTx.has(k)) byTx.set(k, []);
    byTx.get(k).push(t);
  }
  for (const list of byTx.values()) list.sort((a, b) => Number(a.index) - Number(b.index));
  const used = new Set();
  const out = [];
  const auths = [...authLogs].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.index) - Number(b.index));
  for (const a of auths) {
    const payer = lc(addrOf(a.topics[1]));
    const list = byTx.get(lc(a.transactionHash)) || [];
    const t = list.find((x) => Number(x.index) === Number(a.index) + 1 && !used.has(x) && lc(addrOf(x.topics[1])) === payer);
    if (!t) continue; // an authorization whose transfer went elsewhere (not to an agent wallet)
    used.add(t);
    out.push({
      txHash: lc(t.transactionHash), logIndex: Number(t.index), block: Number(t.blockNumber),
      payer, payTo: lc(addrOf(t.topics[2])), amount: BigInt(t.data).toString(),
    });
  }
  return out;
}

/**
 * Pure: pair each x402 proxy's Settled()/SettledWithPermit() with the USDG Transfer right before it (the previous log of
 * the same transaction): the proxy emits it as soon as Permit2 has moved the tokens, and Permit2 emits nothing of its
 * own. A Settled() from any other contract makes no payment. `transferLogs` are USDG Transfers (the caller's query
 * names the token). Returns the same shape as pairPayments.
 */
export function pairPermit2(settleLogs, transferLogs) {
  const byKey = new Map(transferLogs.map((t) => [`${lc(t.transactionHash)}:${Number(t.index)}`, t]));
  const out = [];
  for (const s of settleLogs) {
    if (s.address && !PERMIT2_PROXIES.includes(lc(s.address))) continue;
    if (s.topics[0] !== TOPICS.SETTLED && s.topics[0] !== TOPICS.SETTLED_WITH_PERMIT) continue;
    const t = byKey.get(`${lc(s.transactionHash)}:${Number(s.index) - 1}`);
    if (!t) continue; // the transfer before it went elsewhere (not to an agent wallet)
    out.push({
      txHash: lc(t.transactionHash), logIndex: Number(t.index), block: Number(t.blockNumber),
      payer: lc(addrOf(t.topics[1])), payTo: lc(addrOf(t.topics[2])), amount: BigInt(t.data).toString(),
    });
  }
  return out;
}

/** Windows of at most `span` blocks, inside [a, b], covering every block in `blocks`. */
const windowsAround = (blocks, span, a, b) => {
  const out = [];
  for (const n of uniq(blocks.map(Number)).sort((x, y) => x - y)) {
    if (out.length && n <= out[out.length - 1][1]) continue;
    out.push([Math.max(a, n), Math.min(b, n + span - 1)]);
  }
  return out;
};

async function stamp(provider, items, cache, deadline) {
  for (const b of uniq(items.map((x) => x.block))) {
    if (cache.has(b)) continue;
    if (past(deadline)) throw new DeadlineError();
    cache.set(b, Number((await provider.getBlock(b)).timestamp));
  }
  for (const x of items) x.at = cache.get(x.block);
  return items;
}

/**
 * x402 payments in USDG to any of `wallets` in [fromBlock, toBlock], chunk by chunk, through each of `routes`: signed
 * (EIP-3009) and Permit2 (`via: "permit2"` on those). Permit2 costs four queries per chunk with one address and one
 * topic each (the Robinhood Chain node refuses lists over wide ranges), and a transfer query only around a settle, in
 * windows of `permit2Span` blocks. At `deadline` (ms epoch) it stops between chunks (a chunk cut short is dropped
 * whole) and reports how far it got: resume from `scannedTo + 1`. A node rate-limiting us stops the scan the same way.
 * Returns { payments: [{id, block, at, payer, payTo, amount, via?}], scannedTo, stopped: null | "deadline" |
 * "rate-limited", split: what the node said when a window was split, if it was }.
 */
export async function scanPayments(provider, { usdg, wallets, fromBlock, toBlock, chunk = 2_000_000, payerBatch = 400, walletBatch = 400, deadline = Infinity, routes = ROUTES, permit2Span = 50_000 }) {
  const walletTopics = uniq(wallets.map(lc)).filter(isAddr).map(topicOf);
  const payments = [];
  let scannedTo = fromBlock - 1, stopped = null;
  const seen = { split: null };
  if (!walletTopics.length || fromBlock > toBlock) return { payments, scannedTo: Math.max(scannedTo, toBlock), stopped, split: null };
  const cache = new Map();
  for (let a = fromBlock; a <= toBlock; a += chunk) {
    if (past(deadline)) { stopped = "deadline"; break; }
    const b = Math.min(toBlock, a + chunk - 1);
    try {
      const got = [];
      if (routes.includes("eip3009")) {
        const auth = await getLogsAdaptive(provider, { address: usdg, topics: [TOPICS.AUTH_USED] }, a, b, { deadline, seen });
        if (auth.length) {
          const payers = uniq(auth.map((l) => lc(l.topics[1])));
          const transfers = [];
          for (const pb of batches(payers, payerBatch)) {
            for (const wb of batches(walletTopics, walletBatch)) {
              transfers.push(...await getLogsAdaptive(provider, { address: usdg, topics: [TOPICS.TRANSFER, pb, wb] }, a, b, { deadline, seen }));
            }
          }
          if (transfers.length) got.push(...pairPayments(auth, transfers).map(({ txHash, logIndex, ...p }) => ({ id: txHash + ":" + logIndex, ...p })));
        }
      }
      if (routes.includes("permit2")) {
        const settles = [];
        for (const proxy of PERMIT2_PROXIES) {
          for (const ev of [TOPICS.SETTLED, TOPICS.SETTLED_WITH_PERMIT]) settles.push(...await getLogsAdaptive(provider, { address: proxy, topics: [ev] }, a, b, { deadline, seen }));
        }
        // the transfers to agent wallets, only in windows around the settles (none when there is no settle)
        const transfers = [];
        for (const [wa, wz] of windowsAround(settles.map((s) => s.blockNumber), permit2Span, a, b)) {
          for (const wb of batches(walletTopics, walletBatch)) {
            transfers.push(...await getLogsAdaptive(provider, { address: usdg, topics: [TOPICS.TRANSFER, null, wb] }, wa, wz, { deadline, seen }));
          }
        }
        const taken = new Set(got.map((p) => p.id)); // a transfer both signed and settled by a proxy is one payment
        for (const { txHash, logIndex, ...p } of pairPermit2(settles, transfers)) {
          const id = txHash + ":" + logIndex;
          if (!taken.has(id)) { taken.add(id); got.push({ id, ...p, via: "permit2" }); }
        }
      }
      if (got.length) await stamp(provider, got, cache, deadline);
      payments.push(...got);
      scannedTo = b;
    } catch (e) {
      if (e instanceof DeadlineError) { stopped = "deadline"; break; }
      if (RATE_LIMITED.test(errText(e))) { stopped = "rate-limited"; break; }
      throw e;
    }
  }
  return { payments, scannedTo, stopped, split: seen.split };
}

/**
 * Every USDG Transfer from any of `from` to any of `to` in [fromBlock, toBlock] (any kind of transfer), for netting:
 * money an agent's side sends to a payer is not income from that payer. Only the amounts matter (no timestamps are
 * read). Same chunking and deadline as scanPayments. Returns { transfers: [{id, block, from, to, amount}], scannedTo }.
 */
export async function scanTransfers(provider, { usdg, from, to, fromBlock, toBlock, chunk = 5_000_000, batch = 400, deadline = Infinity }) {
  const fromT = uniq(from.map(lc)).filter(isAddr).map(topicOf), toT = uniq(to.map(lc)).filter(isAddr).map(topicOf);
  const transfers = [];
  let scannedTo = fromBlock - 1;
  if (!fromT.length || !toT.length || fromBlock > toBlock) return { transfers, scannedTo: Math.max(scannedTo, toBlock) };
  for (let a = fromBlock; a <= toBlock; a += chunk) {
    if (past(deadline)) break;
    const b = Math.min(toBlock, a + chunk - 1);
    try {
      const got = [];
      for (const fb of batches(fromT, batch)) {
        for (const tb of batches(toT, batch)) {
          for (const l of await getLogsAdaptive(provider, { address: usdg, topics: [TOPICS.TRANSFER, fb, tb] }, a, b, { deadline })) {
            got.push({ id: lc(l.transactionHash) + ":" + Number(l.index), block: Number(l.blockNumber), from: lc(addrOf(l.topics[1])), to: lc(addrOf(l.topics[2])), amount: BigInt(l.data).toString() });
          }
        }
      }
      transfers.push(...got);
      scannedTo = b;
    } catch (e) {
      if (e instanceof DeadlineError) break;
      throw e;
    }
  }
  return { transfers, scannedTo };
}

const REGISTRY_ABI = ["function getAgentWallet(uint256 agentId) view returns (address)"];
const MULTICALL_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"];

/**
 * The payment wallet each agent declared in the ERC-8004 identity registry (`getAgentWallet`: set to the owner at
 * registration, cleared when the agent changes hands, changed only with the wallet's signature). One Multicall3 call
 * per `batch` agents. Returns { [agentId]: address lowercase | null (none declared) | undefined (the read failed) }.
 */
export async function readAgentWallets(provider, registry, agentIds, { batch = 200, multicall = MULTICALL3 } = {}) {
  const reg = new ethers.Interface(REGISTRY_ABI);
  const mc = new ethers.Contract(multicall, MULTICALL_ABI, provider);
  const out = {};
  for (const ids of batches(uniq(agentIds.map(Number)), batch)) {
    const res = await mc.aggregate3.staticCall(ids.map((id) => ({ target: registry, allowFailure: true, callData: reg.encodeFunctionData("getAgentWallet", [id]) })));
    ids.forEach((id, i) => {
      const r = res[i];
      if (!r || !r.success || !r.returnData || r.returnData.length < 66) { out[id] = undefined; return; }
      try {
        const w = lc(reg.decodeFunctionResult("getAgentWallet", r.returnData)[0]);
        out[id] = w && w !== ethers.ZeroAddress ? w : null;
      } catch { out[id] = undefined; }
    });
  }
  return out;
}

const AUTOREPAID_IFACE = new ethers.Interface(["event AutoRepaid(uint256 indexed loanId, uint256 indexed agentId, address wallet, uint256 fromWallet, uint256 fromWalletSavings, address owner, uint256 fromOwner, uint256 fromOwnerSavings)"]);

/**
 * Who paid a repayment AutoRepay made: the addresses its AutoRepaid log for `loanId`, in the
 * same transaction, names as having paid something: the agent's wallet (its USDG or its savings), the loan's owner
 * (the same), or both. Read only from `autoRepay`'s own logs. Returns one address (lowercase), both as an array (the
 * repayment counts as the agent's own only if each is), or null when no such log is there.
 */
export function autoRepaidPayers(logs, autoRepay, loanId) {
  for (const l of logs) {
    if (lc(l.address) !== lc(autoRepay) || l.topics[0] !== TOPICS.AUTOREPAID) continue;
    const ev = AUTOREPAID_IFACE.parseLog(l);
    if (Number(ev.args.loanId) !== Number(loanId)) continue;
    const who = [];
    if (ev.args.fromWallet + ev.args.fromWalletSavings > 0n) who.push(lc(ev.args.wallet));
    if (ev.args.fromOwner + ev.args.fromOwnerSavings > 0n) who.push(lc(ev.args.owner));
    const set = uniq(who);
    return set.length === 0 ? null : set.length === 1 ? set[0] : set;
  }
  return null;
}

/**
 * Who paid each repayment: the `payer` of `pool`'s Repaid log (msg.sender of repay) in the given transaction; for a
 * repayment whose payer is one of `autoRepay` (the deployed AutoRepays: v2's, `autoRepay` in deployments/4663.v2.json,
 * and the retired v1's, `autoRepayV1` in packages/mcp/deployments/4663.v2.json; nothing else; one address or a list),
 * the addresses that paid through it, read
 * from that contract's own AutoRepaid log (autoRepaidPayers). `loans`: [{loanId, tx}]. Stops at `deadline`. Returns
 * { [loanId]: address lowercase | [addresses] | null (looked, not found) }; a loan left out was not looked at.
 */
export async function readRepayers(provider, pool, loans, deadline = Infinity, { autoRepay = null } = {}) {
  const iface = new ethers.Interface(["event Repaid(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, address payer)"]);
  const pinned = new Set([].concat(autoRepay || []).filter(isAddr).map(lc));
  const out = {};
  for (const { loanId, tx } of loans) {
    if (past(deadline)) break;
    const r = await provider.getTransactionReceipt(tx);
    out[loanId] = null;
    if (!r) continue;
    for (const l of r.logs) {
      if (lc(l.address) !== lc(pool) || l.topics[0] !== TOPICS.REPAID) continue;
      const ev = iface.parseLog(l);
      if (Number(ev.args.loanId) !== Number(loanId)) continue;
      const payer = lc(ev.args.payer);
      out[loanId] = pinned.has(payer) ? autoRepaidPayers(r.logs, payer, loanId) : payer;
    }
  }
  return out;
}

export const INDEX_DEFAULTS = Object.freeze({
  walletsEvery: 6 * 3600,     // re-read every agent's declared wallet this often (new agents are read at once)
  retentionDays: 365,         // payments kept this long (the income window is 30 days; loans look further back)
  minKeepDays: 37,            // what the size guard never prunes below
  maxStateBytes: 20_000_000,  // under Workers KV's 25 MiB value limit
  maxRepayerReads: 50,        // receipts read per run
  paymentsChunk: 2_000_000,   // blocks per payment window at first and at most
  minPaymentsChunk: 10_000,   // a window never gets smaller than this
  // blocks per netting window (cursor and backfills). A window cut short by the run's end is dropped whole. The official
  // node answers a query with lists of topics over 100,000 blocks at most ("only 100000 are allowed for this request"),
  // so a 5M window went out as 80 requests and 79 refusals, 17-36 s, read again from its start whenever the run ended
  // inside it. 100,000 blocks is one request (0.12-0.15 s there, 2026-10-23), so a run keeps all but its last one.
  transfersChunk: 100_000,
  transfersFrom: 1,           // netting reads the whole chain
  minPayerAtomic: 1_000_000,  // a payer is netted (and counts) once it has paid 1 USDG: dust can't make work
});

const DAY = 86400;
const addUnique = (list, items) => { const seen = new Set(list.map((x) => x.id)); for (const x of items) if (!seen.has(x.id)) { seen.add(x.id); list.push(x); } };

/**
 * Keep an income index up to date, resumably. The index holds:
 *   agentWallets  every agent's declared payment wallet (re-read every `walletsEvery` seconds, new agents at once;
 *                 a failed read keeps the wallet known before; an agent never read successfully holds the index
 *                 incomplete, so no scores are published without its wallet)
 *   payments      signed USDG payments to declared wallets since `fromBlock`
 *   transfers     USDG sent from agent-side wallets (owners, declared wallets, `extraWallets`) to those payers, over
 *                 the whole chain from `transfersFrom`, for netting
 *   repayers      who repaid each v2 loan that overlaps a payment to its agent (through `autoRepay`, the deployed
 *                 AutoRepay: the addresses that paid through it, readRepayers)
 * A new wallet or payer is backfilled on its own (only the new pairs are read from the start) while the main cursors
 * keep moving, so new arrivals never hold everyone else back: `pending` names the payers and agent-side wallets whose
 * netting is still being read, and their income waits (sdk/score-v2-inputs.mjs `pending`). Everything stops cleanly
 * at `deadline` (ms epoch) and resumes on the next call. `prev` is the last returned state (plain JSON) or null.
 * Returns { state, complete, pending: { payers, wallets } }: publish scores only from a complete index.
 */
export async function updateIncome(provider, prev, { usdg, registry, pool, autoRepay = null, snapshot, extraWallets = [], fromBlock, head, now, deadline = Infinity, ...opts }) {
  const P = { ...INDEX_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const fresh = () => ({ v: 2, fromBlock, transfersFrom: P.transfersFrom, agentWallets: {}, walletFailures: {}, walletsAt: 0,
    wallets: [], payments: [], paymentsTo: fromBlock - 1, paymentBackfills: [], permit2: true, permit2Backfill: null,
    from: [], payers: [], transfers: [], transfersTo: P.transfersFrom - 1, transferBackfills: [], repayers: {} });
  const state = prev && prev.v === 2 && prev.fromBlock === fromBlock && prev.transfersFrom === P.transfersFrom ? JSON.parse(JSON.stringify(prev)) : fresh();
  // An index read before Permit2 payments counted re-reads Permit2 alone over what it had already read, once; its
  // cursors read both routes from now on. Like a new wallet's backfill, it never holds scores back.
  if (state.permit2 !== true) {
    state.permit2 = true;
    state.permit2Backfill = state.paymentsTo >= fromBlock ? { next: fromBlock, until: state.paymentsTo } : null;
  }
  const ids = snapshot.agents.map((a) => Number(a.id));

  // 1. declared payment wallets
  const unread = ids.filter((id) => !(id in state.agentWallets) || (state.walletFailures[id] || 0) > 0);
  if (now - state.walletsAt >= P.walletsEvery || unread.length) {
    const read = await readAgentWallets(provider, registry, now - state.walletsAt >= P.walletsEvery ? ids : unread);
    for (const [k, w] of Object.entries(read)) {
      const id = Number(k);
      if (w !== undefined) { state.agentWallets[id] = w; delete state.walletFailures[id]; continue; }
      // keep what was known; unknown stays unknown, however many runs fail: a declared wallet is a cluster edge, and an
      // index published without it could make a same-cluster payer look external. The failures are counted for health.
      state.walletFailures[id] = (state.walletFailures[id] || 0) + 1;
    }
    if (now - state.walletsAt >= P.walletsEvery) state.walletsAt = now;
  }
  const walletsPending = ids.some((id) => !(id in state.agentWallets));

  // 2. payments to declared wallets: new wallets backfilled on their own, then the main cursor
  const declared = uniq(Object.values(state.agentWallets).filter(isAddr).map(lc)).sort();
  const want = new Set(declared), had = new Set(state.wallets);
  const removed = new Set(state.wallets.filter((w) => !want.has(w)));
  const added = declared.filter((w) => !had.has(w));
  if (removed.size) {
    state.payments = state.payments.filter((p) => !removed.has(p.payTo));
    state.paymentBackfills = state.paymentBackfills.map((bf) => ({ ...bf, wallets: bf.wallets.filter((w) => !removed.has(w)) })).filter((bf) => bf.wallets.length);
  }
  if (added.length && state.paymentsTo >= fromBlock) state.paymentBackfills.push({ wallets: added, next: fromBlock, until: state.paymentsTo });
  state.wallets = declared;
  // A payment window that can't be read in one run would never advance (a window cut short is dropped whole), so a
  // run that ends without reading one makes the window 4x smaller for the next; a run that reads every window it tries
  // lets it grow back. The index always moves forward as long as one small window fits in a run.
  let chunk = Math.min(P.paymentsChunk, Math.max(P.minPaymentsChunk, Number(state.paymentsChunk) || P.paymentsChunk));
  const scanStatus = { stopped: null, split: null };
  const tune = (r, from) => {
    if (r.split) scanStatus.split = r.split;
    if (r.stopped) scanStatus.stopped = r.stopped;
    if (r.stopped && r.scannedTo < from) chunk = Math.max(P.minPaymentsChunk, Math.floor(chunk / 4));
    else if (!r.stopped && r.scannedTo >= from) chunk = Math.min(P.paymentsChunk, chunk * 2);
  };
  if (state.paymentsTo < head && !past(deadline)) {
    const from = state.paymentsTo + 1;
    const r = await scanPayments(provider, { usdg, wallets: declared, fromBlock: from, toBlock: head, chunk, deadline });
    addUnique(state.payments, r.payments);
    state.paymentsTo = Math.max(state.paymentsTo, r.scannedTo);
    tune(r, from);
  }
  const keep = () => { state.payments = state.payments.filter((p) => Number(p.at) >= now - P.retentionDays * DAY).sort((x, y) => x.block - y.block || (x.id < y.id ? -1 : 1)); };
  keep();

  // 3. money sent back to the payers: new payers and new agent-side wallets backfilled on their own
  const track = () => {
    const paid = new Map();
    for (const p of state.payments) paid.set(p.payer, (paid.get(p.payer) || 0n) + BigInt(p.amount));
    const payers = [...paid].filter(([, v]) => v >= BigInt(P.minPayerAtomic)).map(([k]) => k).sort();
    const from = uniq([...snapshot.agents.map((a) => lc(a.owner)), ...declared, ...extraWallets.map(lc)]).filter(isAddr).sort();
    const fromSet = new Set(from), payerSet = new Set(payers);
    const goneFrom = new Set(state.from.filter((w) => !fromSet.has(w))), gonePayers = new Set(state.payers.filter((x) => !payerSet.has(x)));
    if (goneFrom.size || gonePayers.size) {
      state.transfers = state.transfers.filter((x) => !goneFrom.has(x.from) && !gonePayers.has(x.to));
      state.transferBackfills = state.transferBackfills
        .map((bf) => ({ ...bf, from: bf.from.filter((w) => !goneFrom.has(w)), to: bf.to.filter((x) => !gonePayers.has(x)) }))
        .filter((bf) => bf.from.length && bf.to.length);
    }
    const oldFrom = state.from.filter((w) => fromSet.has(w)), oldPayers = state.payers.filter((x) => payerSet.has(x));
    const newFrom = from.filter((w) => !oldFrom.includes(w)), newPayers = payers.filter((x) => !oldPayers.includes(x));
    if (state.transfersTo >= P.transfersFrom) {
      if (newPayers.length && oldFrom.length) state.transferBackfills.push({ kind: "payers", from: oldFrom, to: newPayers, next: P.transfersFrom, until: state.transfersTo });
      if (newFrom.length && payers.length) state.transferBackfills.push({ kind: "wallets", from: newFrom, to: payers, next: P.transfersFrom, until: state.transfersTo });
    }
    state.from = from;
    state.payers = payers;
    if (!payers.length) state.transfersTo = Math.max(state.transfersTo, head);
    return { from, payers };
  };
  const { from, payers } = track();
  if (payers.length && state.transfersTo < head && !past(deadline)) {
    const r = await scanTransfers(provider, { usdg, from, to: payers, fromBlock: state.transfersTo + 1, toBlock: head, chunk: P.transfersChunk, deadline });
    addUnique(state.transfers, r.transfers);
    state.transfersTo = Math.max(state.transfersTo, r.scannedTo);
  }

  // 4. who repaid the loans that overlap a payment to their agent's declared wallet: read for the payments known so far,
  // and again after the backfills for the ones they found. Returns how many are still unread (they hold the scores).
  const repaidTx = new Map();
  for (const e of snapshot.events || []) if (e.kind === "Repaid" && e.era === "v2") repaidTx.set(Number(e.loanId), e.tx);
  const repayers = async () => {
    const paidAt = new Map(); // agentId -> [payment times]
    for (const a of snapshot.agents) {
      const w = lc(state.agentWallets[a.id]);
      if (!isAddr(w)) continue;
      for (const p of state.payments) if (p.payTo === w) { if (!paidAt.has(Number(a.id))) paidAt.set(Number(a.id), []); paidAt.get(Number(a.id)).push(Number(p.at)); }
    }
    const wanted = snapshot.loans.filter((l) => l.era === "v2" && l.status === "repaid" && !(l.id in state.repayers) && repaidTx.has(Number(l.id))
      && (paidAt.get(Number(l.agentId)) || []).some((t) => t >= Number(l.issuedAt) && t <= Number(l.closedAt)));
    let left = wanted.length;
    if (wanted.length && !past(deadline)) {
      const got = await readRepayers(provider, pool, wanted.slice(0, P.maxRepayerReads).map((l) => ({ loanId: Number(l.id), tx: repaidTx.get(Number(l.id)) })), deadline, { autoRepay });
      for (const [k, v] of Object.entries(got)) { state.repayers[k] = v; left--; }
    }
    return left;
  };
  let pendingRepayers = await repayers();

  /* The backfills, last, with what is left of the run: what the cursors above read is what a score needs now, and a
     backfill can take every run for days (on 2026-10-10 nine new wallets' payment backfills, 10-13 million blocks each,
     took the whole budget of every run, and once a first payer appeared the netting cursor behind them never moved, so
     no score was published). The netting backfills come first: until one is read, its payers' income (or its new
     wallets' cluster's) waits, while a payment backfill still to read only leaves an income smaller for now (until
     2026-10-23 they came after the payment backfills, which took every run, so every payer of 1 USDG or more stayed
     pending and the board showed no receipts). What a payment backfill finds is looked at again below, as if a cursor
     had found it: its payer is tracked (its netting read on its own before its income counts, `pending`, in the same
     run when there is time), and its agent's repaid loans' repayers are read, or the scores wait for them. */
  const netBackfills = async () => {
    for (const bf of state.transferBackfills) {
      if (past(deadline)) break;
      const r = await scanTransfers(provider, { usdg, from: bf.from, to: bf.to, fromBlock: bf.next, toBlock: bf.until, chunk: P.transfersChunk, deadline });
      addUnique(state.transfers, r.transfers);
      bf.next = r.scannedTo + 1;
    }
    state.transferBackfills = state.transferBackfills.filter((bf) => bf.next <= bf.until);
  };
  await netBackfills();
  for (const bf of state.paymentBackfills) {
    if (past(deadline) || scanStatus.stopped === "rate-limited") break;
    const from = bf.next;
    const r = await scanPayments(provider, { usdg, wallets: bf.wallets, fromBlock: from, toBlock: bf.until, chunk, deadline });
    addUnique(state.payments, r.payments);
    bf.next = r.scannedTo + 1;
    tune(r, from);
  }
  if (state.permit2Backfill && !past(deadline) && scanStatus.stopped !== "rate-limited") {
    const bf = state.permit2Backfill, from = bf.next;
    const r = await scanPayments(provider, { usdg, wallets: declared, fromBlock: from, toBlock: bf.until, chunk, deadline, routes: ["permit2"] });
    addUnique(state.payments, r.payments);
    bf.next = r.scannedTo + 1;
    tune(r, from);
    if (bf.next > bf.until) state.permit2Backfill = null;
  }
  state.paymentsChunk = chunk;
  state.paymentBackfills = state.paymentBackfills.filter((bf) => bf.next <= bf.until);
  keep();
  track();
  pendingRepayers = await repayers();
  await netBackfills();

  // 5. size: under the store's value limit, pruning old payments first (never below `minKeepDays`)
  let size = JSON.stringify(state).length;
  if (size > P.maxStateBytes) {
    state.payments = state.payments.filter((p) => Number(p.at) >= now - P.minKeepDays * DAY);
    size = JSON.stringify(state).length;
    if (size > P.maxStateBytes) throw new Error(`x402 income index too large (${size} bytes)`);
  }

  // payers and wallets whose netting is still being read (their income waits); a new wallet's past payments still
  // being read only makes its income smaller for now
  const pending = {
    payers: uniq(state.transferBackfills.filter((bf) => bf.kind === "payers").flatMap((bf) => bf.to)).sort(),
    wallets: uniq(state.transferBackfills.filter((bf) => bf.kind !== "payers").flatMap((bf) => bf.from)).sort(),
  };
  const complete = !walletsPending && state.paymentsTo >= head && state.transfersTo >= head && pendingRepayers <= 0;
  const walletsUnread = ids.filter((id) => !(id in state.agentWallets)).length; // > 0 holds publication back
  const permit2Left = state.permit2Backfill ? state.permit2Backfill.until - state.permit2Backfill.next + 1 : 0; // blocks
  return { state, complete, pending, scan: { paymentsChunk: chunk, ...scanStatus, ...(walletsUnread ? { walletsUnread } : {}), ...(permit2Left ? { permit2Backfill: permit2Left } : {}) } };
}
