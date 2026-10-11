// @priors/x402's record gate (packages/x402/src/gate.mjs) inside a real x402ResourceServer (@x402/core): a payment the
// merchant's policy refuses never reaches the facilitator, so it is never verified or settled; one it accepts goes
// through both. The facilitator here is a spy, and the check API a stub answering like https://priors.trade/api/check.
//   node scripts/test-x402-gate.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
// PRIORS_X402=<an installed @priors/x402's directory> runs these checks on that copy, as published
const X402 = process.env.PRIORS_X402 ? pathToFileURL(`${process.env.PRIORS_X402}/index.mjs`).href : "../packages/x402/index.mjs";
const { createResourceServer, recordGate, payerOf, robinhood } = await import(X402);

const GOOD = "0x1111111111111111111111111111111111111111";
const DEFAULTED = "0x2222222222222222222222222222222222222222";
const NEW = "0x3333333333333333333333333333333333333333";
const MERCHANT = "0x9999999999999999999999999999999999999999";

// what the check API answers for each address
const RECORDS = {
  [GOOD]: { agents: [{ agentId: 7, record: { loansRepaid: 5, defaulted: false }, scoreV2: { score: 120 } }] },
  [DEFAULTED]: { agents: [{ agentId: 8, record: { loansRepaid: 9, defaulted: true }, scoreV2: { score: 0 } }, { agentId: 9, record: { loansRepaid: 2, defaulted: false }, scoreV2: null }] },
  [NEW]: { agents: [] },
};
let apiCalls = 0;
const fetchImpl = async (url) => {
  apiCalls++;
  const a = new URL(url).searchParams.get("address");
  return new Response(JSON.stringify({ verdict: "x", ...(RECORDS[a] || { agents: [] }) }), { status: 200 });
};

function spyFacilitator() {
  const calls = [];
  return {
    calls,
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: robinhood.network }], extensions: [], signers: {} }; },
    async verify(payload) { calls.push(["verify", payerOf(payload)]); return { isValid: true, payer: payerOf(payload) }; },
    async settle(payload) { calls.push(["settle", payerOf(payload)]); return { success: true, transaction: "0x" + "ab".repeat(32), network: robinhood.network, payer: payerOf(payload) }; },
  };
}

const requirements = (amount) => ({ scheme: "exact", network: robinhood.network, amount: String(amount), asset: robinhood.usdg, payTo: MERCHANT, maxTimeoutSeconds: 120, extra: { name: "Global Dollar", version: "1" } });
const payment = (from, amount) => ({
  x402Version: 2,
  accepted: requirements(amount),
  payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: MERCHANT, value: String(amount), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: "0x" + "22".repeat(32) } },
});

async function server(gateOpts) {
  const fac = spyFacilitator();
  const s = createResourceServer({ facilitatorClient: fac });
  recordGate({ fetchImpl, ...gateOpts }).attach(s);
  await s.initialize();
  return { s, fac };
}
async function pay(s, from, amount) {
  const v = await s.verifyPayment(payment(from, amount), requirements(amount));
  if (!v.isValid) return { verified: false, reason: v.invalidReason, message: v.invalidMessage };
  const st = await s.settlePayment(payment(from, amount), requirements(amount));
  return { verified: true, settled: st.success };
}

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

await t("payerOf reads the signer of an EIP-3009 or a Permit2 payment, and nothing else", async () => {
  assert.equal(payerOf(payment(GOOD, 1)), "0x1111111111111111111111111111111111111111");
  assert.equal(payerOf({ payload: { permit2Authorization: { from: NEW } } }), "0x3333333333333333333333333333333333333333");
  assert.equal(payerOf({ payload: { authorization: { from: "not an address" } } }), null);
});

// GHSA-6vjc: @x402/evm's exact scheme settles by the Permit2 arm whenever the payload has a `permit2Authorization` key
// ("permit2Authorization" in payload), whatever else it carries; a gate that judged `authorization.from` first was judging
// one address and letting another pay. A payload naming both arms has no single payer and is refused.
await t("payerOf follows the arm the facilitator settles by, and a payload naming both arms has no payer (GHSA-6vjc)", async () => {
  const both = { payload: { authorization: { from: GOOD }, permit2Authorization: { from: DEFAULTED } } };
  assert.equal(payerOf(both), null);
  assert.equal(payerOf({ payload: { authorization: { from: GOOD }, permit2Authorization: null } }), null, "the key alone picks the Permit2 arm");
  assert.equal(payerOf({ payload: { permit2Authorization: { from: "not an address" } } }), null);
});

await t("a payment naming both arms is refused before the facilitator's verify is called (GHSA-6vjc)", async () => {
  const { s, fac } = await server({ refuseDefaulted: true, basePrice: "$0.10", tiers: [{ minRepaid: 3, price: "$0.01" }] });
  const p = payment(GOOD, 10_000);
  p.payload.permit2Authorization = { from: DEFAULTED, permitted: { token: robinhood.usdg, amount: "10000" }, spender: MERCHANT, nonce: "1", deadline: "9999999999", witness: { to: MERCHANT, validAfter: "0", extra: "0x" } };
  const v = await s.verifyPayment(p, requirements(10_000));
  assert.equal(v.isValid, false);
  assert.match(String(v.invalidReason), /priors_payer_unknown/);
  assert.deepEqual(fac.calls, []);
});

await t("a defaulted payer is refused before the facilitator's verify is called (Criterion 4)", async () => {
  const { s, fac } = await server({ refuseDefaulted: true });
  const r = await pay(s, DEFAULTED, 10_000);
  assert.equal(r.verified, false);
  assert.match(String(r.reason), /priors_payer_defaulted/);
  assert.deepEqual(fac.calls, []);
});

await t("a payer below minRepaid is refused before the facilitator's verify is called (Criterion 5)", async () => {
  const { s, fac } = await server({ minRepaid: 1 });
  const r = await pay(s, NEW, 10_000);
  assert.equal(r.verified, false);
  assert.match(String(r.reason), /priors_record_too_short/);
  assert.deepEqual(fac.calls, []);
});

await t("a payer that meets the policy goes through verify and settlement (Criterion 6)", async () => {
  const { s, fac } = await server({ refuseDefaulted: true, minRepaid: 3, minScore: 100 });
  const r = await pay(s, GOOD, 10_000);
  assert.deepEqual(r, { verified: true, settled: true });
  assert.deepEqual(fac.calls.map((c) => c[0]), ["verify", "settle"]);
});

await t("a payer claiming another payer's record for a lower price is refused before verify (Criterion 7)", async () => {
  // $0.02 without a record, $0.01 from 3 repaid loans on; the stated payer (X-Payer) is GOOD, the signer is NEW
  const gate = recordGate({ fetchImpl, basePrice: "$0.02", tiers: [{ minRepaid: 3, price: "$0.01" }] });
  const price = gate.tierPrice();
  assert.equal(await price({ adapter: { getHeader: (h) => (h === "x-payer" ? GOOD : undefined) } }), "$0.01");
  assert.equal(await price({ adapter: { getHeader: () => undefined } }), "$0.02");
  const fac = spyFacilitator();
  const s = gate.attach(createResourceServer({ facilitatorClient: fac }));
  await s.initialize();
  const cheat = await pay(s, NEW, 10_000);
  assert.equal(cheat.verified, false);
  assert.match(String(cheat.reason), /priors_price_not_entitled/);
  assert.deepEqual(fac.calls, []);
  // the payer that has the record gets the tier price, and anyone paying the full price is served
  assert.deepEqual(await pay(s, GOOD, 10_000), { verified: true, settled: true });
  assert.deepEqual(await pay(s, NEW, 20_000), { verified: true, settled: true });
});

await t("a record that cannot be read refuses (never serves on a guess), and reads are cached", async () => {
  const fac = spyFacilitator();
  const down = async () => new Response("no", { status: 503 });
  const s = recordGate({ fetchImpl: down, minRepaid: 1 }).attach(createResourceServer({ facilitatorClient: fac }));
  await s.initialize();
  const r = await pay(s, GOOD, 10_000);
  assert.equal(r.verified, false);
  assert.match(String(r.reason), /priors_record_unavailable/);
  assert.deepEqual(fac.calls, []);
  const before = apiCalls;
  const g = recordGate({ fetchImpl });
  await g.recordOf(GOOD); await g.recordOf(GOOD);
  assert.equal(apiCalls - before, 1);
});

await t("attach returns the server, so the README's tier sample keeps the gate in its own name", async () => {
  // `const gate = recordGate({...}).attach(server)` names the server, and its gate.tierPrice() throws: the README's
  // sample read that way in 0.5.0
  const gate = recordGate({ fetchImpl, basePrice: "$0.02", tiers: [{ minRepaid: 3, price: "$0.01" }] });
  const s = createResourceServer({ facilitatorClient: spyFacilitator() });
  assert.equal(gate.attach(s), s);
  assert.equal(typeof gate.tierPrice(), "function");
  const doc = "../packages/x402/README.md";
  const text = fs.readFileSync(new URL(doc, import.meta.url), "utf8");
  assert.match(text, /gate\.tierPrice\(\)/, `${doc} has no tier sample`);
  assert.doesNotMatch(text, /const \w+ = recordGate\([^\n]*\)\.attach\(/, `${doc} names the server attach() returns as a gate`);
});

await t("GHSA-vjcp: the cache stays bounded: in API mode X-Priors-Agent does not make a new entry, and cacheMax evicts the oldest", async () => {
  const gate = recordGate({ fetchImpl });
  const before = apiCalls;
  for (let i = 0; i < 1000; i++) {
    const transportContext = { request: { adapter: { getHeader: (h) => (h === "x-priors-agent" ? String(100000 + i) : undefined) } } };
    await gate.beforeVerify({ paymentPayload: payment(GOOD, 10_000), requirements: requirements(10_000), transportContext });
  }
  assert.equal(apiCalls - before, 1, "one payer, one read, whatever agent the header names");
  const small = recordGate({ fetchImpl, cacheMax: 3 });
  const addrs = ["0x" + "a1".repeat(20), "0x" + "a2".repeat(20), "0x" + "a3".repeat(20), "0x" + "a4".repeat(20)];
  for (const a of addrs) await small.recordOf(a);
  const n = apiCalls;
  await small.recordOf(addrs[3]);
  assert.equal(apiCalls, n, "the newest entry is still cached");
  await small.recordOf(addrs[0]);
  assert.equal(apiCalls, n + 1, "the oldest was evicted once the cache held cacheMax entries");
  assert.throws(() => recordGate({ fetchImpl, cacheMax: 0 }), /cacheMax/);
});

console.log(`\n${passed} passed`);
