// Credit as float (docs/FLOAT.md): pay an x402-priced resource from the agent's USDG, borrowing only the
// shortfall from its Priors v2 line.
//
//   import { pay, settleLoans } from "priors/float";
//   const { response, paid, borrowed, loanId } = await pay(url, { signer, pool, agentId, maxBorrow: 5_000000n, maxPrice: 1_000000n });
//   (maxPrice caps what one call pays, default 0.1 USDG: the merchant's 402 names the price, not the agent)
//   ...later, once the agent has been paid:
//   await settleLoans({ signer, pool, agentId });
//
// `signer` is the agent's wallet: the controller of `agentId` on the pool (owner or delegate) and the payer.
// The payment itself is x402 v1 "exact" on Robinhood Chain: an EIP-3009 TransferWithAuthorization signed on USDG's
// "Global Dollar" v1 domain, sent back base64-encoded in X-PAYMENT (format: sdk/x402.mjs).
import { ethers } from "ethers";
import { NETWORKS, TRANSFER_WITH_AUTHORIZATION_TYPES, domainFor, encodePaymentHeader, decodePaymentHeader, USDG_MAINNET } from "./x402.mjs";

const LOAN = "tuple(uint256 agentId, uint256 sponsorId, uint256 principal, uint256 fee, uint256 sponsorCut, uint256 reserveCut, uint256 premium, address owner, uint64 issuedAt, uint64 dueAt, uint64 defaultableAt, uint64 minScoreTerm, uint64 closedAt, uint8 status)";
export const POOL_V2_FLOAT_ABI = [
  "function usdg() view returns (address)",
  "function getParams() view returns (tuple(uint256 minLoan, uint256 maxLoan, uint64 minTerm, uint64 maxTerm, uint64 grace, uint64 minScoreTerm, uint256 feeBps, uint256 sponsorFeeBps, uint256 protocolFeeBps, uint256 minStake, uint256 maxUtilizationBps, uint256 keeperBounty))",
  "function quoteFee(uint256 agentId, uint256 principal, uint64 term) view returns (uint256 fee, uint256 sponsorCut, uint256 reserveCut, uint256 premium)",
  "function borrow(uint256 agentId, uint256 amount, uint64 term, address to, uint256 maxFee) returns (uint256)",
  "function repay(uint256 loanId, uint256 expectedAgentId, uint256 maxDue)",
  "function loansOf(uint256 id) view returns (uint256[])",
  "function isController(uint256 id, address who) view returns (bool)",
  `function getLoan(uint256 loanId) view returns (${LOAN})`,
  // a SeatVaultV5 line's step before a borrow (v5BeforeBorrow): the agent's sponsor and room, and its owner
  "function getAgent(uint256) view returns (tuple(bool enrolled,bool isRoot,bool defaulted,bool frozen,bool importedFromV1,uint64 enrolledAt,uint64 lastBorrowAt,uint64 lastRepayAt,uint256 sponsor,uint256 delegatedIn,uint256 delegatedOut,uint256 principalOut,uint256 activeLoans,uint256 premiumBps,uint256 premiumCap,uint256 loansRepaid,uint256 volumeRepaid,uint256 feesPaid,uint256 recourseHonored,uint256 childrenDefaulted,uint256 qualifiedRepaid,uint256 dollarSecondsRepaid))",
  "function registry() view returns (address)",
  "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 fee, uint64 dueAt, address to)",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const LOAN_ACTIVE = 1n;
/** Default most one pay() call signs away, atomic USDG (0.1 USDG, the x402 reference client's default cap). */
export const DEFAULT_MAX_PRICE = 100_000n;
/** Default longest an authorization stays cashable, seconds, whatever maxTimeoutSeconds the merchant asks. */
export const DEFAULT_MAX_VALIDITY_SECONDS = 600;
/**
 * GHSA-9pw7: whether `me` may move its own money for agent `id` — borrow into it, or repay its loans. The pool's
 * `setDelegate` lets an owner name any address its delegate with no word from that address, so `isController` is no
 * proof the signer acts for that owner. `me` must be the agent's current owner or its declared ERC-8004 wallet (set
 * only by that wallet's own AgentWalletSet signature naming this owner, cleared by a transfer). Borrowing and repaying
 * take the same rule, so no key borrows here and is then refused a repayment. `did`: "borrowed" or "repaid".
 */
async function needOwnerOrAgentWallet(poolC, signer, id, me, did, { ownerOf, agentWalletOf } = {}) {
  const mine = String(me).toLowerCase();
  const reg = ownerOf && agentWalletOf ? null : new ethers.Contract(await poolC.registry(), REGISTRY_OWNER_ABI, signer);
  const holder = String(ownerOf ? await ownerOf(id) : await reg.ownerOf(id));
  if (holder.toLowerCase() === mine) return holder.toLowerCase();
  const declared = String(agentWalletOf ? await agentWalletOf(id) : await reg.getAgentWallet(id));
  if (declared.toLowerCase() === mine) return holder.toLowerCase();
  throw new FloatError("NOT_AGENTS_WALLET",
    `${me} is neither agent #${id}'s owner (${holder}) nor its declared ERC-8004 wallet: a pool delegate the owner `
    + `named is not proof it acts for that owner, so nothing was ${did}. Declare this key as the agent's wallet (the `
    + `registry's setAgentWallet, signed by this key), or use the owner's key.`);
}

/** Default loan term when pay() has to borrow: float is pay now, get paid within the week (x402 audit F3). */
export const DEFAULT_TERM_SECONDS = 7 * 86400;

export class FloatError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "FloatError"; this.code = code; Object.assign(this, details); }
}

const poolContract = (pool, signer) => (typeof pool === "string" ? new ethers.Contract(pool, POOL_V2_FLOAT_ABI, signer) : pool.connect ? pool.connect(signer) : pool);
const sameAddr = (a, b) => typeof a === "string" && typeof b === "string" && ethers.isAddress(a) && ethers.isAddress(b) && ethers.getAddress(a) === ethers.getAddress(b);

/** SeatVaultV5 (a root that backs lines with the owner's $PRIORS), the calls a borrow on its line needs: V5 vouches
 *  nothing at the open and raises the pool's vouch only on `refresh`, by the owner or by the pool delegate V5 recorded
 *  (`noteDelegate`, anyone may send it) at least 24 h before. The same calls as @priors/x402's V5_ABI. */
export const SEAT_VAULT_V5_ABI = [
  "function refresh(uint256 id)",
  "function noteDelegate(uint256 id)",
  "function delegateOf(uint256 id) view returns (address who, uint64 at)",
  "error BookNotOpen()", "error NoPrice()",
];
/** V5's delegate wait: a key V5 recorded raises the line this long after. */
export const V5_DELEGATE_WAIT_S = 86_400;
const REGISTRY_OWNER_ABI = ["function ownerOf(uint256) view returns (address)", "function getAgentWallet(uint256 agentId) view returns (address)"];
const utc = (s) => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
/** "Name(args)" for a revert that decodes against `iface`, else the provider's short message. */
function revertText(err, iface) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (err?.revert?.name) return `${err.revert.name}(${(err.revert.args || []).map(String).join(", ")})`;
  if (typeof data === "string" && data.length >= 10) { try { const e = iface.parseError(data); if (e) return `${e.name}(${e.args.map(String).join(", ")})`; } catch (_) { /* not V5's */ } }
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

/**
 * Before a borrow on a SeatVaultV5 line (the agent's pool sponsor is V5's root `v5Root`): raise the pool's vouch to
 * the line V5 allows now with `refresh(id)`, which only the agent's owner, or the pool delegate V5 recorded at least
 * 24 h ago, may do. A delegate key V5 has not recorded yet is recorded now (`noteDelegate`); while its 24 h run, the
 * borrow goes ahead only if the line already has room for it, and otherwise stops with when it can borrow (it never
 * refreshes then: a refresh V5 may not raise on can lower the vouch). Any other line, or no V5 known (`v5` or `v5Root`
 * missing): nothing read, nothing sent. The same rules as @priors/x402's `v5BeforeBorrow`.
 * Refusals (FloatError): V5_REFRESH_WOULD_REVERT (before anything is sent), NOT_CONTROLLER (a key that does not control
 * the agent; nothing sent), V5_DELEGATE_WAIT (`room`, `readyAt`, `noted`: the noteDelegate tx when one was sent).
 * @param {{ signer: ethers.Signer, pool: string|ethers.Contract, v5?: string|ethers.Contract|null, v5Root?: bigint|number|string|null,
 *   agentId: bigint|number|string, amount: bigint, now?: () => number, ownerOf?: (id: bigint) => Promise<string> }} o
 * @returns {Promise<{ v5: boolean, refreshed: boolean, noted: string|null }>}
 */
export async function v5BeforeBorrow({ signer, pool, v5, v5Root, agentId, amount, now = () => Math.floor(Date.now() / 1000), ownerOf }) {
  const out = { v5: false, refreshed: false, noted: null };
  if (!v5 || !v5Root || BigInt(v5Root) === 0n) return out;
  const poolC = poolContract(pool, signer);
  const id = BigInt(agentId);
  const ag = await poolC.getAgent(id);
  if (BigInt(ag.sponsor) !== BigInt(v5Root)) return out;
  out.v5 = true;
  const v5C = typeof v5 === "string" ? new ethers.Contract(v5, SEAT_VAULT_V5_ABI, signer) : v5.connect ? v5.connect(signer) : v5;
  const me = ethers.getAddress(await signer.getAddress());
  const owner = ethers.getAddress(ownerOf ? await ownerOf(id) : await new ethers.Contract(await poolC.registry(), REGISTRY_OWNER_ABI, signer).ownerOf(id));
  const room = BigInt(ag.delegatedIn) > BigInt(ag.principalOut) ? BigInt(ag.delegatedIn) - BigInt(ag.principalOut) : 0n;
  const refresh = async () => {
    try { await v5C.refresh.staticCall(id); } catch (e) { throw new FloatError("V5_REFRESH_WOULD_REVERT", `agent #${id}'s line is on SeatVaultV5 and its refresh would revert (${revertText(e, v5C.interface)}): the line can't be raised now`); }
    await (await v5C.refresh(id)).wait();
    out.refreshed = true;
  };
  if (owner === me) { await refresh(); return out; }
  const [who, at] = await v5C.delegateOf(id);
  const ready = Number(at) + V5_DELEGATE_WAIT_S;
  if (ethers.getAddress(who) === me && now() >= ready) { await refresh(); return out; }
  // not (yet) a key V5 lets raise the line: never refresh (a refresh it may not raise can lower the vouch)
  if (ethers.getAddress(who) !== me) {
    if (!(await poolC.isController(id, me))) throw new FloatError("NOT_CONTROLLER", `agent #${id} is not controlled by ${me} (neither its owner nor its pool delegate)`);
    const tx = await v5C.noteDelegate(id);
    await tx.wait();
    out.noted = tx.hash;
  }
  if (room >= BigInt(amount)) return out;
  const when = ethers.getAddress(who) === me ? ready : now() + V5_DELEGATE_WAIT_S;
  throw new FloatError("V5_DELEGATE_WAIT",
    `agent #${id}'s line is on SeatVaultV5, which raises it only for the agent's owner, or for the agent's key 24 hours after V5 recorded it${out.noted ? ` (recorded now, tx ${out.noted})` : ""}. `
    + `The line has room for ${room} atomic USDG now. This key can borrow more from ${utc(when)}; before then, the owner can borrow from Go mode, which raises the line first.`,
    { room, readyAt: when, noted: out.noted });
}

/** Pick the first "exact" USDG-on-Robinhood requirement from a 402 body. */
export function pickRequirement(body, asset = USDG_MAINNET) {
  const accepts = Array.isArray(body?.accepts) ? body.accepts : [];
  return accepts.find((r) => r && r.scheme === "exact" && NETWORKS.has(r.network) && sameAddr(r.asset, asset) && /^\d+$/.test(String(r.maxAmountRequired)) && ethers.isAddress(r.payTo || "")) || null;
}

/**
 * Sign an EIP-3009 authorization for `req` and return the X-PAYMENT header value. The window runs until the
 * merchant's maxTimeoutSeconds, capped at `maxValiditySeconds`: the 402 body is the merchant's to write, and an
 * uncapped window would hand it an authorization it could still cash long after the call failed.
 */
export async function signPayment(signer, req, { now = Math.floor(Date.now() / 1000), chainId = 4663, maxValiditySeconds = DEFAULT_MAX_VALIDITY_SECONDS } = {}) {
  const from = await signer.getAddress();
  const asked = Number(req.maxTimeoutSeconds);
  // The 600 s ceiling is a floor under the caller too: an option may only shorten the window, never lift it.
  const cap = Math.min(Number(maxValiditySeconds) > 0 ? Number(maxValiditySeconds) : DEFAULT_MAX_VALIDITY_SECONDS, DEFAULT_MAX_VALIDITY_SECONDS);
  const window = Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, cap) : Math.min(60, cap);
  // Valid from 10 minutes ago (clock skew, as the reference client) until the capped window.
  const authorization = {
    from,
    to: ethers.getAddress(req.payTo),
    value: String(req.maxAmountRequired),
    validAfter: String(now - 600),
    validBefore: String(now + window),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signature = await signer.signTypedData(domainFor(req.asset, chainId), TRANSFER_WITH_AUTHORIZATION_TYPES, authorization);
  return encodePaymentHeader({ x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization } });
}

/**
 * Fetch `url`; on a 402, pay it in USDG, borrowing the shortfall from the agent's v2 line if needed.
 * @param {string} url
 * @param {object} o
 * @param {ethers.Signer} o.signer   agent wallet (controller of agentId, payer)
 * @param {string|ethers.Contract} o.pool   CreditPoolV2 address or contract
 * @param {bigint|number|string} o.agentId
 * @param {bigint|number|string} o.maxBorrow  most this call may borrow, atomic USDG (0 = never borrow)
 * @param {bigint|number|string} [o.maxPrice]  most this call may pay, atomic USDG (default 100000 = 0.1 USDG); a
 *   402 asking more is refused before anything is signed or borrowed, whatever the balance
 * @param {number} [o.maxValiditySeconds]  cap on the authorization's lifetime (default 600)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.termSeconds]  loan term (default 7 days, clamped to the pool's [minTerm, maxTerm]); an explicit
 *   term below minTerm is raised, above maxTerm refused
 * @param {bigint} [o.maxFee]  refuse a loan whose fee is above this
 * @param {string|ethers.Contract} [o.v5]  SeatVaultV5 (the deployment record's `seatVaultV5`), with `o.v5Root` (its
 *   `seatVaultV5AgentId`): a borrow on a line V5 sponsors takes `v5BeforeBorrow`'s step first
 * @param {bigint|number|string} [o.v5Root]
 * @param {RequestInit} [o.init]  passed to every fetch (a redirect is not followed unless `init.redirect` says so)
 * @param {number} [o.pendingRetries]  resends of the SAME payment while the merchant answers "pending" (default 6)
 * @param {number} [o.timeoutMs]  per-request timeout (default 60 s; 0 = none)
 * @returns {Promise<{response: Response, paid: bigint, borrowed: bigint, loanId: bigint|null, dueAt: bigint|null, requirement?: object,
 *   pending?: boolean, timedOut?: boolean, transportError?: boolean, paymentHeader?: string, validBefore?: number}>}
 *   Once a payment is signed, `paymentHeader` and `validBefore` are always returned (and carried by any error thrown
 *   after it, with the loan): until validBefore the merchant can still cash it, so a caller that retries must resend
 *   `paymentHeader` (see `resend`), never call pay() again for the same purchase, which would sign a second payment.
 *   `pending: true` (a "pending" answer, a timeout or a lost connection) means it may still land. A borrow whose answer
 *   was lost throws `BORROW_UNCONFIRMED` with `borrowed` (and `unconfirmed: true`, `hash`): the loan may exist, so check
 *   the agent's loans and repay it.
 */
export async function pay(url, o = {}) {
  if (!o.signer) throw new FloatError("NO_SIGNER", "pay: a signer is required");
  // One payment at a time per wallet: two concurrent calls on a short balance would each read it short and each borrow
  // the gap (private report GHSA-482p, F3). The second waits and sees the first's loan.
  const key = String(await o.signer.getAddress()).toLowerCase();
  const run = (payQueues.get(key) || Promise.resolve()).then(() => payOne(url, o));
  const tail = run.then(() => {}, () => {});
  payQueues.set(key, tail);
  tail.then(() => { if (payQueues.get(key) === tail) payQueues.delete(key); });
  return run;
}
const payQueues = new Map();

async function payOne(url, { signer, pool, agentId, maxBorrow = 0n, maxPrice = DEFAULT_MAX_PRICE, maxValiditySeconds = DEFAULT_MAX_VALIDITY_SECONDS, fetchImpl = fetch, termSeconds, maxFee, init = {}, asset, pendingRetries = 6, sleep = defaultSleep, timeoutMs = DEFAULT_TIMEOUT_MS, v5, v5Root } = {}) {
  const first = await fetchImpl(url, requestInit(init, timeoutMs)); // a timeout here throws: nothing is signed yet
  if (first.status !== 402) return { response: first, paid: 0n, borrowed: 0n, loanId: null, dueAt: null };

  const poolC = pool ? poolContract(pool, signer) : null;
  const usdgAddr = asset || (poolC ? await poolC.usdg() : USDG_MAINNET);
  let body;
  try { body = JSON.parse((await readCapped(first)).text); } catch (_) { throw new FloatError("BAD_402", "pay: the 402 response is not x402 JSON"); }
  const req = pickRequirement(body, usdgAddr);
  if (!req) throw new FloatError("NO_USDG_REQUIREMENT", "pay: the resource does not accept exact USDG on Robinhood Chain");

  const price = BigInt(req.maxAmountRequired);
  // The merchant names the price. Without a cap a funded agent signs whatever a 402 asks (its whole balance).
  if (price > BigInt(maxPrice)) throw new FloatError("PRICE_ABOVE_MAX_PRICE", `pay: price ${price} is above maxPrice ${maxPrice}; not paying`, { price, maxPrice: BigInt(maxPrice) });
  const cap = BigInt(maxBorrow);
  const me = await signer.getAddress();
  const usdg = new ethers.Contract(usdgAddr, ERC20, signer);
  const balance = await usdg.balanceOf(me);

  let borrowed = 0n, loanId = null, dueAt = null;
  if (balance < price) {
    // Checked before any transaction: a refused call opens no loan.
    if (price > cap) throw new FloatError("PRICE_ABOVE_MAX_BORROW", `pay: price ${price} is above maxBorrow ${cap}; not borrowing`, { price, maxBorrow: cap });
    if (!poolC || agentId === undefined) throw new FloatError("NO_POOL", "pay: short of USDG and no pool/agentId to borrow from");
    const p = await poolC.getParams();
    const shortfall = price - balance;
    const amount = shortfall > p.minLoan ? shortfall : p.minLoan;
    if (amount > cap) throw new FloatError("MIN_LOAN_ABOVE_MAX_BORROW", `pay: the pool's minimum loan ${p.minLoan} is above maxBorrow ${cap}; not borrowing`, { amount, maxBorrow: cap });
    if (amount > p.maxLoan) throw new FloatError("ABOVE_MAX_LOAN", `pay: ${amount} is above the pool's maxLoan ${p.maxLoan}`);
    // Float is "pay now, get paid next week": the default is 7 days, clamped into the pool's range. An explicit term
    // above maxTerm is still refused rather than silently shortened (x402 audit F3).
    let term = termSeconds === undefined ? BigInt(DEFAULT_TERM_SECONDS) : BigInt(termSeconds);
    if (term < p.minTerm) term = p.minTerm;
    if (termSeconds === undefined && term > p.maxTerm) term = p.maxTerm;
    if (term > p.maxTerm) throw new FloatError("TERM_OUT_OF_RANGE", `pay: term ${term} is above the pool's maxTerm ${p.maxTerm}`);
    const [fee] = await poolC.quoteFee(agentId, amount, term);
    if (maxFee !== undefined && fee > BigInt(maxFee)) throw new FloatError("FEE_TOO_HIGH", `pay: loan fee ${fee} is above maxFee ${maxFee}`);
    // the repayment rule, before anything is sent (GHSA-9pw7): no borrow this client would then refuse to repay
    await needOwnerOrAgentWallet(poolC, signer, agentId, me, "borrowed");
    // A SeatVaultV5 line: its refresh (or the key's noteDelegate) first, as @priors/x402's borrowGap does.
    await v5BeforeBorrow({ signer, pool: poolC, v5, v5Root, agentId, amount });
    // to = the agent itself: EIP-3009 needs the payer to hold the funds, so the draw lands in the agent's wallet and
    // is spent by the signed authorization below. (A borrow-and-pay router would send it straight to payTo.)
    // A lost answer (the broadcast's or the receipt's) may hide a loan that mined: BORROW_UNCONFIRMED carries the amount
    // (GHSA-v9xj). Only CALL_EXCEPTION (a refused estimate, or a mined revert) and INSUFFICIENT_FUNDS borrowed nothing.
    let tx, rc;
    try { tx = await poolC.borrow(agentId, amount, term, me, fee); rc = await tx.wait(); } catch (e) {
      if (e?.code === "CALL_EXCEPTION" || e?.code === "INSUFFICIENT_FUNDS") throw e;
      const hash = typeof tx?.hash === "string" ? tx.hash : null;
      throw new FloatError("BORROW_UNCONFIRMED", `pay: a borrow of ${amount} was sent${hash ? ` (tx ${hash})` : ""} and its answer was lost (${e?.shortMessage || e?.message || String(e)}): it may have opened a loan`,
        { borrowed: amount, loanId: null, dueAt: null, unconfirmed: true, hash, cause: e });
    }
    const ev = rc.logs.map((l) => { try { return poolC.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e && e.name === "Borrowed");
    loanId = ev ? ev.args.loanId : null;
    dueAt = ev ? ev.args.dueAt : null; // when to have settleLoans() run by, so the line is never defaulted
    borrowed = amount;
  }

  // Exactly one signature for this purchase. An error from here carries the loan (and, once signed, the header).
  let header, validBefore;
  try {
    header = await signPayment(signer, req, { maxValiditySeconds });
    validBefore = Number(decodePaymentHeader(header).payload.authorization.validBefore);
    const r = await resend(url, header, { init, fetchImpl, retries: pendingRetries, sleep, timeoutMs });
    return { ...r, paid: r.response.ok ? price : 0n, borrowed, loanId, dueAt, requirement: req, paymentHeader: header, validBefore };
  } catch (e) {
    if (e && typeof e === "object") Object.assign(e, { borrowed, loanId, dueAt, ...(header ? { paymentHeader: header, validBefore } : {}) });
    throw e;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Per-request timeout, 60 s by default: a merchant that never answers cannot hold pay() forever. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Merchant bodies are read at most this far, as in @priors/x402: a merchant streaming gigabytes cannot exhaust memory. */
export const MAX_BODY_BYTES = 256 * 1024;

/** A response body as text, at most `max` bytes; the rest is cancelled, not read. */
async function readCapped(response, max = MAX_BODY_BYTES) {
  if (!response?.body) return { text: "", cut: false };
  const reader = response.body.getReader();
  const chunks = [];
  let n = 0, cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.byteLength > max) { chunks.push(value.subarray(0, max - n)); n = max; cut = true; await reader.cancel().catch(() => {}); break; }
    chunks.push(value); n += value.byteLength;
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return { text: new TextDecoder().decode(buf), cut };
}

/**
 * The caller's init with a redirect never followed (a signed payment must not travel to a host the caller did not
 * name; the 3xx is the answer, as in @priors/x402) unless the caller sets `redirect`, and the timeout joined to its signal.
 */
function requestInit(init, timeoutMs) {
  const signals = [timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null, init.signal || null].filter(Boolean);
  return { ...init, redirect: init.redirect ?? "manual", ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}) };
}
const isAbort = (e) => e?.name === "AbortError" || e?.name === "TimeoutError";

/** Does this answer say "your payment was broadcast, not confirmed yet: send the same one again"? In x402 that is a 402
 *  whose PAYMENT-RESPONSE (or X-PAYMENT-RESPONSE) header carries errorReason "settlement_pending" (as @x402/core's server
 *  writes it, body {}); a body {pending: true} or {errorReason: "settlement_pending"} too. As @priors/x402 reads it (GHSA-wvxm). */
const isPending = async (response) => {
  if (response.status !== 402) return false;
  for (const name of ["PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"]) if (decodePaymentHeader(response.headers.get(name))?.errorReason === "settlement_pending") return true;
  try { const b = JSON.parse((await readCapped(response.clone(), 64 * 1024)).text); return b?.pending === true || b?.errorReason === "settlement_pending"; } catch (_) { return false; }
};

/**
 * Send an already-signed X-PAYMENT, and keep resending the SAME one while the merchant answers 402 pending (`isPending`:
 * its settlement was broadcast but not confirmed yet; see docs/FLOAT.md). Never signs anything:
 * a new signature while the first payment can still land is how a call gets paid twice. Once the payment may be out,
 * no error is thrown: a timeout or an abort is reported as pending (`timedOut: true`, a synthetic 504), any other
 * transport error as pending too (`transportError: true`, a synthetic 502, the error in `error`), with the header.
 * @returns {Promise<{response: Response, pending: boolean, timedOut?: boolean, transportError?: boolean, error?: unknown, paymentHeader?: string}>}
 */
export async function resend(url, paymentHeader, { init = {}, fetchImpl = fetch, retries = 6, sleep = defaultSleep, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-PAYMENT", paymentHeader);
  const send = () => fetchImpl(url, requestInit({ ...init, headers }, timeoutMs));
  let response;
  try {
    response = await send();
    for (let i = 0; i < retries && (await isPending(response)); i++) {
      const after = Number(response.headers.get("retry-after"));
      await sleep(1000 * Math.min(30, Math.max(1, Number.isFinite(after) && after > 0 ? after : 5)));
      response = await send();
    }
  } catch (e) {
    if (isAbort(e)) return { response: new Response(null, { status: 504, statusText: "payer timeout" }), pending: true, timedOut: true, paymentHeader };
    return { response: new Response(null, { status: 502, statusText: "payer transport error" }), pending: true, transportError: true, error: e, paymentHeader };
  }
  const pending = await isPending(response);
  return { response, pending, ...(pending ? { paymentHeader } : {}) };
}

/**
 * Repay the agent's open loans, earliest due first, while its USDG balance covers principal + fee. Only loans the
 * agent's owner now took: one opened while someone else held the agent stays in `open` and is listed in `others`
 * with who opened it (GHSA-mmp8). `ownerOf(agentId)` is for tests; by default the pool's registry is asked.
 * @returns {Promise<{repaid: bigint[], open: bigint[], others: Array<{loanId: bigint, openedBy: string}>}>}
 */
export async function settleLoans({ signer, pool, agentId, ownerOf, agentWalletOf }) {
  const poolC = poolContract(pool, signer);
  const me = await signer.getAddress();
  // Only the signer's own agent: a wrong or stale agentId would otherwise pay a stranger's loans.
  if (!(await poolC.isController(agentId, me))) throw new FloatError("NOT_CONTROLLER", `agent #${agentId} is not controlled by ${me} (neither its owner nor its pool delegate)`);
  // ...and control alone is not proof: the pool lets the owner name any address its delegate, with no word from it, so
  // a signer that is not the owner must be the agent's declared ERC-8004 wallet, which only that wallet's own signature
  // naming this owner sets and a transfer clears (GHSA-9pw7; AutoRepayV2's rule)
  const holder = await needOwnerOrAgentWallet(poolC, signer, agentId, me, "repaid", { ownerOf, agentWalletOf });
  const usdg = new ethers.Contract(await poolC.usdg(), ERC20, signer);
  const ids = await poolC.loansOf(agentId);
  const loans = (await Promise.all(ids.map(async (id) => ({ id, l: await poolC.getLoan(id) })))).filter((x) => x.l.status === LOAN_ACTIVE);
  loans.sort((a, b) => (a.l.dueAt < b.l.dueAt ? -1 : a.l.dueAt > b.l.dueAt ? 1 : 0));
  const repaid = [], open = [], others = [];
  let balance = await usdg.balanceOf(me);
  const target = await poolC.getAddress();
  for (const { id, l } of loans) {
    if (String(l.owner).toLowerCase() !== holder) { open.push(id); others.push({ loanId: id, openedBy: l.owner }); continue; }
    const due = l.principal + l.fee;
    if (balance < due) { open.push(id); continue; }
    if ((await usdg.allowance(me, target)) < due) await (await usdg.approve(target, due)).wait();
    await (await poolC.repay(id, agentId, due)).wait();
    balance -= due;
    repaid.push(id);
  }
  return { repaid, open, others };
}
