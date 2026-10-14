// A write whose answer is lost, in the v2 SDK and its CLI, network-free (GHSA-g5cv-cpwp-756w). P-18's rule (GHSA-v9xj),
// which @priors/x402, @priors/mcp and sdk/float.mjs follow, for every write the SDK sends (sendChecked):
//   - before anything is accepted (the simulation or the build of the transaction, the wallet declining to sign, the
//     node refusing it: INSUFFICIENT_FUNDS, ACTION_REJECTED), the error is an ordinary one: nothing was sent, and trying
//     again is safe; to bytes signed here (sent as exactly one request to one endpoint, never retried), any answer is
//     reconciled with the transaction's own hash first, so "nonce too low", "replacement transaction underpriced",
//     "already known", or even "insufficient funds" after it was taken, is never a refusal on its own;
//   - once it may have been accepted, a lost answer (the broadcast's or the receipt's) throws TX_UNCONFIRMED, and so
//     does any failure after a status-1 receipt (a missing event, a failed read) with `mined: true`; a borrow says
//     BORROW_UNCONFIRMED with the amount as `borrowed`; the tx `hash` whenever it is known (a key that signs locally
//     knows it before the broadcast);
//   - a revert mined with status 0 is a CALL_EXCEPTION (nothing was done); a transaction replaced by a repriced copy of
//     itself is its replacement's result; one cancelled or replaced by another call is TRANSACTION_REPLACED with
//     `cancelled: true` (it did not run).
// A transaction whose answer was lost may still be pending, so the open loans alone settle nothing: the errors carry
// the `nonce` it was signed with, the block before it was sent and its signed bytes (`raw`), and
// PriorsV2.txStatus(hash, { nonce, sentBlock, raw, seen, explorer }) says whether it is final and whether it ran: a
// verdict only on its receipt, on the receipt of a copy of the same call at its nonce (a speed-up: it ran), or on a
// DIFFERENT call positively found at this sender and nonce (in the block where the nonce count passes it), and final
// only once that block is finalized and canonical; a hash this node does not know, a mined one whose receipt lags, or
// anything the node cannot serve, stays not final. An earlier observation (`seen`) is re-read from its block; an
// explorer's pointer counts only once the RPC confirms it. The CLI records every write it signs in a file of its own
// (0600, in a 0700 directory, opened without following links) before the broadcast, removes it on a conclusive
// answer, holds a lock per key (a dead holder's is recovered), and exits 4 on TX_UNCONFIRMED / BORROW_UNCONFIRMED;
// `tx` (no argument: a 64-hex argument is always refused as a key) lists and settles the records, removes each once
// final, `tx --resend` sends the same signed bytes again, and `tx --forget` drops one only once its nonce is used in
// finalized history; `borrow` and `join` refuse while one is unresolved (`repay` runs, with a note: it cannot pay
// twice). A write that went through exits 0 even if the status shown after it cannot be read.
//
// A local JSON-RPC stub plays the pool, the registry, USDG, the stock vault and a stock token, opens a loan for every
// borrow it is sent, and can drop the connection or answer with a node's refusal at each step.
//
//   node scripts/test-sdk-v2-borrow-lost.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { WebSocketServer } from "ws";
import { PriorsV2, POOL_V2_ABI } from "../sdk/priors-v2.mjs";
import { STOCK_VAULT_ABI } from "../sdk/stock-vault.mjs";

let passed = 0, failed = 0;
/** Each case has 20 s: a wait that never settles is a failure, not a process that quietly exits. */
async function check(name, fn) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, no) => { timer = setTimeout(() => no(new Error("no answer in 20 s (a wait that never settles)")), 20_000); })]);
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n       ")}`);
  } finally {
    clearTimeout(timer);
  }
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REC = JSON.parse(readFileSync(join(ROOT, "deployments/4663.v2.json"), "utf8"));
const { seatVaultV5: _v5, seatVaultV5AgentId: _v5id, ...ADDRESSES } = REC; // no V5 step: the borrow alone
const POOL = REC.pool, REG = REC.registry, USDG = REC.usdg, VAULT = REC.stockVault;
const TOKEN = ethers.getAddress("0x" + "70".repeat(20)); // a stand-in stock token
// the CLI of this tree: `priors-v2` in the public repo, `priors` here
const CLI = existsSync(join(ROOT, "bin/priors-v2.mjs")) ? "priors-v2" : "priors";
const AGENT = 77n, SPONSOR = 6228n, BLOCK = 80_000_000, FEE = 11_666n;
const nowS = () => Math.floor(Date.now() / 1000);

const owner = ethers.Wallet.createRandom();
const poolI = new ethers.Interface(POOL_V2_ABI);
const vaultI = new ethers.Interface(STOCK_VAULT_ABI);
const regI = new ethers.Interface(["function ownerOf(uint256) view returns (address)", "function balanceOf(address) view returns (uint256)", "function register(string) returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
const erc20I = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const PARAMS = [5_000000n, 500_000000n, 86_400n, 30n * 86_400n, 3n * 86_400n, 7n * 86_400n, 100n, 2500n, 2500n, 10_000000n, 10_000n, 0n];

/**
 * The chain: an agent with a `line` of room on the pool, and what happens to the writes it is sent.
 *   lose: "broadcast" | "receipt"  the connection drops on the borrow's broadcast answer, or on every receipt read for it
 *   loseRegister                    the same for a register's broadcast answer
 *   loseNonceRead                   the connection drops on the nonce read, before anything is signed or sent
 *   refuseSend: "<message>"         the node refuses the borrow's broadcast with that JSON-RPC error
 *   minedRevert                     the borrow simulates fine and mines with status 0
 *   noEvent / registerNoLog         the borrow (register) mines with status 1 and no Borrowed (Transfer) log
 *   failReadsAfterWrite             once a write was accepted, every eth_call drops the connection
 *   replace: "repriced" | "cancelled"  the borrow is accepted, then a transaction with its nonce mines in its place:
 *                                   the same call at a higher fee, or a 0-value transfer to the sender
 *   known: { [hash]: { nonce, block, status } }  transactions the node knows by hash (block null: pending)
 *   counts: { latest, pending }     the key's transaction counts, whatever was sent
 *   noIdentity                      the key holds no identity yet (join registers one)
 *   loseBeforeNode                  the borrow's first broadcast never reaches the node (dropped, not executed)
 *   appear: { hash, nonce, after }  a transaction this node does not know for its first `after` hash reads, then
 *                                   pending (it reached the node late, or sat in another node's mempool)
 *   nonceUsed: { nonce, at, by, servableFrom, blockUnservable }  the key's nonce `nonce` was used in block `at` by
 *                                   transaction `by`: the count is nonce before `at`, nonce + 1 from it; history older
 *                                   than `servableFrom` is refused (a node's state window); block `at` may be refused
 *   known[hash].receiptAfter: R     its receipt is not readable for the first R reads (a lagging RPC)
 *   known[hash]: { to, input, value, blockHash }  its fields (default: to the pool, no data, 0) and the block hash its
 *                                   receipt and transaction name (default: the canonical one; another one: a fork flip)
 *   nonceUsed.like: raw             the transaction at the nonce has the same to/data/value as `raw` (a fee-bumped copy)
 *   finalized                       the finalized block's number (default: the latest; `setFinalized` moves it)
 *   stateWindow: w                  the node serves account state only for the last w blocks before its head (the
 *                                   public node's ~5 minutes); `advance(n)` moves the head
 *   hold: "before-apply" | "after-apply"  the first borrow broadcast is held, unanswered, before or after the node took
 *                                   it (`broadcastSeen` resolves when it arrives; `releaseHeld` answers or drops it)
 *   holdCall: "<method>"            the first request with that method is answered only on `releaseHeld` (`callSeen`
 *                                   resolves when it arrives): a pause at a known point, before anything is signed
 *   holdRefuse: "<message>"         the first borrow broadcast is held, NOT taken, and answered on `releaseHeld` with that
 *                                   JSON-RPC error (`broadcastSeen` resolves when it arrives)
 *   takeThenRefuse: "<message>"     the node takes and mines the borrow it is sent, then answers with that error (a
 *                                   retried request whose first try went through; another command's copy that landed)
 *   sentReceiptAfter: R             the receipt of a transaction it was sent is not readable for the first R reads
 *   sentKnown                       it serves a transaction it was sent by hash (mined in the latest block)
 *   rateLimitSend: N                the first N requests carrying eth_sendRawTransaction get HTTP 429, untaken
 *   redirectSend: { to, take }      requests carrying eth_sendRawTransaction get a 307 to `to` (taken first, with take)
 *   refuseFirstSend: "<message>"    only the first borrow broadcast is refused with that JSON-RPC error
 *   ws                              it also answers JSON-RPC over a WebSocket (`wsUrl`)
 *   holdSendAt: n                   the n-th borrow broadcast is taken, and its answer held until `releaseHeld`
 *                                   (`broadcastSeen` resolves when it arrives)
 *   sendReply: (req, hash) => body  a borrow broadcast is NOT taken, and answered with that body, as it is (a node or a
 *                                   proxy that answers malformed, mismatched, or accepted-but-never-mined)
 *   stallReceipts                   a request carrying eth_getTransactionReceipt is never answered (left open)
 * `bodies` keeps every request the node received, to check what was sent to it.
 */
function chain({ line = 20_000000n, lose = null, loseRegister = false, loseNonceRead = false, refuseSend = null, minedRevert = false, noEvent = false, registerNoLog = false, failReadsAfterWrite = false, replace = null, known = {}, counts = null, noIdentity = false, loseBeforeNode = false, appear = null, nonceUsed = null, finalized = BLOCK, hold = null, stateWindow = null, holdCall = null, holdRefuse = null, takeThenRefuse = null, sentReceiptAfter = 0, sentKnown = false, rateLimitSend = 0, redirectSend = null, refuseFirstSend = null, ws = false, holdSendAt = 0, sendReply = null, stallReceipts = false } = {}) {
  const sent = [], receipts = new Map(), nonces = new Map(), borrowHashes = new Set(), registerHashes = new Set(), bodies = [], sentTxs = new Map();
  let byHashReads = 0, droppedOnce = false, rateLimited = 0, refusedFirst = false, borrowSends = 0;
  const receiptReads = new Map();
  let fin = finalized, head = BLOCK;
  const tagNum = (t) => (t === "latest" || t === "pending" || t == null ? head : t === "finalized" || t === "safe" ? fin : Number(t));
  const hashOf = (num) => (nonceUsed && num === nonceUsed.at ? H(nonceUsed.at) : H(1)); // the canonical block hash
  const txObj = (hash, k) => ({ hash, from: owner.address, nonce: q(k.nonce), to: k.to ?? POOL, input: k.input ?? "0x", value: k.value ?? "0x0", gas: q(300_000), gasPrice: q(1_000_000_000), type: "0x0", chainId: "0x1237", r: H(11), s: H(12), v: "0x1b", ...(k.block == null ? { blockHash: null, blockNumber: null, transactionIndex: null } : { blockHash: k.blockHash ?? hashOf(k.block), blockNumber: q(k.block), transactionIndex: "0x0" }) });
  const nonceTx = () => {
    const like = nonceUsed.like ? ethers.Transaction.from(nonceUsed.like) : null;
    return txObj(nonceUsed.by, { nonce: nonceUsed.nonce, block: nonceUsed.at, to: like ? like.to : owner.address, input: like ? like.data : "0x", value: like ? q(like.value) : "0x0" });
  };
  let heldOnce = false, seenBroadcast, heldCallOnce = false, seenCall;
  const broadcastSeen = new Promise((ok) => (seenBroadcast = ok));
  const callSeen = new Promise((ok) => (seenCall = ok));
  const held = [];
  let principalOut = 0n, loans = 0, collateral = 0n, written = false, replacement = null;
  const q = (n) => ethers.toQuantity(n);
  const H = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const agentTuple = () => [false, false, false, false, false, 1n, 0n, 0n, SPONSOR, line, 0n, principalOut, BigInt(loans), 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
  function exec({ to, data, from }, send) {
    if (same(to, POOL)) {
      const f = poolI.parseTransaction({ data });
      const ok = (vals, gas = 50_000n) => ({ result: poolI.encodeFunctionResult(f.name, vals), gas });
      switch (f.name) {
        case "getAgent": return ok([agentTuple()]);
        case "loansOf": return ok([[]]);
        case "registry": return ok([REG]);
        case "usdg": return ok([USDG]);
        case "getParams": return ok([PARAMS]);
        case "quoteFee": return ok([FEE, 0n, 0n, 0n]);
        case "isController": return ok([same(f.args[1], owner.address)]);
        case "borrow": {
          const [id, amount, term, recipient] = f.args;
          const avail = line > principalOut ? line - principalOut : 0n;
          if (amount > avail) return { revert: poolI.encodeErrorResult("InsufficientCapacity", [id, amount, avail]) };
          if (!send) return ok([BigInt(loans + 1)], 300_000n);
          if (minedRevert) return { ...ok([0n], 300_000n), status: 0, borrow: true };
          principalOut += amount;
          const loanId = BigInt(++loans);
          const log = poolI.encodeEventLog("Borrowed", [loanId, id, SPONSOR, amount, FEE, BigInt(nowS()) + term, recipient]);
          return { ...ok([loanId], 300_000n), logs: noEvent ? [] : [{ address: POOL, ...log }], borrow: true };
        }
      }
    }
    if (same(to, VAULT)) {
      const f = vaultI.parseTransaction({ data });
      const ok = (vals, gas = 80_000n) => ({ result: vaultI.encodeFunctionResult(f.name, vals), gas });
      switch (f.name) {
        case "getPosition": return ok([[owner.address, owner.address, TOKEN, BigInt(nowS() - 86400), false, 1, 100_000000n, 10n ** 18n + collateral]]);
        case "addCollateral": if (send) collateral += f.args[1]; return ok([], 120_000n);
      }
    }
    if (same(to, REG)) {
      const f = regI.parseTransaction({ data });
      if (f.name === "register") {
        const log = regI.encodeEventLog("Transfer", [ethers.ZeroAddress, from || owner.address, 9001n]);
        return { result: regI.encodeFunctionResult("register", [9001n]), gas: 120_000n, logs: send && !registerNoLog ? [{ address: REG, ...log }] : [], register: true };
      }
      return { result: regI.encodeFunctionResult(f.name, [f.name === "ownerOf" ? owner.address : noIdentity ? 0n : 1n]), gas: 50_000n };
    }
    if (same(to, USDG) || same(to, TOKEN)) {
      const f = erc20I.parseTransaction({ data });
      return { result: erc20I.encodeFunctionResult(f.name, [same(to, TOKEN) ? 10n ** 30n : 0n]), gas: 50_000n };
    }
    return { unknown: `no contract here answers ${to} ${String(data).slice(0, 10)}` };
  }
  const block = (full) => ({ number: q(BLOCK), hash: H(1), parentHash: H(0), timestamp: q(nowS()), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: q(30_000_000), gasUsed: "0x0", miner: ethers.ZeroAddress, extraData: "0x", baseFeePerGas: q(1_000_000_000), transactions: replacement ? [full ? replacement : replacement.hash] : [] });
  const receiptOf = (hash, tx, gas, logs, status) => ({ transactionHash: hash, blockHash: H(1), blockNumber: q(BLOCK), transactionIndex: "0x0", from: tx.from, to: tx.to, contractAddress: null, cumulativeGasUsed: q(gas), gasUsed: q(gas), effectiveGasPrice: q(1_000_000_000), logs: logs.map((l, i) => ({ ...l, blockNumber: q(BLOCK), blockHash: H(1), transactionHash: hash, transactionIndex: "0x0", logIndex: q(i), removed: false })), logsBloom: "0x" + "00".repeat(256), status: status === 0 ? "0x0" : "0x1", type: "0x2" });
  function answer(r) {
    const ok = (result) => ({ jsonrpc: "2.0", id: r.id, result });
    const err = (code, message, data) => ({ jsonrpc: "2.0", id: r.id, error: { code, message, ...(data ? { data } : {}) } });
    switch (r.method) {
      case "eth_chainId": return ok("0x1237");
      case "net_version": return ok("4663");
      case "eth_blockNumber": return ok(q(head));
      case "eth_getBlockByNumber": {
        const num = tagNum(r.params[0]);
        if (nonceUsed && num === nonceUsed.at && nonceUsed.blockUnservable) return err(-32000, "block not available");
        const txs = new Map();
        if (nonceUsed && num === nonceUsed.at) txs.set(nonceUsed.by, nonceTx());
        for (const [h, k] of Object.entries(known)) if (k.block === num && !txs.has(h)) txs.set(h, txObj(h, k));
        if (replacement && num === BLOCK) txs.set(replacement.hash, replacement);
        const list = [...txs.values()];
        return ok({ ...block(false), number: q(num), hash: hashOf(num), transactions: r.params[1] === true ? list : list.map((t) => t.hash) });
      }
      case "eth_gasPrice": case "eth_maxPriorityFeePerGas": return ok(q(1_000_000_000));
      case "eth_getTransactionCount": {
        if (nonceUsed) {
          const at = tagNum(r.params[1]);
          if (nonceUsed.servableFrom != null && at < nonceUsed.servableFrom) return err(-32000, "historical state is not available");
          if (stateWindow != null && at < head - stateWindow) return err(-32000, "historical state is not available");
          return ok(q(at >= nonceUsed.at ? nonceUsed.nonce + 1 : nonceUsed.nonce));
        }
        return ok(q(counts ? counts[r.params[1] === "pending" ? "pending" : "latest"] : nonces.get(String(r.params[0]).toLowerCase()) || 0));
      }
      case "eth_getTransactionByHash": {
        if (appear && r.params[0] === appear.hash && ++byHashReads > appear.after) known[appear.hash] = { nonce: appear.nonce, block: null };
        const k = known[r.params[0]] ?? (sentKnown ? sentTxs.get(r.params[0]) : undefined);
        if (!k) return ok(null);
        return ok(txObj(r.params[0], k));
      }
      case "eth_call": case "eth_estimateGas": {
        const x = exec(r.params[0], false);
        if (x.unknown) return err(-32601, x.unknown);
        if (x.revert) return err(3, "execution reverted", x.revert);
        return ok(r.method === "eth_call" ? x.result : q(x.gas));
      }
      case "eth_sendRawTransaction": {
        const tx = ethers.Transaction.from(r.params[0]);
        const isBorrow = same(tx.to, POOL) && poolI.parseTransaction({ data: tx.data })?.name === "borrow";
        if (isBorrow && refuseSend) return err(-32000, refuseSend);
        if (isBorrow && refuseFirstSend && !refusedFirst) { refusedFirst = true; return err(-32000, refuseFirstSend); }
        const bump = () => nonces.set(tx.from.toLowerCase(), (nonces.get(tx.from.toLowerCase()) || 0) + 1);
        if (isBorrow && replace) {
          // accepted, then another transaction with its nonce mines instead (never this one)
          const base = { from: tx.from, nonce: q(tx.nonce), gas: q(tx.gasLimit), gasPrice: q(3_000_000_000), type: "0x0", chainId: "0x1237", r: H(11), s: H(12), v: "0x1b", blockHash: H(1), blockNumber: q(BLOCK), transactionIndex: "0x0" };
          const rtx = replace === "repriced" ? { ...base, to: tx.to, input: tx.data, value: q(tx.value) } : { ...base, to: tx.from, input: "0x", value: "0x0" };
          rtx.hash = ethers.keccak256(ethers.toUtf8Bytes(`replacement of ${tx.hash}`));
          const x = replace === "repriced" ? exec({ to: tx.to, data: tx.data, from: tx.from }, true) : { gas: 21_000n, logs: [] };
          receipts.set(rtx.hash, receiptOf(rtx.hash, { from: tx.from, to: rtx.to }, x.gas, x.logs || [], 1));
          replacement = rtx;
          sent.push({ fn: replace === "repriced" ? "borrow" : "cancel", hash: rtx.hash, replaced: tx.hash });
          bump();
          written = true;
          return ok(tx.hash);
        }
        const x = exec({ to: tx.to, data: tx.data, from: tx.from }, true);
        if (x.unknown) return err(-32601, x.unknown);
        sent.push({ fn: x.borrow ? "borrow" : x.register ? "register" : String(tx.data).slice(0, 10), hash: tx.hash });
        if (x.borrow) borrowHashes.add(tx.hash);
        if (x.register) registerHashes.add(tx.hash);
        bump();
        written = true;
        receipts.set(tx.hash, receiptOf(tx.hash, tx, x.gas, x.logs || [], x.status));
        sentTxs.set(tx.hash, { nonce: tx.nonce, block: BLOCK, to: tx.to, input: tx.data, value: q(tx.value) });
        if (isBorrow && takeThenRefuse) return err(-32000, takeThenRefuse); // taken, and the answer says otherwise
        return ok(tx.hash);
      }
      case "eth_getTransactionReceipt": {
        const k = known[r.params[0]];
        const n = (receiptReads.get(r.params[0]) || 0) + 1;
        receiptReads.set(r.params[0], n);
        if (k && k.receiptAfter != null && n <= k.receiptAfter) return ok(null);
        if (!k && receipts.has(r.params[0]) && n <= sentReceiptAfter) return ok(null);
        if (k && k.block != null) return ok({ ...receiptOf(r.params[0], { from: owner.address, to: k.to ?? POOL }, 300_000n, [], k.status), blockNumber: q(k.block), blockHash: k.blockHash ?? hashOf(k.block) });
        return ok(receipts.get(r.params[0]) || null);
      }
      default: return err(-32601, `unexpected ${r.method}`);
    }
  }
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      const msg = JSON.parse(body);
      const items = [].concat(msg);
      const has = (m, f = () => true) => items.some((r) => r.method === m && f(r));
      if (loseNonceRead && has("eth_getTransactionCount")) return req.socket.destroy();
      if (stallReceipts && has("eth_getTransactionReceipt")) return; // never answered: the request stays open
      if (rateLimited < rateLimitSend && has("eth_sendRawTransaction")) { rateLimited++; res.writeHead(429, { "content-type": "text/plain" }); return res.end("Too Many Requests"); }
      if (redirectSend && has("eth_sendRawTransaction")) {
        if (redirectSend.take) items.map(answer); // the first hop takes the bytes, then redirects
        res.writeHead(307, { location: redirectSend.to });
        return res.end();
      }
      const isBorrowRaw = (r) => { const t = ethers.Transaction.from(r.params[0]); return same(t.to, POOL) && poolI.parseTransaction({ data: t.data })?.name === "borrow"; };
      if (loseBeforeNode && !droppedOnce && has("eth_sendRawTransaction", isBorrowRaw)) { droppedOnce = true; return req.socket.destroy(); }
      if (sendReply && has("eth_sendRawTransaction", isBorrowRaw)) {
        const r = items.find((x) => x.method === "eth_sendRawTransaction");
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(sendReply(r, ethers.Transaction.from(r.params[0]).hash)));
      }
      if (holdSendAt && has("eth_sendRawTransaction", isBorrowRaw) && ++borrowSends === holdSendAt) {
        seenBroadcast();
        const outHeld = items.map(answer); // taken now; its answer waits
        return held.push(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(msg) ? outHeld : outHeld[0])); });
      }
      if (holdRefuse && !heldOnce && has("eth_sendRawTransaction", isBorrowRaw)) {
        heldOnce = true;
        seenBroadcast();
        const outHeld = items.map((r) => (r.method === "eth_sendRawTransaction" ? { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: holdRefuse } } : answer(r)));
        return held.push(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(msg) ? outHeld : outHeld[0])); });
      }
      if (hold && !heldOnce && has("eth_sendRawTransaction", isBorrowRaw)) {
        heldOnce = true;
        seenBroadcast();
        if (hold === "before-apply") return held.push(() => req.socket.destroy());
        const outHeld = items.map(answer); // the node takes it now; its answer waits
        return held.push(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(msg) ? outHeld : outHeld[0])); });
      }
      if (holdCall && !heldCallOnce && has(holdCall)) {
        heldCallOnce = true;
        seenCall();
        const outHeld = items.map(answer);
        return held.push(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(msg) ? outHeld : outHeld[0])); });
      }
      if (failReadsAfterWrite && written && has("eth_call")) return req.socket.destroy();
      if (lose === "receipt" && has("eth_getTransactionReceipt", (r) => borrowHashes.has(r.params[0]))) return req.socket.destroy();
      const out = items.map(answer);
      // the transport loses the answer, after the node took (and mined) what it was sent
      const sentNow = (set) => (r) => set.has(ethers.Transaction.from(r.params[0]).hash);
      if (lose === "broadcast" && has("eth_sendRawTransaction", sentNow(borrowHashes))) return req.socket.destroy();
      if (loseRegister && has("eth_sendRawTransaction", sentNow(registerHashes))) return req.socket.destroy();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
    });
  });
  if (ws) {
    new WebSocketServer({ server }).on("connection", (sock) => sock.on("message", (data) => {
      const body = String(data);
      bodies.push(body);
      const msg = JSON.parse(body);
      const out = [].concat(msg).map(answer);
      sock.send(JSON.stringify(Array.isArray(msg) ? out : out[0]));
    }));
  }
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    const provider = new ethers.JsonRpcProvider(url, 4663, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
    ok({ url, wsUrl: url.replace("http:", "ws:"), provider, sent, bodies, loans: () => loans, collateral: () => collateral, broadcastSeen, callSeen, releaseHeld: () => { for (const f of held.splice(0)) f(); }, setFinalized: (n) => (fin = n), advance: (n) => (head += n), close: () => { provider.destroy(); server.closeAllConnections(); server.close(); } });
  }));
}
async function onChain(opts, fn) {
  const c = await chain(opts);
  try { return await fn(c); } finally { c.close(); }
}
const sdk = (c, signer = owner.connect(c.provider)) => new PriorsV2({ signer, addresses: ADDRESSES });
const caught = (p) => p.then((v) => assert.fail(`no error, got ${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x))}`), (e) => e);
const borrows = (c) => c.sent.filter((s) => s.fn === "borrow");
/** How many requests carrying eth_sendRawTransaction reached the node, taken or not. */
const sendRaws = (c) => c.bodies.filter((b) => b.includes('"eth_sendRawTransaction"')).length;
const notUnconfirmed = (e) => {
  assert.ok(!/UNCONFIRMED/.test(String(e.code)), `got ${e.code}: ${e.message}`);
  assert.equal(e.unconfirmed, undefined);
};

/** A wallet that declines to sign, as a browser wallet does when its user says no (it signs and sends in one step). */
class DecliningSigner extends ethers.AbstractSigner {
  constructor(provider) { super(provider); }
  async getAddress() { return owner.address; }
  connect(provider) { return new DecliningSigner(provider); }
  async signTransaction() { throw ethers.makeError("user rejected action", "ACTION_REJECTED", { action: "signTransaction", reason: "rejected" }); }
  async sendTransaction() { throw ethers.makeError("user rejected action", "ACTION_REJECTED", { action: "sendTransaction", reason: "rejected" }); }
  async signMessage() { throw new Error("unused"); }
  async signTypedData() { throw new Error("unused"); }
}

// ---------------------------------------------------------------------------------------------------------------
console.log("PriorsV2.borrow (sdk/priors-v2.mjs): a borrow whose answer is lost");

await check("the broadcast's answer is lost after the loan opened: BORROW_UNCONFIRMED with the amount and the tx hash (signed locally, known before the broadcast)", () =>
  onChain({ lose: "broadcast" }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    assert.equal(c.loans(), 1, "the stub opened the loan");
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got code ${e.code}: ${e.message}`);
    assert.equal(e.unconfirmed, true);
    assert.equal(e.borrowed, 5_000000n);
    assert.equal(e.loanId, null);
    assert.equal(e.dueAt, null);
    assert.equal(e.hash, borrows(c)[0].hash);
    assert.equal(e.nonce, 0, "the nonce it was signed with, to settle it later (txStatus)");
    assert.equal(ethers.Transaction.from(e.raw).hash, e.hash, "the exact signed transaction, to send the same one again");
    assert.match(e.message, /may have opened a loan/);
    assert.doesNotMatch(e.message, /open loans before borrowing again/, "the open loans alone do not settle a transaction that may be pending");
    assert.match(e.message, /final/);
    assert.ok(e.cause, "the transport error is kept as the cause");
  }));

await check("every receipt read is lost after the loan opened: BORROW_UNCONFIRMED carrying the tx hash", () =>
  onChain({ lose: "receipt" }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    assert.equal(c.loans(), 1);
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got code ${e.code}: ${e.message}`);
    assert.equal(e.unconfirmed, true);
    assert.equal(e.borrowed, 5_000000n);
    assert.equal(e.hash, borrows(c)[0].hash);
    assert.match(e.message, new RegExp(e.hash));
  }));

await check("a status-1 receipt without the Borrowed event: BORROW_UNCONFIRMED (mined, its hash), never a plain error", () =>
  onChain({ noEvent: true }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    assert.equal(c.loans(), 1);
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got code ${e.code}: ${e.message}`);
    assert.equal(e.mined, true);
    assert.equal(e.borrowed, 5_000000n);
    assert.equal(e.hash, borrows(c)[0].hash);
    assert.match(e.message, /was mined/);
  }));

for (const msg of ["nonce too low", "replacement transaction underpriced", "already known"]) {
  await check(`regression (round 8): "${msg}" to a borrow signed here, its hash unknown to the node: BORROW_UNCONFIRMED (the nonce may be its own), never a refusal`, () =>
    onChain({ refuseSend: msg }, async (c) => {
      const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
      assert.equal(e.code, "BORROW_UNCONFIRMED", `got ${e.code}: ${e.message}`);
      assert.equal(ethers.Transaction.from(e.raw).hash, e.hash);
      assert.equal(c.loans(), 0);
    }));
}

await check("regression (round 9): the node took and mined the borrow, then answered \"insufficient funds\" (its own spend): the loan, never a refusal", () =>
  onChain({ takeThenRefuse: "insufficient funds for gas * price + value" }, async (c) => {
    const r = await sdk(c).borrow(AGENT, 5, 7 * 86400);
    assert.equal(r.loanId, 1);
    assert.equal(c.loans(), 1);
  }));

await check("regression (round 9): the node took and mined the borrow, then answered with a revert at the broadcast (CALL_EXCEPTION): the loan, never a refusal", () =>
  onChain({ takeThenRefuse: "broadcast-time revert" }, async (c) => {
    const orig = c.provider.getRpcError.bind(c.provider);
    c.provider.getRpcError = (payload, err) => (String(err?.error?.message).includes("broadcast-time revert")
      ? ethers.makeError("execution reverted", "CALL_EXCEPTION", { action: "sendTransaction", data: null, reason: null, invocation: null, revert: null, transaction: { to: null, from: null, data: "" } })
      : orig(payload, err));
    const r = await sdk(c).borrow(AGENT, 5, 7 * 86400);
    assert.equal(r.loanId, 1);
    assert.equal(c.loans(), 1);
  }));

await check("regression (round 9): a 429 on the broadcast: exactly one eth_sendRawTransaction reaches the node (no retry), BORROW_UNCONFIRMED", () =>
  onChain({ rateLimitSend: 1 }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    assert.equal(sendRaws(c), 1, `${sendRaws(c)} broadcast requests`);
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got ${e.code}: ${e.message}`);
    assert.equal(c.loans(), 0);
  }));

await check("regression (round 9): two endpoints (a fallback provider): a send error on the first is never sent again, to the first or to the second", async () => {
  const c1 = await chain({ rateLimitSend: 1 }), c2 = await chain({});
  try {
    const fb = new ethers.FallbackProvider([c1.provider, c2.provider], 4663, { quorum: 1 });
    const e = await caught(new PriorsV2({ signer: owner.connect(fb), addresses: ADDRESSES }).borrow(AGENT, 5, 7 * 86400));
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got ${e.code}: ${e.message}`);
    assert.deepEqual([sendRaws(c1), sendRaws(c2)], [1, 0]);
    fb.destroy();
  } finally {
    c1.close();
    c2.close();
  }
});

await check("regression (round 10): a 307 from the endpoint that took the bytes: no request follows it, BORROW_UNCONFIRMED (never the next hop's refusal)", async () => {
  const c2 = await chain({ refuseSend: "insufficient funds for gas * price + value" });
  const c1 = await chain({ redirectSend: { to: c2.url, take: true }, sentReceiptAfter: 99 });
  try {
    const e = await caught(sdk(c1).borrow(AGENT, 5, 7 * 86400));
    assert.deepEqual([sendRaws(c1), sendRaws(c2)], [1, 0], "one request, to the first URL only");
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got ${e.code}: ${e.message}`);
    assert.equal(c1.loans(), 1);
  } finally {
    c1.close();
    c2.close();
  }
});

/** A provider that is not JSON-RPC over HTTP (whether it sends once is unknown): it forwards to the stub's provider. */
class ForwardingProvider extends ethers.AbstractProvider {
  constructor(inner) {
    super(4663, { cacheTimeout: -1, pollingInterval: 100 });
    this.inner = inner;
  }
  async _detectNetwork() { return this.inner.getNetwork(); }
  async _perform(req) { return this.inner._perform(req); }
}
const viaProvider = (p) => new PriorsV2({ signer: owner.connect(p), addresses: ADDRESSES });
const providers = {
  "a custom AbstractProvider": (c) => new ForwardingProvider(c.provider),
  "a WebSocketProvider": (c) => new ethers.WebSocketProvider(c.wsUrl, 4663),
  "a FallbackProvider whose first entry is not JSON-RPC over HTTP": (c) => new ethers.FallbackProvider([new ForwardingProvider(c.provider)], 4663, { quorum: 1 }),
};
for (const [what, make] of Object.entries(providers)) {
  await check(`regression (round 10): ${what}: a borrow works`, () =>
    onChain({ ws: true }, async (c) => {
      const p = make(c);
      try {
        const r = await viaProvider(p).borrow(AGENT, 5, 7 * 86400);
        assert.equal(r.loanId, 1);
        assert.equal(c.loans(), 1);
      } finally {
        p.destroy();
      }
    }));
  await check(`regression (round 10): ${what}: a broadcast error (even "insufficient funds") is BORROW_UNCONFIRMED, never a refusal`, () =>
    onChain({ ws: true, refuseSend: "insufficient funds for gas * price + value" }, async (c) => {
      const p = make(c);
      try {
        const e = await caught(viaProvider(p).borrow(AGENT, 5, 7 * 86400));
        assert.equal(e.code, "BORROW_UNCONFIRMED", `got ${e.code}: ${e.message}`);
        assert.ok(e.hash && e.raw, "with its hash and bytes");
        assert.equal(c.loans(), 0);
      } finally {
        p.destroy();
      }
    }));
}

// A fetch-based transport that follows redirects inside one call, as a browser's fetch does with ethers' browser
// transport (utils/geturl-browser.js passes no `redirect`). That transport itself cannot be used in Node for this:
// Node's fetch detaches its Uint8Array body after the first hop, so the 307 fails instead of being followed. This one
// sends the body as text, which a redirect can send again.
const FOLLOWING_GET_URL = `async (req, signal) => {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== "content-length"));
  const res = await fetch(req.url, { method: req.method, headers, body: req.body ? new TextDecoder().decode(req.body) : undefined, redirect: "follow" });
  const out = {}; res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  return { statusCode: res.status, statusMessage: res.statusText, headers: out, body: new Uint8Array(await res.arrayBuffer()) };
}`;
const followingGetUrl = (0, eval)(`(${FOLLOWING_GET_URL})`);

await check("regression (round 11): a fetch transport as ethers' default (a browser build: redirects followed inside one call): a 307 from the hop that took the bytes is not followed, BORROW_UNCONFIRMED, the record stays sending", async () => {
  const c2 = await chain({ refuseSend: "insufficient funds for gas * price + value" });
  const c1 = await chain({ redirectSend: { to: c2.url, take: true }, sentReceiptAfter: 99 });
  try {
    const home = mkdtempSync(join(tmpdir(), "borrow-lost-browser-"));
    const cfg = { home, url: c1.url, key: owner.privateKey, addr: owner.address, addresses: ADDRESSES,
      sdk: pathToFileURL(join(ROOT, "sdk/priors-v2.mjs")).href, rec: pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href };
    const code = `const cfg = ${JSON.stringify(cfg)};
      const { ethers } = await import("ethers");
      ethers.FetchRequest.registerGetUrl(${FOLLOWING_GET_URL}); // as in a browser build: ethers' default transport is fetch
      const { PriorsV2 } = await import(cfg.sdk); const rec = await import(cfg.rec);
      const env = { HOME: cfg.home }; const lock = rec.lockKey(cfg.addr, env);
      const provider = new ethers.JsonRpcProvider(cfg.url, 4663, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
      const p = new PriorsV2({ signer: new ethers.Wallet(cfg.key, provider), addresses: cfg.addresses, journal: rec.keyJournal(cfg.addr, () => lock.held(), "borrow", env) });
      let b; try { b = { ok: (await p.borrow(${AGENT}n, 5, 7 * 86400)).loanId }; } catch (e) { b = { code: e.code, message: e.message }; }
      console.log(JSON.stringify(b)); process.exit(0);`;
    const out = await new Promise((ok) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home } });
      let o = "", e = "";
      child.stdout.on("data", (x) => (o += x));
      child.stderr.on("data", (x) => (e += x));
      child.on("close", () => ok({ o, e }));
    });
    let b;
    try { b = JSON.parse(out.o.trim().split("\n").pop()); } catch (_) { assert.fail(`no result: ${out.o} ${out.e}`); }
    assert.deepEqual([sendRaws(c1), sendRaws(c2)], [1, 0], "one request, to the first URL only");
    assert.equal(b.code, "BORROW_UNCONFIRMED", JSON.stringify(b));
    assert.equal(readdirSync(join(home, ".local", "state", "priors", "unconfirmed")).filter((f) => f.endsWith(".json")).length, 1, "kept, as sending");
    rmSync(home, { recursive: true, force: true });
  } finally {
    c1.close();
    c2.close();
  }
});

/**
 * A borrow in a process of its own, with a record journal and the key's lock, after `preload` (code run BEFORE the SDK
 * is imported, e.g. a fetch in place as the SDK finds it when it loads). Returns { b, home }: the borrow's result or
 * error code, and the home whose records the test can read.
 */
async function childBorrow(c, preload = "") {
  const home = mkdtempSync(join(tmpdir(), "borrow-lost-child-"));
  const cfg = { home, url: c.url, key: owner.privateKey, addr: owner.address, addresses: ADDRESSES,
    sdk: pathToFileURL(join(ROOT, "sdk/priors-v2.mjs")).href, rec: pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href };
  const code = `const cfg = ${JSON.stringify(cfg)};
    const { ethers } = await import("ethers");
    ${preload}
    const { PriorsV2 } = await import(cfg.sdk); const rec = await import(cfg.rec);
    const env = { HOME: cfg.home }; const lock = rec.lockKey(cfg.addr, env);
    const provider = new ethers.JsonRpcProvider(cfg.url, 4663, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
    const p = new PriorsV2({ signer: new ethers.Wallet(cfg.key, provider), addresses: cfg.addresses, journal: rec.keyJournal(cfg.addr, () => lock.held(), "borrow", env) });
    let b; try { b = { ok: (await p.borrow(${AGENT}n, 5, 7 * 86400)).loanId }; } catch (e) { b = { code: e.code, message: e.message }; }
    console.log(JSON.stringify(b)); process.exit(0);`;
  const out = await new Promise((ok) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home } });
    let o = "", e = "";
    child.stdout.on("data", (x) => (o += x));
    child.stderr.on("data", (x) => (e += x));
    child.on("close", () => ok({ o, e }));
  });
  let b;
  try { b = JSON.parse(out.o.trim().split("\n").pop()); } catch (_) { assert.fail(`no result: ${out.o} ${out.e}`); }
  return { b, home, sending: () => readdirSync(join(home, ".local", "state", "priors", "unconfirmed")).filter((f) => f.endsWith(".json")).length };
}

await check("guard (round 11, now with the fetch in place before the SDK loads): a browser's answer to a manual redirect (type \"opaqueredirect\", status 0): BORROW_UNCONFIRMED, nothing at the target, the record kept", async () => {
  const c2 = await chain({ refuseSend: "insufficient funds for gas * price + value" });
  const c1 = await chain({ redirectSend: { to: c2.url, take: true }, sentReceiptAfter: 99 });
  try {
    const { b, sending } = await childBorrow(c1, `const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const res = await realFetch(url, init);
        if (init?.redirect !== "manual" || res.status < 300 || res.status >= 400) return res;
        return { type: "opaqueredirect", status: 0, ok: false, statusText: "", headers: new Headers(), url: "", redirected: false, text: async () => "", json: async () => { throw new Error("opaque"); } };
      };`);
    assert.deepEqual([sendRaws(c1), sendRaws(c2)], [1, 0]);
    assert.equal(b.code, "BORROW_UNCONFIRMED", JSON.stringify(b));
    assert.equal(sending(), 1);
  } finally {
    c1.close();
    c2.close();
  }
});

await check("regression (round 12): a fetch in place before the SDK loads that ignores redirect: \"manual\" and follows (redirected, another URL): BORROW_UNCONFIRMED, never the next hop's refusal, the record kept", async () => {
  const c2 = await chain({ refuseSend: "insufficient funds for gas * price + value" });
  const c1 = await chain({ redirectSend: { to: c2.url, take: true }, sentReceiptAfter: 99 });
  try {
    const { b, sending } = await childBorrow(c1, `const realFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => realFetch(url, { ...init, redirect: "follow" }); // ignores "manual"`);
    assert.equal(b.code, "BORROW_UNCONFIRMED", JSON.stringify(b));
    assert.equal(sending(), 1, "kept, as sending");
    assert.equal(c1.loans(), 1);
  } finally {
    c1.close();
    c2.close();
  }
});

await check("regression (round 12): fetch replaced after the SDK loaded (a wrapper that follows redirects): the conservative path, never a refusal (BORROW_UNCONFIRMED)", async () => {
  const c2 = await chain({ refuseSend: "insufficient funds for gas * price + value" });
  const c1 = await chain({ redirectSend: { to: c2.url, take: true }, sentReceiptAfter: 99 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(url, { ...init, redirect: "follow" });
  try {
    const e = await caught(sdk(c1).borrow(AGENT, 5, 7 * 86400));
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got ${e.code}: ${e.message}`);
    assert.equal(c1.loans(), 1);
  } finally {
    globalThis.fetch = realFetch;
    c1.close();
    c2.close();
  }
});

await check("regression (round 11): a provider with a custom getUrlFunc that follows redirects itself: the next hop's \"insufficient funds\" is never a refusal (BORROW_UNCONFIRMED)", async () => {
  const c2 = await chain({ refuseSend: "insufficient funds for gas * price + value" });
  const c1 = await chain({ redirectSend: { to: c2.url, take: true }, sentReceiptAfter: 99 });
  try {
    const req = new ethers.FetchRequest(c1.url);
    req.getUrlFunc = followingGetUrl; // redirects followed inside one call
    const p = new ethers.JsonRpcProvider(req, 4663, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
    const e = await caught(new PriorsV2({ signer: owner.connect(p), addresses: ADDRESSES }).borrow(AGENT, 5, 7 * 86400));
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got ${e.code}: ${e.message}`);
    assert.equal(c1.loans(), 1, "the first hop took it");
    p.destroy();
  } finally {
    c1.close();
    c2.close();
  }
});

await check("guard (round 11): a provider with a custom getUrlFunc: a borrow works", () =>
  onChain({}, async (c) => {
    const req = new ethers.FetchRequest(c.url);
    req.getUrlFunc = followingGetUrl;
    const p = new ethers.JsonRpcProvider(req, 4663, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
    const r = await new PriorsV2({ signer: owner.connect(p), addresses: ADDRESSES }).borrow(AGENT, 5, 7 * 86400);
    assert.equal(r.loanId, 1);
    p.destroy();
  }));

const INSUFFICIENT = { code: -32000, message: "insufficient funds for gas * price + value" };
const malformed = {
  "no jsonrpc": (r) => ({ id: r.id, error: INSUFFICIENT }),
  "a wrong id": (r) => ({ jsonrpc: "2.0", id: Number(r.id) + 1, error: INSUFFICIENT }),
  "jsonrpc \"1.0\"": (r) => ({ jsonrpc: "1.0", id: r.id, error: INSUFFICIENT }),
  "an array reply": (r) => [{ jsonrpc: "2.0", id: r.id, error: INSUFFICIENT }],
  "both error and result": (r, h) => ({ jsonrpc: "2.0", id: r.id, result: h, error: INSUFFICIENT }),
  "a result \"ok\"": (r) => ({ jsonrpc: "2.0", id: r.id, result: "ok" }),
  "an unrelated hash": (r) => ({ jsonrpc: "2.0", id: r.id, result: "0x" + "ab".repeat(32) }),
};
await check("regression (round 12): fetch replaced after the SDK loaded by one that follows a redirect and hides it (same URL, not marked redirected): the conservative path, never a refusal", async () => {
  const c2 = await chain({ refuseSend: "insufficient funds for gas * price + value" });
  const c1 = await chain({ redirectSend: { to: c2.url, take: true }, sentReceiptAfter: 99 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const res = await realFetch(url, { ...init, redirect: "follow" });
    const text = await res.text();
    return { ok: res.ok, status: res.status, statusText: res.statusText, headers: res.headers, type: "basic", redirected: false, url: String(url), text: async () => text, json: async () => JSON.parse(text) };
  };
  try {
    const e = await caught(sdk(c1).borrow(AGENT, 5, 7 * 86400));
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got ${e.code}: ${e.message}`);
    assert.equal(c1.loans(), 1);
  } finally {
    globalThis.fetch = realFetch;
    c1.close();
    c2.close();
  }
});

/** A borrow in this process, with a record journal and the key's lock, against the clock: { r, e, ms, records }. */
async function journalledBorrow(c, limitMs, opts = {}) {
  const home = freshHomeEarly();
  const env = { HOME: home };
  const rec = await import(pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href);
  const lock = rec.lockKey(owner.address, env);
  const t0 = Date.now();
  const run = new PriorsV2({ signer: owner.connect(c.provider), addresses: ADDRESSES, journal: rec.keyJournal(owner.address, () => lock.held(), "borrow", env), ...opts })
    .borrow(AGENT, 5, 7 * 86400).then((ok) => ({ ok }), (e) => ({ e }));
  const out = await Promise.race([run, new Promise((ok) => setTimeout(() => ok({ hung: true }), limitMs))]);
  const dir = join(home, ".local", "state", "priors", "unconfirmed");
  return { ...out, ms: Date.now() - t0, sending: existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0 };
}
const freshHomeEarly = () => mkdtempSync(join(tmpdir(), "borrow-lost-j-"));
for (const [what, reply] of Object.entries(malformed)) {
  await check(`regression (round 12): the broadcast answered with ${what}: BORROW_UNCONFIRMED within seconds, the record kept`, () =>
    onChain({ sendReply: reply }, async (c) => {
      const o = await journalledBorrow(c, 10_000);
      assert.ok(!o.hung, `still waiting after ${o.ms} ms`);
      assert.equal(o.e?.code, "BORROW_UNCONFIRMED", o.e ? `${o.e.code}: ${o.e.message}` : `no error (${JSON.stringify(o.ok)})`);
      assert.equal(o.sending, 1, "kept, as sending");
      assert.equal(c.loans(), 0);
    }));
}
await check("regression (round 12): accepted with our own hash and never mined: the wait is bounded (waitTimeoutMs), then BORROW_UNCONFIRMED, the record kept", () =>
  onChain({ sendReply: (r, h) => ({ jsonrpc: "2.0", id: r.id, result: h }) }, async (c) => {
    const o = await journalledBorrow(c, 10_000, { waitTimeoutMs: 1500 });
    assert.ok(!o.hung, `still waiting after ${o.ms} ms`);
    assert.equal(o.e?.code, "BORROW_UNCONFIRMED", o.e ? `${o.e.code}: ${o.e.message}` : `no error (${JSON.stringify(o.ok)})`);
    assert.equal(o.sending, 1);
  }));

await check("regression (round 13): an answered \"insufficient funds\" whose hash lookup never answers: BORROW_UNCONFIRMED within the bound, never a refusal, the record kept", () =>
  onChain({ refuseSend: "insufficient funds for gas * price + value", stallReceipts: true }, async (c) => {
    const o = await journalledBorrow(c, 12_000, { waitTimeoutMs: 1500 });
    assert.ok(!o.hung, `still waiting after ${o.ms} ms`);
    assert.ok(o.ms < 1500 + 5000, `${o.ms} ms`);
    assert.equal(o.e?.code, "BORROW_UNCONFIRMED", o.e ? `${o.e.code}: ${o.e.message}` : `no error (${JSON.stringify(o.ok)})`);
    assert.equal(o.sending, 1);
  }));

await check("regression (round 13): a provider whose receipt request never settles (a WebSocket left open, say): BORROW_UNCONFIRMED within the bound, and the process exits by itself", () =>
  onChain({}, async (c) => {
    const cfg = { url: c.url, key: owner.privateKey, addresses: ADDRESSES, sdk: pathToFileURL(join(ROOT, "sdk/priors-v2.mjs")).href };
    const code = `const cfg = ${JSON.stringify(cfg)};
      const { ethers } = await import("ethers"); const { PriorsV2 } = await import(cfg.sdk);
      class Stalling extends ethers.AbstractProvider {
        constructor(inner) { super(4663, { cacheTimeout: -1, pollingInterval: 100 }); this.inner = inner; }
        async _detectNetwork() { return this.inner.getNetwork(); }
        _perform(req) { return req.method === "getTransactionReceipt" ? new Promise(() => {}) : this.inner._perform(req); }
      }
      const inner = new ethers.JsonRpcProvider(cfg.url, 4663, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
      const provider = new Stalling(inner);
      const t0 = Date.now();
      let b; try { b = { ok: (await new PriorsV2({ signer: new ethers.Wallet(cfg.key, provider), addresses: cfg.addresses, waitTimeoutMs: 1500 }).borrow(${AGENT}n, 5, 7 * 86400)).loanId }; } catch (e) { b = { code: e.code, message: e.message }; }
      console.log(JSON.stringify({ ...b, ms: Date.now() - t0 }));
      provider.destroy(); inner.destroy(); // no process.exit: the process has to end by itself`;
    const t0 = Date.now();
    const out = await new Promise((ok) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { PATH: process.env.PATH } });
      let o = "", e = "";
      const kill = setTimeout(() => child.kill("SIGKILL"), 14_000);
      child.stdout.on("data", (x) => (o += x));
      child.stderr.on("data", (x) => (e += x));
      child.on("close", (code_, signal) => { clearTimeout(kill); ok({ o, e, signal }); });
    });
    assert.notEqual(out.signal, "SIGKILL", `the process did not end by itself (${Date.now() - t0} ms): ${out.o} ${out.e}`);
    assert.ok(out.o.trim(), `the borrow never settled: the process ended without a result (${Date.now() - t0} ms) ${out.e.slice(0, 200)}`);
    const b = JSON.parse(out.o.trim().split("\n").pop());
    assert.equal(b.code, "BORROW_UNCONFIRMED", JSON.stringify(b));
    assert.ok(b.ms < 1500 + 5000, `${b.ms} ms`);
    assert.equal(c.loans(), 1, "it was sent and taken");
  }));

await check("a refusal that shows the bytes were not taken (insufficient funds): INSUFFICIENT_FUNDS as it is, nothing borrowed", () =>
  onChain({ refuseSend: "insufficient funds for gas * price + value" }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    assert.equal(e.code, "INSUFFICIENT_FUNDS", `got ${e.code}: ${e.message}`);
    notUnconfirmed(e);
    assert.equal(c.loans(), 0);
  }));

for (const msg of ["nonce too low", "already known"]) {
  await check(`regression (round 8): the node took and mined the borrow, then answered "${msg}" (a retried request): the loan, read from its receipt (it ran), never a refusal`, () =>
    onChain({ takeThenRefuse: msg }, async (c) => {
      const r = await sdk(c).borrow(AGENT, 5, 7 * 86400);
      assert.equal(r.loanId, 1);
      assert.equal(r.hash, borrows(c)[0].hash);
      assert.equal(c.loans(), 1);
    }));
}

await check("regression (round 8): taken, then \"nonce too low\", the node knows it but its receipt lags: waited for, then the loan", () =>
  onChain({ takeThenRefuse: "nonce too low", sentKnown: true, sentReceiptAfter: 1 }, async (c) => {
    const r = await sdk(c).borrow(AGENT, 5, 7 * 86400);
    assert.equal(r.loanId, 1);
    assert.equal(c.loans(), 1);
  }));

await check("regression (round 8): taken, then \"nonce too low\", and neither its receipt nor the transaction readable: BORROW_UNCONFIRMED, never a refusal", () =>
  onChain({ takeThenRefuse: "nonce too low", sentReceiptAfter: 99 }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    assert.equal(e.code, "BORROW_UNCONFIRMED", `got ${e.code}: ${e.message}`);
    assert.equal(e.hash, borrows(c)[0].hash);
    assert.equal(c.loans(), 1, "it did open the loan");
  }));

await check("a wallet that declines to sign: ACTION_REJECTED as it is, nothing sent", () =>
  onChain({}, async (c) => {
    const e = await caught(sdk(c, new DecliningSigner(c.provider)).borrow(AGENT, 5, 7 * 86400));
    assert.equal(e.code, "ACTION_REJECTED", `got ${e.code}: ${e.message}`);
    notUnconfirmed(e);
    assert.equal(c.sent.length, 0);
  }));

await check("a lost answer before anything is signed (the nonce read): an ordinary error, nothing sent", () =>
  onChain({ loseNonceRead: true }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    notUnconfirmed(e);
    assert.equal(c.sent.length, 0);
    assert.equal(c.loans(), 0);
  }));

await check("replaced by a repriced copy of itself that mined: the borrow's result, from the replacement", () =>
  onChain({ replace: "repriced" }, async (c) => {
    const r = await sdk(c).borrow(AGENT, 5, 7 * 86400);
    assert.equal(r.loanId, 1);
    assert.equal(r.principal, 5_000000n);
    assert.equal(r.hash, c.sent[0].hash, "the hash of the transaction that mined");
    assert.equal(c.loans(), 1);
  }));

await check("cancelled (a 0-value transfer mined with its nonce): TRANSACTION_REPLACED with cancelled, not unconfirmed, nothing borrowed", () =>
  onChain({ replace: "cancelled" }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    assert.equal(e.code, "TRANSACTION_REPLACED", `got ${e.code}: ${e.message}`);
    assert.equal(e.cancelled, true);
    notUnconfirmed(e);
    assert.match(e.message, /did not run/);
    assert.equal(c.loans(), 0);
  }));

await check("control: a borrow the pool refuses is refused before sending (would revert), not unconfirmed, and nothing is sent", () =>
  onChain({ line: 4_000000n, lose: "broadcast" }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    notUnconfirmed(e);
    assert.match(e.message, /would revert: InsufficientCapacity/);
    assert.equal(c.sent.length, 0);
  }));

await check("control: a borrow that mines with status 0 is a CALL_EXCEPTION (nothing borrowed), not unconfirmed", () =>
  onChain({ minedRevert: true }, async (c) => {
    const e = await caught(sdk(c).borrow(AGENT, 5, 7 * 86400));
    assert.equal(e.code, "CALL_EXCEPTION", `got ${e.code}: ${e.message}`);
    notUnconfirmed(e);
    assert.equal(c.loans(), 0);
  }));

await check("control: with every answer delivered the borrow returns its loan", () =>
  onChain({}, async (c) => {
    const r = await sdk(c).borrow(AGENT, 5, 7 * 86400);
    assert.equal(r.loanId, 1);
    assert.equal(r.principal, 5_000000n);
    assert.equal(r.hash, borrows(c)[0].hash);
  }));

console.log("other writes through sendChecked");

await check("register whose broadcast answer is lost: TX_UNCONFIRMED", () =>
  onChain({ loseRegister: true }, async (c) => {
    const e = await caught(sdk(c).register("priors:test"));
    assert.equal(e.code, "TX_UNCONFIRMED", `got code ${e.code}: ${e.message}`);
    assert.equal(e.unconfirmed, true);
    assert.match(e.message, /register was sent .*answer was lost.*may have landed/);
  }));

await check("register mined without its mint log: TX_UNCONFIRMED (mined, its hash), not a plain error that invites a second identity", () =>
  onChain({ registerNoLog: true }, async (c) => {
    const e = await caught(sdk(c).register("priors:test"));
    assert.equal(e.code, "TX_UNCONFIRMED", `got code ${e.code}: ${e.message}`);
    assert.equal(e.mined, true);
    assert.equal(e.hash, c.sent[0].hash);
  }));

await check("addCollateral whose position read fails after the write: TX_UNCONFIRMED (mined, its hash), not a plain error that invites a second deposit", () =>
  onChain({ failReadsAfterWrite: true }, async (c) => {
    const e = await caught(sdk(c).addCollateral(AGENT, 5n));
    assert.equal(c.collateral(), 5n, "the stub took the collateral");
    assert.equal(e.code, "TX_UNCONFIRMED", `got code ${e.code}: ${e.message}`);
    assert.equal(e.mined, true);
    assert.equal(e.hash, c.sent[0].hash);
  }));

console.log("PriorsV2.txStatus: whether a transaction whose answer was lost is final, and whether it ran");

const HX = "0x" + "ab".repeat(32);
const H32 = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const txStatusOf = (opts, q = {}) => onChain(opts, (c) => sdk(c).txStatus(HX, q));

await check("mined with status 1: final, it ran", async () => {
  const s = await txStatusOf({ known: { [HX]: { nonce: 4, block: 80_000_000, status: 1 } } });
  assert.deepEqual([s.state, s.final, s.ran], ["mined", true, true]);
});
await check("mined with status 0: final, it did not run (reverted)", async () => {
  const s = await txStatusOf({ known: { [HX]: { nonce: 4, block: 80_000_000, status: 0 } } });
  assert.deepEqual([s.state, s.final, s.ran], ["reverted", true, false]);
});
await check("known and not mined, its nonce not used yet: pending, not final", async () => {
  const s = await txStatusOf({ known: { [HX]: { nonce: 4, block: null } }, counts: { latest: 4, pending: 5 } });
  assert.deepEqual([s.state, s.final, s.ran], ["pending", false, null]);
});
// the nonce history the tests below use: nonce 4 of this key used in block K, sent from block SENT on
const K = 79_999_960, SENT = 79_999_800, OTHER = "0x" + "cd".repeat(32);
// the recorded transaction: a borrow this key signed at nonce 4 (what an equivalent fee-bumped copy repeats)
const BORROW_DATA = poolI.encodeFunctionData("borrow", [AGENT, 5_000000n, 7n * 86400n, owner.address, FEE]);
const RAW = await owner.signTransaction({ to: POOL, data: BORROW_DATA, nonce: 4, gasLimit: 300_000n, gasPrice: 1_000_000_000n, chainId: 4663n });
await check("pending here, and a different transaction took its nonce in block K (found there): replaced, final, it did not run", async () => {
  const s = await txStatusOf({ known: { [HX]: { nonce: 4, block: null } }, nonceUsed: { nonce: 4, at: K, by: OTHER } }, { sentBlock: SENT, raw: RAW });
  assert.deepEqual([s.state, s.final, s.ran, s.by, s.block], ["replaced", true, false, OTHER, K]);
});
await check("regression (receipt lag): the node shows ours mined, its nonce counted, no receipt yet: included, NOT final", async () => {
  const s = await txStatusOf({ known: { [HX]: { nonce: 4, block: K, status: 1, receiptAfter: 99 } }, nonceUsed: { nonce: 4, at: K, by: HX } }, { sentBlock: SENT });
  assert.deepEqual([s.state, s.final, s.ran], ["included", false, null]);
});
await check("regression (receipt lag): the same, then the receipt is readable: mined, final, it ran", () =>
  onChain({ known: { [HX]: { nonce: 4, block: K, status: 1, receiptAfter: 1 } }, nonceUsed: { nonce: 4, at: K, by: HX } }, async (c) => {
    const first = await sdk(c).txStatus(HX, { nonce: 4, sentBlock: SENT });
    assert.deepEqual([first.state, first.final], ["included", false]);
    const second = await sdk(c).txStatus(HX, { nonce: 4, sentBlock: SENT });
    assert.deepEqual([second.state, second.final, second.ran], ["mined", true, true]);
  }));
await check("regression (receipt lag): unknown by hash, its nonce counted, and block K holds OUR hash with no receipt yet: included, NOT final", async () => {
  const s = await txStatusOf({ nonceUsed: { nonce: 4, at: K, by: HX } }, { nonce: 4, sentBlock: SENT });
  assert.deepEqual([s.state, s.final, s.ran], ["included", false, null]);
});
await check("its nonce counted, but block K cannot be read: not final", async () => {
  const s = await txStatusOf({ nonceUsed: { nonce: 4, at: K, by: OTHER, blockUnservable: true } }, { nonce: 4, sentBlock: SENT });
  assert.deepEqual([s.state, s.final, s.ran], ["unsettled", false, null]);
});
await check("its nonce counted, but the history to find block K is outside this node's state: not final", async () => {
  const s = await txStatusOf({ nonceUsed: { nonce: 4, at: K, by: OTHER, servableFrom: 80_000_000 - 5 } }, { nonce: 4, sentBlock: SENT });
  assert.deepEqual([s.state, s.final, s.ran], ["unsettled", false, null]);
});
await check("unknown to the node, with the nonce it was signed with still free: not found, never final (another node's mempool may hold it)", async () => {
  const s = await txStatusOf({ counts: { latest: 4, pending: 4 } }, { nonce: 4 });
  assert.deepEqual([s.state, s.final, s.ran], ["not-found", false, null]);
});
await check("regression: unknown at the first hash and nonce reads, then in the mempool: not final, then pending, never 'safe' in between", () =>
  onChain({ counts: { latest: 4, pending: 4 }, appear: { hash: HX, nonce: 4, after: 1 } }, async (c) => {
    const first = await sdk(c).txStatus(HX, { nonce: 4 });
    assert.deepEqual([first.state, first.final, first.ran], ["not-found", false, null]);
    const second = await sdk(c).txStatus(HX, { nonce: 4 });
    assert.deepEqual([second.state, second.final, second.ran], ["pending", false, null]);
  }));
await check("unknown to the node, and block K shows a different transaction at its nonce: replaced, final, it did not run", async () => {
  const s = await txStatusOf({ nonceUsed: { nonce: 4, at: K, by: OTHER } }, { nonce: 4, sentBlock: SENT, raw: RAW });
  assert.deepEqual([s.state, s.final, s.ran, s.by], ["replaced", true, false, OTHER]);
});
await check("no send block known: the search still finds block K from the latest block back", async () => {
  const s = await txStatusOf({ nonceUsed: { nonce: 4, at: K, by: OTHER } }, { nonce: 4, raw: RAW });
  assert.deepEqual([s.state, s.final, s.by], ["replaced", true, OTHER]);
});

console.log("PriorsV2.txStatus: a fee-bumped copy, finality, an explorer's pointer, a persisted observation");

await check("regression (speed-up): a copy of the same call at the same nonce, another hash, that succeeded: it ran (mined), never 'replaced'", async () => {
  const s = await txStatusOf({ nonceUsed: { nonce: 4, at: K, by: OTHER, like: RAW }, known: { [OTHER]: { nonce: 4, block: K, status: 1, to: POOL, input: BORROW_DATA } } }, { nonce: 4, sentBlock: SENT, raw: RAW });
  assert.deepEqual([s.state, s.final, s.ran, s.by], ["mined", true, true, OTHER]);
});
await check("regression (speed-up): the same copy that reverted: reverted, final, it did not run", async () => {
  const s = await txStatusOf({ nonceUsed: { nonce: 4, at: K, by: OTHER, like: RAW }, known: { [OTHER]: { nonce: 4, block: K, status: 0, to: POOL, input: BORROW_DATA } } }, { nonce: 4, sentBlock: SENT, raw: RAW });
  assert.deepEqual([s.state, s.final, s.ran, s.by], ["reverted", true, false, OTHER]);
});
await check("a different transaction at its nonce, but no recorded bytes to compare it with: not final", async () => {
  const s = await txStatusOf({ nonceUsed: { nonce: 4, at: K, by: OTHER } }, { nonce: 4, sentBlock: SENT });
  assert.deepEqual([s.state, s.final], ["unsettled", false]);
});
await check("finality: its receipt in a block above the finalized one: mined but NOT final (waiting for finality)", async () => {
  const s = await txStatusOf({ known: { [HX]: { nonce: 4, block: 80_000_000, status: 1 } }, finalized: 80_000_000 - 100 });
  assert.deepEqual([s.state, s.final, s.ran, s.finality], ["mined", false, true, "waiting"]);
});
await check("finality: a status-0 receipt above the finalized block is NOT final either", async () => {
  const s = await txStatusOf({ known: { [HX]: { nonce: 4, block: 80_000_000, status: 0 } }, finalized: 80_000_000 - 100 });
  assert.deepEqual([s.state, s.final, s.finality], ["reverted", false, "waiting"]);
});
await check("finality: a replacement in a block above the finalized one is NOT final", async () => {
  const s = await txStatusOf({ nonceUsed: { nonce: 4, at: K, by: OTHER }, finalized: K - 1 }, { nonce: 4, sentBlock: SENT, raw: RAW });
  assert.deepEqual([s.state, s.final, s.finality], ["replaced", false, "waiting"]);
});
await check("finality: a fork flip (the receipt's block hash is not the canonical one at that number): NOT final", async () => {
  const s = await txStatusOf({ known: { [HX]: { nonce: 4, block: 80_000_000 - 10, status: 1, blockHash: H32(77) } } });
  assert.deepEqual([s.state, s.final, s.finality], ["mined", false, "reorged"]);
});
await check("finality: at or below the finalized block, on the canonical hash: final", async () => {
  const s = await txStatusOf({ known: { [HX]: { nonce: 4, block: 80_000_000 - 10, status: 1 } }, finalized: 80_000_000 - 10 });
  assert.deepEqual([s.state, s.final, s.finality], ["mined", true, "finalized"]);
});
const UNSERVABLE = { nonce: 4, at: K, by: OTHER, servableFrom: 80_000_000 - 5 };
await check("explorer (honest): history not served, the explorer points at the transaction at its nonce, verified on the RPC: replaced, final", async () => {
  const s = await txStatusOf({ nonceUsed: UNSERVABLE, known: { [OTHER]: { nonce: 4, block: K, status: 1, to: owner.address } } }, { nonce: 4, sentBlock: SENT, raw: RAW, explorer: async () => [OTHER] });
  assert.deepEqual([s.state, s.final, s.by], ["replaced", true, OTHER]);
});
await check("explorer (lying): it points at hashes the RPC does not confirm at this sender and nonce: not final", async () => {
  const LIE = "0x" + "ee".repeat(32);
  const s = await txStatusOf({ nonceUsed: UNSERVABLE, known: { [LIE]: { nonce: 9, block: K, status: 1, to: owner.address } } }, { nonce: 4, sentBlock: SENT, raw: RAW, explorer: async () => [LIE, "0x" + "ef".repeat(32)] });
  assert.deepEqual([s.state, s.final], ["unsettled", false]);
});
await check("explorer (unavailable): it fails: not final", async () => {
  const s = await txStatusOf({ nonceUsed: UNSERVABLE }, { nonce: 4, sentBlock: SENT, raw: RAW, explorer: async () => { throw new Error("403 challenge"); } });
  assert.deepEqual([s.state, s.final], ["unsettled", false]);
});
await check("observation: block K found while the history is served (not final yet), then re-read from the saved observation once finalized: final", () =>
  onChain({ nonceUsed: { nonce: 4, at: K, by: OTHER }, finalized: K - 1 }, async (c) => {
    const first = await sdk(c).txStatus(HX, { nonce: 4, sentBlock: SENT, raw: RAW });
    assert.deepEqual([first.state, first.final, first.seen.consumedBy.block], ["replaced", false, K]);
    c.setFinalized(80_000_000); // later: K is finalized, and the history that found it is gone
    const second = await onChain({ nonceUsed: { ...UNSERVABLE }, finalized: 80_000_000 }, (c2) => sdk(c2).txStatus(HX, { nonce: 4, sentBlock: SENT, raw: RAW, seen: first.seen }));
    assert.deepEqual([second.state, second.final, second.by], ["replaced", true, OTHER]);
  }));
await check("unknown to the node, its nonce taken by something pending: not found, not final", async () => {
  const s = await txStatusOf({ counts: { latest: 4, pending: 5 } }, { nonce: 4 });
  assert.deepEqual([s.state, s.final, s.ran], ["not-found", false, null]);
});
await check("unknown to the node and no nonce to settle it: not found, not final", async () => {
  const s = await txStatusOf({ counts: { latest: 4, pending: 4 } });
  assert.deepEqual([s.state, s.final, s.ran], ["not-found", false, null]);
});

// ---------------------------------------------------------------------------------------------------------------
console.log(`\`${CLI} borrow\` (bin/${CLI}.mjs)`);

const tmp = mkdtempSync(join(tmpdir(), "borrow-lost-"));
const addrFile = join(tmp, "addresses.json");
writeFileSync(addrFile, JSON.stringify(ADDRESSES));
/** A home of its own, for a run whose record of unconfirmed transactions must start empty. */
const freshHome = () => mkdtempSync(join(tmp, "home-"));
/** The CLI as a user runs it; each run has a home of its own (its record of unconfirmed transactions) unless given one. */
function cli(c, args, { agentId = AGENT, home = freshHome(), key = owner.privateKey, explorer = "http://127.0.0.1:9/none", rpc = c.url } = {}) {
  return new Promise((ok) => {
    const env = { PATH: process.env.PATH, HOME: home, PRIORS_KEY: key, PRIORS_RPC: rpc, PRIORS_ADDRESSES: addrFile, PRIORS_EXPLORER_API: explorer, ...(agentId == null ? {} : { PRIORS_AGENT_ID: String(agentId) }) };
    const p = spawn(process.execPath, [join(ROOT, `bin/${CLI}.mjs`), ...args], { cwd: tmp, env });
    let out = "", err = "";
    p.stdout.on("data", (x) => (out += x));
    p.stderr.on("data", (x) => (err += x));
    p.on("close", (code) => ok({ code, out, err }));
  });
}
// where the CLI records a transaction whose answer was lost: one file per transaction, only the user can read it
const recordDir = (home) => join(home, ".local", "state", "priors", "unconfirmed");
const recordPath = (home, hash, who = owner.address) => join(recordDir(home), `${who.toLowerCase()}-${hash}.json`);
const records = (home) => (existsSync(recordDir(home)) ? readdirSync(recordDir(home)).filter((f) => f.endsWith(".json") || f.endsWith(".intent")) : []);
/** A record as the CLI leaves it (directory 0700, file 0600), for a transaction this key signed at `nonce`. */
async function plantRecord(home, nonce, { mode = 0o600, sentBlock = SENT, at = recordPath, data = "0x" } = {}) {
  const raw = await owner.signTransaction({ to: POOL, data, nonce, gasLimit: 21_000n, gasPrice: 1_000_000_000n, chainId: 4663n });
  const hash = ethers.Transaction.from(raw).hash;
  mkdirSync(recordDir(home), { recursive: true, mode: 0o700 });
  const f = at(home, hash);
  writeFileSync(f, JSON.stringify({ address: owner.address, hash, nonce, raw, sentBlock, command: "borrow", at: new Date().toISOString() }), { mode });
  chmodSync(f, mode);
  return hash;
}

await check(`the broadcast's answer is lost: exit 4, the tx hash, a record of its own only the user can read, and \`${CLI} tx\` settles it, then removes it`, () =>
  onChain({ lose: "broadcast" }, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    const h = borrows(c)[0].hash;
    assert.equal(c.loans(), 1);
    assert.equal(borrows(c).length, 1);
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.match(r.err, /a borrow of 5(\.0+)? USDG .*was sent.*may have opened a loan/s);
    assert.ok(r.err.includes(h), `no tx hash in: ${r.err}`);
    assert.match(r.err, /do not run borrow again/);
    assert.match(r.err, new RegExp(`\`${CLI} tx\``));
    assert.ok(r.err.includes(`https://robinhoodchain.blockscout.com/tx/${h}`), `no explorer link in: ${r.err}`);
    assert.match(r.err, /final/);
    assert.doesNotMatch(r.err, /shows no loan|once status|safe to run again/);
    assert.ok(!r.err.includes(owner.privateKey.slice(2)), "the key is never printed");
    const f = recordPath(home, h);
    assert.equal(statSync(f).mode & 0o777, 0o600, "the record: the user's only");
    assert.equal(statSync(recordDir(home)).mode & 0o777, 0o700, "its directory: the user's only");
    const rec = JSON.parse(readFileSync(f, "utf8"));
    assert.deepEqual([rec.hash, rec.nonce, rec.command, ethers.Transaction.from(rec.raw).hash], [h, 0, "borrow", h]);
    assert.equal(typeof rec.sentBlock, "number", "the block it was sent from, to find who used its nonce");
    const t = await cli(c, ["tx"], { home });
    assert.equal(t.code, 0, `tx exit ${t.code}: ${t.err}`);
    assert.match(t.out, new RegExp(`${h}.*mined.*status 1.*it ran.*final`, "s"));
    assert.deepEqual(records(home), [], "removed once final");
  }));

await check(`\`${CLI} join\` whose register answer is lost: exit 4, \`${CLI} tx\`, and no claim that join is safe to run again`, () =>
  onChain({ noIdentity: true, loseRegister: true }, async (c) => {
    const r = await cli(c, ["join"], { agentId: null, home: freshHome() });
    assert.equal(c.sent.filter((s) => s.fn === "register").length, 1);
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.match(r.err, new RegExp(`\`${CLI} tx\``));
    assert.doesNotMatch(r.err, /join is safe/);
    assert.match(r.err, /second identity/);
  }));

console.log(`\`${CLI} tx\` (settles every transaction a lost answer recorded; takes no argument)`);

await check("a recorded transaction mined with status 1: exit 0, final, it ran (do not send it again), record removed", async () => {
  const home = freshHome();
  const h = await plantRecord(home, 4);
  await onChain({ known: { [h]: { nonce: 4, block: 80_000_000, status: 1 } } }, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.match(r.out, /mined.*status 1.*it ran.*final/s);
    assert.deepEqual(records(home), []);
  });
});

await check("a recorded transaction still pending: exit 3, not final, do not send it again, record kept", async () => {
  const home = freshHome();
  const h = await plantRecord(home, 4);
  await onChain({ known: { [h]: { nonce: 4, block: null } }, counts: { latest: 4, pending: 5 } }, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 3, `exit ${r.code}: ${r.err} ${r.out}`);
    assert.match(r.out, /pending.*not final/s);
    assert.equal(records(home).length, 1);
  });
});

await check("unknown to the node, its nonce still free: exit 3, not final, `--resend` offered, nothing called safe", async () => {
  const home = freshHome();
  await plantRecord(home, 4);
  await onChain({ counts: { latest: 4, pending: 4 } }, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 3, `exit ${r.code}: ${r.err}`);
    assert.match(r.out, /not found.*not final/s);
    assert.match(r.out, new RegExp(`${CLI} tx --resend`));
    assert.doesNotMatch(r.out + r.err, /safe/);
  });
});

await check("regression: unknown at the first reads, then in the mempool: exit 3 both times, never 'safe'", async () => {
  const home = freshHome();
  const h = await plantRecord(home, 4);
  await onChain({ counts: { latest: 4, pending: 4 }, appear: { hash: h, nonce: 4, after: 1 } }, async (c) => {
    const first = await cli(c, ["tx"], { home });
    assert.equal(first.code, 3, `exit ${first.code}: ${first.err}`);
    assert.doesNotMatch(first.out + first.err, /safe/);
    const second = await cli(c, ["tx"], { home });
    assert.equal(second.code, 3, `exit ${second.code}: ${second.err}`);
    assert.match(second.out, /pending.*not final/s);
  });
});

await check("regression (receipt lag): the node counts its nonce and shows it mined, no receipt yet: exit 3, never 'safe', record kept", async () => {
  const home = freshHome();
  const h = await plantRecord(home, 4);
  await onChain({ known: { [h]: { nonce: 4, block: K, status: 1, receiptAfter: 99 } }, nonceUsed: { nonce: 4, at: K, by: h } }, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 3, `exit ${r.code}: ${r.err}`);
    assert.doesNotMatch(r.out + r.err, /safe/);
    assert.equal(records(home).length, 1);
  });
});

await check("a different transaction found at its nonce in block K: exit 0, final, it did not run, record removed", async () => {
  const home = freshHome();
  await plantRecord(home, 4);
  await onChain({ nonceUsed: { nonce: 4, at: K, by: OTHER } }, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.match(r.out, new RegExp(`${OTHER}.*did not run.*final`, "s"));
    assert.deepEqual(records(home), []);
  });
});

await check("two unresolved transactions of one key: both listed and kept", async () => {
  const home = freshHome();
  const a = await plantRecord(home, 4), b = await plantRecord(home, 5);
  await onChain({ known: { [a]: { nonce: 4, block: null } }, counts: { latest: 4, pending: 5 } }, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 3, `exit ${r.code}: ${r.err}`);
    assert.ok(r.out.includes(a) && r.out.includes(b), `both listed: ${r.out}`);
    assert.equal(records(home).length, 2);
  });
});

await check(`\`${CLI} borrow\` and \`${CLI} join\` refused while a transaction of this key is unresolved (exit 3, \`${CLI} tx\`), nothing sent`, async () => {
  const home = freshHome();
  const h = await plantRecord(home, 4);
  await onChain({ known: { [h]: { nonce: 4, block: null } }, counts: { latest: 4, pending: 5 } }, async (c) => {
    for (const args of [["borrow", "5"], ["join"]]) {
      const r = await cli(c, args, { home });
      assert.equal(r.code, 3, `${args[0]} exit ${r.code}: ${r.err}`);
      assert.match(r.err, new RegExp(`${h}.*\`${CLI} tx\``, "s"));
    }
    assert.equal(c.sent.length, 0);
  });
});

await check(`\`${CLI} repay\` still runs while one is unresolved (a repay cannot pay twice; a blocked repay could miss a due date), with a note`, async () => {
  const home = freshHome();
  await plantRecord(home, 4);
  await onChain({ counts: { latest: 4, pending: 4 } }, async (c) => {
    const r = await cli(c, ["repay"], { home });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.match(r.out, /no open loan/);
    assert.match(r.err, new RegExp(`unresolved.*\`${CLI} tx\``, "s"));
  });
});

await check("a borrow that never reached the node: `tx` not final, then `tx --resend` sends the same signed transaction (one hash, one loan), it ran, record removed", () =>
  onChain({ loseBeforeNode: true }, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.equal(c.loans(), 0, "the node never got it");
    const [file] = records(home);
    const rec = JSON.parse(readFileSync(join(recordDir(home), file), "utf8"));
    const t = await cli(c, ["tx"], { home });
    assert.equal(t.code, 3, `tx exit ${t.code}: ${t.err}`);
    assert.match(t.out, /not found.*not final/s);
    const s = await cli(c, ["tx", "--resend"], { home });
    assert.equal(s.code, 0, `resend exit ${s.code}: ${s.err} ${s.out}`);
    assert.match(s.out, /it ran/);
    assert.equal(c.loans(), 1, "one loan: the borrow the user signed, once");
    assert.deepEqual([...new Set(borrows(c).map((b) => b.hash))], [rec.hash], "only the recorded transaction was ever sent");
    assert.deepEqual(records(home), []);
  }));

console.log(`\`${CLI}\`: recorded before the broadcast, one command per key at a time, final only when finalized`);

const lockPath = (home, who = owner.address) => join(recordDir(home), `${who.toLowerCase()}.lock`);
/** The CLI as a child the test can kill while it waits on its broadcast. */
function spawnCli(c, args, { home, agentId = AGENT } = {}) {
  const env = { PATH: process.env.PATH, HOME: home, PRIORS_KEY: owner.privateKey, PRIORS_RPC: c.url, PRIORS_ADDRESSES: addrFile, PRIORS_EXPLORER_API: "http://127.0.0.1:9/none", PRIORS_AGENT_ID: String(agentId) };
  const child = spawn(process.execPath, [join(ROOT, `bin/${CLI}.mjs`), ...args], { cwd: tmp, env });
  let out = "", err = "";
  child.stdout.on("data", (x) => (out += x));
  child.stderr.on("data", (x) => (err += x));
  return { child, done: new Promise((ok) => child.on("close", (code, signal) => ok({ code, signal, out, err }))) };
}
/** A pid that no process holds any more. */
const deadPid = () => new Promise((ok) => { const p = spawn(process.execPath, ["-e", ""]); p.on("close", () => ok(p.pid)); });

await check("killed after the record is written, before the node took the borrow: the record stays, borrow is refused (the dead holder's lock recovered), `tx --resend` settles it", () =>
  onChain({ hold: "before-apply" }, async (c) => {
    const home = freshHome();
    const run = spawnCli(c, ["borrow", "5"], { home });
    await c.broadcastSeen;
    run.child.kill("SIGKILL");
    assert.equal((await run.done).signal, "SIGKILL");
    c.releaseHeld();
    assert.equal(records(home).length, 1, "the signed intent was recorded before the broadcast");
    assert.equal(c.loans(), 0);
    const again = await cli(c, ["borrow", "5"], { home });
    assert.equal(again.code, 3, `exit ${again.code}: ${again.err}`);
    assert.match(again.err, /not settled/);
    assert.doesNotMatch(again.err, /running/, "the killed holder's lock is recovered, not mistaken for a live one");
    const t = await cli(c, ["tx", "--resend"], { home });
    assert.equal(t.code, 0, `tx exit ${t.code}: ${t.err} ${t.out}`);
    assert.match(t.out, /it ran/);
    assert.equal(c.loans(), 1);
    assert.deepEqual(records(home), []);
  }));

await check("killed after the node took the borrow, before its answer: the record stays, borrow is refused, `tx` finds it mined and removes it", () =>
  onChain({ hold: "after-apply" }, async (c) => {
    const home = freshHome();
    const run = spawnCli(c, ["borrow", "5"], { home });
    await c.broadcastSeen;
    run.child.kill("SIGKILL");
    await run.done;
    c.releaseHeld();
    assert.equal(records(home).length, 1);
    assert.equal(c.loans(), 1);
    const again = await cli(c, ["borrow", "5"], { home });
    assert.equal(again.code, 3, `exit ${again.code}: ${again.err}`);
    const t = await cli(c, ["tx"], { home });
    assert.equal(t.code, 0, `tx exit ${t.code}: ${t.err}`);
    assert.match(t.out, /mined.*it ran/s);
    assert.deepEqual(records(home), []);
    assert.equal(c.loans(), 1, "one loan");
  }));

await check("two borrows of one key at once: the second is refused while the first holds the key's lock; one borrow sent", () =>
  onChain({ hold: "after-apply" }, async (c) => {
    const home = freshHome();
    const a = spawnCli(c, ["borrow", "5"], { home });
    await c.broadcastSeen;
    const b = await cli(c, ["borrow", "5"], { home });
    assert.equal(b.code, 3, `second exit ${b.code}: ${b.err}`);
    assert.match(b.err, /another .* is running/);
    c.releaseHeld();
    const ra = await a.done;
    assert.equal(ra.code, 0, `first exit ${ra.code}: ${ra.err}`);
    assert.equal(borrows(c).length, 1);
    assert.deepEqual(records(home), []);
    assert.ok(!existsSync(lockPath(home)), "the lock is released");
  }));

await check("a stale lock left by a dead process is recovered: the borrow goes through", async () => {
  const home = freshHome();
  mkdirSync(recordDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath(home), JSON.stringify({ pid: await deadPid(), token: "stale", at: new Date().toISOString() }), { mode: 0o600 });
  await onChain({}, async (c) => {
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.equal(c.loans(), 1);
    assert.ok(!existsSync(lockPath(home)));
  });
});

await check("twelve processes of one key racing for its lock at the same instant: exactly one takes it", async () => {
  const home = freshHome();
  const mod = pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href;
  const at = Date.now() + 1500; // all try at the same instant; whoever took it holds it until every one has answered
  const done = join(home, "all-answered");
  const procs = Array.from({ length: 12 }, () => {
    const code = `const m = await import(${JSON.stringify(mod)}); const { existsSync } = await import("node:fs"); while (Date.now() < ${at}); let r; try { m.lockKey(${JSON.stringify(owner.address)}); r = "took"; } catch (e) { r = e.code; } console.log(r); while (r === "took" && !existsSync(${JSON.stringify(done)})) await new Promise((d) => setTimeout(d, 25));`;
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home } });
    let out = "";
    const answered = new Promise((ok) => {
      p.stdout.on("data", (x) => { out += x; if (out.includes("\n")) ok(out.trim()); });
      p.on("close", () => ok(out.trim())); // one that died before answering fails the check below, never hangs it
    });
    const closed = new Promise((ok) => p.on("close", ok));
    return { answered, closed };
  });
  const got = await Promise.all(procs.map((x) => x.answered));
  writeFileSync(done, "");
  await Promise.all(procs.map((x) => x.closed));
  assert.equal(got.filter((r) => r === "took").length, 1, `took: ${got.join(", ")}`);
  assert.ok(got.every((r) => r === "took" || r === "LOCK_HELD"), got.join(", "));
});

// The stale-lock recovery race both reviewers traced (round 7), forced through node:fs, which sdk/tx-record.mjs
// imports (no timing): A reads the dead holder X; before A moves X aside, B recovers X and takes the lock; A then moves
// B's fresh lock aside instead, and before A can put it back, C links its own into the gap; A's restore fails. B and C
// both come out of lockKey holding a lock. Only a check right before the broadcast can stop the second one.
async function forcedLockRace(home) {
  const env = { HOME: home };
  const rec = await import(pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href);
  mkdirSync(recordDir(home), { recursive: true, mode: 0o700 });
  const file = lockPath(home);
  writeFileSync(file, JSON.stringify({ pid: await deadPid(), token: "dead", at: new Date().toISOString() }), { mode: 0o600 });
  const realRename = fs.renameSync, realLink = fs.linkSync;
  let step = 0, B = null, C = null, aErr = null;
  fs.renameSync = (from, to) => {
    if (from === file && step === 0) { step = 1; B = rec.lockKey(owner.address, env); } // A has read X; B goes first
    return realRename(from, to);
  };
  fs.linkSync = (from, to) => {
    if (to === file && basename(from).startsWith(".stale-") && step === 1) { step = 2; C = rec.lockKey(owner.address, env); } // A's restore: C first
    return realLink(from, to);
  };
  syncBuiltinESMExports();
  try {
    rec.lockKey(owner.address, env);
  } catch (e) {
    aErr = e;
  } finally {
    fs.renameSync = realRename;
    fs.linkSync = realLink;
    syncBuiltinESMExports();
  }
  assert.equal(step, 2, "the A/B/C interleaving was forced");
  assert.ok(B && C, "B and C both came out of lockKey with a lock");
  assert.equal(aErr?.code, "LOCK_HELD", "A finds C's lock held");
  // each contender's journal, as the CLI builds it: the record before the broadcast, and the lock checked after it
  const journal = (lock) => rec.keyJournal
    ? rec.keyJournal(owner.address, () => lock.held(), "borrow", env)
    : { before: (t) => rec.saveUnconfirmed(owner.address, { hash: t.hash, nonce: t.nonce, raw: t.raw, sentBlock: t.sentBlock ?? null, command: "borrow" }, env), settled: (h) => rec.removeUnconfirmed(owner.address, h, env) };
  return { rec, env, B, C, journalB: journal(B), journalC: journal(C) };
}
const settle = (p) => p.then((ok) => ({ ok }), (e) => ({ e }));

await check("stale-lock race, forced (A reads the dead holder, B takes the lock, A moves B's aside, C links into the gap): the loser (B) sends nothing and keeps no record; one broadcast", async () => {
  const home = freshHome();
  const { rec, env, journalB, journalC } = await forcedLockRace(home);
  await onChain({}, async (c) => {
    // step 2, after taking the lock: neither sees a record
    assert.deepEqual(rec.listUnconfirmed(owner.address, env), []);
    const mk = (journal) => new PriorsV2({ signer: owner.connect(c.provider), addresses: ADDRESSES, journal });
    const b = await settle(mk(journalB).borrow(AGENT, 5, 7 * 86400));
    const cc = await settle(mk(journalC).borrow(AGENT, 6, 7 * 86400));
    assert.ok(borrows(c).length <= 1, `${borrows(c).length} borrows broadcast`);
    assert.equal(b.e?.code, "LOCK_LOST", `B: ${b.e ? `${b.e.code} ${b.e.message}` : "sent"}`);
    assert.equal(cc.ok?.loanId, 1, `C: ${cc.e?.message}`);
    assert.equal(borrows(c).length, 1);
    assert.deepEqual(records(home), [], "B's record removed, C's settled");
  });
});

await check("stale-lock race, forced, then both send the very same signed borrow at once: at most one broadcast, no record left behind", async () => {
  const home = freshHome();
  const { journalB, journalC } = await forcedLockRace(home);
  await onChain({}, async (c) => {
    const mk = (journal) => new PriorsV2({ signer: owner.connect(c.provider), addresses: ADDRESSES, journal });
    const [b, cc] = await Promise.all([settle(mk(journalB).borrow(AGENT, 5, 7 * 86400)), settle(mk(journalC).borrow(AGENT, 5, 7 * 86400))]);
    assert.ok(borrows(c).length <= 1, `${borrows(c).length} borrows broadcast`);
    for (const r of [b, cc]) if (r.e) assert.ok(["LOCK_LOST", "ALREADY_RECORDED"].includes(r.e.code), `${r.e.code}: ${r.e.message}`);
    assert.deepEqual(records(home), []);
  });
});

await check("the order before a broadcast: the record is on disk when the lock is checked (a command that takes the lock after that check finds it, and refuses)", async () => {
  const home = freshHome();
  const env = { HOME: home };
  const rec = await import(pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href);
  assert.equal(typeof rec.keyJournal, "function", "sdk/tx-record.mjs has keyJournal (the CLI's journal)");
  const lock = rec.lockKey(owner.address, env);
  let atCheck = null;
  const journal = rec.keyJournal(owner.address, () => { atCheck = rec.listUnconfirmed(owner.address, env).map((r) => r.hash); return lock.held(); }, "borrow", env);
  await onChain({}, async (c) => {
    const r = await new PriorsV2({ signer: owner.connect(c.provider), addresses: ADDRESSES, journal }).borrow(AGENT, 5, 7 * 86400);
    assert.deepEqual(atCheck, [r.hash], "recorded before the check, and the check before the broadcast");
    assert.deepEqual(records(home), [], "settled once its receipt was read");
  });
  lock.release();
  assert.ok(!existsSync(lockPath(home)));
});

await check("`borrow` whose lock is taken over while it prepares (before it signs): nothing sent, no record of its own, the other's lock left alone, exit 3", () =>
  onChain({ holdCall: "eth_estimateGas" }, async (c) => {
    const home = freshHome();
    const run = spawnCli(c, ["borrow", "5"], { home });
    await c.callSeen;
    rmSync(lockPath(home)); // another command holds the path now, as after the race above
    writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid, token: "other", at: new Date().toISOString() }), { mode: 0o600 });
    c.releaseHeld();
    const r = await run.done;
    assert.equal(r.code, 3, `exit ${r.code}: ${r.err}`);
    assert.match(r.err, /another command .* is running/);
    assert.equal(c.sent.length, 0, "nothing broadcast");
    assert.deepEqual(records(home), []);
    assert.equal(JSON.parse(readFileSync(lockPath(home), "utf8")).token, "other");
  }));

await check("`tx --resend` whose lock is taken over before the resend: nothing sent, the record kept, exit 3", async () => {
  const home = freshHome();
  await plantRecord(home, 4, { data: BORROW_DATA });
  await onChain({ counts: { latest: 4, pending: 4 }, holdCall: "eth_getTransactionByHash" }, async (c) => {
    const run = spawnCli(c, ["tx", "--resend"], { home });
    await c.callSeen;
    rmSync(lockPath(home));
    writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid, token: "other", at: new Date().toISOString() }), { mode: 0o600 });
    c.releaseHeld();
    const r = await run.done;
    assert.equal(r.code, 3, `exit ${r.code}: ${r.err} ${r.out}`);
    assert.match(r.out + r.err, /another command .* is running/);
    assert.ok(!c.bodies.some((b) => b.includes("eth_sendRawTransaction")), "nothing broadcast");
    assert.equal(records(home).length, 1);
  });
});

await check("a normal successful borrow leaves no record and no lock", () =>
  onChain({}, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.deepEqual(records(home), []);
    assert.ok(!existsSync(lockPath(home)));
  }));

await check("a borrow mined with status 0: exit 1, its record kept until `tx` finds it reverted on a finalized block (then removed, and only then 'safe')", () =>
  onChain({ minedRevert: true }, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 1, `exit ${r.code}: ${r.err}`);
    assert.equal(records(home).length, 1, "a status 0 receipt is not final before its block is");
    const t = await cli(c, ["tx"], { home });
    assert.equal(t.code, 0, `tx exit ${t.code}: ${t.err}`);
    assert.match(t.out, /reverted.*final.*safe/s);
    assert.deepEqual(records(home), []);
  }));

await check("regression (speed-up): `tx` on a borrow whose fee-bumped copy succeeded: exit 0, it ran, never 'safe to run again', record removed", async () => {
  const home = freshHome();
  await plantRecord(home, 4, { data: BORROW_DATA });
  await onChain({ nonceUsed: { nonce: 4, at: K, by: OTHER, like: RAW }, known: { [OTHER]: { nonce: 4, block: K, status: 1, to: POOL, input: BORROW_DATA } } }, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.match(r.out, /it ran/);
    assert.doesNotMatch(r.out + r.err, /safe/);
    assert.deepEqual(records(home), []);
  });
});

await check("finality: `tx` on a status-0 receipt above the finalized block: exit 3, waiting for finality, record kept, nothing called safe", async () => {
  const home = freshHome();
  const h = await plantRecord(home, 4);
  await onChain({ known: { [h]: { nonce: 4, block: 80_000_000, status: 0 } }, finalized: 80_000_000 - 100 }, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 3, `exit ${r.code}: ${r.err}`);
    assert.match(r.out, /waiting for finality/);
    assert.doesNotMatch(r.out + r.err, /safe/);
    assert.equal(records(home).length, 1);
  });
});

/** A Blockscout-like explorer: `answer(url)` gives [status, body]. */
function explorerServer(answer) {
  const server = createServer((req, res) => { const [status, body, type] = answer(req.url); res.writeHead(status, { "content-type": type || "application/json" }); res.end(body); });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}/api`, close: () => { server.closeAllConnections(); server.close(); } })));
}
const txlist = (rows) => [200, JSON.stringify({ status: "1", message: "OK", result: rows })];

await check("explorer via the CLI: honest (verified on the RPC) removes the record; lying or unavailable keeps it (exit 3)", async () => {
  const LIE = "0x" + "ee".repeat(32);
  const cases = [
    ["honest", txlist([{ hash: OTHER, nonce: "4", from: owner.address.toLowerCase(), blockNumber: String(K) }]), 0],
    ["lying", txlist([{ hash: LIE, nonce: "4", from: owner.address.toLowerCase(), blockNumber: String(K) }]), 3],
    ["unavailable", [403, "<!DOCTYPE html><title>Just a moment...</title>", "text/html"], 3],
  ];
  for (const [name, answer, want] of cases) {
    const home = freshHome();
    await plantRecord(home, 4);
    const ex = await explorerServer(() => answer);
    try {
      await onChain({ nonceUsed: { nonce: 4, at: K, by: OTHER, servableFrom: 80_000_000 - 5 }, known: { [OTHER]: { nonce: 4, block: K, status: 1, to: owner.address }, [LIE]: { nonce: 9, block: K, status: 1, to: owner.address } } }, async (c) => {
        const r = await cli(c, ["tx"], { home, explorer: ex.url });
        assert.equal(r.code, want, `${name}: exit ${r.code}: ${r.err} ${r.out}`);
        assert.equal(records(home).length, want === 0 ? 0 : 1, `${name}: record`);
      });
    } finally {
      ex.close();
    }
  }
});

await check("`tx --forget` refused while its nonce is free (exit 3, points at --resend and a wallet cancel), record kept", async () => {
  const home = freshHome();
  await plantRecord(home, 4);
  await onChain({ counts: { latest: 4, pending: 4 } }, async (c) => {
    const r = await cli(c, ["tx", "--forget"], { home });
    assert.equal(r.code, 3, `exit ${r.code}: ${r.err}`);
    assert.match(r.out + r.err, /free/);
    assert.match(r.out + r.err, /--resend/);
    assert.equal(records(home).length, 1);
  });
});

await check("`tx --forget` allowed once its nonce is used at the finalized block (history otherwise unservable): shows the loans and the explorer link, removes the record", async () => {
  const home = freshHome();
  const h = await plantRecord(home, 4);
  await onChain({ nonceUsed: { nonce: 4, at: K, by: OTHER, servableFrom: K + 20 }, finalized: K + 30 }, async (c) => {
    const plain = await cli(c, ["tx"], { home });
    assert.equal(plain.code, 3, `plain tx exit ${plain.code}: ${plain.err}`);
    const r = await cli(c, ["tx", "--forget"], { home });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err} ${r.out}`);
    assert.match(r.out, /no open loan/);
    assert.ok(r.out.includes(`https://robinhoodchain.blockscout.com/tx/${h}`));
    assert.match(r.out + r.err, /forgot/i);
    assert.deepEqual(records(home), []);
  });
});

await check("`tx --forget` when the node cannot serve the finalized block's state: it records where the nonce was seen used, refuses until that block is finalized, then forgets", async () => {
  const home = freshHome();
  await plantRecord(home, 4);
  await onChain({ nonceUsed: { nonce: 4, at: K, by: OTHER }, stateWindow: 5, finalized: 80_000_000 - 10 }, async (c) => {
    const first = await cli(c, ["tx", "--forget"], { home });
    assert.equal(first.code, 3, `first exit ${first.code}: ${first.err} ${first.out}`);
    assert.match(first.out + first.err, /finalized/);
    assert.equal(records(home).length, 1);
    c.advance(20);
    c.setFinalized(80_000_000); // the block where it was seen used is final now; its state is long gone
    const second = await cli(c, ["tx", "--forget"], { home });
    assert.equal(second.code, 0, `second exit ${second.code}: ${second.err} ${second.out}`);
    assert.deepEqual(records(home), []);
  });
});

console.log(`\`${CLI}\`: one broadcast request; an unsent intent, then a sending record (round 9)`);

await check("regression (round 9): the node took the borrow, then answered \"insufficient funds\": exit 0, one loan, no record", () =>
  onChain({ takeThenRefuse: "insufficient funds for gas * price + value" }, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.equal(c.loans(), 1);
    assert.deepEqual(records(home), []);
  }));

await check("regression (round 9): a 429 on the broadcast: exactly one eth_sendRawTransaction reaches the node, exit 4, the record kept", () =>
  onChain({ rateLimitSend: 1 }, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(sendRaws(c), 1, `${sendRaws(c)} broadcast requests`);
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.equal(records(home).length, 1);
    assert.equal(c.loans(), 0);
  }));

if (CLI === "priors-v2") {
  await check("regression (round 9): two RPC endpoints (PRIORS_RPC list): a send error on the first is never sent again, to the first or to the second", async () => {
    const c1 = await chain({ rateLimitSend: 1 }), c2 = await chain({});
    try {
      const home = freshHome();
      const r = await cli(c1, ["borrow", "5"], { home, rpc: `${c1.url},${c2.url}` });
      assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
      assert.deepEqual([sendRaws(c1), sendRaws(c2)], [1, 0]);
      assert.equal(records(home).length, 1);
    } finally {
      c1.close();
      c2.close();
    }
  });
} else {
  console.log("  --   two RPC endpoints through the CLI: this CLI takes one endpoint (the SDK check above covers two)");
}

// B, a borrow in a process of its own, whose lock check runs C, a real `tx --resend`, to completion in the gap the
// reviewers traced (the record written, the lock check not decided yet, or decided and not acted on): B blocks in
// spawnSync while this process's stub node answers C. The stale-lock race is what hands the name to C.
async function intentGap(when) {
  const home = freshHome();
  return onChain({}, async (c) => {
    const cEnv = { PATH: process.env.PATH, HOME: home, PRIORS_KEY: owner.privateKey, PRIORS_RPC: c.url, PRIORS_ADDRESSES: addrFile, PRIORS_EXPLORER_API: "http://127.0.0.1:9/none", PRIORS_AGENT_ID: String(AGENT) };
    const cfg = { when, home, url: c.url, key: owner.privateKey, addr: owner.address, addresses: ADDRESSES, lockFile: lockPath(home), cli: join(ROOT, `bin/${CLI}.mjs`), cwd: tmp, cEnv,
      sdk: pathToFileURL(join(ROOT, "sdk/priors-v2.mjs")).href, rec: pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href };
    const code = `const cfg = ${JSON.stringify(cfg)};
      const { ethers } = await import("ethers"); const { PriorsV2 } = await import(cfg.sdk); const rec = await import(cfg.rec);
      const { spawnSync } = await import("node:child_process"); const { rmSync } = await import("node:fs");
      const env = { HOME: cfg.home };
      const lockB = rec.lockKey(cfg.addr, env);
      let cRun = null;
      const runC = () => { rmSync(cfg.lockFile, { force: true }); const r = spawnSync(process.execPath, [cfg.cli, "tx", "--resend"], { cwd: cfg.cwd, env: cfg.cEnv, encoding: "utf8", timeout: 60000 }); cRun = { code: r.status, out: r.stdout, err: r.stderr }; };
      const held = () => {
        if (cfg.when === "before-check") { runC(); return lockB.held(); } // C first, then B's check (it fails)
        if (cfg.when === "after-failed-check") { rmSync(cfg.lockFile); const r = lockB.held(); runC(); return r; } // B's check fails, C runs before B acts on it
        const r = lockB.held(); runC(); return r; // "after-passed-check": B's check passes, then C takes the name
      };
      const provider = new ethers.JsonRpcProvider(cfg.url, 4663, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
      const p = new PriorsV2({ signer: new ethers.Wallet(cfg.key, provider), addresses: cfg.addresses, journal: rec.keyJournal(cfg.addr, held, "borrow", env) });
      let b;
      try { b = { ok: (await p.borrow(${AGENT}n, 5, 7 * 86400)).loanId }; } catch (e) { b = { code: e.code, message: e.message }; }
      console.log(JSON.stringify({ b, c: cRun }));
      process.exit(0);`;
    const out = await new Promise((ok) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home } });
      let o = "", e = "";
      child.stdout.on("data", (x) => (o += x));
      child.stderr.on("data", (x) => (e += x));
      child.on("close", () => ok({ o, e }));
    });
    let res;
    try { res = JSON.parse(out.o.trim().split("\n").pop()); } catch (_) { assert.fail(`B printed no result: ${out.o} ${out.e}`); }
    assert.ok(res.c, "C ran in the gap");
    assert.equal(sendRaws(c), 0, `bytes B never sent were broadcast ${sendRaws(c)} time(s) (C: exit ${res.c.code} ${res.c.out})`);
    assert.equal(res.b.code, "LOCK_LOST", `B: ${JSON.stringify(res.b)}`);
    assert.deepEqual(records(home), [], "no record left: those bytes were never sent");
    assert.equal(c.loans(), 0);
  });
}
await check("regression (round 9): C's `tx --resend` runs after B recorded its borrow and before B's lock check (which then fails): C sends nothing for an unsent intent, B sends nothing", () => intentGap("before-check"));
await check("regression (round 9): C's `tx --resend` runs after B's lock check failed and before B removes its record: C sends nothing, B sends nothing", () => intentGap("after-failed-check"));
await check("regression (round 9): B's lock check passed, then C takes the lock and runs `tx --resend` before B marks its record sending: C sends nothing, B sends nothing", () => intentGap("after-passed-check"));

/** A command of this key killed inside its journal: right after recording its intent ("intent"), or right after
 *  marking it sending ("sending"), before any answer. */
async function killedInJournal(home, at) {
  const mod = pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href;
  const raw = await owner.signTransaction({ to: POOL, data: BORROW_DATA, nonce: 0, gasLimit: 300_000n, gasPrice: 1_000_000_000n, chainId: 4663n });
  const hash = ethers.Transaction.from(raw).hash;
  const code = `const m = await import(${JSON.stringify(mod)}); const env = { HOME: ${JSON.stringify(home)} }; const lock = m.lockKey(${JSON.stringify(owner.address)}, env);
    const j = m.keyJournal(${JSON.stringify(owner.address)}, () => { if (${JSON.stringify(at)} === "intent") process.kill(process.pid, "SIGKILL"); return lock.held(); }, "borrow", env);
    await j.before({ name: "borrow", hash: ${JSON.stringify(hash)}, nonce: 0, raw: ${JSON.stringify(raw)}, sentBlock: ${BLOCK} });
    process.kill(process.pid, "SIGKILL");`;
  await new Promise((ok) => spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home } }).on("close", ok));
  return hash;
}

await check("regression (round 9): killed after recording its intent, before marking it sending: borrow refused until `tx` drops it (never sent), then borrow goes through", async () => {
  const home = freshHome();
  await killedInJournal(home, "intent");
  assert.equal(records(home).length, 1, "the intent was recorded");
  await onChain({}, async (c) => {
    const refused = await cli(c, ["borrow", "5"], { home });
    assert.equal(refused.code, 3, `borrow: exit ${refused.code}: ${refused.err}`);
    const t = await cli(c, ["tx", "--resend"], { home });
    assert.equal(t.code, 0, `tx: exit ${t.code}: ${t.err} ${t.out}`);
    assert.match(t.out, /never sent/);
    assert.equal(sendRaws(c), 0, "an intent is never resent");
    assert.deepEqual(records(home), []);
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 0, `borrow: exit ${r.code}: ${r.err}`);
    assert.equal(c.loans(), 1);
  });
});

await check("regression (round 9): killed after marking it sending: kept, borrow refused, `tx` does not drop it", async () => {
  const home = freshHome();
  await killedInJournal(home, "sending");
  await onChain({}, async (c) => {
    const refused = await cli(c, ["borrow", "5"], { home });
    assert.equal(refused.code, 3, `borrow: exit ${refused.code}: ${refused.err}`);
    const t = await cli(c, ["tx"], { home });
    assert.equal(t.code, 3, `tx: exit ${t.code}: ${t.err} ${t.out}`);
    assert.equal(records(home).length, 1);
    assert.equal(c.loans(), 0);
  });
});

console.log(`\`${CLI}\`: no redirect followed; \`tx --resend\` sends once; a record claimed by rename (round 10)`);

await check("regression (round 10): `borrow` gets a 307 from the endpoint that took its bytes: one request to it, none to the target, exit 4, the record stays sending", async () => {
  const c2 = await chain({ refuseSend: "insufficient funds for gas * price + value" });
  const c1 = await chain({ redirectSend: { to: c2.url, take: true }, sentReceiptAfter: 99 });
  try {
    const home = freshHome();
    const r = await cli(c1, ["borrow", "5"], { home });
    assert.deepEqual([sendRaws(c1), sendRaws(c2)], [1, 0]);
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.equal(records(home).filter((f) => f.endsWith(".json")).length, 1, "kept, as sending");
  } finally {
    c1.close();
    c2.close();
  }
});

for (const [what, opts] of [["a 429", { rateLimitSend: 1 }], ["a 307", "redirect"]]) {
  await check(`regression (round 10): \`tx --resend\` gets ${what}: exactly one request, the record kept`, async () => {
    const home = freshHome();
    await plantRecord(home, 0, { data: BORROW_DATA });
    const c2 = await chain({});
    const c1 = await chain(opts === "redirect" ? { redirectSend: { to: c2.url } } : opts);
    try {
      const r = await cli(c1, ["tx", "--resend"], { home });
      assert.equal(sendRaws(c1), 1, `${sendRaws(c1)} requests`);
      assert.equal(sendRaws(c2), 0);
      assert.equal(r.code, 3, `exit ${r.code}: ${r.err} ${r.out}`);
      assert.equal(records(home).length, 1);
      assert.equal(c1.loans() + c2.loans(), 0);
    } finally {
      c1.close();
      c2.close();
    }
  });
}

/** B, a borrow in a process of its own whose broadcast is refused ("insufficient funds", its hash unknown); on the
 *  lock check B makes while settling that refusal, the lock passes to C, a real `tx --resend`, which runs to completion
 *  in the gap (after B's check resolved, before B acts on the record). */
async function refusalGap(c, home) {
  const cEnv = { PATH: process.env.PATH, HOME: home, PRIORS_KEY: owner.privateKey, PRIORS_RPC: c.url, PRIORS_ADDRESSES: addrFile, PRIORS_EXPLORER_API: "http://127.0.0.1:9/none", PRIORS_AGENT_ID: String(AGENT) };
  const cfg = { home, url: c.url, key: owner.privateKey, addr: owner.address, addresses: ADDRESSES, lockFile: lockPath(home), cli: join(ROOT, `bin/${CLI}.mjs`), cwd: tmp, cEnv,
    sdk: pathToFileURL(join(ROOT, "sdk/priors-v2.mjs")).href, rec: pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href };
  const code = `const cfg = ${JSON.stringify(cfg)};
    const { ethers } = await import("ethers"); const { PriorsV2 } = await import(cfg.sdk); const rec = await import(cfg.rec);
    const { spawnSync } = await import("node:child_process"); const { rmSync } = await import("node:fs");
    const env = { HOME: cfg.home };
    const lockB = rec.lockKey(cfg.addr, env);
    let calls = 0, cRun = null;
    const held = () => {
      const r = lockB.held();
      if (++calls === 2) { rmSync(cfg.lockFile, { force: true }); const x = spawnSync(process.execPath, [cfg.cli, "tx", "--resend"], { cwd: cfg.cwd, env: cfg.cEnv, encoding: "utf8", timeout: 60000 }); cRun = { code: x.status, out: x.stdout, err: x.stderr }; }
      return r;
    };
    const provider = new ethers.JsonRpcProvider(cfg.url, 4663, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
    const p = new PriorsV2({ signer: new ethers.Wallet(cfg.key, provider), addresses: cfg.addresses, journal: rec.keyJournal(cfg.addr, held, "borrow", env) });
    let b;
    try { b = { ok: (await p.borrow(${AGENT}n, 5, 7 * 86400)).loanId }; } catch (e) { b = { code: e.code, message: e.message }; }
    console.log(JSON.stringify({ b, c: cRun, calls }));
    process.exit(0);`;
  const out = await new Promise((ok) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home } });
    let o = "", e = "";
    child.stdout.on("data", (x) => (o += x));
    child.stderr.on("data", (x) => (e += x));
    child.on("close", () => ok({ o, e }));
  });
  try { return JSON.parse(out.o.trim().split("\n").pop()); } catch (_) { assert.fail(`B printed no result: ${out.o} ${out.e}`); }
}

await check("regression (round 10): B's broadcast is refused; after B's lock check resolves the lock passes to C's `tx --resend`, which claims the record first and resends: B then sends nothing, deletes nothing, ends unconfirmed (exit 4)", () =>
  onChain({ refuseFirstSend: "insufficient funds for gas * price + value" }, async (c) => {
    const home = freshHome();
    const res = await refusalGap(c, home);
    assert.ok(res.c, `C ran in the gap (lock checks: ${res.calls})`);
    assert.match(res.c.out, /sent the same signed transaction again/, `C: exit ${res.c.code}: ${res.c.out} ${res.c.err}`);
    assert.equal(res.b.code, "BORROW_UNCONFIRMED", `B: ${JSON.stringify(res.b)}`);
    assert.equal(c.loans(), 1, "C's resend landed, once");
    assert.equal(sendRaws(c), 2, "B's refused broadcast and C's resend, nothing else");
  }));

await check("regression (round 10): B's broadcast is refused; after B's lock check resolves, C's `tx --resend` claims the record and is mid-broadcast when B settles: B sends nothing, deletes nothing, ends unconfirmed; C's resend completes", () =>
  onChain({ refuseFirstSend: "insufficient funds for gas * price + value", holdSendAt: 2 }, async (c) => {
    const home = freshHome();
    const dir = recordDir(home), marker = join(home, "b-checked");
    const cfg = { home, dir, marker, url: c.url, key: owner.privateKey, addr: owner.address, addresses: ADDRESSES, lockFile: lockPath(home),
      sdk: pathToFileURL(join(ROOT, "sdk/priors-v2.mjs")).href, rec: pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href };
    const code = `const cfg = ${JSON.stringify(cfg)};
      const { ethers } = await import("ethers"); const { PriorsV2 } = await import(cfg.sdk); const rec = await import(cfg.rec);
      const { rmSync, writeFileSync, readdirSync } = await import("node:fs");
      const env = { HOME: cfg.home };
      const lockB = rec.lockKey(cfg.addr, env);
      let calls = 0;
      const held = async () => {
        const r = lockB.held();
        if (++calls === 2) { // B's check resolved; the lock passes to C, and B waits until C has claimed the record
          rmSync(cfg.lockFile, { force: true });
          writeFileSync(cfg.marker, "");
          for (let i = 0; i < 300 && !readdirSync(cfg.dir).some((f) => f.includes(".resending-")); i++) await new Promise((d) => setTimeout(d, 50));
        }
        return r;
      };
      const provider = new ethers.JsonRpcProvider(cfg.url, 4663, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
      const p = new PriorsV2({ signer: new ethers.Wallet(cfg.key, provider), addresses: cfg.addresses, journal: rec.keyJournal(cfg.addr, held, "borrow", env) });
      let b;
      try { b = { ok: (await p.borrow(${AGENT}n, 5, 7 * 86400)).loanId }; } catch (e) { b = { code: e.code, message: e.message }; }
      console.log(JSON.stringify({ b, calls }));
      process.exit(0);`;
    let bOut = "";
    const b = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home } });
    b.stdout.on("data", (x) => (bOut += x));
    const bDone = new Promise((ok) => b.on("close", ok));
    for (let i = 0; i < 600 && !existsSync(marker); i++) await new Promise((d) => setTimeout(d, 25));
    assert.ok(existsSync(marker), "B reached its settlement");
    const cRun = spawnCli(c, ["tx", "--resend"], { home }); // C: takes the lock, claims the record, its resend is held
    await c.broadcastSeen;
    await bDone; // B settles while C holds the claim
    const res = JSON.parse(bOut.trim().split("\n").pop());
    assert.equal(res.b.code, "BORROW_UNCONFIRMED", `B: ${JSON.stringify(res.b)}`);
    assert.equal(readdirSync(recordDir(home)).filter((f) => f.includes(".resending-")).length, 1, "C's claim untouched by B");
    c.releaseHeld();
    const rc = await cRun.done;
    assert.match(rc.out, /sent the same signed transaction again/, `C: exit ${rc.code}: ${rc.out} ${rc.err}`);
    assert.equal(c.loans(), 1);
    assert.equal(sendRaws(c), 2, "B's refused broadcast and C's resend, nothing else");
  }));

await check("guard (round 10): B's broadcast is refused and B claims the record first: B exit 1, nothing left, and a later `tx --resend` finds nothing to send", () =>
  onChain({ refuseSend: "insufficient funds for gas * price + value" }, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 1, `exit ${r.code}: ${r.err}`);
    assert.deepEqual(records(home), []);
    const t = await cli(c, ["tx", "--resend"], { home });
    assert.equal(t.code, 0, `tx: exit ${t.code}: ${t.err} ${t.out}`);
    assert.equal(sendRaws(c), 1, "only B's own broadcast");
  }));

await check("regression (round 10): a crash while resending (a claimed record left by a dead process) is treated as sending: borrow refused, `tx` keeps it, `tx --resend` settles it", async () => {
  const home = freshHome();
  const dead = await deadPid();
  await plantRecord(home, 0, { data: BORROW_DATA, at: (h, hash) => join(recordDir(h), `${owner.address.toLowerCase()}-${hash}.resending-${dead}-abcdef`) });
  await onChain({}, async (c) => {
    const refused = await cli(c, ["borrow", "5"], { home });
    assert.equal(refused.code, 3, `borrow: exit ${refused.code}: ${refused.err}`);
    const t = await cli(c, ["tx"], { home });
    assert.equal(t.code, 3, `tx: exit ${t.code}: ${t.err} ${t.out}`);
    assert.equal(records(home).length + readdirSync(recordDir(home)).filter((f) => f.includes(".resending-")).length, 1, "kept");
    const s2 = await cli(c, ["tx", "--resend"], { home });
    assert.equal(s2.code, 0, `resend: exit ${s2.code}: ${s2.err} ${s2.out}`);
    assert.equal(c.loans(), 1);
    assert.deepEqual(readdirSync(recordDir(home)).filter((f) => f.endsWith(".json") || f.endsWith(".intent") || f.includes(".resending-")), []);
  });
});

console.log(`\`${CLI}\`: an owner is its pid and its start time; tombstones swept (round 11)`);

/** A live process unrelated to this key: its pid, as a crashed owner's pid reused. */
function sleeper() {
  const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"]);
  return { pid: p.pid, stop: () => p.kill("SIGKILL") };
}
const recMod = () => import(pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href);

await check("regression (round 11): a stale lock whose pid now belongs to an unrelated live process (another start time): recovered, the borrow goes through", async () => {
  const home = freshHome();
  const z = sleeper();
  try {
    mkdirSync(recordDir(home), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath(home), JSON.stringify({ pid: z.pid, token: "stale", at: new Date().toISOString(), birth: "deadbeef" }), { mode: 0o600 });
    await onChain({}, async (c) => {
      const r = await cli(c, ["borrow", "5"], { home });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
      assert.equal(c.loans(), 1);
    });
  } finally {
    z.stop();
  }
});

await check("regression (round 11): a resend claim left by a crash whose pid now belongs to an unrelated live process: still sending (borrow refused), and `tx --resend` reclaims and settles it", async () => {
  const home = freshHome();
  const z = sleeper();
  try {
    await plantRecord(home, 0, { data: BORROW_DATA, at: (h, hash) => join(recordDir(h), `${owner.address.toLowerCase()}-${hash}.resending-${z.pid}-deadbeef-abcdef`) });
    await onChain({}, async (c) => {
      const refused = await cli(c, ["borrow", "5"], { home });
      assert.equal(refused.code, 3, `borrow: exit ${refused.code}: ${refused.err}`);
      const t = await cli(c, ["tx", "--resend"], { home });
      assert.equal(t.code, 0, `tx: exit ${t.code}: ${t.err} ${t.out}`);
      assert.equal(c.loans(), 1);
      assert.deepEqual(readdirSync(recordDir(home)).filter((f) => f.includes("0x") && !f.endsWith(".lock")), []);
    });
  } finally {
    z.stop();
  }
});

await check("guard (round 11): a resend claim held by a live process with its own start time is left alone: `tx --resend` sends nothing", async () => {
  const home = freshHome();
  const z = sleeper();
  try {
    const { birthTag } = await recMod();
    assert.equal(typeof birthTag, "function", "sdk/tx-record.mjs exports birthTag");
    const tag = birthTag(z.pid) || "00000000";
    await plantRecord(home, 0, { data: BORROW_DATA, at: (h, hash) => join(recordDir(h), `${owner.address.toLowerCase()}-${hash}.resending-${z.pid}-${tag}-abcdef`) });
    await onChain({}, async (c) => {
      const t = await cli(c, ["tx", "--resend"], { home });
      assert.equal(t.code, 3, `tx: exit ${t.code}: ${t.err} ${t.out}`);
      assert.equal(sendRaws(c), 0);
      assert.equal(readdirSync(recordDir(home)).filter((f) => f.includes(".resending-")).length, 1);
    });
  } finally {
    z.stop();
  }
});

await check("guard (round 11): an unsent intent whose writer's pid now belongs to an unrelated live process: `tx` drops it", async () => {
  const home = freshHome();
  const z = sleeper();
  try {
    const hash = await plantRecord(home, 0, { data: BORROW_DATA, at: (h, x) => join(recordDir(h), `${owner.address.toLowerCase()}-${x}.intent`) });
    const f = join(recordDir(home), `${owner.address.toLowerCase()}-${hash}.intent`);
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), writer: z.pid, writerBirth: "deadbeef", lockToken: "gone" }));
    await onChain({}, async (c) => {
      const t = await cli(c, ["tx"], { home });
      assert.equal(t.code, 0, `tx: exit ${t.code}: ${t.err} ${t.out}`);
      assert.match(t.out, /never sent/);
      assert.deepEqual(records(home), []);
    });
  } finally {
    z.stop();
  }
});

await check("regression (round 11): `tx` sweeps tombstones whose owner is gone (dead, or its pid reused), and leaves a live owner's", async () => {
  const home = freshHome();
  const z = sleeper();
  try {
    const { birthTag } = await recMod();
    const dir = recordDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dead = await deadPid();
    const live = `.tomb-${z.pid}-${(typeof birthTag === "function" && birthTag(z.pid)) || "00000000"}-cccccc`;
    for (const n of [`.tomb-${dead}-00000000-aaaaaa`, `.tomb-${z.pid}-deadbeef-bbbbbb`, live]) writeFileSync(join(dir, n), "{}", { mode: 0o600 });
    await onChain({}, async (c) => {
      const t = await cli(c, ["tx"], { home });
      assert.equal(t.code, 0, `tx: exit ${t.code}: ${t.err} ${t.out}`);
      assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".tomb-")), [live]);
    });
  } finally {
    z.stop();
  }
});

await check("regression (round 13): `borrow` whose receipt request is never answered: exit 4 within PRIORS_WAIT_SECONDS, the record kept, the lock released (the next command takes it)", () =>
  onChain({ stallReceipts: true }, async (c) => {
    const home = freshHome();
    const env = { PATH: process.env.PATH, HOME: home, PRIORS_KEY: owner.privateKey, PRIORS_RPC: c.url, PRIORS_ADDRESSES: addrFile, PRIORS_EXPLORER_API: "http://127.0.0.1:9/none", PRIORS_AGENT_ID: String(AGENT), PRIORS_WAIT_SECONDS: "2" };
    const t0 = Date.now();
    const r = await new Promise((ok) => {
      const p = spawn(process.execPath, [join(ROOT, `bin/${CLI}.mjs`), "borrow", "5"], { cwd: tmp, env });
      let out = "", err = "";
      const kill = setTimeout(() => p.kill("SIGKILL"), 14_000);
      p.stdout.on("data", (x) => (out += x));
      p.stderr.on("data", (x) => (err += x));
      p.on("close", (code, signal) => { clearTimeout(kill); ok({ code, signal, out, err }); });
    });
    const ms = Date.now() - t0;
    assert.notEqual(r.signal, "SIGKILL", `still running after ${ms} ms`);
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.ok(ms < 2000 + 8000, `${ms} ms`);
    assert.equal(records(home).filter((f) => f.endsWith(".json")).length, 1, "kept, as sending");
    assert.ok(!existsSync(lockPath(home)), "the lock is released");
    const next = await cli(c, ["borrow", "5"], { home });
    assert.equal(next.code, 3, `next: exit ${next.code}: ${next.err}`);
    assert.match(next.err, /not settled/, "refused for the record, not for a lock");
    assert.equal(c.loans(), 1);
  }));

await check("no record for this key: exit 0, nothing to settle", () =>
  onChain({}, async (c) => {
    const r = await cli(c, ["tx"], { home: freshHome() });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.match(r.out, /no unconfirmed transaction recorded/);
  }));

await check("a record others can write to: refused (exit 2), not read", async () => {
  const home = freshHome();
  await plantRecord(home, 4, { mode: 0o666 });
  await onChain({}, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 2, `exit ${r.code}: ${r.err}`);
    assert.match(r.err, /not trusted/);
  });
});

await check("a symlink planted at a record's path: refused (exit 2), not followed", async () => {
  const home = freshHome();
  const elsewhere = mkdtempSync(join(tmp, "elsewhere-"));
  const h = await plantRecord(elsewhere, 4); // a well-formed record, but outside the directory
  mkdirSync(recordDir(home), { recursive: true, mode: 0o700 });
  symlinkSync(recordPath(elsewhere, h), recordPath(home, h));
  await onChain({}, async (c) => {
    const r = await cli(c, ["tx"], { home });
    assert.equal(r.code, 2, `exit ${r.code}: ${r.err}`);
    assert.match(r.err, /not trusted/);
  });
});

await check("concurrent saves for different keys (separate processes): every record survives", async () => {
  const home = freshHome();
  const keys = Array.from({ length: 8 }, () => ethers.Wallet.createRandom());
  const mod = pathToFileURL(join(ROOT, "sdk/tx-record.mjs")).href;
  const ethersUrl = pathToFileURL(join(ROOT, "sdk/priors-v2.mjs")).href;
  const raws = await Promise.all(keys.map((k) => k.signTransaction({ to: POOL, data: "0x", nonce: 1, gasLimit: 21_000n, gasPrice: 1n, chainId: 4663n })));
  await Promise.all(keys.map((k, i) => new Promise((ok, no) => {
    const code = `const m = await import(${JSON.stringify(mod)}); await import(${JSON.stringify(ethersUrl)}); const { ethers } = await import("ethers"); const raw = ${JSON.stringify(raws[i])}; const t = ethers.Transaction.from(raw); m.saveUnconfirmed(${JSON.stringify(k.address)}, { hash: t.hash, nonce: 1, raw, command: "borrow", sentBlock: 1 });`;
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home } });
    let err = "";
    p.stderr.on("data", (x) => (err += x));
    p.on("close", (code_) => (code_ === 0 ? ok() : no(new Error(`save exited ${code_}: ${err}`))));
  })));
  const { listUnconfirmed } = await import(mod);
  for (const k of keys) assert.equal(listUnconfirmed(k.address, { HOME: home }).length, 1, `${k.address}'s record survived`);
});

await check("`tx` takes no argument: exit 2", () =>
  onChain({}, async (c) => {
    const r = await cli(c, ["tx", "0x1234"], { home: freshHome() });
    assert.equal(r.code, 2, `exit ${r.code}: ${r.err}`);
  }));

await check("another valid private key on the command line (after `tx`): refused (exit 2), never sent to the node, never printed", () =>
  onChain({}, async (c) => {
    const other = ethers.Wallet.createRandom().privateKey;
    for (const arg of [other, other.slice(2)]) {
      const r = await cli(c, ["tx", arg], { home: freshHome() });
      assert.equal(r.code, 2, `exit ${r.code}: ${r.err}`);
      assert.match(r.err, /private key was passed on the command line/);
      assert.ok(!(r.err + r.out).includes(other.slice(2)), "the other key is never printed");
    }
    assert.ok(!c.bodies.some((b) => b.toLowerCase().includes(other.slice(2).toLowerCase())), "the other key never reached the node");
  }));

await check("every receipt read is lost: exit 4 and the tx hash", () =>
  onChain({ lose: "receipt" }, async (c) => {
    const r = await cli(c, ["borrow", "5"]);
    assert.equal(c.loans(), 1);
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.ok(r.err.includes(borrows(c)[0].hash), `no tx hash in: ${r.err}`);
  }));

await check("a borrow that went through and a status read after it that fails: exit 0, the loan printed, and a word to run status (not a failure to retry)", () =>
  onChain({ failReadsAfterWrite: true }, async (c) => {
    const r = await cli(c, ["borrow", "5"]);
    assert.equal(c.loans(), 1);
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.match(r.out, /borrowed 5(\.0+)? USDG as loan #1/);
    assert.match(r.err, new RegExp(`could not be read.*${CLI} status`, "s"));
  }));

await check("regression (round 8): \"nonce too low\" and its nonce was used by a different transaction: exit 4, record kept, borrow refused, and not 'safe' until `tx` finds the other one final", async () => {
  const home = freshHome();
  await onChain({ refuseSend: "nonce too low", counts: { latest: 0, pending: 0 } }, async (c) => {
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.doesNotMatch(r.out + r.err, /safe/);
    assert.equal(c.loans(), 0);
    assert.equal(records(home).length, 1, "kept: the nonce may have been its own");
    const again = await cli(c, ["borrow", "5"], { home });
    assert.equal(again.code, 3, `again: exit ${again.code}: ${again.err}`);
  });
  // later: nonce 0 was used by another call, in a block after it was signed
  await onChain({ nonceUsed: { nonce: 0, at: BLOCK + 5, by: OTHER } }, async (c) => {
    c.advance(10);
    const t = await cli(c, ["tx"], { home });
    assert.equal(t.code, 3, `tx exit ${t.code}: ${t.err} ${t.out}`);
    assert.match(t.out, /waiting for finality/);
    assert.doesNotMatch(t.out + t.err, /safe/);
    c.setFinalized(BLOCK + 10);
    const f = await cli(c, ["tx"], { home });
    assert.equal(f.code, 0, `tx exit ${f.code}: ${f.err} ${f.out}`);
    assert.match(f.out, new RegExp(`${OTHER}.*did not run.*final.*safe`, "s"));
    assert.deepEqual(records(home), []);
  });
});

await check("a refusal that shows the bytes were not taken (insufficient funds): exit 1 with the reason, its record removed", () =>
  onChain({ refuseSend: "insufficient funds for gas * price + value" }, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 1, `exit ${r.code}: ${r.err}`);
    assert.doesNotMatch(r.err, /may have/);
    assert.equal(c.loans(), 0);
    assert.deepEqual(records(home), []);
  }));

await check("regression (round 8): the node took the borrow, then answered \"nonce too low\": exit 0, the loan (it ran), no record", () =>
  onChain({ takeThenRefuse: "nonce too low" }, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
    assert.match(r.out, /borrowed 5(\.0+)? USDG as loan #1/);
    assert.equal(c.loans(), 1);
    assert.deepEqual(records(home), []);
  }));

await check("regression (round 8): the node took the borrow, answered \"nonce too low\", its receipt not readable: exit 4, record kept, a second borrow refused (one loan)", () =>
  onChain({ takeThenRefuse: "nonce too low", sentReceiptAfter: 99 }, async (c) => {
    const home = freshHome();
    const r = await cli(c, ["borrow", "5"], { home });
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.doesNotMatch(r.out + r.err, /safe/);
    assert.equal(records(home).length, 1);
    const again = await cli(c, ["borrow", "5"], { home });
    assert.equal(again.code, 3, `again: exit ${again.code}: ${again.err}`);
    assert.equal(c.loans(), 1);
  }));

await check("regression (round 8, Codex's race): B passed its lock check; C takes the lock and resends B's recorded bytes, which land first; B then gets \"nonce too low\": the record stays, a later borrow is refused, one loan", () =>
  onChain({ holdRefuse: "nonce too low", sentReceiptAfter: 99 }, async (c) => {
    const home = freshHome();
    const b = spawnCli(c, ["borrow", "5"], { home });
    await c.broadcastSeen; // B recorded its borrow, checked its lock, and sent it: the answer is held
    rmSync(lockPath(home)); // the stale-lock race hands the name to C
    const cRun = await cli(c, ["tx", "--resend"], { home });
    assert.match(cRun.out, /sent the same signed transaction again/, `C: exit ${cRun.code}: ${cRun.err} ${cRun.out}`);
    assert.equal(c.loans(), 1, "C's copy of B's borrow landed");
    c.releaseHeld(); // B's own broadcast: "nonce too low"
    const rb = await b.done;
    assert.equal(rb.code, 4, `B: exit ${rb.code}: ${rb.err}`);
    assert.equal(records(home).length, 1, "the record C relies on is still there");
    const later = await cli(c, ["borrow", "5"], { home });
    assert.equal(later.code, 3, `later: exit ${later.code}: ${later.err}`);
    assert.equal(c.loans(), 1, "one loan");
  }));

await check("regression (round 8): a refusal at the broadcast after this command lost its lock: the record is kept (another command may be sending the same bytes), exit 4", () =>
  onChain({ holdRefuse: "insufficient funds for gas * price + value" }, async (c) => {
    const home = freshHome();
    const b = spawnCli(c, ["borrow", "5"], { home });
    await c.broadcastSeen;
    rmSync(lockPath(home));
    writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid, token: "other", at: new Date().toISOString() }), { mode: 0o600 });
    c.releaseHeld();
    const r = await b.done;
    assert.equal(r.code, 4, `exit ${r.code}: ${r.err}`);
    assert.equal(records(home).length, 1);
    assert.equal(c.loans(), 0);
  }));

await check("control: a borrow the pool refuses exits 1 with its reason, nothing sent", () =>
  onChain({ line: 4_000000n }, async (c) => {
    const r = await cli(c, ["borrow", "5"]);
    assert.equal(r.code, 1, `exit ${r.code}: ${r.err}`);
    assert.match(r.err, /would revert: InsufficientCapacity/);
    assert.equal(c.sent.length, 0);
  }));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
