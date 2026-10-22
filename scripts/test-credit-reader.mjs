// The ERC-8004 credit reader (sdk/credit-reader.mjs) and its command (scripts/verify-credit.mjs), network-free: an
// in-memory chain (the reputation registry, lenders, tokens) served over JSON-RPC on 127.0.0.1 and read through ethers'
// JsonRpcProvider, as a real endpoint would be. Each test is a lender's history and a writer's entries, honest or not,
// and what the reader must say about them. The format alone is scripts/test-credit-profile.mjs; the real chain is
// scripts/test-credit-fork.mjs.
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import * as P from "../sdk/credit-profile.mjs";
import { readCredit, findEntries, openEntry, LIMITS } from "../sdk/credit-reader.mjs";
import { REPUTATION_REGISTRY, REGISTRY_ABI, NEW_FEEDBACK } from "../sdk/attestation.mjs";

let passed = 0;
const failed = [];
const t = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed.push(name); console.log(`not ok - ${name}\n  ${String(e?.message || e).slice(0, 2000).split("\n").join("\n  ")}\n  ${String(e?.stack || "").split("\n").find((l) => l.includes("test-credit-reader")) || ""}`); }
};

// ---- an in-memory chain behind JSON-RPC -------------------------------------------------------------------------
const CHAIN = 4663;
const time = (b) => 1_700_000_000 + 2 * b;
const lc = (s) => String(s).toLowerCase();
const q = (n) => ethers.toQuantity(n);
const bh = (n) => ethers.id(`block ${n}`);
const NF = new ethers.Interface([NEW_FEEDBACK]);
const REG = new ethers.Interface(REGISTRY_ABI);
const ERC20 = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

class Chain {
  constructor() { this.logs = []; this.receipts = new Map(); this.head = 1; this.n = 0; this.perBlock = new Map(); this.feedback = new Map(); this.last = new Map(); this.tokens = new Map(); this.getLogs = 0; }
  token(address, decimals, symbol) { this.tokens.set(lc(address), { decimals, symbol }); }
  /** The chain moves on to `block` with nothing in it. */
  mine(block) { this.head = Math.max(this.head, block); }
  /** One transaction in `block` holding `logs` ([{ address, topics, data }]). */
  tx(block, logs) {
    const hash = ethers.zeroPadValue(ethers.toBeHex(++this.n), 32);
    let i = this.perBlock.get(block) || 0;
    const out = logs.map((l) => ({ ...l, address: ethers.getAddress(l.address), blockNumber: block, transactionHash: hash, index: i++ }));
    this.perBlock.set(block, i);
    this.logs.push(...out);
    this.receipts.set(hash, { block, logs: out });
    this.head = Math.max(this.head, block);
    return { hash, logs: out };
  }
  /** giveFeedback as the registry logs it (NewFeedback), with what readFeedback answers for it. */
  post({ writer, agentId, block, uri, hash, value = 0n, valueDecimals = 6, tag1 = P.TAG_STATEMENT, tag2 = "unsecured", revoked = false }) {
    const k = `${BigInt(agentId)}:${lc(writer)}`;
    const index = (this.last.get(k) || 0) + 1;
    this.last.set(k, index);
    const r = this.tx(block, [{ address: REPUTATION_REGISTRY, ...NF.encodeEventLog("NewFeedback", [agentId, writer, index, value, valueDecimals, tag1, tag1, tag2, "", uri, hash]) }]);
    this.feedback.set(`${k}:${index}`, { value, valueDecimals, tag1, tag2, revoked });
    return { index, txHash: r.hash, blockNumber: block };
  }
  /** Post exactly these bytes (or this URI), as a writer could. */
  postBytes(writer, agentId, block, bytes, { uri, file = null } = {}) {
    const b = typeof bytes === "string" ? ethers.toUtf8Bytes(bytes) : bytes;
    let value = 0n;
    try { value = BigInt(file?.value ?? 0); } catch (_) { /* a malformed file: 0 on chain */ }
    return this.post({ writer, agentId, block, uri: uri ?? P.DATA_URI_PREFIX + ethers.encodeBase64(b), hash: ethers.keccak256(b), value, valueDecimals: Number(file?.valueDecimals ?? 6) || 0, tag1: typeof file?.tag1 === "string" ? file.tag1 : P.TAG_STATEMENT, tag2: typeof file?.tag2 === "string" ? file.tag2 : "unsecured" });
  }
  /** Post what the SDK's encodeFile gives. */
  postEnc(writer, agentId, block, enc) {
    return this.post({ writer, agentId, block, uri: enc.feedbackURI, hash: enc.feedbackHash, value: BigInt(enc.file.value), valueDecimals: Number(enc.file.valueDecimals), tag1: enc.file.tag1, tag2: enc.file.tag2 });
  }
}

const logJson = (l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: q(l.blockNumber), blockHash: bh(l.blockNumber), transactionHash: l.transactionHash, transactionIndex: "0x0", logIndex: q(l.index), removed: false });
const topicMatch = (want, got) => want == null || (Array.isArray(want) ? want.some((w) => w == null || lc(w) === lc(got)) : lc(want) === lc(got));
function handle(c, method, params) {
  switch (method) {
    case "eth_chainId": return q(CHAIN);
    case "net_version": return String(CHAIN);
    case "eth_blockNumber": return q(c.head);
    case "eth_getBlockByNumber": {
      const n = params[0] === "latest" ? c.head : Number(params[0]);
      if (n > c.head) return null;
      return { number: q(n), hash: bh(n), parentHash: bh(n - 1), timestamp: q(time(n)), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: ethers.ZeroAddress, extraData: "0x", baseFeePerGas: "0x1", stateRoot: ethers.ZeroHash, receiptsRoot: ethers.ZeroHash, transactions: [] };
    }
    case "eth_getLogs": {
      c.getLogs++;
      const f = params[0];
      const from = Number(f.fromBlock), to = Number(f.toBlock);
      const addrs = f.address == null ? null : [].concat(f.address).map(lc);
      return c.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && (!addrs || addrs.includes(lc(l.address))) && (f.topics || []).every((w, i) => topicMatch(w, l.topics[i]) && (w == null || l.topics[i] != null))).map(logJson);
    }
    case "eth_getTransactionReceipt": {
      const r = c.receipts.get(lc(params[0]));
      if (!r) return null;
      return { transactionHash: lc(params[0]), transactionIndex: "0x0", blockHash: bh(r.block), blockNumber: q(r.block), from: "0x00000000000000000000000000000000000A6E17", to: r.logs.at(-1)?.address || null, contractAddress: null, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", logsBloom: "0x" + "00".repeat(256), logs: r.logs.map(logJson), status: "0x1", type: "0x2" };
    }
    case "eth_call": {
      const { to, data } = params[0];
      if (lc(to) === lc(REPUTATION_REGISTRY)) {
        const d = REG.parseTransaction({ data });
        if (d.name === "getLastIndex") return REG.encodeFunctionResult("getLastIndex", [c.last.get(`${d.args[0]}:${lc(d.args[1])}`) || 0]);
        const f = c.feedback.get(`${d.args[0]}:${lc(d.args[1])}:${d.args[2]}`);
        if (!f) throw new Error("execution reverted: no such feedback");
        return REG.encodeFunctionResult("readFeedback", [f.value, f.valueDecimals, f.tag1, f.tag2, f.revoked]);
      }
      const tk = c.tokens.get(lc(to));
      if (tk) { const d = ERC20.parseTransaction({ data }); return ERC20.encodeFunctionResult(d.name, [tk[d.name]]); }
      return "0x"; // no code at that address
    }
    default: throw new Error(`unsupported ${method}`);
  }
}
const server = { chain: new Chain(), requests: 0 }; // requests: every JSON-RPC request answered
const srv = http.createServer(async (req, res) => {
  let body = "";
  for await (const ch of req) body += ch;
  const msg = JSON.parse(body);
  server.requests += Array.isArray(msg) ? msg.length : 1;
  const one = (m) => { try { return { jsonrpc: "2.0", id: m.id, result: handle(server.chain, m.method, m.params) }; } catch (e) { return { jsonrpc: "2.0", id: m.id, error: { code: 3, message: e.message, data: "0x" } }; } };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${srv.address().port}`;
const provider = () => new ethers.JsonRpcProvider(URL_, CHAIN, { staticNetwork: true, batchMaxCount: 1 });

// ---- lenders, writers ---------------------------------------------------------------------------------------------
const EV = {
  open: "Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint64 dueAt)",
  repaid: "Repaid(uint256 indexed loanId, uint256 indexed agentId, uint256 principal)",
  defaulted: "Defaulted(uint256 indexed loanId, uint256 indexed agentId, uint256 principal)",
};
const LI = new ethers.Interface(Object.values(EV).map((s) => `event ${s}`));
const WALLET = "0x00000000000000000000000000000000000A6E17";
const IDR = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const USDG = ethers.getAddress("0x0000000000000000000000000000000000005D01");
const T18 = ethers.getAddress("0x0000000000000000000000000000000000001818");
const W = (n) => ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0xbeef00 + n), 20));
const [W1, W2, W3, W4, W5, W6, W9] = [1, 2, 3, 4, 5, 6, 9].map(W);
const POOL = (n) => ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0xa00000 + n), 20));
const AGENT = 7n;
const assetOf = (token, chainId = CHAIN) => `eip155:${chainId}/erc20:${ethers.getAddress(token)}`;
const zero = () => ({ count: 0, amount: "0" });
const sum = (ls) => ({ count: ls.length, amount: ls.reduce((s, l) => s + BigInt(l.principal), 0n).toString() });
const addT = (a, b) => ({ count: a.count + b.count, amount: (BigInt(a.amount) + BigInt(b.amount)).toString() });
const merge = (...ws) => ({ leaves: ws.flatMap((w) => w.leaves), opened: ws.map((w) => w.opened).reduce(addT, zero()), outstanding: ws.map((w) => w.outstanding).reduce(addT, zero()) });
/** The RFC 8785 subset this profile writes (sorted keys, no whitespace), written here independently of the SDK. */
const canon = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`);

class Lender {
  constructor(chain, contract, token, start) { Object.assign(this, { chain, contract: ethers.getAddress(contract), token: ethers.getAddress(token), start }); this.loans = new Map(); }
  source(end = null) { return { chainId: CHAIN, contract: this.contract, blocks: [this.start, end], events: EV, fields: { amount: "principal", dueAt: "dueAt" } }; }
  borrow(loan, agent, principal, block, { dueIn = 100, paid = principal } = {}) {
    const dueAt = time(block) + dueIn;
    const r = this.chain.tx(block, [
      { address: this.token, ...ERC20.encodeEventLog("Transfer", [this.contract, WALLET, paid]) },
      { address: this.contract, ...LI.encodeEventLog("Borrowed", [loan, agent, principal, dueAt]) },
    ]);
    this.loans.set(String(loan), { loan: String(loan), agent: BigInt(agent), principal: String(principal), dueAt, open: { block, tx: r.hash, log: r.logs[1].index } });
  }
  /** `quiet`: the close log with no transfer behind it (a contract can emit loan events with no money moving). */
  close(loan, block, { defaulted = false, quiet = false } = {}) {
    const L = this.loans.get(String(loan));
    const logs = defaulted || quiet ? [] : [{ address: this.token, ...ERC20.encodeEventLog("Transfer", [WALLET, this.contract, L.principal]) }];
    logs.push({ address: this.contract, ...LI.encodeEventLog(defaulted ? "Defaulted" : "Repaid", [loan, L.agent, L.principal]) });
    const r = this.chain.tx(block, logs);
    const closedAt = time(block);
    L.leaf = { cls: "unsecured", loan: L.loan, amount: L.principal, dueAt: L.dueAt, closedAt, outcome: P.outcomeOf({ defaulted, closedAt, dueAt: L.dueAt }), block, tx: r.hash, log: r.logs.at(-1).index, openBlock: L.open.block, openTx: L.open.tx, openLog: L.open.log };
    return L.leaf;
  }
  /** What a statement over [from, to] holds for `agent` at this source: its leaves (as source `src`), opened, outstanding. */
  window(agent, from, to, src = 0) {
    const mine = [...this.loans.values()].filter((l) => l.agent === BigInt(agent));
    return {
      leaves: mine.filter((l) => l.leaf && l.leaf.block >= from && l.leaf.block <= to).map((l) => ({ ...l.leaf, src })),
      opened: sum(mine.filter((l) => l.open.block >= from && l.open.block <= to)),
      outstanding: sum(mine.filter((l) => l.open.block <= to && !(l.leaf && l.leaf.block <= to))),
    };
  }
}

function world() {
  const chain = new Chain();
  server.chain = chain;
  chain.token(USDG, 6, "USDG");
  chain.token(T18, 18, "T18");
  return { chain, A: new Lender(chain, POOL(1), USDG, 100), B: new Lender(chain, POOL(2), USDG, 100), C: new Lender(chain, POOL(3), USDG, 100), D: new Lender(chain, POOL(4), T18, 100) };
}
function statement({ writer = W1, agentId = AGENT, sources, seq = 1, prev = null, from, to, w, asset = assetOf(USDG), decimals = 6 }) {
  return P.statementFile({ chainId: CHAIN, identityRegistry: IDR, writer, agentId, asset, decimals, sources, seq, prev, window: { fromBlock: from, toBlock: to, toTime: time(to) }, leaves: w.leaves, opened: w.opened, outstanding: w.outstanding, createdAt: time(to) + 10, lender: { name: "Test lender" } });
}
async function read(agentId, o = {}) {
  const p = provider();
  try { return await readCredit(p, agentId, { fromBlock: 1, ...o }); } finally { p.destroy(); }
}
const CLI = new URL("./verify-credit.mjs", import.meta.url).pathname;
/** verify-credit against the in-memory chain: { code, out }. VERBOSE=1 prints each run. */
const cli = (args) => new Promise((res) => execFile(process.execPath, [CLI, ...args, "--rpc", URL_, "--from-block", "1"], { timeout: 120_000 }, (e, stdout, stderr) => {
  const r = { code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: `${stdout}${stderr}` };
  if (process.env.VERBOSE) console.log(`  $ verify-credit ${args.join(" ")}  (exit ${r.code})\n${r.out.replace(/^/gm, "  | ")}`);
  res(r);
}));
const probs = (r, i = 0) => r.writers[i].problems.join("\n");
const byWriter = (r, w) => r.writers.find((x) => lc(x.writer) === lc(w));
/** A reader's manifest, { "<writer>": [source, ...] } -> { "<writer>": { sources } }. */
const pin = (o) => Object.fromEntries(Object.entries(o).map(([w, sources]) => [w, { sources }]));
/** `fn(path)` with `manifest` written to a scratch file, for the command's --sources. */
async function withManifest(manifest, fn) {
  const dir = mkdtempSync(join(tmpdir(), "credit-reader-"));
  try { const f = join(dir, "sources.json"); writeFileSync(f, JSON.stringify(manifest)); return await fn(f); } finally { rmSync(dir, { recursive: true }); }
}

/** The audit's padded statement: five real repayments carried as anchors, the default left out, 1000 loans claimed. */
function padded() {
  const { chain, A } = world();
  for (let i = 1; i <= 5; i++) { A.borrow(i, AGENT, 1_000_000, 100 + i * 10); A.close(i, 105 + i * 10); }
  A.borrow(6, AGENT, 9_000_000, 170);
  A.close(6, 300, { defaulted: true });
  const honest = A.window(AGENT, 100, 400);
  const f = statement({ sources: [A.source()], from: 100, to: 400, w: { ...honest, leaves: honest.leaves.filter((l) => l.outcome !== P.DEFAULTED) } });
  const claim = { count: 1000, amount: "999000000000" };
  f.value = claim.amount;
  f.credit.closed = { onTime: claim, late: zero(), defaulted: zero(), recovered: zero() };
  f.credit.classes = { unsecured: { onTime: claim, late: zero(), defaulted: zero(), recovered: zero() } };
  f.credit.leaves = 1000;
  f.credit.root = ethers.id("any root");
  chain.postBytes(W1, AGENT, 410, canon(f), { file: f });
  return { chain, A };
}

// ---- 1. light mode -------------------------------------------------------------------------------------------------
await t("1. light mode samples, it does not verify: its claims are never counted; full mode rebuilds, counts (with the reader's manifest), and fails a padded statement", async () => {
  const { chain, A } = world();
  A.borrow(1, AGENT, 5_000_000, 110); A.close(1, 120);
  A.borrow(2, AGENT, 7_000_000, 130, { dueIn: 10 }); A.close(2, 200); // late
  A.borrow(3, AGENT, 1_000_000, 210); // outstanding at 400
  chain.postEnc(W1, AGENT, 410, P.encodeFile(statement({ sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) })));
  let r = await read(AGENT, { writers: [W1], mode: "light", manifest: pin({ [W1]: [A.source()] }) });
  assert.deepEqual(r.writers[0].problems, []);
  assert.equal(r.writers[0].status, "sampled");
  assert.equal(r.writers[0].ok, true, "nothing light mode checked is wrong");
  assert.equal(r.writers[0].claimed.onTime.count, 1);
  assert.equal(r.totals.onTime.count, 0, "light mode counts no claim");
  r = await read(AGENT, { writers: [W1], mode: "full", manifest: pin({ [W1]: [A.source()] }) });
  assert.deepEqual(r.writers[0].problems, []);
  assert.equal(r.writers[0].status, "rebuilt");
  assert.deepEqual([r.totals.onTime.count, r.totals.late.count, r.totals.late.amount], [1, 1, "7000000"]);
  // without --writer nobody is trusted, so nothing is counted even when rebuilt
  r = await read(AGENT, { mode: "full" });
  assert.equal(r.writers[0].status, "rebuilt");
  assert.equal(r.totals.onTime.count, 0, "untrusted writers are not added up");

  padded();
  r = await read(AGENT, { writers: [W1], mode: "light" });
  assert.deepEqual(r.writers[0].problems, [], "every anchor is real: light mode finds nothing wrong");
  assert.equal(r.writers[0].status, "sampled");
  assert.equal(r.writers[0].claimed.onTime.count, 1000);
  assert.equal(r.totals.onTime.count, 0, "the padded claims are not counted");
  assert.deepEqual(r.counted, {});
  r = await read(AGENT, { writers: [W1], mode: "full" });
  assert.equal(r.writers[0].status, "failed");
  assert.match(probs(r), /root rebuilt from the chain/);
  assert.match(probs(r), /defaulted 1/);
  assert.equal(r.totals.onTime.count, 0);
});

await t("1. verify-credit names the mode and what light mode did not check; light exits 0 and counts nothing, full exits 1", async () => {
  padded();
  let c = await cli([String(AGENT), "--writer", W1]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /light/i);
  assert.match(c.out, /not checked/i);
  assert.match(c.out, /claim/i);
  assert.doesNotMatch(c.out, /counted[^\n]*1000/, "light claims are printed as counted");
  c = await cli([String(AGENT), "--writer", W1, "--full"]);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /fund movement is sampled/i);
});

// ---- 2. omission before seq 1, undeclared sources ------------------------------------------------------------------
await t("2. seq 1 starts at or before every declared source's first block: a default before it is not left out", async () => {
  const { chain, A } = world();
  A.borrow(1, AGENT, 5_000_000, 110); A.close(1, 150, { defaulted: true });
  A.borrow(2, AGENT, 1_000_000, 210); A.close(2, 220);
  chain.postEnc(W1, AGENT, 410, P.encodeFile(statement({ sources: [A.source()], from: 200, to: 400, w: A.window(AGENT, 200, 400) })));
  const r = await read(AGENT, { writers: [W1], mode: "full" });
  assert.match(probs(r), /seq 1 starts at block 200, after the first block of source .*\(100\)/);
});

await t("2. a later statement declares every earlier source whose range reaches its window", async () => {
  const run = async (bEnd) => {
    const { chain, A, B } = world();
    A.borrow(1, AGENT, 5_000_000, 110); A.close(1, 120);
    B.borrow(1, AGENT, 2_000_000, 130); B.close(1, 140);
    A.borrow(2, AGENT, 1_000_000, 450); A.close(2, 460);
    const e1 = P.encodeFile(statement({ sources: [A.source(), B.source(bEnd)], from: 100, to: 400, w: merge(A.window(AGENT, 100, 400, 0), B.window(AGENT, 100, 400, 1)) }));
    chain.postEnc(W1, AGENT, 410, e1);
    chain.postEnc(W1, AGENT, 610, P.encodeFile(statement({ sources: [A.source()], seq: 2, prev: e1.feedbackHash, from: 401, to: 600, w: A.window(AGENT, 401, 600) })));
    return read(AGENT, { writers: [W1], mode: "full" });
  };
  const r = await run(null);
  assert.match(probs(r), new RegExp(`seq 2 does not declare source ${POOL(2)}`, "i"));
  const ended = await run(300); // B's declared range ends before seq 2: it need not be declared
  assert.deepEqual(ended.writers[0].problems, []);
});

await t("2. a source's declared end does not narrow the rebuild: a default after it is found", async () => {
  const { chain, A, B } = world();
  A.borrow(1, AGENT, 5_000_000, 110); A.close(1, 120);
  B.borrow(1, AGENT, 2_000_000, 130); B.close(1, 140);
  B.borrow(2, AGENT, 3_000_000, 450); B.close(2, 500, { defaulted: true }); // after the end B's declaration claims
  const e1 = P.encodeFile(statement({ sources: [A.source(), B.source(300)], from: 100, to: 400, w: merge(A.window(AGENT, 100, 400, 0), B.window(AGENT, 100, 400, 1)) }));
  chain.postEnc(W1, AGENT, 410, e1);
  chain.postEnc(W1, AGENT, 610, P.encodeFile(statement({ sources: [A.source()], seq: 2, prev: e1.feedbackHash, from: 401, to: 600, w: A.window(AGENT, 401, 600) })));
  const r = await read(AGENT, { writers: [W1], mode: "full" });
  assert.match(probs(r), /seq 2: defaulted 1/);
});

await t("2. a reader's manifest of a writer's sources: an undeclared source is required and rebuilt, its start enforced", async () => {
  const { chain, A, C } = world();
  A.borrow(1, AGENT, 5_000_000, 110); A.close(1, 120);
  C.borrow(1, AGENT, 4_000_000, 200); C.close(1, 250, { defaulted: true });
  chain.postEnc(W1, AGENT, 410, P.encodeFile(statement({ sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) })));
  // what a reader without a manifest cannot see: the writer never names C
  let r = await read(AGENT, { writers: [W1], mode: "full" });
  assert.deepEqual(r.writers[0].problems, []);
  const manifest = { [W1]: { sources: [A.source(), C.source()] } };
  r = await read(AGENT, { writers: [W1], mode: "full", manifest });
  assert.match(probs(r), new RegExp(`seq 1 does not declare source ${C.contract} of the reader's manifest`, "i"));
  assert.match(probs(r), /seq 1: defaulted 1/);
  const dir = mkdtempSync(join(tmpdir(), "credit-reader-"));
  try {
    writeFileSync(join(dir, "sources.json"), JSON.stringify(manifest));
    const c = await cli([String(AGENT), "--writer", W1, "--full", "--sources", join(dir, "sources.json")]);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /manifest/);
  } finally { rmSync(dir, { recursive: true }); }
  // the manifest's first block binds seq 1, whatever the writer declares
  const w2 = world();
  w2.A.borrow(1, AGENT, 5_000_000, 150); w2.A.close(1, 160, { defaulted: true });
  w2.A.borrow(2, AGENT, 1_000_000, 210); w2.A.close(2, 220);
  w2.chain.postEnc(W1, AGENT, 410, P.encodeFile(statement({ sources: [{ ...w2.A.source(), blocks: [200, null] }], from: 200, to: 400, w: w2.A.window(AGENT, 200, 400) })));
  r = await read(AGENT, { writers: [W1], mode: "full", manifest: { [W1]: { sources: [w2.A.source()] } } });
  assert.match(probs(r), /starts at block 200, after the first block of source .*\(100\)/);
});

// ---- 3. recovery, leaf count ---------------------------------------------------------------------------------------
await t("3. full mode: fabricated recoveries, a false leaf count and a zero root over leaves are rejected", async () => {
  const { chain, A } = world();
  const f = statement({ sources: [A.source()], from: 100, to: 400, w: { leaves: [], opened: zero(), outstanding: zero() } });
  f.credit.closed.recovered = { count: 999, amount: "999999999" };
  f.credit.leaves = 999;
  chain.postBytes(W1, AGENT, 410, canon(f), { file: f });
  const r = await read(AGENT, { writers: [W1], mode: "full" });
  assert.equal(r.writers[0].ok, false, "999 recoveries pass against an empty source");
  assert.match(probs(r), /recovered/);
  assert.match(probs(r), /root/);
});

// ---- 4. assets -----------------------------------------------------------------------------------------------------
await t("4. one asset per writer and agent; totals are kept by asset and printed in the asset's decimals", async () => {
  let { chain, A, D } = world();
  A.borrow(1, AGENT, 1_000_000, 110); A.close(1, 120);
  const e1 = P.encodeFile(statement({ sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) }));
  chain.postEnc(W1, AGENT, 410, e1);
  chain.postEnc(W1, AGENT, 610, P.encodeFile(statement({ sources: [A.source()], seq: 2, prev: e1.feedbackHash, from: 401, to: 600, w: A.window(AGENT, 401, 600), asset: assetOf(T18), decimals: 18 })));
  let r = await read(AGENT, { writers: [W1], mode: "full" });
  assert.match(probs(r), /seq 2: asset .* differs from seq 1/);

  ({ chain, A, D } = world());
  A.borrow(1, AGENT, 1_000_000, 110); A.close(1, 120);
  D.borrow(1, AGENT, 10n ** 18n, 130); D.close(1, 140);
  chain.postEnc(W1, AGENT, 410, P.encodeFile(statement({ sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) })));
  chain.postEnc(W2, AGENT, 420, P.encodeFile(statement({ writer: W2, sources: [D.source()], from: 100, to: 400, w: D.window(AGENT, 100, 400), asset: assetOf(T18), decimals: 18 })));
  const both = pin({ [W1]: [A.source()], [W2]: [D.source()] });
  r = await read(AGENT, { writers: [W1, W2], mode: "full", manifest: both });
  assert.deepEqual(r.writers.map((w) => w.problems), [[], []]);
  assert.ok(r.counted, "totals by asset");
  assert.deepEqual(Object.keys(r.counted).sort(), [assetOf(T18), assetOf(USDG)].sort());
  assert.equal(r.counted[assetOf(USDG)].onTime.amount, "1000000");
  assert.equal(r.counted[assetOf(T18)].onTime.amount, (10n ** 18n).toString());
  assert.equal(r.totals, null, "two assets have no single total");
  const c = await withManifest(both, (f) => cli([String(AGENT), "--writer", W1, "--writer", W2, "--full", "--sources", f]));
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /USDG[^\n]*on time 1 \(1\.0\)/);
  assert.match(c.out, /T18[^\n]*on time 1 \(1\.0\)/);
  assert.doesNotMatch(c.out, /1000000000001/);
});

// ---- 5. funds ------------------------------------------------------------------------------------------------------
await t("5. funds: a malformed or wrong-chain asset fails, the token's decimals must match, a default's payout is checked", async () => {
  const one = (o = {}) => {
    const { chain, A, D } = world();
    const L = o.lender === "D" ? D : A;
    L.borrow(1, AGENT, 1_000_000, 110); L.close(1, 120);
    const f = statement({ sources: [L.source()], from: 100, to: 400, w: L.window(AGENT, 100, 400), ...o.st });
    chain.postBytes(W1, AGENT, 410, canon(f), { file: f });
  };
  one({ st: { asset: "not-a-caip-id" } });
  let r = await read(AGENT, { writers: [W1], mode: "light", funds: true });
  assert.match(probs(r), /asset/, "a malformed asset id disables the funds check");
  one({ st: { asset: assetOf(USDG, 1) } });
  r = await read(AGENT, { writers: [W1], mode: "light", funds: true });
  assert.match(probs(r), /chain/, "an asset on another chain");
  r = await read(AGENT, { writers: [W1], mode: "light", funds: false });
  assert.deepEqual(r.writers[0].problems, []);
  one({ lender: "D", st: { asset: assetOf(T18), decimals: 6 } }); // the token says 18
  r = await read(AGENT, { writers: [W1], mode: "light", funds: true });
  assert.match(probs(r), /decimals/);
  // a default entry whose loan never paid anything out
  const { chain, A } = world();
  A.borrow(1, AGENT, 5_000_000, 110, { paid: 0 });
  const leaf = A.close(1, 300, { defaulted: true });
  chain.postEnc(W1, AGENT, 310, P.encodeFile(P.defaultFile({ chainId: CHAIN, identityRegistry: IDR, writer: W1, agentId: AGENT, asset: assetOf(USDG), decimals: 6, source: A.source(), leaf: { ...leaf, src: 0 }, createdAt: time(310) })));
  r = await read(AGENT, { writers: [W1], mode: "light", funds: true });
  assert.match(probs(r), /default entry 1: loan 1: the lender paid out less than the principal/);
});

// ---- 6. missing data -----------------------------------------------------------------------------------------------
await t("6. fromBlock is required; a requested writer with no statements is no-data, and the command exits 2", async () => {
  const { chain, A } = world();
  A.borrow(1, AGENT, 1_000_000, 110); A.close(1, 120);
  chain.postEnc(W1, AGENT, 410, P.encodeFile(statement({ sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) })));
  const p = provider();
  try {
    await assert.rejects(readCredit(p, AGENT, { writers: [W1] }), /fromBlock/);
    await assert.rejects(findEntries(p, { agentId: AGENT }), /fromBlock/);
  } finally { p.destroy(); }
  const r = await read(AGENT, { writers: [W9] });
  assert.equal(r.writers.length, 1);
  assert.equal(r.writers[0].status, "no-data");
  assert.equal(r.writers[0].ok, false);
  let c = await cli([String(AGENT), "--writer", W9]);
  assert.equal(c.code, 2, c.out);
  assert.match(c.out, /no statements/);
  c = await cli(["99"]); // no credit entry at all
  assert.equal(c.code, 2, c.out);
});

// ---- 7. malformed entries ------------------------------------------------------------------------------------------
await t("7. a malformed entry fails its writer, never the read: the other writers are still read", async () => {
  const { chain, A } = world();
  A.borrow(1, AGENT, 1_000_000, 110); A.close(1, 120);
  const good = statement({ writer: W2, sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) });
  chain.postEnc(W2, AGENT, 410, P.encodeFile(good));
  chain.postBytes(W1, AGENT, 411, canon({ credit: { v: "erc8004-credit/v1" } }));
  const badEvent = structuredClone({ ...good, clientAddress: `eip155:${CHAIN}:${W3}` });
  badEvent.credit.sources[0].events.open = "not an event";
  chain.postBytes(W3, AGENT, 412, canon(badEvent), { file: badEvent });
  const big = structuredClone({ ...good, clientAddress: `eip155:${CHAIN}:${W4}` });
  big.credit.lender.name = "x".repeat(9000);
  chain.postBytes(W4, AGENT, 413, canon(big), { file: big });
  const noArray = structuredClone({ ...good, clientAddress: `eip155:${CHAIN}:${W5}` });
  noArray.credit.anchors = "nope";
  chain.postBytes(W5, AGENT, 414, canon(noArray), { file: noArray });
  const r = await read(AGENT, { mode: "full" });
  assert.equal(byWriter(r, W2).status, "rebuilt");
  for (const w of [W1, W3, W4, W5]) {
    assert.equal(byWriter(r, w).ok, false, w);
    assert.ok(byWriter(r, w).problems.length, w);
  }
  for (const [w, re] of [[W1, /unknown tag1/], [W3, /events\.open is not an event signature/], [W4, /more than 8192 bytes/], [W5, /anchors is not a list/]]) assert.match(byWriter(r, w).problems.join("\n"), re);
});

// ---- 8. ids --------------------------------------------------------------------------------------------------------
await t("8. an agent id past 2^53 is read exactly: the file names it as a decimal string, the command queries it", async () => {
  const BIG = 9007199254740993n;
  const { chain, A } = world();
  A.borrow(1, BIG, 5_000_000, 110); A.close(1, 120);
  A.borrow(2, BIG - 1n, 5_000_000, 130); A.close(2, 140);
  chain.postEnc(W1, BIG, 410, P.encodeFile(statement({ agentId: BIG, sources: [A.source()], from: 100, to: 400, w: A.window(BIG, 100, 400) })));
  chain.postEnc(W1, BIG - 1n, 420, P.encodeFile(statement({ agentId: BIG - 1n, sources: [A.source()], from: 100, to: 400, w: A.window(BIG - 1n, 100, 400) })));
  const p = provider();
  let es;
  try { es = await findEntries(p, { agentId: BIG, fromBlock: 1 }); } finally { p.destroy(); }
  assert.equal(es.length, 1);
  assert.equal(openEntry(es[0]).file.agentId, "9007199254740993");
  const r = await read(BIG, { writers: [W1], mode: "full", manifest: pin({ [W1]: [A.source()] }) });
  assert.equal(r.agentId, "9007199254740993");
  assert.deepEqual(r.writers[0].problems, []);
  assert.equal(r.totals.onTime.count, 1);
  const c = await cli(["9007199254740993", "--writer", W1, "--full"]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /#9007199254740993/);
  assert.match(c.out, /rebuilt/);
});

// ---- 9. canonical bytes --------------------------------------------------------------------------------------------
await t("9. only canonical bytes are read: the exact data URI prefix, strict base64 and UTF-8, no duplicate keys, no whitespace", async () => {
  const { chain, A } = world();
  A.borrow(1, AGENT, 1_000_000, 110); A.close(1, 120);
  const mk = (w) => statement({ writer: w, sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) });
  const text = (w) => canon(mk(w));
  chain.postBytes(W1, AGENT, 410, text(W1), { file: mk(W1), uri: `data:text/plain,${encodeURIComponent(text(W1))}` });
  chain.postBytes(W2, AGENT, 411, text(W2).replace('{"agentId":', '{"agentId":"8","agentId":'), { file: mk(W2) });
  chain.postBytes(W3, AGENT, 412, JSON.stringify(mk(W3), null, 1), { file: mk(W3) });
  const bytes4 = ethers.toUtf8Bytes(text(W4).replace("Test lender", "Test lenderé"));
  const at = bytes4.indexOf(0xc3);
  bytes4[at] = 0xff; // not UTF-8
  chain.postBytes(W4, AGENT, 413, bytes4, { file: mk(W4) });
  let b5;
  for (let i = 0; !b5; i++) { // a file whose base64 is padded, so the padding can be dropped
    const f = mk(W5);
    f.credit.lender.name = `Test lender${".".repeat(i)}`;
    const b = ethers.toUtf8Bytes(canon(f));
    if (ethers.encodeBase64(b).endsWith("=")) b5 = b;
  }
  chain.postBytes(W5, AGENT, 414, b5, { file: mk(W5), uri: P.DATA_URI_PREFIX + ethers.encodeBase64(b5).replace(/=+$/, "") });
  chain.postEnc(W6, AGENT, 415, P.encodeFile(mk(W6)));
  const r = await read(AGENT, { mode: "light" });
  for (const [w, why] of [[W1, "a percent-encoded text/plain URI"], [W2, "duplicate keys"], [W3, "whitespace"], [W4, "invalid UTF-8"], [W5, "unpadded base64"]]) assert.equal(byWriter(r, w).ok, false, `${why} is accepted`);
  for (const [w, re] of [[W1, /feedbackURI is not data:application\/json;base64,/], [W2, /not canonical JSON/], [W3, /not canonical JSON/], [W4, /not UTF-8/], [W5, /base64 is not canonical/]]) assert.match(byWriter(r, w).problems.join("\n"), re);
  assert.equal(byWriter(r, W6).status, "sampled", "the canonical file is read");
});

// ---- located entries: a reader that cannot scan the registry (a Worker behind capped endpoints) -------------------
await t("located entries instead of a registry scan: each read from its receipt; a wrong agent, writer, block or hash, and a missing index, are each reported", async () => {
  const { chain, A } = world();
  A.borrow(1, AGENT, 1_000_000, 110); A.close(1, 120);
  A.borrow(2, AGENT, 2_000_000, 450); A.close(2, 460);
  A.borrow(3, 8n, 1_000_000, 130); A.close(3, 140);
  const e1 = P.encodeFile(statement({ sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) }));
  const p1 = chain.postEnc(W1, AGENT, 410, e1);
  const note = chain.post({ writer: W1, agentId: AGENT, block: 420, uri: "https://example.com/note", hash: ethers.ZeroHash, value: 5n, valueDecimals: 0, tag1: "priors-score", tag2: "" }); // not a credit entry, still an index
  const p2 = chain.postEnc(W1, AGENT, 610, P.encodeFile(statement({ sources: [A.source()], seq: 2, prev: e1.feedbackHash, from: 401, to: 600, w: A.window(AGENT, 401, 600) })));
  const other = chain.postEnc(W1, 8n, 620, P.encodeFile(statement({ agentId: 8n, sources: [A.source()], from: 100, to: 600, w: A.window(8n, 100, 600) })));
  const w2 = chain.postEnc(W2, AGENT, 630, P.encodeFile(statement({ writer: W2, sources: [A.source()], from: 100, to: 600, w: A.window(AGENT, 100, 600) })));
  const at = (p) => ({ txHash: p.txHash, blockNumber: p.blockNumber });
  const good = [at(p1), at(note), at(p2)];
  // the good case reads no registry log at all
  const scans = chain.getLogs;
  let r = await read(AGENT, { writers: [W1], mode: "light", fromBlock: undefined, locate: { [W1]: good } });
  assert.deepEqual(r.writers[0].problems, []);
  assert.equal(r.writers[0].statements, 2);
  assert.equal(chain.getLogs, scans, "a located read scans no log");
  r = await read(AGENT, { writers: [W1], mode: "full", manifest: pin({ [W1]: [A.source()] }), locate: async (agentId, writer) => { assert.equal(agentId, "7"); assert.equal(writer, W1); return good; } });
  assert.equal(r.writers[0].status, "rebuilt");
  assert.equal(r.totals.onTime.count, 2);
  const p = provider();
  try {
    assert.equal((await findEntries(p, { agentId: AGENT, located: { [W1]: good } })).length, 2);
    await assert.rejects(findEntries(p, { agentId: AGENT, located: { [W1]: [at(p1), at(p2)] } }), /entry 2 of 3/);
  } finally { p.destroy(); }
  const cases = [
    [[...good, at(other)], /names agent 8, not 7/],
    [[...good, at(w2)], new RegExp(`is from writer ${W2}, not ${W1}`)],
    [[at(p1), at(note), { ...at(p2), blockNumber: 611 }], /in block 610, not 611/],
    [[at(p1), at(p2)], /entry 2 of 3 \(getLastIndex\): an entry the index did not give/],
  ];
  for (const [list, re] of cases) {
    r = await read(AGENT, { writers: [W1], mode: "light", locate: { [W1]: list } });
    assert.equal(r.writers[0].ok, false, String(re));
    assert.match(probs(r), re);
  }
  // an entry whose feedbackHash is not its file's, located like any other
  const bad = chain.post({ writer: W1, agentId: AGENT, block: 640, uri: e1.feedbackURI, hash: ethers.id("not the file"), value: BigInt(e1.file.value), valueDecimals: 6, tag1: P.TAG_STATEMENT, tag2: e1.file.tag2 });
  r = await read(AGENT, { writers: [W1], mode: "light", locate: { [W1]: [...good, at(bad)] } });
  assert.match(probs(r), /entry 4: feedbackHash is not keccak256 of the file/);
});

await t("a node's error that names its URL (a paid node's URL carries its key) never reaches a reported problem", async () => {
  const SECRET = "https://node.example/key-0123456789abcdef";
  const p = new ethers.JsonRpcProvider("http://127.0.0.1:9", 4663, { staticNetwork: true, batchMaxCount: 1 });
  p.send = async () => { throw new Error(`request to ${SECRET} failed, reason: connect ECONNREFUSED`); }; // not an ethers error: no shortMessage
  const W = "0x03af41aEb1EEa4DA0572bbb6AB1B4c5331F17aC7";
  const r = await readCredit(p, 7, { writers: [W], locate: { [W]: [{ txHash: "0x" + "a".repeat(64) }] }, history: p, funds: false });
  const text = JSON.stringify(r);
  assert.ok(r.writers[0].problems.length > 0, "the failure is reported");
  for (const s of ["node.example", "key-0123", "https://"]) assert.ok(!text.includes(s), `the result names ${s}: ${text.slice(0, 300)}`);
});

// ---- 10. where a chain ends: a writer that stops posting (GHSA-m5xx) -----------------------------------------------
/** One honest statement over blocks 100-400; then loan 2, opened at 450 and defaulted at 500, which the writer never
 *  posts (with `entry`: posts as a default entry only); the chain is read at block `readAt` (10,000: 5.3 hours after
 *  the default, inside the 24 hours the profile gives a writer to post its default entry; 60,000: 33 hours after). */
function stopped({ entry = false, readAt = 10_000 } = {}) {
  const { chain, A } = world();
  A.borrow(1, AGENT, 1_000_000, 110); A.close(1, 200);
  chain.postEnc(W1, AGENT, 410, P.encodeFile(statement({ sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) })));
  A.borrow(2, AGENT, 5_000_000, 450);
  const leaf = A.close(2, 500, { defaulted: true });
  if (entry) chain.postEnc(W1, AGENT, 510, P.encodeFile(P.defaultFile({ chainId: CHAIN, identityRegistry: IDR, writer: W1, agentId: AGENT, asset: assetOf(USDG), decimals: 6, source: A.source(), leaf: { ...leaf, src: 0 }, createdAt: time(510) })));
  chain.mine(readAt);
  return { chain, A };
}

await t("10. a writer that stops posting cannot hide a later default: a full read scans past the last statement and fails a default no entry reports after 24 hours", async () => {
  stopped({ readAt: 60_000 });
  let r = await read(AGENT, { writers: [W1], mode: "full" });
  let w = r.writers[0];
  assert.equal(w.status, "failed", `a default at block 500, after the last statement (to 400), reads as ${w.status} (ok ${w.ok}, problems ${JSON.stringify(w.problems)}, counted ${JSON.stringify(r.counted)})`);
  assert.match(probs(r), new RegExp(`loan 2 at source ${POOL(1)} defaulted in block 500, after the last statement \\(to block 400\\), and no default entry of this writer reports it, 33\\.1 hours before the block read at`));
  assert.deepEqual(r.asOf, { block: 60000, time: time(60000) });
  assert.deepEqual(w.after, { fromBlock: 401, toBlock: 60000, since: time(400), closed: { onTime: zero(), late: zero(), defaulted: { count: 1, amount: "5000000" }, recovered: zero() }, opened: { count: 1, amount: "5000000" }, awaiting: [] });
  assert.deepEqual(r.counted, {}, "a failed writer is not counted");
  const c = await cli([String(AGENT), "--writer", W1, "--full"]);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /statements end at block 400 \(2023-11-14T22:26:40Z\); read at block 60000 \(2023-11-16T07:33:20Z\), 33\.1 hours later/);
  assert.match(c.out, /after them, blocks 401-60000, in no statement and not counted: on time 0 \(0\.0\), late 0 \(0\.0\), defaulted 1 \(5\.0\); opened 1 \(5\.0\)/);
  // as of block 450, before the default: loan 2 is open, nothing after the statement has closed
  r = await read(AGENT, { writers: [W1], mode: "full", toBlock: 450 });
  w = r.writers[0];
  assert.deepEqual([w.status, w.after.toBlock, w.after.closed.defaulted.count, w.after.opened.count], ["rebuilt", 450, 0, 1]);
});

await t("10. a default after the last statement, inside the 24 hours the profile gives the writer, is shown as awaiting its entry, not a failure", async () => {
  stopped(); // read 5.3 hours after the default
  const r = await read(AGENT, { writers: [W1], mode: "full" });
  const w = r.writers[0];
  assert.deepEqual([w.status, w.problems], ["rebuilt", []], JSON.stringify(w.problems));
  assert.deepEqual(w.after.awaiting, [{ source: POOL(1), loan: "2", block: 500, closedAt: time(500) }]);
  const c = await cli([String(AGENT), "--writer", W1, "--full"]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, new RegExp(`loan 2 at source ${POOL(1)} defaulted in block 500, 5\\.3 hours before the block read at: no default entry yet \\(the profile gives the writer 24 hours\\)`));
});

await t("10. a default the writer did post as a default entry after its last statement is shown after the statements, not counted, not a failure", async () => {
  stopped({ entry: true });
  const r = await read(AGENT, { writers: [W1], mode: "full" });
  const w = r.writers[0];
  assert.deepEqual(w.problems, []);
  assert.deepEqual([w.status, w.defaults, w.after.closed.defaulted.count], ["rebuilt", 1, 1]);
  assert.equal(r.totals.defaulted.count, 0, "counted: the statements' figures only");
  const c = await cli([String(AGENT), "--writer", W1, "--full"]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /after them, blocks 401-10000, in no statement and not counted: [^\n]*defaulted 1 \(5\.0\)/);
});

await t("10. light mode does not read past the last statement, and says where the statements end", async () => {
  stopped();
  const r = await read(AGENT, { writers: [W1], mode: "light" });
  const w = r.writers[0];
  assert.equal(w.status, "sampled");
  assert.deepEqual(w.after, { fromBlock: 401, toBlock: 10000, since: time(400), closed: null, opened: null });
  const c = await cli([String(AGENT), "--writer", W1]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /statements end at block 400 \(2023-11-14T22:26:40Z\); read at block 10000 \(2023-11-15T03:46:40Z\), 5\.3 hours later/);
  assert.match(c.out, /after them, blocks 401-10000: in no statement, and not read in light mode/);
});

// ---- 11. a read's budget: entries anyone can plant (GHSA-rc33) ------------------------------------------------------
await t("11. a read's RPC requests are bounded, all writers together: statements planted by many writers cost a reader at most its budget", async () => {
  const { chain, A, B } = world();
  A.borrow(1, AGENT, 1_000_000, 110); A.close(1, 120);
  const honest = chain.postEnc(W1, AGENT, 410, P.encodeFile(statement({ sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) })));
  // 5 writers x 20 statements, each with 16 anchors citing transactions that do not exist: each anchor costs a receipt
  for (let k = 0; k < 5; k++) for (let n = 0; n < 20; n++) {
    const wr = W(0x100 + k);
    const leaves = Array.from({ length: P.MAX_ANCHORS }, (_, i) => ({ cls: "unsecured", loan: String(1000 + 100 * n + i), amount: "1000000", dueAt: time(300), closedAt: time(150 + i), outcome: P.ON_TIME, block: 150 + i, tx: ethers.id(`spam ${k} ${n} ${i}`), log: 0, openBlock: 120, openTx: ethers.id(`spam open ${k} ${n} ${i}`), openLog: 0, src: 0 }));
    const f = P.statementFile({ chainId: CHAIN, identityRegistry: IDR, writer: wr, agentId: AGENT, asset: assetOf(USDG), decimals: 6, sources: [B.source()], seq: 1, prev: null, window: { fromBlock: 100, toBlock: 400, toTime: time(400) }, leaves, opened: { count: leaves.length, amount: String(leaves.length * 1_000_000) }, outstanding: zero(), createdAt: time(400) + 10, anchors: P.MAX_ANCHORS });
    const enc = P.encodeFile(f, { max: P.FILE_LIMIT });
    assert.equal(enc.file.credit.anchors.length, P.MAX_ANCHORS);
    chain.postEnc(wr, AGENT, 500 + n, enc);
  }
  const count = async (o) => { server.requests = 0; const r = await read(AGENT, o); return { r, n: server.requests }; };
  // a reader that names the writers it trusts never reads the others' entries, scanning or located (credit_history)
  let { r, n } = await count({ writers: [W1], mode: "light" });
  assert.equal(byWriter(r, W1).status, "sampled");
  assert.ok(n <= 15, `${n} requests`);
  ({ r, n } = await count({ writers: [W1], mode: "light", fromBlock: undefined, locate: { [W1]: [{ txHash: honest.txHash, blockNumber: honest.blockNumber }] } }));
  assert.ok(n <= 15, `${n} requests`);
  // a reader that reads every writer spends at most its budget, whatever was planted
  ({ r, n } = await count({ mode: "light", maxRequests: 300 }));
  assert.ok(n <= 300, `${n} requests for one read, over its budget of 300`);
  assert.equal(byWriter(r, W1).status, "sampled", "the writer read before the budget ran out");
  const spent = r.writers.filter((w) => /budget of 300 RPC requests for one read is spent/.test(w.problems.join("\n")));
  assert.equal(spent.length, 5, JSON.stringify(r.writers.map((w) => [w.writer, w.status, w.problems.slice(0, 2)])));
  for (const w of spent) assert.deepEqual([w.status, w.ok], ["failed", false]);
  // the default budget is LIMITS.requests
  const was = LIMITS.requests;
  assert.ok(Number.isSafeInteger(was) && was >= 10_000, `LIMITS.requests is ${was}`);
  LIMITS.requests = 300;
  try { ({ n } = await count({ mode: "light" })); assert.ok(n <= 300, `${n} requests under a default budget of 300`); } finally { LIMITS.requests = was; }
});

// ---- 12. a source the writer adds: its own contract (GHSA-fgg6) ---------------------------------------------------
/** A writer key (the lender's, or a leaked one) that adds a contract of its own as a source. Seq 1 is honest over the
 *  pool A (one $5 loan); seq 2 declares [A, X], X the key holder's contract, first block 401 (at its window's start,
 *  as a new source must be): one more real loan at A ($7), three $100 loans at X with no money behind them, and five
 *  $1 anchors at X whose USDG moves out and back. Agent 42 gets the same from nothing: one seq 1 declaring only X. */
function ownSource() {
  const { chain, A } = world();
  const X = new Lender(chain, POOL(9), USDG, 401);
  A.borrow(1, AGENT, 5_000_000, 110); A.close(1, 120);
  const e1 = P.encodeFile(statement({ sources: [A.source()], from: 100, to: 400, w: A.window(AGENT, 100, 400) }));
  chain.postEnc(W1, AGENT, 410, e1);
  A.borrow(2, AGENT, 7_000_000, 430); A.close(2, 440);
  for (let i = 0; i < 3; i++) { X.borrow(1001 + i, AGENT, 100_000_000, 450 + 20 * i, { dueIn: 1000, paid: 0 }); X.close(1001 + i, 460 + 20 * i, { quiet: true }); }
  for (let i = 0; i < 5; i++) { X.borrow(2001 + i, AGENT, 1_000_000, 570 + i, { dueIn: 1000 }); X.close(2001 + i, 590 + i); }
  chain.postEnc(W1, AGENT, 610, P.encodeFile(statement({ sources: [A.source(), X.source()], seq: 2, prev: e1.feedbackHash, from: 401, to: 600, w: merge(A.window(AGENT, 401, 600, 0), X.window(AGENT, 401, 600, 1)) })));
  const Y = new Lender(chain, POOL(8), USDG, 100);
  for (let i = 0; i < 3; i++) { Y.borrow(3001 + i, 42n, 250_000_000, 110 + 20 * i, { dueIn: 1000, paid: 0 }); Y.close(3001 + i, 120 + 20 * i, { quiet: true }); }
  for (let i = 0; i < 5; i++) { Y.borrow(4001 + i, 42n, 1_000_000, 570 + i, { dueIn: 1000 }); Y.close(4001 + i, 590 + i); }
  chain.postEnc(W1, 42n, 620, P.encodeFile(statement({ agentId: 42n, sources: [Y.source()], from: 100, to: 600, w: Y.window(42n, 100, 600) })));
  return { chain, A, X, Y };
}

await t("12. a source the writer adds rebuilds exactly, so a rebuild against the writer's own sources is not counted; the reader's manifest fails it (GHSA-fgg6)", async () => {
  const { A, X } = ownSource();
  let r = await read(AGENT, { writers: [W1], mode: "full" });
  let w = r.writers[0];
  assert.deepEqual([w.status, w.problems, w.claimed.onTime.count, w.claimed.onTime.amount], ["rebuilt", [], 10, "317000000"], "the statements match the logs of the sources they declare");
  assert.deepEqual(r.counted, {}, `a rebuild against the sources the writer itself declares is counted as checked: ${JSON.stringify(r.counted)}`);
  assert.equal(r.totals.onTime.count, 0);
  assert.equal(w.manifest, false, "no manifest names the writer: its sources are the ones it declares");
  // an agent with no history anywhere: one statement over the key holder's contract only
  r = await read(42n, { writers: [W1], mode: "full" });
  assert.deepEqual([r.writers[0].status, r.writers[0].claimed.onTime.amount, r.counted], ["rebuilt", "755000000", {}]);
  // the reader's manifest pins the writer's real source: the added one fails the writer, in both modes
  const real = pin({ [W1]: [A.source()] });
  for (const mode of ["full", "light"]) {
    r = await read(AGENT, { writers: [W1], mode, manifest: real });
    assert.equal(r.writers[0].status, "failed", mode);
    assert.match(probs(r), new RegExp(`seq 2: source ${X.contract} is not in the reader's manifest`, "i"));
    assert.deepEqual([r.writers[0].manifest, r.counted], [true, {}]);
  }
  r = await read(42n, { writers: [W1], mode: "full", manifest: real });
  assert.equal(r.writers[0].status, "failed");
  // the command: without --sources the rebuild says whose sources it used and counts nothing (every check that ran
  // passed: exit 0); with --sources it fails (exit 1)
  let c = await cli([String(AGENT), "--writer", W1, "--full"]);
  assert.equal(c.code, 0, c.out);
  assert.doesNotMatch(c.out, /\ncounted \(/, `a rebuild against the writer's own sources is printed as counted:\n${c.out}`);
  assert.match(c.out, /rebuilt from the sources it declares[^\n]*not counted[^\n]*: on time 10 \(317\.0\)/);
  assert.match(c.out, /counted: nothing \([^\n]*--sources/);
  c = await withManifest(real, (f) => cli([String(AGENT), "--writer", W1, "--full", "--sources", f]));
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /is not in the reader's manifest/);
  // the honest chain: with the manifest, rebuilt and counted
  const h = world();
  h.A.borrow(1, AGENT, 5_000_000, 110); h.A.close(1, 120);
  const e1 = P.encodeFile(statement({ sources: [h.A.source()], from: 100, to: 400, w: h.A.window(AGENT, 100, 400) }));
  h.chain.postEnc(W1, AGENT, 410, e1);
  h.A.borrow(2, AGENT, 7_000_000, 430); h.A.close(2, 440);
  h.chain.postEnc(W1, AGENT, 610, P.encodeFile(statement({ sources: [h.A.source()], seq: 2, prev: e1.feedbackHash, from: 401, to: 600, w: h.A.window(AGENT, 401, 600) })));
  r = await read(AGENT, { writers: [W1], mode: "full", manifest: pin({ [W1]: [h.A.source()] }) });
  assert.deepEqual([r.writers[0].status, r.writers[0].manifest, r.totals.onTime.count, r.totals.onTime.amount], ["rebuilt", true, 2, "12000000"]);
  c = await withManifest(pin({ [W1]: [h.A.source()] }), (f) => cli([String(AGENT), "--writer", W1, "--full", "--sources", f]));
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /\ncounted \([^\n]*manifest[^\n]*\n[^\n]*on time 2 \(12\.0\)/);
});

await t("12. a manifest that does not name a trusted writer fails that writer, never reads as no manifest; each writer says whether the manifest pinned its sources (GHSA-fgg6)", async () => {
  const { A } = ownSource();
  const other = pin({ [W2]: [A.source()] }); // Priors' pools filed under another writer, say
  let r = await read(AGENT, { writers: [W1], mode: "full", manifest: other });
  let w = r.writers[0];
  assert.equal(w.status, "failed", `a manifest that does not name ${W1} reads as no manifest: ${w.status} (problems ${JSON.stringify(w.problems)}, counted ${JSON.stringify(r.counted)})`);
  assert.match(probs(r), new RegExp(`the reader's manifest does not name writer ${W1}`));
  assert.deepEqual([w.manifest, r.manifest, r.counted], [false, true, {}]);
  r = await read(AGENT, { writers: [W1], mode: "light", manifest: other }); // the hosted credit_history's mode
  assert.equal(r.writers[0].status, "failed");
  r = await read(AGENT, { writers: [W9], mode: "full", manifest: other }); // a trusted writer with no entries
  assert.deepEqual([r.writers[0].status, r.writers[0].manifest], ["failed", false]);
  assert.match(probs(r), new RegExp(`the reader's manifest does not name writer ${W9}`));
  let c = await withManifest(other, (f) => cli([String(AGENT), "--writer", W1, "--full", "--sources", f]));
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /does not name writer/);
  c = await withManifest(other, (f) => cli([String(AGENT), "--writer", W1, "--full", "--sources", f, "--json"]));
  const j = JSON.parse(c.out);
  assert.deepEqual([c.code, j.writers[0].status, j.writers[0].manifest, j.counted], [1, "failed", false, {}]);
  // two honest writers, the manifest names one: read untrusted, each says whether its sources were pinned; trusted,
  // the one it does not name fails and the other is counted
  const { chain, A: A2 } = world();
  A2.borrow(1, AGENT, 5_000_000, 110); A2.close(1, 120);
  for (const wr of [W1, W2]) chain.postEnc(wr, AGENT, 410, P.encodeFile(statement({ writer: wr, sources: [A2.source()], from: 100, to: 400, w: A2.window(AGENT, 100, 400) })));
  const one = pin({ [W1]: [A2.source()] });
  r = await read(AGENT, { mode: "full", manifest: one });
  assert.deepEqual([W1, W2].map((x) => [byWriter(r, x).status, byWriter(r, x).manifest]), [["rebuilt", true], ["rebuilt", false]]);
  assert.deepEqual(r.counted, {}, "no writer is trusted");
  r = await read(AGENT, { writers: [W1, W2], mode: "full", manifest: one });
  assert.deepEqual([byWriter(r, W1).status, byWriter(r, W2).status, r.totals.writers, r.totals.onTime.count], ["rebuilt", "failed", 1, 1]);
});

// ---- 13. what ties a writer's asset and its default entries to the reader's sources (GHSA-6rpg) ---------------------
await t("13. the asset is tied to what the sources moved: statements that close loans with no anchor and no default entry fail a read that checks funds (GHSA-6rpg)", async () => {
  const FAKE0 = ethers.getAddress("0x0000000000000000000000000000000000000DEC"); // decimals() 0, symbol() "USDG"
  const run = ({ asset = assetOf(USDG), decimals = 6, anchors = true, to = 150, close = true } = {}) => {
    const { chain, A } = world();
    chain.token(FAKE0, 0, "USDG");
    A.borrow(1, AGENT, 5_000_000, 110); // 5 USDG out of the pool
    if (close) A.close(1, 120); // and back, on time
    const f = statement({ sources: [A.source()], from: 100, to, w: A.window(AGENT, 100, to), asset, decimals });
    if (!anchors) f.credit.anchors = [];
    chain.postEnc(W1, AGENT, to + 1, P.encodeFile(f));
    return pin({ [W1]: [A.source()] });
  };
  // the report's statement: the pool's 5,000,000 base units stated in a 0-decimal token named USDG, with no anchor
  let man = run({ asset: assetOf(FAKE0), decimals: 0, anchors: false });
  let r = await read(AGENT, { writers: [W1], mode: "full", funds: true, manifest: man });
  assert.equal(r.writers[0].status, "failed", `5 USDG counted as ${JSON.stringify(r.totals?.onTime)} at ${r.totals?.decimals} decimals (problems ${JSON.stringify(r.writers[0].problems)})`);
  assert.match(probs(r), /no anchor, and there is no default entry/);
  assert.deepEqual(r.counted, {});
  r = await read(AGENT, { writers: [W1], mode: "light", funds: true, manifest: man }); // the hosted credit_history's mode
  assert.equal(r.writers[0].status, "failed");
  let c = await withManifest(man, (f) => cli([String(AGENT), "--writer", W1, "--full", "--sources", f]));
  assert.equal(c.code, 1, c.out);
  // with its anchor, the same file already failed: the anchor's funds check is what ties the asset
  man = run({ asset: assetOf(FAKE0), decimals: 0 });
  r = await read(AGENT, { writers: [W1], mode: "full", funds: true, manifest: man });
  assert.match(probs(r), /the lender paid out less than the principal/);
  // the real token with no anchor: nothing ties it either, so it fails the same way; without --no-funds nothing is said
  man = run({ anchors: false });
  r = await read(AGENT, { writers: [W1], mode: "full", funds: true, manifest: man });
  assert.match(probs(r), /no anchor, and there is no default entry/);
  r = await read(AGENT, { writers: [W1], mode: "full", funds: false, manifest: man });
  assert.deepEqual([r.writers[0].status, r.writers[0].problems], ["rebuilt", []]);
  // unchanged: an honest statement with its anchor, and one that closes no loan (nothing to anchor, nothing closed)
  man = run();
  r = await read(AGENT, { writers: [W1], mode: "full", funds: true, manifest: man });
  assert.deepEqual([r.writers[0].status, r.totals.onTime.amount, r.totals.decimals], ["rebuilt", "5000000", 6]);
  man = run({ close: false });
  r = await read(AGENT, { writers: [W1], mode: "full", funds: true, manifest: man });
  assert.deepEqual([r.writers[0].status, r.writers[0].problems, r.writers[0].claimed.outstanding.count], ["rebuilt", [], 1]);
});

await t("13. a default entry's source is held to the reader's manifest, events and fields too: it cannot cite a repayment's log or read another parameter as its amount (GHSA-6rpg)", async () => {
  // (a) the report's default entry: repaid and defaulted swapped in its source, citing loan 2's Repaid log
  let { chain, A } = world();
  chain.postEnc(W1, AGENT, 151, P.encodeFile(statement({ sources: [A.source()], from: 100, to: 150, w: A.window(AGENT, 100, 150) })));
  A.borrow(2, AGENT, 5_000_000, 160);
  const repaid = A.close(2, 170); // repaid on time
  const swapped = { ...A.source(), events: { ...EV, repaid: EV.defaulted, defaulted: EV.repaid } };
  const def = (source, leaf, at) => chain.postEnc(W1, AGENT, at, P.encodeFile(P.defaultFile({ chainId: CHAIN, identityRegistry: IDR, writer: W1, agentId: AGENT, asset: assetOf(USDG), decimals: 6, source, leaf: { ...leaf, src: 0 }, createdAt: time(at) })));
  def(swapped, { ...repaid, outcome: P.DEFAULTED }, 171);
  let man = pin({ [W1]: [A.source()] });
  for (const mode of ["full", "light"]) {
    const r = await read(AGENT, { writers: [W1], mode, manifest: man });
    assert.equal(r.writers[0].status, "failed", `${mode}: a repaid loan read as a default (${r.writers[0].defaults} default entries, problems ${JSON.stringify(r.writers[0].problems)})`);
    assert.match(probs(r), /default entry 2: source 0x[0-9a-fA-F]{40}'s events or fields are not the reader's manifest's/);
  }
  // (b) a real 500 USDG default reported at its fourth parameter (sharesBurnt, 0.01): the same types, two names swapped
  ({ chain } = world());
  const EV2 = { open: "Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, uint64 dueAt)", repaid: "Repaid(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee)", defaulted: "Defaulted(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 sharesBurnt)" };
  const LI2 = new ethers.Interface(Object.values(EV2).map((s) => `event ${s}`));
  const src2 = { chainId: CHAIN, contract: POOL(5), blocks: [100, null], events: EV2, fields: { amount: "principal", dueAt: "dueAt" } };
  chain.postEnc(W1, AGENT, 151, P.encodeFile(statement({ sources: [src2], from: 100, to: 150, w: { leaves: [], opened: zero(), outstanding: zero() } })));
  const dueAt = time(160) + 100;
  const o = chain.tx(160, [{ address: USDG, ...ERC20.encodeEventLog("Transfer", [POOL(5), WALLET, 500_000_000]) }, { address: POOL(5), ...LI2.encodeEventLog("Borrowed", [9, AGENT, 500_000_000, 0, dueAt]) }]);
  const d = chain.tx(170, [{ address: POOL(5), ...LI2.encodeEventLog("Defaulted", [9, AGENT, 500_000_000, 10_000]) }]);
  const leaf = { cls: "unsecured", loan: "9", amount: "10000", dueAt, closedAt: time(170), outcome: P.DEFAULTED, block: 170, tx: d.hash, log: d.logs[0].index, openBlock: 160, openTx: o.hash, openLog: o.logs[1].index };
  const renamed = { ...src2, events: { ...EV2, defaulted: "Defaulted(uint256 indexed loanId, uint256 indexed agentId, uint256 sharesBurnt, uint256 principal)" } };
  def(renamed, leaf, 171);
  chain.mine(170 + 43_300); // the default is more than 24 hours old: unreported, it would fail the writer
  man = pin({ [W1]: [src2] });
  let r = await read(AGENT, { writers: [W1], mode: "full", manifest: man });
  assert.equal(r.writers[0].status, "failed", `a 500 USDG default passed as 0.01 (problems ${JSON.stringify(r.writers[0].problems)})`);
  assert.match(probs(r), /default entry 2: source .*'s events or fields are not the reader's manifest's/);
  // the same entry with the manifest's own events was always caught: its amount is not the principal on chain
  ({ chain } = world());
  chain.postEnc(W1, AGENT, 151, P.encodeFile(statement({ sources: [src2], from: 100, to: 150, w: { leaves: [], opened: zero(), outstanding: zero() } })));
  chain.tx(160, [{ address: USDG, ...ERC20.encodeEventLog("Transfer", [POOL(5), WALLET, 500_000_000]) }, { address: POOL(5), ...LI2.encodeEventLog("Borrowed", [9, AGENT, 500_000_000, 0, dueAt]) }]);
  chain.tx(170, [{ address: POOL(5), ...LI2.encodeEventLog("Defaulted", [9, AGENT, 500_000_000, 10_000]) }]);
  def(src2, leaf, 171);
  chain.mine(170 + 43_300);
  r = await read(AGENT, { writers: [W1], mode: "full", manifest: man });
  assert.match(probs(r), /loan 9: amount 500000000 on chain, 10000 in the file/);
});

srv.close();
console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed:\n  ${failed.join("\n  ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
