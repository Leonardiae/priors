// x402 income in Priors Score v2: reading payments from the chain and turning them into score. Each rule is a case
// that fails if the rule is removed.
//   node scripts/test-x402-income.mjs
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { pairPayments, pairPermit2, scanPayments, scanTransfers, TOPICS, PERMIT2_PROXIES, getLogsAdaptive, DeadlineError, readAgentWallets, readRepayers, autoRepaidPayers, updateIncome, updateBackerTenure } from "../sdk/x402-income.mjs";
import { scoreV2, DEFAULT_WEIGHTS as W } from "../sdk/score-v2.mjs";
import { buildInputs, scoreAll } from "../sdk/score-v2-inputs.mjs";

const DAY = 86400, NOW = 1_800_000_000, $ = (n) => Math.round(n * 1e6);
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log("  ok  ", name); };
const pts = (r, k) => r.components.find((c) => c.key === k).points;
const A = (n) => "0x" + n.toString(16).padStart(40, "0"); // a readable fake address
const lc = (a) => String(a).toLowerCase();
const topic = (a) => ethers.zeroPadValue(a, 32);
const auth = (tx, index, payer, block = 100) => ({ transactionHash: tx, index, blockNumber: block, topics: [TOPICS.AUTH_USED, topic(payer), ethers.id("nonce" + tx + index)], data: "0x" });
const xfer = (tx, index, from, to, amount, block = 100) => ({ transactionHash: tx, index, blockNumber: block, topics: [TOPICS.TRANSFER, topic(from), topic(to)], data: ethers.toBeHex(amount, 32) });

console.log("x402 income");

// ---------------------------------------------------------------- reading the chain
await check("a signed payment is the authorization plus the transfer right after it, from the same payer", () => {
  const p = pairPayments([auth("0x01", 4, A(1))], [xfer("0x01", 5, A(1), A(9), 30000)]);
  assert.deepEqual(p.map((x) => [x.payer, x.payTo, x.amount]), [[A(1), A(9), "30000"]]);
});

await check("an unrelated transfer in the same transaction is never taken for the payment", () => {
  // the authorized transfer went elsewhere (not in the list); a later plain transfer from the payer is not it
  assert.deepEqual(pairPayments([auth("0x02", 4, A(1))], [xfer("0x02", 9, A(1), A(9), 50)]), []);
  // a transfer right after, but from someone else
  assert.deepEqual(pairPayments([auth("0x03", 4, A(1))], [xfer("0x03", 5, A(2), A(9), 50)]), []);
});

await check("a transaction settling two authorizations yields two payments", () => {
  const p = pairPayments([auth("0x04", 0, A(1)), auth("0x04", 2, A(2))], [xfer("0x04", 1, A(1), A(9), 10), xfer("0x04", 3, A(2), A(9), 20)]);
  assert.deepEqual(p.map((x) => x.amount), ["10", "20"]);
});

await check("the scan asks only for transfers from the block range's payers to agent wallets, chunk by chunk, and stops at a deadline", async () => {
  const calls = [];
  const provider = {
    async getLogs(f) {
      calls.push(f);
      if (f.topics[0] === TOPICS.AUTH_USED) return f.fromBlock <= 150 && 150 <= f.toBlock ? [auth("0x05", 0, A(1), 150)] : [];
      if (f.topics[0] === TOPICS.SETTLED || f.topics[0] === TOPICS.SETTLED_WITH_PERMIT) return []; // no Permit2 settle here
      assert.deepEqual(f.topics[1], [topic(A(1))]);
      assert.deepEqual(f.topics[2], [topic(A(9))]);
      return [xfer("0x05", 1, A(1), A(9), 7, 150)];
    },
    async getBlock(n) { return { timestamp: 1000 + n }; },
  };
  const r = await scanPayments(provider, { usdg: A(7), wallets: [A(9)], fromBlock: 1, toBlock: 300, chunk: 100 });
  assert.equal(r.scannedTo, 300);
  assert.deepEqual(r.payments.map((x) => [x.amount, x.at]), [["7", 1150]]);
  assert.equal(calls.filter((c) => c.topics[0] === TOPICS.AUTH_USED).length, 3);
  const stopped = await scanPayments(provider, { usdg: A(7), wallets: [A(9)], fromBlock: 1, toBlock: 300, chunk: 100, deadline: Date.now() - 1 });
  assert.equal(stopped.scannedTo, 0); // nothing done, resume from block 1
});

// x402 through Permit2 (the `upto` scheme, and `exact` without EIP-3009): Permit2 moves the USDG (one Transfer, no event
// of its own), then the x402 proxy emits Settled() or SettledWithPermit() (x402-foundation/x402, x402UptoPermit2Proxy.sol)
const [EXACT_PROXY, UPTO_PROXY] = PERMIT2_PROXIES;
const settled = (tx, index, block = 100, proxy = UPTO_PROXY, withPermit = false) => ({ transactionHash: tx, index, blockNumber: block, address: proxy, topics: [withPermit ? TOPICS.SETTLED_WITH_PERMIT : TOPICS.SETTLED], data: "0x" });

await check("Permit2: the USDG transfer right before an x402 proxy's Settled() or SettledWithPermit() is a payment", () => {
  const p = pairPermit2([settled("0x21", 6), settled("0x22", 3, 100, EXACT_PROXY, true)], [xfer("0x21", 5, A(1), A(9), 4200), xfer("0x22", 2, A(2), A(9), 50)]);
  assert.deepEqual(p.map((x) => [x.payer, x.payTo, x.amount]), [[A(1), A(9), "4200"], [A(2), A(9), "50"]]);
});

await check("Permit2: a Settled() from any other contract, or a transfer that is not the log right before it, is no payment", () => {
  assert.deepEqual(pairPermit2([settled("0x23", 6, 100, A(0xbad))], [xfer("0x23", 5, A(1), A(9), 4200)]), []);
  assert.deepEqual(pairPermit2([settled("0x24", 6)], [xfer("0x24", 4, A(1), A(9), 4200)]), []);
  assert.deepEqual(pairPermit2([settled("0x25", 6)], [xfer("0x99", 5, A(1), A(9), 4200)]), []);
  // the proxy's other events (an EIP-2612 permit that failed) are not a settle
  const failed = { ...settled("0x26", 6), topics: [ethers.id("EIP2612PermitFailedWithReason(address,address,string)"), topic(A(7)), topic(A(1))] };
  assert.deepEqual(pairPermit2([failed], [xfer("0x26", 5, A(1), A(9), 4200)]), []);
});

/** A chain of logs for scanPayments: answers each filter (address, topics, blocks) and records it. */
function logChain(logs) {
  const calls = [];
  const has = (want, t) => want == null || (Array.isArray(want) ? want : [want]).map((x) => x.toLowerCase()).includes(String(t).toLowerCase());
  return { calls,
    async getLogs(f) {
      calls.push(f);
      return logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock && (!l.address || !f.address || has(f.address, l.address))
        && f.topics.every((t, i) => has(t, l.topics[i])));
    },
    async getBlock(n) { return { timestamp: 1000 + n }; } };
}

await check("Permit2: the scan finds a Permit2 payment to an agent wallet next to the signed ones, and a plain transfer is not one", async () => {
  const W = A(9), USDG = A(7);
  const chain = logChain([
    auth("0x31", 0, A(1), 150), { ...xfer("0x31", 1, A(1), W, 30000, 150), address: USDG },
    { ...xfer("0x32", 7, A(2), W, 4200, 160), address: USDG }, settled("0x32", 8, 160),
    { ...xfer("0x33", 0, A(3), W, 777, 170), address: USDG },
  ]);
  const r = await scanPayments(chain, { usdg: USDG, wallets: [W], fromBlock: 1, toBlock: 300, chunk: 100 });
  assert.deepEqual(r.payments.map((x) => [x.payer, x.amount, x.via || "eip3009", x.at]), [[A(1), "30000", "eip3009", 1150], [A(2), "4200", "permit2", 1160]]);
});

await check("Permit2: a transfer with an authorization before it and a Settled() after it is still one payment", async () => {
  const W = A(9), USDG = A(7);
  const chain = logChain([auth("0x34", 0, A(1), 150), { ...xfer("0x34", 1, A(1), W, 30000, 150), address: USDG }, settled("0x34", 2, 150)]);
  const r = await scanPayments(chain, { usdg: USDG, wallets: [W], fromBlock: 1, toBlock: 200, chunk: 200 });
  assert.equal(r.payments.length, 1);
});

await check("Permit2 costs four one-value queries per window, and transfers are asked for only where a settle happened", async () => {
  const W = A(9), USDG = A(7);
  const quiet = logChain([]);
  await scanPayments(quiet, { usdg: USDG, wallets: [W], fromBlock: 1, toBlock: 300, chunk: 100 });
  const proxyCalls = quiet.calls.filter((f) => f.topics[0] === TOPICS.SETTLED || f.topics[0] === TOPICS.SETTLED_WITH_PERMIT);
  assert.equal(proxyCalls.length, 12, "4 per window, 3 windows");
  // one address and one topic value per query: the Robinhood Chain node refuses lists over wide ranges
  assert.ok(proxyCalls.every((f) => typeof f.address === "string" && f.topics.length === 1 && typeof f.topics[0] === "string"));
  assert.equal(quiet.calls.filter((f) => f.topics[0] === TOPICS.TRANSFER && f.topics[1] == null).length, 0, "no settle, no transfer query");
  const busy = logChain([{ ...xfer("0x35", 7, A(2), W, 4200, 160), address: USDG }, settled("0x35", 8, 160), settled("0x36", 3, 170)]);
  await scanPayments(busy, { usdg: USDG, wallets: [W], fromBlock: 1, toBlock: 300, chunk: 100 });
  const asked = busy.calls.filter((f) => f.topics[0] === TOPICS.TRANSFER && f.topics[1] == null);
  assert.equal(asked.length, 1, "one transfer query around settles close together");
  assert.ok(asked[0].fromBlock <= 160 && asked[0].toBlock >= 160 && asked[0].fromBlock >= 101 && asked[0].toBlock <= 200);
  assert.deepEqual(asked[0].topics[2], [topic(W)]);
});

await check("transfers sent back to payers are read the same way, with no block lookups (only amounts matter)", async () => {
  let blocks = 0;
  const provider = {
    async getLogs(f) { assert.equal(f.topics[0], TOPICS.TRANSFER); return [xfer("0x06", 3, A(9), A(1), 5, 42)]; },
    async getBlock() { blocks++; return { timestamp: 5 }; },
  };
  const r = await scanTransfers(provider, { usdg: A(7), from: [A(9)], to: [A(1)], fromBlock: 1, toBlock: 10 });
  assert.deepEqual(r.transfers.map((x) => [x.from, x.to, x.amount]), [[A(9), A(1), "5"]]);
  assert.equal(blocks, 0);
});

await check("S-1 (GHSA-6f8j): each backer id's last registry transfer is read incrementally, for those ids only; a new id from the start", async () => {
  const REG = A(8), calls = [];
  const nft = (id, block) => ({ transactionHash: "0x" + block.toString(16), index: 0, blockNumber: block, address: REG, topics: [TOPICS.TRANSFER, topic(A(1)), topic(A(2)), ethers.zeroPadValue(ethers.toBeHex(id), 32)], data: "0x" });
  const logs = [nft(5, 120), nft(5, 180), nft(6, 250)];
  const provider = {
    async getLogs(f) {
      calls.push(f);
      const ids = f.topics[3].map((t) => Number(BigInt(t)));
      return logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock && ids.includes(Number(BigInt(l.topics[3]))));
    },
    async getBlock(n) { return { timestamp: 1000 + n }; },
  };
  const s1 = await updateBackerTenure(provider, null, { registry: REG, ids: [5], fromBlock: 100, head: 200 });
  assert.deepEqual(s1.since, { 5: 1180 }); assert.equal(s1.scannedTo, 200);
  assert.ok(calls.every((c) => c.address === REG && c.topics[0] === TOPICS.TRANSFER && c.topics[1] === null && c.topics[2] === null), "the registry's transfers of those ids only");
  calls.length = 0;
  const s2 = await updateBackerTenure(provider, s1, { registry: REG, ids: [5, 6], fromBlock: 100, head: 300 });
  assert.deepEqual(s2.since, { 5: 1180, 6: 1250 }); assert.equal(s2.scannedTo, 300);
  assert.ok(calls.some((c) => c.fromBlock === 201) && calls.some((c) => c.fromBlock === 100), "known ids from the cursor, a new id from the start");
});

await check("S-1: the backer transfer read is resumable: out of time mid-scan it keeps its progress, and the next run finishes it", async () => {
  const REG = A(8);
  const nft = (id, block) => ({ transactionHash: "0x" + block.toString(16), index: 0, blockNumber: block, address: REG, topics: [TOPICS.TRANSFER, topic(A(1)), topic(A(2)), ethers.zeroPadValue(ethers.toBeHex(id), 32)], data: "0x" });
  const logs = [nft(7, 150), nft(7, 950)];
  let calls = 0, budget = 2; // the clock runs out after two chunks
  const realNow = Date.now;
  const provider = {
    async getLogs(f) { calls++; if (--budget <= 0) Date.now = () => realNow() + 3_600_000; return logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock); },
    async getBlock(n) { return { timestamp: 1000 + n }; },
  };
  let s;
  try { s = await updateBackerTenure(provider, null, { registry: REG, ids: [7], fromBlock: 100, head: 1000, chunk: 100, deadline: realNow() + 60_000 }); } finally { Date.now = realNow; }
  assert.ok(s.pending && s.pending.next === 300 && !s.ids.includes(7), `progress kept: ${JSON.stringify(s)}`);
  assert.deepEqual(s.since, { 7: 1150 }, "what was read counts already");
  const done = await updateBackerTenure(provider, s, { registry: REG, ids: [7], fromBlock: 100, head: 1000, chunk: 100 });
  assert.ok(!done.pending && done.ids.includes(7) && done.scannedTo === 1000, JSON.stringify(done));
  assert.deepEqual(done.since, { 7: 1950 });
});

// ---------------------------------------------------------------- scoring income
const agent = (id, owner, over = {}) => ({ id, owner, sponsor: 0, isRoot: false, delegatedIn: 0, enrolledAt: NOW - 100 * DAY, defaulted: false, ...over });
const pay = (payer, payTo, usd, daysAgo = 1) => ({ payer, payTo, amount: $(usd), at: NOW - daysAgo * DAY });
const world = (agents, loans = []) => ({ meta: { timestamp: NOW }, events: [], agents, loans });
// every agent declared its owner as its payment wallet (the registry's default at registration) unless a test says otherwise
const one = (s, id, opts = {}) => scoreAll(s, { links: { clusters: [] }, ...opts, agentWallets: { ...Object.fromEntries(s.agents.map((a) => [a.id, a.owner])), ...opts.agentWallets } }).find((x) => x.agentId === id);
const OWNER = A(0xa), WALLET = A(0xb), CLIENT = A(0xc), OTHER = A(0xd);

await check("income paid to the agent's declared payment wallet counts for that agent", () => {
  const s = world([agent(1, OWNER), agent(2, OTHER)]);
  const withWallet = one(s, 1, { income: [pay(CLIENT, WALLET, 10)], agentWallets: { 1: WALLET } });
  const without = one(s, 1, { income: [pay(CLIENT, WALLET, 10)] });
  assert.ok(pts(withWallet, "income") > 0);
  assert.equal(pts(without, "income"), 0);
});

await check("a wallet two agents declare links them: they can't pay each other income or back each other", () => {
  // agent 1 (owner A) and agent 2 (owner B) both declared WALLET, which signed for both: one party
  const s = world([agent(1, OWNER, { sponsor: 2, delegatedIn: $(100) }), agent(2, OTHER, { isRoot: true, enrolledAt: NOW - 400 * DAY })]);
  const linked = one(s, 1, { income: [pay(OTHER, WALLET, 20)], agentWallets: { 1: WALLET, 2: WALLET } });
  assert.equal(pts(linked, "income"), 0);
  assert.equal(pts(linked, "backing"), 0);
  const apart = one(s, 1, { income: [pay(OTHER, OWNER, 20)] });
  assert.ok(pts(apart, "income") > 0 && pts(apart, "backing") > 0);
});

await check("USDG the agent's side sent to a payer is netted out of that payer's income", () => {
  const s = world([agent(1, OWNER)]);
  const full = one(s, 1, { income: [pay(CLIENT, OWNER, 20)] });
  const roundTrip = one(s, 1, { income: [pay(CLIENT, OWNER, 20)], transfers: [{ from: OWNER, to: CLIENT, amount: $(20), at: NOW - 3 * DAY }] });
  const partly = one(s, 1, { income: [pay(CLIENT, OWNER, 20)], transfers: [{ from: OWNER, to: CLIENT, amount: $(5), at: NOW - 3 * DAY }] });
  assert.equal(pts(roundTrip, "income"), 0);
  assert.equal(roundTrip.detail.distinctPayers, 0);
  assert.ok(pts(partly, "income") < pts(full, "income") && pts(partly, "income") > 0);
});

await check("funding sent from the agent's declared wallet counts as its side too", () => {
  const s = world([agent(1, OWNER)]);
  const r = one(s, 1, { income: [pay(CLIENT, OWNER, 20)], agentWallets: { 1: WALLET }, transfers: [{ from: WALLET, to: CLIENT, amount: $(20), at: NOW - 9 * DAY }] });
  assert.equal(pts(r, "income"), 0);
});

// a backed loan (another owner's aged root) repaid by the agent's owner
const backed = (id, usd, issuedDaysAgo, holdDays) => ({ agentId: 1, sponsorId: 2, era: "v2", id, principal: $(usd), fee: $(usd * 0.01),
  issuedAt: NOW - issuedDaysAgo * DAY, dueAt: NOW - (issuedDaysAgo - 30) * DAY, closedAt: NOW - (issuedDaysAgo - holdDays) * DAY, status: "repaid" });
const lender = () => [agent(1, OWNER, { sponsor: 2 }), agent(2, OTHER, { isRoot: true, enrolledAt: NOW - 400 * DAY })];

// five distinct clients paying 20.2 USDG each: at half weight (unknown wallets), 10.1 each, 50.5 in all: one loan's due
const clients = (n, usd, daysAgo = 15) => Array.from({ length: n }, (_, k) => pay(A(0x500 + k), OWNER, usd, daysAgo));

await check("a loan repaid from income earns more risk time than one repaid from the owner's pocket", () => {
  const s = world(lender(), [backed(501, 50, 20, 10)]);
  const opts = { income: clients(5, 20.2), repayers: { 501: OWNER } };
  const fromIncome = one(s, 1, opts);
  const fromPocket = one(s, 1, { ...opts, income: [] });
  assert.equal(fromIncome.detail.repaidFromIncome, 1);
  assert.equal(pts(fromIncome, "riskTime"), Math.round(pts(fromPocket, "riskTime") * (1 + W.components.riskTime.incomeRepaidBonus) * 10) / 10);
});

await check("one payment funds at most its own amount: two loans share it", () => {
  const s = world(lender(), [backed(601, 50, 20, 10), backed(602, 50, 19, 10)]);
  const r = one(s, 1, { income: clients(5, 20.2), repayers: { 601: OWNER, 602: OWNER } });
  assert.equal(r.detail.repaidFromIncome, 1); // 50.5 of weighted income covers one loan's 50.5 due, not two
  const small = one(world(lender(), [backed(603, 50, 20, 10)]), 1, { income: clients(1, 20.2), repayers: { 603: OWNER } });
  assert.equal(small.detail.repaidFromIncome, 0.2); // 10.1 of 50.5 due: a fifth of the loan
});

await check("audit F5: a loan's income is weighted and capped per payer, so one big (or recycled) payment can't fund it", () => {
  const s = world(lender(), [backed(611, 120, 20, 10)]);
  const r = one(s, 1, { income: [pay(CLIENT, OWNER, 121.2, 15)], repayers: { 611: OWNER } });
  assert.equal(r.detail.repaidFromIncome, 0.2, `repaidFromIncome ${r.detail.repaidFromIncome}`); // 20 of 121.2 (0.165), not 1
  // a payer with a strong record counts in full: the same five clients, scored 1000, fund the loan twice as fast
  const base = { links: { clusters: [] }, income: clients(5, 10.1), repayers: { 612: OWNER }, agentWallets: { 1: OWNER, 2: OTHER } };
  const s2 = world(lender(), [backed(612, 50, 20, 10)]);
  const unknown = buildInputs(s2, base).find((x) => x.agentId === 1).loans[0].incomeShare;
  const scored = buildInputs(s2, { ...base, payerScores: Object.fromEntries(clients(5, 1).map((p) => [p.payer, 1000])) }).find((x) => x.agentId === 1).loans[0].incomeShare;
  assert.ok(Math.abs(scored - 2 * unknown) < 1e-9 && unknown > 0, `${unknown} ${scored}`);
});

await check("audit F5: income is spent only on loans that count (not late, not self-backed)", () => {
  const late = { ...backed(621, 50, 20, 10), dueAt: NOW - 12 * DAY, closedAt: NOW - 10 * DAY }; // repaid after its due date
  const self = { ...backed(622, 50, 20, 9), sponsorId: 3 }; // backed by its owner's own root
  const good = backed(623, 50, 20, 11);
  const s = world([...lender(), agent(3, OWNER, { isRoot: true, enrolledAt: NOW - 400 * DAY })], [late, self, good]);
  const i = buildInputs(s, { links: { clusters: [] }, income: clients(5, 20.2, 15), repayers: { 621: OWNER, 622: OWNER, 623: OWNER }, agentWallets: { 1: OWNER, 2: OTHER, 3: null } }).find((x) => x.agentId === 1);
  assert.deepEqual(i.loans.map((l) => l.incomeShare), [0, 0, 1]);
});

await check("audit F3: a v1 loan with the same id as a funded v2 loan gets no income share", () => {
  // the same id on both pools, the same dates, and the v1 loan backed by someone else too (its FeeSplit names the root)
  const v2 = backed(701, 50, 20, 10);
  const v1 = { ...backed(701, 50, 20, 10), era: "v1", sponsorId: undefined };
  const s = { ...world(lender(), [v1, v2]), events: [{ kind: "FeeSplit", era: "v1", loanId: 701, sponsor: 2 }] };
  const i = buildInputs(s, { links: { clusters: [] }, income: clients(5, 20.2), repayers: { 701: OWNER }, agentWallets: { 1: OWNER, 2: OTHER } }).find((x) => x.agentId === 1);
  assert.deepEqual(i.loans.map((l) => [l.incomeShare]), [[0], [1]]);
});

await check("Autopay: a loan repaid through AutoRepay from the agent's wallet, its owner, or both, keeps the income reward", () => {
  const s = world(lender(), [backed(711, 50, 20, 10)]);
  const toKey = clients(5, 20.2).map((p) => ({ ...p, payTo: WALLET })); // x402 income lands on the agent's declared key
  const fromWallet = one(s, 1, { income: toKey, repayers: { 711: WALLET }, agentWallets: { 1: WALLET } });
  const fromBoth = one(s, 1, { income: toKey, repayers: { 711: [WALLET, OWNER] }, agentWallets: { 1: WALLET } });
  const fromOwner = one(s, 1, { income: toKey, repayers: { 711: OWNER }, agentWallets: { 1: WALLET } });
  for (const r of [fromWallet, fromBoth, fromOwner]) assert.equal(r.detail.repaidFromIncome, 1);
  // every address that paid must be the agent's own: a stranger beside the wallet, an empty list, or AutoRepay itself
  // (a repayment the mapping could not resolve) fund nothing
  const mixed = one(s, 1, { income: toKey, repayers: { 711: [WALLET, OTHER] }, agentWallets: { 1: WALLET } });
  const empty = one(s, 1, { income: toKey, repayers: { 711: [] }, agentWallets: { 1: WALLET } });
  const unmapped = one(s, 1, { income: toKey, repayers: { 711: A(0xa0) }, agentWallets: { 1: WALLET } });
  for (const r of [mixed, empty, unmapped]) assert.equal(r.detail.repaidFromIncome, 0);
});

await check("income arriving outside the loan, from the agent's own side, or a loan repaid by someone else, funds nothing", () => {
  const s = world(lender(), [backed(701, 50, 20, 10)]);
  const before = one(s, 1, { income: [pay(CLIENT, OWNER, 60, 25)], repayers: { 701: OWNER } }); // paid before the loan
  const self = one(s, 1, { income: [pay(OWNER, OWNER, 60, 15)], repayers: { 701: OWNER } }); // its own money
  const thirdParty = one(s, 1, { income: [pay(CLIENT, OWNER, 60, 15)], repayers: { 701: OTHER } }); // repaid by another wallet
  const unknown = one(s, 1, { income: [pay(CLIENT, OWNER, 60, 15)] }); // repayer not known
  for (const r of [before, self, thirdParty, unknown]) assert.equal(r.detail.repaidFromIncome, 0);
});

await check("a default spreads to agents linked through a declared wallet", () => {
  const s = world([agent(1, OWNER, { sponsor: 3 }), agent(2, OTHER, { defaulted: true }), agent(3, A(0xe), { isRoot: true, enrolledAt: NOW - 400 * DAY })],
    [{ agentId: 1, sponsorId: 3, era: "v2", id: 801, principal: $(50), issuedAt: NOW - 40 * DAY, dueAt: NOW - 10 * DAY, closedAt: NOW - 30 * DAY, status: "repaid" }]);
  assert.ok(one(s, 1).score > 0);
  const linked = one(s, 1, { agentWallets: { 1: WALLET, 2: WALLET } });
  assert.equal(linked.score, 0);
  assert.equal(linked.flags.ownerDefaulted, true);
});

await check("a payer's weight follows the best record of the agents it pays for, declared wallet included", () => {
  const snap = world([agent(1, OWNER), agent(2, OTHER)]);
  const i = buildInputs(snap, { income: [pay(WALLET, OWNER, 10)], agentWallets: { 1: OWNER, 2: WALLET }, payerScores: { [WALLET]: 400 } }).find((x) => x.agentId === 1);
  assert.equal(i.income[0].payerScore, 400);
});

await check("the engine refuses an income share over 1 and never depends on the order of income", () => {
  const base = { agentId: 1, now: NOW, recordStart: NOW - 60 * DAY, loans: [], income: [] };
  assert.throws(() => scoreV2({ ...base, loans: [{ principal: $(5), issuedAt: NOW - 10 * DAY, dueAt: NOW, closedAt: NOW - 5 * DAY, status: "repaid", backedByOthers: true, incomeShare: 1.5 }] }), /incomeShare/);
  const inc = Array.from({ length: 40 }, (_, i) => ({ payer: A(100 + (i % 7)), amount: 333_333 + i * 1_111, at: NOW - (i % 5) * DAY, payerScore: (i * 37) % 1000 }));
  assert.deepEqual(scoreV2({ ...base, income: inc }), scoreV2({ ...base, income: [...inc].reverse() }));
});

await check("audit F1: sending a defaulted agent to an honest owner harms nobody", () => {
  const HONEST = A(0x1001), ATTACKER = A(0x3003);
  const loans = [0, 1, 2, 3].map((k) => ({ ...backed(100 + k, 50, 80 - k * 16, 10), owner: HONEST }));
  const dead = { agentId: 9, sponsorId: 2, era: "v2", id: 990, owner: ATTACKER, principal: $(5), fee: 0, issuedAt: NOW - 50 * DAY, dueAt: NOW - 43 * DAY, closedAt: 0, status: "defaulted" };
  const agents = (holder) => [agent(1, HONEST, { sponsor: 2, delegatedIn: $(100), enrolledAt: NOW - 200 * DAY }), agent(2, OTHER, { isRoot: true, enrolledAt: NOW - 400 * DAY }), agent(9, holder, { defaulted: true })];
  const before = one(world(agents(ATTACKER), [...loans, dead]), 1);
  const after = one(world(agents(HONEST), [...loans, dead]), 1, { agentWallets: { 9: null } }); // the registry clears its wallet on transfer
  assert.ok(before.score > 0);
  assert.equal(after.score, before.score);
  assert.equal(after.flags.ownerDefaulted, false);
  // the defaulting wallet's own other agents are still zeroed
  const sibling = one(world([...agents(ATTACKER), agent(4, ATTACKER, { sponsor: 2 })], [...loans, dead, { ...backed(401, 50, 30, 10), agentId: 4, owner: ATTACKER }]), 4);
  assert.equal(sibling.score, 0);
  assert.equal(sibling.flags.ownerDefaulted, true);
});

await check("audit F2: agents pushed onto someone's address can't take a share of its income", () => {
  const s = world([agent(1, OWNER), ...[11, 12, 13].map((k) => agent(k, OWNER))]); // three agents sent to OWNER
  const alone = one(world([agent(1, OWNER)]), 1, { income: [pay(CLIENT, OWNER, 20)] });
  const pushed = one(s, 1, { income: [pay(CLIENT, OWNER, 20)], agentWallets: { 11: null, 12: null, 13: null } });
  assert.equal(pts(pushed, "income"), pts(alone, "income"));
});

await check("audit F4: income can't lift a thin record to the earned rung", () => {
  // a proven record just under 300 on its own, plus plenty of income: score over 300, rung stays 2 (proven)
  const loans = [0, 1, 2].map((k) => backed(800 + k, 50, 50 - k * 10, 9));
  const s = world(lender(), loans);
  const r = one(s, 1, { income: Array.from({ length: 10 }, (_, k) => pay(A(0x900 + k), OWNER, 20, 2)) });
  const record = r.score - pts(r, "income");
  assert.ok(r.score >= 300 && record < 300, `score ${r.score}, record ${record}`);
  assert.equal(r.rung, 2);
});

// ---------------------------------------------------------------- the index (resumable, incremental)
/**
 * A tiny chain: signed payments, Permit2 payments (`permit2`: the transfer, then the proxy's Settled()) and plain
 * transfers of one token, declared wallets, receipts. Records every query.
 */
function fakeChain({ payments = [], permit2 = [], transfers = [], wallets = {}, failWallets = new Set(), receipts = {} } = {}) {
  const calls = [];
  const hex = (a) => ethers.zeroPadValue(a, 32).toLowerCase();
  const inSet = (want, t) => want == null || (Array.isArray(want) ? want.map((x) => x.toLowerCase()) : [want.toLowerCase()]).includes(String(t).toLowerCase());
  const logs = [];
  payments.forEach((p, i) => { logs.push(auth("0xp" + i, 0, p.payer, p.block)); logs.push(xfer("0xp" + i, 1, p.payer, p.payTo, p.amount, p.block)); });
  permit2.forEach((p, i) => { logs.push(xfer("0xq" + i, 3, p.payer, p.payTo, p.amount, p.block)); logs.push(settled("0xq" + i, 4, p.block)); });
  transfers.forEach((x, i) => logs.push(xfer("0xt" + i, 0, x.from, x.to, x.amount, x.block)));
  const kindOf = (t) => (t === TOPICS.AUTH_USED ? "auth" : t === TOPICS.SETTLED || t === TOPICS.SETTLED_WITH_PERMIT ? "settled" : "transfer");
  const mc = new ethers.Interface(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);
  const reg = new ethers.Interface(["function getAgentWallet(uint256) view returns (address)"]);
  return {
    calls,
    async getLogs(f) {
      calls.push({ kind: kindOf(f.topics[0]), from: f.fromBlock, to: f.toBlock, t1: f.topics[1], t2: f.topics[2] });
      return logs.filter((l) => l.topics[0] === f.topics[0] && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock
        && (!l.address || inSet(f.address, l.address)) && inSet(f.topics[1], l.topics[1]) && (f.topics[2] === undefined || inSet(f.topics[2], l.topics[2])));
    },
    async getBlock(n) { return { timestamp: NOW - 1000 + n }; },
    async call(tx) {
      const [list] = mc.decodeFunctionData("aggregate3", tx.data);
      return mc.encodeFunctionResult("aggregate3", [list.map((c) => {
        const id = Number(reg.decodeFunctionData("getAgentWallet", c.callData)[0]);
        if (failWallets.has(id)) return [false, "0x"];
        return [true, reg.encodeFunctionResult("getAgentWallet", [wallets[id] || ethers.ZeroAddress])];
      })]);
    },
    async getTransactionReceipt(h) { return receipts[h] || null; },
  };
}
const W1 = A(0xe1), W2 = A(0xe2), P1 = A(0xf1), P2 = A(0xf2);
const snapOf = (agents, loans = [], events = []) => ({ meta: { timestamp: NOW }, agents, loans, events });
const opts = (snapshot, head, extra = {}) => ({ usdg: A(7), registry: A(8), pool: A(0x99), snapshot, fromBlock: 10, head, now: NOW, ...extra });

await check("index: a new payment wallet is backfilled on its own while the main cursor keeps moving", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }, { payer: P2, payTo: W2, amount: 2_000_000, block: 60 }], wallets: { 1: W1, 2: W2 } });
  let r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  assert.equal(r.complete, true);
  assert.deepEqual(r.state.payments.map((p) => p.payTo), [W1.toLowerCase()]);
  chain.calls.length = 0;
  r = await updateIncome(chain, r.state, opts(snapOf([agent(1, W1), agent(2, W2)]), 120));
  const tr = chain.calls.filter((c) => c.kind === "transfer" && c.t2 && c.t2.length && ethers.zeroPadValue(W2, 32).toLowerCase() === String(c.t2[0]).toLowerCase() && c.t2.length === 1);
  assert.ok(tr.some((c) => c.from === 10 && c.to === 100), "the new wallet alone, from the start to the old cursor");
  assert.ok(!chain.calls.some((c) => c.kind === "auth" && c.from < 101 && c.to > 100 && c.from !== 10), "no full rescan");
  assert.ok(chain.calls.some((c) => c.kind === "auth" && c.from === 101 && c.to === 120), "the main cursor moved on");
  assert.deepEqual(r.state.payments.map((p) => p.payTo).sort(), [W1, W2].map((x) => x.toLowerCase()).sort());
  assert.equal(r.complete, true);
});

await check("index: a backfill that runs out of time never holds back the netting cursor or the scores (live 2026-10-10: nine wallet backfills ate every run once a first payer appeared)", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }, { payer: P2, payTo: W2, amount: 2_000_000, block: 60 }], wallets: { 1: W1, 2: W2 } });
  let r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  assert.deepEqual([r.complete, r.state.payers, r.state.transfersTo], [true, [P1.toLowerCase()], 100]);
  // the next run: agent 2's wallet is new, so it is backfilled from the start; that read outlasts the run's time
  const slow = { ...chain, async getLogs(f) { if (f.fromBlock === 10) await new Promise((res) => setTimeout(res, 300)); return chain.getLogs(f); } };
  r = await updateIncome(slow, r.state, opts(snapOf([agent(1, W1), agent(2, W2)]), 120, { deadline: Date.now() + 150 }));
  assert.equal(r.state.paymentsTo, 120, "the payment cursor moved on");
  assert.equal(r.state.transfersTo, 120, "and so did the netting cursor, before the backfill took the time");
  assert.equal(r.complete, true, "so the scores are published; the backfill resumes next run");
  assert.ok(r.state.paymentBackfills.some((bf) => bf.wallets.includes(W2.toLowerCase()) && bf.next <= 100), "the backfill is still there, to resume");
});

await check("index: a payer a payment backfill finds is netted in the same run, before its income counts", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }, { payer: P2, payTo: W2, amount: 2_000_000, block: 60 }],
    transfers: [{ from: W1, to: P2, amount: 500_000, block: 70 }], wallets: { 1: W1, 2: W2 } });
  let r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  assert.deepEqual(r.state.payers, [P1.toLowerCase()]);
  r = await updateIncome(chain, r.state, opts(snapOf([agent(1, W1), agent(2, W2)]), 120));
  assert.deepEqual(r.state.payers, [P1, P2].map((x) => x.toLowerCase()).sort(), "P2, found by W2's backfill, is a payer now");
  assert.deepEqual(r.state.transfers.map((x) => [x.from, x.to, x.amount]), [[W1.toLowerCase(), P2.toLowerCase(), "500000"]], "and what agent 1's wallet sent it is read");
  assert.deepEqual(r.pending.payers, [], "read to the end: nothing waits");
  assert.equal(r.complete, true);
});

await check("index: a payment a backfill finds puts its agent's repaid loan's repayer before the scores, as one the cursor finds does", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }, { payer: P2, payTo: W2, amount: 2_000_000, block: 60 }], wallets: { 1: W1, 2: W2 } });
  const first = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  // agent 2 is new (its wallet W2 is backfilled) and repaid loan 7 while P2's payment (block 60) was in
  const loan = { agentId: 2, era: "v2", id: 7, principal: 1, fee: 0, issuedAt: NOW - 1000 + 55, dueAt: NOW + DAY, closedAt: NOW - 1000 + 65, status: "repaid" };
  const snap = snapOf([agent(1, W1), agent(2, W2)], [loan], [{ kind: "Repaid", era: "v2", loanId: 7, tx: "0xr7" }]);
  const held = await updateIncome(chain, first.state, opts(snap, 120, { maxRepayerReads: 0 }));
  assert.equal(held.complete, false, "its repayer not read yet: no scores from this run");
  const read = await updateIncome(chain, first.state, opts(snap, 120));
  assert.ok("7" in read.state.repayers, "read in the same run when there is time");
  assert.equal(read.complete, true);
});

await check("index (live 2026-10-23): a payment backfill that outlasts every run never starves the netting backfills: a new payer and a new agent's wallet stop waiting, and the payments count", async () => {
  // agent 1 (W1) has been paid by P1; then agent 2 arrives with a new wallet (W2, whose past payments are backfilled
  // from the start) and a new payer P2 pays agent 1. Live, the new wallets' payment backfills took every run's budget,
  // the netting backfills behind them never ran, and every payer of 1 USDG or more stayed pending: 0 receipts on the board
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }, { payer: P2, payTo: W1, amount: 2_000_000, block: 110 }], wallets: { 1: W1, 2: W2 } });
  let r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  const inner = chain.getLogs.bind(chain), real = Date.now;
  let clock = real();
  // from now on, a payment window of the range read before (the backfill's) takes a minute: longer than a whole run
  chain.getLogs = async (f) => { if (f.topics[0] === TOPICS.AUTH_USED && f.toBlock <= 100) clock += 60_000; return inner(f); };
  Date.now = () => clock;
  const snap = snapOf([agent(1, W1), agent(2, W2)]);
  const waiting = [];
  try {
    for (let run = 1; run <= 4; run++) {
      r = await updateIncome(chain, r.state, opts(snap, 100 + 10 * run, { deadline: clock + 45_000 }));
      waiting.push(r.pending.payers.length + r.pending.wallets.length);
      assert.ok(r.state.paymentBackfills.some((bf) => bf.wallets.includes(lc(W2))), `run ${run}: the payment backfill outlasts the run`);
    }
  } finally { Date.now = real; }
  assert.deepEqual(r.pending, { payers: [], wallets: [] }, `the new payer and the new wallet stop waiting (pending per run: ${waiting})`);
  assert.equal(waiting[0], 0, "in the first run");
  const s = scoreAll(world([agent(1, W1), agent(2, W2)]), { links: { clusters: [] }, income: r.state.payments, agentWallets: r.state.agentWallets, transfers: r.state.transfers, pending: r.pending }).find((x) => x.agentId === 1);
  assert.deepEqual([s.detail.receiptPayers, s.detail.receiptsUsdg, s.detail.distinctPayers], [2, 3, 2], "P2's payment shows and counts");
});

await check("index (live 2026-10-23): a netting backfill longer than a run's time moves run by run, its cursor kept, instead of reading the same window again every run", async () => {
  // the official node answers a query with lists of topics over 100,000 blocks at most: it refuses a wider one, and
  // getLogsAdaptive halves it, so a 5M window goes out as 64 requests and 63 refusals (18 s on 2026-10-23, up to 36 s
  // before: 0.14-0.28 s a call). Here each call takes 0.3 s and the run's cursors 10 s first: the 5M window needs
  // 38 s of the 35 s left. A window cut short by the run's deadline is dropped whole: one that never fits never moves
  const M = 1_000_000, HEAD = 30 * M;
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: HEAD - 50 }, { payer: P2, payTo: W1, amount: 2_000_000, block: HEAD + 50 }],
    transfers: [{ from: W1, to: P2, amount: 500_000, block: 3 * M }, { from: W1, to: P2, amount: 250_000, block: 27 * M }], wallets: { 1: W1 } });
  let r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), HEAD)); // built while netting was cheap
  const inner = chain.getLogs.bind(chain), real = Date.now;
  let clock = real();
  const netting = (f) => f.topics[0] === TOPICS.TRANSFER && Array.isArray(f.topics[1]) && f.topics[1].map((t) => t.toLowerCase()).includes(ethers.zeroPadValue(W1, 32).toLowerCase());
  chain.getLogs = async (f) => {
    if (f.topics[0] === TOPICS.AUTH_USED && f.fromBlock > HEAD) clock += 10_000; // the run's cursors, before the backfills
    if (!netting(f)) return inner(f);
    clock += 300;
    if (f.toBlock - f.fromBlock + 1 > 100_000) throw Object.assign(new Error("could not coalesce error"), { error: { code: -32602, message: "query spans too many blocks; narrow the block range" } });
    return inner(f);
  };
  Date.now = () => clock;
  const next = [];
  try {
    for (let run = 1; run <= 4 && (run === 1 || r.state.transferBackfills.length); run++) {
      r = await updateIncome(chain, r.state, opts(snapOf([agent(1, W1)]), HEAD + 100 * run, { deadline: clock + 45_000 }));
      const bf = r.state.transferBackfills.find((x) => x.to.includes(lc(P2)));
      next.push(bf ? bf.next : "done");
    }
  } finally { Date.now = real; }
  assert.ok(typeof next[0] === "number" && next[0] > 1, `the first run keeps what it read (next per run: ${next})`);
  assert.ok(next.every((n, i) => i === 0 || n === "done" || n > next[i - 1]), `and each run goes on from there (next per run: ${next})`);
  assert.equal(next[next.length - 1], "done", `P2's netting is read within 4 runs (next per run: ${next})`);
  assert.deepEqual(r.pending.payers, []);
  assert.deepEqual(r.state.transfers.map((x) => [x.to, x.amount, x.block]), [[lc(P2), "500000", 3 * M], [lc(P2), "250000", 27 * M]], "every window of the chain read once");
});

await check("index (live 2026-10-23): the netting backfills not started yet are read in one scan per kind, over the union of their wallets and payers: each gets exactly the transfers its own scan finds, and each payer stops waiting once its own range is read", async () => {
  // Live, 29 backfills waited at block 1, each to read the same chain again on its own. Here two of each kind, with
  // overlapping wallets and payers, and transfers that only the union of a kind's addresses matches (no backfill's pair)
  const W3 = A(0xe3), W4 = A(0xe4), P3 = A(0xf3), HEAD = 100;
  const transfers = [
    { from: W1, to: P2, amount: 100, block: 15 }, // A's
    { from: W2, to: P2, amount: 101, block: 65 }, // past A's range
    { from: W3, to: P2, amount: 102, block: 20 }, // C's (W3's netting toward P1 and P2), not A's (W3 is not A's)
    { from: W3, to: P3, amount: 103, block: 40 }, // B's; in the union of the wallets kind, but neither C's pair nor D's
    { from: W2, to: P3, amount: 104, block: 50 }, // B's
    { from: W4, to: P1, amount: 105, block: 30 }, // D's
    { from: W4, to: P3, amount: 106, block: 95 }, // D's
    { from: W1, to: P1, amount: 107, block: 25 }, // nobody's: W1 toward P1 was read before
    { from: W3, to: P1, amount: 108, block: 80 }, // past C's range
    { from: W3, to: P3, amount: 109, block: 92 }, // past B's range, and not a pair of the wallets kind
  ];
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 11 }, { payer: P2, payTo: W1, amount: 1_000_000, block: 12 }, { payer: P3, payTo: W2, amount: 1_000_000, block: 13 }],
    transfers, wallets: { 1: W1, 2: W2, 3: W3, 4: W4 } });
  const snap = snapOf([agent(1, W1), agent(2, W2), agent(3, W3), agent(4, W4)]);
  const o = (extra = {}) => opts(snap, HEAD, { transfersChunk: 10, ...extra });
  const built = (await updateIncome(chain, null, o())).state;
  assert.deepEqual([built.payers, built.from, built.transfersTo], [[P1, P2, P3].map(lc), [W1, W2, W3, W4].map(lc), HEAD]);
  // the same index with its netting still to read: two payers' backfills and two wallets' backfills, none started
  const bfs = [
    { kind: "payers", from: [W1, W2].map(lc), to: [lc(P2)], next: 1, until: 60 }, // A
    { kind: "payers", from: [W1, W2, W3].map(lc), to: [lc(P3)], next: 1, until: 90 }, // B
    { kind: "wallets", from: [lc(W3)], to: [P1, P2].map(lc), next: 1, until: 70 }, // C
    { kind: "wallets", from: [lc(W4)], to: [P1, P2, P3].map(lc), next: 1, until: 100 }, // D
  ];
  const waiting = { ...built, transfers: [], transferBackfills: bfs };
  // what each backfill's own scan finds
  const own = [];
  for (const bf of bfs) own.push(...(await scanTransfers(chain, { usdg: A(7), from: bf.from, to: bf.to, fromBlock: bf.next, toBlock: bf.until, chunk: 10 })).transfers);
  const ids = (xs) => [...new Set(xs.map((x) => x.id))].sort();
  assert.deepEqual(own.map((x) => Number(x.amount)).sort(), [100, 102, 103, 104, 105, 106], "the separate scans' transfers (the reference)");
  const isNet = (c) => c.kind === "transfer" && Array.isArray(c.t1) && c.from <= HEAD;
  const kindOfCall = (c) => (c.t1.map(lc).includes(topic(W1).toLowerCase()) ? "payers" : "wallets");

  // one run with time for everything
  chain.calls.length = 0;
  const r = await updateIncome(chain, waiting, o());
  assert.deepEqual(ids(r.state.transfers), ids(own), "each backfill got exactly the transfers its own scan finds");
  assert.deepEqual([r.state.transferBackfills, r.pending], [[], { payers: [], wallets: [] }]);
  const nets = chain.calls.filter(isNet);
  assert.equal(nets.length, 9 + 10, `one query a window for each kind: the payers' to block 90, the wallets' to block 100 (asked: ${nets.length}, separate scans 6 + 9 + 7 + 10 = 32)`);

  // runs of five queries each: a backfill stops waiting in the run that reads its last block, not when its kind's scan ends
  const real = Date.now;
  let clock = real();
  const inner = chain.getLogs.bind(chain);
  chain.getLogs = async (f) => { const out = await inner(f); if (f.topics[0] === TOPICS.TRANSFER && Array.isArray(f.topics[1])) clock += 1000; return out; };
  Date.now = () => clock;
  chain.calls.length = 0;
  let s = waiting, runs = 0;
  const readTo = { payers: 0, wallets: 0 };
  try {
    while (s.transferBackfills.length && runs < 10) {
      const before = chain.calls.length;
      const step = await updateIncome(chain, s, o({ deadline: clock + 4_500 }));
      s = step.state; runs++;
      for (const c of chain.calls.slice(before).filter(isNet)) readTo[kindOfCall(c)] = Math.max(readTo[kindOfCall(c)], c.to);
      const left = (bf) => s.transferBackfills.some((x) => x.kind === bf.kind && x.until === bf.until);
      for (const bf of bfs) assert.equal(left(bf), bf.until > readTo[bf.kind], `run ${runs}: the backfill to ${bf.until} waits exactly while its own range is unread (${bf.kind} read to ${readTo[bf.kind]})`);
      assert.deepEqual(step.pending.payers, bfs.filter((bf) => bf.kind === "payers" && left(bf)).flatMap((bf) => bf.to).sort(), `run ${runs}: pending payers`);
      assert.deepEqual(step.pending.wallets, bfs.filter((bf) => bf.kind === "wallets" && left(bf)).flatMap((bf) => bf.from).sort(), `run ${runs}: pending wallets`);
      const got = new Set(s.transfers.map((x) => x.id));
      assert.ok([...got].every((id) => own.some((x) => x.id === id)), `run ${runs}: no transfer that no backfill's own scan finds`);
      for (const bf of bfs.filter((x) => !left(x))) {
        const mine = own.filter((x) => x.block <= bf.until && bf.from.includes(x.from) && bf.to.includes(x.to));
        assert.ok(mine.every((x) => got.has(x.id)), `run ${runs}: the backfill to ${bf.until} has all its transfers once it stops waiting`);
      }
    }
  } finally { Date.now = real; }
  assert.deepEqual(ids(s.transfers), ids(own));
  assert.equal(chain.calls.filter(isNet).length, 19, "every window read once over the runs");
});

await check("index (live 2026-10-23): from the live index's shape, on a node that serves 10,000 blocks a query, every netting backfill is read within 50 steps", async () => {
  // The index of 2026-10-23 18:45 UTC (KV income:v1): 30 netting backfills, the first at block 39,000,001 of
  // 85,362,903, the other 29 not started: [kind, wallets, payers, next, until]. The paid node behind INCOME_RPC answers
  // eth_getLogs over at most 10,000 blocks (HTTP 413, -32614 "eth_getLogs is limited to a 10,000 range"; probed on the
  // private node, the same provider): a 100,000-block window went out as 15 refusals and 16 queries of 6,250 blocks.
  // Live, a step read 17-19 such windows (39M blocks in 3.5 h of steps 10 minutes apart): 530-590 queries in 45 s, about
  // 80-85 ms each from the Worker, the cost here. The cursors read the 3,852 blocks of a step first.
  const LIVE = [["payers", 305, 1, 39_000_001, 85_362_903], ["payers", 305, 1, 1, 85_535_652], ["wallets", 1, 2, 1, 85_920_765], ["payers", 306, 1, 1, 86_027_202],
    ["wallets", 4, 3, 1, 88_007_169], ["wallets", 1, 3, 1, 88_432_907], ["wallets", 1, 3, 1, 88_671_963], ["wallets", 1, 3, 1, 88_906_791], ["wallets", 2, 3, 1, 89_344_935],
    ["wallets", 1, 3, 1, 89_392_417], ["wallets", 1, 3, 1, 89_472_027], ["wallets", 2, 3, 1, 89_513_867], ["wallets", 2, 3, 1, 89_615_004], ["wallets", 2, 3, 1, 89_835_715],
    ["wallets", 1, 3, 1, 89_923_466], ["wallets", 3, 3, 1, 90_286_854], ["wallets", 1, 3, 1, 91_590_643], ["wallets", 1, 3, 1, 91_595_625], ["wallets", 2, 3, 1, 92_661_611],
    ["wallets", 1, 3, 1, 93_154_879], ["wallets", 1, 3, 1, 93_659_289], ["wallets", 1, 3, 1, 93_681_490], ["wallets", 1, 3, 1, 93_782_708], ["wallets", 1, 3, 1, 94_001_582],
    ["wallets", 2, 3, 1, 94_431_819], ["wallets", 2, 3, 1, 94_540_216], ["wallets", 2, 3, 1, 94_549_732], ["payers", 342, 1, 1, 94_626_759], ["wallets", 1, 4, 1, 95_197_040],
    ["wallets", 1, 4, 1, 96_065_389]];
  const HEAD = 96_153_865, STEP = 3_852, COST = 85, BUDGET = 45_000;
  const side = Array.from({ length: 344 }, (_, i) => lc(A(0x10000 + i))), payers = [1, 2, 3, 4].map((k) => lc(A(0xfa0 + k)));
  let fresh = side.length; // a wallets backfill's wallets: the newest agent-side wallets, from the end
  const transferBackfills = LIVE.map(([kind, nf, nt, next, until], i) => ({ kind, next, until,
    from: kind === "payers" ? side.slice(0, nf) : side.slice((fresh -= nf), fresh + nf),
    to: kind === "payers" ? [payers[[0, 1, 3, 27].indexOf(i)]] : payers.slice(0, nt) }));
  const snap = snapOf(side.map((w, i) => agent(i + 1, w)));
  const state = { v: 2, fromBlock: 10, transfersFrom: 1, agentWallets: Object.fromEntries(side.map((w, i) => [i + 1, w])), walletFailures: {}, walletsAt: NOW,
    wallets: [...side].sort(), payments: payers.map((p, k) => ({ id: `0x${k}:1`, block: HEAD - 100 + k, at: NOW - DAY, payer: p, payTo: side[0], amount: "2000000" })),
    paymentsTo: HEAD, paymentBackfills: [], permit2: true, permit2Backfill: null, from: [...side].sort(), payers, transfers: [], transfersTo: HEAD,
    transferBackfills, repayers: {}, paymentsChunk: 2_000_000 };
  const real = Date.now;
  let clock = real(), queries = 0;
  const node = {
    async getLogs(f) {
      clock += COST; queries++;
      if (f.toBlock - f.fromBlock > 10_000) throw Object.assign(new Error("server response 413 Request Entity Too Large"), { error: { code: -32614, message: "eth_getLogs is limited to a 10,000 range" } });
      return [];
    },
    async getBlock(n) { clock += COST; return { timestamp: NOW - 1000 + n }; },
  };
  Date.now = () => clock;
  let r = { state }, steps = 0, payersClear = null;
  try {
    while (r.state.transferBackfills.length && steps < 120) {
      steps++;
      r = await updateIncome(node, r.state, opts(snap, HEAD + STEP * steps, { deadline: clock + BUDGET }));
      if (payersClear == null && !r.pending.payers.length) payersClear = steps;
      assert.equal(r.complete, true, `step ${steps}: the cursors keep up`);
    }
  } finally { Date.now = real; }
  assert.equal(r.state.transferBackfills.length, 0, `every netting backfill read (left after ${steps} steps: ${r.state.transferBackfills.length}, the first at block ${r.state.transferBackfills[0]?.next})`);
  // 23,707 windows of 10,000 blocks (the started one's 4,637, the payers' 9,463, the wallets' 9,607), ~523 a step
  assert.ok(steps <= 50, `in ${steps} steps (${queries} queries, ${Math.round(queries / steps)} a step)`);
  assert.ok(payersClear <= 30, `every payer read back by step ${payersClear}`);
});

await check("index: a new index reads Permit2 payments from the start, through the same cursor as the signed ones", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 40 }], permit2: [{ payer: P2, payTo: W1, amount: 2_000_000, block: 50 }], wallets: { 1: W1 } });
  const r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  assert.deepEqual(r.state.payments.map((p) => [p.payer, p.amount, p.via || "eip3009"]), [[P1.toLowerCase(), "1000000", "eip3009"], [P2.toLowerCase(), "2000000", "permit2"]]);
  assert.equal(r.state.permit2Backfill, null, "nothing to re-read");
  assert.deepEqual(r.state.payers, [P1, P2].map((x) => x.toLowerCase()).sort(), "a Permit2 payer is netted like any other");
  assert.equal(r.complete, true);
});

/** The state an index built before Permit2 counted would hold: no Permit2 marker, and no Permit2 payment read. */
const beforePermit2 = (state) => {
  const s = JSON.parse(JSON.stringify(state));
  delete s.permit2; delete s.permit2Backfill;
  s.payments = s.payments.filter((p) => p.via !== "permit2");
  return s;
};

await check("index: an index read before Permit2 counted re-reads Permit2 alone over what it had read, once", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 40 }], permit2: [{ payer: P2, payTo: W1, amount: 2_000_000, block: 50 }], wallets: { 1: W1 } });
  const old = beforePermit2((await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100))).state);
  chain.calls.length = 0;
  const r = await updateIncome(chain, old, opts(snapOf([agent(1, W1)]), 120));
  assert.ok(!chain.calls.some((c) => c.kind === "auth" && c.from <= 100), "the signed payments already read are not read again");
  assert.ok(chain.calls.some((c) => c.kind === "settled" && c.from === 10 && c.to === 100), "Permit2 alone over the part already read");
  assert.ok(chain.calls.some((c) => c.kind === "auth" && c.from === 101 && c.to === 120), "the main cursor moved on");
  assert.deepEqual(r.state.payments.map((p) => [p.block, p.via || "eip3009"]), [[40, "eip3009"], [50, "permit2"]]);
  assert.equal(r.state.permit2Backfill, null, "done: never re-read again");
  assert.equal(r.state.permit2, true);
  chain.calls.length = 0;
  await updateIncome(chain, r.state, opts(snapOf([agent(1, W1)]), 120));
  assert.ok(!chain.calls.some((c) => c.kind === "settled" && c.from <= 100), "the next run does not re-read it");
});

await check("index: a Permit2 re-read still in progress never holds scores back, and says how far it has to go", async () => {
  const chain = fakeChain({ permit2: [{ payer: P2, payTo: W1, amount: 2_000_000, block: 50 }], wallets: { 1: W1 } });
  const old = beforePermit2((await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100))).state);
  const r = await updateIncome(chain, old, opts(snapOf([agent(1, W1)]), 100, { deadline: Date.now() - 1 }));
  assert.equal(r.complete, true, "like a new wallet's backfill: income is only smaller for now");
  assert.deepEqual(r.state.permit2Backfill, { next: 10, until: 100 });
  assert.equal(r.scan.permit2Backfill, 91, "blocks left to re-read");
});

await check("index: a new payer backfills only its own netting transfers", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }], transfers: [{ from: W1, to: P2, amount: 500_000, block: 20 }], wallets: { 1: W1 } });
  let r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  assert.equal(r.state.transfersTo, 100);
  chain.calls.length = 0;
  chain.logsAdd = null;
  const chain2 = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }, { payer: P2, payTo: W1, amount: 1_000_000, block: 110 }], transfers: [{ from: W1, to: P2, amount: 500_000, block: 20 }], wallets: { 1: W1 } });
  r = await updateIncome(chain2, r.state, opts(snapOf([agent(1, W1)]), 120));
  const nets = chain2.calls.filter((c) => c.kind === "transfer" && Array.isArray(c.t1) && c.t1.length && c.from === 1);
  assert.ok(nets.length && nets.every((c) => c.t2.length === 1 && c.t2[0].toLowerCase() === ethers.zeroPadValue(P2, 32).toLowerCase()), "only the new payer from the start");
  assert.deepEqual(r.state.transfers.map((x) => [x.from, x.to, x.amount]), [[W1.toLowerCase(), P2.toLowerCase(), "500000"]]);
  assert.equal(r.complete, true);
});

await check("index: agent-side wallets for netting include the clusters file's wallets", async () => {
  const X = A(0xabc);
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }], wallets: { 1: W1 } });
  await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100, { extraWallets: [X] }));
  assert.ok(chain.calls.some((c) => c.kind === "transfer" && Array.isArray(c.t1) && c.t1.map((t) => t.toLowerCase()).includes(ethers.zeroPadValue(X, 32).toLowerCase())));
});

await check("index: a failed wallet read keeps the wallet known before; an agent never read keeps the index incomplete", async () => {
  const chain = fakeChain({ wallets: { 1: W1 } });
  let r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  assert.equal(r.state.agentWallets[1], W1.toLowerCase());
  const failing = fakeChain({ wallets: { 1: W1, 2: W2 }, failWallets: new Set([1, 2]) });
  r = await updateIncome(failing, r.state, opts(snapOf([agent(1, W1), agent(2, W2)]), 100, { walletsEvery: 0 }));
  assert.equal(r.state.agentWallets[1], W1.toLowerCase(), "kept");
  assert.equal(2 in r.state.agentWallets, false);
  assert.equal(r.complete, false, "agent 2 was never read");
});

await check("index: a wallet that keeps failing to read holds the index back however many runs it fails (fail closed)", async () => {
  // a declared wallet is a cluster edge: publishing without it could make a same-cluster payer look external
  const failing = fakeChain({ wallets: { 1: W1, 2: W2 }, failWallets: new Set([2]) });
  let r = { state: null };
  for (let run = 0; run < 6; run++) r = await updateIncome(failing, r.state, opts(snapOf([agent(1, W1), agent(2, W2)]), 100));
  assert.equal(2 in r.state.agentWallets, false, "never read is unknown, not 'none declared'");
  assert.equal(r.complete, false, "no publication while a wallet is unknown");
  assert.equal(r.scan.walletsUnread, 1, "and health can say why");
  const healed = fakeChain({ wallets: { 1: W1, 2: W2 } });
  r = await updateIncome(healed, r.state, opts(snapOf([agent(1, W1), agent(2, W2)]), 100));
  assert.equal(r.state.agentWallets[2], W2.toLowerCase());
  assert.equal(r.complete, true, "publishes once every wallet is read");
});

await check("index: the zero address is never a declared wallet, and a failed read is not a declaration", async () => {
  const chain = fakeChain({ wallets: { 1: ethers.ZeroAddress }, failWallets: new Set([2]) });
  const got = await readAgentWallets(chain, A(8), [1, 2]);
  assert.deepEqual([got[1], got[2]], [null, undefined]);
});

await check("index: log windows are split only when refused as too wide or slow, and never past the deadline", async () => {
  let n = 0;
  const slow = { async getLogs(f) { n++; if (f.toBlock - f.fromBlock > 10) throw Object.assign(new Error("could not coalesce"), { error: { message: "log query timed out" } }); return [{ blockNumber: f.fromBlock }]; } };
  const got = await getLogsAdaptive(slow, {}, 1, 40, { minSpan: 5 });
  assert.equal(got.length, 4);
  const broken = { async getLogs() { n++; throw new Error("execution reverted"); } };
  n = 0;
  await assert.rejects(() => getLogsAdaptive(broken, {}, 1, 1000, { minSpan: 5 }), /reverted/);
  assert.equal(n, 1, "no split on other errors");
  await assert.rejects(() => getLogsAdaptive(slow, {}, 1, 40, { deadline: Date.now() - 1 }), DeadlineError);
});

await check("index: a Repaid log counts only from the pool itself", async () => {
  const repaid = new ethers.Interface(["event Repaid(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, address payer)"]);
  const log = (address) => ({ address, ...repaid.encodeEventLog("Repaid", [7, 1, 5, 0, W1]) });
  const chain = { async getTransactionReceipt(h) { return { logs: [log(h === "0xgood" ? A(0x99) : A(0x66))] }; } };
  const got = await readRepayers(chain, A(0x99), [{ loanId: 7, tx: "0xgood" }]);
  const fake = await readRepayers(chain, A(0x99), [{ loanId: 7, tx: "0xbad" }]);
  assert.deepEqual([got[7], fake[7]], [W1.toLowerCase(), null]);
});

await check("index: a repayment AutoRepay made is read from its AutoRepaid log: the address or addresses that paid, only for the pinned AutoRepay", async () => {
  const repaid = new ethers.Interface(["event Repaid(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, address payer)"]);
  const auto = new ethers.Interface(["event AutoRepaid(uint256 indexed loanId, uint256 indexed agentId, address wallet, uint256 fromWallet, uint256 fromWalletSavings, address owner, uint256 fromOwner, uint256 fromOwnerSavings)"]);
  assert.equal(auto.getEvent("AutoRepaid").topicHash, TOPICS.AUTOREPAID);
  const POOL = A(0x99), AR = A(0xa0), FAKE = A(0xa1), OWN = A(0x0a);
  const rep = (loanId) => ({ address: POOL, ...repaid.encodeEventLog("Repaid", [loanId, 1, 5, 0, AR]) });
  const ar = (address, loanId, w, ow) => ({ address, ...auto.encodeEventLog("AutoRepaid", [loanId, 1, W1, w[0], w[1], OWN, ow[0], ow[1]]) });
  const txs = {
    "0xw": [ar(AR, 7, [5, 0], [0, 0]), rep(7)], // the wallet's USDG
    "0xws": [ar(AR, 7, [0, 5], [0, 0]), rep(7)], // the wallet's savings
    "0xboth": [ar(AR, 7, [2, 1], [1, 1]), rep(7)], // the wallet, then the owner
    "0xo": [ar(AR, 7, [0, 0], [3, 2]), rep(7)], // the owner plan alone
    "0xfake": [ar(FAKE, 7, [5, 0], [0, 0]), rep(7)], // an AutoRepaid log from another contract
    "0xother": [ar(AR, 8, [5, 0], [0, 0]), rep(7)], // another loan's log
  };
  const chain = { async getTransactionReceipt(h) { return { logs: txs[h] }; } };
  const got = {};
  for (const h of Object.keys(txs)) got[h] = (await readRepayers(chain, POOL, [{ loanId: 7, tx: h }], Infinity, { autoRepay: AR }))[7];
  assert.deepEqual(got, { "0xw": lc(W1), "0xws": lc(W1), "0xboth": [lc(W1), lc(OWN)], "0xo": lc(OWN), "0xfake": null, "0xother": null });
  // without the pinned address (before it is deployed) the payer stays AutoRepay itself: never the agent's own
  assert.equal((await readRepayers(chain, POOL, [{ loanId: 7, tx: "0xw" }]))[7], lc(AR));
  assert.equal(autoRepaidPayers([ar(AR, 7, [0, 0], [0, 0])], AR, 7), null, "a log with nothing paid names no one");
  // both pinned AutoRepays (v2's autoRepay and the retired v1's autoRepayV1): each repayment read
  // from its own payer's log, never from the other's
  const V1 = A(0xa2);
  const rep1 = (loanId) => ({ address: POOL, ...repaid.encodeEventLog("Repaid", [loanId, 1, 5, 0, V1]) });
  const both = { "0xv1": [ar(V1, 7, [5, 0], [0, 0]), rep1(7)], "0xv2": [ar(AR, 7, [0, 0], [5, 0]), rep(7)], "0xmix": [ar(AR, 7, [5, 0], [0, 0]), rep1(7)] };
  const c2 = { async getTransactionReceipt(h) { return { logs: both[h] }; } };
  const two = {};
  for (const h of Object.keys(both)) two[h] = (await readRepayers(c2, POOL, [{ loanId: 7, tx: h }], Infinity, { autoRepay: [AR, V1] }))[7];
  assert.deepEqual(two, { "0xv1": lc(W1), "0xv2": lc(OWN), "0xmix": null });
});

await check("index: complete waits for the netting scan and the repayers", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }], wallets: { 1: W1 } });
  const real = Date.now;
  let clock = real();
  Date.now = () => clock;
  const t0 = chain.getBlock.bind(chain);
  chain.getBlock = async (n) => { const r = await t0(n); clock += 10_000; return r; }; // time runs out as the payments chunk ends
  try {
    const r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100, { deadline: clock + 5_000 }));
    assert.equal(r.state.paymentsTo, 100);
    assert.ok(r.state.transfersTo < 100);
    assert.equal(r.complete, false);
  } finally { Date.now = real; }
  const loan = { agentId: 1, era: "v2", id: 5, principal: 1, fee: 0, issuedAt: NOW - 1000 + 40, dueAt: NOW + DAY, closedAt: NOW - 1000 + 60, status: "repaid" };
  const r2 = await updateIncome(fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }], wallets: { 1: W1 } }), null,
    opts(snapOf([agent(1, W1)], [loan], [{ kind: "Repaid", era: "v2", loanId: 5, tx: "0xr" }]), 100, { maxRepayerReads: 0 }));
  assert.equal(r2.complete, false, "a wanted repayer not read yet");
});

await check("index: old payments leave after the retention; the size guard prunes, then refuses", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 1_000_000, block: 50 }], wallets: { 1: W1 } });
  const kept = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  assert.equal(kept.state.payments.length, 1);
  const later = await updateIncome(chain, kept.state, { ...opts(snapOf([agent(1, W1)]), 100), now: NOW + 400 * DAY });
  assert.equal(later.state.payments.length, 0, "past 365 days");
  await assert.rejects(() => updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100, { maxStateBytes: 50 })), /too large/);
});

await check("index: a new paying client every run never holds scores back; its income waits until its netting is read", async () => {
  // audit p07: a fresh payer each run used to restart the netting scan from block 1, so the index never completed
  let state = null;
  const pays = [];
  const head = (run) => 100 + run * 100;
  for (let run = 0; run < 5; run++) {
    pays.push({ payer: A(0x700 + run), payTo: W1, amount: 2_000_000, block: head(run) - 5 });
    const chain = fakeChain({ payments: pays, wallets: { 1: W1 } });
    const t0 = chain.getLogs.bind(chain);
    let fromStart = 0;
    chain.getLogs = async (f) => { if (f.topics[0] === TOPICS.TRANSFER && Array.isArray(f.topics[1]) && f.fromBlock === 1) fromStart++; return t0(f); };
    const r = await updateIncome(chain, state, opts(snapOf([agent(1, W1)]), head(run)));
    state = r.state;
    assert.equal(r.complete, true, `run ${run}: complete while the new payer's netting is read`);
    assert.equal(r.state.transfersTo, head(run), "the main netting cursor keeps up");
    if (run) assert.ok(fromStart >= 1, "only the new payer is read from the start");
    assert.deepEqual(r.pending.payers, [], "read within the run");
  }
  // when there is no time for the new payer's backfill, the index is still complete and that payer's income waits
  pays.push({ payer: A(0x7ff), payTo: W1, amount: 2_000_000, block: head(5) - 5 });
  const slow = fakeChain({ payments: pays, wallets: { 1: W1 } });
  const t1 = slow.getLogs.bind(slow);
  const real = Date.now;
  let clock = real();
  Date.now = () => clock;
  const fromW1 = (f) => Array.isArray(f.topics[1]) && f.topics[1].map((t) => t.toLowerCase()).includes(ethers.zeroPadValue(W1, 32).toLowerCase());
  slow.getLogs = async (f) => { const r = await t1(f); if (f.topics[0] === TOPICS.TRANSFER && fromW1(f) && f.fromBlock > 1) clock += 60_000; return r; }; // the main netting scan uses the time up
  try {
    const r = await updateIncome(slow, state, opts(snapOf([agent(1, W1)]), head(5), { deadline: clock + 30_000 }));
    assert.equal(r.complete, true);
    assert.deepEqual(r.pending.payers, [A(0x7ff).toLowerCase()]);
  } finally { Date.now = real; }
  const snap = world([agent(1, W1)]);
  const waiting = scoreAll(snap, { links: { clusters: [] }, income: [pay(P1, W1, 20)], agentWallets: { 1: W1 }, pending: { payers: [P1] } }).find((x) => x.agentId === 1);
  const read = scoreAll(snap, { links: { clusters: [] }, income: [pay(P1, W1, 20)], agentWallets: { 1: W1 } }).find((x) => x.agentId === 1);
  assert.equal(pts(waiting, "income"), 0);
  assert.ok(pts(read, "income") > 0);
});

await check("index: a payer under 1 USDG costs no netting scan and counts for nothing", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 900_000, block: 50 }], wallets: { 1: W1 } });
  const r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  assert.deepEqual(r.state.payers, []);
  assert.equal(chain.calls.filter((c) => c.kind === "transfer" && Array.isArray(c.t1) && c.t1.length && c.t2 && c.t2.map((t) => t.toLowerCase()).includes(ethers.zeroPadValue(P1, 32).toLowerCase()) && c.from === 1).length, 0);
  const s = scoreAll(world([agent(1, W1)]), { links: { clusters: [] }, income: [pay(P1, W1, 0.9)], agentWallets: { 1: W1 } }).find((x) => x.agentId === 1);
  assert.equal(pts(s, "income"), 0);
});

await check("index (live stall): a payment window too slow for one run gets smaller until the index moves, then grows back", async () => {
  // a node that answers wide authorization windows only after the run's time is up, as seen from the Worker
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 2_000_000, block: 500 }, { payer: P2, payTo: W1, amount: 2_000_000, block: 1500 }], wallets: { 1: W1 } });
  const inner = chain.getLogs.bind(chain);
  chain.getLogs = async (f) => { if (f.topics[0] === TOPICS.AUTH_USED && f.toBlock - f.fromBlock > 300) await new Promise((res) => setTimeout(res, 40)); return inner(f); };
  const o = (extra) => opts(snapOf([agent(1, W1)]), 2000, { paymentsChunk: 1000, minPaymentsChunk: 10, ...extra });
  let r = await updateIncome(chain, null, o({ deadline: Date.now() + 20 }));
  assert.equal(r.state.paymentsTo, 9, "the first run reads no whole window");
  assert.equal(r.scan.stopped, "deadline");
  assert.equal(r.state.paymentsChunk, 250, "so the next window is 4x smaller");
  let runs = 1;
  while (r.state.paymentsTo < 2000 && runs < 20) { r = await updateIncome(chain, r.state, o({ deadline: Date.now() + 200 })); runs++; }
  assert.equal(r.state.paymentsTo, 2000, `the index reached the head in ${runs} runs`);
  assert.deepEqual(r.state.payments.map((p) => p.block), [500, 1500]);
  assert.ok(r.state.paymentsChunk > 250, "and the window grew back once windows went through");
});

await check("index (live stall): a node rate-limiting us stops the run without splitting, and the next run resumes", async () => {
  const chain = fakeChain({ payments: [{ payer: P1, payTo: W1, amount: 2_000_000, block: 50 }], wallets: { 1: W1 } });
  const inner = chain.getLogs.bind(chain);
  let limited = true, authCalls = 0;
  chain.getLogs = async (f) => { if (f.topics[0] === TOPICS.AUTH_USED) { authCalls++; if (limited) throw Object.assign(new Error("server response 429 Too Many Requests"), { error: { code: 429 } }); } return inner(f); };
  let r = await updateIncome(chain, null, opts(snapOf([agent(1, W1)]), 100));
  assert.equal(authCalls, 1, "a rate limit is not split into more calls");
  assert.equal(r.scan.stopped, "rate-limited");
  assert.equal(r.state.paymentsTo, 9);
  assert.equal(r.complete, false);
  limited = false;
  r = await updateIncome(chain, r.state, opts(snapOf([agent(1, W1)]), 100));
  assert.equal(r.state.paymentsTo, 100);
  assert.equal(r.scan.stopped, null);
  assert.deepEqual(r.state.payments.map((p) => p.payTo), [W1.toLowerCase()]);
});

await check("agents with no known owner stand alone: one can back another", () => {
  const s = world([agent(1, undefined, { sponsor: 2 }), agent(2, undefined, { isRoot: true, enrolledAt: NOW - 400 * DAY })], [backed(901, 50, 40, 10)]);
  assert.equal(one(s, 1, { agentWallets: {} }).detail.repaidByOthers, 1);
});

await check("a payer's weight comes from the record of the agent that declared it as its payment wallet (through scoreAll)", () => {
  // agent 2 has a real record and declared WALLET; WALLET pays agent 1: it weighs more than an unknown wallet paying the same
  const X = A(0xabc);
  const rich = [0, 1, 2, 3, 4].map((k) => ({ ...backed(950 + k, 200, 90 - k * 15, 12), agentId: 2, sponsorId: 3 }));
  const agents = [agent(1, OWNER), agent(2, OTHER, { sponsor: 3 }), agent(3, X, { isRoot: true, enrolledAt: NOW - 400 * DAY })];
  const known = one(world(agents, rich), 1, { income: [pay(WALLET, OWNER, 20)], agentWallets: { 1: OWNER, 2: WALLET, 3: X } });
  const stranger = one(world(agents, rich), 1, { income: [pay(A(0xdead), OWNER, 20)], agentWallets: { 1: OWNER, 2: WALLET, 3: X } });
  assert.ok(pts(known, "income") > pts(stranger, "income"), `${pts(known, "income")} vs ${pts(stranger, "income")}`);
});

console.log(`\n${passed} passed`);
