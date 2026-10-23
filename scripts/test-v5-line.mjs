// SeatVaultV5 lines in the SDK, network-free. V5 vouches nothing when it opens a line, and raises the pool's vouch only
// on refresh(agentId) from the agent's owner, or from the pool delegate V5 recorded (noteDelegate) at least 24 h before.
// PriorsV2.borrow (and so `priors-v2 borrow`), float pay() and PriorsV2.pay take float.mjs's v5BeforeBorrow step when,
// and only when, the addresses name V5 (seatVaultV5 and seatVaultV5AgentId) and V5's root sponsors the agent: the owner,
// or a key recorded 24 h ago, refreshes; a controlling key V5 has not recorded is recorded now (noteDelegate) and
// borrows only within the line's room; a key recorded under 24 h ago never refreshes. A local JSON-RPC stub plays the
// pool, the registry, USDG and V5, and keeps every transaction sent; nothing reaches a real chain.
// When @priors/x402 has its own v5BeforeBorrow, the two are run side by side on the same cases.
//
//   node scripts/test-v5-line.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { PriorsV2, POOL_V2_ABI } from "../sdk/priors-v2.mjs";
import { pay, v5BeforeBorrow, SEAT_VAULT_V5_ABI, V5_DELEGATE_WAIT_S } from "../sdk/float.mjs";

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n       ")}`);
  }
}

const REC = JSON.parse(readFileSync(new URL("../deployments/4663.v2.json", import.meta.url), "utf8"));
// Today's record, whatever a later one adds: the "no V5" cases must not change once V5 is recorded.
const { seatVaultV5: _v5, seatVaultV5AgentId: _v5id, ...NO_V5 } = REC;
const POOL = REC.pool, REG = REC.registry, USDG = REC.usdg;
const V5 = ethers.getAddress("0x" + "5e".repeat(20)); // a stand-in: V5 is not deployed, and no real address is assumed
const V5_ROOT = 7001n;
const OTHER_ROOT = BigInt(REC.treasuryV4AgentId);
const AGENT = 77n;
const BLOCK = 80_000_000;
const REFRESH_GAS = 200_000n, NOTE_GAS = 60_000n, BORROW_GAS = 300_000n;
const WITH_V5 = { ...NO_V5, seatVaultV5: V5, seatVaultV5AgentId: Number(V5_ROOT) };
const nowS = () => Math.floor(Date.now() / 1000);

const owner = ethers.Wallet.createRandom();
const delegate = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();
const poolI = new ethers.Interface(POOL_V2_ABI);
const v5I = new ethers.Interface(SEAT_VAULT_V5_ABI);
// getAgentWallet: PriorsV2.borrow reads the agent's declared ERC-8004 wallet too (GHSA-9pw7); here the owner's key acts
const regI = new ethers.Interface(["function ownerOf(uint256) view returns (address)", "function getAgentWallet(uint256) view returns (address)"]);
const erc20I = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const PARAMS = [1_000000n, 50_000000n, 86_400n, 30n * 86_400n, 3n * 86_400n, 7n * 86_400n, 100n, 0n, 0n, 0n, 9_000n, 0n];
const FEE = 11_666n;

/**
 * The chain an agent sees: its sponsor and line on the pool (room = delegatedIn - principalOut), its owner and pool
 * delegate, the key V5 recorded and when (`noted`), and V5's refresh (raises the vouch to `raiseTo`, or reverts with
 * `refreshRevert`).
 */
function world(over = {}) {
  return { sponsor: V5_ROOT, delegatedIn: 0n, principalOut: 0n, owner: owner.address, poolDelegate: delegate.address, noted: [ethers.ZeroAddress, 0n], raiseTo: 10_000000n, refreshRevert: null, balance: 0n, ...over };
}

/** A JSON-RPC stub for world `w`. `asked`: every eth_call / eth_estimateGas as "contract.fn"; `sent`: every transaction. */
function chain(w) {
  const asked = [], sent = [], receipts = new Map(), nonces = new Map();
  let loans = 0;
  const q = (n) => ethers.toQuantity(n);
  const H = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
  const agentTuple = () => [true, false, false, false, false, 1n, 0n, 0n, w.sponsor, w.delegatedIn, 0n, w.principalOut, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  /** One call: { result } or { revert } (hex), and its gas; `send` applies its effects (and returns logs). */
  function exec({ to, data, from }, send) {
    const name = (c, fn) => asked.push(`${c}.${fn}`);
    if (same(to, POOL)) {
      const f = poolI.parseTransaction({ data });
      name("pool", f.name);
      const ok = (vals) => ({ result: poolI.encodeFunctionResult(f.name, vals), gas: f.name === "borrow" ? BORROW_GAS : 50_000n });
      switch (f.name) {
        case "getAgent": return ok([agentTuple()]);
        case "registry": return ok([REG]);
        case "usdg": return ok([USDG]);
        case "getParams": return ok([PARAMS]);
        case "quoteFee": return ok([FEE, 0n, 0n, 0n]);
        case "isController": return ok([same(f.args[1], w.owner) || same(f.args[1], w.poolDelegate)]);
        case "borrow": {
          const [id, amount, term, recipient] = f.args;
          const avail = w.delegatedIn > w.principalOut ? w.delegatedIn - w.principalOut : 0n;
          if (amount > avail) return { revert: poolI.encodeErrorResult("InsufficientCapacity", [id, amount, avail]) };
          if (!send) return ok([BigInt(loans + 1)]);
          w.principalOut += amount;
          const loanId = BigInt(++loans);
          const log = poolI.encodeEventLog("Borrowed", [loanId, id, w.sponsor, amount, FEE, BigInt(nowS()) + term, recipient]);
          return { ...ok([loanId]), logs: [{ address: POOL, ...log }] };
        }
      }
    }
    if (same(to, V5)) {
      const f = v5I.parseTransaction({ data });
      name("v5", f.name);
      const ok = (vals, gas = 50_000n) => ({ result: v5I.encodeFunctionResult(f.name, vals), gas });
      switch (f.name) {
        case "delegateOf": return ok(w.noted);
        case "noteDelegate":
          if (send) w.noted = [same(from, w.poolDelegate) ? w.poolDelegate : ethers.ZeroAddress, BigInt(nowS())];
          return ok([], NOTE_GAS);
        case "refresh":
          if (w.refreshRevert) return { revert: v5I.encodeErrorResult(w.refreshRevert, []) };
          if (send && w.raiseTo > w.delegatedIn) w.delegatedIn = w.raiseTo;
          return ok([], REFRESH_GAS);
      }
    }
    if (same(to, REG)) {
      const f = regI.parseTransaction({ data });
      name("registry", f.name);
      // the agent's key is also its declared ERC-8004 wallet, as Go mode's Start sets it (GHSA-9pw7: a borrow needs
      // the owner or the declared wallet, the same rule as a repayment)
      const who = f.name === "getAgentWallet" ? (w.declared ?? w.poolDelegate) : w.owner;
      return { result: regI.encodeFunctionResult(f.name, [who]), gas: 50_000n };
    }
    if (same(to, USDG)) { const f = erc20I.parseTransaction({ data }); name("usdg", f.name); return { result: erc20I.encodeFunctionResult(f.name, [f.name === "balanceOf" ? w.balance : 0n]), gas: 50_000n }; }
    return { unknown: `no contract here answers ${to} ${String(data).slice(0, 10)} (from ${from})` };
  }
  const block = () => ({ number: q(BLOCK), hash: H(1), parentHash: H(0), timestamp: q(nowS()), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: q(30_000_000), gasUsed: "0x0", miner: ethers.ZeroAddress, extraData: "0x", baseFeePerGas: q(1_000_000_000), transactions: [] });
  function answer(r) {
    const ok = (result) => ({ jsonrpc: "2.0", id: r.id, result });
    const err = (code, message, data) => ({ jsonrpc: "2.0", id: r.id, error: { code, message, ...(data ? { data } : {}) } });
    switch (r.method) {
      case "eth_chainId": return ok("0x1237");
      case "net_version": return ok("4663");
      case "eth_blockNumber": return ok(q(BLOCK));
      case "eth_getBlockByNumber": return ok(block());
      case "eth_gasPrice": case "eth_maxPriorityFeePerGas": return ok(q(1_000_000_000));
      case "eth_getTransactionCount": return ok(q(nonces.get(String(r.params[0]).toLowerCase()) || 0));
      case "eth_call": case "eth_estimateGas": {
        const x = exec(r.params[0], false);
        if (x.unknown) return err(-32601, x.unknown);
        if (x.revert) return err(3, "execution reverted", x.revert);
        return ok(r.method === "eth_call" ? x.result : q(x.gas));
      }
      case "eth_sendRawTransaction": {
        const tx = ethers.Transaction.from(r.params[0]);
        const x = exec({ to: tx.to, data: tx.data, from: tx.from }, true);
        if (x.unknown) return err(-32601, x.unknown);
        const contract = same(tx.to, V5) ? "v5" : same(tx.to, POOL) ? "pool" : tx.to;
        let fn = String(tx.data).slice(0, 10);
        try { fn = (same(tx.to, V5) ? v5I : poolI).parseTransaction({ data: tx.data })?.name ?? fn; } catch (_) { /* another contract: its selector */ }
        sent.push({ to: contract, fn, gasLimit: tx.gasLimit, from: tx.from, hash: tx.hash });
        nonces.set(tx.from.toLowerCase(), (nonces.get(tx.from.toLowerCase()) || 0) + 1);
        const logs = (x.logs || []).map((l, i) => ({ ...l, blockNumber: q(BLOCK), blockHash: H(1), transactionHash: tx.hash, transactionIndex: "0x0", logIndex: q(i), removed: false }));
        receipts.set(tx.hash, { transactionHash: tx.hash, blockHash: H(1), blockNumber: q(BLOCK), transactionIndex: "0x0", from: tx.from, to: tx.to, contractAddress: null, cumulativeGasUsed: q(x.gas || 21_000n), gasUsed: q(x.gas || 21_000n), effectiveGasPrice: q(1_000_000_000), logs, logsBloom: "0x" + "00".repeat(256), status: x.revert ? "0x0" : "0x1", type: "0x2" });
        return ok(tx.hash);
      }
      case "eth_getTransactionReceipt": return ok(receipts.get(r.params[0]) || null);
      default: return err(-32601, `unexpected ${r.method}`);
    }
  }
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const out = [].concat(msg).map(answer);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    const provider = new ethers.JsonRpcProvider(url, 4663, { staticNetwork: true, cacheTimeout: -1 });
    ok({ url, provider, asked, sent, close: () => { provider.destroy(); server.closeAllConnections(); server.close(); } });
  }));
}
/** Run `fn(c)` against a fresh chain for world `over`; the chain is closed whatever happens. */
async function onChain(over, fn) {
  const c = await chain(world(over));
  try { return await fn(c); } finally { c.close(); }
}
const asSent = (c) => c.sent.map((s) => `${s.to}.${s.fn}`);
const noV5Asked = (c) => assert.ok(!c.asked.some((a) => a.startsWith("v5.")) && !c.sent.some((s) => s.to === "v5"), `V5 was asked: ${c.asked.join(", ")}`);
/** The refresh (simulated first, sent at the plain estimate: no margin), then the borrow, both from `from`. */
function refreshThenBorrow(c, from = owner.address) {
  assert.deepEqual(asSent(c), ["v5.refresh", "pool.borrow"]);
  assert.equal(c.sent[0].gasLimit, REFRESH_GAS, `refresh gas ${c.sent[0].gasLimit}, want the estimate ${REFRESH_GAS}`);
  assert.equal(c.sent[0].from, from);
  assert.ok(c.asked.indexOf("v5.refresh") >= 0, "the refresh is simulated before it is sent");
}
const rejectsWith = async (p, code, re) => {
  const e = await p.then(() => null, (x) => x);
  assert.ok(e, `no error, want ${code}`);
  assert.equal(e.code, code, `got ${e.code}: ${e.message}`);
  if (re) assert.match(e.message, re);
  return e;
};
const sdk = (c, key = owner, addresses = WITH_V5) => new PriorsV2({ signer: key.connect(c.provider), addresses });
const borrow5 = (c, key, addresses) => sdk(c, key, addresses).borrow(AGENT, 5, 7 * 86400);

// ---------------------------------------------------------------------------------------------------------------
console.log("PriorsV2.borrow (sdk/priors-v2.mjs, and so `priors-v2 borrow`)");

await check("no V5 in the record, or seatVaultV5 without seatVaultV5AgentId: the borrow only, and neither V5 nor the pool's getAgent is asked", async () => {
  for (const addresses of [NO_V5, { ...NO_V5, seatVaultV5: V5 }]) {
    await onChain({ delegatedIn: 10_000000n }, async (c) => {
      const r = await borrow5(c, owner, addresses);
      assert.equal(r.loanId, 1);
      assert.equal(r.v5Refreshed, undefined);
      assert.deepEqual(asSent(c), ["pool.borrow"]);
      noV5Asked(c);
      assert.ok(!c.asked.includes("pool.getAgent"), `getAgent was read: ${c.asked}`);
    });
  }
});

await check("the owner's key on a V5 line: refresh, simulated then sent at the plain estimate and waited for, then the borrow (v5Refreshed)", () =>
  onChain({}, async (c) => {
    const r = await borrow5(c, owner);
    refreshThenBorrow(c);
    assert.equal(r.v5Refreshed, true);
    assert.equal(r.v5Noted, null);
    assert.equal(r.principal, 5_000000n);
    assert.ok(!c.asked.includes("v5.delegateOf"), "the owner's key needs no delegate record");
  }));

await check("another root sponsors the agent: no V5 step, the borrow only", () =>
  onChain({ sponsor: OTHER_ROOT, delegatedIn: 5_000000n }, async (c) => {
    const r = await borrow5(c, owner);
    assert.deepEqual(asSent(c), ["pool.borrow"]);
    assert.equal(r.v5Refreshed, undefined);
    assert.ok(!c.asked.some((a) => a.startsWith("v5.")), `V5 was asked: ${c.asked}`);
  }));

await check("a key V5 recorded 24 h ago or more: it refreshes like the owner, then the borrow", () =>
  onChain({ noted: [delegate.address, BigInt(nowS() - V5_DELEGATE_WAIT_S - 60)] }, async (c) => {
    const r = await borrow5(c, delegate);
    refreshThenBorrow(c, delegate.address);
    assert.equal(r.v5Refreshed, true);
  }));

await check("a controlling key V5 never recorded, the line has room: noteDelegate now, then the borrow, never a refresh (v5Noted)", () =>
  onChain({ delegatedIn: 5_000000n }, async (c) => {
    const r = await borrow5(c, delegate);
    assert.deepEqual(asSent(c), ["v5.noteDelegate", "pool.borrow"]);
    assert.equal(r.v5Refreshed, false);
    assert.equal(r.v5Noted, c.sent[0].hash);
  }));

await check("a controlling key V5 never recorded, no room: noteDelegate now, then V5_DELEGATE_WAIT 24 h on; no refresh, no borrow", () =>
  onChain({}, async (c) => {
    const t0 = nowS();
    const e = await rejectsWith(borrow5(c, delegate), "V5_DELEGATE_WAIT", /SeatVaultV5, which raises it only for the agent's owner, or for the agent's key 24 hours after V5 recorded it \(recorded now, tx 0x[0-9a-f]{64}\)\. The line has room for 0 atomic USDG now\. This key can borrow more from \d{4}-\d\d-\d\d \d\d:\d\d UTC; before then, the owner can borrow from Go mode/);
    assert.deepEqual(asSent(c), ["v5.noteDelegate"]);
    assert.equal(e.noted, c.sent[0].hash);
    assert.equal(e.room, 0n);
    assert.ok(e.readyAt >= t0 + V5_DELEGATE_WAIT_S && e.readyAt <= nowS() + V5_DELEGATE_WAIT_S, `readyAt ${e.readyAt}`);
  }));

await check("a key V5 recorded under 24 h ago: within the room, the borrow only; beyond it, V5_DELEGATE_WAIT at its recording + 24 h, nothing sent", async () => {
  const at = nowS() - 3600;
  await onChain({ noted: [delegate.address, BigInt(at)], delegatedIn: 5_000000n }, async (c) => {
    const r = await borrow5(c, delegate);
    assert.deepEqual(asSent(c), ["pool.borrow"]);
    assert.equal(r.v5Refreshed, false);
    assert.equal(r.v5Noted, null);
  });
  await onChain({ noted: [delegate.address, BigInt(at)], delegatedIn: 3_000000n }, async (c) => {
    const e = await rejectsWith(borrow5(c, delegate), "V5_DELEGATE_WAIT", /room for 3000000 atomic USDG now/);
    assert.equal(e.readyAt, at + V5_DELEGATE_WAIT_S);
    assert.equal(e.noted, null);
    assert.doesNotMatch(e.message, /recorded now/);
    assert.deepEqual(c.sent, []);
  });
});

// GHSA-9pw7: a key that is neither the agent's owner nor its declared ERC-8004 wallet is refused before the V5 step
// (so before `isController`'s NOT_CONTROLLER, which it would also fail): nothing is recorded or sent either way.
await check("a key that does not control the agent: refused before anything is recorded or sent", () =>
  onChain({}, async (c) => {
    await rejectsWith(borrow5(c, stranger), undefined, /neither agent #77's owner .* nor its declared ERC-8004 wallet/);
    assert.deepEqual(c.sent, []);
  }));

await check("the owner's refresh would revert (BookNotOpen): V5_REFRESH_WOULD_REVERT naming it, before anything is sent", () =>
  onChain({ refreshRevert: "BookNotOpen" }, async (c) => {
    await rejectsWith(borrow5(c, owner), "V5_REFRESH_WOULD_REVERT", /BookNotOpen\(\).*can't be raised now/);
    assert.deepEqual(c.sent, []);
  }));

// ---------------------------------------------------------------------------------------------------------------
console.log("float pay() (sdk/float.mjs) and PriorsV2.pay");
const merchant = ethers.Wallet.createRandom().address;
const requirement = { scheme: "exact", network: "robinhood", maxAmountRequired: "10000", payTo: merchant, asset: USDG, maxTimeoutSeconds: 60, resource: "https://m.example/x" };
/** A merchant that asks 0.01 USDG and serves the call once paid; `signed` counts the payments it received. */
function merchantFetch() {
  const f = async (_u, init = {}) => {
    if (new Headers(init.headers || {}).get("X-PAYMENT")) { f.signed++; return new Response("data", { status: 200 }); }
    return new Response(JSON.stringify({ x402Version: 1, accepts: [requirement] }), { status: 402, headers: { "content-type": "application/json" } });
  };
  f.signed = 0;
  return f;
}
const payOpts = (c, over = {}) => ({ signer: owner.connect(c.provider), pool: POOL, agentId: AGENT, maxBorrow: 5_000000n, asset: USDG, fetchImpl: merchantFetch(), ...over });

await check("pay() with v5 and v5Root, the owner's key: refresh, then the borrow, then the payment", () =>
  onChain({}, async (c) => {
    const r = await pay("https://m.example/x", payOpts(c, { v5: V5, v5Root: V5_ROOT }));
    refreshThenBorrow(c);
    assert.equal(r.borrowed, 1_000000n);
    assert.equal(r.paid, 10000n);
  }));
await check("pay() with a controlling key V5 never recorded and no room: noteDelegate, V5_DELEGATE_WAIT, no loan, nothing signed", () =>
  onChain({}, async (c) => {
    const fetchImpl = merchantFetch();
    await rejectsWith(pay("https://m.example/x", payOpts(c, { signer: delegate.connect(c.provider), v5: V5, v5Root: V5_ROOT, fetchImpl })), "V5_DELEGATE_WAIT");
    assert.deepEqual(asSent(c), ["v5.noteDelegate"]);
    assert.equal(fetchImpl.signed, 0);
  }));
await check("pay() without v5, or on a line another root sponsors: the borrow only", async () => {
  await onChain({ delegatedIn: 5_000000n }, async (c) => {
    await pay("https://m.example/x", payOpts(c));
    assert.deepEqual(asSent(c), ["pool.borrow"]);
    noV5Asked(c);
    assert.ok(!c.asked.includes("pool.getAgent"), `getAgent was read: ${c.asked}`);
  });
  await onChain({ sponsor: OTHER_ROOT, delegatedIn: 5_000000n }, async (c) => {
    await pay("https://m.example/x", payOpts(c, { v5: V5, v5Root: V5_ROOT }));
    assert.deepEqual(asSent(c), ["pool.borrow"]);
  });
});
await check("PriorsV2.pay() hands the record's seatVaultV5 and seatVaultV5AgentId to pay(); without them, the borrow only", async () => {
  await onChain({}, async (c) => {
    await sdk(c).pay("https://m.example/x", { agentId: AGENT, maxBorrow: 5_000000n, asset: USDG, fetchImpl: merchantFetch() });
    refreshThenBorrow(c);
  });
  await onChain({ delegatedIn: 5_000000n }, async (c) => {
    await sdk(c, owner, NO_V5).pay("https://m.example/x", { agentId: AGENT, maxBorrow: 5_000000n, asset: USDG, fetchImpl: merchantFetch() });
    assert.deepEqual(asSent(c), ["pool.borrow"]);
    noV5Asked(c);
  });
});

// ---------------------------------------------------------------------------------------------------------------
console.log("the SDK's v5BeforeBorrow and @priors/x402's");
const credit = await import("../packages/x402/src/credit.mjs");
if (typeof credit.v5BeforeBorrow !== "function") {
  console.log("  skip @priors/x402 here has no v5BeforeBorrow yet (it comes with the packages' next sync): nothing to compare");
} else {
  await check("sdk/float.mjs and @priors/x402 v5BeforeBorrow agree case by case: the same transactions, results and error codes", async () => {
    const t = nowS();
    const cases = [
      [{}, owner], [{ sponsor: OTHER_ROOT }, owner], [{ sponsor: 0n }, owner], [{ refreshRevert: "BookNotOpen" }, owner],
      [{}, delegate], [{ delegatedIn: 5_000000n }, delegate], [{}, stranger],
      [{ noted: [delegate.address, BigInt(t - 100)] }, delegate], [{ noted: [delegate.address, BigInt(t - 100)], delegatedIn: 5_000000n }, delegate],
      [{ noted: [delegate.address, BigInt(t - V5_DELEGATE_WAIT_S)] }, delegate],
    ];
    for (const [over, key] of cases) {
      const runs = [];
      for (const fn of [v5BeforeBorrow, credit.v5BeforeBorrow]) {
        runs.push(await onChain(over, async (c) => {
          const out = await fn({ signer: key.connect(c.provider), pool: POOL, v5: V5, v5Root: V5_ROOT, agentId: AGENT, amount: 5_000000n, now: () => t })
            .then((r) => ({ v5: r.v5, refreshed: r.refreshed, noted: r.noted ? "tx" : null }), (e) => ({ code: e.code, readyAt: e.readyAt, room: e.room }));
          return { out, sent: c.sent.map((s) => `${s.to}.${s.fn}@${s.gasLimit}`) };
        }));
      }
      assert.deepEqual(runs[1], runs[0], `case ${JSON.stringify(over, (_k, v) => (typeof v === "bigint" ? String(v) : v))} with ${key === owner ? "the owner" : key === delegate ? "the delegate" : "a stranger"}`);
    }
  });
}

console.log(failed ? `\ntest-v5-line: ${failed} failed, ${passed} passed` : `\ntest-v5-line: all ${passed} good`);
process.exit(failed ? 1 : 0);
