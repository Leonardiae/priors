// Priors SDK v2: pool v2 (CreditPoolV2), treasury v4 (TreasurySponsorV4) and seats v2 (SeatVaultV2), in one ESM
// module on ethers v6. The v1 module (sdk/priors.mjs) stays as it is, for the v1 pool.
//
//   import { PriorsV2 } from "./sdk/priors-v2.mjs";
//   const p = new PriorsV2({ signer, addresses });   // addresses: deployments/<chainId>.v2.json (DeployV2 writes it)
//
//   lender   await p.deposit(50); await p.withdraw("all"); await p.position(addr)
//   staker   await p.offer(agentId); await p.withdrawOffer(agentId); await p.closeSeat(agentId)
//            await p.claimSeatFees(to); await p.pendingSeatFees(addr); await p.seatable(agentId); await p.openSeats()
//   backer   await p.enrollRoot(rootId, 20); await p.addStake(rootId, 5)
//            await p.vouchWithConsent(rootId, agentId, 10, premiumBps, consent, sig); await p.claimSponsorFees(rootId, to)
//   agent    const id = await p.register(uri)
//            const { consent, sig } = await p.signConsent({ agentId, sponsorId, maxPremiumBps, deadline })
//            await p.redeemInvite(agentId, "priors-invite:<id>:<expiry>:<sig>")   // treasury v4 first line
//            await p.acceptSeat(agentId, staker)                                  // a staker's seat offer
//            const { loanId } = await p.borrow(agentId, 5, 7 * 86400)             // $5 for 7 days
//            await p.repay(loanId, { agentId }); await p.openLoans(agentId); await p.status(agentId)
//   stocks   (addresses.stockVault) await p.stockAssets(); await p.stockPosition(agentId)
//            await p.openStockLine(agentId, token, "0.05")                        // deposit and open the line
//            await p.addCollateral(agentId, "0.01"); await p.closeStockLine(agentId)
//   PT-USDG  await p.ptQuote({ side: "buy", amount: 100 }); await p.ptPosition(addr)   (sdk/pt-usdg.mjs)
//            await p.ptBuy(100); await p.ptSell("all"); await p.ptRedeem("all")       // { send: false } returns the calls
//            await p.openPtLine(agentId, 50)                                      // once the stock vault lists PT-USDG
//
// Amounts: a number or a decimal string is whole USDG ("5", 5.5); a bigint is raw 6-decimal units. Every write
// simulates first (a revert is explained with the contracts' own custom errors, before any gas is spent) and
// approves the exact USDG or $PRIORS it needs when the allowance is short.
//
// EXTENSION POINT: x402 `pay()` / `settleLoans()` live in sdk/float.mjs, not here. That module adds them with
// `extendPriorsV2({ pay, settleLoans })` (below), which refuses to overwrite a method this file defines. Everything
// it needs is public on an instance: `borrow`, `repay`, `openLoans`, `quoteFee`, `toUnits`, `usdg`, `pool`, `signer`.
import { ethers } from "ethers";
import { parseInvite, explainRevert } from "./priors.mjs";
import { pay as floatPay, resend as floatResend, settleLoans as floatSettleLoans, v5BeforeBorrow, SEAT_VAULT_V5_ABI } from "./float.mjs";
import { PT_USDG, ptQuote, ptBuy, ptSell, ptRedeem, ptPosition, ptListing } from "./pt-usdg.mjs";
import { STOCK_VAULT_ABI, stockAssets as readStockAssets, stockPosition as readStockPosition, collateralOf, borrowable } from "./stock-vault.mjs";

export { parseInvite, explainRevert, SEAT_VAULT_V5_ABI };

// ---------------------------------------------------------------------------------------------------------------
// ABIs (human-readable, from src/CreditPoolV2.sol, src/SeatVaultV2.sol, src/TreasurySponsorV4.sol)
// ---------------------------------------------------------------------------------------------------------------

const CONSENT_T = "tuple(uint256 agentId,uint256 sponsorId,address owner,uint256 maxPremiumBps,uint256 nonce,uint256 deadline)";
const AGENT_T =
  "tuple(bool enrolled,bool isRoot,bool defaulted,bool frozen,bool importedFromV1,uint64 enrolledAt,uint64 lastBorrowAt,uint64 lastRepayAt,uint256 sponsor,uint256 delegatedIn,uint256 delegatedOut,uint256 principalOut,uint256 activeLoans,uint256 premiumBps,uint256 premiumCap,uint256 loansRepaid,uint256 volumeRepaid,uint256 feesPaid,uint256 recourseHonored,uint256 childrenDefaulted,uint256 qualifiedRepaid,uint256 dollarSecondsRepaid)";
const LOAN_T =
  "tuple(uint256 agentId,uint256 sponsorId,uint256 principal,uint256 fee,uint256 sponsorCut,uint256 reserveCut,uint256 premium,address owner,uint64 issuedAt,uint64 dueAt,uint64 defaultableAt,uint64 minScoreTerm,uint64 closedAt,uint8 status)";
const PARAMS_T =
  "tuple(uint256 minLoan,uint256 maxLoan,uint64 minTerm,uint64 maxTerm,uint64 grace,uint64 minScoreTerm,uint256 feeBps,uint256 sponsorFeeBps,uint256 protocolFeeBps,uint256 minStake,uint256 maxUtilizationBps,uint256 keeperBounty)";

export const POOL_V2_ABI = [
  // lenders
  "function deposit(uint256 assets, address receiver, uint256 minShares) returns (uint256)",
  "function withdraw(uint256 shares, address receiver) returns (uint256)",
  "function shares(address) view returns (uint256)",
  "function lastDepositAt(address) view returns (uint64)",
  "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function poolLiquidity() view returns (uint256)",
  "function totalPrincipalOut() view returns (uint256)",
  "function MIN_HOLD() view returns (uint64)",
  "function EARLY_EXIT_BPS() view returns (uint256)",
  // roots
  "function enrollRoot(uint256 rootId, uint256 assets)",
  "function addStake(uint256 rootId, uint256 assets)",
  "function unlock(uint256 rootId, uint256 shares, address to) returns (uint256)",
  "function rootShares(uint256) view returns (uint256)",
  "function backing(uint256) view returns (uint256)",
  "function freeBacking(uint256) view returns (uint256)",
  "function claimSponsorFees(uint256 sponsorId, address to) returns (uint256)",
  "function sponsorFees(uint256) view returns (uint256)",
  "function feesFrom(uint256 sponsorId, uint256 agentId) view returns (uint256)",
  // consent and vouching
  `function consentDigest(${CONSENT_T} c) view returns (bytes32)`,
  "function nonces(uint256) view returns (uint256)",
  `function vouchWithConsent(uint256 sponsorId, uint256 agentId, uint256 amount, uint256 premiumBps, ${CONSENT_T} c, bytes sig)`,
  "function vouch(uint256 sponsorId, uint256 agentId, uint256 amount)",
  "function leave(uint256 agentId)",
  "function setDelegate(uint256 agentId, address delegate)",
  "function isController(uint256 id, address who) view returns (bool)",
  // loans
  "function quoteFee(uint256 agentId, uint256 principal, uint64 term) view returns (uint256 fee, uint256 sponsorCut, uint256 reserveCut, uint256 premium)",
  "function borrow(uint256 agentId, uint256 amount, uint64 term, address to, uint256 maxFee) returns (uint256)",
  "function repay(uint256 loanId, uint256 expectedAgentId, uint256 maxDue)",
  `function getLoan(uint256) view returns (${LOAN_T})`,
  "function loansOf(uint256) view returns (uint256[])",
  "function loanCount() view returns (uint256)",
  `function getAgent(uint256) view returns (${AGENT_T})`,
  `function getParams() view returns (${PARAMS_T})`,
  "function ownerDefaults(address) view returns (uint256)",
  "function custodian(address) view returns (bool)",
  "function pausedUntil() view returns (uint64)",
  "function usdg() view returns (address)",
  "function registry() view returns (address)",
  "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 fee, uint64 dueAt, address to)",
  "event Deposited(address indexed lender, uint256 assets, uint256 shares)",
  "event Withdrawn(address indexed lender, uint256 assets, uint256 shares)",
  // errors
  "error Paused()", "error NotSeeded()", "error AlreadySeeded()", "error ZeroAmount()",
  "error NotOwnerOf(uint256 id, address caller)", "error NotController(uint256 id, address caller)", "error NotGuardian()",
  "error InvalidAgent(uint256 id)", "error NotRoot(uint256 id)", "error IsRoot(uint256 id)", "error AgentDefaulted(uint256 id)",
  "error V1Busy(uint256 id)", "error WrongSponsor(uint256 id, uint256 sponsor)", "error LoanOpen(uint256 id)",
  "error BadConsent()", "error ConsentExpired()", "error PremiumTooHigh(uint256 bps, uint256 cap)",
  "error InsufficientBacking(uint256 rootId, uint256 requested, uint256 free)",
  "error InsufficientCapacity(uint256 id, uint256 requested, uint256 available)",
  "error InsufficientLiquidity(uint256 requested, uint256 available)", "error UtilizationTooHigh()",
  "error LoanSizeOutOfRange(uint256 amount)", "error TermOutOfRange(uint64 term)", "error FeeTooHigh(uint256 fee, uint256 maxFee)",
  "error IsFrozen(uint256 id)", "error OwnerDefaulted(address owner)", "error BorrowBlockedByBacker(uint256 rootId)",
  "error LoanNotActive(uint256 loanId)", "error LoanNotDue(uint256 loanId, uint64 defaultableAt)", "error WrongLoan(uint256 loanId)",
  "error DueTooHigh(uint256 due, uint256 maxDue)", "error BelowMinStake(uint256 amount, uint256 minStake)",
  "error SlippageShares(uint256 minted, uint256 minShares)", "error InvalidHook(address hook)", "error HookNotReady(uint64 eta)",
  "error StillBacking(uint256 rootId)", "error ReserveShort(uint256 requested, uint256 reserve)",
  "error AlreadyImported(uint256 id)", "error NoV1()", "error ImportOutOfRange(uint256 id)", "error InvalidParams()", "error Renounce()",
];

export const SEAT_VAULT_V2_ABI = [
  "function offer(uint256 id)",
  `function accept(uint256 id, address staker, ${CONSENT_T} c, bytes sig)`,
  `function seat(uint256 id, ${CONSENT_T} c, bytes sig)`,
  "function withdrawOffer(uint256 id, address staker)",
  "function close(uint256 id)",
  "function settle(uint256 id, uint256 loanId)",
  "function poke(uint256 id)",
  "function claim(address to) returns (uint256)",
  "function pendingFees(uint256 id) view returns (uint256)",
  "function feesOwed(address) view returns (uint256)",
  "function offers(uint256 id, address staker) view returns (uint256)",
  "function getSeat(uint256 id) view returns (tuple(address staker,uint64 openedAt,bool closing,uint8 status,uint128 line,uint128 burnBps,uint256 amount,uint256 feeMark))",
  "function openSeats() view returns (uint256[])",
  "function seatable(uint256 id) view returns (bool)",
  "function epochRoom() view returns (uint256)",
  "function seatsPaused() view returns (bool)",
  "function params() view returns (uint256 seatSize, uint256 line, uint256 burnBps, uint256 maxOpenSeats, uint256 epochCap, uint64 epochLength)",
  "function agentId() view returns (uint256)",
  "function token() view returns (address)",
  "error Reentrancy()", "error NotAdopted()", "error AlreadyAdopted()", "error NotOurs(uint256 agentId)", "error Paused()",
  "error ZeroAmount()", "error NotController(uint256 agentId, address caller)", "error NoOffer(uint256 agentId, address staker)",
  "error OfferExists(uint256 agentId, address staker)", "error OfferTooSmall(uint256 agentId, uint256 offered, uint256 seatSize)",
  "error TermsChanged(uint256 agentId)", "error NotSeatable(uint256 agentId)", "error NoOpenSeat(uint256 agentId)",
  "error NotStakerOrController(uint256 agentId, address caller)", "error AgentDefaulted(uint256 agentId)",
  "error StillBacked(uint256 agentId)", "error BadProof(uint256 agentId, uint256 loanId)",
  "error TooManySeats(uint256 open, uint256 max)", "error EpochCapReached(uint256 wanted, uint256 left)",
  "error BadTransfer(uint256 expected, uint256 received)", "error InvalidParams()", "error Protected(address token)",
];

export const TREASURY_V4_ABI = [
  `function firstLine(uint256 id, uint64 expiry, bytes invite, ${CONSENT_T} c, bytes consentSig)`,
  "function inviteDigest(uint256 id, uint64 expiry) view returns (bytes32)",
  "function inviters(address) view returns (bool)",
  "function inviteUsed(bytes32) view returns (bool)",
  "function firstLined(uint256) view returns (bool)",
  "function agentId() view returns (uint256)",
  "function epochRoom() view returns (uint256)",
  "function raise(uint256 id)",
  "function eligibleForRaise(uint256 id) view returns (bool)",
  "function rules() view returns (uint256 reserveBps, uint256 firstLine, uint256 secondLine, uint256 epochCap, uint64 epochLength, uint64 minSeasoning, uint256 minQualified, uint256 minScore, uint64 idleAfter)",
  "error NotAdopted()", "error AlreadyAdopted()", "error NotOurs(uint256 agentId)", "error AlreadyLined(uint256 agentId)",
  "error NotEligible(uint256 agentId)", "error OwnerDefaulted(address owner)", "error EpochCapReached(uint256 wanted, uint256 left)",
  "error NotInvited(uint256 agentId, address signer)", "error InviteExpired(uint256 agentId, uint64 expiry)",
  "error InviteUsed(uint256 agentId)", "error NotIdle(uint256 agentId, uint256 reclaimableAt)", "error LoanOpen(uint256 agentId)",
  "error NothingToReclaim(uint256 agentId)", "error InvalidRules()", "error InvalidAddress()", "error UseSweep()", "error TransferFailed()",
  // OpenZeppelin ECDSA, reached from firstLine when the invite is not a signature at all
  "error ECDSAInvalidSignature()", "error ECDSAInvalidSignatureLength(uint256 length)", "error ECDSAInvalidSignatureS(bytes32 s)",
];

const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  // OpenZeppelin v5 ERC-20 errors, in case a token raises them
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
];
const REGISTRY_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function register(string) returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "error ERC721NonexistentToken(uint256 tokenId)",
];

export const LOAN_STATUS = ["none", "active", "repaid", "defaulted"];
export const SEAT_STATUS = ["none", "open", "closed", "settled"];

/** EIP-712 for pool consents: CreditPoolV2's constructor says EIP712("Priors Credit", "2"). */
export const CONSENT_TYPES = {
  Consent: [
    { name: "agentId", type: "uint256" },
    { name: "sponsorId", type: "uint256" },
    { name: "owner", type: "address" },
    { name: "maxPremiumBps", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
export const INVITE_TYPES = { Invite: [{ name: "agentId", type: "uint256" }, { name: "expiry", type: "uint64" }] };

// ---------------------------------------------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------------------------------------------

/** USDG: a bigint is raw units; a number or decimal string is whole dollars (6 decimals, exact for strings). */
export function toUnits(amount) {
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`not an amount: ${amount}`);
    return ethers.parseUnits(amount.toFixed(6), 6);
  }
  const s = String(amount ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`not an amount: ${JSON.stringify(amount)} (use e.g. 5 or 12.5)`);
  return ethers.parseUnits(s, 6);
}
export const fmtUsdg = (units) => ethers.formatUnits(units, 6);
export const fmtPriors = (units) => ethers.formatUnits(units, 18);

// ---------------------------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------------------------

/**
 * Simulate, then send with 25% gas headroom (same reasons as sdk/priors.mjs: a doomed transaction returns its
 * reason only before the send, and a bare estimate can undershoot a branch taken at mining time).
 */
async function sendChecked(contract, method, args, ifaces) {
  const fn = contract.getFunction(method);
  try {
    await fn.staticCall(...args);
  } catch (err) {
    const shown = args.map((a) => (typeof a === "string" && a.length > 80 ? a.slice(0, 12) + "…" : typeof a === "object" && a !== null && !Array.isArray(a) ? "{…}" : String(a)));
    const e = new Error(`${method.split("(")[0]}(${shown.join(", ")}) would revert: ${explainRevert(err, ifaces)}`);
    e.cause = err;
    throw e;
  }
  let overrides = {};
  try {
    const est = await fn.estimateGas(...args);
    overrides = { gasLimit: est + est / 4n };
  } catch (_) { /* let ethers estimate on its own */ }
  const tx = await fn(...args, overrides);
  const rc = await tx.wait();
  if (!rc || rc.status !== 1) throw new Error(`${method.split("(")[0]} mined with status 0 (tx ${tx.hash})`);
  return rc;
}

const consentTuple = (c) => [BigInt(c.agentId), BigInt(c.sponsorId), c.owner, BigInt(c.maxPremiumBps), BigInt(c.nonce), BigInt(c.deadline)];

// ---------------------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------------------

export class PriorsV2 {
  /**
   * @param {{ signer?: any, provider?: any, rpc?: string,
   *           addresses: { pool: string, treasuryV4?: string, seatVault?: string, seatVaultV4?: string, usdg?: string, registry?: string, priors?: string, stockVault?: string,
   *                        seatVaultV5?: string, seatVaultV5AgentId?: number } }} opts
   * With `seatVaultV4` (the growth seat vault), new seats go to it; a seat already open stays on its own vault.
   * With `seatVaultV5` and `seatVaultV5AgentId` (SeatVaultV5 and its root), `borrow` and `pay` on a line V5 sponsors take
   * its step first (float.mjs `v5BeforeBorrow`).
   */
  constructor(opts = {}) {
    const a = opts.addresses || {};
    if (!a.pool) throw new Error("addresses.pool is required");
    this.provider = opts.provider || opts.signer?.provider || (opts.rpc ? new ethers.JsonRpcProvider(opts.rpc, undefined, { cacheTimeout: -1 }) : null);
    if (!this.provider) throw new Error("give a signer connected to a provider, a provider, or an rpc");
    this.signer = opts.signer ? (opts.signer.provider ? opts.signer : opts.signer.connect(this.provider)) : null;
    this.addresses = a;
    const run = this.signer || this.provider;
    this.pool = new ethers.Contract(a.pool, POOL_V2_ABI, run);
    this.treasury = a.treasuryV4 ? new ethers.Contract(a.treasuryV4, TREASURY_V4_ABI, run) : null;
    this.vault = a.seatVault ? new ethers.Contract(a.seatVault, SEAT_VAULT_V2_ABI, run) : null;
    this.vaultV4 = a.seatVaultV4 ? new ethers.Contract(a.seatVaultV4, SEAT_VAULT_V2_ABI, run) : null;
    this.usdg = a.usdg ? new ethers.Contract(a.usdg, ERC20_ABI, run) : null;
    this.token = a.priors ? new ethers.Contract(a.priors, ERC20_ABI, run) : null;
    this.registry = a.registry ? new ethers.Contract(a.registry, REGISTRY_ABI, run) : null;
    this.stockVault = a.stockVault ? new ethers.Contract(a.stockVault, STOCK_VAULT_ABI, run) : null;
    this.vaultV5 = a.seatVaultV5 ? new ethers.Contract(a.seatVaultV5, SEAT_VAULT_V5_ABI, run) : null;
    // every interface a call here can revert with: a vault or treasury call bubbles the pool's errors up
    this._ifaces = [this.pool.interface, ...(this.vault ? [this.vault.interface] : []), ...(this.vaultV4 ? [this.vaultV4.interface] : []), ...(this.treasury ? [this.treasury.interface] : []), ...(this.stockVault ? [this.stockVault.interface] : []), ...(this.vaultV5 ? [this.vaultV5.interface] : []), new ethers.Interface(ERC20_ABI), new ethers.Interface(REGISTRY_ABI)];
    this.toUnits = toUnits;
  }

  /** A revert as `Name(args)`, decoded against every v2 ABI. */
  explain(err) { return explainRevert(err, this._ifaces); }

  async _usdg() {
    if (!this.usdg) this.usdg = new ethers.Contract(await this.pool.usdg(), ERC20_ABI, this.signer || this.provider);
    return this.usdg;
  }
  async _registry() {
    if (!this.registry) this.registry = new ethers.Contract(await this.pool.registry(), REGISTRY_ABI, this.signer || this.provider);
    return this.registry;
  }
  _needSigner() { if (!this.signer) throw new Error("this call needs a signer"); }
  _need(c, name) { if (!c) throw new Error(`no ${name} address configured`); return c; }
  async me() { this._needSigner(); return this.signer.getAddress(); }

  /** Approve `spender` for exactly `amount` of `token` if the allowance is short; also checks the balance. */
  async _ensure(token, spender, amount, what) {
    const me = await this.me();
    const bal = await token.balanceOf(me);
    if (bal < amount) throw new Error(`${what}: needs ${amount} units but ${me} holds ${bal}`);
    if ((await token.allowance(me, spender)) < amount) await sendChecked(token, "approve", [spender, amount], this._ifaces);
  }

  // ---- lenders -------------------------------------------------------------------------------------------------

  /** Deposit USDG for pool shares. `minShares` defaults to the quote less 0.5% (the share price only rises). */
  async deposit(amount, { receiver, minShares } = {}) {
    const assets = toUnits(amount);
    const me = await this.me();
    const usdg = await this._usdg();
    await this._ensure(usdg, await this.pool.getAddress(), assets, "deposit");
    const min = minShares ?? ((await this.pool.convertToShares(assets)) * 995n) / 1000n;
    const rc = await sendChecked(this.pool, "deposit", [assets, receiver || me, min], this._ifaces);
    const ev = this._event(rc, "Deposited");
    return { hash: rc.hash, assets, shares: ev ? ev.args.shares : null };
  }

  /** Withdraw `shares` (bigint) or `'all'`. Inside the 7-day hold, 0.5% stays with the pool. */
  async withdraw(shares = "all", { receiver } = {}) {
    const me = await this.me();
    const s = shares === "all" ? await this.pool.shares(me) : BigInt(shares);
    if (s === 0n) throw new Error(`${me} holds no pool shares`);
    const rc = await sendChecked(this.pool, "withdraw", [s, receiver || me], this._ifaces);
    const ev = this._event(rc, "Withdrawn");
    return { hash: rc.hash, shares: s, assets: ev ? ev.args.assets : null };
  }

  /** A lender's shares, their value now, and when the early-exit fee stops applying. */
  async position(addr) {
    const who = addr || (await this.me());
    const [shares, last, hold] = await Promise.all([this.pool.shares(who), this.pool.lastDepositAt(who), this.pool.MIN_HOLD()]);
    const value = shares === 0n ? 0n : await this.pool.convertToAssets(shares);
    return { address: who, shares, value, lastDepositAt: Number(last), feeFreeAt: last === 0n ? 0 : Number(last + hold) };
  }

  // ---- stakers (seat vault) ------------------------------------------------------------------------------------

  /** The seat vaults, the growth seat vault (V4) first once recorded. */
  _vaults() { return [this.vaultV4, this.vault].filter(Boolean); }
  _needAnyVault() { if (!this.vault && !this.vaultV4) throw new Error("no seatVault address configured"); }
  /** Where new seats go: the growth seat vault (V4) once recorded, else `seatVault`. */
  _newSeatVault() { return this.vaultV4 || this._need(this.vault, "seatVault"); }
  /** The vault whose root sponsors `agentId`, else the one holding an open seat for it, else where new seats go. */
  async _seatVaultOf(agentId) {
    const vs = this._vaults();
    if (vs.length === 1) return vs[0];
    const [a, roots] = await Promise.all([this.pool.getAgent(agentId), Promise.all(vs.map((v) => v.agentId()))]);
    const i = roots.findIndex((r) => r === a.sponsor);
    if (i >= 0) return vs[i];
    for (const v of vs) if (SEAT_STATUS[Number((await v.getSeat(agentId)).status)] === "open") return v;
    return this._newSeatVault();
  }
  /** The vault holding `staker`'s offer on `agentId` (V4 first), or null. */
  async _offerVault(agentId, staker) {
    for (const v of this._vaults()) if ((await v.offers(agentId, staker)) !== 0n) return v;
    return null;
  }
  /** `staker`'s untaken offer on `agentId`: the vault it waits on and its $PRIORS, or null. */
  async seatOffer(agentId, staker) {
    const v = await this._offerVault(agentId, staker);
    return v ? { seatVault: await v.getAddress(), amount: await v.offers(agentId, staker) } : null;
  }

  /** Escrow a seat's worth of $PRIORS behind `agentId` (approved automatically). Nothing is vouched until accepted. */
  async offer(agentId) {
    const vault = this._newSeatVault();
    const token = this.token || (this.token = new ethers.Contract(await vault.token(), ERC20_ABI, this.signer));
    const { seatSize } = await vault.params();
    await this._ensure(token, await vault.getAddress(), seatSize, "offer");
    return { hash: (await sendChecked(vault, "offer", [agentId], this._ifaces)).hash, seatSize, seatVault: await vault.getAddress() };
  }
  /** Take back an untaken offer (the staker's own by default). */
  async withdrawOffer(agentId, staker) {
    const who = staker || (await this.me());
    const vault = (await this._offerVault(agentId, who)) || this._newSeatVault();
    return (await sendChecked(vault, "withdrawOffer", [agentId, who], this._ifaces)).hash;
  }
  /** Close a seat (staker or agent controller). With a loan open it closes when the last one is repaid. */
  async closeSeat(agentId) {
    this._needAnyVault();
    const vault = await this._seatVaultOf(agentId);
    return (await sendChecked(vault, "close", [agentId], this._ifaces)).hash;
  }
  /**
   * Pay out the USDG fees credited to the caller, on every seat vault. Pokes the caller's open seats first so nothing
   * is left behind. `hash` is the last claim's; `hashes` has one per vault that paid. If a later vault's claim fails,
   * the error carries `partial` ({ hashes, amount }) for the claims already made.
   */
  async claimSeatFees(to) {
    this._needAnyVault();
    const me = await this.me();
    let amount = 0n;
    const hashes = [];
    for (const vault of this._vaults()) {
      try {
        for (const id of await vault.openSeats()) {
          const s = await vault.getSeat(id);
          if (s.staker.toLowerCase() === me.toLowerCase() && (await vault.pendingFees(id)) > 0n) await sendChecked(vault, "poke", [id], this._ifaces);
        }
        const owed = await vault.feesOwed(me);
        if (owed === 0n) continue;
        hashes.push((await sendChecked(vault, "claim", [to || me], this._ifaces)).hash);
        amount += owed;
      } catch (e) {
        if (hashes.length) e.partial = { hashes, amount };
        throw e;
      }
    }
    if (amount === 0n) throw new Error(`no seat fees owed to ${me}`);
    return { hash: hashes[hashes.length - 1], hashes, amount };
  }
  /** Fees owed to `addr`: credited, plus what its open seats would be credited now. */
  async pendingSeatFees(addr) {
    this._needAnyVault();
    const who = (addr || (await this.me())).toLowerCase();
    let total = 0n;
    for (const vault of this._vaults()) {
      total += await vault.feesOwed(who);
      for (const id of await vault.openSeats()) {
        const s = await vault.getSeat(id);
        if (s.staker.toLowerCase() === who) total += await vault.pendingFees(id);
      }
    }
    return total;
  }
  /** Whether a seat could open behind `agentId` now (the vault's own check). */
  async seatable(agentId) { return this._newSeatVault().seatable(agentId); }
  /**
   * The seats open now. There is no cheap on-chain list of every seatable identity (the registry is not
   * enumerable); filter candidate ids with `seatableAgents(ids)`.
   */
  async openSeats() {
    this._needAnyVault();
    const out = [];
    for (const vault of this._vaults()) {
      const at = await vault.getAddress();
      for (const id of await vault.openSeats()) out.push({ agentId: Number(id), seatVault: at, ...this._seat(await vault.getSeat(id)) });
    }
    return out;
  }
  async seatableAgents(ids) {
    const vault = this._newSeatVault();
    const ok = await Promise.all(ids.map((id) => vault.seatable(id)));
    return ids.filter((_, i) => ok[i]).map(Number);
  }
  _seat(s) {
    return { staker: s.staker, openedAt: Number(s.openedAt), closing: s.closing, status: SEAT_STATUS[Number(s.status)], line: BigInt(s.line), burnBps: Number(s.burnBps), amount: s.amount };
  }

  // ---- backers (roots) -----------------------------------------------------------------------------------------

  /** Make `rootId` (an identity the signer owns) a backer with `stake` USDG locked as pool shares. */
  async enrollRoot(rootId, stake) {
    const assets = toUnits(stake);
    await this._ensure(await this._usdg(), await this.pool.getAddress(), assets, "enrollRoot");
    return (await sendChecked(this.pool, "enrollRoot", [rootId, assets], this._ifaces)).hash;
  }
  /** Add stake behind a root. Anyone may; only the root's owner can take it out. */
  async addStake(rootId, amount) {
    const assets = toUnits(amount);
    await this._ensure(await this._usdg(), await this.pool.getAddress(), assets, "addStake");
    return (await sendChecked(this.pool, "addStake", [rootId, assets], this._ifaces)).hash;
  }
  /**
   * Open (or hand off to) a sponsorship of `line` USDG at `premiumBps`, with the consent the agent's owner signed
   * (`signConsent`). Only the sponsor's owner can call it.
   */
  async vouchWithConsent(sponsorId, agentId, line, premiumBps, consent, sig) {
    return (await sendChecked(this.pool, "vouchWithConsent", [sponsorId, agentId, toUnits(line), premiumBps, consentTuple(consent), sig], this._ifaces)).hash;
  }
  /** Claim a root's sponsor fees to `to` (default: the signer). */
  async claimSponsorFees(sponsorId, to) {
    const me = await this.me();
    const amount = await this.pool.sponsorFees(sponsorId);
    if (amount === 0n) throw new Error(`root #${sponsorId} has no sponsor fees to claim`);
    const rc = await sendChecked(this.pool, "claimSponsorFees", [sponsorId, to || me], this._ifaces);
    return { hash: rc.hash, amount };
  }
  /** A root's stake and fees. */
  async root(rootId) {
    const [a, shares, backing, free, fees] = await Promise.all([this.pool.getAgent(rootId), this.pool.rootShares(rootId), this.pool.backing(rootId), this.pool.freeBacking(rootId), this.pool.sponsorFees(rootId)]);
    return { isRoot: a.isRoot, shares, backing, freeBacking: free, delegatedOut: a.delegatedOut, sponsorFees: fees };
  }

  // ---- agents --------------------------------------------------------------------------------------------------

  /**
   * Register a new ERC-8004 identity; returns its id, read from the registry's ERC-721 mint log to the signer
   * (the registry-specific `Registered` event differs between implementations; see sdk/priors.mjs).
   */
  async register(uri = "") {
    const reg = await this._registry();
    const me = (await this.me()).toLowerCase();
    const rc = await sendChecked(reg, "register", [uri], this._ifaces);
    const T = ethers.id("Transfer(address,address,uint256)");
    const ZERO = ethers.ZeroHash;
    const regAddr = (await reg.getAddress()).toLowerCase();
    const ours = rc.logs.filter((l) => l.address.toLowerCase() === regAddr && l.topics.length === 4 && l.topics[0] === T && l.topics[1] === ZERO && ethers.getAddress("0x" + l.topics[2].slice(26)).toLowerCase() === me);
    if (ours.length !== 1) throw new Error(`expected one identity minted to ${me} in tx ${rc.hash}, found ${ours.length}`);
    return Number(BigInt(ours[0].topics[3]));
  }

  /**
   * Sign the pool consent that lets `sponsorId` back `agentId`, as the agent's NFT owner. EIP-712 on the pool:
   * domain "Priors Credit" v2, Consent(agentId, sponsorId, owner, maxPremiumBps, nonce, deadline). The nonce is the
   * agent's current one, so a consent is good for exactly one vouchWithConsent. Checked against the pool's own
   * `consentDigest` before it is handed back, so a domain mismatch fails here, not as `BadConsent` on chain.
   */
  async signConsent({ agentId, sponsorId, maxPremiumBps = 0, deadline, nonce } = {}) {
    const owner = await this.me();
    const onchainOwner = await (await this._registry()).ownerOf(agentId);
    if (onchainOwner.toLowerCase() !== owner.toLowerCase()) throw new Error(`agent #${agentId} is owned by ${onchainOwner}, not by the signer ${owner}: only the owner can consent`);
    const { chainId } = await this.provider.getNetwork();
    const now = (await this.provider.getBlock("latest")).timestamp;
    const consent = {
      agentId: BigInt(agentId),
      sponsorId: BigInt(sponsorId),
      owner,
      maxPremiumBps: BigInt(maxPremiumBps),
      nonce: nonce ?? (await this.pool.nonces(agentId)),
      deadline: BigInt(deadline ?? now + 3600),
    };
    const domain = { name: "Priors Credit", version: "2", chainId, verifyingContract: await this.pool.getAddress() };
    const sig = await this.signer.signTypedData(domain, CONSENT_TYPES, consent);
    const want = await this.pool.consentDigest(consentTuple(consent));
    if (ethers.TypedDataEncoder.hash(domain, CONSENT_TYPES, consent) !== want) throw new Error("consent digest does not match the pool's consentDigest (wrong pool address or chain?)");
    return { consent, sig };
  }

  /**
   * Redeem a treasury v4 invite (`priors-invite:<agentId>:<expiry>:<sig>`) for a first line: the inviter's signature
   * plus the owner's pool consent naming the treasury's root. The signer must own `agentId`.
   */
  async redeemInvite(agentId, inviteCode) {
    const t4 = this._need(this.treasury, "treasuryV4");
    const inv = parseInvite(inviteCode, agentId);
    const signer = ethers.recoverAddress(await t4.inviteDigest(agentId, inv.expiry), inv.signature);
    if (!(await t4.inviters(signer))) throw new Error(`the invite for #${agentId} was signed by ${signer}, which treasury v4 has not named an inviter (signed for another treasury version?)`);
    const sponsorId = await t4.agentId();
    const { consent, sig } = await this.signConsent({ agentId, sponsorId, maxPremiumBps: 0 });
    const rc = await sendChecked(t4, "firstLine", [agentId, inv.expiry, inv.signature, consentTuple(consent), sig], this._ifaces);
    return { hash: rc.hash, sponsorId: Number(sponsorId) };
  }

  /** Take staker `staker`'s seat offer on `agentId` (on whichever seat vault it waits): the vault vouches its line with the owner's consent. */
  async acceptSeat(agentId, staker) {
    this._needAnyVault();
    const vault = await this._offerVault(agentId, staker);
    if (!vault) throw new Error(`no seat offer from ${staker} on agent #${agentId}`);
    const sponsorId = await vault.agentId();
    const { consent, sig } = await this.signConsent({ agentId, sponsorId, maxPremiumBps: 0 });
    const rc = await sendChecked(vault, "accept", [agentId, staker, consentTuple(consent), sig], this._ifaces);
    return { hash: rc.hash, sponsorId: Number(sponsorId), seatVault: await vault.getAddress() };
  }

  /** The fee for `amount` over `termSeconds` for this agent (its sponsor's premium included), from the pool. */
  async quoteFee(agentId, amount, termSeconds) {
    const q = await this.pool.quoteFee(agentId, toUnits(amount), BigInt(termSeconds));
    return { fee: q.fee, sponsorCut: q.sponsorCut, reserveCut: q.reserveCut, premium: q.premium };
  }

  /**
   * Borrow `amount` for `termSeconds`. USDG lands in `to` (default: the signer). `maxFee` defaults to the pool's
   * own quote, so a premium raised between quote and mining reverts (FeeTooHigh) instead of costing more.
   * On a SeatVaultV5 line (`seatVaultV5` and `seatVaultV5AgentId` in the addresses), V5's step first (float.mjs
   * `v5BeforeBorrow`: the owner's refresh, or the key's noteDelegate); the result then says `v5Refreshed`, `v5Noted`.
   */
  async borrow(agentId, amount, termSeconds, { to, maxFee } = {}) {
    const units = toUnits(amount);
    const term = BigInt(termSeconds);
    const fee = maxFee ?? (await this.pool.quoteFee(agentId, units, term)).fee;
    if (this.vaultV5) this._needSigner();
    const v5 = await v5BeforeBorrow({ signer: this.signer, pool: this.pool, v5: this.vaultV5, v5Root: this.addresses.seatVaultV5AgentId ?? null, agentId, amount: units });
    const rc = await sendChecked(this.pool, "borrow", [agentId, units, term, to || (await this.me()), fee], this._ifaces);
    const ev = this._event(rc, "Borrowed");
    if (!ev) throw new Error("Borrowed event not found");
    return { hash: rc.hash, loanId: Number(ev.args.loanId), principal: ev.args.principal, fee: ev.args.fee, dueAt: Number(ev.args.dueAt), ...(v5.v5 ? { v5Refreshed: v5.refreshed, v5Noted: v5.noted } : {}) };
  }

  /**
   * Repay a loan of `agentId` in full; approves USDG for exactly what is due. `agentId` is the caller's own agent, and
   * the pool refuses the loan if it is another agent's, whatever the RPC says (own audit 2026-10-01: the loan's agent
   * id, read from the RPC, was passed back, so the pool's check could not fail and a lying RPC or a wrong loan id paid a
   * stranger's loan; P-7's controller guard was missing too).
   */
  async repay(loanId, { agentId } = {}) {
    if (agentId === undefined || agentId === null) throw new Error("repay(loanId, { agentId }): name the agent whose loan this is; the pool refuses the loan if it is another agent's");
    const l = await this.pool.getLoan(loanId);
    if (Number(l.status) !== 1) throw new Error(`loan #${loanId} is not active (${LOAN_STATUS[Number(l.status)]})`);
    if (BigInt(agentId) !== l.agentId) throw new Error(`loan #${loanId} is agent #${l.agentId}'s, not #${agentId}'s: not repaid`);
    const me = await this.me();
    if (!(await this.pool.isController(l.agentId, me))) throw new Error(`loan #${loanId} belongs to agent #${l.agentId}, which ${me} does not control: not repaid`);
    // ...and only a loan the agent's owner now took: one opened while someone else held the agent is theirs (GHSA-mmp8,
    // GHSA-5c2h), and controlling the agent now does not make it this key's to pay
    const holder = await (await this._registry()).ownerOf(l.agentId);
    if (String(l.owner).toLowerCase() !== String(holder).toLowerCase()) throw new Error(`loan #${loanId} was opened by ${l.owner}, which held agent #${l.agentId} then; its owner now (${holder}) did not take it: not repaid`);
    const due = l.principal + l.fee;
    await this._ensure(await this._usdg(), await this.pool.getAddress(), due, `repay(${loanId})`);
    const rc = await sendChecked(this.pool, "repay", [loanId, BigInt(agentId), due], this._ifaces);
    return { hash: rc.hash, loanId: Number(loanId), paid: due };
  }

  /** Every loan of an agent, decoded. */
  async loans(agentId) {
    const ids = await this.pool.loansOf(agentId);
    return Promise.all(ids.map(async (id) => this._loan(id, await this.pool.getLoan(id))));
  }
  /** The agent's active loans. */
  async openLoans(agentId) { return (await this.loans(agentId)).filter((l) => l.status === "active"); }
  _loan(id, l) {
    return { loanId: Number(id), agentId: Number(l.agentId), sponsorId: Number(l.sponsorId), principal: l.principal, fee: l.fee, due: l.principal + l.fee, issuedAt: Number(l.issuedAt), dueAt: Number(l.dueAt), defaultableAt: Number(l.defaultableAt), status: LOAN_STATUS[Number(l.status)] };
  }

  /** Where an agent stands: identity, sponsor (which kind), line, loans, seat, stock collateral, and the owner's USDG.
   *  For a stock line `available` is capped by the vault's borrowRoom (collateralOf). */
  async status(agentId) {
    const reg = await this._registry();
    const owner = await reg.ownerOf(agentId).catch(() => null);
    const a = await this.pool.getAgent(agentId);
    const vs = this._vaults();
    const [tRoot, vRoots, sRoot] = await Promise.all([this.treasury ? this.treasury.agentId() : 0n, Promise.all(vs.map((v) => v.agentId())), this.stockVault ? this.stockVault.agentId() : 0n]);
    const sponsor = a.sponsor;
    const onStock = sponsor !== 0n && sponsor === sRoot;
    const onSeat = sponsor !== 0n && vRoots.includes(sponsor);
    const sponsorKind = sponsor === 0n ? "none" : sponsor === tRoot ? "treasury v4" : onSeat ? "seat vault" : onStock ? "stock vault" : "backer";
    // the seat vault that sponsors it, else the one holding an open seat for it, else where new seats go
    const seatVault = vs.length ? (onSeat ? vs[vRoots.indexOf(sponsor)] : await this._seatVaultOf(agentId)) : null;
    const collateral = onStock ? collateralOf(await readStockPosition(this.stockVault, agentId)) : null;
    const available = borrowable(a.delegatedIn > a.principalOut ? a.delegatedIn - a.principalOut : 0n, collateral);
    const seat = seatVault ? this._seat(await seatVault.getSeat(agentId)) : null;
    const usdg = await this._usdg();
    return {
      agentId: Number(agentId), owner, enrolled: a.enrolled, isRoot: a.isRoot, defaulted: a.defaulted, frozen: a.frozen,
      sponsor: Number(sponsor), sponsorKind, seatVault: onSeat ? await seatVault.getAddress() : null, premiumBps: Number(a.premiumBps),
      line: a.delegatedIn, principalOut: a.principalOut, available, activeLoans: Number(a.activeLoans),
      loansRepaid: Number(a.loansRepaid), qualifiedRepaid: Number(a.qualifiedRepaid), volumeRepaid: a.volumeRepaid, feesPaid: a.feesPaid,
      openLoans: await this.openLoans(agentId),
      seat: seat && seat.status !== "none" ? { ...seat, seatVault: await seatVault.getAddress() } : null,
      collateral,
      ownerUsdg: owner ? await usdg.balanceOf(owner) : 0n,
    };
  }

  // ---- stock lines (addresses.stockVault) ----

  /** Every accepted stock token with its price, whether the vault lends against it now, its hold and its LTV. */
  async stockAssets() { return readStockAssets(this.provider, await this._need(this.stockVault, "stockVault").getAddress()); }

  /** Agent `agentId`'s stock position (the tokens behind its line, their value, the line's room), or null. */
  async stockPosition(agentId) { return readStockPosition(this._need(this.stockVault, "stockVault"), agentId); }

  /** `amount` of `token` in its own units: a bigint is raw, a number or decimal string is whole tokens. */
  async _tokenUnits(token, amount) {
    if (typeof amount === "bigint") return amount;
    const t = new ethers.Contract(token, ["function decimals() view returns (uint8)"], this.provider);
    return ethers.parseUnits(String(amount), Number(await t.decimals()));
  }

  /**
   * Deposit `amount` of an accepted stock `token` behind agent `agentId` and open its line (the owner signs the pool
   * consent naming the vault's root; the signer is the depositor and gets the tokens back on close). An agent backed
   * elsewhere moves to the vault only with no loan open (the pool's handoff).
   */
  async openStockLine(agentId, token, amount, { maxPremiumBps = 0, deadline } = {}) {
    const v = this._need(this.stockVault, "stockVault");
    const units = await this._tokenUnits(token, amount);
    const { consent, sig } = await this.signConsent({ agentId, sponsorId: await v.agentId(), maxPremiumBps, deadline });
    const t = new ethers.Contract(token, ERC20_ABI, this.signer);
    await this._ensure(t, await v.getAddress(), units, `openStockLine(${agentId})`);
    const rc = await sendChecked(v, "open", [BigInt(agentId), ethers.getAddress(token), units, consentTuple(consent), sig], this._ifaces);
    return { hash: rc.hash, agentId: Number(agentId), position: await this.stockPosition(agentId) };
  }

  /** Add `amount` of the position's own token (the depositor only): a higher borrow limit. */
  async addCollateral(agentId, amount) {
    const v = this._need(this.stockVault, "stockVault");
    const p = await v.getPosition(BigInt(agentId));
    if (Number(p.status) !== 1) throw new Error(`agent #${agentId} has no open stock position`);
    const units = await this._tokenUnits(p.token, amount);
    await this._ensure(new ethers.Contract(p.token, ERC20_ABI, this.signer), await v.getAddress(), units, `addCollateral(${agentId})`);
    const rc = await sendChecked(v, "addCollateral", [BigInt(agentId), units], this._ifaces);
    return { hash: rc.hash, agentId: Number(agentId), position: await this.stockPosition(agentId) };
  }

  /** Close agent `agentId`'s stock line (depositor or controller): no new loans; the tokens go back to the depositor
   *  now with no loan open, otherwise with the repayment of the last one. */
  async closeStockLine(agentId) {
    this._needSigner();
    const rc = await sendChecked(this._need(this.stockVault, "stockVault"), "close", [BigInt(agentId)], this._ifaces);
    return { hash: rc.hash, agentId: Number(agentId), position: await this.stockPosition(agentId) };
  }

  _event(rc, name) {
    const pool = this.pool.target.toLowerCase();
    for (const log of rc.logs) {
      if (log.address.toLowerCase() !== pool) continue;
      try { const ev = this.pool.interface.parseLog(log); if (ev && ev.name === name) return ev; } catch (_) {}
    }
    return null;
  }
}

/**
 * EXTENSION POINT for other modules (sdk/float.mjs adds `pay` and `settleLoans`): installs methods on
 * PriorsV2.prototype. Refuses to overwrite a method defined here or already installed, so two modules cannot
 * silently replace each other's behaviour.
 */
export function extendPriorsV2(methods) {
  for (const [name, fn] of Object.entries(methods)) {
    if (typeof fn !== "function") throw new Error(`extendPriorsV2: ${name} is not a function`);
    if (name in PriorsV2.prototype) throw new Error(`extendPriorsV2: PriorsV2.${name} already exists`);
    Object.defineProperty(PriorsV2.prototype, name, { value: fn, writable: false, configurable: false, enumerable: false });
  }
  return PriorsV2;
}

/* Credit as float (docs/FLOAT.md): x402 payment that borrows the shortfall from the agent's line. The logic lives
   in float.mjs; these bind it to this instance's signer and pool. */
extendPriorsV2({
  /** @param {string} url @param {{agentId, maxBorrow, maxPrice?, maxValiditySeconds?, termSeconds?, maxFee?, fetchImpl?, init?}} opts */
  pay(url, opts = {}) {
    this._needSigner();
    const v5 = this.vaultV5 ? { v5: this.vaultV5, v5Root: this.addresses.seatVaultV5AgentId ?? null } : {};
    return floatPay(url, { ...opts, signer: this.signer, pool: this.pool, ...v5 });
  },
  /** Send again the payment a `pay()` handed back (`paymentHeader` without `paid`): the same authorization, never a new
   *  one. Never call `pay()` again for that purchase. @param {{init?, fetchImpl?, retries?, timeoutMs?}} opts */
  resend(url, paymentHeader, opts = {}) { return floatResend(url, paymentHeader, opts); },
  /** Repay open loans of `agentId`, earliest due first, while the balance covers them. */
  settleLoans(agentId) { this._needSigner(); return floatSettleLoans({ signer: this.signer, pool: this.pool, agentId }); },
});

/* PT-USDG (sdk/pt-usdg.mjs): Pendle's principal token for USDG, bought, sold and redeemed through Pendle's router with
   this instance's provider and signer, and posted behind an agent's line through the stock vault once it lists it. A
   trade with a signer is sent unless `send: false`; without one (or with `send: false`) it returns the calls, for
   `account` (default: the signer's address). */
const ptTrade = (fn) => async function (amount, opts = {}) {
  const { send = true, account, ...rest } = opts;
  const wallet = send && this.signer ? this.signer : undefined;
  const who = account || (this.signer ? await this.signer.getAddress() : undefined);
  return fn(this.provider, { ...rest, amount, account: who, wallet });
};
extendPriorsV2({
  /** What a trade gives now: { side: "buy" | "sell" | "redeem", amount, slippageBps? } (sdk/pt-usdg.mjs ptQuote). */
  ptQuote(o = {}) { return ptQuote(this.provider, o); },
  /** Buy PT-USDG with `amount` USDG (approve exactly that to the router, then swap). */
  ptBuy: ptTrade(ptBuy),
  /** Sell `amount` PT-USDG (or "all") for USDG at the market, before maturity. */
  ptSell: ptTrade(ptSell),
  /** Redeem `amount` PT-USDG (or "all") for USDG 1:1, from maturity on; `{ market }` picks a listed market (PT_MARKETS),
   *  else the oldest matured one the account holds PT of. */
  ptRedeem: ptTrade(ptRedeem),
  /** `addr`'s PT-USDG (default: the signer's): balance, value now, days to maturity, implied fixed APY, the vault's listing. */
  async ptPosition(addr) { return ptPosition(this.provider, addr || (await this.me())); },
  /** Deposit `amount` PT-USDG behind agent `agentId` and open its line (openStockLine with the PT token), once the
   *  stock vault lists it enabled (ptListing's `backsLines`); refused before that, with nothing sent. */
  async openPtLine(agentId, amount, opts = {}) {
    const l = await ptListing(this.provider);
    if (!l || !l.backsLines) throw new Error(l && l.listed ? "the stock vault takes no new PT-USDG line now (disabled, or its shared cap is used up)" : "the stock vault does not list PT-USDG yet");
    return this.openStockLine(agentId, PT_USDG.token, amount, opts);
  },
});

export { PT_USDG };
export { sendChecked };
export default PriorsV2;
