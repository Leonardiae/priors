#!/usr/bin/env node
// x402 on Base, phase 1 (docs/X402-BASE-PLAN.md): @priors/x402's network allowlist (networks.mjs), the Base path of
// createPayer (paid from the Base float, BASE_FLOAT_SHORT before any signature), bridge.mjs (the Across quote checks and
// deposit, the Relay return's typed-data checks), and @priors/mcp's fund_base, return_to_robinhood and the Base side of
// pay_url, wallet_balance and credit_status, with the default (Base off) unchanged.
//   node scripts/test-x402-base.mjs            offline: mock chains, mock Across and Relay APIs, throwaway keys
//   node scripts/test-x402-base.mjs --fork     also the fork tests, each only when its RPC is set:
//     BASE_RPC_URL  anvil forks Base: a mock seller's USDC 402, paid by createPayer, is settled on the fork with USDC's
//                   transferWithAuthorization; USDC's name and version read on chain
//     RPC_URL       anvil forks Robinhood Chain: fundBase sends an exact approval and a depositV3 to the real Across
//                   spoke (the quote read from app.across.to, read-only), and the FundsDeposited fields are checked
// scripts/test-packages.mjs runs these cases too (runX402BaseTests), forks included when the env is set. Nothing here
// signs with a real key or sends anything outside the local anvil.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as X from "../packages/x402/index.mjs";
import * as B from "../packages/x402/src/bridge.mjs";
import { POOL_ABI, borrowGap as realBorrowGap } from "../packages/x402/src/credit.mjs";
import { createPriorsMcpServer } from "../packages/mcp/src/server.mjs";

const NOW = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const USDG = X.ROBINHOOD_USDG.asset;
const USDC = X.BASE_USDC.asset;
const SPOKE = X.ACROSS.spokes[4663];
const DEST_SPOKE = X.ACROSS.spokes[8453];
/** The two lookalike "USDG" tokens on Robinhood Chain (same prefix and suffix as USDG; read on chain 2026-10-08). */
const LOOKALIKES = ["0x5fc591225f1f20C08C3c59Fe25826F6a36e1d168", "0x5fc54b6CbC5ccD9B112ddfF3326Caeeaba33d168"];
/** A USDC lookalike for Base (one digit changed). */
const FAKE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02914";
const MERCHANT = "0x000000000000000000000000000000000000dEaD";
const RELAYER = "0xFD03AbCAdaF3F930fA4E37Eb2f6ea3A44a41b7F0";
const TX = (b) => "0x" + b.repeat(32);
const DOMAIN_USDG = { name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: USDG };
const DOMAIN_USDC = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC };
const TWA = { TransferWithAuthorization: X.TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization.map((f) => ({ ...f })) };
const BOTH = ["eip155:4663", "eip155:8453"];
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? String(v) : v)), { status, headers: { "content-type": "application/json", ...headers } });
const lc = (a) => String(a).toLowerCase();
const same = (a, b) => lc(a) === lc(b);

// ---- mocks ------------------------------------------------------------------------------------------------------

const ERC20_IFACE = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function authorizationState(address,bytes32) view returns (bool)", "function usdg() view returns (address)", "event Approval(address indexed owner, address indexed spender, uint256 value)"]);
const SPOKE_IFACE = new ethers.Interface(B.ACROSS_SPOKE_ABI);
const b32 = (a) => ethers.zeroPadValue(a, 32);

/**
 * A chain behind an ethers provider, no network: ERC-20 balances and allowances (`st.balances` by "token:holder"),
 * approve, and the Across spoke's depositV3 (it pulls the input token and emits FundsDeposited). Every broadcast is kept
 * in `st.sent` ({ kind: "approve" | "deposit", args, hash }) and its kind in `st.log`. `st.loseReceipt` makes every
 * receipt read fail (a lost answer); `st.depositReverts` makes the deposit's simulation revert.
 */
class ChainMock extends ethers.JsonRpcProvider {
  constructor(chainId, st = {}) {
    super("http://127.0.0.1:1", ethers.Network.from(chainId), { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1, pollingInterval: 20 });
    this.chainId = chainId;
    this.st = { balances: {}, allowances: {}, sent: [], log: [], receipts: new Map(), nonce: 0, deposits: 0, reads: 0, ...st };
  }
  bal(token, who) { return this.st.balances[`${lc(token)}:${lc(who)}`] ?? 0n; }
  setBal(token, who, v) { this.st.balances[`${lc(token)}:${lc(who)}`] = BigInt(v); }
  allowed(token, owner, spender) { return this.st.allowances[`${lc(token)}:${lc(owner)}:${lc(spender)}`] ?? 0n; }
  setAllowed(token, owner, spender, v) { this.st.allowances[`${lc(token)}:${lc(owner)}:${lc(spender)}`] = BigInt(v); }
  answer(method, params) {
    if (method === "eth_chainId") return ethers.toBeHex(this.chainId);
    if (method === "eth_blockNumber") return "0x100";
    if (method === "eth_getBlockByNumber") return { number: "0x100", hash: TX("ab"), parentHash: TX("cd"), timestamp: ethers.toBeHex(NOW()), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: ethers.ZeroAddress, extraData: "0x", baseFeePerGas: "0x5f5e100", transactions: [] };
    if (method === "eth_getTransactionCount") return ethers.toBeHex(this.st.nonce);
    if (method === "eth_estimateGas") return "0x40000";
    if (method === "eth_gasPrice") return "0x5f5e100";
    if (method === "eth_maxPriorityFeePerGas") return "0x1";
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_getTransactionReceipt") { if (this.st.loseReceipt) throw new Error("mock: the receipt read failed"); return this.st.receipts.get(params[0]) ?? null; }
    if (method === "eth_sendRawTransaction") return this.broadcast(params[0]);
    if (method !== "eth_call") throw new Error("mock: " + method);
    const { to, data, from } = params[0];
    this.st.reads++;
    if (same(to, SPOKE)) {
      if (this.st.depositReverts) { const e = new Error("execution reverted"); e.data = SPOKE_IFACE.encodeErrorResult("InvalidFillDeadline", []); throw e; }
      SPOKE_IFACE.parseTransaction({ data }); // a depositV3, or the test fails here
      return "0x";
    }
    const f = ERC20_IFACE.parseTransaction({ data });
    if (f.name === "balanceOf") return ERC20_IFACE.encodeFunctionResult("balanceOf", [this.bal(to, f.args[0])]);
    if (f.name === "allowance") return ERC20_IFACE.encodeFunctionResult("allowance", [this.allowed(to, f.args[0], f.args[1])]);
    if (f.name === "approve") return ERC20_IFACE.encodeFunctionResult("approve", [true]);
    if (f.name === "authorizationState") return ERC20_IFACE.encodeFunctionResult("authorizationState", [Boolean(this.st.used?.has(lc(f.args[1])))]);
    if (f.name === "usdg") return ERC20_IFACE.encodeFunctionResult("usdg", [USDG]); // the pool's (pay_url with max_borrow_usd reads it)
    throw new Error("mock: unexpected call from " + from);
  }
  broadcast(raw) {
    const tx = ethers.Transaction.from(raw);
    this.st.nonce++;
    const logs = [];
    let entry;
    if (same(tx.to, SPOKE)) {
      const d = SPOKE_IFACE.parseTransaction({ data: tx.data });
      const a = d.args;
      this.setBal(a.inputToken, tx.from, this.bal(a.inputToken, tx.from) - BigInt(a.inputAmount));
      this.setAllowed(a.inputToken, tx.from, SPOKE, this.allowed(a.inputToken, tx.from, SPOKE) - BigInt(a.inputAmount));
      const ev = SPOKE_IFACE.encodeEventLog("FundsDeposited", [b32(a.inputToken), b32(a.outputToken), a.inputAmount, a.outputAmount, a.destinationChainId, BigInt(438_520 + this.st.deposits++), a.quoteTimestamp, a.fillDeadline, a.exclusivityParameter, b32(a.depositor), b32(a.recipient), b32(a.exclusiveRelayer), a.message]);
      logs.push({ ...ev, address: SPOKE });
      entry = { kind: "deposit", args: a };
    } else {
      const d = ERC20_IFACE.parseTransaction({ data: tx.data });
      if (d.name !== "approve") throw new Error("mock: unexpected transaction");
      this.setAllowed(tx.to, tx.from, d.args[0], d.args[1]);
      logs.push({ ...ERC20_IFACE.encodeEventLog("Approval", [tx.from, d.args[0], d.args[1]]), address: tx.to });
      entry = { kind: "approve", args: d.args, token: tx.to };
    }
    this.st.sent.push({ ...entry, hash: tx.hash });
    this.st.log.push(entry.kind);
    if (this.st.dropSend && entry.kind === "deposit") throw new Error("mock: the connection was reset");
    this.st.receipts.set(tx.hash, {
      transactionHash: tx.hash, transactionIndex: "0x0", blockHash: TX("ab"), blockNumber: "0x100", from: tx.from, to: tx.to,
      cumulativeGasUsed: "0x5208", gasUsed: "0x5208", contractAddress: null, logsBloom: "0x" + "00".repeat(256), status: "0x1", effectiveGasPrice: "0x5f5e100", type: "0x2",
      logs: logs.map((l, i) => ({ ...l, logIndex: ethers.toBeHex(i), transactionIndex: "0x0", transactionHash: tx.hash, blockHash: TX("ab"), blockNumber: "0x100", removed: false })),
    });
    return tx.hash;
  }
  async _send(payload) {
    return (Array.isArray(payload) ? payload : [payload]).map((p) => { try { return { id: p.id, result: this.answer(p.method, p.params) }; } catch (e) { return { id: p.id, error: { code: -32000, message: e.message, ...(e.data ? { data: e.data } : {}) } }; } });
  }
}

/** A Wallet that counts its signatures and keeps what it was asked to sign. */
class CountingWallet extends ethers.Wallet {
  constructor(key, provider) { super(key, provider); this.signs = 0; this.signed = []; }
  async signTypedData(d, t, v) { this.signs++; this.signed.push({ domain: d, types: t, value: v }); return super.signTypedData(d, t, v); }
}

/** An x402 v2 merchant as a fetch function, one requirement per network it names (`accepts`), each checked as a real
 *  resource server would: the signature on that network's token domain, the amount. Records every payment. */
function merchant({ accepts = ["base"], amount = "10000", pending = false, maxTimeoutSeconds = 60 } = {}) {
  const reqOf = (k) => (k === "base" ? { scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo: MERCHANT, maxTimeoutSeconds, extra: { name: "USD Coin", version: "2" } }
    : k === "robinhood" ? { scheme: "exact", network: "eip155:4663", asset: USDG, amount, payTo: MERCHANT, maxTimeoutSeconds, extra: { name: "Global Dollar", version: "1" } } : k);
  const pr = { x402Version: 2, resource: { url: "https://merchant.example/data", description: "data", mimeType: "application/json" }, accepts: accepts.map(reqOf) };
  const m = { pr, payloads: [], headers: [], requests: 0 };
  m.fetchImpl = async (input, init) => {
    const r = input instanceof Request ? input : new Request(input, init);
    m.requests++;
    const sig = r.headers.get("PAYMENT-SIGNATURE");
    if (!sig) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr), "content-type": "application/json" } });
    m.headers.push(sig);
    const p = decodePaymentSignatureHeader(sig);
    m.payloads.push(p);
    const a = p.payload.authorization;
    const dom = p.accepted.network === "eip155:8453" ? DOMAIN_USDC : DOMAIN_USDG;
    if (ethers.verifyTypedData(dom, TWA, a, p.payload.signature) !== ethers.getAddress(a.from)) return new Response("{\"bad\":\"signature\"}", { status: 402 });
    const settle = pending ? { success: false, errorReason: "settlement_pending", transaction: TX("ab"), network: p.accepted.network, payer: a.from } : { success: true, transaction: TX("cd"), network: p.accepted.network, payer: a.from };
    return new Response(pending ? "{}" : JSON.stringify({ data: 42 }), { status: pending ? 402 : 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle), "content-type": "application/json" } });
  };
  return m;
}

/** A live-shaped Across suggested-fees answer for `amount` (fee about 0.0035 + 0.06%), at `now`; `mutate` changes it. */
function acrossQuoteBody(amount, now = NOW(), mutate = (q) => q) {
  const fee = 3_500n + (BigInt(amount) * 6n) / 10_000n;
  return mutate({
    estimatedFillTimeSec: 2, totalRelayFee: { pct: "1278200000000000", total: String(fee) }, timestamp: String(now - 20), isAmountTooLow: false, quoteBlock: "26150180",
    exclusiveRelayer: RELAYER, exclusivityDeadline: 3, spokePoolAddress: SPOKE, destinationSpokePoolAddress: DEST_SPOKE,
    limits: { minDeposit: "500194", maxDeposit: "972502725625", maxDepositInstant: "332767589551", maxDepositShortDelay: "972502725625", recommendedDepositInstant: "332767589551" },
    fillDeadline: String(now - 20 + 7200), outputAmount: String(BigInt(amount) - fee),
    inputToken: { address: USDG, symbol: "USDG", decimals: 6, chainId: 4663 }, outputToken: { address: USDC, symbol: "USDC", decimals: 6, chainId: 8453 },
    id: "xpvh6-test",
  });
}
/** Across's API as a fetch: suggested-fees from acrossQuoteBody, deposit/status from `status` (a value, 404, or a
 *  function of the poll count). Every URL is kept. */
function acrossApi({ mutate, status = "filled", now } = {}) {
  const api = { urls: [], statuses: 0 };
  api.fetchImpl = async (input) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    api.urls.push(u);
    if (u.pathname === "/api/suggested-fees") return json(acrossQuoteBody(BigInt(u.searchParams.get("amount")), now ?? NOW(), mutate));
    if (u.pathname === "/api/deposit/status") {
      const s = typeof status === "function" ? status(++api.statuses) : (api.statuses++, status);
      if (s === 404) return json({ error: "DepositNotFoundException" }, 404);
      return json({ status: s, originChainId: 4663, destinationChainId: 8453, depositTxnRef: u.searchParams.get("depositTxHash"), fillTxnRef: s === "filled" ? TX("fe") : null, depositRefundTxnRef: s === "refunded" ? TX("ef") : null });
    }
    return json({}, 404);
  };
  return api;
}

const RECEIVE_TYPES = [["from", "address"], ["to", "address"], ["value", "uint256"], ["validAfter", "uint256"], ["validBefore", "uint256"], ["nonce", "bytes32"]].map(([name, type]) => ({ name, type }));
/** A live-shaped Relay /quote answer (Base USDC -> Robinhood Chain USDG, gasless, exact input). */
function relayQuoteBody(me, amount, now = NOW(), mutate = (q) => q) {
  const requestId = "0x1791492819b74c3577ac5d0fdd9e022128b60039086bceb70c5fe4fbd0e07bca";
  const out = BigInt(amount) - (BigInt(amount) * 58n) / 10_000n;
  return mutate({
    requestId,
    steps: [{ id: "authorize1", action: "Sign authorization", description: "Sign to approve swap of USDC for USDG", kind: "signature", requestId,
      items: [{ status: "incomplete", check: { endpoint: `/intents/status?requestId=${requestId}`, method: "GET" },
        data: {
          sign: { signatureKind: "eip712", types: { ReceiveWithAuthorization: RECEIVE_TYPES.map((f) => ({ ...f })) }, domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC }, primaryType: "ReceiveWithAuthorization",
            value: { from: lc(me), to: lc(X.RELAY.receiver), value: String(amount), validAfter: 0, validBefore: now + 600, nonce: "0x54354872fe3c192ac264fc28448c522b345771b9313a8126565b5aa3e2fc4adc" } },
          post: { endpoint: "/execute/permits", method: "POST", body: { kind: "eip3009", requestId, api: "swap" } },
        } }] }],
    details: { operation: "swap", sender: lc(me), recipient: lc(me),
      currencyIn: { currency: { chainId: 8453, address: lc(USDC), symbol: "USDC", decimals: 6 }, amount: String(amount), minimumAmount: String(amount) },
      currencyOut: { currency: { chainId: 4663, address: lc(USDG), symbol: "USDG", decimals: 6 }, amount: String(out), minimumAmount: String((out * 995n) / 1000n) } },
  });
}
/** Relay's API as a fetch: /quote, /execute/permits (kept in `submits`), /intents/status/v3 from `statuses` in turn. */
function relayApi({ mutate, statuses = ["success"], submitStatus = 200 } = {}) {
  const api = { submits: [], quotes: [], polls: 0 };
  api.fetchImpl = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url);
    if (u.host !== "api.relay.link") return json({}, 404);
    if (u.pathname === "/quote") { const b = await req.json(); api.quotes.push(b); return json(relayQuoteBody(b.user, BigInt(b.amount), NOW(), mutate)); }
    if (u.pathname === "/execute/permits") { api.submits.push({ signature: u.searchParams.get("signature"), body: await req.json(), method: req.method }); return json({ message: "ok" }, submitStatus); }
    if (u.pathname === "/intents/status/v3") { const s = statuses[Math.min(api.polls++, statuses.length - 1)]; return json({ status: s, txHashes: s === "success" ? [TX("aa")] : [] }); }
    return json({}, 404);
  };
  return api;
}

/** CreditPoolV2 test double (as scripts/test-packages.mjs's): every borrow recorded. */
function mockPool() {
  const iface = new ethers.Interface(POOL_ABI);
  const calls = { borrow: [] };
  const borrow = async (...a) => { calls.borrow.push(a); throw new Error("no borrow expected"); };
  borrow.staticCall = async () => 7n;
  return { calls, interface: iface, usdg: async () => USDG, getParams: async () => ({ minLoan: 5_000_000n, maxLoan: 50_000_000n, minTerm: 86400n, maxTerm: 30n * 86400n }), quoteFee: async () => [10_000n, 0n, 0n, 0n], borrow };
}

async function rejects(p, code) {
  try { await p; } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return e; }
  assert.fail(`expected a ${code} refusal`);
}
function refused(fn, code) {
  try { fn(); } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return e; }
  assert.fail(`expected a ${code} refusal`);
}

// ---- MCP harness ------------------------------------------------------------------------------------------------

const KEY = ethers.Wallet.createRandom().privateKey;
const ME = new ethers.Wallet(KEY).address;
const ON = { PRIORS_PAY_NETWORKS: "eip155:4663,eip155:8453", PRIORS_BRIDGE: "across" };
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
async function mcp(env, { fetchImpl, deps = {} } = {}) {
  const server = await createPriorsMcpServer({ env: { PRIORS_STATE_DIR: mkdtempSync(join(tmpdir(), "priors-base-state-")), ...env }, fetchImpl, deps: { lookup, sleep: async () => {}, ...deps } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, text: r.content.map((c) => c.text).join("\n") };
  };
  return { client, call };
}
/** The chain facade the MCP reads (credit), with `usdg` in the wallet on Robinhood Chain and every borrowGap recorded.
 *  Its borrowGap lends max(price - balance, 5) without the real rule's checks (the case "through the real borrowGap
 *  rule" swaps in credit.mjs's, realBorrowGap); `minLoan` adds the pool's minimum-loan read (an Error: the read fails). */
function fakeCredit({ usdg = 10_000_000n, borrowGap, loans = [], minLoan } = {}) {
  const rec = [];
  return {
    rec,
    ...(minLoan === undefined ? {} : { minLoan: async () => { if (minLoan instanceof Error) throw minLoan; return minLoan; } }),
    balances: async (a) => ({ address: a, usdg, native: 10n ** 15n }),
    status: async (id) => ({ agentId: BigInt(id), owner: ME, enrolled: true, isRoot: false, defaulted: false, frozen: false, sponsor: 6228n, premiumBps: 0n, line: 25_000_000n, drawn: 0n, available: 25_000_000n, loansRepaid: 3n, qualifiedRepaid: 2n, volumeRepaid: 15_000_000n, feesPaid: 150_000n, enrolledAt: NOW() - 86400 * 10, score: 612, openLoans: loans }),
    quote: async (id, amount, term) => ({ amount, term, fee: 50_000n, due: amount + 50_000n }),
    borrow: async (id, amount, term) => { rec.push(["borrow", amount]); return { hash: TX("11"), loanId: 43n, principal: amount, fee: 50_000n, dueAt: NOW() + Number(term) }; },
    isController: async () => true,
    agentsOf: async () => [7n],
    borrowGap: async (o) => { rec.push(["borrowGap", o]); if (borrowGap) return borrowGap(o); return { borrowed: o.price - o.balance > 5_000_000n ? o.price - o.balance : 5_000_000n, loanId: 42n, dueAt: BigInt(NOW() + 7 * 86400), fee: 50_000n, term: 604_800n }; },
  };
}
/** The bridge facade (deps.bridge): a Base float that fund_base fills, and fake routes that record what they were asked. */
function fakeBridge({ float = 0n, fund, ret, depositStatus = "pending", relayStatus = "pending" } = {}) {
  const b = { float, calls: [], depositStatusNow: depositStatus, relayStatusNow: relayStatus, quoteRefusal: null };
  b.floatOf = async () => b.float;
  b.quote = async (o) => { b.calls.push(["quote", o]); if (b.quoteRefusal) throw b.quoteRefusal; return { amount: o.amount }; };
  b.fundBase = async (o) => {
    b.calls.push(["fund", o]);
    if (fund) return fund(o, b);
    const t = { route: "across", from: ME, amount: o.amount, outputAmount: o.amount - 4_000n, fee: 4_000n, quoteTimestamp: NOW(), fillDeadline: NOW() + 7200, startedAt: NOW() };
    await o.onDepositSending(t);
    await o.onDepositSent?.({ ...t, hash: TX("de") });
    b.float += t.outputAmount;
    return { route: "across", hash: TX("de"), approveHash: TX("ad"), depositId: 9n, amount: o.amount, outputAmount: t.outputAmount, fee: 4_000n, feeBps: 8, fillDeadline: t.fillDeadline, filled: true, fillTx: TX("fe") };
  };
  b.returnToRobinhood = async (o) => {
    b.calls.push(["return", o]);
    if (ret) return ret(o, b);
    const t = { route: "relay", from: ME, amount: o.amount, expectedOut: o.amount - 3_000n, fee: 3_000n, requestId: TX("17"), nonce: TX("54"), validBefore: NOW() + 600, startedAt: NOW() };
    await o.onSigned(t);
    b.float -= o.amount;
    return { ...t, delivered: true, txHashes: [TX("aa")] };
  };
  b.depositStatus = async () => ({ status: b.depositStatusNow, fillTx: null, refundTx: null });
  b.relayStatus = async () => ({ status: b.relayStatusNow, txHashes: [] });
  return b;
}
/** A transfer kept by fund_base that never lands: recorded, then BRIDGE_PENDING once the poll window ends. */
const pendingFund = async (o) => {
  const t = { route: "across", from: ME, amount: o.amount, outputAmount: o.amount - 4_000n, fee: 4_000n, quoteTimestamp: NOW(), fillDeadline: NOW() + 7200, startedAt: NOW() };
  await o.onDepositSending(t);
  await o.onDepositSent({ ...t, hash: TX("de") });
  await sleep(Math.max(0, o.pollUntil - Date.now()));
  throw new X.PayError("BRIDGE_PENDING", `fundBase: the Across deposit (tx ${TX("de")}) was sent and had not landed on Base when the wait ended (status pending). Do not send it again`, { moved: true, hash: TX("de") });
};

// =================================================================================================================

export async function runX402BaseTests({ test, fork = false }) {
  console.log("x402 on Base: the network allowlist and the payer");

  await test("networks: a frozen allowlist (USDG on 4663, USDC on Base with its own domain), Robinhood Chain only by default", () => {
    assert.ok(Object.isFrozen(X.NETWORKS) && Object.isFrozen(X.NETWORKS["eip155:8453"]) && Object.isFrozen(X.NETWORKS["eip155:8453"].eip712));
    assert.deepEqual({ ...X.ROBINHOOD_USDG.eip712 }, { name: "Global Dollar", version: "1" });
    assert.equal(X.ROBINHOOD_USDG.asset, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    assert.deepEqual({ ...X.BASE_USDC.eip712 }, { name: "USD Coin", version: "2" });
    assert.equal(X.BASE_USDC.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    assert.equal(X.BASE_USDC.chainId, 8453);
    assert.deepEqual([...X.DEFAULT_PAY_NETWORKS], ["eip155:4663"]);
    assert.deepEqual([...X.payNetworks()], ["eip155:4663"]);
    assert.deepEqual([...X.payNetworks(" eip155:4663 , eip155:8453,eip155:8453")], BOTH);
    assert.throws(() => X.payNetworks("eip155:1"), /not a network/);
    assert.equal(X.networkOf("constructor"), null); assert.equal(X.networkOf("__proto__"), null);
    assert.equal(X.ACROSS.spokes[4663], "0xD29C85F15DF544bA632C9E25829fd29d767d7978");
    assert.equal(X.ACROSS.spokes[8453], "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64");
    assert.equal(lc(X.RELAY.receiver), "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be");
    assert.ok(Object.isFrozen(X.ACROSS) && Object.isFrozen(X.ACROSS.spokes) && Object.isFrozen(X.RELAY));
  });

  await test("pickV2Requirement: Base only when enabled; full addresses (lookalike USDG and USDC refused); pinned domains; 4663 first", () => {
    const base = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: MERCHANT, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
    const rh = { scheme: "exact", network: "eip155:4663", asset: USDG, amount: "10000", payTo: MERCHANT, maxTimeoutSeconds: 60, extra: { name: "Global Dollar", version: "1" } };
    // default: unchanged (Robinhood Chain only), with the (accepts, asset) signature kept
    assert.equal(X.pickV2Requirement([base]), null);
    assert.equal(X.pickV2Requirement([rh]), rh);
    assert.equal(X.pickV2Requirement([rh], USDG), rh);
    const on = { networks: BOTH };
    assert.equal(X.pickV2Requirement([base], undefined, on), base);
    assert.equal(X.pickV2Requirement([{ ...base, extra: undefined }], undefined, on)?.network, "eip155:8453", "no domain named: signed on USDC's own");
    // lookalikes, by full address
    for (const fake of LOOKALIKES) {
      assert.equal(X.pickV2Requirement([{ ...rh, asset: fake }], undefined, on), null, `lookalike ${fake}`);
      assert.equal(X.pickV2Requirement([{ ...rh, asset: fake }], fake.slice(0, 41) + "0", on), null);
    }
    assert.equal(X.pickV2Requirement([{ ...base, asset: FAKE_USDC }], undefined, on), null, "USDC lookalike");
    assert.equal(X.pickV2Requirement([{ ...base, asset: USDG }], undefined, on), null, "USDG named on Base");
    assert.equal(X.pickV2Requirement([{ ...rh, asset: USDC }], undefined, on), null, "USDC named on Robinhood Chain");
    // wrong domain
    for (const extra of [{ name: "USDC", version: "2" }, { name: "USD Coin", version: "1" }, { name: "Global Dollar", version: "1" }, { name: 1, version: "2" }]) assert.equal(X.pickV2Requirement([{ ...base, extra }], undefined, on), null, JSON.stringify(extra));
    assert.equal(X.pickV2Requirement([{ ...rh, extra: { name: "USD Coin", version: "2" } }], undefined, on), null);
    assert.equal(X.pickV2Requirement([{ ...base, extra: { ...base.extra, assetTransferMethod: "permit2" } }], undefined, on), null, "Permit2 is not signed");
    // both offered: Robinhood Chain, whatever the order
    assert.equal(X.pickV2Requirement([base, rh], undefined, on), rh);
    assert.equal(X.pickV2Requirement([rh, base], undefined, on), rh);
    assert.equal(X.pickV2Requirement([base, rh], undefined, { networks: ["eip155:8453"] }), base, "4663 not enabled: Base");
    assert.throws(() => X.pickV2Requirement([base], undefined, { networks: ["eip155:1"] }), /not a network/);
  });

  await test("CappedExactEvmScheme: a Base requirement naming no domain is signed on USDC's (USD Coin/2, chain 8453), 4663 on USDG's", async () => {
    const w = new CountingWallet(ethers.Wallet.createRandom().privateKey);
    const s = new X.CappedExactEvmScheme(X.toX402Signer(w, w.address));
    const p = await s.createPaymentPayload(2, { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: MERCHANT, maxTimeoutSeconds: 3600, extra: {} });
    const a = p.payload.authorization;
    assert.equal(ethers.verifyTypedData(DOMAIN_USDC, TWA, a, p.payload.signature), w.address);
    assert.deepEqual({ name: w.signed[0].domain.name, version: w.signed[0].domain.version, chainId: Number(w.signed[0].domain.chainId) }, { name: "USD Coin", version: "2", chainId: 8453 });
    assert.ok(Number(a.validBefore) <= NOW() + 601, "the 600 s cap holds on Base too");
    const q = await s.createPaymentPayload(2, { scheme: "exact", network: "eip155:4663", asset: USDG, amount: "10000", payTo: MERCHANT, maxTimeoutSeconds: 60 });
    assert.equal(ethers.verifyTypedData(DOMAIN_USDG, TWA, q.payload.authorization, q.payload.signature), w.address);
  });

  await test("createUsdgClient: Base only when enabled, then within the cap; USDC's address only", async () => {
    const w = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
    await assert.rejects(wrapFetchWithPayment(merchant().fetchImpl, X.createUsdgClient({ signer: w }))("https://merchant.example/data"), "default: Base is not registered");
    const m = merchant();
    const res = await wrapFetchWithPayment(m.fetchImpl, X.createUsdgClient({ signer: w, networks: BOTH }))("https://merchant.example/data");
    assert.equal(res.status, 200); assert.equal(m.payloads.length, 1);
    await assert.rejects(wrapFetchWithPayment(merchant({ amount: "500000" }).fetchImpl, X.createUsdgClient({ signer: w, networks: BOTH }))("https://merchant.example/data"), "above the cap");
    await assert.rejects(wrapFetchWithPayment(merchant({ accepts: [{ scheme: "exact", network: "eip155:8453", asset: FAKE_USDC, amount: "10000", payTo: MERCHANT, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] }).fetchImpl, X.createUsdgClient({ signer: w, networks: BOTH }))("https://merchant.example/data"), "a USDC lookalike");
  });

  /** A payer whose wallet holds `usdg` on Robinhood Chain and `usdc` on Base; every read and signature counted.
   *  `networks: null`: createPayer's own default (no networks, no baseProvider passed). */
  function basePayer({ usdg = 0n, usdc = 0n, networks = BOTH, ...o } = {}) {
    const rh = new ChainMock(4663), base = new ChainMock(8453);
    const signer = new CountingWallet(ethers.Wallet.createRandom().privateKey, rh);
    rh.setBal(USDG, signer.address, usdg); base.setBal(USDC, signer.address, usdc);
    const seen = { topUp: 0, reserve: 0, signed: [] };
    const pool = mockPool();
    const net = networks === null ? {} : { networks, baseProvider: base };
    const payer = X.createPayer({ signer, ...net, pool, agentId: 7, maxBorrow: "$10", topUp: async () => { seen.topUp++; return { withdrawn: 0n }; }, reserve: async () => { seen.reserve++; return 0n; }, onSigned: (s) => { seen.signed.push(s); }, ...o });
    return { rh, base, signer, seen, pool, payer };
  }

  await test("createPayer: a Base 402 with the float short is refused (BASE_FLOAT_SHORT) before any signature, loan, savings or reserve step", async () => {
    const m = merchant({ amount: "10000" });
    const b = basePayer({ usdg: 50_000_000n, usdc: 9_999n, fetchImpl: m.fetchImpl });
    const err = await rejects(b.payer.pay("https://merchant.example/data"), "BASE_FLOAT_SHORT");
    assert.equal(err.price, 10_000n); assert.equal(err.balance, 9_999n); assert.equal(err.network, "eip155:8453"); assert.equal(err.asset, USDC);
    assert.equal(b.signer.signs, 0, "nothing signed"); assert.equal(m.headers.length, 0, "nothing sent");
    assert.equal(b.pool.calls.borrow.length, 0, "no loan"); assert.equal(b.seen.topUp, 0, "no savings top-up"); assert.equal(b.seen.reserve, 0, "no reserve read");
    assert.equal(b.rh.st.reads, 0, "Robinhood Chain not even read");
  });

  await test("createPayer: a funded Base 402 is paid once from the float, on USDC's domain; onSigned carries network and asset", async () => {
    const m = merchant({ amount: "10000" });
    const b = basePayer({ usdc: 1_000_000n, fetchImpl: m.fetchImpl });
    const r = await b.payer.pay("https://merchant.example/data");
    assert.equal(r.response.status, 200); assert.equal(r.paid, 10_000n); assert.equal(r.borrowed, 0n);
    assert.equal(r.network, "eip155:8453"); assert.equal(r.asset, USDC);
    assert.equal(b.signer.signs, 1); assert.equal(m.payloads.length, 1);
    const a = m.payloads[0].payload.authorization;
    assert.equal(ethers.verifyTypedData(DOMAIN_USDC, TWA, a, m.payloads[0].payload.signature), b.signer.address);
    assert.deepEqual(m.payloads[0].accepted, m.pr.accepts[0], "accepted is the merchant's requirement verbatim");
    assert.equal(b.seen.signed.length, 1); assert.equal(b.seen.signed[0].network, "eip155:8453"); assert.equal(b.seen.signed[0].asset, USDC);
    assert.equal(b.pool.calls.borrow.length, 0); assert.equal(b.seen.topUp, 0); assert.equal(b.seen.reserve, 0);
    // the price cap still comes first: above maxPrice, not even the float is read
    const dear = merchant({ amount: "500000" });
    const c = basePayer({ usdc: 1_000_000n, fetchImpl: dear.fetchImpl });
    await rejects(c.payer.pay("https://merchant.example/data"), "PRICE_ABOVE_MAX_PRICE");
    assert.equal(c.base.st.reads, 0); assert.equal(c.signer.signs, 0);
  });

  await test("createPayer: baseReserve keeps part of the float back, read before its balance; the price must fit in the rest, else BASE_FLOAT_SHORT unsigned", async () => {
    const url = "https://merchant.example/data";
    const m = merchant({ amount: "10000" });
    let held = 1_995_000n, b;
    const readsAtReserve = [];
    b = basePayer({ usdc: 2_000_000n, fetchImpl: m.fetchImpl, baseReserve: async () => { readsAtReserve.push(b.base.st.reads); return held; } });
    const err = await rejects(b.payer.pay(url), "BASE_FLOAT_SHORT");
    assert.equal(err.reserve, 1_995_000n); assert.equal(err.balance, 2_000_000n); assert.equal(err.price, 10_000n);
    assert.ok(/holds 2\.00 USDC on Base, 1\.995 of it kept back \(0\.005 free\), less than the price 0\.01 USDC; nothing was signed/.test(err.message), err.message);
    assert.equal(b.signer.signs, 0); assert.equal(m.headers.length, 0);
    assert.deepEqual(readsAtReserve, [0], "the reserve is read before the float's balance (a transfer landing in between shows in the balance)");
    held = 1_990_000n; // exactly the price left free
    const r = await b.payer.pay(url);
    assert.equal(r.paid, 10_000n); assert.equal(b.signer.signs, 1);
    // a reserve that cannot be read: nothing is signed
    const c = basePayer({ usdc: 2_000_000n, fetchImpl: merchant().fetchImpl, baseReserve: async () => { throw new Error("rpc down"); } });
    await assert.rejects(c.payer.pay(url), /rpc down/);
    assert.equal(c.signer.signs, 0);
    // a Robinhood Chain payment never asks for it
    let asked = 0;
    const d = basePayer({ usdg: 1_000_000n, fetchImpl: merchant({ accepts: ["robinhood"] }).fetchImpl, baseReserve: async () => { asked++; return 10n ** 12n; } });
    assert.equal((await d.payer.pay(url)).paid, 10_000n); assert.equal(asked, 0);
  });

  await test("createPayer: a seller offering both is paid in USDG on Robinhood Chain (the Base float is not read)", async () => {
    const m = merchant({ accepts: ["base", "robinhood"] });
    const b = basePayer({ usdg: 1_000_000n, usdc: 1_000_000n, fetchImpl: m.fetchImpl });
    const r = await b.payer.pay("https://merchant.example/data");
    assert.equal(r.response.status, 200); assert.equal(r.network, "eip155:4663");
    assert.equal(m.payloads[0].accepted.network, "eip155:4663");
    assert.equal(ethers.verifyTypedData(DOMAIN_USDG, TWA, m.payloads[0].payload.authorization, m.payloads[0].payload.signature), b.signer.address);
    assert.equal(b.base.st.reads, 0, "the Base float was not read");
    assert.equal(b.seen.signed[0].network, "eip155:4663"); assert.equal(b.seen.signed[0].asset, USDG);
  });

  await test("createPayer: v1 stays Robinhood Chain only; default-off unchanged (a Base 402 is NO_USDG_REQUIREMENT); Base needs baseProvider", async () => {
    const v1 = async (input) => (input.headers.get("X-PAYMENT") ? new Response("{}") : json({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "10000", payTo: MERCHANT, asset: USDC, maxTimeoutSeconds: 60, resource: "x" }] }, 402));
    const b = basePayer({ usdc: 1_000_000n, fetchImpl: v1 });
    await rejects(b.payer.pay("https://merchant.example/v1"), "NO_USDG_REQUIREMENT");
    assert.equal(b.signer.signs, 0);
    const off = basePayer({ usdg: 1_000_000n, usdc: 1_000_000n, networks: null, fetchImpl: merchant().fetchImpl });
    const e = await rejects(off.payer.pay("https://merchant.example/data"), "NO_USDG_REQUIREMENT");
    assert.ok(!/Base/.test(e.message), "the default message is the old one");
    assert.equal(off.signer.signs, 0); assert.equal(off.base.st.reads, 0);
    const w = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, new ChainMock(4663));
    assert.throws(() => X.createPayer({ signer: w, networks: BOTH }), (err) => err.code === "NO_PROVIDER");
    assert.throws(() => X.createPayer({ signer: w, networks: ["eip155:1"] }), (err) => err.code === "BAD_NETWORK");
    X.createPayer({ signer: w }); // default: no baseProvider needed
  });

  console.log("x402 on Base: bridge.mjs (Across out, Relay back)");

  await test("Across quote: a live-shaped answer passes; every field the deposit uses is checked", async () => {
    const now = NOW(), amount = 5_000_000n;
    const ok = B.checkAcrossQuote(acrossQuoteBody(amount, now), { amount, now });
    assert.equal(ok.outputAmount, amount - (3_500n + 3_000n)); assert.equal(ok.fee, 6_500n); assert.equal(ok.spoke, SPOKE);
    assert.equal(ok.exclusiveRelayer, RELAYER); assert.equal(ok.exclusivityDeadline, 3); assert.ok(Object.isFrozen(ok));
    // each mutation of Across's answer, served through an injected fetch, is refused by acrossQuote
    const bad = (mut, code = "BRIDGE_QUOTE_REFUSED", o = {}) => rejects(B.acrossQuote({ amount, now: () => now, fetchImpl: acrossApi({ now, mutate: (q) => { mut(q); return q; } }).fetchImpl, ...(o.maxFeeBps !== undefined ? { maxFeeBps: o.maxFeeBps } : {}) }), code);
    for (const fake of LOOKALIKES) { await bad((q) => { q.inputToken.address = fake; }); await bad((q) => { q.inputToken = fake; }); }
    await bad((q) => { q.inputToken.chainId = 1; });
    await bad((q) => { q.outputToken.address = FAKE_USDC; });
    await bad((q) => { q.outputToken.address = USDG; });
    await bad((q) => { q.outputToken.chainId = 4663; });
    await bad((q) => { q.spokePoolAddress = DEST_SPOKE; });
    await bad((q) => { q.spokePoolAddress = SPOKE.slice(0, 41) + "0"; });
    await bad((q) => { q.destinationSpokePoolAddress = SPOKE; });
    await bad((q) => { q.isAmountTooLow = true; });
    await bad((q) => { delete q.isAmountTooLow; });
    await bad((q) => { q.limits.minDeposit = String(amount + 1n); });
    await bad((q) => { delete q.limits; });
    await bad((q) => { q.outputAmount = String(amount + 1n); });
    await bad((q) => { q.outputAmount = "0"; });
    await bad((q) => { q.outputAmount = "4.9e6"; });
    await bad((q) => { q.timestamp = String(now - 3_100); }); // past the spoke's hour, less the margin to get mined
    await bad((q) => { q.timestamp = String(now + 300); });
    await bad((q) => { q.fillDeadline = String(now + 60); });
    await bad((q) => { q.fillDeadline = String(Number(q.timestamp) + 21_601); });
    await bad((q) => { q.exclusivityDeadline = 3_600; });
    await bad((q) => { q.exclusiveRelayer = ethers.ZeroAddress; });
    await bad((q) => { q.exclusiveRelayer = "not an address"; });
    await bad((q) => { q.outputAmount = String(amount - 60_000n); }, "BRIDGE_FEE_TOO_HIGH"); // 1.2% > the 1% default
    await bad(() => {}, "BRIDGE_FEE_TOO_HIGH", { maxFeeBps: 10 });
    assert.equal(B.checkAcrossQuote(acrossQuoteBody(amount, now, (q) => { q.exclusiveRelayer = ethers.ZeroAddress; q.exclusivityDeadline = 0; return q; }), { amount, now }).exclusivityDeadline, 0, "no exclusivity is fine");
    refused(() => B.checkAcrossQuote(null, { amount, now }), "BRIDGE_QUOTE_REFUSED");
    // fetched from the pinned host with the pinned tokens and chains; an error status says nothing of the answer
    const api = acrossApi();
    const q = await B.acrossQuote({ amount, fetchImpl: api.fetchImpl });
    const u = api.urls[0];
    assert.equal(u.origin, "https://app.across.to"); assert.equal(u.pathname, "/api/suggested-fees");
    assert.deepEqual(Object.fromEntries(u.searchParams), { inputToken: USDG, outputToken: USDC, originChainId: "4663", destinationChainId: "8453", amount: "5000000" });
    assert.equal(q.outputAmount, ok.outputAmount);
    const e = await rejects(B.acrossQuote({ amount, fetchImpl: async () => new Response("<html>secret</html>", { status: 503 }) }), "BRIDGE_QUOTE_FAILED");
    assert.ok(!/secret/.test(e.message));
  });

  await test("Across deposit status: by the deposit's hash on the pinned host; a 404 (not indexed yet) is pending", async () => {
    for (const [s, want] of [[404, "pending"], ["pending", "pending"], ["filled", "filled"], ["expired", "expired"], ["refunded", "refunded"], ["weird", "unknown"]]) {
      const api = acrossApi({ status: s });
      const r = await B.depositStatus({ hash: TX("de"), fetchImpl: api.fetchImpl });
      assert.equal(r.status, want, String(s));
      assert.equal(api.urls[0].origin, "https://app.across.to"); assert.equal(api.urls[0].pathname, "/api/deposit/status");
      assert.deepEqual(Object.fromEntries(api.urls[0].searchParams), { originChainId: "4663", depositTxHash: TX("de") });
    }
    await rejects(B.depositStatus({ hash: "0x12" }), "BAD_HASH");
  });

  /** A wallet with `usdg` on a mock Robinhood Chain, and Across's API. */
  function fundRig({ usdg = 10_000_000n, allowance = 0n, status = "filled", mutate, chain = {} } = {}) {
    const rh = new ChainMock(4663, chain);
    const signer = new CountingWallet(ethers.Wallet.createRandom().privateKey, rh);
    rh.setBal(USDG, signer.address, usdg);
    if (allowance) rh.setAllowed(USDG, signer.address, SPOKE, allowance);
    return { rh, signer, api: acrossApi({ status, mutate }) };
  }

  await test("fundBase: an exact approval to the pinned spoke, a simulated depositV3 to itself with the quote's outputAmount, recorded before the broadcast", async () => {
    const { rh, signer, api } = fundRig();
    const order = [];
    const r = await B.fundBase({ signer, amount: 5_000_000n, fetchImpl: api.fetchImpl, pollMs: 5, onDepositSending: (t) => { order.push(`record:${rh.st.log.join(",")}`); assert.equal(t.amount, 5_000_000n); }, onDepositSent: (t) => { order.push(`sent:${t.hash}`); } });
    assert.deepEqual(rh.st.log, ["approve", "deposit"]);
    const [ap, dep] = rh.st.sent;
    assert.equal(ap.token, USDG); assert.equal(ap.args[0], SPOKE); assert.equal(ap.args[1], 5_000_000n, "approve exactly the amount, never unlimited");
    const a = dep.args;
    assert.equal(a.depositor, signer.address); assert.equal(a.recipient, signer.address);
    assert.equal(a.inputToken, USDG); assert.equal(a.outputToken, USDC);
    assert.equal(a.inputAmount, 5_000_000n); assert.equal(a.outputAmount, 5_000_000n - 6_500n, "outputAmount is the quote's exactly");
    assert.equal(a.destinationChainId, 8453n); assert.equal(a.exclusiveRelayer, RELAYER); assert.equal(a.exclusivityParameter, 3n); assert.equal(a.message, "0x");
    assert.deepEqual(order, ["record:approve", `sent:${dep.hash}`], "recorded after the approval and before the deposit's broadcast");
    assert.equal(r.filled, true); assert.equal(r.hash, dep.hash); assert.equal(r.fillTx, TX("fe")); assert.equal(r.depositId, 438_520n); assert.equal(r.mismatch, undefined);
    assert.equal(signer.signs, 0, "no typed data is signed for Across");
    // an allowance already there: no new approval
    const again = fundRig({ allowance: 5_000_000n });
    await B.fundBase({ signer: again.signer, amount: 5_000_000n, fetchImpl: again.api.fetchImpl, pollMs: 5 });
    assert.deepEqual(again.rh.st.log, ["deposit"]);
  });

  await test("fundBase: refusals before anything is sent (fee, lookalike, short wallet, would revert, record failed)", async () => {
    const fee = fundRig({ mutate: (q) => { q.outputAmount = "4900000"; return q; } });
    const e1 = await rejects(B.fundBase({ signer: fee.signer, amount: 5_000_000n, fetchImpl: fee.api.fetchImpl }), "BRIDGE_FEE_TOO_HIGH");
    assert.deepEqual(fee.rh.st.sent, []); assert.equal(e1.fee, 100_000n);
    const fake = fundRig({ mutate: (q) => { q.inputToken.address = LOOKALIKES[0]; return q; } });
    await rejects(B.fundBase({ signer: fake.signer, amount: 5_000_000n, fetchImpl: fake.api.fetchImpl }), "BRIDGE_QUOTE_REFUSED");
    assert.deepEqual(fake.rh.st.sent, []);
    const short = fundRig({ usdg: 4_000_000n });
    const e2 = await rejects(B.fundBase({ signer: short.signer, amount: 5_000_000n, fetchImpl: short.api.fetchImpl }), "INSUFFICIENT_USDG");
    assert.equal(e2.moved, false); assert.deepEqual(short.rh.st.sent, []);
    const rev = fundRig({ chain: { depositReverts: true } });
    const e3 = await rejects(B.fundBase({ signer: rev.signer, amount: 5_000_000n, fetchImpl: rev.api.fetchImpl, onDepositSending: () => assert.fail("not recorded") }), "BRIDGE_WOULD_REVERT");
    assert.ok(/InvalidFillDeadline/.test(e3.message), e3.message); assert.deepEqual(rev.rh.st.log, ["approve"], "only the exact approval");
    const nr = fundRig();
    const e4 = await rejects(B.fundBase({ signer: nr.signer, amount: 5_000_000n, fetchImpl: nr.api.fetchImpl, onDepositSending: () => { throw new Error("disk full"); } }), "NOT_RECORDED");
    assert.equal(e4.moved, false); assert.deepEqual(nr.rh.st.log, ["approve"], "no deposit without a record");
  });

  await test("fundBase: not filled in time -> BRIDGE_PENDING with the hash (one deposit, never resent); refunded -> BRIDGE_REFUNDED; a lost answer -> DEPOSIT_UNCONFIRMED", async () => {
    const p = fundRig({ status: (n) => (n < 3 ? 404 : "pending") });
    const t0 = Date.now();
    const e = await rejects(B.fundBase({ signer: p.signer, amount: 5_000_000n, fetchImpl: p.api.fetchImpl, pollMs: 20, pollUntil: Date.now() + 300 }), "BRIDGE_PENDING");
    assert.ok(Date.now() - t0 < 1_500, "the wait ends at pollUntil");
    assert.equal(e.moved, true); assert.equal(e.hash, p.rh.st.sent[1].hash); assert.ok(p.api.statuses >= 3);
    assert.equal(p.rh.st.sent.filter((s) => s.kind === "deposit").length, 1);
    // timeoutMs bounds the wait too, from the broadcast
    const t = fundRig({ status: "pending" });
    const t1 = Date.now();
    await rejects(B.fundBase({ signer: t.signer, amount: 5_000_000n, fetchImpl: t.api.fetchImpl, pollMs: 20, timeoutMs: 200 }), "BRIDGE_PENDING");
    assert.ok(Date.now() - t1 < 1_500);
    const ref = fundRig({ status: "refunded" });
    const e2 = await rejects(B.fundBase({ signer: ref.signer, amount: 5_000_000n, fetchImpl: ref.api.fetchImpl, pollMs: 5 }), "BRIDGE_REFUNDED");
    assert.equal(e2.refundTx, TX("ef")); assert.equal(e2.moved, true);
    const lost = fundRig({ chain: { loseReceipt: true } });
    // the approval's receipt is read first: give it an allowance so the deposit is the first transaction
    lost.rh.setAllowed(USDG, lost.signer.address, SPOKE, 5_000_000n);
    const e3 = await rejects(B.fundBase({ signer: lost.signer, amount: 5_000_000n, fetchImpl: lost.api.fetchImpl }), "DEPOSIT_UNCONFIRMED");
    assert.equal(e3.moved, true); assert.equal(e3.unconfirmed, true); assert.equal(e3.hash, lost.rh.st.sent[0].hash);
    const dropped = fundRig({ allowance: 5_000_000n, chain: { dropSend: true } });
    const e4 = await rejects(B.fundBase({ signer: dropped.signer, amount: 5_000_000n, fetchImpl: dropped.api.fetchImpl }), "DEPOSIT_UNCONFIRMED");
    assert.equal(e4.moved, true, "a broadcast whose answer was lost may have mined");
  });

  await test("Relay return: a live-shaped quote passes, and what is signed is rebuilt from the checked fields (never the quote's object)", () => {
    const me = ethers.Wallet.createRandom().address, now = NOW(), amount = 5_000_000n;
    const q = relayQuoteBody(me, amount, now, (x) => { x.steps[0].items[0].data.sign.value.extraField = "ignored"; return x; });
    const plan = B.checkRelayReturn(q, { me, amount, now });
    assert.deepEqual(plan.domain, { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC });
    assert.deepEqual(plan.types, { ReceiveWithAuthorization: RECEIVE_TYPES });
    assert.deepEqual(Object.keys(plan.message), ["from", "to", "value", "validAfter", "validBefore", "nonce"]);
    assert.equal(plan.message.from, me); assert.equal(plan.message.to, X.RELAY.receiver); assert.equal(plan.message.value, amount);
    assert.deepEqual(plan.submit, { endpoint: "/execute/permits", body: { kind: "eip3009", requestId: q.requestId, api: "swap" } });
    assert.equal(plan.expectedOut, amount - 29_000n); assert.equal(plan.fee, 29_000n);
    // the quote changed afterwards changes nothing that is signed
    q.steps[0].items[0].data.sign.value.to = MERCHANT; q.steps[0].items[0].data.sign.domain.verifyingContract = MERCHANT;
    assert.equal(plan.message.to, X.RELAY.receiver); assert.equal(plan.domain.verifyingContract, USDC);
  });

  await test("Relay return: every mutation of the typed data, the route or the amounts is refused before signing", () => {
    const me = ethers.Wallet.createRandom().address, now = NOW(), amount = 5_000_000n;
    const sign = (q) => q.steps[0].items[0].data.sign;
    const bad = (mut, code = "RELAY_QUOTE_REFUSED", o = {}) => refused(() => B.checkRelayReturn(relayQuoteBody(me, amount, now, (q) => { mut(q); return q; }), { me, amount, now, ...o }), code);
    bad((q) => { sign(q).primaryType = "TransferWithAuthorization"; });
    bad((q) => { sign(q).signatureKind = "eip191"; });
    bad((q) => { sign(q).types.ReceiveWithAuthorization.push({ name: "extra", type: "uint256" }); });
    bad((q) => { sign(q).types.ReceiveWithAuthorization.reverse(); });
    bad((q) => { sign(q).types.ReceiveWithAuthorization[2].type = "uint128"; });
    bad((q) => { sign(q).types.Permit = [{ name: "owner", type: "address" }]; });
    bad((q) => { sign(q).domain.name = "USDC"; });
    bad((q) => { sign(q).domain.version = "1"; });
    bad((q) => { sign(q).domain.chainId = 1; });
    bad((q) => { sign(q).domain.chainId = 4663; });
    bad((q) => { sign(q).domain.verifyingContract = FAKE_USDC; });
    bad((q) => { sign(q).domain.salt = TX("00"); });
    bad((q) => { sign(q).value.from = MERCHANT; });
    bad((q) => { sign(q).value.to = MERCHANT; });
    bad((q) => { sign(q).value.to = USDC; });
    bad((q) => { sign(q).value.value = String(amount + 1n); });
    bad((q) => { sign(q).value.value = "5e6"; });
    bad((q) => { sign(q).value.validAfter = now + 120; });
    bad((q) => { sign(q).value.validBefore = now + 3_600; });
    bad((q) => { sign(q).value.validBefore = now + 30; });
    bad((q) => { sign(q).value.validBefore = now - 1; });
    bad((q) => { sign(q).value.nonce = "0x1234"; });
    bad((q) => { q.steps.push({ kind: "transaction", items: [] }); });
    bad((q) => { q.steps[0].kind = "transaction"; });
    bad((q) => { q.steps[0].items.push(q.steps[0].items[0]); });
    bad((q) => { q.steps[0].items[0].data.post.endpoint = "/execute/swap"; });
    bad((q) => { q.steps[0].items[0].data.post.body.requestId = TX("99"); });
    bad((q) => { q.steps[0].items[0].data.post.body.kind = "permit"; });
    bad((q) => { q.requestId = "0x12"; });
    bad((q) => { q.details.recipient = MERCHANT; });
    bad((q) => { q.details.sender = MERCHANT; });
    for (const fake of LOOKALIKES) bad((q) => { q.details.currencyOut.currency.address = fake; });
    bad((q) => { q.details.currencyOut.currency.chainId = 8453; });
    bad((q) => { q.details.currencyIn.currency.address = FAKE_USDC; });
    bad((q) => { q.details.currencyIn.amount = String(amount * 2n); });
    bad((q) => { q.details.currencyOut.minimumAmount = String(amount / 2n); });
    bad((q) => { q.details.currencyOut.amount = String(amount * 2n); });
    bad((q) => { q.details.currencyOut.amount = String(amount - 100_000n); q.details.currencyOut.minimumAmount = String(amount - 100_000n); }, "BRIDGE_FEE_TOO_HIGH");
    bad(() => {}, "BRIDGE_FEE_TOO_HIGH", { maxFeeBps: 10 });
  });

  await test("returnToRobinhood: one signature on the rebuilt authorization, recorded before it leaves, handed to /execute/permits, then delivered", async () => {
    const base = new ChainMock(8453);
    const signer = new CountingWallet(ethers.Wallet.createRandom().privateKey);
    base.setBal(USDC, signer.address, 6_000_000n);
    const api = relayApi({ statuses: ["waiting", "pending", "success"] });
    const order = [];
    const r = await B.returnToRobinhood({ signer, amount: 5_000_000n, baseProvider: base, fetchImpl: async (i, n) => { order.push(new URL(typeof i === "string" ? i : i.url).pathname); return api.fetchImpl(i, n); }, pollMs: 5, onSigned: (t) => { order.push(`record:${signer.signs}`); assert.equal(api.submits.length, 0, "recorded before it leaves"); assert.equal(t.amount, 5_000_000n); } });
    assert.equal(r.delivered, true); assert.deepEqual(r.txHashes, [TX("aa")]);
    assert.equal(signer.signs, 1);
    const s = signer.signed[0];
    assert.deepEqual(Object.keys(s.types), ["ReceiveWithAuthorization"], "never a TransferWithAuthorization: not through the x402 scheme");
    assert.equal(s.value.to, X.RELAY.receiver); assert.equal(s.value.from, signer.address);
    assert.deepEqual(order.slice(0, 3), ["/quote", "record:1", "/execute/permits"], "recorded after signing, before it leaves");
    assert.equal(api.quotes[0].usePermit, true); assert.equal(api.quotes[0].tradeType, "EXACT_INPUT"); assert.equal(api.quotes[0].recipient, signer.address); assert.equal(api.quotes[0].destinationCurrency, USDG);
    const sub = api.submits[0];
    assert.equal(sub.method, "POST"); assert.deepEqual(sub.body, { kind: "eip3009", requestId: r.requestId, api: "swap" });
    assert.equal(ethers.verifyTypedData(DOMAIN_USDC, { ReceiveWithAuthorization: RECEIVE_TYPES }, s.value, sub.signature), signer.address);
  });

  await test("returnToRobinhood: nothing signed when the float is short or the quote is refused; a record that fails never leaves; an unclear submit is pending", async () => {
    const base = new ChainMock(8453);
    const signer = new CountingWallet(ethers.Wallet.createRandom().privateKey);
    base.setBal(USDC, signer.address, 1_000_000n);
    const api = relayApi();
    const e1 = await rejects(B.returnToRobinhood({ signer, amount: 5_000_000n, baseProvider: base, fetchImpl: api.fetchImpl }), "INSUFFICIENT_USDC");
    assert.equal(e1.moved, false); assert.equal(signer.signs, 0); assert.equal(api.quotes.length, 0);
    base.setBal(USDC, signer.address, 10_000_000n);
    const evil = relayApi({ mutate: (q) => { q.steps[0].items[0].data.sign.value.to = MERCHANT; return q; } });
    await rejects(B.returnToRobinhood({ signer, amount: 5_000_000n, baseProvider: base, fetchImpl: evil.fetchImpl }), "RELAY_QUOTE_REFUSED");
    assert.equal(signer.signs, 0, "a quote paying anyone else is never signed");
    const nr = relayApi();
    const e2 = await rejects(B.returnToRobinhood({ signer, amount: 5_000_000n, baseProvider: base, fetchImpl: nr.fetchImpl, onSigned: () => { throw new Error("disk full"); } }), "NOT_RECORDED");
    assert.equal(e2.moved, false); assert.equal(nr.submits.length, 0, "the signature never left");
    const unclear = relayApi({ submitStatus: 502 });
    const e3 = await rejects(B.returnToRobinhood({ signer, amount: 5_000_000n, baseProvider: base, fetchImpl: unclear.fetchImpl }), "RETURN_PENDING");
    assert.equal(e3.moved, true); assert.ok(e3.validBefore > NOW());
    const slow = relayApi({ statuses: ["pending"] });
    const e4 = await rejects(B.returnToRobinhood({ signer, amount: 5_000_000n, baseProvider: base, fetchImpl: slow.fetchImpl, pollMs: 10, pollUntil: Date.now() + 100 }), "RETURN_PENDING");
    assert.equal(e4.moved, true);
    const failed = relayApi({ statuses: ["failure"] });
    const e5 = await rejects(B.returnToRobinhood({ signer, amount: 5_000_000n, baseProvider: base, fetchImpl: failed.fetchImpl, pollMs: 5 }), "RETURN_FAILED");
    assert.equal(e5.moved, true, "kept as out until the authorization expires");
    const used = new ChainMock(8453, { used: new Set([lc(TX("54"))]) });
    assert.equal(await B.authorizationUsed({ baseProvider: used, from: signer.address, nonce: TX("54") }), true);
    assert.equal(await B.authorizationUsed({ baseProvider: used, from: signer.address, nonce: TX("55") }), false);
  });

  console.log("x402 on Base: @priors/mcp");

  await test("MCP default-off: no Base tool, pay_url unchanged (a Base 402 is not paid), even with one of the two settings; bad values stop the start without echoing them", async () => {
    const plain = await mcp({});
    const names = (await plain.client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("fund_base") && !names.includes("return_to_robinhood"), names.join(","));
    const pay = (await plain.client.listTools()).tools.find((t) => t.name === "pay_url");
    assert.ok(!/Base/.test(pay.description) && pay.title === "Pay for a URL with x402 (USDG)");
    for (const env of [{ PRIORS_PAY_NETWORKS: "eip155:4663,eip155:8453" }, { PRIORS_BRIDGE: "across" }, { PRIORS_PAY_NETWORKS: "eip155:8453", PRIORS_BRIDGE: "off" }]) {
      const m = merchant();
      const base = new ChainMock(8453);
      const s = await mcp({ PRIORS_KEY: KEY, ...env }, { fetchImpl: m.fetchImpl, deps: { credit: fakeCredit(), provider: new ChainMock(4663), baseProvider: base } });
      const tools = (await s.client.listTools()).tools.map((t) => t.name);
      assert.ok(!tools.includes("fund_base"), JSON.stringify(env));
      const r = await s.call("pay_url", { url: "https://merchant.example/data" });
      assert.ok(r.error && /NO_USDG_REQUIREMENT/.test(r.text) && !/Base/.test(r.text), r.text);
      assert.equal(m.headers.length, 0); assert.equal(base.st.reads, 0, "the Base provider is never used");
      const w = await s.call("wallet_balance", {});
      assert.ok(!/Base/.test(w.text), w.text);
    }
    for (const [k, v] of [["PRIORS_PAY_NETWORKS", "eip155:1"], ["PRIORS_PAY_NETWORKS", KEY], ["PRIORS_BRIDGE", "stargate"], ["PRIORS_BRIDGE", KEY]]) {
      await assert.rejects(createPriorsMcpServer({ env: { PRIORS_STATE_DIR: "off", [k]: v } }), (e) => !e.message.includes(v) && !e.message.includes(KEY.slice(2, 20)) && e.message.includes(k));
    }
  });

  await test("MCP on: fund_base and return_to_robinhood are listed, destructive, and say to get the user's go-ahead; the instructions name them", async () => {
    const s = await mcp({ ...ON, PRIORS_KEY: KEY }, { deps: { credit: fakeCredit(), bridge: fakeBridge() } });
    const { tools } = await s.client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ["fund_base", "return_to_robinhood"]) {
      assert.ok(by[n], n); assert.equal(by[n].annotations.destructiveHint, true);
      assert.ok(/go-ahead first/.test(by[n].description), by[n].description);
      assert.ok(!/\b(first-ever|partner|guaranteed|yield)\b/i.test(by[n].description));
    }
    assert.deepEqual(by.fund_base.inputSchema.required, ["amount_usd"]);
    assert.ok(/USDC on Base/.test(by.pay_url.description));
    const inst = s.client.getInstructions();
    assert.ok(/fund_base, return_to_robinhood\) act immediately/.test(inst) && /Loans stay on Robinhood Chain/.test(inst), inst);
  });

  /** A server with Base on: a wallet holding `usdc` on Base (a ChainMock: pay_url's payer reads it) and `usdg` on 4663. */
  async function baseServer({ usdc = 0n, usdg = 10_000_000n, env = {}, fetchImpl, bridge, credit, deps = {} } = {}) {
    const base = new ChainMock(8453);
    base.setBal(USDC, ME, usdc);
    const fb = bridge || fakeBridge({ float: usdc });
    if (!bridge) fb.floatOf = async (a) => base.bal(USDC, a); // the float pay_url pays from
    const s = await mcp({ ...ON, PRIORS_KEY: KEY, ...env }, { fetchImpl, deps: { credit: credit || fakeCredit({ usdg }), provider: new ChainMock(4663), baseProvider: base, bridge: fb, ...deps } });
    return { ...s, base, bridge: fb };
  }

  await test("MCP pay_url on Base: paid from the float and said in USDC; kept on file with its network and asset; counted against PRIORS_MAX_SPEND_USD", async () => {
    const m = merchant({ amount: "10000" });
    const s = await baseServer({ usdc: 1_000_000n, fetchImpl: m.fetchImpl, env: { PRIORS_MAX_SPEND_USD: "0.20" } });
    const r = await s.call("pay_url", { url: "https://merchant.example/data" });
    assert.ok(!r.error && /^Paid 0\.01 USDC on Base \(x402 v2\) to 0x000000000000000000000000000000000000dEaD/.test(r.text) && /Nothing was borrowed/.test(r.text), r.text);
    assert.equal(ethers.verifyTypedData(DOMAIN_USDC, TWA, m.payloads[0].payload.authorization, m.payloads[0].payload.signature), ME);
    // a pending one stays on file, with its network and asset
    const dir = mkdtempSync(join(tmpdir(), "priors-base-state-"));
    const pm = merchant({ amount: "10000", pending: true });
    const p = await baseServer({ usdc: 1_000_000n, fetchImpl: pm.fetchImpl, env: { PRIORS_STATE_DIR: dir } });
    const pr = await p.call("pay_url", { url: "https://merchant.example/data" });
    assert.ok(/A payment of 0\.01 USDC on Base to 0x0+dEaD was signed and sent/.test(pr.text) && /do NOT call pay_url again/.test(pr.text), pr.text);
    const file = readdirSync(dir).find((f) => f.startsWith("outstanding-"));
    const entry = Object.values(JSON.parse(readFileSync(join(dir, file), "utf8")))[0];
    assert.equal(entry.network, "eip155:8453"); assert.equal(entry.asset, USDC); assert.equal(entry.price, "10000");
    const again = await p.call("pay_url", { url: "https://merchant.example/data" });
    assert.ok(/same signed payment was sent again/.test(again.text) && /0\.01 USDC on Base/.test(again.text), again.text);
    assert.equal(new Set(pm.payloads.map((x) => x.payload.authorization.nonce)).size, 1);
    // PRIORS_MAX_SPEND_USD counts Base payments too: after one of 0.01, a call that may sign up to its 0.10 max passes 0.105
    const both = merchant({ accepts: ["base"] });
    const c = await baseServer({ usdc: 1_000_000n, fetchImpl: both.fetchImpl, env: { PRIORS_MAX_SPEND_USD: "0.105" } });
    assert.ok(!(await c.call("pay_url", { url: "https://merchant.example/a" })).error);
    const over = await c.call("pay_url", { url: "https://merchant.example/b" });
    assert.ok(over.error && /PRIORS_MAX_SPEND_USD/.test(over.text), over.text);
    rmSync(dir, { recursive: true, force: true });
  });

  await test("MCP pay_url on Base with the float short: BASE_FLOAT_SHORT before anything is signed, pointing to fund_base", async () => {
    const m = merchant({ amount: "10000" });
    const s = await baseServer({ usdc: 5_000n, fetchImpl: m.fetchImpl });
    const r = await s.call("pay_url", { url: "https://merchant.example/data", max_borrow_usd: 5 });
    assert.ok(r.error && /takes USDC on Base/.test(r.text) && /holds 0\.005 USDC, less than the price of 0\.01 USDC/.test(r.text) && /Nothing was signed or paid/.test(r.text) && /fund_base/.test(r.text), r.text);
    assert.equal(m.headers.length, 0); assert.equal(s.bridge.calls.length, 0, "no bridging from pay_url in phase 1");
  });

  await test("MCP fund_base: the per-call, per-process, float and borrow caps refuse before anything is done", async () => {
    const s = await baseServer({ env: { PRIORS_MAX_BRIDGE_TOTAL_USD: "12" } });
    const t1 = await s.call("fund_base", { amount_usd: 11 });
    assert.ok(t1.error && /PRIORS_MAX_BRIDGE_USD/.test(t1.text), t1.text);
    assert.ok(!(await s.call("fund_base", { amount_usd: 8 })).error);
    s.bridge.float = 0n; // spent meanwhile: only the process total stops the next one
    const t2 = await s.call("fund_base", { amount_usd: 5 });
    assert.ok(t2.error && /PRIORS_MAX_BRIDGE_TOTAL_USD/.test(t2.text), t2.text);
    const f = await baseServer({ bridge: fakeBridge({ float: 6_000_000n }) });
    const t3 = await f.call("fund_base", { amount_usd: 5 });
    assert.ok(t3.error && /PRIORS_MAX_BASE_FLOAT_USD/.test(t3.text) && /holds 6\.00 now/.test(t3.text), t3.text);
    const t4 = await f.call("fund_base", { amount_usd: 1, max_borrow_usd: 30 });
    assert.ok(t4.error && /PRIORS_MAX_BORROW_USD/.test(t4.text), t4.text);
    assert.equal(f.bridge.calls.length, 0);
    const relay = await baseServer({ env: { PRIORS_BRIDGE: "relay" } });
    const t5 = await relay.call("fund_base", { amount_usd: 1 });
    assert.ok(t5.error && /not built yet/.test(t5.text), t5.text);
  });

  await test("MCP fund_base: the shortfall keeps back Autopay's next 24 h and signed 4663 payments; borrows only with max_borrow_usd, counted like borrow", async () => {
    const credit = fakeCredit({ usdg: 3_000_000n });
    const autopay = { status: async () => ({ declared: true, plan: { on: true, current: true, cap: 25_000_000n }, held: false, loans: [{ loanId: 1n, opens: NOW() + 3600, dueAt: NOW() + 6 * 3600, due: 1_000_000n }] }) };
    const rhMerchant = merchant({ accepts: ["robinhood"], amount: "50000", pending: true });
    const rh = new ChainMock(4663); rh.setBal(USDG, ME, 3_000_000n);
    const s = await baseServer({ credit, fetchImpl: rhMerchant.fetchImpl, env: { PRIORS_AGENT_ID: "7" }, deps: { autopay, provider: rh } });
    assert.ok(/was signed and sent/.test((await s.call("pay_url", { url: "https://merchant.example/data" })).text), "a 4663 payment out");
    const no = await s.call("fund_base", { amount_usd: 3 });
    assert.ok(no.error && /holds 3\.00 USDG on Robinhood Chain and keeps 1\.00 USDG for Autopay loans due in the next 24 hours and 0\.05 USDG for signed payments not settled yet: it is 1\.05 USDG short/.test(no.text) && /pass max_borrow_usd of at least 1\.05/.test(no.text) && /minimum loan/.test(no.text), no.text);
    assert.equal(s.bridge.calls.length, 0);
    // a route Across would refuse is found before any loan
    s.bridge.quoteRefusal = new X.PayError("BRIDGE_FEE_TOO_HIGH", "Across quote refused: the fee is 0.05 USDG (1.66%), above the 1% allowed; nothing was sent");
    const refusedRoute = await s.call("fund_base", { amount_usd: 3, max_borrow_usd: 10 });
    assert.ok(refusedRoute.error && /BRIDGE_FEE_TOO_HIGH/.test(refusedRoute.text) && /Nothing was borrowed or moved/.test(refusedRoute.text), refusedRoute.text);
    assert.equal(credit.rec.filter((x) => x[0] === "borrowGap").length, 0, "no loan for a refused route");
    s.bridge.quoteRefusal = null;
    const yes = await s.call("fund_base", { amount_usd: 3, max_borrow_usd: 10 });
    assert.ok(!yes.error && /Moved 3\.00 USDG from Robinhood Chain to 2\.996 USDC on Base/.test(yes.text) && /Borrowed 5\.00 USDG from the Priors line for agent #7 as loan #42/.test(yes.text), yes.text);
    // borrowGap is asked for the gap (3.00 to move + 1.05 kept - 3.00 held), never the whole amount: max_borrow_usd caps the loan
    const gap = credit.rec.find((x) => x[0] === "borrowGap")[1];
    assert.equal(gap.price, 1_050_000n); assert.equal(gap.balance, 0n); assert.equal(gap.maxBorrow, 10_000_000n); assert.equal(gap.agentId, 7n);
    // the loan counts against PRIORS_MAX_BORROW_TOTAL_USD (25): 5 + 21 is over
    const b = await s.call("borrow", { amount_usd: 21, days: 7 });
    assert.ok(b.error && /PRIORS_MAX_BORROW_TOTAL_USD/.test(b.text), b.text);
  });

  await test("MCP fund_base through the real borrowGap rule: max_borrow_usd equal to the gap is enough; a cap under the pool's minimum loan is refused in dollars, naming what would do", async () => {
    /** A pool that lends (CreditPoolV2's borrow, its Borrowed event), minimum loan 5. */
    const lendingPool = () => {
      const iface = new ethers.Interface(POOL_ABI);
      const calls = [];
      const borrow = async (agentId, amount, term, to, fee) => {
        calls.push({ agentId, amount, term, to, fee });
        const log = iface.encodeEventLog("Borrowed", [77n, agentId, 6228n, amount, fee, BigInt(NOW()) + BigInt(term), to]);
        return { hash: TX("b0"), wait: async () => ({ logs: [log] }) };
      };
      borrow.staticCall = async () => 77n;
      return { calls, interface: iface, getParams: async () => ({ minLoan: 5_000_000n, maxLoan: 50_000_000n, minTerm: 86400n, maxTerm: 30n * 86400n }), quoteFee: async () => [10_000n, 0n, 0n, 0n], borrow };
    };
    const signer = new ethers.Wallet(KEY);
    /** fakeCredit with the real borrowGap (credit.mjs: price above maxBorrow refused, then max(gap, minLoan) against it). */
    const realCredit = (usdg, pool, minLoan = 5_000_000n) => ({ ...fakeCredit({ usdg, minLoan }), borrowGap: (o) => realBorrowGap({ signer, pool, ...o }) });
    const atomic = /\b\d{6,}\b|\[[A-Z_]+\]|pay: /; // atomic units, an error code or the payer's wording: none in a fund_base answer

    // 8 to move, 2 held: a 6 gap, above the minimum loan. The answer names 6; max_borrow_usd 6 borrows exactly 6.
    const p1 = lendingPool();
    const s1 = await baseServer({ credit: realCredit(2_000_000n, p1), env: { PRIORS_AGENT_ID: "7" } });
    const short = await s1.call("fund_base", { amount_usd: 8 });
    assert.ok(short.error && /it is 6\.00 USDG short of moving 8\.00 USDG/.test(short.text) && /A loan from the Priors line for it would be 6\.00 USDG: to take it, pass max_borrow_usd of at least 6\.00/.test(short.text), short.text);
    const r1 = await s1.call("fund_base", { amount_usd: 8, max_borrow_usd: 6 });
    assert.ok(!r1.error && /^Moved 8\.00 USDG from Robinhood Chain/.test(r1.text) && /Borrowed 6\.00 USDG from the Priors line for agent #7 as loan #77/.test(r1.text), r1.text);
    assert.equal(p1.calls.length, 1); assert.equal(p1.calls[0].amount, 6_000_000n); assert.equal(p1.calls[0].to, ME); assert.equal(p1.calls[0].agentId, 7n);
    const over = await s1.call("borrow", { amount_usd: 20, days: 7 });
    assert.ok(over.error && /PRIORS_MAX_BORROW_TOTAL_USD/.test(over.text), `the 6 counts against the 25 total: ${over.text}`);

    // 3 to move, 2 held: a 1 gap, under the minimum loan of 5. max_borrow_usd 1 is refused before any quote or loan,
    // naming 5; max_borrow_usd 5 borrows 5. (Before the fix: PRICE_ABOVE_MAX_BORROW, "pay: price 3000000 ...", for both.)
    const p2 = lendingPool();
    const s2 = await baseServer({ credit: realCredit(2_000_000n, p2), env: { PRIORS_AGENT_ID: "7" } });
    const low = await s2.call("fund_base", { amount_usd: 3, max_borrow_usd: 1 });
    assert.ok(low.error && /it is 1\.00 USDG short of moving 3\.00 USDG/.test(low.text) && /A loan for it would be 5\.00 USDG, the pool's minimum loan, above max_borrow_usd 1\.00/.test(low.text) && /pass max_borrow_usd of at least 5\.00/.test(low.text) && !atomic.test(low.text), low.text);
    assert.equal(p2.calls.length, 0); assert.equal(s2.bridge.calls.length, 0, "no quote, no transfer");
    const r2 = await s2.call("fund_base", { amount_usd: 3, max_borrow_usd: 5 });
    assert.ok(!r2.error && /Borrowed 5\.00 USDG/.test(r2.text), r2.text);
    assert.equal(p2.calls[0].amount, 5_000_000n);

    // the review's case: 10 to move, 9 held, max_borrow_usd 5 (the minimum loan): a loan of 5, not a refusal
    const p3 = lendingPool();
    const s3 = await baseServer({ credit: realCredit(9_000_000n, p3), env: { PRIORS_AGENT_ID: "7" } });
    const r3 = await s3.call("fund_base", { amount_usd: 10, max_borrow_usd: 5 });
    assert.ok(!r3.error && /Moved 10\.00 USDG/.test(r3.text) && /Borrowed 5\.00 USDG/.test(r3.text), r3.text);

    // the minimum loan could not be read: the real rule refuses after the quote, and that is said in dollars too
    const p4 = lendingPool();
    const s4 = await baseServer({ credit: realCredit(2_000_000n, p4, new Error("rpc down")), env: { PRIORS_AGENT_ID: "7" } });
    const noMin = await s4.call("fund_base", { amount_usd: 3 });
    assert.ok(noMin.error && /would be at least 1\.00 USDG \(the pool lends at least its minimum loan, so it may be more\)/.test(noMin.text), noMin.text);
    const m4 = await s4.call("fund_base", { amount_usd: 3, max_borrow_usd: 1 });
    assert.ok(m4.error && /The pool lends at least 5\.00 USDG, above max_borrow_usd 1\.00/.test(m4.text) && /pass max_borrow_usd of at least 5\.00/.test(m4.text) && !atomic.test(m4.text), m4.text);
    assert.equal(p4.calls.length, 0); assert.equal(s4.bridge.calls.filter((c) => c[0] === "fund").length, 0);
  });

  await test("MCP fund_base: a borrow whose answer was lost is counted and said, and nothing is bridged", async () => {
    const credit = fakeCredit({ usdg: 0n, borrowGap: async () => { throw new X.PayError("BORROW_UNCONFIRMED", "a borrow of 5000000 was sent and its answer was lost", { borrowed: 5_000_000n, unconfirmed: true, hash: TX("bb"), cause: new Error("socket hang up") }); } });
    const s = await baseServer({ credit, env: { PRIORS_AGENT_ID: "7" } });
    const r = await s.call("fund_base", { amount_usd: 2, max_borrow_usd: 10 });
    assert.ok(r.error && /may have opened a loan/.test(r.text) && /Nothing was moved to Base/.test(r.text) && r.text.includes(TX("bb")), r.text);
    assert.equal(s.bridge.calls.filter((c) => c[0] === "fund").length, 0);
    const b = await s.call("borrow", { amount_usd: 21, days: 7 });
    assert.ok(b.error && /PRIORS_MAX_BORROW_TOTAL_USD/.test(b.text), b.text);
  });

  // GHSA-24qq: fund_base checked the session caps, then awaited the transfer record and the Base float, and only then
  // counted (GHSA-cq9v's count, two awaits late): a call made once the hold of one stalled in its float read had ended
  // read a total that left the first out, and both borrowed. Clocks scaled as in test-mcp-call-budget.mjs: a 400 ms
  // budget (45 s) and a 200 ms hold (HOLD_MAX_MS, 120 s).
  /** A bridge whose next float read waits until released (a Base RPC that answers late). */
  const stallingFloat = (bridge) => {
    const st = { release: null, reached: null };
    st.reached = new Promise((ok) => {
      const read = bridge.floatOf;
      let armed = true;
      bridge.floatOf = async (a) => { if (armed) { armed = false; ok(); await new Promise((go) => { st.release = go; }); } return read(a); };
    });
    return st;
  };
  const RACE = { PRIORS_AGENT_ID: "7", PRIORS_MAX_BRIDGE_USD: "25", PRIORS_MAX_BRIDGE_TOTAL_USD: "100", PRIORS_MAX_BASE_FLOAT_USD: "100", PRIORS_MAX_BORROW_USD: "25", PRIORS_MAX_BORROW_TOTAL_USD: "25" };

  await test("GHSA-24qq: fund_base counts what it may borrow from its cap check, before its Base reads: a call made after the hold of one stalled there is refused by PRIORS_MAX_BORROW_TOTAL_USD", async () => {
    const credit = fakeCredit({ usdg: 0n }); // an empty wallet: each transfer borrows its whole amount
    const bridge = fakeBridge();
    const stall = stallingFloat(bridge);
    const s = await baseServer({ bridge, credit, env: RACE, deps: { callBudgetMs: 400, holdMaxMs: 200 } });
    const first = await s.call("fund_base", { amount_usd: 25, max_borrow_usd: 25 });
    assert.ok(first.error && /did not finish within/.test(first.text), `the first answers its deadline while its float read waits: ${first.text}`);
    await stall.reached;
    await sleep(400); // the hold has ended (440 ms + 200 ms after the first arrived); the first call still waits for its read
    const second = await s.call("fund_base", { amount_usd: 25, max_borrow_usd: 25 });
    stall.release();
    await sleep(150);
    const gaps = credit.rec.filter((x) => x[0] === "borrowGap");
    assert.equal(gaps.length, 1, `one loan against a session cap of 25, not ${gaps.length} (the second call answered: ${second.text.split("\n")[0]})`);
    assert.equal(gaps[0][1].price, 25_000_000n);
    assert.equal(bridge.calls.filter((c) => c[0] === "fund").length, 1, "one transfer");
    // the call the model made later is the one refused, in words, at its check; the first (the user's go-ahead, whose
    // answer said it may still complete) completes
    assert.ok(second.error && /PRIORS_MAX_BORROW_TOTAL_USD/.test(second.text) && /50\.00 USDG, above 25\.00 USDG/.test(second.text), `the first call's 25 is in the total the second reads: ${second.text}`);
    const more = await s.call("borrow", { amount_usd: 1, days: 7 });
    assert.ok(more.error && /PRIORS_MAX_BORROW_TOTAL_USD/.test(more.text), `the 25 borrowed stays counted: ${more.text}`);
  });

  await test("GHSA-24qq: the same timing cannot pass PRIORS_MAX_BRIDGE_TOTAL_USD; a fund_base refused after its count (float above its cap) gives both totals back", async () => {
    const bridge = fakeBridge();
    const stall = stallingFloat(bridge);
    const s = await baseServer({ bridge, env: { ...RACE, PRIORS_MAX_BRIDGE_TOTAL_USD: "10", PRIORS_MAX_BRIDGE_USD: "10" }, deps: { callBudgetMs: 400, holdMaxMs: 200 } });
    const first = await s.call("fund_base", { amount_usd: 10 });
    assert.ok(first.error && /did not finish within/.test(first.text), first.text);
    await stall.reached;
    await sleep(400);
    const second = await s.call("fund_base", { amount_usd: 10 });
    assert.ok(second.error && /PRIORS_MAX_BRIDGE_TOTAL_USD/.test(second.text), `the first call's 10 is in the bridged total: ${second.text}`);
    stall.release();
    await sleep(150);
    assert.equal(bridge.calls.filter((c) => c[0] === "fund").length, 1, "10 moved, not 20");
    // refused after its count, by the float: nothing stays counted
    const f = await baseServer({ bridge: fakeBridge({ float: 99_000_000n }), env: RACE });
    const full = await f.call("fund_base", { amount_usd: 5, max_borrow_usd: 25 });
    assert.ok(full.error && /PRIORS_MAX_BASE_FLOAT_USD/.test(full.text), full.text);
    const all = await f.call("borrow", { amount_usd: 25, days: 7 });
    assert.ok(!all.error, `the refused call's 25 was given back to PRIORS_MAX_BORROW_TOTAL_USD: ${all.text}`);
  });

  await test("MCP fund_base racing pay_url: one money call at a time (the payment waits for the transfer)", async () => {
    const order = [];
    let release;
    const gate = new Promise((ok) => { release = ok; });
    const bridge = fakeBridge({ fund: async (o, b) => { order.push("fund-start"); await gate; order.push("fund-end"); b.float += o.amount; const t = { route: "across", from: ME, amount: o.amount, outputAmount: o.amount, fee: 0n, quoteTimestamp: NOW(), fillDeadline: NOW() + 7200, startedAt: NOW() }; await o.onDepositSending(t); return { hash: TX("de"), amount: o.amount, outputAmount: o.amount, fee: 0n, feeBps: 0, fillTx: null }; } });
    const m = merchant({ accepts: ["robinhood"], amount: "50000" });
    const inner = m.fetchImpl;
    m.fetchImpl = async (i, n) => { order.push("pay"); return inner(i, n); };
    const rh = new ChainMock(4663); rh.setBal(USDG, ME, 10_000_000n);
    const s = await baseServer({ bridge, fetchImpl: m.fetchImpl, deps: { provider: rh } });
    const f = s.call("fund_base", { amount_usd: 2 });
    await sleep(50);
    const p = s.call("pay_url", { url: "https://merchant.example/data" });
    await sleep(100);
    assert.deepEqual(order, ["fund-start"], "the payment waits in the queue");
    release();
    const [fr, pr] = await Promise.all([f, p]);
    assert.ok(!fr.error && !pr.error, `${fr.text}\n${pr.text}`);
    assert.deepEqual(order.slice(0, 3), ["fund-start", "fund-end", "pay"]);
  });

  await test("MCP fund_base: a transfer that has not landed answers within the call's budget (no hold), and holds only fund_base, return and borrowing for Base", async () => {
    // when the transfer starts: serial() set the call's deadline before that, so the deadline is at most this + 1.5 s
    let startedAt = 0;
    const bridge = fakeBridge({ fund: (o, b) => { startedAt = Date.now(); return pendingFund(o, b); } });
    const m = merchant({ accepts: ["robinhood"], amount: "50000" });
    const rh = new ChainMock(4663); rh.setBal(USDG, ME, 10_000_000n);
    const s = await baseServer({ bridge, fetchImpl: m.fetchImpl, env: { PRIORS_BRIDGE_TIMEOUT_S: "30" }, deps: { provider: rh, callBudgetMs: 1_500 } });
    const t0 = Date.now();
    const r = await s.call("fund_base", { amount_usd: 2 });
    const took = Date.now() - t0;
    assert.ok(took < 1_500, `answered in ${took} ms, within the 1.5 s budget`);
    assert.ok(r.error && /BRIDGE_PENDING/.test(r.text) && /Do NOT call fund_base again/.test(r.text) && !/did not finish within/.test(r.text), r.text);
    const o = bridge.calls[0][1];
    assert.equal(o.timeoutMs, 30_000);
    // the call's deadline is set on arrival, between t0 and the transfer's start: the poll window ends 300 ms before it
    assert.ok(o.pollUntil >= t0 + 1_500 - 300 && o.pollUntil <= startedAt + 1_500 - 300, `the poll window ends before the budget (${o.pollUntil - t0} ms after t0)`);
    const again = await s.call("fund_base", { amount_usd: 1 });
    assert.ok(again.error && /is in flight/.test(again.text) && again.text.includes(TX("de")) && /Nothing was done by this call/.test(again.text), again.text);
    assert.equal(bridge.calls.length, 1, "never sent again");
    const back = await s.call("return_to_robinhood", { amount_usd: "all" });
    assert.ok(back.error && /is in flight/.test(back.text), back.text);
    const pay = await s.call("pay_url", { url: "https://merchant.example/data" });
    assert.ok(!pay.error && /^Paid 0\.05 USDG/.test(pay.text), `payments go on: ${pay.text}`);
    const w = await s.call("wallet_balance", {});
    assert.ok(/A transfer of 2\.00 USDG from Robinhood Chain to Base \(Across\) is in flight/.test(w.text), w.text);
  });

  await test("MCP restart with a transfer in flight: the next process reads it, counts it, and holds Base transfers until Across says it landed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "priors-base-state-"));
    try {
      const env = { PRIORS_STATE_DIR: dir, PRIORS_MAX_BRIDGE_TOTAL_USD: "6" };
      const first = await baseServer({ bridge: fakeBridge({ fund: pendingFund }), env, deps: { callBudgetMs: 1_000 } });
      assert.ok(/BRIDGE_PENDING/.test((await first.call("fund_base", { amount_usd: 5 })).text));
      await first.client.close();
      const file = join(dir, `bridge-${lc(ME)}.json`);
      assert.ok(existsSync(file), "the transfer is on file");
      const rec = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(rec.route, "across"); assert.equal(rec.amount, "5000000"); assert.equal(rec.hash, TX("de"));
      const bridge = fakeBridge({ depositStatus: "pending" });
      const second = await baseServer({ bridge, env });
      const f = await second.call("fund_base", { amount_usd: 1 });
      assert.ok(f.error && /is in flight/.test(f.text), f.text);
      const r = await second.call("return_to_robinhood", { amount_usd: 1 });
      assert.ok(r.error && /is in flight/.test(r.text), r.text);
      assert.ok(/is in flight \(tx 0x(de){32}\), pending/.test((await second.call("wallet_balance", {})).text));
      bridge.depositStatusNow = "filled"; // Across reports it landed: the next look ends the record
      assert.ok(!/in flight/.test((await second.call("wallet_balance", {})).text));
      assert.ok(!existsSync(file), "cleared once Across says filled");
      const over = await second.call("fund_base", { amount_usd: 2 });
      assert.ok(over.error && /PRIORS_MAX_BRIDGE_TOTAL_USD/.test(over.text), `the 5 the previous process sent counts in this one: ${over.text}`);
      assert.ok(!(await second.call("fund_base", { amount_usd: 1 })).error);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test("MCP state written by an older server (no network or asset): read as Robinhood Chain USDG, resent, and the only payments save keeps back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "priors-base-state-"));
    try {
      const key = await X.purchaseKey(new Request("https://merchant.example/data", { method: "GET" }));
      const keyB = await X.purchaseKey(new Request("https://merchant.example/base", { method: "GET" }));
      const old = { paymentHeaders: { "PAYMENT-SIGNATURE": "old-signed-header" }, validBefore: NOW() + 500, price: "50000", payTo: MERCHANT, borrowed: "0", loanId: null };
      const baseEntry = { paymentHeaders: { "PAYMENT-SIGNATURE": "base-signed-header" }, validBefore: NOW() + 500, price: "10000", payTo: MERCHANT, borrowed: "0", loanId: null, network: "eip155:8453", asset: USDC };
      writeFileSync(join(dir, `outstanding-${lc(ME)}.json`), JSON.stringify({ [key]: old, [keyB]: baseEntry }), { mode: 0o600 });
      const seen = [];
      const fetchImpl = async (i, n) => { const q = i instanceof Request ? i : new Request(i, n); seen.push(q.headers.get("PAYMENT-SIGNATURE")); return new Response("{}", { status: 402 }); };
      const saves = [];
      const credit = { ...fakeCredit({ usdg: 1_000_000n }), save: async (a) => { saves.push(a); return { amount: a, hash: TX("5a"), vault: MERCHANT }; }, savingsOf: async () => ({ saved: 0n, wallet: 0n }) };
      const s = await baseServer({ credit, fetchImpl, env: { PRIORS_STATE_DIR: dir } });
      const r = await s.call("pay_url", { url: "https://merchant.example/data" });
      assert.deepEqual(seen, ["old-signed-header"], "the old entry is resent, never re-signed");
      assert.ok(/No new payment was signed/.test(r.text) && /A payment of 0\.05 USDG to/.test(r.text), r.text);
      const sv = await s.call("save", { amount_usd: 0.99 });
      assert.ok(sv.error && /0\.05 USDG of the wallet's USDG is held for signed payments/.test(sv.text), `only the Robinhood Chain entry is kept back: ${sv.text}`);
      assert.ok(!(await s.call("save", { amount_usd: 0.95 })).error && saves.length === 1, "the Base payment is not counted against USDG");
      // and the file, rewritten, keeps both, the old one now with its network
      const after = JSON.parse(readFileSync(join(dir, `outstanding-${lc(ME)}.json`), "utf8"));
      assert.equal(after[key]?.network ?? "eip155:4663", "eip155:4663"); assert.equal(after[keyB].network, "eip155:8453");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test("MCP return_to_robinhood: keeps back the USDC live Base payments need; \"all\" is the rest; one that has not landed holds until it expires", async () => {
    const pm = merchant({ amount: "10000", pending: true });
    const s = await baseServer({ usdc: 3_000_000n, fetchImpl: pm.fetchImpl });
    s.bridge.float = 3_000_000n;
    assert.ok(/was signed and sent/.test((await s.call("pay_url", { url: "https://merchant.example/data" })).text));
    const tooMuch = await s.call("return_to_robinhood", { amount_usd: 3 });
    assert.ok(tooMuch.error && /of which 0\.01 is held for signed payments on Base/.test(tooMuch.text) && /at most 2\.99 can move back/.test(tooMuch.text), tooMuch.text);
    const all = await s.call("return_to_robinhood", { amount_usd: "all" });
    assert.ok(!all.error && /Moved 2\.99 USDC from Base back to Robinhood Chain through Relay: 2\.987 USDG delivered/.test(all.text), all.text);
    assert.equal(s.bridge.calls.at(-1)[1].amount, 2_990_000n);
    // a return whose authorization is out and not delivered: held until it lands or expires
    const ret = async (o) => { const t = { route: "relay", from: ME, amount: o.amount, expectedOut: o.amount - 3_000n, fee: 3_000n, requestId: TX("17"), nonce: TX("54"), validBefore: NOW() + 600, startedAt: NOW() }; await o.onSigned(t); throw new X.PayError("RETURN_PENDING", "returnToRobinhood: Relay has the authorization and had not delivered when the wait ended. Do not sign another before then", { moved: true }); };
    const p = await baseServer({ bridge: fakeBridge({ float: 2_000_000n, ret }) });
    const r = await p.call("return_to_robinhood", { amount_usd: 1 });
    assert.ok(r.error && /RETURN_PENDING/.test(r.text) && /Do NOT call return_to_robinhood again/.test(r.text), r.text);
    const f = await p.call("fund_base", { amount_usd: 1 });
    assert.ok(f.error && /A return of 1\.00 USDC from Base to Robinhood Chain \(Relay request 0x(17){32}\) is in flight/.test(f.text), f.text);
  });

  /** A transfer record as fund_base or return_to_robinhood writes it (bridge-<wallet>.json), in `dir`. */
  const writeFlightRecord = (dir, rec) => writeFileSync(join(dir, `bridge-${lc(ME)}.json`), JSON.stringify(rec), { mode: 0o600 });
  const relayRecord = (o = {}) => ({ route: "relay", amount: "2000000", startedAt: NOW() - 60, validBefore: NOW() + 800, requestId: TX("17"), nonce: TX("54"), expectedOut: "1997000", ...o });

  await test("MCP pay_url on Base during a return to Robinhood Chain: the USDC its authorization may pull is not free (refused, nothing signed); paid once USDC records it used, or once it expires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "priors-base-state-"));
    try {
      writeFlightRecord(dir, relayRecord());
      const m = merchant({ amount: "50000" });
      const s = await baseServer({ usdc: 2_000_000n, fetchImpl: m.fetchImpl, env: { PRIORS_STATE_DIR: dir } });
      assert.ok(/A return of 2\.00 USDC from Base to Robinhood Chain .* is in flight/.test((await s.call("wallet_balance", {})).text));
      const r = await s.call("pay_url", { url: "https://merchant.example/data" });
      assert.ok(r.error && /holds 2\.00 USDC, and 2\.00 of it is held for a return to Robinhood Chain still in flight \(Relay may use its authorization until /.test(r.text) && /less than the price of 0\.05 USDC\. Nothing was signed or paid/.test(r.text), r.text);
      assert.equal(m.headers.length, 0, "no second claim on the same USDC");
      // USDC records the nonce as used: Relay pulled it, the float (1.00 left from other income) is all free
      s.base.st.used = new Set([lc(TX("54"))]);
      s.base.setBal(USDC, ME, 1_000_000n);
      const paid = await s.call("pay_url", { url: "https://merchant.example/data" });
      assert.ok(!paid.error && /^Paid 0\.05 USDC on Base/.test(paid.text), paid.text);
      assert.equal(m.headers.length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // past validBefore (and the clock-skew margin): it can no longer be used, nothing is kept back
    const old = mkdtempSync(join(tmpdir(), "priors-base-state-"));
    try {
      writeFlightRecord(old, relayRecord({ startedAt: NOW() - 3600, validBefore: NOW() - X.SKEW_SECONDS - 5 }));
      const m = merchant({ amount: "50000" });
      const s = await baseServer({ usdc: 2_000_000n, fetchImpl: m.fetchImpl, env: { PRIORS_STATE_DIR: old } });
      assert.ok(!(await s.call("pay_url", { url: "https://merchant.example/data" })).error);
    } finally { rmSync(old, { recursive: true, force: true }); }
    // the authorization's state cannot be read: kept back (refused), never a payment against USDC that may be gone
    const down = mkdtempSync(join(tmpdir(), "priors-base-state-"));
    try {
      writeFlightRecord(down, relayRecord());
      const m = merchant({ amount: "50000" });
      const s = await baseServer({ usdc: 2_000_000n, fetchImpl: m.fetchImpl, env: { PRIORS_STATE_DIR: down }, bridge: { ...fakeBridge({ float: 2_000_000n }), authorizationUsed: async () => { throw new Error("rpc down"); } } });
      const r = await s.call("pay_url", { url: "https://merchant.example/data" });
      assert.ok(r.error && /held for a return to Robinhood Chain/.test(r.text), r.text);
      assert.equal(m.headers.length, 0);
      // a Robinhood Chain payment meanwhile goes on: the return holds the Base float only
      const rhm = merchant({ accepts: ["robinhood"], amount: "50000" });
      const rh = new ChainMock(4663); rh.setBal(USDG, ME, 1_000_000n);
      const t = await baseServer({ usdc: 2_000_000n, fetchImpl: rhm.fetchImpl, env: { PRIORS_STATE_DIR: down }, deps: { provider: rh } });
      const usdg = await t.call("pay_url", { url: "https://merchant.example/data" });
      assert.ok(!usdg.error && /^Paid 0\.05 USDG/.test(usdg.text), usdg.text);
    } finally { rmSync(down, { recursive: true, force: true }); }
  });

  await test("MCP: a transfer record past its time ends even when its route cannot be reached; one still in time stands", async () => {
    const unreachable = async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND api.example"), { code: "ENOTFOUND" }); };
    const cases = [
      ["a Relay return 1 h past validBefore", relayRecord({ startedAt: NOW() - 7200, validBefore: NOW() - 3600 })],
      ["an Across deposit about 15 h past fillDeadline + 12 h", { route: "across", amount: "2000000", startedAt: NOW() - 30 * 3600, fillDeadline: NOW() - 27 * 3600, outputAmount: "1996000", hash: TX("de") }],
    ];
    for (const [what, rec] of cases) {
      const dir = mkdtempSync(join(tmpdir(), "priors-base-state-"));
      try {
        writeFlightRecord(dir, rec);
        const bridge = { ...fakeBridge(), depositStatus: unreachable, relayStatus: unreachable };
        const s = await baseServer({ bridge, env: { PRIORS_STATE_DIR: dir } });
        const w = await s.call("wallet_balance", {});
        assert.ok(!/in flight/.test(w.text), `${what}: ${w.text}`);
        assert.ok(!existsSync(join(dir, `bridge-${lc(ME)}.json`)), `${what}: the record is gone`);
        const f = await s.call("fund_base", { amount_usd: 1 });
        assert.ok(!f.error && /^Moved 1\.00 USDG/.test(f.text), `${what}: ${f.text}`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    // in time, its route unreachable: the record stands (nothing can say it landed), and the time it shows is ahead
    const dir = mkdtempSync(join(tmpdir(), "priors-base-state-"));
    try {
      writeFlightRecord(dir, relayRecord());
      const s = await baseServer({ bridge: { ...fakeBridge(), depositStatus: unreachable, relayStatus: unreachable }, env: { PRIORS_STATE_DIR: dir } });
      const f = await s.call("fund_base", { amount_usd: 1 });
      assert.ok(f.error && /is in flight/.test(f.text), f.text);
      const until = /expires at (\S+?Z)/.exec(f.text);
      assert.ok(until && Date.parse(until[1]) > Date.now(), f.text);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test("MCP wallet_balance and credit_status: the Base float, and a warning when a loan is due within 24 h while money sits on Base", async () => {
    const loans = [{ loanId: 9n, principal: 5_000_000n, fee: 50_000n, due: 5_050_000n, dueAt: NOW() + 12 * 3600 }];
    const s = await baseServer({ bridge: fakeBridge({ float: 2_000_000n }), credit: fakeCredit({ loans }), env: { PRIORS_AGENT_ID: "7" } });
    const w = await s.call("wallet_balance", {});
    assert.ok(/On Base it holds 2\.00 USDC: its Base float/.test(w.text), w.text);
    const c = await s.call("credit_status", {});
    assert.ok(/On Base it holds 2\.00 USDC/.test(c.text) && /Loan #9 is due within 24 hours and 2\.00 USDC sits on Base/.test(c.text) && /return_to_robinhood/.test(c.text), c.text);
    const later = await baseServer({ bridge: fakeBridge({ float: 2_000_000n }), credit: fakeCredit({ loans: [{ ...loans[0], dueAt: NOW() + 3 * 86400 }] }), env: { PRIORS_AGENT_ID: "7" } });
    assert.ok(!/is due within 24 hours/.test((await later.call("credit_status", {})).text));
    const other = await s.call("credit_status", { agent_id: 99 });
    assert.ok(!/Base/.test(other.text), "another agent's status says nothing of this wallet's float");
  });

  await test("MCP: PRIORS_BASE_RPC is cut from every answer, like PRIORS_RPC (whole, host, token), Base on or off", async () => {
    const secret = "https://base-secret.example:8545/v2/token-xyz789secret";
    const leaky = async () => { throw new Error(`could not reach ${secret} (base-secret.example: ENOTFOUND)`); };
    const s = await baseServer({ bridge: { ...fakeBridge(), floatOf: leaky }, env: { PRIORS_BASE_RPC: secret } });
    const outs = [await s.call("wallet_balance", {}), await s.call("fund_base", { amount_usd: 1 }), await s.call("return_to_robinhood", { amount_usd: "all" })];
    assert.ok(outs.some((o) => /<rpc>|<redacted>/.test(o.text)), outs.map((o) => o.text).join("\n"));
    for (const o of outs) assert.ok(!o.text.includes("token-xyz789secret") && !o.text.includes("base-secret.example"), o.text);
    const off = await mcp({ PRIORS_KEY: KEY, PRIORS_BASE_RPC: secret }, { deps: { credit: { ...fakeCredit(), balances: leaky } } });
    const r = await off.call("wallet_balance", {});
    assert.ok(r.error && !r.text.includes("token-xyz789secret") && !r.text.includes("base-secret.example"), r.text);
  });

  await test("MCP fund_base through the real bridge.mjs: an exact approval and one deposit on a mock chain, recorded then cleared", async () => {
    const rh = new ChainMock(4663);
    rh.setBal(USDG, ME, 10_000_000n);
    const dir = mkdtempSync(join(tmpdir(), "priors-base-state-"));
    try {
      const base = new ChainMock(8453);
      const api = acrossApi();
      const s = await mcp({ ...ON, PRIORS_KEY: KEY, PRIORS_STATE_DIR: dir }, { deps: { credit: fakeCredit({ usdg: 10_000_000n }), provider: rh, baseProvider: base, bridgeFetch: api.fetchImpl } });
      const r = await s.call("fund_base", { amount_usd: 5 });
      assert.ok(!r.error && /Moved 5\.00 USDG from Robinhood Chain to 4\.9935 USDC on Base through Across \(fee 0\.0065, 0\.13%\)/.test(r.text) && /filled on Base in tx/.test(r.text), r.text);
      assert.deepEqual(rh.st.log, ["approve", "deposit"]);
      assert.equal(rh.st.sent[0].args[1], 5_000_000n);
      assert.equal(rh.st.sent[1].args.outputAmount, 4_993_500n);
      assert.ok(!existsSync(join(dir, `bridge-${lc(ME)}.json`)), "the record is cleared once filled");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // ---- forks ------------------------------------------------------------------------------------------------------
  console.log("x402 on Base: forks");
  if (!fork) { console.log("  skipped: --fork not given"); return; }
  if (!process.env.BASE_RPC_URL) console.log("  skipped Base fork: set BASE_RPC_URL");
  else await forkBase(test);
  if (!process.env.RPC_URL) console.log("  skipped Robinhood Chain fork: set RPC_URL");
  else await forkRobinhood(test);
}

/** anvil on a fork of `url` at `port`; resolves to { provider, stop }. */
async function startAnvil(url, port, chainId) {
  const anvilBin = process.env.ANVIL || (spawnSync("anvil", ["--version"]).status === 0 ? "anvil" : join(homedir(), ".foundry/bin/anvil"));
  if (anvilBin !== "anvil" && !existsSync(anvilBin)) throw new Error("anvil not found (install foundry or set ANVIL)");
  const anvil = spawn(anvilBin, ["--fork-url", url, "--port", String(port), "--silent", "--no-rate-limit"], { stdio: "ignore" });
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, ethers.Network.from(chainId), { staticNetwork: true, cacheTimeout: -1, pollingInterval: 200 });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = /anvil/i.test(await provider.send("web3_clientVersion", [])); } catch (_) { await sleep(500); } }
  if (!up) { anvil.kill("SIGTERM"); throw new Error("anvil did not start"); }
  return { provider, stop: () => anvil.kill("SIGTERM") };
}

async function forkBase(test) {
  const { dealErc20 } = await import("./fork-v2.mjs");
  const { provider, stop } = await startAnvil(process.env.BASE_RPC_URL, 8576, 8453);
  const servers = [];
  try {
    const usdc = new ethers.Contract(USDC, ["function name() view returns (string)", "function version() view returns (string)", "function balanceOf(address) view returns (uint256)", "function authorizationState(address,bytes32) view returns (bool)", "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"], provider);
    await test("fork (Base): USDC's name and version on chain are the allowlist's (USD Coin / 2)", async () => {
      assert.equal(await usdc.name(), X.BASE_USDC.eip712.name);
      assert.equal(await usdc.version(), X.BASE_USDC.eip712.version);
    });
    // a mock seller on Base: a USDC 402 (as CoinGecko's live one), settled on the fork with transferWithAuthorization
    const hot = new ethers.Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", provider); // anvil dev account 1: fork-only
    await provider.send("anvil_setBalance", [hot.address, "0x56BC75E2D63100000"]);
    const seller = ethers.Wallet.createRandom().address;
    const req = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: seller, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
    const pr = { x402Version: 2, resource: { url: "http://127.0.0.1/paid", description: "fork seller", mimeType: "application/json" }, accepts: [req] };
    let settles = 0;
    const srv = createServer(async (q, res) => {
      try {
        const sig = q.headers["payment-signature"];
        if (!sig) { res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr), "content-type": "application/json" }); return res.end("{}"); }
        const p = decodePaymentSignatureHeader(sig);
        const a = p.payload.authorization;
        if (ethers.verifyTypedData(DOMAIN_USDC, TWA, a, p.payload.signature) !== ethers.getAddress(a.from) || !same(a.to, seller) || a.value !== req.amount) { res.writeHead(402); return res.end("{\"bad\":true}"); }
        const s = ethers.Signature.from(p.payload.signature);
        const tx = await usdc.connect(hot).transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, s.v, s.r, s.s);
        await tx.wait();
        settles++;
        res.writeHead(200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: tx.hash, network: "eip155:8453", payer: a.from }), "content-type": "application/json" });
        res.end(JSON.stringify({ data: "paid on base" }));
      } catch (e) { res.writeHead(500); res.end(String(e.message).slice(0, 100)); }
    }).listen(0);
    servers.push(srv);
    await new Promise((r) => srv.once("listening", r));
    const url = `http://127.0.0.1:${srv.address().port}/paid`;

    await test("fork (Base): a seller's USDC 402 is paid by createPayer from the Base float and settled with transferWithAuthorization", async () => {
      const payer = ethers.Wallet.createRandom().connect(provider);
      await dealErc20(provider, USDC, payer.address, 1_000_000n);
      const r = await X.createPayer({ signer: payer, networks: BOTH, baseProvider: provider, maxPrice: "$0.10" }).pay(url);
      assert.equal(r.response.status, 200, `answered ${r.response.status}`);
      assert.deepEqual(await r.response.json(), { data: "paid on base" });
      assert.equal(r.paid, 10_000n); assert.equal(r.network, "eip155:8453"); assert.ok(r.settlement?.success);
      assert.equal(await usdc.balanceOf(seller), 10_000n, "the seller got 0.01 USDC");
      assert.equal(await usdc.balanceOf(payer.address), 990_000n, "paid once");
      const nonce = decodePaymentSignatureHeader(r.signed.paymentHeaders["PAYMENT-SIGNATURE"]).payload.authorization.nonce;
      assert.equal(await usdc.authorizationState(payer.address, nonce), true);
      assert.equal(settles, 1);
    });

    await test("fork (Base): an empty float is refused (BASE_FLOAT_SHORT) before anything is signed", async () => {
      const empty = new CountingWallet(ethers.Wallet.createRandom().privateKey, provider);
      await rejects(X.createPayer({ signer: empty, networks: BOTH, baseProvider: provider }).pay(url), "BASE_FLOAT_SHORT");
      assert.equal(empty.signs, 0);
    });
  } finally { for (const s of servers) s.close(); stop(); }
}

async function forkRobinhood(test) {
  const { dealErc20 } = await import("./fork-v2.mjs");
  const { provider, stop } = await startAnvil(process.env.RPC_URL, 8577, 4663);
  try {
    await test("fork (Robinhood Chain): fundBase sends an exact approval and one depositV3 to the real Across spoke; FundsDeposited carries what was asked", async () => {
      const agent = ethers.Wallet.createRandom().connect(provider);
      await provider.send("anvil_setBalance", [agent.address, "0x56BC75E2D63100000"]);
      await dealErc20(provider, USDG, agent.address, 10_000_000n);
      const spoke = new ethers.Contract(SPOKE, [...B.ACROSS_SPOKE_ABI, "function numberOfDeposits() view returns (uint32)"], provider);
      const usdg = new ethers.Contract(USDG, ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"], provider);
      const before = { n: await spoke.numberOfDeposits(), bal: await usdg.balanceOf(agent.address), spoke: await usdg.balanceOf(SPOKE) };
      // The quote is Across's live one (a GET: read-only, it creates nothing); if the API is out of reach, a quote shaped
      // like it at the fork's own time. The fill is off chain (no relayer fills a fork): the status says filled.
      const block = await provider.getBlock("latest");
      let live = true;
      const fetchImpl = async (input, init) => {
        const u = new URL(typeof input === "string" ? input : input.url);
        if (u.pathname === "/api/deposit/status") return json({ status: "filled", fillTxnRef: TX("fe") });
        try { const r = await fetch(input, init); if (r.ok) return r; } catch (_) { /* fall through */ }
        live = false;
        return json(acrossQuoteBody(BigInt(u.searchParams.get("amount")), block.timestamp));
      };
      const r = await B.fundBase({ signer: agent, amount: 5_000_000n, fetchImpl, pollMs: 10, now: () => Math.max(NOW(), block.timestamp) });
      console.log(`        (quote: ${live ? "Across's live API" : "synthetic, the API was out of reach"}; fee ${X.formatUsdg(r.fee)} USDG)`);
      assert.equal(r.mismatch, undefined, `event fields differ: ${r.mismatch}`); assert.equal(r.noEvent, undefined);
      // the approval was exactly the amount, and the spoke pulled all of it
      const ap = await provider.getTransactionReceipt(r.approveHash);
      const approval = ap.logs.map((l) => { try { return ERC20_IFACE.parseLog(l); } catch (_) { return null; } }).find((x) => x?.name === "Approval");
      assert.equal(approval.args.spender, SPOKE); assert.equal(approval.args.value, 5_000_000n);
      assert.equal(await usdg.allowance(agent.address, SPOKE), 0n, "nothing left approved");
      const rc = await provider.getTransactionReceipt(r.hash);
      assert.equal(rc.status, 1);
      const ev = rc.logs.filter((l) => same(l.address, SPOKE)).map((l) => spoke.interface.parseLog(l)).find((x) => x?.name === "FundsDeposited");
      const addr = (x) => ethers.getAddress(ethers.dataSlice(x, 12));
      assert.equal(addr(ev.args.depositor), agent.address); assert.equal(addr(ev.args.recipient), agent.address);
      assert.equal(addr(ev.args.inputToken), USDG); assert.equal(addr(ev.args.outputToken), USDC);
      assert.equal(ev.args.inputAmount, 5_000_000n); assert.equal(ev.args.outputAmount, r.outputAmount);
      assert.equal(ev.args.destinationChainId, 8453n); assert.equal(ev.args.message, "0x");
      assert.equal(ev.args.fillDeadline, BigInt(r.fillDeadline));
      assert.equal(ev.args.depositId, BigInt(before.n), "the next deposit id");
      assert.equal(await spoke.numberOfDeposits(), before.n + 1n, "one deposit");
      assert.equal(await usdg.balanceOf(agent.address), before.bal - 5_000_000n);
      assert.equal(await usdg.balanceOf(SPOKE), before.spoke + 5_000_000n);
    });
  } finally { stop(); }
}

// ---- standalone -------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0, failed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed++; console.log("  ok  ", name); } catch (e) { failed++; console.log("  FAIL", name, "\n       ", e?.stack?.split("\n").slice(0, 5).join("\n        ") || e); }
  };
  await runX402BaseTests({ test, fork: process.argv.includes("--fork") });
  console.log(`\nx402 on Base: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
void fileURLToPath;
