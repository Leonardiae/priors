// SDK v2 and x402 float, network-free: the deployment record, amounts, the CLI's refusals, and every pay() guard
// that must hold before anything is signed or borrowed. A local in-process JSON-RPC stub answers the two reads pay()
// makes (chainId, USDG balanceOf); nothing reaches a real chain and no transaction is ever built.
//
//   node scripts/test-sdk-v2.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { PriorsV2, POOL_V2_ABI, toUnits, fmtUsdg, extendPriorsV2 } from "../sdk/priors-v2.mjs";
import { pay, resend, signPayment, pickRequirement, FloatError, DEFAULT_MAX_PRICE } from "../sdk/float.mjs";
import { USDG_MAINNET, TRANSFER_WITH_AUTHORIZATION_TYPES, domainFor, decodePaymentHeader, FACILITATOR_URL } from "../sdk/x402.mjs";
import { readDeploymentV2, readDeployment } from "../sdk/env.mjs";

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e && e.message || e).split("\n").join("\n       ")}`);
  }
}

console.log("deployment records");
await check("the v2 record is live on 4663 and names every contract the SDK and CLI need, checksummed", () => {
  const d = readDeploymentV2(4663);
  assert.ok(d, "deployments/4663.v2.json is missing");
  assert.equal(d.chainId, 4663);
  assert.equal(d.status, "live");
  for (const k of ["pool", "lens", "timelock", "treasuryV4", "seatVault", "seatVaultV2", "inviteBond", "usdg", "registry", "priors", "safe", "v1Pool"]) {
    assert.ok(ethers.isAddress(d[k]), `${k} is not an address`);
    assert.equal(ethers.getAddress(d[k]), d[k], `${k} is not checksummed`);
  }
  assert.equal(d.pool, "0x281210097f0de7A8FB6F87310AF0f089c9C8DE21");
  assert.equal(d.usdg, USDG_MAINNET);
  assert.equal(d.treasuryV4AgentId, 6228);
  // the seat vault is SeatVaultV3 since 2026-09-25 (audit V-2); V2 stays in the record, retired
  assert.equal(d.seatVault, "0x59D155C42A9263fA7596867b992bB3e84dF680a9");
  assert.equal(d.seatVaultAgentId, 6234);
  assert.equal(d.seatVaultV2, "0x6D934C07a33E7285cE691A9B258cdB53F18e6B5F");
  assert.equal(d.seatVaultV2AgentId, 6229);
  // the growth seat vault (SeatVaultV4) since 2026-09-29, and its own SeatSizer: the CLI seats on it once recorded
  for (const k of ["seatVaultV4", "seatSizerV4"]) assert.equal(ethers.getAddress(d[k]), d[k], `${k} is not a checksummed address`);
  assert.equal(d.seatVaultV4, "0xb1c3a04496238D62E3c93118C297163855e22192");
  assert.equal(d.seatVaultV4AgentId, 6466);
  assert.equal(d.seatSizerV4, "0x97C4e594D458f8BBE961d5384Bbd8a9Cc2D18777");
});
await check("the v1 record is kept for history, marked paused, and points at the v2 record", () => {
  const v1 = readDeployment(4663);
  const v2 = readDeploymentV2(4663);
  assert.equal(v1.status, "paused");
  assert.equal(v1.supersededBy, "4663.v2.json");
  assert.equal(v1.creditPool, v2.v1Pool, "the v2 record's v1Pool is not the pool the v1 record names");
});
await check("a record for a chain with no v2 deployment is null, not a guess", () => {
  assert.equal(readDeploymentV2(31337), null);
});

console.log("amounts");
await check("toUnits: whole USDG as number or string, raw units as bigint, exact to 6 decimals", () => {
  assert.equal(toUnits(5), 5_000000n);
  assert.equal(toUnits("12.5"), 12_500000n);
  assert.equal(toUnits("0.000001"), 1n);
  assert.equal(toUnits(7n), 7n);
  assert.equal(fmtUsdg(11666n), "0.011666");
});
await check("toUnits refuses what is not an amount rather than rounding it", () => {
  for (const bad of ["-1", "1.0000001", "abc", "", -5, NaN]) assert.throws(() => toUnits(bad), /not an amount/, `accepted ${bad}`);
});

console.log("client");
await check("PriorsV2 needs a pool and a provider, and refuses writes without a signer", async () => {
  assert.throws(() => new PriorsV2({ addresses: {} }), /addresses.pool is required/);
  assert.throws(() => new PriorsV2({ addresses: { pool: USDG_MAINNET } }), /signer connected to a provider/);
  const p = new PriorsV2({ provider: new ethers.JsonRpcProvider("http://127.0.0.1:1", 4663, { staticNetwork: true }), addresses: readDeploymentV2(4663) });
  await assert.rejects(() => p.deposit(5), /needs a signer/);
  assert.throws(() => p.pay("https://example.invalid"), /needs a signer/);
});
await check("priors.resend() sends the header pay() handed back, unchanged, and signs nothing (GHSA-x4jj: the resend the docs point to)", async () => {
  const p = new PriorsV2({ provider: new ethers.JsonRpcProvider("http://127.0.0.1:1", 4663, { staticNetwork: true }), addresses: readDeploymentV2(4663) });
  const seen = [];
  const fetchImpl = async (_u, init) => { seen.push(new Headers(init.headers).get("X-PAYMENT")); return new Response("ok", { status: 200 }); };
  const r = await p.resend("https://m.example/x", "HEADER", { fetchImpl, sleep: async () => {} });
  assert.equal(r.response.status, 200);
  assert.deepEqual(seen, ["HEADER"], "the same authorization, once; no signer was needed");
});
await check("extendPriorsV2 refuses to overwrite a method, so float's pay() cannot be replaced silently", () => {
  assert.throws(() => extendPriorsV2({ pay() {} }), /already exists/);
  assert.throws(() => extendPriorsV2({ borrow() {} }), /already exists/);
});

console.log("x402 float");
const wallet = ethers.Wallet.createRandom();
const merchant = ethers.Wallet.createRandom().address;
const requirement = (over = {}) => ({ scheme: "exact", network: "robinhood", maxAmountRequired: "10000", payTo: merchant, asset: USDG_MAINNET, maxTimeoutSeconds: 60, resource: "https://m.example/x", ...over });
const json402 = (body) => new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json" } });

await check("pickRequirement takes only exact USDG on Robinhood Chain", () => {
  assert.equal(pickRequirement({ accepts: [requirement({ network: "base" }), requirement({ asset: ethers.ZeroAddress })] }), null);
  assert.equal(pickRequirement({ accepts: [requirement({ scheme: "upto" }), requirement()] }).scheme, "exact");
  assert.ok(pickRequirement({ accepts: [requirement({ network: "eip155:4663" })] }));
});
await check("signPayment signs EIP-3009 on USDG's Global Dollar domain, recoverable to the payer", async () => {
  const now = 1_800_000_000;
  const header = await signPayment(wallet, requirement(), { now });
  const p = decodePaymentHeader(header);
  assert.equal(p.x402Version, 1);
  assert.equal(p.scheme, "exact");
  const a = p.payload.authorization;
  assert.equal(a.from, wallet.address);
  assert.equal(a.to, merchant);
  assert.equal(a.value, "10000");
  const who = ethers.verifyTypedData(domainFor(USDG_MAINNET), TRANSFER_WITH_AUTHORIZATION_TYPES, a, p.payload.signature);
  assert.equal(who, wallet.address);
  assert.equal(Number(a.validBefore), now + 60, "window should be the merchant's 60 s");
});
await check("an authorization never outlives 600 s, whatever the merchant or the caller asks", async () => {
  const now = 1_800_000_000;
  for (const [req, opt] of [[requirement({ maxTimeoutSeconds: 86400 }), {}], [requirement({ maxTimeoutSeconds: 86400 }), { maxValiditySeconds: 99999 }]]) {
    const a = decodePaymentHeader(await signPayment(wallet, req, { now, ...opt })).payload.authorization;
    assert.equal(Number(a.validBefore), now + 600);
  }
});
await check("a non-402 answer is returned as-is, with nothing signed or borrowed", async () => {
  const r = await pay("https://m.example/free", { signer: wallet, fetchImpl: async () => new Response("hi", { status: 200 }) });
  assert.equal(r.response.status, 200);
  assert.equal(r.paid, 0n);
  assert.equal(r.borrowed, 0n);
});
await check("a price above maxPrice is refused before anything is signed or read", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return json402({ accepts: [requirement({ maxAmountRequired: String(DEFAULT_MAX_PRICE + 1n) })] }); };
  await assert.rejects(() => pay("https://m.example/x", { signer: wallet, fetchImpl, asset: USDG_MAINNET }), (e) => e instanceof FloatError && e.code === "PRICE_ABOVE_MAX_PRICE");
  assert.equal(calls, 1, "it retried with a payment");
});
await check("a 402 that does not accept USDG on Robinhood Chain is refused", async () => {
  const fetchImpl = async () => json402({ accepts: [requirement({ network: "base" })] });
  await assert.rejects(() => pay("https://m.example/x", { signer: wallet, fetchImpl, asset: USDG_MAINNET }), (e) => e.code === "NO_USDG_REQUIREMENT");
});
await check("resend() repeats the SAME X-PAYMENT while the merchant answers pending, and never signs a new one", async () => {
  const seen = [];
  let n = 0;
  const fetchImpl = async (_u, init) => {
    seen.push(new Headers(init.headers).get("X-PAYMENT"));
    return ++n < 3 ? json402({ pending: true }) : new Response("ok", { status: 200 });
  };
  const r = await resend("https://m.example/x", "HEADER", { fetchImpl, sleep: async () => {} });
  assert.equal(r.response.status, 200);
  assert.equal(r.pending, false);
  assert.deepEqual(seen, ["HEADER", "HEADER", "HEADER"]);
});
await check("still pending after the retries: handed back as pending with the header, for a later resend", async () => {
  const fetchImpl = async () => json402({ pending: true });
  const r = await resend("https://m.example/x", "HEADER", { fetchImpl, retries: 2, sleep: async () => {} });
  assert.equal(r.pending, true);
  assert.equal(r.paymentHeader, "HEADER");
});

/* A two-method JSON-RPC stub: enough for pay() to read the payer's USDG balance, nothing more. Any other method
   (a send, a gas estimate) fails the test, which is how "short of USDG and maxBorrow 0 opens no loan" is proven. */
function stub(balance) {
  const methods = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqs = [].concat(JSON.parse(body));
      const out = reqs.map((r) => {
        methods.push(r.method);
        if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x1237" };
        // the identity registry (GHSA-9pw7): float's borrow step reads the agent's owner and declared wallet; this
        // wallet is both here (an agent run by its own owner's key), so the rule lets the borrow through
        if (r.method === "eth_call") {
          const d = String(r.params[0].data || r.params[0].input || "");
          if (d.startsWith(ethers.id("ownerOf(uint256)").slice(0, 10)) || d.startsWith(ethers.id("getAgentWallet(uint256)").slice(0, 10))) {
            return { jsonrpc: "2.0", id: r.id, result: ethers.zeroPadValue(wallet.address, 32) };
          }
          return { jsonrpc: "2.0", id: r.id, result: ethers.toBeHex(balance, 32) };
        }
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, methods, url: `http://127.0.0.1:${server.address().port}` })));
}

await check("funded agent: pays from its balance, one signed header, no loan", async () => {
  const s = await stub(1_000000n);
  try {
    const signer = wallet.connect(new ethers.JsonRpcProvider(s.url, 4663, { staticNetwork: true }));
    let paidWith = null;
    const fetchImpl = async (_u, init = {}) => {
      const h = new Headers(init.headers || {}).get("X-PAYMENT");
      if (!h) return json402({ accepts: [requirement()] });
      paidWith = decodePaymentHeader(h);
      return new Response("data", { status: 200 });
    };
    const r = await pay("https://m.example/x", { signer, fetchImpl, asset: USDG_MAINNET });
    assert.equal(r.response.status, 200);
    assert.equal(r.paid, 10000n);
    assert.equal(r.borrowed, 0n);
    assert.equal(r.loanId, null);
    assert.equal(paidWith.payload.authorization.to, merchant);
    assert.ok(!s.methods.some((m) => /send|estimate/i.test(m)), `unexpected methods: ${s.methods}`);
  } finally {
    s.server.close();
  }
});
await check("short of USDG with maxBorrow 0: refused before any transaction, no loan opened", async () => {
  const s = await stub(0n);
  try {
    const signer = wallet.connect(new ethers.JsonRpcProvider(s.url, 4663, { staticNetwork: true }));
    const fetchImpl = async () => json402({ accepts: [requirement()] });
    await assert.rejects(() => pay("https://m.example/x", { signer, fetchImpl, asset: USDG_MAINNET, pool: readDeploymentV2(4663).pool, agentId: 1, maxBorrow: 0n }), (e) => e.code === "PRICE_ABOVE_MAX_BORROW");
    assert.ok(!s.methods.some((m) => /send|estimate/i.test(m)), `unexpected methods: ${s.methods}`);
  } finally {
    s.server.close();
  }
});
await check("a borrow whose answer is lost throws BORROW_UNCONFIRMED carrying the amount, and nothing is signed; a mined revert borrowed nothing (GHSA-v9xj)", async () => {
  const s = await stub(0n);
  try {
    const signer = wallet.connect(new ethers.JsonRpcProvider(s.url, 4663, { staticNetwork: true }));
    let signed = 0;
    const fetchImpl = async (_u, init = {}) => { if (new Headers(init.headers || {}).get("X-PAYMENT")) { signed++; return new Response("data", { status: 200 }); } return json402({ accepts: [requirement()] }); };
    // a pool whose borrow is sent (it may have mined) and then `wait` decides what came back
    const pool = (wait) => ({ registry: async () => readDeploymentV2(4663).registry, getParams: async () => ({ minLoan: 1_000000n, maxLoan: 50_000000n, minTerm: 86400n, maxTerm: 30n * 86400n }), quoteFee: async () => [10_000n], interface: new ethers.Interface([]), borrow: async () => ({ hash: "0x" + "77".repeat(32), wait }) });
    const o = (p) => ({ signer, fetchImpl, asset: USDG_MAINNET, pool: p, agentId: 1, maxBorrow: 5_000000n });
    const lost = await pay("https://m.example/x", o(pool(async () => { throw Object.assign(new Error("eth_getTransactionReceipt: socket hang up"), { code: "NETWORK_ERROR" }); }))).then(() => null, (e) => e);
    assert.ok(lost instanceof FloatError && lost.code === "BORROW_UNCONFIRMED", `got ${lost?.code}: ${lost?.message}`);
    assert.equal(lost.borrowed, 1_000000n); assert.equal(lost.loanId, null); assert.equal(lost.dueAt, null);
    assert.equal(lost.unconfirmed, true); assert.equal(lost.hash, "0x" + "77".repeat(32));
    const reverted = await pay("https://m.example/x", o(pool(async () => { throw Object.assign(new Error("transaction execution reverted"), { code: "CALL_EXCEPTION", receipt: { status: 0 } }); }))).then(() => null, (e) => e);
    assert.equal(reverted?.code, "CALL_EXCEPTION"); assert.equal(reverted.borrowed, undefined, "a mined revert borrowed nothing");
    assert.equal(signed, 0, "nothing was signed or sent");
  } finally {
    s.server.close();
  }
});
await check("the facilitator URL the docs name is the one the SDK exports", () => {
  assert.equal(FACILITATOR_URL, "https://facilitator.priors.trade");
});

console.log("priors-v2 CLI");
const cli = (args, env = {}) => spawnSync(process.execPath, ["bin/priors-v2.mjs", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, timeout: 30_000 });
await check("a private key on the command line is refused, and not echoed back", () => {
  const key = ethers.Wallet.createRandom().privateKey;
  const r = cli(["status", key]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /private key was passed on the command line/);
  assert.ok(!(r.stdout + r.stderr).includes(key.slice(2)), "the key was printed");
});
await check("no key configured: a usage error, before any network call", () => {
  // Empty, not absent: a maintainer's own .env must not fill them in (env.mjs never overrides a set variable).
  const r = cli(["status"], { RPC_URL: "http://127.0.0.1:1", PRIORS_KEY: "", PRIVATE_KEY: "" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /PRIORS_KEY is not set/);
});
await check("an argument a command does not take is a usage error, before any key or network (a loan id typed after repay is not dropped)", () => {
  const env = { RPC_URL: "http://127.0.0.1:1", PRIORS_KEY: "", PRIVATE_KEY: "" };
  for (const [args, re] of [[["repay", "42"], /repay takes no loan id/], [["status", "999"], /status takes no argument/], [["join", "junk"], /join takes no argument/], [["repay", "--days", "3"], /--days is not an option of repay/], [["status", "--invite", "x"], /--invite is not an option of status/], [["borrow", "5", "--seat", "0x1"], /--seat is not an option of borrow/]]) {
    const r = cli(args, env);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, re, args.join(" "));
  }
  // the forms each command takes still reach the key check
  for (const args of [["repay"], ["repay", "--all"], ["status"], ["join", "--invite", "x"], ["borrow", "5", "--days", "3"]]) assert.match(cli(args, env).stderr, /PRIORS_KEY is not set/, args.join(" "));
});
await check("an unknown command is a usage error", () => {
  const r = cli(["frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});
await check("the v2 CLI is declared as a package bin, next to the v1 one", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.bin["priors-v2"], "bin/priors-v2.mjs");
  assert.equal(pkg.bin.priors, "bin/priors.mjs");
});

// Own audit, 2026-10-01: what a CLI or the client could be made to pay for someone else.
/* A chain-4663 stub for the CLIs and the client: eth_call answered by `call({ to, data })` (a hex result, or undefined
   for an error), eth_getLogs by `logs(filter)`. Every request is kept, so a test can say what was asked and sent. */
function chain({ call = () => undefined, logs = () => [] } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqs = [].concat(JSON.parse(body));
      const out = reqs.map((r) => {
        seen.push(r);
        const ok = (result) => ({ jsonrpc: "2.0", id: r.id, result });
        if (r.method === "eth_chainId") return ok("0x1237");
        if (r.method === "eth_blockNumber") return ok(ethers.toQuantity(71_702_470));
        if (r.method === "eth_call") { const v = call(r.params[0]); if (v !== undefined) return ok(v); }
        if (r.method === "eth_getLogs") return ok(logs(r.params[0]));
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
const bin = (name) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
/** A CLI run that lets this process answer its RPC (spawnSync would block the stub). A variable given as undefined is
 *  left out, so the .env in `cwd` can set it; the others are empty, so a maintainer's own .env cannot. */
const run = (name, args, env = {}, cwd = process.cwd()) => new Promise((ok) => {
  const vars = { PATH: process.env.PATH, HOME: process.env.HOME, PRIORS_KEY: "", PRIVATE_KEY: "", RPC_URL: "", PRIORS_RPC: "", POOL: "", ...env };
  for (const k of Object.keys(vars)) if (vars[k] === undefined) delete vars[k];
  const c = spawn(process.execPath, [bin(name), ...args], { cwd, env: vars });
  let stdout = "", stderr = "";
  c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
  const t = setTimeout(() => c.kill(), 30_000);
  c.on("close", (status) => { clearTimeout(t); ok({ status, stdout, stderr }); });
});
const inDir = (dotenv) => { const d = mkdtempSync(join(tmpdir(), "priors-cwd-")); writeFileSync(join(d, ".env"), dotenv); return d; };
const sel = (sig) => ethers.id(sig).slice(0, 10);
const REG = readDeploymentV2(4663).registry.toLowerCase();

await check("audit SD-1: priors-v2 takes only an identity minted to the key, never one transferred to it", async () => {
  const me = ethers.Wallet.createRandom();
  const T = ethers.id("Transfer(address,address,uint256)");
  const zero = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const filters = [];
  const c = await chain({
    call: ({ to, data }) => (to.toLowerCase() !== REG ? undefined : data.startsWith(sel("balanceOf(address)")) ? ethers.toBeHex(1, 32) : data.startsWith(sel("ownerOf(uint256)")) ? ethers.zeroPadValue(me.address, 32) : undefined),
    // a stranger pushed agent #6567 to this key: a Transfer from them, not a mint
    logs: (f) => { filters.push(f); return f.topics?.[1] ? [] : [{ address: REG, topics: [T, ethers.zeroPadValue("0x" + "ab".repeat(20), 32), ethers.zeroPadValue(me.address, 32).toLowerCase(), ethers.toBeHex(6567, 32)], data: "0x", blockNumber: "0x1", blockHash: "0x" + "00".repeat(32), transactionHash: "0x" + "00".repeat(32), transactionIndex: "0x0", logIndex: "0x0", removed: false }]; },
  });
  try {
    const r = await run("priors-v2.mjs", ["status"], { PRIORS_KEY: me.privateKey, PRIORS_RPC: c.url });
    assert.ok(filters.length > 0 && filters.every((f) => String(f.topics?.[1]).toLowerCase() === zero), `the search must ask for mints only: ${JSON.stringify(filters.map((f) => f.topics))}`);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /PRIORS_AGENT_ID/);
    assert.ok(!/#6567/.test(r.stdout), `the pushed agent was taken: ${r.stdout}`);
  } finally { c.server.close(); }
});

await check("GHSA-mmp8: priors-v2 drops an identity minted to the key that left it, even once it is back", async () => {
  const me = ethers.Wallet.createRandom();
  const T = ethers.id("Transfer(address,address,uint256)");
  const zero = ethers.zeroPadValue(ethers.ZeroAddress, 32).toLowerCase();
  const mine = ethers.zeroPadValue(me.address, 32).toLowerCase();
  const log = (from, to) => ({ address: REG, topics: [T, from, to, ethers.toBeHex(6567, 32)], data: "0x", blockNumber: "0x1", blockHash: "0x" + "00".repeat(32), transactionHash: "0x" + "00".repeat(32), transactionIndex: "0x0", logIndex: "0x0", removed: false });
  const c = await chain({
    call: ({ to, data }) => (to.toLowerCase() !== REG ? undefined : data.startsWith(sel("balanceOf(address)")) ? ethers.toBeHex(1, 32) : data.startsWith(sel("ownerOf(uint256)")) ? ethers.zeroPadValue(me.address, 32) : undefined),
    // #6567 was minted to this key, went to a stranger (who borrowed on it) and came back
    logs: (f) => { const from = String(f.topics?.[1] ?? "").toLowerCase(); return from === zero ? [log(zero, mine)] : from === mine ? [log(mine, ethers.zeroPadValue("0x" + "ab".repeat(20), 32))] : []; },
  });
  try {
    const r = await run("priors-v2.mjs", ["status"], { PRIORS_KEY: me.privateKey, PRIORS_RPC: c.url });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /PRIORS_AGENT_ID/);
    assert.ok(!/#6567/.test(r.stdout), `the round-tripped agent was taken: ${r.stdout}`);
  } finally { c.server.close(); }
});

await check("GHSA-mmp8: priors-v2 repay never pays a loan opened while someone else held the agent", async () => {
  const me = ethers.Wallet.createRandom();
  const pool = new ethers.Interface(POOL_V2_ABI);
  const P = readDeploymentV2(4663).pool.toLowerCase();
  const STRANGER = "0x" + "ab".repeat(20);
  const due = Math.floor(Date.now() / 1000) + 86400;
  // agent #9's one open loan, #14285, was opened by its interim holder
  const loan = [9n, 1n, 5_000000n, 11_666n, 0n, 0n, 0n, STRANGER, 1n, BigInt(due), BigInt(due + 3 * 86400), 0n, 0n, 1];
  const c = await chain({
    call: ({ to, data }) => {
      if (to.toLowerCase() === REG && data.startsWith(sel("ownerOf(uint256)"))) return ethers.zeroPadValue(me.address, 32);
      if (to.toLowerCase() !== P) return undefined;
      if (data.startsWith(sel("loansOf(uint256)"))) return pool.encodeFunctionResult("loansOf", [[14_285n]]);
      if (data.startsWith(sel("getLoan(uint256)"))) return pool.encodeFunctionResult("getLoan", [loan]);
      return undefined;
    },
  });
  try {
    for (const args of [["repay"], ["repay", "--all"]]) {
      const r = await run("priors-v2.mjs", args, { PRIORS_KEY: me.privateKey, PRIORS_RPC: c.url, PRIORS_AGENT_ID: "9" });
      assert.match(r.stdout + r.stderr, new RegExp(`loan #14285 .*opened by ${STRANGER}`, "i"), args.join(" "));
      assert.ok(!/repaid loan #14285/.test(r.stdout), `${args.join(" ")} repaid it: ${r.stdout}`);
    }
    assert.ok(!c.seen.some((r) => /send|estimate/i.test(r.method)), `something was sent: ${c.seen.map((r) => r.method)}`);
  } finally { c.server.close(); }
});

await check("GHSA-rr73: a PRIORS_AGENT_ID from a .env does not make repay pay a loan the agent's owner now did not take", async () => {
  const me = ethers.Wallet.createRandom();
  const pool = new ethers.Interface(POOL_V2_ABI);
  const P = readDeploymentV2(4663).pool.toLowerCase();
  const STRANGER = "0x" + "ab".repeat(20);
  const due = Math.floor(Date.now() / 1000) + 86400;
  // agent #9, bought by this key, still carries the seller's loan #300
  const loan = [9n, 1n, 10_000000n, 20_000n, 0n, 0n, 0n, STRANGER, 1n, BigInt(due), BigInt(due + 3 * 86400), 0n, 0n, 1];
  const c = await chain({
    call: ({ to, data }) => {
      if (to.toLowerCase() === REG && data.startsWith(sel("ownerOf(uint256)"))) return ethers.zeroPadValue(me.address, 32);
      if (to.toLowerCase() !== P) return undefined;
      if (data.startsWith(sel("loansOf(uint256)"))) return pool.encodeFunctionResult("loansOf", [[300n]]);
      if (data.startsWith(sel("getLoan(uint256)"))) return pool.encodeFunctionResult("getLoan", [loan]);
      return undefined;
    },
  });
  const dir = inDir("PRIORS_AGENT_ID=9\n");
  try {
    const r = await run("priors-v2.mjs", ["repay", "--all"], { PRIORS_KEY: me.privateKey, PRIORS_RPC: c.url }, dir);
    assert.match(r.stdout + r.stderr, new RegExp(`loan #300 .*opened by ${STRANGER}`, "i"));
    assert.ok(!/repaid loan #300/.test(r.stdout), `it repaid: ${r.stdout}`);
    assert.ok(!c.seen.some((q) => /send|estimate/i.test(q.method)), `something was sent: ${c.seen.map((q) => q.method)}`);
  } finally { c.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

await check("GHSA-95v6: on a real chain, an addresses file from a .env must keep the published deployBlock, unless the opt-in is exported", async () => {
  const c = await chain();
  const dir = inDir("");
  const file = join(dir, "addresses.json");
  writeFileSync(file, JSON.stringify({ ...readDeploymentV2(4663), deployBlock: readDeploymentV2(4663).deployBlock - 1 }));
  writeFileSync(join(dir, ".env"), `PRIORS_ADDRESSES=${file}\n`);
  try {
    const key = ethers.Wallet.createRandom().privateKey;
    const r = await run("priors-v2.mjs", ["repay"], { PRIORS_KEY: key, PRIORS_RPC: c.url }, dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /differs from the published Robinhood Chain deployment \(deployBlock\)/);
    assert.ok(!c.seen.some((q) => q.method === "eth_getLogs" || /send|estimate/i.test(q.method)), `it searched or sent: ${c.seen.map((q) => q.method)}`);
  } finally { c.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

await check("GHSA-5c2h: PriorsV2.repay refuses a loan opened while someone else held the agent, before any approval", async () => {
  const me = ethers.Wallet.createRandom();
  const pool = new ethers.Interface(POOL_V2_ABI);
  const P = readDeploymentV2(4663).pool.toLowerCase();
  const STRANGER = "0x" + "ab".repeat(20);
  // agent #9 is this key's now (owner and controller); loan #14285 was opened by its interim holder
  const loan = [9n, 1n, 10_000000n, 23_333n, 0n, 0n, 0n, STRANGER, 1n, 2n, 3n, 0n, 0n, 1];
  const c = await chain({ call: ({ to, data }) => {
    if (to.toLowerCase() === REG && data.startsWith(sel("ownerOf(uint256)"))) return ethers.zeroPadValue(me.address, 32);
    if (to.toLowerCase() !== P) return undefined;
    if (data.startsWith(sel("getLoan(uint256)"))) return pool.encodeFunctionResult("getLoan", [loan]);
    if (data.startsWith(sel("isController(uint256,address)"))) return ethers.toBeHex(1, 32);
    if (data.startsWith(sel("registry()"))) return ethers.zeroPadValue(REG, 32);
    return undefined;
  } });
  try {
    const s = new PriorsV2({ signer: me.connect(new ethers.JsonRpcProvider(c.url, 4663, { staticNetwork: true })), addresses: readDeploymentV2(4663) });
    await assert.rejects(s.repay(14_285, { agentId: 9 }), new RegExp(`opened by ${STRANGER}`, "i"));
    assert.ok(!c.seen.some((r) => /send|estimate/i.test(r.method)), `something was sent: ${c.seen.map((r) => r.method)}`);
  } finally { c.server.close(); }
});

await check("GHSA-9pw7: PriorsV2.repay pays nothing for an agent whose owner named this key its pool delegate without its consent (neither the owner nor its declared ERC-8004 wallet), before any approval", async () => {
  const me = ethers.Wallet.createRandom();
  const pool = new ethers.Interface(POOL_V2_ABI);
  const P = readDeploymentV2(4663).pool.toLowerCase();
  const BUYER = "0x" + "b0".repeat(20);
  // agent #9 was this key's; its buyer opened loan #14285 and named this key its delegate (setDelegate needs no word from it)
  const loan = [9n, 1n, 10_000000n, 23_333n, 0n, 0n, 0n, BUYER, 1n, 2n, 3n, 0n, 0n, 1];
  let declared = ethers.ZeroAddress;
  const c = await chain({ call: ({ to, data }) => {
    if (to.toLowerCase() === REG && data.startsWith(sel("ownerOf(uint256)"))) return ethers.zeroPadValue(BUYER, 32);
    if (to.toLowerCase() === REG && data.startsWith(sel("getAgentWallet(uint256)"))) return ethers.zeroPadValue(declared, 32);
    if (to.toLowerCase() !== P) return undefined;
    if (data.startsWith(sel("getLoan(uint256)"))) return pool.encodeFunctionResult("getLoan", [loan]);
    if (data.startsWith(sel("isController(uint256,address)"))) return ethers.toBeHex(1, 32);
    if (data.startsWith(sel("registry()"))) return ethers.zeroPadValue(REG, 32);
    return undefined;
  } });
  try {
    const s = new PriorsV2({ signer: me.connect(new ethers.JsonRpcProvider(c.url, 4663, { staticNetwork: true })), addresses: readDeploymentV2(4663) });
    for (const d of [ethers.ZeroAddress, "0x" + "cc".repeat(20)]) {
      declared = d;
      await assert.rejects(s.repay(14_285, { agentId: 9 }), /neither agent #9's owner .* nor its declared ERC-8004 wallet/i, `declared ${d}`);
    }
    assert.ok(!c.seen.some((r) => /send|estimate/i.test(r.method)), `something was sent: ${c.seen.map((r) => r.method)}`);
    // the agent's declared wallet (its key, signed for this owner) goes on to pay: it is not refused by this rule
    declared = me.address;
    await assert.rejects(s.repay(14_285, { agentId: 9 }), (e) => !/neither agent #9's owner/i.test(e.message), "the declared wallet was refused");
  } finally { c.server.close(); }
});

await check("GHSA-9pw7: PriorsV2.borrow refuses the same key repay refuses (a pool delegate that is neither the owner nor the declared ERC-8004 wallet), before any read or send; the owner and the declared wallet borrow", async () => {
  const me = ethers.Wallet.createRandom();
  const pool = new ethers.Interface(POOL_V2_ABI);
  const P = readDeploymentV2(4663).pool.toLowerCase();
  const BUYER = "0x" + "b0".repeat(20);
  let owner = BUYER, declared = ethers.ZeroAddress;
  const c = await chain({ call: ({ to, data }) => {
    if (to.toLowerCase() === REG && data.startsWith(sel("ownerOf(uint256)"))) return ethers.zeroPadValue(owner, 32);
    if (to.toLowerCase() === REG && data.startsWith(sel("getAgentWallet(uint256)"))) return ethers.zeroPadValue(declared, 32);
    if (to.toLowerCase() !== P) return undefined;
    if (data.startsWith(sel("registry()"))) return ethers.zeroPadValue(REG, 32);
    if (data.startsWith(sel("isController(uint256,address)"))) return ethers.toBeHex(1, 32);
    if (data.startsWith(sel("quoteFee(uint256,uint256,uint64)"))) return pool.encodeFunctionResult("quoteFee", [10_000n, 0n, 0n, 0n]);
    if (data.startsWith(sel("getAgent(uint256)"))) return undefined; // no V5 line in this addresses file
    return undefined;
  } });
  try {
    const s = new PriorsV2({ signer: me.connect(new ethers.JsonRpcProvider(c.url, 4663, { staticNetwork: true })), addresses: readDeploymentV2(4663) });
    for (const d of [ethers.ZeroAddress, "0x" + "cc".repeat(20)]) {
      declared = d;
      await assert.rejects(s.borrow(9, 5, 7 * 86400), /neither agent #9's owner .* nor its declared ERC-8004 wallet/i, `declared ${d}`);
      await assert.rejects(s.borrow(9, 5, 7 * 86400), /nothing was borrowed/i);
    }
    assert.ok(!c.seen.some((r) => /send|estimate/i.test(r.method)), `something was sent: ${c.seen.map((r) => r.method)}`);
    // the owner, and the agent's declared wallet, get past this rule (they fail later, on the stub's missing borrow)
    for (const who of ["owner", "declared"]) {
      owner = who === "owner" ? me.address : BUYER;
      declared = who === "declared" ? me.address : ethers.ZeroAddress;
      await assert.rejects(s.borrow(9, 5, 7 * 86400), (e) => !/neither agent #9's owner/i.test(e.message), `${who} was refused by the GHSA-9pw7 rule`);
    }
  } finally { c.server.close(); }
});

await check("audit SD-2: PriorsV2.repay needs the caller's agent, and refuses another agent's loan, or one of an agent the key does not control, before any approval, even when the RPC vouches for it", async () => {
  const me = ethers.Wallet.createRandom();
  const pool = new ethers.Interface(POOL_V2_ABI);
  const P = readDeploymentV2(4663).pool.toLowerCase();
  const loan = [9n, 1n, 10_000000n, 23_333n, 0n, 0n, 0n, "0x" + "ab".repeat(20), 1n, 2n, 3n, 0n, 0n, 1];
  let controls = true; // a lying RPC says this key controls agent #9
  const c = await chain({ call: ({ to, data }) => (to.toLowerCase() !== P ? undefined : data.startsWith(sel("getLoan(uint256)")) ? pool.encodeFunctionResult("getLoan", [loan]) : data.startsWith(sel("isController(uint256,address)")) ? ethers.toBeHex(controls ? 1 : 0, 32) : undefined) });
  try {
    const s = new PriorsV2({ signer: me.connect(new ethers.JsonRpcProvider(c.url, 4663, { staticNetwork: true })), addresses: readDeploymentV2(4663) });
    await assert.rejects(s.repay(14_285), /name the agent whose loan this is/);
    await assert.rejects(s.repay(14_285, { agentId: 7 }), /agent #9's, not #7's/);
    controls = false;
    await assert.rejects(s.repay(14_285, { agentId: 9 }), /does not control/);
    assert.ok(!c.seen.some((r) => /send|estimate/i.test(r.method)), `something was sent: ${c.seen.map((r) => r.method)}`);
  } finally { c.server.close(); }
});

await check("audit SD-3: on a real chain, an RPC a .env names must be a documented public endpoint, unless exported", async () => {
  const c = await chain();
  const dir = inDir(`PRIORS_RPC=${c.url}\n`);
  try {
    const key = ethers.Wallet.createRandom().privateKey;
    const r = await run("priors-v2.mjs", ["status"], { PRIORS_KEY: key, PRIORS_RPC: undefined }, dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /PRIORS_RPC comes from a \.env file/);
    assert.ok(!r.stderr.includes(c.url), "the RPC is not printed");
    const shell = await run("priors-v2.mjs", ["status"], { PRIORS_KEY: key, PRIORS_RPC: c.url }, dir);
    assert.ok(!/comes from a \.env file/.test(shell.stderr), `an exported RPC is the user's choice: ${shell.stderr}`);
  } finally { c.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

await check("audit SD-4: the v1 CLI refuses POOL/TREASURY/USDC from a .env on a real chain unless the opt-in is exported", async () => {
  const c = await chain();
  const dir = inDir("POOL=0x000000000000000000000000000000000000bEEF\n");
  try {
    const r = await run("priors.mjs", ["score", "1"], { RPC_URL: c.url, POOL: undefined }, dir);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr + r.stdout, /differ from the published/);
  } finally { c.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

await check("audit SD-6: a key in a .env is never printed: an inline comment is not part of it, and a malformed one is refused by name", async () => {
  const c = await chain();
  const key = ethers.Wallet.createRandom().privateKey;
  for (const line of [`PRIVATE_KEY=${key} # deployer`, `PRIVATE_KEY=${key.slice(0, -1)}zz`]) {
    const dir = inDir(`${line}\n`);
    try {
      const r = await run("priors.mjs", ["score", "1"], { RPC_URL: c.url, PRIVATE_KEY: undefined }, dir);
      assert.ok(!(r.stdout + r.stderr).toLowerCase().includes(key.slice(2, 40).toLowerCase()), `the key was printed: ${r.stdout}${r.stderr}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  c.server.close();
});

await check("audit SD-7: priors-v2 refuses --agent rather than ignore it (PRIORS_AGENT_ID names the identity)", () => {
  const r = cli(["status", "--agent", "6228"], { PRIORS_KEY: ethers.Wallet.createRandom().privateKey });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option --agent/);
});

console.log(failed ? `\ntest-sdk-v2: ${failed} failed, ${passed} passed` : `\ntest-sdk-v2: all ${passed} good`);
process.exit(failed ? 1 : 0);
