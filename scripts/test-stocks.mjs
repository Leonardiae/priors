// Stock lines in the SDK and the packages, with no network: Score v2 2.0.1 counts the stock vault's loans as the
// borrower's own money; every surface that reports what an agent can draw reports min(available, borrowRoom) for a
// stock line; @priors/x402 and @priors/mcp read the vault.
//   node scripts/test-stocks.mjs
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { weightsFor, WEIGHTS_BY_VERSION, DEFAULT_WEIGHTS } from "../sdk/score-v2.mjs";
import { scoreAll } from "../sdk/score-v2-inputs.mjs";
import { STOCK_VAULT_ABI, STOCK_ASSETS, borrowable, collateralOf } from "../sdk/stock-vault.mjs";
import * as credit from "../packages/x402/src/credit.mjs";
import { createPriorsMcpServer, collateralText } from "../packages/mcp/src/server.mjs";

let n = 0;
const ok = (m) => { n++; console.log("  ok  ", m); };
const NOW = 1_790_000_000, DAY = 86400;
const $ = (x) => Math.round(x * 1e6);

// ---------------------------------------------------------------------------------------------------------------
// Score v2 2.0.1: the stock vault's loans are the borrower's own money
// ---------------------------------------------------------------------------------------------------------------
{
  const VAULT = 9000, TREASURY = 10;
  const loans = (agentId, sponsorId, count, size, owner) => Array.from({ length: count }, (_, i) => {
    const issuedAt = NOW - (29 - i * 4) * DAY;
    return { id: agentId * 100 + i, agentId, sponsorId, era: "v2", owner, principal: $(size), fee: $(size * 0.002), issuedAt, dueAt: issuedAt + 8 * DAY, closedAt: issuedAt + 7 * DAY, status: "repaid" };
  });
  const snap = (meta = {}) => ({
    meta: { timestamp: NOW, treasuryAgentId: TREASURY, stockVaultAgentId: VAULT, ...meta }, events: [],
    agents: [
      { id: TREASURY, owner: "0x" + "71".repeat(20), sponsor: 0, isRoot: true, delegatedIn: 0, enrolledAt: NOW - 400 * DAY },
      { id: VAULT, owner: "0x" + "57".repeat(20), sponsor: 0, isRoot: true, delegatedIn: 0, enrolledAt: NOW - 60 * DAY },
      { id: 100, owner: "0x" + "a1".repeat(20), sponsor: VAULT, isRoot: false, delegatedIn: $(250), enrolledAt: NOW - 31 * DAY }, // its own SPY behind it
      { id: 101, owner: "0x" + "b1".repeat(20), sponsor: 102, isRoot: false, delegatedIn: $(250), enrolledAt: NOW - 31 * DAY }, // backed by its owner's own root
      { id: 102, owner: "0x" + "b1".repeat(20), sponsor: 0, isRoot: true, delegatedIn: 0, enrolledAt: NOW - 60 * DAY },
      { id: 200, owner: "0x" + "c1".repeat(20), sponsor: TREASURY, isRoot: false, delegatedIn: $(5), enrolledAt: NOW - 31 * DAY }, // an honest $5 agent
    ],
    loans: [...loans(100, VAULT, 7, 125, "0x" + "a1".repeat(20)), ...loans(101, 102, 7, 125, "0x" + "b1".repeat(20)), ...loans(200, TREASURY, 3, 5, "0x" + "c1".repeat(20))],
  });
  const at = (scores, id) => scores.find((s) => Number(s.agentId) === id);
  const W200 = weightsFor("2.0.0"), W201 = weightsFor("2.0.1");
  const old = scoreAll(snap(), { now: NOW, weights: W200 }), neu = scoreAll(snap(), { now: NOW, weights: W201 });
  assert.ok(at(old, 100).score >= 300, `under 2.0.0 the self-collateralised agent builds a record of others' risk (${at(old, 100).score})`);
  assert.equal(at(neu, 100).score, at(neu, 101).score, "under 2.0.1 it scores exactly like an agent backed by its owner's own root");
  assert.ok(at(old, 100).score - at(neu, 100).score >= 200, `${at(old, 100).score} -> ${at(neu, 100).score}`);
  assert.equal(at(neu, 200).score, at(old, 200).score, "the honest $5 agent is unchanged");
  assert.equal(at(neu, 100).version, "2.0.1");
  ok(`score 2.0.1: a self-collateralised agent at day 30 goes from ${at(old, 100).score} to ${at(neu, 100).score} (= a self-funded one); the honest $5 agent stays at ${at(neu, 200).score}`);

  const noId = scoreAll(snap({ stockVaultAgentId: undefined }), { now: NOW, weights: W201 });
  assert.equal(at(noId, 100).score, at(old, 100).score, "without the vault's id in the snapshot the rule has nothing to apply to");
  assert.equal(DEFAULT_WEIGHTS.version, "2.0.0", "2.0.0 stays the engine's default (weightsFor() with no version)");
  const strip = (w) => { const c = JSON.parse(JSON.stringify(w)); delete c.backers.ownCollateralRoots; delete c.backers.ownCollateralWhy; delete c.version; delete c.published; return c; };
  assert.deepEqual(strip(W201), strip(W200), "2.0.1 changes no number, only adds the rule");
  assert.throws(() => weightsFor("9.9.9"), /unknown weights version/);
  assert.deepEqual(Object.keys(WEIGHTS_BY_VERSION).sort(), ["2.0.0", "2.0.1", "2.0.2"]);
  ok("score 2.0.1: inert without meta.stockVaultAgentId; 2.0.0 still the engine default; no weight number changed; unknown versions refused");
}

// ---------------------------------------------------------------------------------------------------------------
// What a stock line can draw, and its collateral (fixtures)
// ---------------------------------------------------------------------------------------------------------------
const SPY = STOCK_ASSETS.find((a) => a.symbol === "SPY");
assert.ok(SPY && STOCK_ASSETS.length === 35, "the 35 accepted tokens, SPY among them (deployments/stock-assets.4663.json)");
const COL = { token: SPY.token, symbol: "SPY", decimals: 18, amount: 5n * 10n ** 16n, value: 38_560_633n, ltvBps: 5000n, borrowRoom: 19_280_316n, hold: 0, holdReason: "", status: "open", closing: false };
{
  assert.equal(borrowable(25_000_000n, COL), 19_280_316n);
  assert.equal(borrowable(4_000_000n, COL), 4_000_000n, "the pool's own figure when it is the smaller");
  assert.equal(borrowable(4_000_000n, null), 4_000_000n, "any other line: the pool's figure");
  assert.equal(borrowable(9n, { ...COL, borrowRoom: 0n }), 0n, "a hold (borrowRoom 0) stops every draw");
  assert.equal(collateralOf(null), null);
  assert.deepEqual(collateralOf({ ...COL, status: 1, statusName: "open", agentId: 7n, line: 1n, depositor: "0x1", owner: "0x1", openedAt: 1 }), COL);
  ok("SDK borrowable and collateralOf: min(available, borrowRoom) on a stock line, the pool's figure otherwise");

  // @priors/x402 creditStatus
  const agent = (sponsor) => ({ enrolledAt: 1n, isRoot: false, defaulted: false, frozen: false, sponsor, premiumBps: 0n, delegatedIn: 25_000_000n, principalOut: 0n, loansRepaid: 0n, qualifiedRepaid: 0n, volumeRepaid: 0n, feesPaid: 0n });
  const vault = { agentId: async () => 9000n, getPosition: async () => ({ token: SPY.token, amount: 5n * 10n ** 16n, status: 1n, closing: false, line: 19_280_316n, depositor: "0x1", openedAt: 1n }), valueOf: async () => [true, 38_560_633n], borrowRoom: async () => 19_280_316n, lendStatus: async () => 0n, ltvOf: async () => { throw new Error("no ltvOf yet"); }, params: async () => ({ ltvBps: 5000n }) };
  const c = (sponsor, sv = vault) => ({ pool: { getAgent: async () => agent(sponsor), loansOf: async () => [] }, lens: { score: async () => 0n }, registry: { ownerOf: async () => "0x1" }, stockVault: sv });
  const st = await credit.creditStatus(c(9000n), 100);
  assert.equal(st.available, 19_280_316n);
  assert.deepEqual({ ...st.collateral }, { token: SPY.token, amount: 5n * 10n ** 16n, value: 38_560_633n, ltvBps: 5000n, borrowRoom: 19_280_316n, hold: 0, holdReason: "", status: "open", closing: false });
  const other = await credit.creditStatus(c(10n), 200);
  assert.equal(other.collateral, null); assert.equal(other.available, 25_000_000n);
  const none = await credit.creditStatus(c(9000n, null), 100);
  assert.equal(none.collateral, null, "without a vault configured nothing is read");
  ok("@priors/x402: creditStatus carries a stock line's collateral (LTV from params when the vault has no per-token LTV) and min(available, borrowRoom)");

  // After an issuer burn from the vault (it holds less of a token than it owes), a position is paid its share,
  // amount x balance / held, not what was deposited: every surface values that, and says so (our audit, 2026-09-30).
  const DEP = 2n * 10n ** 17n, HELD = 4n * 10n ** 17n, BAL = 16n * 10n ** 16n, PAID = 8n * 10n ** 16n; // 0.2 deposited, 0.08 paid
  const VAULT_AT = "0x0000000000000000000000000000000000005700";
  const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  const px = (amt) => (amt * 771_212_660n) / 10n ** 18n; // $771.21 a share, USDG base units
  const pos = { depositor: "0x0000000000000000000000000000000000000001", owner: "0x0000000000000000000000000000000000000001", token: SPY.token, openedAt: 1n, closing: false, status: 1n, line: 19_280_316n, amount: DEP };
  const fakeVault = (bal) => ({
    target: VAULT_AT, runner: { call: async () => erc20.encodeFunctionResult("balanceOf", [bal]) },
    agentId: async () => 9000n, getPosition: async () => pos, held: async () => HELD, valueOf: async (_t, amt) => [true, px(amt)],
    borrowRoom: async () => 1_000_000n, lendStatus: async () => 0n, ltvOf: async () => 5000n, params: async () => ({ ltvBps: 5000n }),
  });
  const { stockPosition: sdkPosition, stockPositions: sdkPositions } = await import("../sdk/stock-vault.mjs");
  const short = await sdkPosition(fakeVault(BAL), 100);
  assert.equal(short.amount, DEP, "amount stays what was deposited");
  assert.equal(short.payout, PAID, "payout: what the vault would pay it now");
  assert.equal(short.value, px(PAID), "valued on what it would be paid");
  const whole = await sdkPosition(fakeVault(HELD), 100);
  assert.equal(whole.payout, undefined, "no shortfall: no payout field, nothing changes");
  assert.equal(whole.value, px(DEP));
  // many positions in one Multicall3-shaped read (here one by one, on a fake provider)
  const viface = new ethers.Interface(STOCK_VAULT_ABI);
  const fakeProvider = (bal) => ({
    call: async (tx) => {
      if (tx.to.toLowerCase() === SPY.token.toLowerCase()) return erc20.encodeFunctionResult("balanceOf", [bal]);
      const f = viface.getFunction(tx.data.slice(0, 10)); const args = viface.decodeFunctionData(f, tx.data);
      const out = { getPosition: [pos], borrowRoom: [1_000_000n], held: [HELD], valueOf: f.name === "valueOf" ? [true, px(args[1])] : null, lendStatus: [0n], ltvOf: [5000n], params: [5000n, 250_000_000n, 1_000_000_000n, 604800n] }[f.name];
      return viface.encodeFunctionResult(f, out);
    },
  });
  const many = await sdkPositions(fakeProvider(BAL), VAULT_AT, [100], { multicall: null });
  assert.equal(many["100"].payout, PAID); assert.equal(many["100"].value, px(PAID));
  assert.equal((await sdkPositions(fakeProvider(HELD), VAULT_AT, [100], { multicall: null }))["100"].payout, undefined);
  assert.equal(collateralOf(short).payout, PAID, "the collateral block carries the payout");
  assert.equal(collateralOf(whole).payout, undefined);
  ok("SDK: after an issuer burn, stockPosition and stockPositions value what the position would be paid and carry it as `payout`; no shortfall, no change");

  const xs = await credit.stockPosition({ stockVault: fakeVault(BAL) }, 100, [{ symbol: "SPY", token: SPY.token, decimals: 18 }]);
  assert.equal(xs.payout, PAID); assert.equal(xs.value, px(PAID)); assert.equal(xs.amount, DEP);
  const xc = await credit.creditStatus(c(9000n, fakeVault(BAL)), 100);
  assert.equal(xc.collateral.payout, PAID); assert.equal(xc.collateral.value, px(PAID));
  assert.equal((await credit.creditStatus(c(9000n, fakeVault(HELD)), 100)).collateral.payout, undefined);
  assert.ok(/Backed by 0\.08 SPY, of 0\.2 deposited: an issuer burn left the vault short/.test(collateralText(xs)), collateralText(xs));
  ok("@priors/x402 and @priors/mcp: stockPosition and creditStatus value the payout after an issuer burn, and the text says so");
}

// ---------------------------------------------------------------------------------------------------------------
// @priors/mcp: stock_assets, stock_position, and credit_status on a stock line (fake chain)
// ---------------------------------------------------------------------------------------------------------------
{
  const now = Math.floor(Date.now() / 1000);
  const OWNER = "0x" + "ab".repeat(20);
  const base = {
    balances: async (a) => ({ address: a, usdg: 12_340_000n, native: 10n ** 15n }),
    status: async (id) => ({ agentId: BigInt(id), owner: OWNER, enrolled: true, isRoot: false, defaulted: false, frozen: false, sponsor: 6228n, premiumBps: 0n, line: 5_000_000n, drawn: 1_000_000n, available: 4_000_000n, loansRepaid: 3n, qualifiedRepaid: 2n, volumeRepaid: 15_000_000n, feesPaid: 150_000n, enrolledAt: now - 86400 * 10, score: 612, openLoans: [] }),
    isController: async () => true,
    agentsOf: async () => [7n],
    stockAssets: async () => [
      { symbol: "SPY", name: "SPDR S&P 500 ETF", token: SPY.token, answer: 77121266000n, price: 771.21266, updatedAt: now - 600, usable: true, hold: 0, holdReason: "", ltvBps: 5000n },
      { symbol: "RGTI", name: "Rigetti Computing", token: "0x" + "99".repeat(20), answer: 1850000000n, price: 18.5, updatedAt: now - 600, usable: false, hold: 1, holdReason: "the price moved sharply", ltvBps: 3500n },
    ],
    stockPosition: async (id) => (BigInt(id) === 8n ? null : { agentId: BigInt(id), token: SPY.token, symbol: "SPY", decimals: 18, amount: 5n * 10n ** 16n, value: 38_560_633n, ltvBps: 5000n, line: 19_280_316n, borrowRoom: 19_280_316n, hold: 0, holdReason: "", status: "open", closing: false, depositor: OWNER, openedAt: now - 3600 }),
  };
  const mcp = async (creditFake) => {
    const server = await createPriorsMcpServer({ env: {}, fetchImpl: async () => new Response("{}", { status: 404 }), deps: { credit: creditFake } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { error: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
    };
    return { client, call };
  };
  const { client, call } = await mcp(base);
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const t of ["stock_assets", "stock_position"]) assert.equal(byName[t]?.annotations?.readOnlyHint, true, `${t} is listed and read-only`);
  const a = await call("stock_assets", {});
  assert.ok(!a.error && /accepts 2 stock tokens; 1 of those shown take new lines now/.test(a.text) && /SPY \(SPDR S&P 500 ETF\): \$771\.21/.test(a.text) && /lends at 50% of value/.test(a.text) && /no new loans \(the price moved sharply\)/.test(a.text), a.text);
  const one = await call("stock_assets", { symbol: "spy" });
  assert.ok(!one.error && !/RGTI/.test(one.text) && /SPY/.test(one.text), one.text);
  const nope = await call("stock_assets", { symbol: "NOPE" });
  assert.ok(nope.error && /NOPE is not among the 2 stock tokens/.test(nope.text), nope.text);
  const p = await call("stock_position", { agent_id: 7 });
  assert.ok(!p.error && /Backed by 0\.05 SPY worth 38\.560633 USDG to the vault, at 50% loan-to-value: 19\.280316 USDG can be drawn now\./.test(p.text), p.text);
  const np = await call("stock_position", { agent_id: 8 });
  assert.ok(!np.error && /has no stock position/.test(np.text), np.text);
  const onStock = { ...base, status: async (id) => ({ ...(await base.status(id)), available: 19_280_316n, collateral: { token: SPY.token, amount: 5n * 10n ** 16n, value: null, ltvBps: 5000n, borrowRoom: 19_280_316n, hold: 1, holdReason: "the price moved sharply", status: "open", closing: false } }) };
  const { call: c2 } = await mcp(onStock);
  const cs = await c2("credit_status", { agent_id: 7 });
  assert.ok(!cs.error && /available 19\.280316 USDG/.test(cs.text) && /not priced for new loans right now/.test(cs.text) && /New loans wait: the price moved sharply\./.test(cs.text), cs.text);
  ok("@priors/mcp: stock_assets and stock_position read the vault (read-only tools); credit_status shows a stock line's collateral and hold");
}

// ---------------------------------------------------------------------------------------------------------------
// @priors/mcp over a node like the public one: single calls answered, a batch of 100 refused with HTTP 429 (which
// ethers retries until its 5-minute timeout): the server sends one call per request, so stock_assets' ~140 reads answer
// ---------------------------------------------------------------------------------------------------------------
{
  const { createServer } = await import("node:http");
  let batches = 0, singles = 0;
  const node = createServer(async (req, res) => {
    let body = ""; for await (const ch of req) body += ch;
    const msg = JSON.parse(body);
    if (Array.isArray(msg)) { batches++; res.statusCode = 429; return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: 429, message: "Too Many Requests" } })); }
    singles++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(msg.method === "eth_call" ? { jsonrpc: "2.0", id: msg.id, result: "0x" + "00".repeat(32 * 8) } : { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "not served here" } }));
  });
  await new Promise((r) => node.listen(0, "127.0.0.1", r));
  try {
    const server = await createPriorsMcpServer({ env: { PRIORS_RPC: `http://127.0.0.1:${node.address().port}` } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    await Promise.race([client.callTool({ name: "stock_assets", arguments: {} }), new Promise((_, rej) => setTimeout(() => rej(new Error("stock_assets did not answer within 15 s")), 15000))]);
    assert.equal(batches, 0, `batches sent: ${batches}`);
    assert.ok(singles > 35, `single calls: ${singles}`);
    await client.close();
  } finally { node.closeAllConnections(); node.close(); }
  ok("@priors/mcp: one call per request (the public node answers a 100-call batch with 429): stock_assets answers in time");
}

console.log(`\n${n} checks passed`);
