// The SDK's side of the treasuries: treasury v3's invite parsing and firstLine overload, then treasury v5's raise and
// move (sdk/priors-v2.mjs raise, moveToTreasuryV5; bin/priors-v2.mjs raise, move; docs/AGENTS.md, "3. Grow").
//
// The first two halves are worth a test for the same reason. The parser is what stands between a user and a
// transaction that costs gas to be told what a regex could have said for free, so its rejections matter as
// much as its acceptance. The overload choice is invisible when it is right and silent when it is wrong:
// v2's `firstLine(uint256)` and v3's `firstLine(uint256,uint64,bytes)` share a name, and ethers will happily
// encode the one you did not mean.
//
// Treasury v5: a local JSON-RPC stub plays the pool, the registry, USDG, treasury v4 and v5, InviteBond (v1, its four
// words) and InviteBondV2 (three) at their published addresses, applies what each sent transaction does, and keeps them
// all; nothing reaches a real chain. Without treasuryV5 in the record nothing changes; the raise goes by the agent's
// sponsor and is refused on v4 while v4's rules hold raises; the move sends exactly the steps not done yet, in order,
// and every refusal sends nothing. No network.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { parseInvite, TREASURY_ABI } from "../sdk/priors.mjs";
import { PriorsV2, POOL_V2_ABI, TREASURY_V4_ABI, TREASURY_V5_ABI, INVITE_BOND_ABI, CONSENT_TYPES, raisesHeld, raiseShortfall } from "../sdk/priors-v2.mjs";

const hour = 3600;
const future = Math.floor(Date.now() / 1000) + 72 * hour;
const past = Math.floor(Date.now() / 1000) - hour;
const sig = "0x" + "ab".repeat(65); // 65 bytes, the shape ECDSA.recover wants
const code = (id, exp) => `priors-invite:${id}:${exp}:${sig}`;

// ---- what it accepts ----
const ok = parseInvite(code(462, future), 462);
assert.equal(ok.agentId, 462);
assert.equal(ok.expiry, future);
assert.equal(ok.signature, sig);
console.log("  ok   a well-formed invite parses into agent, expiry and signature");

// the agent id is optional to check against, for a caller that does not have one to hand
assert.equal(parseInvite(code(462, future)).agentId, 462);
console.log("  ok   the agent id check is skipped when no agent is supplied");

// ---- what it refuses, and why each refusal earns its place ----
assert.throws(() => parseInvite("", 462), /not an invite code/);
assert.throws(() => parseInvite("priors-invite:462:" + future, 462), /not an invite code/);
assert.throws(() => parseInvite(`priors-invite:462:${future}:0xdeadbeef`, 462), /not an invite code/);
console.log("  ok   a malformed code is refused before it can cost gas");

assert.throws(() => parseInvite(code(463, future), 462), /for agent #463, not #462/);
console.log("  ok   an invite for another agent is refused, and says which");

assert.throws(() => parseInvite(code(462, past), 462), /expired/);
console.log("  ok   an expired invite is refused locally, not by the contract");

// whitespace around a pasted code is the normal case, not an error
assert.equal(parseInvite(`  ${code(462, future)}\n`, 462).agentId, 462);
console.log("  ok   a pasted code survives its surrounding whitespace");

// ---- the overloads are both reachable and distinct ----
const iface = new ethers.Interface(TREASURY_ABI);
const v3 = iface.encodeFunctionData("firstLine(uint256,uint64,bytes)", [462, future, sig]);
const v2 = iface.encodeFunctionData("firstLine(uint256)", [462]);
assert.notEqual(v3.slice(0, 10), v2.slice(0, 10));
assert.equal(iface.getFunction("firstLine(uint256,uint64,bytes)").inputs.length, 3);
console.log("  ok   v2 and v3 firstLine are separate selectors the SDK can each reach");

// the invite-specific reverts decode, so an integrator reads a reason rather than four bytes
const notInvited = iface.encodeErrorResult("NotInvited", [462, ethers.ZeroAddress]);
assert.equal(iface.parseError(notInvited).name, "NotInvited");
for (const e of ["InviteExpired", "InviteUsed"]) assert.ok(iface.getError(e), `${e} missing from the ABI`);
console.log("  ok   NotInvited, InviteExpired and InviteUsed decode instead of printing a selector");

// ---------------------------------------------------------------------------------------------------------------
// Treasury v5: raise and moveToTreasuryV5
// ---------------------------------------------------------------------------------------------------------------
const REC = JSON.parse(readFileSync(new URL("../deployments/4663.v2.json", import.meta.url), "utf8"));
const { treasuryV5: _t5, inviteBondV2: _b2, ...TODAY } = REC; // the record as it was before treasury v5
const POOL = REC.pool, REG = REC.registry, USDG = REC.usdg, T4 = REC.treasuryV4, V1 = REC.inviteBond;
// treasury v5 and its bond where the record publishes them (only the stub answers there)
const T5 = ethers.getAddress(REC.treasuryV5), V2 = ethers.getAddress(REC.inviteBondV2);
const WITH_V5 = REC;
const V4_ROOT = BigInt(REC.treasuryV4AgentId), V5_ROOT = BigInt(REC.treasuryV5AgentId), OTHER_ROOT = 8646n, AGENT = 6448n;
const U = 1_000_000n, DAY = 86_400n, NOW = 1_800_000_000n, BLOCK = 90_000_000;
const ZERO = ethers.ZeroAddress;
const owner = ethers.Wallet.createRandom(), stranger = ethers.Wallet.createRandom(), oldOwner = ethers.Wallet.createRandom().address;
const RULES5 = { reserveBps: 0n, firstLine: 5n * U, secondLine: 25n * U, epochCap: 100n * U, epochLength: 7n * DAY, minSeasoning: 14n * DAY, minQualified: 3n, minScore: 100n, idleAfter: 30n * DAY };
const HELD4 = { ...RULES5, minQualified: 1_000_000n }; // treasury v4's since 2026-10-12 (docs/SECURITY-v2.md H1): raises on hold
const poolI = new ethers.Interface(POOL_V2_ABI), t4I = new ethers.Interface(TREASURY_V4_ABI), t5I = new ethers.Interface(TREASURY_V5_ABI);
const bondI = new ethers.Interface(INVITE_BOND_ABI);
const bond1I = new ethers.Interface(["function bonds(uint256) view returns ((address depositor, uint64 at, uint256 amount, uint256 qualifiedAt))"]); // v1's four words
const regI = new ethers.Interface(["function ownerOf(uint256) view returns (address)"]);
const erc20I = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)"]);

/** A seasoned agent on treasury v4's 5 USDG line, its owner's InviteBond (v1) bond posted 20 days ago, no V2 bond. */
function world(over = {}) {
  const w = {
    agent: { sponsor: V4_ROOT, delegatedIn: 5n * U, activeLoans: 0n, defaulted: false, frozen: false, enrolledAt: NOW - 30n * DAY, qualifiedRepaid: 4n, childrenDefaulted: 0n },
    owner: owner.address, ownerDefaults: 0n, nonce: 3n, balance: 20n * U, allowance: 0n, free: 100n * U,
    v4: { rules: HELD4, firstLined: true, seeded: false },
    v5: { root: V5_ROOT, rules: RULES5, firstLined: false, seeded: false, score: 150n, epochRoom: 100n * U, raiseLeft: 100n * U, legacy: V1, moveRevert: null },
    v1: { depositor: owner.address, at: NOW - 20n * DAY }, v2: { depositor: ZERO, amount: 5n * U },
  };
  for (const [k, v] of Object.entries(over)) w[k] = v && typeof v === "object" && !Array.isArray(v) && typeof w[k] === "object" ? { ...w[k], ...v } : v;
  return w;
}
const agentTuple = (a) => [true, false, a.defaulted, a.frozen, false, a.enrolledAt, 0n, 0n, a.sponsor, a.delegatedIn, 0n, 0n, a.activeLoans, 0n, 0n, 7n, 50n * U, U, 0n, a.childrenDefaulted, a.qualifiedRepaid, 10n ** 12n];
/** treasury v5's own check, as src/TreasurySponsorV5.sol eligibleForRaise reads the record */
const eligible5 = (w) => { const a = w.agent, r = w.v5.rules; return w.v5.root !== 0n && !w.v5.seeded && !w.v4.seeded && a.sponsor === w.v5.root && !a.defaulted && !a.frozen && a.childrenDefaulted === 0n && a.delegatedIn > 0n && a.delegatedIn < r.secondLine && a.qualifiedRepaid >= r.minQualified && NOW >= a.enrolledAt + r.minSeasoning && w.v5.score >= r.minScore && w.ownerDefaults === 0n; };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** A JSON-RPC stub for world `w`: `asked` every call as "contract.fn", `sent` every transaction as "contract.fn". */
function chain(w) {
  const asked = [], sent = [], receipts = new Map(), nonces = new Map();
  const q = (n) => ethers.toQuantity(n);
  const H = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
  const domain = { name: "Priors Credit", version: "2", chainId: 4663, verifyingContract: POOL };
  function exec({ to, data, from }, send) {
    const named = [[POOL, "pool", poolI], [T4, "v4", t4I], [T5, "v5", t5I], [V1, "v1", bondI], [V2, "v2", bondI], [REG, "registry", regI], [USDG, "usdg", erc20I]].find(([at]) => same(at, to));
    if (!named) return { unknown: `no contract here answers ${to}` };
    const [, c, iface] = named;
    const f = iface.parseTransaction({ data });
    asked.push(`${c}.${f.name}`);
    const ok = (vals, logs = []) => ({ result: iface.encodeFunctionResult(f.name, vals), gas: 90_000n, logs, name: `${c}.${f.name}` });
    const no = (err, args = []) => ({ revert: (err === "ERC20InsufficientAllowance" ? erc20I : err === "LoanOpen" && c === "pool" ? poolI : c === "v1" || c === "v2" ? bondI : c === "pool" ? poolI : t5I).encodeErrorResult(err, args) });
    const a = w.agent, x = f.args;
    // a refusal forced on one call ("contract.fn": error name), as a chain that changed since the SDK's reads would answer
    const forced = (w.reverts || {})[`${c}.${f.name}`];
    if (forced) return no(forced, [x[0]]);
    if (c === "pool") switch (f.name) {
      case "getAgent": return ok([agentTuple(a)]);
      case "registry": return ok([REG]);
      case "usdg": return ok([USDG]);
      case "nonces": return ok([w.nonce]);
      case "consentDigest": return ok([ethers.TypedDataEncoder.hash(domain, CONSENT_TYPES, { agentId: x[0][0], sponsorId: x[0][1], owner: x[0][2], maxPremiumBps: x[0][3], nonce: x[0][4], deadline: x[0][5] })]);
      case "ownerDefaults": return ok([same(x[0], w.owner) ? w.ownerDefaults : 0n]);
      case "custodian": return ok([false]);
      case "freeBacking": return ok([w.free]);
      case "loansOf": return ok([[]]);
      case "leave":
        if (a.activeLoans !== 0n) return no("LoanOpen", [x[0]]);
        if (send) { a.sponsor = 0n; a.delegatedIn = 0n; }
        return ok([]);
    }
    if (c === "registry") return ok([w.owner]);
    if (c === "usdg") {
      if (f.name === "balanceOf") return ok([same(x[0], w.owner) ? w.balance : 0n]);
      if (f.name === "allowance") return ok([w.allowance]);
      if (send) w.allowance = x[1];
      return ok([true]);
    }
    if (c === "v4") switch (f.name) {
      case "agentId": return ok([V4_ROOT]);
      case "rules": return ok(Object.values(w.v4.rules));
      case "firstLined": return ok([w.v4.firstLined]);
      case "seeded": return ok([w.v4.seeded]);
      case "score": return ok([w.v5.score]);
      case "eligibleForRaise": return ok([!raisesHeld(w.v4.rules) && a.sponsor === V4_ROOT && a.delegatedIn < w.v4.rules.secondLine]);
      case "raise": if (send) a.delegatedIn = w.v4.rules.secondLine; return ok([], [{ address: T4, ...t4I.encodeEventLog("Raised", [x[0], w.v4.rules.secondLine - 5n * U, w.v4.rules.secondLine]) }]);
    }
    if (c === "v5") switch (f.name) {
      case "agentId": return ok([w.v5.root]);
      case "rules": return ok(Object.values(w.v5.rules));
      case "firstLined": return ok([w.v5.firstLined]);
      case "seeded": return ok([w.v5.seeded]);
      case "score": return ok([w.v5.score]);
      case "epochRoom": return ok([w.v5.epochRoom]);
      case "raiseRoom": return ok([w.v5.raiseLeft]);
      case "bond": return ok([V2]);
      case "legacyBond": return ok([w.v5.legacy]);
      case "previous": return ok([T4]);
      case "eligibleForRaise": return ok([eligible5(w)]);
      case "move": {
        const [id, cons, sig] = x;
        if (w.v5.moveRevert) return no(w.v5.moveRevert, [5n * U, 0n]);
        // src/TreasurySponsorV5.sol move, and the pool's consent check
        if (w.v5.firstLined || !w.v4.firstLined || (a.sponsor !== 0n && a.sponsor !== V4_ROOT) || w.v1.depositor !== ZERO || !same(w.v2.depositor, cons[2])) return no("NotMovable", [id]);
        if (cons[1] !== w.v5.root || cons[4] !== w.nonce || !same(ethers.verifyTypedData(domain, CONSENT_TYPES, { agentId: cons[0], sponsorId: cons[1], owner: cons[2], maxPremiumBps: cons[3], nonce: cons[4], deadline: cons[5] }, sig), w.owner)) return { revert: poolI.encodeErrorResult("BadConsent", []) };
        if (a.activeLoans !== 0n) return { revert: poolI.encodeErrorResult("LoanOpen", [id]) };
        if (send) { a.sponsor = w.v5.root; a.delegatedIn = w.v5.rules.firstLine; w.v5.firstLined = true; w.nonce += 1n; }
        return ok([], [{ address: T5, ...t5I.encodeEventLog("Moved", [id, cons[2]]) }, { address: T5, ...t5I.encodeEventLog("FirstLine", [id, w.v5.rules.firstLine, from || ZERO]) }]);
      }
      case "raise": {
        if (!eligible5(w)) return no("NotEligible", [x[0]]);
        const add = w.v5.rules.secondLine - a.delegatedIn;
        if (add > w.v5.raiseLeft) return no("RaiseCapReached", [add, w.v5.raiseLeft]);
        if (send) { a.delegatedIn += add; w.v5.raiseLeft -= add; }
        return ok([], [{ address: T5, ...t5I.encodeEventLog("Raised", [x[0], add, a.delegatedIn + (send ? 0n : add)]) }]);
      }
    }
    if (c === "v1") switch (f.name) {
      // InviteBond's bonds() is four words: the SDK reads its first three
      case "bonds": return { result: bond1I.encodeFunctionResult("bonds", [[w.v1.depositor, w.v1.at, w.v1.depositor === ZERO ? 0n : 5n * U, 2n]]), gas: 50_000n };
      case "isBonded": return ok([w.v1.depositor !== ZERO]);
      case "unusedReleaseAt": return ok([w.v1.depositor === ZERO ? 0n : w.v1.at + 4n * DAY]);
      case "release":
        if (w.v1.depositor === ZERO) return no("NoBond", [x[0]]);
        if (a.delegatedIn !== 0n || a.activeLoans !== 0n || NOW < w.v1.at + 4n * DAY) return no("NotReleasable", [x[0]]);
        if (send) w.v1.depositor = ZERO;
        return ok([]);
    }
    if (c === "v2") switch (f.name) {
      case "bonds": return ok([[w.v2.depositor, w.v2.depositor === ZERO ? 0n : NOW, w.v2.depositor === ZERO ? 0n : w.v2.amount]]);
      case "amount": return ok([w.v2.amount]);
      case "isBonded": return ok([w.v2.depositor !== ZERO]);
      case "deposit":
        if (!same(from, w.owner)) return no("NotOwner", [x[0]]);
        if (a.activeLoans !== 0n) return no("LoanOpen", [x[0]]);
        if (a.sponsor !== 0n && a.sponsor !== w.v5.root) return no("NotTreasuryLine", [x[0]]); // no line, or v5's
        if (same(w.v2.depositor, from)) return no("AlreadyBonded", [x[0]]);
        if (w.allowance < w.v2.amount) return no("ERC20InsufficientAllowance", [V2, w.allowance, w.v2.amount]);
        if (send) { w.v2.depositor = from; w.allowance -= w.v2.amount; w.balance -= w.v2.amount; }
        return ok([]);
    }
    return { unknown: `${c}.${f.name} is not stubbed` };
  }
  const block = () => ({ number: q(BLOCK), hash: H(1), parentHash: H(0), timestamp: q(NOW), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: q(30_000_000), gasUsed: "0x0", miner: ZERO, extraData: "0x", baseFeePerGas: q(1_000_000_000), transactions: [] });
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
        if (x.unknown || x.revert) return err(3, "execution reverted", x.revert);
        sent.push(x.name);
        nonces.set(tx.from.toLowerCase(), (nonces.get(tx.from.toLowerCase()) || 0) + 1);
        const logs = (x.logs || []).map((l, i) => ({ ...l, blockNumber: q(BLOCK), blockHash: H(1), transactionHash: tx.hash, transactionIndex: "0x0", logIndex: q(i), removed: false }));
        receipts.set(tx.hash, { transactionHash: tx.hash, blockHash: H(1), blockNumber: q(BLOCK), transactionIndex: "0x0", from: tx.from, to: tx.to, contractAddress: null, cumulativeGasUsed: q(x.gas), gasUsed: q(x.gas), effectiveGasPrice: q(1_000_000_000), logs, logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x2" });
        return ok(tx.hash);
      }
      case "eth_getTransactionReceipt": return ok(receipts.get(r.params[0]) || null);
      default: return err(-32601, `unexpected ${r.method}`);
    }
  }
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { const msg = JSON.parse(body); const out = [].concat(msg).map(answer); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(msg) ? out : out[0])); });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${server.address().port}`, 4663, { staticNetwork: true, cacheTimeout: -1 });
    ok({ w, provider, asked, sent, close: () => { provider.destroy(); server.closeAllConnections(); server.close(); } });
  }));
}
let passed5 = 0;
/** `fn(c, sdk)` against a fresh stub of world(`over`), the SDK on `addresses` signed by `key`; the stub is closed after. */
async function check(name, over, fn, { addresses = WITH_V5, key = owner } = {}) {
  const c = await chain(world(over));
  try { await fn(c, new PriorsV2({ signer: key.connect(c.provider), addresses })); } finally { c.close(); }
  passed5++;
  console.log(`  ok   ${name}`);
}
const refused = async (p, re) => { const e = await p.then(() => null, (x) => x); assert.ok(e, "no error"); assert.match(e.message, re); return e; };
const nothingSent = (c) => assert.deepEqual(c.sent, [], `sent: ${c.sent.join(", ")}`);
const AT_V5 = { agent: { sponsor: V5_ROOT, delegatedIn: 5n * U }, v1: { depositor: ZERO }, v2: { depositor: owner.address }, v5: { firstLined: true } };

console.log("treasury v5: raise and moveToTreasuryV5 (sdk/priors-v2.mjs)");

assert.equal(raisesHeld(HELD4), true); assert.equal(raisesHeld(RULES5), false); assert.equal(raisesHeld({ ...RULES5, secondLine: 5n * U }), true);
assert.equal(raisesHeld({ ...RULES5, minQualified: 100n }), false, "a bar of 100 is a real bar (RAISE_HOLD_BAR)");
assert.deepEqual(raiseShortfall({ agent: world().agent, rules: RULES5, score: 150n, now: NOW }), []);
assert.deepEqual(raiseShortfall({ agent: { ...world().agent, qualifiedRepaid: 1n, enrolledAt: NOW - DAY }, rules: RULES5, score: 40n, now: NOW }),
  ["3 qualified loans repaid (it has 1)", `14 days since it enrolled (from ${new Date(Number(NOW + 13n * DAY) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC)`, "a score of 100 (it has 40)"]);
passed5++; console.log("  ok   raisesHeld (v4's rules today hold raises; a bar of 100 or less does not) and raiseShortfall, in plain phrases");

await check("without treasuryV5 in the record: no v5 contract or errors, a raise on v4's held line is refused and points nowhere new, the move says v5 is not configured; nothing sent", {}, async (c, sdk) => {
  assert.equal(sdk.treasuryV5, null);
  assert.ok(!sdk._ifaces.some((i) => i.getError?.("NotMovable")), "v5's errors are not added to the decoding");
  await refused(sdk.raise(AGENT), /treasury v4's, whose raises are on hold \(its bar of 1000000 qualified loans holds them\): nothing was sent\. Treasury v5, which raises it, is not in this addresses file/);
  await refused(sdk.moveToTreasuryV5(AGENT), /no treasuryV5 address configured/);
  nothingSent(c);
  assert.ok(!c.asked.some((x) => x.startsWith("v5.") || x.startsWith("v2.")), c.asked.join(", "));
}, { addresses: TODAY });

await check("raise on a v5 line that qualifies: V5.raise once, its Raised event read back (line 25 USDG)", AT_V5, async (c, sdk) => {
  const r = await sdk.raise(AGENT);
  assert.deepEqual(c.sent, ["v5.raise"]);
  assert.equal(r.treasury, "treasury v5"); assert.equal(r.line, 25n * U); assert.equal(r.added, 20n * U);
});

await check("raise on a v5 line whose record falls short: refused with what it lacks, nothing sent", { ...AT_V5, agent: { ...AT_V5.agent, qualifiedRepaid: 1n } }, async (c, sdk) => {
  await refused(sdk.raise(AGENT), /^agent #6448 is not eligible for a raise on treasury v5 yet: the raise needs 3 qualified loans repaid \(it has 1\)\. Nothing was sent$/);
  nothingSent(c);
});

await check("raise on v4's line while its rules hold raises: refused, pointing at the move to v5; nothing sent, v4's raise never asked", {}, async (c, sdk) => {
  await refused(sdk.raise(AGENT), /^agent #6448's line is treasury v4's, whose raises are on hold \(its bar of 1000000 qualified loans holds them\): nothing was sent\. Treasury v5 raises it: moveToTreasuryV5 \(`priors-v2 move`\) moves the line there, then raises it\.$/);
  nothingSent(c);
  assert.ok(!c.asked.includes("v4.raise") && !c.asked.includes("v4.eligibleForRaise"), c.asked.join(", "));
});

await check("raise on v4's line once its rules allow raises again (a bar of 3): v4's own raise", { v4: { rules: RULES5 } }, async (c, sdk) => {
  const r = await sdk.raise(AGENT);
  assert.deepEqual(c.sent, ["v4.raise"]); assert.equal(r.treasury, "treasury v4"); assert.equal(r.line, 25n * U);
});

await check("raise on another root's line, or with no sponsor: not a treasury line, refused", { agent: { sponsor: OTHER_ROOT } }, async (c, sdk) => {
  await refused(sdk.raise(AGENT), /not on a treasury line \(its sponsor is #8646\)/);
  c.w.agent.sponsor = 0n;
  await refused(sdk.raise(AGENT), /not on a treasury line \(it has no sponsor\)/);
  nothingSent(c);
});

await check("move with a v1 bond: leave, the v1 bond back, approve and the V2 bond, the owner's consent and move, then the raise, in that order", {}, async (c, sdk) => {
  const r = await sdk.moveToTreasuryV5(AGENT);
  assert.deepEqual(c.sent, ["pool.leave", "v1.release", "usdg.approve", "v2.deposit", "v5.move", "v5.raise"]);
  assert.deepEqual(r.steps.map((s) => [s.step, !!s.hash]), [["leave", true], ["release v1 bond", true], ["bond on InviteBondV2", true], ["move", true], ["raise", true]]);
  assert.equal(r.line, 25n * U); assert.equal(c.w.agent.sponsor, V5_ROOT); assert.equal(c.w.v1.depositor, ZERO); assert.equal(c.w.v2.depositor, owner.address);
});

await check("move with no v1 bond: still leave first (InviteBondV2 takes a deposit only off v4's line), no release; the V2 bond, move, raise", { v1: { depositor: ZERO } }, async (c, sdk) => {
  const r = await sdk.moveToTreasuryV5(AGENT);
  assert.deepEqual(c.sent, ["pool.leave", "usdg.approve", "v2.deposit", "v5.move", "v5.raise"]);
  assert.equal(r.steps[1].skipped, "no InviteBond (v1) bond");
});

await check("a refusal on chain at a step is put in plain words first: NotTreasuryLine at the deposit, NotMovable at the move, LoanOpen at the leave", {}, async (c, sdk) => {
  c.w.reverts = { "v2.deposit": "NotTreasuryLine" };
  let e = await refused(sdk.moveToTreasuryV5(AGENT), /^bond on InviteBondV2: InviteBondV2 takes a bond only for an agent with no line, or on treasury v5's: leave treasury v4's line first \(deposit\(6448\) would revert: NotTreasuryLine\(6448\)\) \(done before it: leave, release v1 bond; run the move again to go on\)$/);
  assert.equal(e.step, "bond on InviteBondV2");
  c.w.reverts = { "v5.move": "NotMovable" };
  await refused(sdk.moveToTreasuryV5(AGENT), /^move: treasury v5 moves only an agent treasury v4 lined and v5 never did, .* \(move\(6448, .*\) would revert: NotMovable\(6448\)\)/);
  assert.deepEqual(c.sent, ["pool.leave", "v1.release", "usdg.approve", "v2.deposit"], "the second run sent only the deposit (its approve was the first run's)");
});
await check("a loan opened between the reads and the leave: LoanOpen in plain words, nothing sent", { reverts: { "pool.leave": "LoanOpen" } }, async (c, sdk) => {
  await refused(sdk.moveToTreasuryV5(AGENT), /^leave: the agent has a loan open: repay your open loan first \(leave\(6448\) would revert: LoanOpen\(6448\)\)$/);
  nothingSent(c);
});
await check("v4's seeded flag holds v5's raise too: a raise on v5 refused, saying the record was seeded", { ...AT_V5, v4: { seeded: true } }, async (c, sdk) => {
  await refused(sdk.raise(AGENT), /not eligible for a raise on treasury v5 yet: its record was seeded by the protocol, and a seeded record is never raised by rule\. Nothing was sent$/);
  nothingSent(c);
});

await check("a move that stops at the move (EpochCapReached) says what it did; run again, it goes on from there and sends only the rest", {}, async (c, sdk) => {
  c.w.v5.moveRevert = "EpochCapReached";
  const e = await refused(sdk.moveToTreasuryV5(AGENT), /^move: move\(6448, .*\) would revert: EpochCapReached\(5000000, 0\) \(done before it: leave, release v1 bond, bond on InviteBondV2; run the move again to go on\)$/);
  assert.equal(e.step, "move"); assert.deepEqual(e.steps.map((s) => s.step), ["leave", "release v1 bond", "bond on InviteBondV2"]);
  assert.deepEqual(c.sent, ["pool.leave", "v1.release", "usdg.approve", "v2.deposit"]);
  c.w.v5.moveRevert = null;
  const r = await sdk.moveToTreasuryV5(AGENT);
  assert.deepEqual(c.sent.slice(4), ["v5.move", "v5.raise"]);
  assert.deepEqual(r.steps.map((s) => s.hash ? s.step : `${s.step}: ${s.skipped}`), ["leave: not on treasury v4's line", "release v1 bond: no InviteBond (v1) bond", "bond on InviteBondV2: the owner's InviteBondV2 bond is posted", "move", "raise"]);
});

await check("already on v5's line: steps 1 to 4 skipped, the raise sent", AT_V5, async (c, sdk) => {
  const r = await sdk.moveToTreasuryV5(AGENT);
  assert.deepEqual(c.sent, ["v5.raise"]);
  assert.ok(r.steps.slice(0, 4).every((s) => s.skipped === "already on treasury v5's line"));
});

await check("the raise after the move is not fatal: the epoch's raise budget used up leaves the agent moved, the raise skipped for the keeper", { v5: { raiseLeft: 10n * U } }, async (c, sdk) => {
  const r = await sdk.moveToTreasuryV5(AGENT);
  assert.deepEqual(c.sent, ["pool.leave", "v1.release", "usdg.approve", "v2.deposit", "v5.move"]);
  assert.match(r.steps.at(-1).skipped, /RaiseCapReached\(20000000, 10000000\); the keeper raises it within about 30 minutes once it can$/);
  assert.equal(r.line, 5n * U);
});

const refusals = [
  ["a loan open", { agent: { activeLoans: 1n } }, /it has a loan open: repay your open loan first\. Nothing was sent$/],
  ["defaulted", { agent: { defaulted: true } }, /it has defaulted/],
  ["a record short of v5's raise rules", { agent: { qualifiedRepaid: 2n, enrolledAt: NOW - 3n * DAY }, v5: { score: 90n } }, /not yet: the raise on treasury v5 needs 3 qualified loans repaid \(it has 2\), 14 days since it enrolled \(from .* UTC\), a score of 100 \(it has 90\)\. Nothing was sent$/],
  ["seeded on v4", { v4: { seeded: true } }, /its record was seeded by the protocol, and treasury v5 never raises a seeded record by rule/],
  ["lined by v5 before", { agent: { sponsor: 0n, delegatedIn: 0n }, v5: { firstLined: true } }, /treasury v5 lined it before, and an agent moves once/],
  ["another root's line", { agent: { sponsor: OTHER_ROOT } }, /its line is #8646's, not treasury v4's/],
  ["never lined by v4", { agent: { sponsor: 0n, delegatedIn: 0n }, v4: { firstLined: false } }, /treasury v4 never lined it/],
  ["a v1 bond not back for 2 more days", { v1: { at: NOW - 2n * DAY } }, /its InviteBond \(v1\) bond comes back only from .* UTC \(4 days after it was posted\), and treasury v5 moves an agent only once that bond is gone: run this again from then/],
  ["v5's first lines used up this epoch", { v5: { epochRoom: 4n * U } }, /treasury v5's first lines for this epoch are used up \(4\.0 USDG of room left\)/],
  ["v5's free backing short", { free: 4n * U }, /treasury v5's free backing \(4\.0 USDG\) does not cover a first line now/],
  ["the owner marked by a default", { ownerDefaults: 1n }, /its owner's wallet was marked by a default/],
  ["the owner short of USDG for the V2 bond", { balance: 4n * U }, /the InviteBondV2 bond takes 5\.0 USDG from 0x[0-9a-fA-F]{40}, which holds 4\.0/],
  ["v5 not set up (no root)", { v5: { root: 0n } }, /treasury v5 has no root yet/],
];
for (const [what, over, re] of refusals) {
  await check(`move refused, nothing sent: ${what}`, over, async (c, sdk) => { await refused(sdk.moveToTreasuryV5(AGENT), re); nothingSent(c); });
}
await check("move refused, nothing sent: a signer that does not own the agent", {}, async (c, sdk) => {
  await refused(sdk.moveToTreasuryV5(AGENT), /it is owned by 0x[0-9a-fA-F]{40}, not by the signer .*: only its owner can move it/);
  nothingSent(c);
}, { key: stranger });
await check("move refused, nothing sent: a recorded inviteBondV2 that is not treasury v5's bond()", {}, async (c, sdk) => {
  await refused(sdk.moveToTreasuryV5(AGENT), /the addresses file's inviteBondV2 \(0x0+bad\) is not treasury v5's bond/);
  nothingSent(c);
}, { addresses: { ...WITH_V5, inviteBondV2: "0x0000000000000000000000000000000000000bad" } });
await check("a stale V2 bond (posted by the agent's previous owner) is replaced by the owner's own: leave, approve and deposit, then move", { v1: { depositor: ZERO }, v2: { depositor: oldOwner } }, async (c, sdk) => {
  await sdk.moveToTreasuryV5(AGENT);
  assert.deepEqual(c.sent, ["pool.leave", "usdg.approve", "v2.deposit", "v5.move", "v5.raise"]);
});
await check("status names a v5 sponsor \"treasury v5\" once treasuryV5 is recorded", AT_V5, async (c, sdk) => {
  assert.equal((await sdk.status(AGENT)).sponsorKind, "treasury v5");
}, { addresses: { pool: POOL, registry: REG, usdg: USDG, treasuryV4: T4, treasuryV5: T5 } }); // no seat or stock vault in this stub

// ---- the CLI (bin/priors-v2.mjs raise, move) as a user runs it, against the same stub: its own HOME, its own key ----
{
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(`${tmpdir()}/priors-raise-cli-`);
  // `addresses`: written to a file named by PRIORS_ADDRESSES; none: the CLI's default, this package's published record.
  // The working directory is the empty home, so no .env is read; PRIORS_RPC is exported, as a user's shell would.
  const cli = (args, url, addresses) => new Promise((done) => {
    const env = { PATH: process.env.PATH, HOME: home, PRIORS_KEY: owner.privateKey, PRIORS_RPC: url, PRIORS_AGENT_ID: String(AGENT) };
    if (addresses) {
      env.PRIORS_ADDRESSES = `${home}/addresses-${Math.random().toString(36).slice(2)}.json`;
      writeFileSync(env.PRIORS_ADDRESSES, JSON.stringify(addresses));
    }
    const p = spawn(process.execPath, [new URL("../bin/priors-v2.mjs", import.meta.url).pathname, ...args], { cwd: home, env });
    let out = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    const t = setTimeout(() => p.kill(), 60_000);
    p.on("close", (code) => { clearTimeout(t); done({ code, out }); });
  });
  const url = (c) => c.provider._getConnection().url;
  // the stub has no seat vault, so the status after each write cannot be read: the CLI says so and still exits 0
  await check("`priors-v2 move` on the published record: every step in order, each one's tx printed, exit 0; the key never printed", {}, async (c) => {
    const r = await cli(["move"], url(c));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(c.sent, ["pool.leave", "v1.release", "usdg.approve", "v2.deposit", "v5.move", "v5.raise"]);
    assert.match(r.out, /  leave: tx 0x[0-9a-f]{64}\n  release v1 bond: tx 0x[0-9a-f]{64}\n  bond on InviteBondV2: tx 0x[0-9a-f]{64}\n  move: tx 0x[0-9a-f]{64}\n  raise: tx 0x[0-9a-f]{64}\nagent #6448 is on treasury v5's line, now 25\.0 USDG/);
    assert.ok(!r.out.toLowerCase().includes(owner.privateKey.slice(2).toLowerCase()), "the key is not printed");
  });
  await check("`priors-v2 raise` on v4's held line: exit 1, the refusal pointing at `priors-v2 move`, nothing sent", {}, async (c) => {
    const r = await cli(["raise"], url(c));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /priors-v2: agent #6448's line is treasury v4's, whose raises are on hold .* nothing was sent\. Treasury v5 raises it: moveToTreasuryV5 \(`priors-v2 move`\)/);
    nothingSent(c);
  });
  await check("`priors-v2 raise` on a v5 line: raised, exit 0", AT_V5, async (c) => {
    const r = await cli(["raise"], url(c));
    assert.equal(r.code, 0, r.out); assert.deepEqual(c.sent, ["v5.raise"]);
    assert.match(r.out, /raised agent #6448 on treasury v5: its line is now 25\.0 USDG, tx 0x[0-9a-f]{64}/);
  });
  await check("`priors-v2 move` with no treasuryV5 in the addresses file: exit 2, nothing asked of the chain", {}, async (c) => {
    const r = await cli(["move"], url(c), TODAY);
    assert.equal(r.code, 2, r.out); assert.match(r.out, /the v2 addresses have no "treasuryV5"/);
    assert.deepEqual(c.asked, []); nothingSent(c);
  });
  await check("`priors-v2 raise` and `move` take no argument or option: exit 2 before anything is asked", {}, async (c) => {
    const a = await cli(["raise", "6448"], url(c));
    assert.equal(a.code, 2, a.out); assert.match(a.out, /raise takes no argument \(got "6448"\)/);
    const b = await cli(["move", "--days", "1"], url(c));
    assert.equal(b.code, 2, b.out); assert.match(b.out, /--days is not an option of move/);
    assert.deepEqual(c.asked, []); nothingSent(c);
  });
  // `move` approves USDG to the bond treasury v5 names: an addresses file (a .env can name one, GHSA-xw44) that repoints
  // treasuryV5 or inviteBondV2 is refused unless PRIORS_ALLOW_CUSTOM_ADDRESSES=1 is exported
  for (const key of ["treasuryV5", "inviteBondV2"]) {
    await check(`\`priors-v2 move\` with an addresses file whose ${key} is not the published one: refused, exit 2, nothing asked`, {}, async (c) => {
      const r = await cli(["move"], url(c), { ...REC, [key]: ethers.getAddress("0x" + "5a".repeat(20)) });
      assert.equal(r.code, 2, r.out); assert.match(r.out, new RegExp(`differs from the published Robinhood Chain deployment \\(${key}\\)`));
      assert.deepEqual(c.asked, []); nothingSent(c);
    });
  }
}

console.log(`sdk treasury v5: ${passed5} passed`);
console.log("sdk invite handling: all checks passed");
