// @priors/x402's recordGate on its chain source (packages/x402/src/gate.mjs readChain), against a local JSON-RPC stub
// the real ethers provider talks to: the pool marks the owner of a defaulted agent (ownerDefaults), and a payer the pool
// marked is refused under refuseDefaulted whatever agent it names, a clean sibling or none (reported by Muse,
// 2026-10-04), as the API source refuses it; the named agent's own default and its owner's mark count too; a custodian
// (which holds others' agents, and whose marks the pool skips) is not refused for a mark; an unmarked payer is served.
//   node scripts/test-x402-gate-chain.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { pathToFileURL } from "node:url";
// PRIORS_X402=<an installed @priors/x402's directory> runs these checks on that copy, as published
const PKG = process.env.PRIORS_X402 ? pathToFileURL(`${process.env.PRIORS_X402}/`).href : new URL("../packages/x402/", import.meta.url).href;
const { recordGate } = await import(new URL("index.mjs", PKG).href);
const { POOL_ABI, LENS_ABI, STOCK_VAULT_ABI } = await import(new URL("src/credit.mjs", PKG).href);

const W = "0x1111111111111111111111111111111111111111"; // owns #7 (defaulted) and #9 (clean); the pool marked it
const Z = "0x2222222222222222222222222222222222222222"; // owns #11, clean, unmarked
const D = "0x3333333333333333333333333333333333333333"; // #9's delegate (its agent key), unmarked itself
const C = "0x4444444444444444444444444444444444444444"; // a custodian holding #12: marked, but the pool skips custodians
const AGENTS = { 7: { owner: W, defaulted: true, loansRepaid: 3n }, 9: { owner: W, defaulted: false, loansRepaid: 3n }, 11: { owner: Z, defaulted: false, loansRepaid: 4n }, 12: { owner: C, defaulted: false, loansRepaid: 2n } };
const CONTROLS = { 7: [W], 9: [W, D], 11: [Z], 12: [C] };
const MARKS = { [W.toLowerCase()]: 1n, [C.toLowerCase()]: 1n };
const CUSTODIAN = { [C.toLowerCase()]: true };
let registryDown = false; // the registry's ownerOf fails (an RPC error), while the pool still answers

const pool = new ethers.Interface(POOL_ABI), lens = new ethers.Interface(LENS_ABI), vault = new ethers.Interface(STOCK_VAULT_ABI);
const registry = new ethers.Interface(["function ownerOf(uint256) view returns (address)"]);
function agentTuple(id) {
  const a = AGENTS[id] || {};
  const out = pool.getFunction("getAgent").outputs[0];
  const v = {};
  for (const c of out.components) v[c.name] = c.type === "bool" ? false : c.type === "address" ? ethers.ZeroAddress : 0n;
  return { ...v, enrolledAt: a.owner ? 1n : 0n, defaulted: !!a.defaulted, loansRepaid: a.loansRepaid || 0n, sponsor: a.owner ? 5n : 0n };
}
function answer(data) {
  const sel = data.slice(0, 10);
  // the stock vault's own root (it backs none of these lines: their sponsor is 5)
  if (sel === vault.getFunction("agentId").selector) return vault.encodeFunctionResult("agentId", [999n]);
  for (const [iface, fns] of [[pool, ["getAgent", "isController", "loansOf", "ownerDefaults", "custodian"]], [lens, ["score"]], [registry, ["ownerOf"]]]) {
    for (const fn of fns) {
      let f; try { f = iface.getFunction(fn); } catch (_) { continue; }
      if (!f || f.selector !== sel) continue;
      const args = iface.decodeFunctionData(fn, data);
      const id = args[0];
      const val = {
        getAgent: () => [agentTuple(Number(id))],
        isController: () => [(CONTROLS[Number(id)] || []).some((x) => x.toLowerCase() === String(args[1]).toLowerCase())],
        loansOf: () => [[]],
        ownerDefaults: () => [MARKS[String(id).toLowerCase()] || 0n],
        custodian: () => [!!CUSTODIAN[String(id).toLowerCase()]],
        score: () => [AGENTS[Number(id)] && !AGENTS[Number(id)].defaulted ? 400n : 0n],
        ownerOf: () => { if (registryDown) throw new Error("registry read failed"); return [AGENTS[Number(id)] ? AGENTS[Number(id)].owner : ethers.ZeroAddress]; },
      }[fn]();
      return iface.encodeFunctionResult(fn, val);
    }
  }
  throw new Error(`stub: no answer for selector ${sel}`);
}
const srv = createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const msgs = [].concat(JSON.parse(body));
  const out = msgs.map((m) => {
    try {
      if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x1237" };
      if (m.method === "eth_call") return { jsonrpc: "2.0", id: m.id, result: answer(m.params[0].data) };
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: m.method } };
    } catch (e) { return { jsonrpc: "2.0", id: m.id, error: { code: 3, message: e.message } }; }
  });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
}).listen(0);
const rpc = `http://127.0.0.1:${srv.address().port}`;

let n = 0;
const ok = (m) => { n++; console.log("  ok   " + m); };
const judgeFor = async (payer, agent, opts = {}) => {
  const g = recordGate({ source: "chain", rpc, refuseDefaulted: true, cacheSeconds: 0, ...opts });
  const r = await g.beforeVerify({ paymentPayload: { payload: { authorization: { from: payer } } }, requirements: { amount: "20000" }, transportContext: { request: { adapter: { getHeader: (h) => (h === "x-priors-agent" ? agent : null) } } } });
  return r ? r.reason : "accepted";
};
try {
  assert.equal(await judgeFor(W, "7"), "priors_payer_defaulted");
  ok("chain source: a payer naming its own defaulted agent is refused");
  assert.equal(await judgeFor(W, "9"), "priors_payer_defaulted");
  assert.equal(await judgeFor(W, null), "priors_payer_defaulted");
  ok("chain source: a payer the pool marked for a default is refused naming a clean sibling, or naming none (the report's two paths)");
  assert.equal(await judgeFor(D, "9"), "priors_payer_defaulted");
  ok("chain source: an agent key whose agent's owner the pool marked is refused too");
  assert.equal(await judgeFor(C, "12"), "accepted");
  ok("chain source: a custodian's mark is skipped, as the pool skips it");
  assert.equal(await judgeFor(Z, "11"), "accepted");
  assert.equal(await judgeFor(Z, null), "accepted");
  ok("chain source: an unmarked payer is served, naming its clean agent or none (refuseDefaulted only)");
  assert.equal(await judgeFor(W, "9", { refuseDefaulted: false }), "accepted");
  ok("chain source: with refuseDefaulted off, the mark is not a refusal");
  // the pool says D controls #9, so #9 has an owner; a registry read of it that fails is an unreadable record, not an
  // owner without a mark (before 0.7.1 the owner's mark was skipped and D, the key of a marked owner's agent, was served)
  registryDown = true;
  try {
    assert.equal(await judgeFor(D, "9"), "priors_record_unavailable");
    assert.equal(await judgeFor(Z, "11"), "priors_record_unavailable");
  } finally { registryDown = false; }
  assert.equal(await judgeFor(D, "9"), "priors_payer_defaulted");
  ok("chain source: when the named agent's owner cannot be read, the payment is refused as unreadable, never judged without the owner's mark");
} finally {
  srv.close();
}
console.log(`x402 gate (chain source): ${n} passed`);
