// Priors v2 credit line on Robinhood Chain, the parts a payer and an MCP server need: borrow the gap before a
// purchase, repay, read an agent's line, record and score. ethers v6.
//
// `borrowGap` and `settleLoans` are a port of sdk/float.mjs (repository `priors`, 2026-09-24), kept rule for rule:
// maxBorrow is checked against the PRICE before any transaction, the draw is max(shortfall, pool minLoan), the term
// defaults to 7 days clamped into the pool's range (an explicit term above maxTerm is refused), the fee is bounded by
// the pool's own quote (or maxFee), and the draw lands in the payer's wallet because EIP-3009 needs the payer to hold
// the funds. The package carries its own copy so it installs on its own; the package tests check it
// against sdk/float.mjs on the same inputs.
import { ethers } from "ethers";
import { robinhood, DEFAULT_TERM_SECONDS } from "./robinhood.mjs";
import { repayWindow } from "./autopay.mjs";

const LOAN_T = "tuple(uint256 agentId, uint256 sponsorId, uint256 principal, uint256 fee, uint256 sponsorCut, uint256 reserveCut, uint256 premium, address owner, uint64 issuedAt, uint64 dueAt, uint64 defaultableAt, uint64 minScoreTerm, uint64 closedAt, uint8 status)";
const AGENT_T = "tuple(bool enrolled,bool isRoot,bool defaulted,bool frozen,bool importedFromV1,uint64 enrolledAt,uint64 lastBorrowAt,uint64 lastRepayAt,uint256 sponsor,uint256 delegatedIn,uint256 delegatedOut,uint256 principalOut,uint256 activeLoans,uint256 premiumBps,uint256 premiumCap,uint256 loansRepaid,uint256 volumeRepaid,uint256 feesPaid,uint256 recourseHonored,uint256 childrenDefaulted,uint256 qualifiedRepaid,uint256 dollarSecondsRepaid)";
const PARAMS_T = "tuple(uint256 minLoan, uint256 maxLoan, uint64 minTerm, uint64 maxTerm, uint64 grace, uint64 minScoreTerm, uint256 feeBps, uint256 sponsorFeeBps, uint256 protocolFeeBps, uint256 minStake, uint256 maxUtilizationBps, uint256 keeperBounty)";

/** CreditPoolV2, the subset used here, with its custom errors so a revert decodes to a name. */
export const POOL_ABI = [
  "function usdg() view returns (address)",
  "function registry() view returns (address)",
  `function getParams() view returns (${PARAMS_T})`,
  "function quoteFee(uint256 agentId, uint256 principal, uint64 term) view returns (uint256 fee, uint256 sponsorCut, uint256 reserveCut, uint256 premium)",
  "function borrow(uint256 agentId, uint256 amount, uint64 term, address to, uint256 maxFee) returns (uint256)",
  "function repay(uint256 loanId, uint256 expectedAgentId, uint256 maxDue)",
  "function loansOf(uint256 id) view returns (uint256[])",
  `function getLoan(uint256 loanId) view returns (${LOAN_T})`,
  `function getAgent(uint256) view returns (${AGENT_T})`,
  "function isController(uint256 id, address who) view returns (bool)",
  // the pool marks the owner of an agent that defaulted (custodians, which hold others' agents, are skipped)
  "function ownerDefaults(address owner) view returns (uint256)",
  "function custodian(address who) view returns (bool)",
  "function pausedUntil() view returns (uint64)",
  "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 fee, uint64 dueAt, address to)",
  "error Paused()", "error ZeroAmount()", "error NotOwnerOf(uint256 id, address caller)", "error NotController(uint256 id, address caller)",
  "error InvalidAgent(uint256 id)", "error IsRoot(uint256 id)", "error AgentDefaulted(uint256 id)", "error V1Busy(uint256 id)",
  "error InsufficientCapacity(uint256 id, uint256 requested, uint256 available)", "error InsufficientLiquidity(uint256 requested, uint256 available)",
  "error UtilizationTooHigh()", "error LoanSizeOutOfRange(uint256 amount)", "error TermOutOfRange(uint64 term)", "error FeeTooHigh(uint256 fee, uint256 maxFee)",
  "error IsFrozen(uint256 id)", "error OwnerDefaulted(address owner)", "error BorrowBlockedByBacker(uint256 rootId)",
  "error LoanNotActive(uint256 loanId)", "error WrongLoan(uint256 loanId)", "error DueTooHigh(uint256 due, uint256 maxDue)",
];
/** CreditLensV2: the score (0..1000) and v1-layout credit report. */
export const LENS_ABI = [
  "function score(uint256 id) view returns (uint256)",
  "function available(uint256 id) view returns (uint256)",
];
export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
];
const REGISTRY_ABI = ["function ownerOf(uint256) view returns (address)", "function getAgentWallet(uint256 agentId) view returns (address)"];
/** SeatVaultV5 (a root that backs lines with the owner's $PRIORS), the calls a borrow on its line needs: V5 vouches
 *  nothing at the open and raises the pool's vouch only on `refresh`, by the owner or by the pool delegate V5 recorded
 *  (`noteDelegate`, anyone may send it) at least 24 h before. */
export const V5_ABI = [
  "function refresh(uint256 id)",
  "function noteDelegate(uint256 id)",
  "function delegateOf(uint256 id) view returns (address who, uint64 at)",
  "error BookNotOpen()", "error NoPrice()",
];
/** V5's C.DELEGATE_WAIT: a key V5 recorded raises the line this long after. */
export const V5_DELEGATE_WAIT_S = 86_400;
/** The Priors stock vault (a root that backs lines with the agent's own stock tokens), the reads creditStatus needs. */
export const STOCK_VAULT_ABI = [
  "function agentId() view returns (uint256)",
  "function params() view returns (uint256 ltvBps, uint256 maxLine, uint256 epochCap, uint64 epochLength)",
  "function getPosition(uint256 id) view returns (tuple(address depositor, address owner, address token, uint64 openedAt, bool closing, uint8 status, uint128 line, uint256 amount))",
  "function valueOf(address token, uint256 amount) view returns (bool ok, uint256 value)",
  "function lendStatus(address token) view returns (uint8)",
  "function ltvOf(uint256 id, address token) view returns (uint256)", // id 0: the stock's own; else with the agent's record bonus
  "function borrowRoom(uint256 id) view returns (uint256)",
  "function held(address token) view returns (uint256)", // what the vault owes of a token, all positions together
];
/** Why the stock vault holds new loans on a token (StockVault.lendStatus; 0: no hold). */
export const STOCK_HOLDS = ["", "the price moved sharply", "a multiplier change", "the token is paused", "the token blocks the vault"];
const POSITION_STATUS = ["none", "open", "closed", "seized", "written off"];
/** The vault's own `valueOf`: on an ethers Contract, `vault.valueOf` is Object.prototype.valueOf, not the function. */
const vaultValueOf = (vault, token, amount) => (typeof vault.getFunction === "function" ? vault.getFunction("valueOf")(token, amount) : vault.valueOf(token, amount));
/** What the vault would pay position `p` now (its `_payout`): all of it, or after an issuer burn from the vault its
 *  share, amount x balance / held. `p.amount` when that cannot be read. */
async function payoutOf(vault, p) {
  try {
    const at = vault.target ?? (await vault.getAddress());
    const [held, balance] = await Promise.all([vault.held(p.token), new ethers.Contract(p.token, ERC20_ABI, vault.runner).balanceOf(at)]);
    const a = BigInt(p.amount), h = BigInt(held), b = BigInt(balance);
    return h === 0n || b >= h ? a : (a * b) / h;
  } catch (_) { return BigInt(p.amount); }
}
export const LOAN_STATUS = ["none", "active", "repaid", "defaulted"];
const LOAN_ACTIVE = 1n;

/** A refusal or failure with a stable `code` (the same codes as sdk/float.mjs's FloatError). */
export class PayError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "PayError"; this.code = code; Object.assign(this, details); }
}

/** A pool address or contract, bound to `runner`. A plain object without `connect` (a test double) is used as is. */
export const poolContract = (pool, runner) => (typeof pool === "string" ? new ethers.Contract(pool, POOL_ABI, runner) : pool && typeof pool.connect === "function" ? pool.connect(runner) : pool);

/** "Name(args)" for a contract revert when it decodes, else the provider's short message. */
export function explainRevert(err, iface = new ethers.Interface(POOL_ABI)) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (err?.revert?.name) return `${err.revert.name}(${(err.revert.args || []).map(String).join(", ")})`;
  if (typeof data === "string" && data.length >= 10) {
    for (const i of [iface, new ethers.Interface(ERC20_ABI)]) {
      try { const e = i.parseError(data); if (e) return `${e.name}(${e.args.map(String).join(", ")})`; } catch (_) { /* next */ }
    }
  }
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

/**
 * Send a borrow and wait for its receipt. Once the transaction may have left, a lost answer (the broadcast's or the
 * receipt's) may hide a loan that mined: it throws BORROW_UNCONFIRMED carrying the amount as `borrowed` (`loanId` and
 * `dueAt` unknown, `unconfirmed: true`, the tx `hash` when known), for the caller to count and to tell its user to check
 * and repay (GHSA-v9xj). Only CALL_EXCEPTION (ethers raises it for a refused estimate, before anything is sent, and for
 * a mined revert) and INSUFFICIENT_FUNDS (no gas: refused before it was sent) mean nothing was borrowed: rethrown as is.
 */
async function sendBorrow(poolC, args, amount, prefix) {
  let tx;
  try {
    tx = await poolC.borrow(...args);
    return { tx, rc: await tx.wait() };
  } catch (e) {
    if (e?.code === "CALL_EXCEPTION" || e?.code === "INSUFFICIENT_FUNDS") throw e;
    const hash = typeof tx?.hash === "string" ? tx.hash : null;
    throw new PayError("BORROW_UNCONFIRMED", `${prefix}a borrow of ${amount} was sent${hash ? ` (tx ${hash})` : ""} and its answer was lost (${e?.shortMessage || e?.message || String(e)}): it may have opened a loan`,
      { borrowed: amount, loanId: null, dueAt: null, unconfirmed: true, hash, cause: e });
  }
}

const utc = (s) => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * GHSA-9pw7: whether the signer `me` may move its own money for agent `agentId` — borrow into it, or repay its loans.
 * `CreditPoolV2.setDelegate` lets an owner name any address its delegate with no word from that address, so
 * `isController` does not show the signer agreed to act for that owner: a buyer of an agent the signer once held could
 * otherwise borrow and have the signer repay. The signer must be the agent's current owner (`holder`, lowercase), or
 * its declared ERC-8004 wallet, which only that wallet's own `AgentWalletSet` signature naming this owner sets and a
 * transfer clears (AutoRepay v2's rule, and the rule `bin/priors-v2.mjs` already applied to the CLI).
 * Borrowing and repaying take the same rule, so no key can borrow through a client that then refuses to repay.
 * `did` is what did not happen ("borrowed", "repaid"). Throws NOT_AGENTS_WALLET otherwise.
 */
export async function needOwnerOrAgentWallet(agentId, holder, me, agentWallet, did = "repaid") {
  const mine = String(me).toLowerCase();
  if (String(holder).toLowerCase() === mine) return;
  if (String(await agentWallet()).toLowerCase() === mine) return;
  throw new PayError("NOT_AGENTS_WALLET",
    `${me} is neither agent #${agentId}'s owner (${holder}) nor its declared ERC-8004 wallet: a pool delegate the `
    + `owner named is not proof it acts for that owner, so nothing was ${did}. Declare this key as the agent's wallet `
    + `(the registry's setAgentWallet, signed by this key: \`priors-mcp link-wallet\`), or use the owner's key.`);
}

/** The agent's owner and declared wallet, from injectors when given, else the pool's own registry. */
async function agentParties(poolC, signer, id, ownerOf, agentWalletOf) {
  const reg = ownerOf && agentWalletOf ? null : new ethers.Contract(await poolC.registry(), REGISTRY_ABI, signer);
  return {
    holder: String(ownerOf ? await ownerOf(id) : await reg.ownerOf(id)),
    agentWallet: () => (agentWalletOf ? agentWalletOf(id) : reg.getAgentWallet(id)),
  };
}

/**
 * Before a borrow on a SeatVaultV5 line (the agent's pool sponsor is V5's root `v5Root`): raise the pool's vouch to
 * the line V5 allows now with `refresh(id)`, which only the agent's owner, or the pool delegate V5 recorded at least
 * 24 h ago, may do (L-05). A delegate key V5 has not recorded yet is recorded now (`noteDelegate`); while its 24 h run,
 * the borrow goes ahead only if the line already has room for it, and otherwise stops with when it can borrow. Any
 * other line, or no V5 known (`v5` null): nothing. Returns { v5: bool, refreshed: bool, noted: tx hash | null }.
 */
export async function v5BeforeBorrow({ signer, pool, v5, v5Root, agentId, amount, now = () => Math.floor(Date.now() / 1000), ownerOf }) {
  const out = { v5: false, refreshed: false, noted: null };
  if (!v5 || !v5Root || BigInt(v5Root) === 0n) return out;
  const poolC = poolContract(pool, signer);
  const id = BigInt(agentId);
  const ag = await poolC.getAgent(id);
  if (BigInt(ag.sponsor) !== BigInt(v5Root)) return out;
  out.v5 = true;
  const v5C = typeof v5 === "string" ? new ethers.Contract(v5, V5_ABI, signer) : v5.connect ? v5.connect(signer) : v5;
  const me = ethers.getAddress(await signer.getAddress());
  const owner = ethers.getAddress(ownerOf ? await ownerOf(id) : await new ethers.Contract(await poolC.registry(), REGISTRY_ABI, signer).ownerOf(id));
  const room = BigInt(ag.delegatedIn) > BigInt(ag.principalOut) ? BigInt(ag.delegatedIn) - BigInt(ag.principalOut) : 0n;
  const refresh = async () => {
    try { await v5C.refresh.staticCall(id); } catch (e) { throw new PayError("V5_REFRESH_WOULD_REVERT", `agent #${id}'s line is on SeatVaultV5 and its refresh would revert (${explainRevert(e, v5C.interface)}): the line can't be raised now`); }
    await (await v5C.refresh(id)).wait();
    out.refreshed = true;
  };
  if (owner === me) { await refresh(); return out; }
  const [who, at] = await v5C.delegateOf(id);
  const ready = Number(at) + V5_DELEGATE_WAIT_S;
  if (ethers.getAddress(who) === me && now() >= ready) { await refresh(); return out; }
  // not (yet) a key V5 lets raise the line: never refresh (a refresh it may not raise can lower the vouch)
  if (ethers.getAddress(who) !== me) {
    if (!(await poolC.isController(id, me))) throw new PayError("NOT_CONTROLLER", `agent #${id} is not controlled by ${me} (neither its owner nor its pool delegate)`);
    const tx = await v5C.noteDelegate(id);
    await tx.wait();
    out.noted = tx.hash;
  }
  if (room >= BigInt(amount)) return out;
  const when = ethers.getAddress(who) === me ? ready : now() + V5_DELEGATE_WAIT_S;
  throw new PayError("V5_DELEGATE_WAIT",
    `agent #${id}'s line is on SeatVaultV5, which raises it only for the agent's owner, or for the agent's key 24 hours after V5 recorded it${out.noted ? ` (recorded now, tx ${out.noted})` : ""}. `
    + `The line has room for ${room} atomic USDG now. This key can borrow more from ${utc(when)}; before then, the owner can borrow from Go mode, which raises the line first.`,
    { room, readyAt: when, noted: out.noted });
}

/**
 * Borrow what a purchase is short of, from the agent's line, into the payer's wallet. Port of sdk/float.mjs's
 * borrow step; every refusal happens before any transaction (a SeatVaultV5 line's refresh, v5BeforeBorrow, comes
 * first: it is what gives the line its room).
 * @param {{ signer: any, pool: any, agentId?: bigint|number|string, price: bigint, balance: bigint, maxBorrow: bigint,
 *   termSeconds?: bigint|number, maxFee?: bigint, me?: string }} o
 * @returns {Promise<{ borrowed: bigint, loanId: bigint|null, dueAt: bigint|null, fee: bigint, term: bigint }>}
 */
export async function borrowGap({ signer, pool, agentId, price, balance, maxBorrow, termSeconds, maxFee, me, v5, v5Root, ownerOf, agentWalletOf }) {
  const cap = BigInt(maxBorrow ?? 0n);
  if (price > cap) throw new PayError("PRICE_ABOVE_MAX_BORROW", `pay: price ${price} is above maxBorrow ${cap}; not borrowing`, { price, maxBorrow: cap });
  const poolC = pool ? poolContract(pool, signer) : null;
  if (!poolC || agentId === undefined || agentId === null) throw new PayError("NO_POOL", "pay: short of USDG and no pool/agentId to borrow from");
  // the same rule as repaying (GHSA-9pw7): a delegate-only key must not borrow a loan it could not then repay here
  const parties = await agentParties(poolC, signer, agentId, ownerOf, agentWalletOf);
  await needOwnerOrAgentWallet(agentId, parties.holder, me || (await signer.getAddress()), parties.agentWallet, "borrowed");
  const p = await poolC.getParams();
  const shortfall = price - balance;
  const amount = shortfall > p.minLoan ? shortfall : p.minLoan;
  if (amount > cap) throw new PayError("MIN_LOAN_ABOVE_MAX_BORROW", `pay: the pool's minimum loan ${p.minLoan} is above maxBorrow ${cap}; not borrowing`, { amount, maxBorrow: cap });
  if (amount > p.maxLoan) throw new PayError("ABOVE_MAX_LOAN", `pay: ${amount} is above the pool's maxLoan ${p.maxLoan}`);
  let term = termSeconds === undefined ? BigInt(DEFAULT_TERM_SECONDS) : BigInt(termSeconds);
  if (term < p.minTerm) term = p.minTerm;
  if (termSeconds === undefined && term > p.maxTerm) term = p.maxTerm;
  if (term > p.maxTerm) throw new PayError("TERM_OUT_OF_RANGE", `pay: term ${term} is above the pool's maxTerm ${p.maxTerm}`);
  const [fee] = await poolC.quoteFee(agentId, amount, term);
  if (maxFee !== undefined && fee > BigInt(maxFee)) throw new PayError("FEE_TOO_HIGH", `pay: loan fee ${fee} is above maxFee ${maxFee}`);
  const to = me || (await signer.getAddress());
  await v5BeforeBorrow({ signer, pool: poolC, v5, v5Root, agentId, amount, ownerOf });
  // Simulate first: a doomed borrow says why (its custom error) before any gas is spent.
  if (poolC.borrow && typeof poolC.borrow.staticCall === "function") {
    try { await poolC.borrow.staticCall(agentId, amount, term, to, fee); } catch (e) { throw new PayError("BORROW_WOULD_REVERT", `pay: borrow would revert: ${explainRevert(e, poolC.interface)}`); }
  }
  const { rc } = await sendBorrow(poolC, [agentId, amount, term, to, fee], amount, "pay: ");
  const ev = (rc?.logs || []).map((l) => { try { return poolC.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e && e.name === "Borrowed");
  return { borrowed: amount, loanId: ev ? ev.args.loanId : null, dueAt: ev ? ev.args.dueAt : null, fee, term };
}

/**
 * Repay the agent's open loans, earliest due first, while the signer's USDG covers principal + fee (sdk/float.mjs).
 * With `topUp(need)` (e.g. savings), the wallet is first topped up to what all open loans need; a failed top-up is
 * reported in `savings` and the repayments go on with the wallet's balance.
 * With `onlyInWindow` (the runtime's own in-window repay): only the loans whose repay window
 * is open now, AutoRepay's rule (autopay.mjs repayWindow: the last 6 h before due, never before day 7 on a term over a
 * week + 2 h), or that are past due; the others are left in `open` and `waiting` (with when their window opens).
 * Only loans the agent's owner now took are repaid: one opened while someone else held the agent (its `Loan.owner` is
 * another address) stays in `open` and is listed in `others` with who opened it (GHSA-mmp8).
 * @returns {Promise<{ repaid: bigint[], open: bigint[], others: Array<{ loanId: bigint, openedBy: string }>, waiting?: Array<{ loanId: bigint, opens: number }>, savings?: object }>}
 */
export async function settleLoans({ signer, pool, agentId, topUp, onlyInWindow = false, now = () => Math.floor(Date.now() / 1000), ownerOf, agentWalletOf }) {
  const poolC = poolContract(pool, signer);
  const me = await signer.getAddress();
  // Only the signer's own agent: a wrong or stale agentId would otherwise pay a stranger's loans (P-7).
  if (!(await poolC.isController(agentId, me))) throw new PayError("NOT_CONTROLLER", `agent #${agentId} is not controlled by ${me} (neither its owner nor its pool delegate)`);
  // ...and control alone is not proof: the pool lets the owner name any address its delegate, with no word from it, so
  // a signer that is not the owner must be the agent's declared ERC-8004 wallet (GHSA-9pw7)
  const parties = await agentParties(poolC, signer, agentId, ownerOf, agentWalletOf);
  const holder = parties.holder.toLowerCase();
  await needOwnerOrAgentWallet(agentId, holder, me, parties.agentWallet, "repaid");
  const usdg = new ethers.Contract(await poolC.usdg(), ERC20_ABI, signer);
  const ids = await poolC.loansOf(agentId);
  let loans = (await Promise.all(ids.map(async (id) => ({ id, l: await poolC.getLoan(id) })))).filter((x) => x.l.status === LOAN_ACTIVE);
  loans.sort((a, b) => (a.l.dueAt < b.l.dueAt ? -1 : a.l.dueAt > b.l.dueAt ? 1 : 0));
  const repaid = [], open = [], waiting = [], others = [];
  if (loans.length) {
    loans = loans.filter(({ id, l }) => { if (String(l.owner).toLowerCase() === holder) return true; open.push(id); others.push({ loanId: id, openedBy: l.owner }); return false; });
  }
  if (onlyInWindow) {
    const t = now();
    loans = loans.filter(({ id, l }) => { const { opens } = repayWindow(l.issuedAt, l.dueAt); if (t >= opens) return true; open.push(id); waiting.push({ loanId: id, opens }); return false; });
  }
  let balance = await usdg.balanceOf(me);
  let savings;
  const total = loans.reduce((a, { l }) => a + l.principal + l.fee, 0n);
  if (typeof topUp === "function" && balance < total) {
    try { savings = await topUp(total); } catch (e) { savings = { withdrawn: 0n, error: e }; }
    try { balance = await usdg.balanceOf(me); } catch (e) { if (e && typeof e === "object") Object.assign(e, { repaid, open, savings }); throw e; }
  }
  const target = await poolC.getAddress();
  try {
    for (const { id, l } of loans) {
      const due = l.principal + l.fee;
      if (balance < due) { open.push(id); continue; }
      if ((await usdg.allowance(me, target)) < due) await (await usdg.approve(target, due)).wait();
      await (await poolC.repay(id, agentId, due)).wait();
      balance -= due;
      repaid.push(id);
    }
  } catch (e) {
    // what was done is not lost with the error: the loans already repaid, and what the top-up did
    if (e && typeof e === "object") Object.assign(e, { repaid, ...(savings ? { savings } : {}) });
    throw e;
  }
  const out = savings ? { repaid, open, others, savings } : { repaid, open, others };
  return onlyInWindow ? { ...out, waiting } : out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reads and single writes for tools (the MCP server): plain objects with bigint amounts.
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{ runner: any, addresses?: { pool?: string, lens?: string, usdg?: string, registry?: string, stockVault?: string | null } }} o
 */
export function creditContracts({ runner, addresses = {} }) {
  const a = { pool: robinhood.pool, lens: robinhood.lens, usdg: robinhood.usdg, registry: robinhood.registry, stockVault: robinhood.stockVault, seatVaultV5: robinhood.seatVaultV5, seatVaultV5AgentId: robinhood.seatVaultV5AgentId, ...addresses };
  return {
    addresses: a,
    v5: a.seatVaultV5 ? new ethers.Contract(a.seatVaultV5, V5_ABI, runner) : null,
    pool: new ethers.Contract(a.pool, POOL_ABI, runner),
    lens: new ethers.Contract(a.lens, LENS_ABI, runner),
    usdg: new ethers.Contract(a.usdg, ERC20_ABI, runner),
    registry: new ethers.Contract(a.registry, REGISTRY_ABI, runner),
    stockVault: a.stockVault ? new ethers.Contract(a.stockVault, STOCK_VAULT_ABI, runner) : null,
  };
}

/**
 * The stock collateral behind agent `id`'s line, when the stock vault backs it (`sponsor` is the vault's root), else
 * null: { token, amount (token units), value (what the vault prices it at, USDG base units; null while it will not
 * price it for new loans), ltvBps, borrowRoom (what the line can draw now), hold (0, or why new loans wait:
 * STOCK_HOLDS), holdReason, status, closing }.
 */
export async function stockCollateral(c, id, sponsor) {
  if (!c.stockVault || !sponsor) return null;
  if (c._stockRoot === undefined) c._stockRoot = await c.stockVault.agentId();
  if (BigInt(sponsor) !== BigInt(c._stockRoot) || BigInt(c._stockRoot) === 0n) return null;
  const p = await c.stockVault.getPosition(BigInt(id));
  const payout = await payoutOf(c.stockVault, p);
  const [[ok, value], borrowRoom, hold, ltvBps] = await Promise.all([
    vaultValueOf(c.stockVault, p.token, payout), c.stockVault.borrowRoom(BigInt(id)), c.stockVault.lendStatus(p.token).then(Number).catch(() => 0),
    c.stockVault.ltvOf(BigInt(id), p.token).then(BigInt).catch(async () => BigInt((await c.stockVault.params()).ltvBps)),
  ]);
  return {
    token: p.token, amount: p.amount, ...(payout < BigInt(p.amount) ? { payout } : {}), value: ok ? value : null, ltvBps, borrowRoom: BigInt(borrowRoom), hold, holdReason: STOCK_HOLDS[hold] || (hold ? `hold ${hold}` : ""),
    status: POSITION_STATUS[Number(p.status)] || `status ${p.status}`, closing: p.closing,
  };
}

const loanView = (id, l) => ({ loanId: BigInt(id), agentId: l.agentId, sponsorId: l.sponsorId, principal: l.principal, fee: l.fee, due: l.principal + l.fee, issuedAt: Number(l.issuedAt), dueAt: Number(l.dueAt), defaultableAt: Number(l.defaultableAt), status: LOAN_STATUS[Number(l.status)] || "unknown" });

/** An agent's line, record, open loans and score, from the pool and lens; on a stock line, the collateral behind it
 *  and `available` capped by what the stock vault lets it draw (borrowRoom). */
export async function creditStatus(c, agentId) {
  const id = BigInt(agentId);
  const [a, score, owner] = await Promise.all([c.pool.getAgent(id), c.lens.score(id).catch(() => null), c.registry.ownerOf(id).catch(() => null)]);
  const ids = await c.pool.loansOf(id);
  const loans = await Promise.all(ids.map(async (lid) => loanView(lid, await c.pool.getLoan(lid))));
  const blocked = a.defaulted || a.frozen || a.sponsor === 0n;
  const collateral = await stockCollateral(c, id, a.sponsor);
  const pooled = blocked ? 0n : a.delegatedIn > a.principalOut ? a.delegatedIn - a.principalOut : 0n;
  return {
    agentId: id, owner, enrolled: a.enrolledAt !== 0n, isRoot: a.isRoot, defaulted: a.defaulted, frozen: a.frozen,
    sponsor: a.sponsor, premiumBps: a.premiumBps, line: a.delegatedIn, drawn: a.principalOut,
    available: collateral && collateral.borrowRoom < pooled ? collateral.borrowRoom : pooled,
    collateral,
    loansRepaid: a.loansRepaid, qualifiedRepaid: a.qualifiedRepaid, volumeRepaid: a.volumeRepaid, feesPaid: a.feesPaid,
    enrolledAt: Number(a.enrolledAt), score: score === null ? null : Number(score),
    openLoans: loans.filter((l) => l.status === "active").sort((x, y) => x.dueAt - y.dueAt),
  };
}

const FEED_ABI = ["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"];

/**
 * Agent `id`'s stock position (whatever backs its line today), or null when it has none: the collateral fields plus
 * { agentId, symbol (from `assets` when listed), depositor, line, openedAt }. Needs `c.stockVault`.
 * @param {Array<{symbol: string, token: string, decimals: number}>} [assets]
 */
export async function stockPosition(c, id, assets = []) {
  if (!c.stockVault) throw new PayError("NO_STOCK_VAULT", "Priors has no stock vault configured (not deployed yet)");
  const p = await c.stockVault.getPosition(BigInt(id));
  if (Number(p.status) === 0) return null;
  const payout = await payoutOf(c.stockVault, p);
  const [[ok, value], borrowRoom, hold, ltvBps] = await Promise.all([
    vaultValueOf(c.stockVault, p.token, payout), c.stockVault.borrowRoom(BigInt(id)), c.stockVault.lendStatus(p.token).then(Number).catch(() => 0),
    c.stockVault.ltvOf(BigInt(id), p.token).then(BigInt).catch(async () => BigInt((await c.stockVault.params()).ltvBps)),
  ]);
  const a = assets.find((x) => String(x.token).toLowerCase() === String(p.token).toLowerCase()) || null;
  return {
    agentId: BigInt(id), token: p.token, symbol: a ? a.symbol : null, decimals: a ? a.decimals : null, amount: p.amount, ...(payout < BigInt(p.amount) ? { payout } : {}), value: ok ? value : null, ltvBps,
    line: BigInt(p.line), borrowRoom: BigInt(borrowRoom), hold, holdReason: STOCK_HOLDS[hold] || (hold ? `hold ${hold}` : ""),
    status: POSITION_STATUS[Number(p.status)] || `status ${p.status}`, closing: p.closing, depositor: p.depositor, openedAt: Number(p.openedAt),
  };
}

/**
 * The stock tokens in `assets` (e.g. deployments/stock-assets.4663.json's list) as the vault sees them now:
 * [{ symbol, name, token, answer, price, updatedAt, usable, hold, holdReason, ltvBps }]; `usable` is whether the vault
 * would open a line on it now. Needs `c.stockVault`.
 * @param {Array<{symbol: string, name: string, token: string, decimals: number, feed: string, feedDecimals: number}>} assets
 */
export async function stockAssets(c, assets) {
  if (!c.stockVault) throw new PayError("NO_STOCK_VAULT", "Priors has no stock vault configured (not deployed yet)");
  const runner = c.stockVault.runner;
  const defaultLtv = BigInt((await c.stockVault.params()).ltvBps);
  return Promise.all(assets.map(async (a) => {
    const feed = new ethers.Contract(a.feed, FEED_ABI, runner);
    const [round, val, hold, ltv] = await Promise.all([
      feed.latestRoundData().catch(() => null), vaultValueOf(c.stockVault, a.token, 10n ** BigInt(a.decimals)).catch(() => null),
      c.stockVault.lendStatus(a.token).then(Number).catch(() => null), c.stockVault.ltvOf(0n, a.token).then(BigInt).catch(() => defaultLtv),
    ]);
    const answer = round ? BigInt(round.answer) : null;
    return {
      symbol: a.symbol, name: a.name, token: a.token, answer, price: answer === null ? null : Number(answer) / 10 ** a.feedDecimals,
      updatedAt: round ? Number(round.updatedAt) : null, usable: !!(val && val[0]) && !hold, hold, holdReason: hold ? STOCK_HOLDS[hold] || `hold ${hold}` : "", ltvBps: ltv,
    };
  }));
}

/** Quote a borrow and check it against the pool's ranges, without sending anything. */
export async function quoteBorrow(c, agentId, amount, termSeconds) {
  const p = await c.pool.getParams();
  const term = BigInt(termSeconds);
  if (amount < p.minLoan || amount > p.maxLoan) throw new PayError("LOAN_SIZE_OUT_OF_RANGE", `the pool lends between ${p.minLoan} and ${p.maxLoan} atomic USDG per loan`, { minLoan: p.minLoan, maxLoan: p.maxLoan });
  if (term < p.minTerm || term > p.maxTerm) throw new PayError("TERM_OUT_OF_RANGE", `the pool's terms run from ${p.minTerm} to ${p.maxTerm} seconds`, { minTerm: p.minTerm, maxTerm: p.maxTerm });
  const q = await c.pool.quoteFee(BigInt(agentId), amount, term);
  return { amount, term, fee: q.fee, due: amount + q.fee };
}

/** Borrow `amount` for `termSeconds` into the signer's wallet; fee capped at the quote. On a SeatVaultV5 line, its
 *  refresh first (v5BeforeBorrow). Simulates first. */
export async function borrowLine(c, signer, agentId, amount, termSeconds) {
  const pool0 = c.pool.connect(signer);
  const me0 = await signer.getAddress();
  // GHSA-9pw7: borrowing takes the repayment rule, so a key cannot draw a loan this client would refuse to repay
  await needOwnerOrAgentWallet(agentId, String(await c.registry.ownerOf(BigInt(agentId))), me0, () => c.registry.getAgentWallet(BigInt(agentId)), "borrowed");
  const q = await quoteBorrow(c, agentId, amount, termSeconds);
  const pool = pool0;
  const me = me0;
  const v5 = await v5BeforeBorrow({ signer, pool, v5: c.v5 || null, v5Root: c.addresses?.seatVaultV5AgentId ?? null, agentId, amount });
  const args = [BigInt(agentId), amount, q.term, me, q.fee];
  try { await pool.borrow.staticCall(...args); } catch (e) { throw new PayError("BORROW_WOULD_REVERT", `borrow would revert: ${explainRevert(e, pool.interface)}`); }
  const { tx, rc } = await sendBorrow(pool, args, amount, "");
  const ev = rc.logs.map((l) => { try { return pool.interface.parseLog(l); } catch (_) { return null; } }).find((e) => e && e.name === "Borrowed");
  return { hash: tx.hash, loanId: ev ? ev.args.loanId : null, principal: amount, fee: ev ? ev.args.fee : q.fee, dueAt: ev ? Number(ev.args.dueAt) : null, ...(v5.v5 ? { v5Refreshed: v5.refreshed, v5Noted: v5.noted } : {}) };
}

/** Repay one loan in full from the signer's USDG; approves exactly what is due. */
export async function repayLoan(c, signer, loanId) {
  const pool = c.pool.connect(signer);
  const usdg = c.usdg.connect(signer);
  const l = await pool.getLoan(BigInt(loanId));
  if (l.status !== LOAN_ACTIVE) throw new PayError("LOAN_NOT_ACTIVE", `loan #${loanId} is not active (${LOAN_STATUS[Number(l.status)] || "unknown"})`);
  const due = l.principal + l.fee;
  const me = await signer.getAddress();
  // The pool lets anyone repay any loan; this helper spends the signer's USDG only on an agent the signer controls.
  if (!(await pool.isController(l.agentId, me))) throw new PayError("NOT_CONTROLLER", `loan #${loanId} belongs to agent #${l.agentId}, which ${me} does not control (neither its owner nor its pool delegate)`);
  // ...and only a loan its owner now took: one opened while someone else held the agent is theirs (GHSA-mmp8)
  const holder = String(await c.registry.ownerOf(l.agentId));
  if (String(l.owner).toLowerCase() !== holder.toLowerCase()) throw new PayError("NOT_OWNERS_LOAN", `loan #${loanId} was opened by ${l.owner}, which held agent #${l.agentId} then; its owner now (${holder}) did not take it: not repaid`);
  await needOwnerOrAgentWallet(l.agentId, holder, me, () => c.registry.getAgentWallet(l.agentId), "repaid");
  const bal = await usdg.balanceOf(me);
  if (bal < due) throw new PayError("INSUFFICIENT_USDG", `repaying loan #${loanId} needs ${due} atomic USDG but the wallet holds ${bal}`, { due, balance: bal });
  const target = await pool.getAddress();
  if ((await usdg.allowance(me, target)) < due) await (await usdg.approve(target, due)).wait();
  try { await pool.repay.staticCall(BigInt(loanId), l.agentId, due); } catch (e) { throw new PayError("REPAY_WOULD_REVERT", `repay would revert: ${explainRevert(e, pool.interface)}`); }
  const tx = await pool.repay(BigInt(loanId), l.agentId, due);
  await tx.wait();
  return { hash: tx.hash, loanId: BigInt(loanId), agentId: l.agentId, paid: due };
}

/** USDG and native (gas) balance of an address. */
export async function balances(c, provider, address) {
  const [usdg, native] = await Promise.all([c.usdg.balanceOf(address), provider.getBalance(address)]);
  return { address, usdg, native };
}
