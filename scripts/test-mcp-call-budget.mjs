#!/usr/bin/env node
// @priors/mcp: every money call answers within its time budget, and a money call made while one that ran out of time is
// still running does nothing (GHSA-rg79: pt_buy waited for its receipts past the MCP client's 60 s timeout, the model
// saw nothing, and its retry signed a second buy). Network-free: the real server and MCP client over an in-memory
// transport, a throwaway key, a mock chain that mines each transaction a fixed time after its broadcast.
//   node scripts/test-mcp-call-budget.mjs
// Then (GHSA-cq9v) the session caps once that call's hold has ended while it still runs: what it may still borrow, sign
// or save stays counted, so a call made then cannot pass PRIORS_MAX_BORROW_TOTAL_USD, PRIORS_MAX_SPEND_USD or
// PRIORS_MAX_SAVE_TOTAL_USD on a total that leaves it out.
// Then (GHSA-549m) a PT trade whose broadcast was taken by the node but whose answer was lost: what pt_buy may have
// spent stays counted against PRIORS_MAX_PT_TOTAL_USD, and the answer says a transaction may have been sent.
// PRIORS_MCP_SERVER=/path/to/server.mjs runs the same tests against another copy of the server (before/after a fix).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PT_USDG } from "../sdk/pt-usdg.mjs";
import { ORACLE_ABI, PT_ABI } from "../sdk/pendle-pt.mjs";
import { robinhood } from "../packages/x402/index.mjs";
import { POOL_ABI } from "../packages/x402/src/credit.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { createPriorsMcpServer } = await import(pathToFileURL(process.env.PRIORS_MCP_SERVER || join(ROOT, "packages/mcp/src/server.mjs")).href);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  ", name); } catch (e) { failed++; console.log("  FAIL", name, "\n       ", e?.stack?.split("\n").slice(0, 4).join("\n        ") || e); }
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const KEY = ethers.Wallet.createRandom().privateKey;

/** PT-USDG's contracts behind an ethers provider (as scripts/test-packages.mjs's PtChain), except that a transaction's
 *  receipt appears only `mineMs` after its broadcast; every broadcast is kept in `st.sent` as "approve" or "swap". */
class SlowPtChain extends ethers.JsonRpcProvider {
  constructor(st, mineMs) { super("http://127.0.0.1:1", ethers.Network.from(4663), { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 }); this.st = st; this.mineMs = mineMs; this.nonce = 0; this.minedAt = new Map(); }
  answer(method, params) {
    const st = this.st, lc = (a) => String(a).toLowerCase();
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return "0x100";
    if (method === "eth_getBlockByNumber") return { number: "0x100", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x" + st.now.toString(16), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: ethers.ZeroAddress, extraData: "0x", baseFeePerGas: "0x5f5e100", transactions: [] };
    if (method === "eth_getTransactionCount") return ethers.toBeHex(this.nonce);
    if (method === "eth_estimateGas") return "0x40000";
    if (method === "eth_gasPrice") return "0x5f5e100";
    if (method === "eth_maxPriorityFeePerGas") return "0x1";
    if (method === "eth_sendRawTransaction") {
      const tx = ethers.Transaction.from(params[0]); this.nonce++;
      st.sent.push(lc(tx.to) === lc(PT_USDG.router) ? "swap" : "approve");
      this.minedAt.set(tx.hash, Date.now() + this.mineMs);
      this.lastSend = Date.now();
      return tx.hash;
    }
    if (method === "eth_getTransactionReceipt") return !this.hidden?.has(params[0]) && Date.now() >= (this.minedAt.get(params[0]) ?? Infinity) ? { status: "0x1" } : null;
    if (method === "eth_getTransactionByHash") return this.minedAt.has(params[0]) && !this.hidden?.has(params[0]) ? { hash: params[0] } : null;
    if (method !== "eth_call") throw new Error("mock: " + method);
    const { to, data } = params[0];
    if (lc(to) === lc(PT_USDG.router)) return "0x";
    if (lc(to) === lc(PT_USDG.oracle)) return encodeFunctionResult({ abi: ORACLE_ABI, functionName: "getPtToAssetRate", result: st.rate });
    const d = decodeFunctionData({ abi: PT_ABI, data });
    if (d.functionName === "balanceOf") return encodeFunctionResult({ abi: PT_ABI, functionName: "balanceOf", result: st.usdg });
    if (d.functionName === "allowance") return encodeFunctionResult({ abi: PT_ABI, functionName: "allowance", result: 0n });
    if (d.functionName === "approve") return encodeFunctionResult({ abi: PT_ABI, functionName: "approve", result: true });
    throw new Error("mock: unexpected call");
  }
  async _send(payload) {
    return (Array.isArray(payload) ? payload : [payload]).map((p) => { try { return { id: p.id, result: this.answer(p.method, p.params) }; } catch (e) { return { id: p.id, error: { code: -32000, message: e.message } }; } });
  }
}

/** A server and a client whose requests time out after `clientTimeoutMs` (an MCP client's 60 s, scaled like the budget). */
async function connect(env, deps, clientTimeoutMs, fetchImpl) {
  const server = await createPriorsMcpServer({ env: { PRIORS_KEY: KEY, PRIORS_STATE_DIR: mkdtempSync(join(tmpdir(), "priors-mcp-budget-")), ...env }, deps, ...(fetchImpl ? { fetchImpl } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  /** { timedOut } when the client gave up, else { error, text } */
  return (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: clientTimeoutMs }).then(
    (r) => ({ timedOut: false, error: !!r.isError, text: r.content.map((c) => c.text).join("\n") }),
    (e) => { if (/timed out/i.test(String(e?.message))) return { timedOut: true, text: String(e.message) }; throw e; });
}
/** Until every transaction sent is mined and none was sent for 2 s (longer than the 1.5 s between receipt polls): what
 *  the server still runs, a trade past its budget or a queued call, has finished by then. */
async function quiet(chain) {
  while (![...chain.minedAt.values()].every((t) => t <= Date.now()) || Date.now() - (chain.lastSend ?? 0) < 2_000) await sleep(200);
}
const ptState = () => ({ now: PT_USDG.expiry - 100 * 86400, rate: 980_000_000_000_000_000n, usdg: 1_000_000_000n, sent: [] });
// Budget 2 s (the server's 45 s, scaled) under a client timeout of 2.65 s (an MCP client's 60 s); each transaction is mined
// 1 s after its broadcast and receipts are polled every 1.5 s, so a buy (an approval, then the swap) takes about 3.1 s.
const BUDGET = 2_000, CLIENT_TIMEOUT = 2_650, MINE = 1_000;

console.log("@priors/mcp money calls within their time budget (GHSA-rg79)");

await test("pt_buy outlasting its budget: the model, retrying as it would after a client timeout or a 'try again', signs one buy", async () => {
  const st = ptState(), chain = new SlowPtChain(st, MINE);
  const call = await connect({}, { provider: chain, callBudgetMs: BUDGET }, CLIENT_TIMEOUT);
  const answers = [];
  for (let i = 0; i < 3; i++) {
    const r = await call("pt_buy", { amount_usdg: 50 });
    answers.push(r);
    if (!r.timedOut && !/try again/i.test(r.text)) break; // the model retries only when it saw nothing, or was told to
  }
  await quiet(chain);
  assert.equal(st.sent.filter((s) => s === "swap").length, 1, `one authorized pt_buy signed ${st.sent.filter((s) => s === "swap").length} buys (${st.sent.join(", ")}); answers: ${answers.map((a) => (a.timedOut ? "client timeout" : a.text.slice(0, 90))).join(" | ")}`);
  assert.ok(!answers[0].timedOut, "the first call answered before the client's timeout");
  assert.ok(answers[0].error && /did not finish within 2 s and is still running/.test(answers[0].text) && /Do NOT call it again/.test(answers[0].text), answers[0].text);
});

await test("a pt_buy made while an earlier one that ran out of time is still running signs nothing, and says so", async () => {
  const st = ptState(), chain = new SlowPtChain(st, MINE);
  const call = await connect({}, { provider: chain, callBudgetMs: BUDGET }, CLIENT_TIMEOUT);
  await call("pt_buy", { amount_usdg: 50 });
  const again = await call("pt_buy", { amount_usdg: 50 }); // made at once: the first buy confirms while this one waits
  await quiet(chain);
  assert.deepEqual(st.sent, ["approve", "swap"], `one buy only: ${st.sent.join(", ")}`);
  assert.ok(!again.timedOut && again.error && /Nothing was done by this call/.test(again.text), again.text);
  const later = await call("pt_buy", { amount_usdg: 1 }); // once it is over, a new call is a new purchase, as before
  assert.ok(!later.timedOut && !/Nothing was done by this call/.test(later.text), later.text);
});

await test("borrow too: a borrow outlasting its budget answers in time; one made meanwhile borrows nothing, even once the first lands", async () => {
  const rec = [];
  let land;
  const landed = new Promise((ok) => { land = ok; });
  const now = Math.floor(Date.now() / 1000);
  const credit = {
    isController: async () => true,
    quote: async (id, amount, term) => ({ amount, term, fee: 50_000n, due: amount + 50_000n }),
    borrow: async (id, amount, term) => { rec.push(amount); if (rec.length === 1) await landed; return { hash: "0x" + "11".repeat(32), loanId: 41n + BigInt(rec.length), principal: amount, fee: 50_000n, dueAt: now + Number(term) }; },
  };
  const call = await connect({ PRIORS_AGENT_ID: "7" }, { credit, callBudgetMs: 1_000 }, 1_500);
  const first = await call("borrow", { amount_usd: 5, days: 7 });
  assert.ok(!first.timedOut && first.error && /did not finish within 1 s/.test(first.text) && /Do NOT call it again/.test(first.text), first.text);
  const again = call("borrow", { amount_usd: 5, days: 7 });
  await sleep(200);
  land(); // the first borrow confirms while the second waits for it
  const r = await again;
  assert.ok(!r.timedOut && r.error && /Nothing was done by this call/.test(r.text), r.text);
  assert.equal(rec.length, 1, "one borrow sent");
  const later = await call("borrow", { amount_usd: 5, days: 7 });
  assert.ok(!later.error && /Borrowed 5\.00 USDG/.test(later.text), later.text);
});

// ---- GHSA-cq9v: the hold above ends after HOLD_MAX_MS (scaled to HOLD here) whatever the first call does; a call made
// then runs beside it, and its cap check must count what the first may still borrow, sign or save.
const HOLD = 500;
const until = async (ok, ms = 3_000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await sleep(20); };
/** A credit facade whose first `kind` call ("borrow" or "save") waits until `land()`, as one in tx.wait() on a stalled
 *  node does (no timeout, no signal); every call is kept in `rec`. `at: "quote"` stalls the first quote instead (a read
 *  before anything is sent); `refuse` makes the first one refused before sending. */
function stalling(kind, { refuse = false, at = kind } = {}) {
  const rec = [];
  let land, quotes = 0;
  const landed = new Promise((ok) => { land = ok; });
  const now = Math.floor(Date.now() / 1000);
  const credit = {
    isController: async () => true,
    quote: async (id, amount, term) => { if (at === "quote" && ++quotes === 1) await landed; return { amount, term, fee: 50_000n, due: amount + 50_000n }; },
    savingsOf: async () => ({ saved: 0n, wallet: 0n }),
    [kind]: async (...a) => {
      const amount = kind === "borrow" ? a[1] : a[0];
      rec.push(amount);
      if (rec.length === 1 && refuse) throw Object.assign(new Error("execution reverted: InsufficientCapacity()"), { code: "CALL_EXCEPTION" });
      if (rec.length === 1 && at === kind) await landed;
      return kind === "borrow" ? { hash: "0x" + "11".repeat(32), loanId: 40n + BigInt(rec.length), principal: amount, fee: 50_000n, dueAt: now + Number(a[2]) } : { hash: "0x" + "22".repeat(32), amount };
    },
  };
  return { credit, rec, land: () => land() };
}

await test("GHSA-cq9v: a borrow still running once its hold has ended keeps its amount counted: the next borrow is refused by PRIORS_MAX_BORROW_TOTAL_USD; once it lands, what it borrowed counts, once", async () => {
  const s = stalling("borrow");
  const call = await connect({ PRIORS_AGENT_ID: "7", PRIORS_MAX_BORROW_USD: "25", PRIORS_MAX_BORROW_TOTAL_USD: "30" }, { credit: s.credit, callBudgetMs: 1_000, holdMaxMs: HOLD }, 1_500);
  const first = await call("borrow", { amount_usd: 25, days: 7 });
  assert.ok(!first.timedOut && /did not finish within 1 s and is still running/.test(first.text), first.text);
  await sleep(HOLD + 300); // the hold has ended; the first borrow still waits for its receipt
  const second = await call("borrow", { amount_usd: 25, days: 7 });
  assert.equal(s.rec.length, 1, `one borrow sent while the first runs (session cap 30): ${s.rec.length}; the second answered: ${second.text.slice(0, 120)}`);
  assert.ok(second.error && /50\.00 USDG, above 30\.00 USDG \(PRIORS_MAX_BORROW_TOTAL_USD\)/.test(second.text), second.text);
  s.land();
  await sleep(100);
  const rest = await call("borrow", { amount_usd: 5, days: 7 });
  assert.ok(!rest.error && /Borrowed 5\.00 USDG/.test(rest.text), `once the first has landed, its 25 counts once (25 + 5 = 30): ${rest.text}`);
  const over = await call("borrow", { amount_usd: 1, days: 7 });
  assert.ok(over.error && /PRIORS_MAX_BORROW_TOTAL_USD/.test(over.text), over.text);
});

await test("GHSA-cq9v: counted from its check, not from its send: a borrow still reading its quote once its hold has ended counts too", async () => {
  const s = stalling("borrow", { at: "quote" });
  const call = await connect({ PRIORS_AGENT_ID: "7", PRIORS_MAX_BORROW_USD: "25", PRIORS_MAX_BORROW_TOTAL_USD: "25" }, { credit: s.credit, callBudgetMs: 1_000, holdMaxMs: HOLD }, 1_500);
  const first = await call("borrow", { amount_usd: 25, days: 7 });
  assert.ok(!first.timedOut && /did not finish within 1 s and is still running/.test(first.text), first.text);
  await sleep(HOLD + 300);
  const second = await call("borrow", { amount_usd: 25, days: 7 });
  s.land(); // the first one's quote answers: it goes on and borrows, as the user asked
  await until(() => s.rec.length > 0);
  await sleep(100);
  assert.equal(s.rec.length, 1, `one borrow in all (session cap 25): ${s.rec.length}; the second answered: ${second.text.slice(0, 120)}`);
  assert.ok(second.error && /PRIORS_MAX_BORROW_TOTAL_USD/.test(second.text), second.text);
});

await test("GHSA-cq9v: a borrow refused before it was sent counts nothing: the whole session cap is still there", async () => {
  const s = stalling("borrow", { refuse: true });
  const call = await connect({ PRIORS_AGENT_ID: "7", PRIORS_MAX_BORROW_USD: "25", PRIORS_MAX_BORROW_TOTAL_USD: "25" }, { credit: s.credit }, 5_000);
  const refused = await call("borrow", { amount_usd: 25, days: 7 });
  assert.ok(refused.error && /InsufficientCapacity/.test(refused.text), refused.text);
  const again = await call("borrow", { amount_usd: 25, days: 7 });
  assert.ok(!again.error && /Borrowed 25\.00 USDG/.test(again.text), again.text);
});

/** CreditPoolV2 and USDG behind an ethers provider, for pay_url's own borrow (the payer's borrowGap): the wallet holds
 *  `st.balance` USDG, every transaction sent is kept in `st.loans`, and the receipt of the first is answered only once
 *  `st.land()` is called, as a stalled node would (the borrow's tx.wait() has no timeout and no signal). */
const POOL_I = new ethers.Interface(POOL_ABI);
class StallingPool extends ethers.JsonRpcProvider {
  constructor(st) { super("http://127.0.0.1:1", ethers.Network.from(4663), { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 }); this.st = st; st.loans = []; const landed = new Promise((ok) => { st.land = ok; }); this.landed = landed; }
  async answer(method, params) {
    const st = this.st, H = (n, w) => ethers.toBeHex(n, w);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return "0x100";
    if (method === "eth_getBlockByNumber") return { number: "0x100", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: H(Math.floor(Date.now() / 1000)), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: ethers.ZeroAddress, extraData: "0x", baseFeePerGas: "0x5f5e100", transactions: [] };
    if (method === "eth_getTransactionCount") return H(st.loans.length);
    if (method === "eth_estimateGas") return "0x40000";
    if (method === "eth_gasPrice") return "0x5f5e100";
    if (method === "eth_maxPriorityFeePerGas") return "0x1";
    if (method === "eth_sendRawTransaction") { const tx = ethers.Transaction.from(params[0]); st.loans.push({ hash: tx.hash, from: tx.from, to: tx.to }); return tx.hash; }
    if (method === "eth_getTransactionReceipt") {
      const i = st.loans.findIndex((l) => l.hash === params[0]);
      if (i < 0) return null;
      if (i === 0) await this.landed;
      const l = st.loans[i];
      return { transactionHash: l.hash, blockHash: "0x" + "ab".repeat(32), blockNumber: "0x100", transactionIndex: "0x0", from: l.from, to: l.to, contractAddress: null, cumulativeGasUsed: "0x30000", gasUsed: "0x30000", effectiveGasPrice: "0x5f5e100", status: "0x1", type: "0x2", logsBloom: "0x" + "00".repeat(256), logs: [] };
    }
    if (method !== "eth_call") throw new Error("mock: " + method);
    const data = params[0].data || params[0].input;
    if (data.startsWith("0x70a08231")) return H(st.balance, 32); // USDG balanceOf
    const f = POOL_I.parseTransaction({ data });
    if (f.name === "usdg") return POOL_I.encodeFunctionResult("usdg", [robinhood.usdg]);
    if (f.name === "getParams") return POOL_I.encodeFunctionResult("getParams", [[100_000n, 50_000_000n, 86400n, 30n * 86400n, 3n * 86400n, 7n * 86400n, 100n, 0n, 0n, 0n, 9000n, 0n]]);
    if (f.name === "quoteFee") return POOL_I.encodeFunctionResult("quoteFee", [1_000n, 0n, 0n, 0n]);
    if (f.name === "borrow") return POOL_I.encodeFunctionResult("borrow", [BigInt(st.loans.length + 1)]);
    // the borrow's V5 step (the package names SeatVaultV5 since 0.8.4) asks the agent's sponsor first: a line from
    // another root (the treasury's), so V5 has nothing to do
    if (f.name === "getAgent") {
      const agent = POOL_I.getFunction("getAgent").outputs[0].components.map((c) => (c.type === "bool" ? c.name === "enrolled" : c.name === "sponsor" ? 6228n : 0n));
      return POOL_I.encodeFunctionResult("getAgent", [agent]);
    }
    throw new Error("mock: unexpected call " + f.name);
  }
  async _send(payload) {
    return Promise.all((Array.isArray(payload) ? payload : [payload]).map(async (p) => { try { return { id: p.id, result: await this.answer(p.method, p.params) }; } catch (e) { return { id: p.id, error: { code: -32000, message: e.message } }; } }));
  }
}
/** A legacy x402 v1 merchant at https://merchant.example/<path>, as a fetch function: a 402 at `prices[path]` (atomic
 *  USDG), then 200 for a payment. A payment sent is kept in `sent`, one answered in `paid`; an aborted request fails,
 *  as a real fetch would. */
function merchant(prices) {
  const m = { sent: [], paid: [] };
  m.fetchImpl = async (input, init) => {
    const r = input instanceof Request ? input : new Request(input, init);
    const path = new URL(r.url).pathname;
    const req = { scheme: "exact", network: "robinhood", maxAmountRequired: String(prices[path]), payTo: "0x000000000000000000000000000000000000dEaD", asset: robinhood.usdg, maxTimeoutSeconds: 3600, resource: r.url };
    if (!r.headers.get("X-PAYMENT")) return new Response(JSON.stringify({ x402Version: 1, accepts: [req] }), { status: 402, headers: { "content-type": "application/json" } });
    m.sent.push(path);
    if (r.signal?.aborted) throw r.signal.reason;
    m.paid.push(path);
    return new Response("{\"ok\":true}", { status: 200 });
  };
  return m;
}
const payUrlServer = (st, m, env) => connect({ PRIORS_AGENT_ID: "7", PRIORS_SAVINGS_VAULT: "off", PRIORS_AUTOPAY_RESERVE: "off", ...env },
  { provider: new StallingPool(st), credit: { isController: async () => true }, autopay: null, lookup: async () => [{ address: "93.184.216.34", family: 4 }], callBudgetMs: 1_000, holdMaxMs: HOLD }, 1_500, m.fetchImpl);

await test("GHSA-cq9v: pay_url too: one whose borrow still waits for its receipt once its hold has ended keeps max_borrow_usd counted, so the same purchase again does not borrow past PRIORS_MAX_BORROW_TOTAL_USD", async () => {
  const st = { balance: 400_000n }, m = merchant({ "/a": 1_000_000n });
  const call = await payUrlServer(st, m, { PRIORS_MAX_SPEND_USD: "10", PRIORS_MAX_BORROW_TOTAL_USD: "1" });
  const buy = { url: "https://merchant.example/a", max_price_usd: 1, max_borrow_usd: 1 };
  const first = await call("pay_url", buy);
  assert.ok(!first.timedOut && /did not finish within 1 s and is still running/.test(first.text), first.text);
  assert.equal(st.loans.length, 1, "the first pay_url sent its borrow");
  await sleep(HOLD + 300);
  const again = await call("pay_url", buy);
  st.land();
  assert.equal(st.loans.length, 1, `one loan (session cap 1.00): ${st.loans.length} sent; the second answered: ${again.text.slice(0, 120)}`);
  assert.ok(again.error && /PRIORS_MAX_BORROW_TOTAL_USD/.test(again.text), again.text);
});

await test("GHSA-cq9v: pay_url too: one still borrowing once its hold has ended keeps max_price_usd counted, so another purchase is not signed past PRIORS_MAX_SPEND_USD; once it ends, what it signed counts, once", async () => {
  const st = { balance: 400_000n }, m = merchant({ "/a": 1_000_000n, "/b": 400_000n, "/c": 200_000n });
  const call = await payUrlServer(st, m, { PRIORS_MAX_SPEND_USD: "1.2", PRIORS_MAX_BORROW_TOTAL_USD: "25" });
  const first = await call("pay_url", { url: "https://merchant.example/a", max_price_usd: 1, max_borrow_usd: 1 }); // short by 0.60: borrows
  assert.ok(!first.timedOut && /did not finish within 1 s and is still running/.test(first.text), first.text);
  await sleep(HOLD + 300);
  const other = await call("pay_url", { url: "https://merchant.example/b", max_price_usd: 0.4 }); // the wallet's 0.40: no borrow
  assert.deepEqual(m.sent, [], `nothing signed and sent while the first may still sign 1.00 of a 1.20 cap; the second answered: ${other.text.slice(0, 120)}`);
  assert.ok(other.error && /PRIORS_MAX_SPEND_USD/.test(other.text), other.text);
  st.land();
  await until(() => m.sent.includes("/a")); // it signs once its borrow lands (sent after its deadline: refused as aborted)
  await sleep(100);
  const rest = await call("pay_url", { url: "https://merchant.example/c", max_price_usd: 0.2 });
  assert.ok(!rest.error && /Paid 0\.20 USDG/.test(rest.text), `once the first has ended, its 1.00 counts once (1.00 + 0.20 = 1.20): ${rest.text.slice(0, 160)}`);
});

await test("GHSA-cq9v: save too: a save still running once its hold has ended keeps its amount counted against PRIORS_MAX_SAVE_TOTAL_USD", async () => {
  const s = stalling("save");
  const call = await connect({ PRIORS_MAX_SAVE_USD: "50", PRIORS_MAX_SAVE_TOTAL_USD: "60" }, { credit: s.credit, callBudgetMs: 1_000, holdMaxMs: HOLD }, 1_500);
  const first = await call("save", { amount_usd: 50 });
  assert.ok(!first.timedOut && /did not finish within 1 s and is still running/.test(first.text), first.text);
  await sleep(HOLD + 300);
  const second = await call("save", { amount_usd: 50 });
  assert.equal(s.rec.length, 1, `one save sent while the first runs (session cap 60): ${s.rec.length}; the second answered: ${second.text.slice(0, 120)}`);
  assert.ok(second.error && /PRIORS_MAX_SAVE_TOTAL_USD/.test(second.text), second.text);
  s.land();
  await sleep(100);
  const rest = await call("save", { amount_usd: 10 });
  assert.ok(!rest.error && /Saved 10\.00 USDG/.test(rest.text), `once the first has landed, its 50 counts once (50 + 10 = 60): ${rest.text}`);
});

// ---- GHSA-549m: a broadcast the node took whose answer was lost may have landed. pt_buy recorded a send only once its
// answer came back, so such a buy was given back as "nothing sent": the USDG left, the session total did not count it,
// and the answer was the bare transport error.
/** As SlowPtChain, mined at once, but the chain keeps the router's allowance (`st.allowance`, for whichever token) and what
 *  the swaps took from the wallet (`st.out`). A broadcast whose kind ("approve" or "swap") is in `st.drop` is taken and
 *  mined, then its answer is lost; unless `st.showDropped`, the node asked afterwards does not show it either (another
 *  node took it), so its outcome is not known. `st.refuse` refuses the next transaction before it is sent: "estimate"
 *  (its estimate reverts) or "gas" (the node refuses the broadcast: no ETH for gas). */
const PT_UNITS = 50_000_000n;
class LossyPtChain extends SlowPtChain {
  constructor(st) { super(st, 0); st.allowance ??= 0n; st.out = 0n; st.drop ??= []; this.hidden = new Set(); }
  answer(method, params) {
    const st = this.st;
    if (method === "eth_estimateGas" && st.refuse === "estimate") { st.refuse = null; throw new Error("execution reverted"); }
    if (method === "eth_sendRawTransaction" && st.refuse === "gas") { st.refuse = null; throw new Error("insufficient funds for gas * price + value"); }
    if (method === "eth_call" && String(params[0].data).startsWith("0xdd62ed3e")) return encodeFunctionResult({ abi: PT_ABI, functionName: "allowance", result: st.allowance });
    const r = super.answer(method, params);
    if (method === "eth_sendRawTransaction") {
      const tx = ethers.Transaction.from(params[0]);
      this.lastHash = tx.hash;
      if (st.sent.at(-1) === "approve") st.allowance = decodeFunctionData({ abi: PT_ABI, data: tx.data }).args[1];
      else { st.allowance -= PT_UNITS; st.out += PT_UNITS; } // each swap here takes 50
    }
    return r;
  }
  async _send(payload) {
    const out = await super._send(payload);
    [payload].flat().forEach((p, i) => {
      const k = p.method === "eth_sendRawTransaction" && !out[i].error ? this.st.drop.indexOf(this.st.sent.at(-1)) : -1;
      if (k >= 0) { this.st.drop.splice(k, 1); if (!this.st.showDropped) this.hidden.add(this.lastHash); throw new Error("fetch failed: socket hang up (the node took the transaction; its answer was lost)"); }
    });
    return out;
  }
}
const ptCapped = (st) => connect({ PRIORS_MAX_PT_USD: "50", PRIORS_MAX_PT_TOTAL_USD: "50" }, { provider: new LossyPtChain(st) }, 5_000);

await test("GHSA-549m: a pt_buy whose swap was taken but whose answer was lost (the allowance already live) stays counted, says it may have been sent, and the next buy is refused by PRIORS_MAX_PT_TOTAL_USD", async () => {
  const st = { ...ptState(), allowance: PT_UNITS, drop: ["swap"] }, call = await ptCapped(st);
  const first = await call("pt_buy", { amount_usdg: 50 });
  assert.ok(first.error && /may have been sent: its answer was lost/.test(first.text) && /Check pt_position and wallet_balance before trying again/.test(first.text), first.text);
  const second = await call("pt_buy", { amount_usdg: 50 });
  assert.equal(st.out, PT_UNITS, `USDG that left the wallet (session cap 50.00): ${Number(st.out) / 1e6}; the second answered: ${second.text.slice(0, 120)}`);
  assert.ok(second.error && /100\.00 USDG, above 50\.00 USDG \(PRIORS_MAX_PT_TOTAL_USD\)/.test(second.text), second.text);
});

await test("GHSA-549m: one whose approval was taken but whose answer was lost stays counted too: no swap follows it past the cap", async () => {
  const st = { ...ptState(), drop: ["approve", "swap"] }, call = await ptCapped(st);
  const first = await call("pt_buy", { amount_usdg: 50 });
  assert.ok(first.error && /may have been sent: its answer was lost/.test(first.text), first.text);
  const second = await call("pt_buy", { amount_usdg: 50 }); // the allowance is live now: this one would send only the swap
  const third = await call("pt_buy", { amount_usdg: 50 });
  assert.deepEqual(st.sent, ["approve"], `one approval and no swap (session cap 50.00): ${st.sent.join(", ")}; the second answered: ${second.text.slice(0, 120)}`);
  assert.ok(second.error && /PRIORS_MAX_PT_TOTAL_USD/.test(second.text) && third.error && /PRIORS_MAX_PT_TOTAL_USD/.test(third.text), `${second.text} | ${third.text}`);
});

await test("GHSA-549m: a buy refused before anything was sent (its estimate reverts; the node refuses it for gas) counts nothing: the whole cap is still there", async () => {
  const st = { ...ptState(), allowance: PT_UNITS }, call = await ptCapped(st);
  st.refuse = "estimate";
  const a = await call("pt_buy", { amount_usdg: 50 });
  assert.ok(a.error && !/may have been sent/.test(a.text), a.text);
  st.refuse = "gas";
  const b = await call("pt_buy", { amount_usdg: 50 });
  assert.ok(b.error && /insufficient funds/i.test(b.text) && !/may have been sent/.test(b.text), b.text);
  const c = await call("pt_buy", { amount_usdg: 50 });
  assert.ok(!c.error && /Bought about/.test(c.text), c.text);
  assert.equal(st.out, PT_UNITS);
});

await test("a lost answer whose transaction the node shows mined: the buy is done and said so, counted once, and nothing is sent twice", async () => {
  const st = { ...ptState(), allowance: PT_UNITS, drop: ["swap"], showDropped: true }, call = await ptCapped(st);
  const first = await call("pt_buy", { amount_usdg: 50 });
  assert.ok(!first.error && /Bought about/.test(first.text), first.text);
  assert.deepEqual(st.sent, ["swap"]); assert.equal(st.out, PT_UNITS);
});

await test("GHSA-549m: pt_sell (pt_redeem shares the path) whose transaction was taken but whose answer was lost says it may have been sent, not the bare error", async () => {
  const st = { ...ptState(), allowance: PT_UNITS, drop: ["swap"] }, call = await ptCapped(st);
  const r = await call("pt_sell", { amount_pt: 50 });
  assert.deepEqual(st.sent, ["swap"]);
  assert.ok(r.error && /may have been sent: its answer was lost/.test(r.text) && /Check pt_position and wallet_balance before trying again/.test(r.text), r.text);
});

console.log(`\nmcp call budget: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
