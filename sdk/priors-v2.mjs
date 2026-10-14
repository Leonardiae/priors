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
//   raise    await p.raise(agentId)                    // its treasury's raise to the second line (25 USDG)
//            await p.moveToTreasuryV5(agentId)         // treasury v4's line -> treasury v5's, then the raise
//            (both with addresses.treasuryV5: docs/AGENTS.md, "3. Grow")
//   stocks   (addresses.stockVault) await p.stockAssets(); await p.stockPosition(agentId)
//            await p.openStockLine(agentId, token, "0.05")                        // deposit and open the line
//            await p.addCollateral(agentId, "0.01"); await p.closeStockLine(agentId)
//   PT-USDG  await p.ptQuote({ side: "buy", amount: 100 }); await p.ptPosition(addr)   (sdk/pt-usdg.mjs)
//            await p.ptBuy(100); await p.ptSell("all"); await p.ptRedeem("all")       // { send: false } returns the calls
//            await p.openPtLine(agentId, 50)                                      // once the stock vault lists PT-USDG
//
// Amounts: a number or a decimal string is whole USDG ("5", 5.5); a bigint is raw 6-decimal units. Every write
// simulates first (a revert is explained with the contracts' own custom errors, before any gas is spent) and
// approves the exact USDG or $PRIORS it needs when the allowance is short. A write signed by a key held here is sent
// once; a refusal ("insufficient funds") is recognised only over plain JSON-RPC over HTTP(S) on ethers' own transport,
// where it is exactly one request sent here (no retry, no redirect followed) and its reply exactly one JSON-RPC 2.0
// answer to it: through a WebSocket, browser or custom provider, or a custom transport, or once the global fetch was
// replaced after this module loaded, any send error leaves it unconfirmed (TX_UNCONFIRMED / BORROW_UNCONFIRMED, see
// sendChecked). A proxy or getUrl registered globally before this module loads is not used for that one request (an
// error there leaves it unconfirmed); a per-provider transport is respected. Out of reach by design: user code that
// replaces globals with a lying implementation, and an RPC node that lies about what it took.
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
  "function score(uint256 id) view returns (uint256)",
  "function seeded(uint256) view returns (bool)",
  "event Raised(uint256 indexed agentId, uint256 added, uint256 lineNow)",
  "error NotAdopted()", "error AlreadyAdopted()", "error NotOurs(uint256 agentId)", "error AlreadyLined(uint256 agentId)",
  "error NotEligible(uint256 agentId)", "error OwnerDefaulted(address owner)", "error EpochCapReached(uint256 wanted, uint256 left)",
  "error NotInvited(uint256 agentId, address signer)", "error InviteExpired(uint256 agentId, uint64 expiry)",
  "error InviteUsed(uint256 agentId)", "error NotIdle(uint256 agentId, uint256 reclaimableAt)", "error LoanOpen(uint256 agentId)",
  "error NothingToReclaim(uint256 agentId)", "error InvalidRules()", "error InvalidAddress()", "error UseSweep()", "error TransferFailed()",
  // OpenZeppelin ECDSA, reached from firstLine when the invite is not a signature at all
  "error ECDSAInvalidSignature()", "error ECDSAInvalidSignatureLength(uint256 length)", "error ECDSAInvalidSignatureS(bytes32 s)",
];

/** TreasurySponsorV5 (src/TreasurySponsorV5.sol): where an agent treasury v4 lined moves for its raise to the second
 *  line (docs/AGENTS.md, "3. Grow"). It names no inviter: its first lines are moves. */
export const TREASURY_V5_ABI = [
  `function move(uint256 id, ${CONSENT_T} c, bytes consentSig)`,
  "function raise(uint256 id)",
  "function eligibleForRaise(uint256 id) view returns (bool)",
  "function score(uint256 id) view returns (uint256)",
  "function rules() view returns (uint256 reserveBps, uint256 firstLine, uint256 secondLine, uint256 epochCap, uint64 epochLength, uint64 minSeasoning, uint256 minQualified, uint256 minScore, uint64 idleAfter)",
  "function agentId() view returns (uint256)",
  "function firstLined(uint256) view returns (bool)",
  "function seeded(uint256) view returns (bool)",
  "function epochRoom() view returns (uint256)",
  "function raiseRoom() view returns (uint256)",
  "function bond() view returns (address)",
  "function legacyBond() view returns (address)",
  "function previous() view returns (address)",
  "event Moved(uint256 indexed agentId, address indexed owner)",
  "event FirstLine(uint256 indexed agentId, uint256 amount, address indexed caller)",
  "event Raised(uint256 indexed agentId, uint256 added, uint256 lineNow)",
  "error NotAdopted()", "error NotEligible(uint256 agentId)", "error NotMovable(uint256 agentId)", "error OwnerDefaulted(address owner)",
  "error EpochCapReached(uint256 wanted, uint256 left)", "error RaiseCapReached(uint256 wanted, uint256 left)",
  "error AlreadyLined(uint256 agentId)", "error LoanOpen(uint256 agentId)",
];

/** InviteBond (v1, src/InviteBond.sol) and InviteBondV2 (src/InviteBondV2.sol), the calls the move makes on them.
 *  bonds() is read as its first three words, which both return (v1 has a fourth, qualifiedAt; V2 has none). */
export const INVITE_BOND_ABI = [
  "function bonds(uint256) view returns ((address depositor, uint64 at, uint256 amount))",
  "function isBonded(uint256) view returns (bool)",
  "function releasable(uint256) view returns (bool)",
  "function unusedReleaseAt(uint256) view returns (uint256)",
  "function amount() view returns (uint256)",
  "function deposit(uint256 agentId)",
  "function release(uint256 agentId)",
  "error AlreadyBonded(uint256 agentId)", "error NotOwner(uint256 agentId)", "error AgentDefaulted(uint256 agentId)",
  "error LoanOpen(uint256 agentId)", "error NoBond(uint256 agentId)", "error NotReleasable(uint256 agentId)",
  "error NotTreasuryLine(uint256 agentId)", // InviteBondV2: a deposit only with no sponsor or on treasury v5's line
];

/** The move's refusals on chain, in plain words (moveToTreasuryV5 puts them before the revert it names). */
const MOVE_WORDS = {
  LoanOpen: "the agent has a loan open: repay your open loan first",
  NotTreasuryLine: "InviteBondV2 takes a bond only for an agent with no line, or on treasury v5's: leave treasury v4's line first",
  NotMovable: "treasury v5 moves only an agent treasury v4 lined and v5 never did, on v4's line or none, with no InviteBond (v1) bond left and the owner's own InviteBondV2 bond posted",
  NotReleasable: "the InviteBond (v1) bond comes back only with the line closed, no loan open, from 4 days after it was posted",
};

/** The bar of qualified loans above which a treasury's rules hold raises: the Safe's setting of 2026-10-12 (H1 in
 *  docs/SECURITY-v2.md: treasury v4's minQualified 1,000,000), which returns an InviteBond (v1) bond only once its line
 *  is closed. */
export const RAISE_HOLD_BAR = 100n;

/** Pure: whether a treasury's rules() hold raises: secondLine at or under firstLine (no line is ever under its first
 *  line), or minQualified above RAISE_HOLD_BAR. */
export const raisesHeld = (r) => BigInt(r.secondLine) <= BigInt(r.firstLine) || BigInt(r.minQualified) > RAISE_HOLD_BAR;

const utcAt = (t) => new Date(Number(t) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * Pure: what an agent's record (`agent`, the pool's getAgent) still lacks for a raise under a treasury's `rules` (its
 * rules()), with the treasury's `score` for it, at chain time `now`: plain phrases, none when the record meets them.
 * The record's part of eligibleForRaise only: the line itself (its sponsor, frozen, already raised) is the caller's.
 */
export function raiseShortfall({ agent, rules, score, now }) {
  const out = [];
  if (agent.defaulted) out.push("a record with no default (it has defaulted)");
  if (BigInt(agent.childrenDefaulted) !== 0n) out.push("no default among the agents it backs");
  const q = BigInt(agent.qualifiedRepaid), need = BigInt(rules.minQualified);
  if (q < need) out.push(`${need} qualified loans repaid (it has ${q})`);
  const ready = BigInt(agent.enrolledAt) + BigInt(rules.minSeasoning);
  if (BigInt(agent.enrolledAt) === 0n || BigInt(now) < ready) out.push(`${Number(rules.minSeasoning) / 86400} days since it enrolled${BigInt(agent.enrolledAt) === 0n ? " (it is not enrolled)" : ` (from ${utcAt(ready)})`}`);
  if (BigInt(score) < BigInt(rules.minScore)) out.push(`a score of ${rules.minScore} (it has ${score})`);
  return out;
}

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

/** What a wallet or a node answers when it does not take a transaction: it was refused, nothing was sent. */
const REFUSED = new Set(["ACTION_REJECTED", "INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED", "CALL_EXCEPTION"]);

/** For bytes signed here, the node's answers that can be a refusal: only once our own hash is shown to be unknown. */
const SIGNED_REFUSALS = new Set(["INSUFFICIENT_FUNDS", "CALL_EXCEPTION"]);

// ethers' own transport as this module found it when it loaded: Node's http(s) in Node, fetch in a browser build (or
// whatever was registered globally before this module loaded). A request given another one (its own getUrlFunc, a
// preflight or a process function) goes through a transport this code does not control.
const ETHERS_GET_URL = new ethers.FetchRequest("http://localhost/").getUrlFunc;
// the global fetch as this module found it when it loaded: the one broadcast is sent with it, and only while it is
// still the global one (a fetch replaced since is a transport this code does not control)
const FETCH_AT_LOAD = typeof globalThis.fetch === "function" ? globalThis.fetch : null;

/**
 * The JSON-RPC-over-HTTP(S) endpoint behind `p` (itself, or a fallback or failover provider's first entry) when this
 * code can send to it itself: ethers' own transport, no custom getUrlFunc, preflight or process function, and the
 * global fetch still the one found at load. null otherwise: such a provider is sent through as it is, and none of its
 * errors is taken as a refusal. A proxy or getUrl registered globally before this module loaded is not used for that
 * one request (it fails safe: an error there leaves the transaction unconfirmed); a per-provider transport is
 * respected.
 */
function ownEndpoint(p) {
  const ep = typeof p?._getConnection === "function" ? p : p?.providerConfigs?.[0]?.provider;
  if (!ep || typeof ep._getConnection !== "function" || typeof ep.getRpcError !== "function") return null;
  if (!FETCH_AT_LOAD || globalThis.fetch !== FETCH_AT_LOAD) return null;
  const conn = ep._getConnection();
  if (!/^https?:/i.test(String(conn.url))) return null;
  if (conn.getUrlFunc !== ETHERS_GET_URL || conn.preflightFunc || conn.processFunc) return null;
  return { ep, conn };
}

/**
 * ONE eth_sendRawTransaction as exactly one HTTP request, sent here with fetch and `redirect: "manual"`, to the
 * provider's URL with its headers (including the Basic authorization ethers derives from its credentials, and any
 * user:password in the URL, sent as that header). ethers' own FetchRequest would send it again: after a 429 (its
 * throttle), and after a 301/302/307/308 (redirect() builds a new request with the default throttle, ethers 6.17
 * utils/fetch.js 460-464 and 526-551), and its browser transport lets fetch follow a redirect inside one call
 * (utils/geturl-browser.js). Any 3xx, an opaque redirect (a browser's status 0), a 429, any other non-2xx, a body that
 * is not exactly one JSON-RPC 2.0 reply to this request (its id; exactly one of error and result; a result that is
 * this transaction's hash), a transport failure or a timeout throws as it is (never a refusal); a 2xx JSON-RPC error
 * reply throws the provider's mapped error marked `answered`. A redirect is also any response that says it was
 * redirected or comes from another URL (a fetch that ignores "manual").
 */
async function postOnce({ ep, conn }, raw) {
  const fail = (why) => ethers.makeError(`the broadcast request ${why}`, "SERVER_ERROR");
  const id = 1 + Math.floor(Math.random() * 2 ** 30);
  const payload = { method: "eth_sendRawTransaction", params: [raw], id, jsonrpc: "2.0" };
  const hash = ethers.Transaction.from(raw).hash.toLowerCase();
  const url = new URL(conn.url);
  const headers = new Headers();
  for (const [k, v] of conn) if (!["content-length", "accept-encoding"].includes(k.toLowerCase())) headers.set(k, v);
  if (url.username || url.password) {
    if (!headers.has("authorization")) headers.set("authorization", `Basic ${ethers.encodeBase64(ethers.toUtf8Bytes(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`))}`);
    url.username = "";
    url.password = "";
  }
  headers.set("content-type", "application/json");
  let res;
  try {
    res = await FETCH_AT_LOAD(url, { method: "POST", headers, body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(conn.timeout || 300_000) });
  } catch (e) {
    throw Object.assign(fail(`failed (${e?.cause?.message || e?.message || e})`), { cause: e });
  }
  // a redirect, followed or not, by this fetch or by one that ignores "manual": never an answer to this request
  let sameUrl = false;
  try { sameUrl = new URL(String(res.url)).href === url.href; } catch (_) { /* no URL: not the same */ }
  if (res.type === "opaqueredirect" || res.status === 0 || res.redirected === true || (res.status >= 300 && res.status < 400) || !sameUrl) {
    throw fail(`was redirected (${res.status || res.type}${res.redirected ? ", followed" : ""}), so its answer is not taken`);
  }
  if (!res.ok) throw fail(`was answered with HTTP ${res.status}`);
  // exactly one JSON-RPC 2.0 reply to this request: its id, and exactly one of error and result
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch (_) {
    throw fail("was answered with something other than JSON");
  }
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!isObj(body) || body.jsonrpc !== "2.0" || body.id !== id || ("error" in body) === ("result" in body)) {
    throw fail("was answered with something other than one JSON-RPC 2.0 reply to it");
  }
  if ("error" in body) {
    if (!isObj(body.error) || typeof body.error.message !== "string" || typeof body.error.code !== "number") throw fail("was answered with a malformed JSON-RPC error");
    throw Object.assign(ep.getRpcError(payload, body), { answered: true });
  }
  if (typeof body.result !== "string" || body.result.toLowerCase() !== hash) throw fail(`was answered with ${JSON.stringify(body.result)}, not this transaction's hash`);
  return body.result;
}

/**
 * Send signed bytes once, as sendChecked does (and the CLI's `tx --resend`): to a JSON-RPC-over-HTTP(S) endpoint this
 * code can send to itself, exactly one request (postOnce); through any other provider (a WebSocket, a browser's, a
 * custom one, or one with its own transport), its own broadcastTransaction, which sends it once as far as this code can
 * tell. Resolves with the hash. A refusal can be recognised only from the first kind (an error marked `answered`);
 * from the second, any error leaves it unconfirmed.
 */
export async function sendRawOnce(provider, raw) {
  const own = ownEndpoint(provider);
  return own ? postOnce(own, raw) : (await provider.broadcastTransaction(raw)).hash;
}

/** TX_UNCONFIRMED: `name` may have landed or may still be pending (`mined`: it landed), and what it did is not known.
 *  It carries the tx `hash` and the `nonce` it was signed with, which `txStatus` takes to tell when it is final, and,
 *  signed here, the exact signed transaction (`raw`): sending those same bytes again cannot make a second one. */
function unconfirmed(name, hash, cause, mined = false, nonce = null, raw = null, sentBlock = null) {
  const why = cause?.shortMessage || cause?.message || String(cause);
  const msg = mined
    ? `${name} was mined (tx ${hash}) but its result could not be read (${why}): it landed, so do not send it again`
    : `${name} was sent${hash ? ` (tx ${hash}, nonce ${nonce})` : ""} and its answer was lost (${why}): it may have landed, or may still be pending. Do not send it again until it is final (mined, reverted, or replaced: txStatus)`;
  return Object.assign(new Error(msg), { code: "TX_UNCONFIRMED", unconfirmed: true, mined, hash, nonce, raw, sentBlock, cause });
}

/** A key held in this process (an ethers Wallet): it signs here, so the hash is known before anything is sent. */
const signsHere = (runner) => typeof runner?.signTransaction === "function" && runner.signingKey != null && runner.provider != null;

/**
 * Simulate, then send with 25% gas headroom (same reasons as sdk/priors.mjs: a doomed transaction returns its
 * reason only before the send, and a bare estimate can undershoot a branch taken at mining time). Then, so that an
 * error says what happened and never invites a second send of a write that landed (P-18's rule; GHSA-g5cv-cpwp-756w):
 *  1. build: nonce, gas and fees are read and, with a key held here, the transaction is signed, so its hash is known
 *     before it is sent. A failure here sent nothing: an ordinary error.
 *  2. send: bytes signed here go out once (sendRawOnce): to a JSON-RPC-over-HTTP(S) endpoint on ethers' own transport,
 *     exactly one request, sent here with fetch, no retry, no redirect followed. Any answer from the node is first
 *     reconciled with our own hash: its receipt is read and used as below, or the node holds it and it is waited for.
 *     Only an unknown hash with a refusal in a 2xx JSON-RPC answer (INSUFFICIENT_FUNDS, or a revert reported at the
 *     broadcast: CALL_EXCEPTION) is an ordinary error; any other answer ("nonce too low", "replacement underpriced",
 *     "already known"...), a lookup that fails, and any 3xx, 429, other HTTP status, transport failure or timeout are
 *     TX_UNCONFIRMED. Through any other provider (WebSocket, browser, custom, or a custom transport on a JSON-RPC
 *     provider) no refusal is recognised: any error is reconciled the same way, else TX_UNCONFIRMED. A wallet that
 *     signs and sends itself: its refusals (ACTION_REJECTED, INSUFFICIENT_FUNDS, NONCE_EXPIRED,
 *     REPLACEMENT_UNDERPRICED, CALL_EXCEPTION) sent nothing; any other failure is TX_UNCONFIRMED.
 *  3. wait (one wall-clock deadline, PriorsV2's waitTimeoutMs, over the broadcast, the lookups, the wait and reading
 *     the result: no conclusive answer by then is TX_UNCONFIRMED): a revert mined with status 0
 *     (CALL_EXCEPTION, from the receipt) did nothing: an ordinary error. A
 *     replacement is read from its receipt: repriced (this same call at another fee) is this call's result; cancelled,
 *     or replaced by another call, is TRANSACTION_REPLACED with `cancelled: true` (this call did not run). Any other
 *     failure: TX_UNCONFIRMED with the hash.
 * `then(rc)` reads the result from the status-1 receipt (an event, a read after the write): anything it throws is
 * TX_UNCONFIRMED with `mined: true`, since the write landed. `borrow` names both BORROW_UNCONFIRMED.
 * With a `journal` (PriorsV2's option) and a key held here, the signed transaction is handed to `journal.before` and
 * recorded before the broadcast (if `before` throws, nothing is sent, and its error's code is kept: a record that
 * cannot be written, or the CLI's lock no longer held, LOCK_LOST), so a process killed at any later point leaves it
 * behind; `journal.settled(hash, { refusal })` is called only on a conclusive answer: a refusal at the broadcast
 * (`refusal: true`; a journal that answers false keeps the record, and the transaction is then TX_UNCONFIRMED), or the
 * status-1 receipt with its result read. A mined revert, a cancel, a lost answer and an ambiguous answer keep it.
 */
async function sendChecked(contract, method, args, ifaces, then = (rc) => rc) {
  const fn = contract.getFunction(method);
  const name = method.split("(")[0];
  const runner = contract.runner;
  const journal = ifaces.journal || null;
  const waitMs = ifaces.waitTimeoutMs ?? 180_000;
  if (typeof runner?.sendTransaction !== "function") throw ethers.makeError(`${name}: this call needs a signer`, "UNSUPPORTED_OPERATION", { operation: "sendTransaction" });
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
  // 1. build (and sign, with a key held here): nothing is sent yet
  const pop = await runner.populateTransaction(await fn.populateTransaction(...args, overrides));
  const nonce = pop.nonce == null ? null : Number(pop.nonce);
  // the block before it is sent: it cannot be mined at or before it, which bounds the search for its nonce (txStatus)
  const sentBlock = await runner.provider.getBlockNumber();
  let signed = null, hash = null;
  if (signsHere(runner)) {
    delete pop.from;
    signed = await runner.signTransaction(ethers.Transaction.from(pop));
    hash = ethers.Transaction.from(signed).hash;
  }
  // the one broadcast, prepared before anything is recorded (nothing after the send may fail but the send itself)
  const own = signed ? ownEndpoint(runner.provider) : null;
  const network = signed ? await runner.provider.getNetwork() : null;
  if (journal && signed) {
    try {
      await journal.before({ name, hash, nonce, raw: signed, sentBlock });
    } catch (e) {
      throw Object.assign(new Error(`${name} was not sent: ${e.message}`), { code: e.code, cause: e });
    }
  }
  // the record goes only on a conclusive answer; if removing it fails, or the journal keeps it (another process claimed
  // it first, or, for a refusal, the CLI's lock is no longer this command's), it stays, and `tx` settles it
  const settled = async (refusal = false) => {
    if (!journal || !hash) return true;
    try { return (await journal.settled(hash, { refusal })) !== false; } catch (_) { return false; }
  };
  // 2. send. Broadcast here rather than through the contract: ethers' contract response forgets the block it was sent
  //    at, and its wait() then never looks for a replacement (a replaced transaction was waited for forever).
  // One wall-clock deadline (waitTimeoutMs) over everything from the broadcast of bytes signed here (or, for a wallet
  // that sends itself, from its answer) to the conclusive answer: the broadcast, the hash lookups, the receipt and
  // replacement wait (ethers arms its own timeout only after its first lookup), and reading the result. A request
  // that never settles is raced, not awaited: at the deadline the write is TX_UNCONFIRMED, its record kept; the losing
  // request is ignored, and the timer is cleared on every path, so nothing holds the process open.
  let deadline = Date.now() + waitMs;
  const bounded = (promise, what) => {
    let timer;
    const left = Math.max(0, deadline - Date.now());
    const late = new Promise((_, no) => { timer = setTimeout(() => no(ethers.makeError(`${name}: ${what} gave no answer within ${waitMs} ms`, "TIMEOUT")), left); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  };
  let tx = null, rc = null;
  try {
    if (signed && own) {
      await bounded(postOnce(own, signed), "the broadcast");
      tx = runner.provider._wrapTransactionResponse(ethers.Transaction.from(signed), network).replaceableTransaction(sentBlock);
    } else if (signed) {
      tx = await bounded(runner.provider.broadcastTransaction(signed), "the broadcast"); // not a transport we control: any error is unconfirmed
    } else {
      tx = await runner.sendTransaction(pop); // a wallet's own send (its user may take their time): not bounded
      deadline = Date.now() + waitMs;
    }
  } catch (e) {
    if (signed && (e?.answered || !own)) {
      // the node answered (or a provider we cannot make send once failed): our own hash decides first
      let onNode = null, looked = false;
      try {
        rc = await bounded(runner.provider.getTransactionReceipt(hash), "the receipt lookup");
        if (!rc) onNode = await bounded(runner.provider.getTransaction(hash), "the transaction lookup");
        looked = true;
      } catch (_) { // a lookup that fails or never answers: nothing is known, so never a refusal
        rc = null;
        onNode = null;
      }
      if (!rc && onNode) tx = onNode.replaceableTransaction(sentBlock);
      else if (!rc) {
        // unknown to the node: a refusal only for a refusing 2xx answer to our own request, once its record is claimed
        if (own && e?.answered && looked && SIGNED_REFUSALS.has(e.code) && (await settled(true))) throw e;
        throw unconfirmed(name, hash, e, false, nonce, signed, sentBlock);
      }
    } else if (!signed && REFUSED.has(e?.code)) {
      throw e;
    } else {
      throw unconfirmed(name, hash, e, false, nonce, signed, sentBlock);
    }
  }
  // 3. wait
  if (!rc) {
    try {
      rc = await bounded(tx.wait(1, Math.max(1, deadline - Date.now())), "the receipt"); // no receipt by then: TX_UNCONFIRMED
    } catch (e) {
      if (e?.code === "CALL_EXCEPTION") throw e;
      if (e?.code !== "TRANSACTION_REPLACED") throw unconfirmed(name, tx.hash, e, false, tx.nonce ?? nonce, signed, sentBlock);
      if (e.cancelled) {
        throw Object.assign(new Error(`${name} (tx ${tx.hash}) was ${e.reason} by tx ${e.hash}, which mined with its nonce: it did not run`),
          { code: "TRANSACTION_REPLACED", cancelled: true, reason: e.reason, hash: tx.hash, replacement: e.hash, cause: e });
      }
      rc = e.receipt; // repriced: this same call, mined under the replacement's hash
    }
  }
  if (!rc || rc.status !== 1) throw Object.assign(new Error(`${name} mined with status 0 (tx ${rc?.hash ?? tx?.hash ?? hash}): it did nothing`), { code: "CALL_EXCEPTION", receipt: rc });
  let out;
  try {
    out = await bounded(Promise.resolve().then(() => then(rc)), "reading its result");
  } catch (e) {
    throw unconfirmed(name, rc.hash, e, true, tx?.nonce ?? nonce, signed, sentBlock);
  }
  await settled();
  return out;
}

const sameAddr = (x, y) => (x == null ? null : String(x).toLowerCase()) === (y == null ? null : String(y).toLowerCase());

/** The same call: sender, target, calldata, value and chain. A fee-bumped copy (a speed-up) differs only in its fee
 *  fields and so its hash: it does what the original would have done. */
const sameCall = (a, b) => sameAddr(a.from, b.from) && sameAddr(a.to, b.to) && String(a.data).toLowerCase() === String(b.data).toLowerCase() && BigInt(a.value ?? 0) === BigInt(b.value ?? 0) && BigInt(a.chainId ?? 0) === BigInt(b.chainId ?? 0);

/** `who`'s transaction at nonce `n` in block `num`'s body ({ tx, block, blockHash }), or null if the body has none. */
async function inBlock(p, num, who, n) {
  const block = await p.getBlock(num, true);
  if (!block) throw new Error(`block ${num} is not available`);
  const t = block.prefetchedTransactions.find((x) => sameAddr(x.from, who) && x.nonce === n);
  return t ? { tx: t, block: num, blockHash: block.hash } : null;
}

/**
 * Whether block `num` (as a receipt or a transaction named it, with `blockHash`) is final: "finalized" once it is at
 * or below the chain's finalized block and its hash is the canonical one at that number; "waiting" while it is above;
 * "reorged" when the canonical block at that number has another hash; "unknown" when either cannot be read. The
 * finalized block is read first, so a canonical hash read after it, at or below it, is the finalized chain's.
 */
async function finalityOf(p, num, blockHash) {
  try {
    const fin = await p.getBlock("finalized");
    const canon = await p.getBlock(num);
    if (!fin || !canon || !blockHash) return "unknown";
    if (String(canon.hash).toLowerCase() !== String(blockHash).toLowerCase()) return "reorged";
    return num <= fin.number ? "finalized" : "waiting";
  } catch (_) {
    return "unknown";
  }
}

/**
 * The explorer as a pointer only: `lookup({ from, nonce, sentBlock })` names candidate hashes; each is checked on the
 * RPC (this sender, this nonce, mined, its receipt in the same block) and only a checked one is returned. An explorer
 * that lies or fails yields nothing.
 */
async function viaExplorer(p, lookup, who, n, sentBlock) {
  const hashes = [].concat((await lookup({ from: who, nonce: n, sentBlock })) || []);
  for (const h of hashes.slice(0, 10)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(h))) continue;
    const t = await p.getTransaction(h);
    if (!t || !sameAddr(t.from, who) || t.nonce !== n || t.blockNumber == null) continue;
    const r = await p.getTransactionReceipt(h);
    if (!r || r.blockNumber !== t.blockNumber || !sameAddr(r.blockHash, t.blockHash)) continue;
    return { tx: t, block: t.blockNumber, blockHash: t.blockHash };
  }
  return null;
}

/**
 * The transaction that used `who`'s nonce `n`, given that the count at block `B` has passed it: the block K where the
 * count goes from n to n + 1 (searched back from B, doubling, then halving, never below `floor`, the block it was sent
 * after), then the sender's transaction at nonce n in K ({ tx, block, blockHash }). null when that cannot be shown;
 * throws when a read fails.
 */
async function nonceUser(p, who, n, B, floor) {
  const low = Math.max(0, floor == null ? 0 : Number(floor));
  const count = (b) => p.getTransactionCount(who, b);
  let hi = B, lo = null;
  for (let step = 1; lo === null; step *= 2) {
    const probe = Math.max(low, hi - step);
    if ((await count(probe)) <= n) lo = probe;
    else if (probe === low) return null; // used at or before the bound: not this search's to place
    else hi = probe;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await count(mid)) > n) hi = mid;
    else lo = mid;
  }
  return inBlock(p, hi, who, n);
}

const consentTuple = (c) => [BigInt(c.agentId), BigInt(c.sponsorId), c.owner, BigInt(c.maxPremiumBps), BigInt(c.nonce), BigInt(c.deadline)];

// ---------------------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------------------

export class PriorsV2 {
  /**
   * @param {{ signer?: any, provider?: any, rpc?: string,
   *           addresses: { pool: string, treasuryV4?: string, seatVault?: string, seatVaultV4?: string, usdg?: string, registry?: string, priors?: string, stockVault?: string,
   *                        seatVaultV5?: string, seatVaultV5AgentId?: number, treasuryV5?: string, inviteBondV2?: string } }} opts
   * With `seatVaultV4` (the growth seat vault), new seats go to it; a seat already open stays on its own vault.
   * With `seatVaultV5` and `seatVaultV5AgentId` (SeatVaultV5 and its root), `borrow` and `pay` on a line V5 sponsors take
   * its step first (float.mjs `v5BeforeBorrow`).
   * With `treasuryV5` (TreasurySponsorV5), `raise` and `moveToTreasuryV5` reach it; its bond and treasury v4's are read
   * from it (bond(), legacyBond(), previous()), and a recorded `inviteBondV2` must be its bond().
   * `waitTimeoutMs` (default 180000): a wall-clock bound on a write from its broadcast to its conclusive answer (the
   * broadcast, the hash lookups, the receipt and replacement wait, reading its result); past it, TX_UNCONFIRMED.
   * `journal: { before({ name, hash, nonce, raw, sentBlock }), settled(hash) }` (optional, a key held here): every
   * write hands its signed transaction to `before`, which must record it durably, before the broadcast (and may stop
   * it by throwing), and `settled` once its outcome is conclusive (see sendChecked). The CLI's (sdk/tx-record.mjs
   * keyJournal) records it and checks the key's lock.
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
    // treasury v5 (raise, moveToTreasuryV5): only once the record names it; its bonds are read from it (_treasuryV5)
    this.treasuryV5 = a.treasuryV5 ? new ethers.Contract(a.treasuryV5, TREASURY_V5_ABI, run) : null;
    // every interface a call here can revert with: a vault or treasury call bubbles the pool's errors up
    this._ifaces = [this.pool.interface, ...(this.vault ? [this.vault.interface] : []), ...(this.vaultV4 ? [this.vaultV4.interface] : []), ...(this.treasury ? [this.treasury.interface] : []), ...(this.stockVault ? [this.stockVault.interface] : []), ...(this.vaultV5 ? [this.vaultV5.interface] : []), new ethers.Interface(ERC20_ABI), new ethers.Interface(REGISTRY_ABI),
      ...(this.treasuryV5 ? [this.treasuryV5.interface, new ethers.Interface(INVITE_BOND_ABI)] : [])];
    this._ifaces.journal = opts.journal || null; // sendChecked reads it with the interfaces every write passes
    this._ifaces.waitTimeoutMs = opts.waitTimeoutMs ?? 180_000; // how long a sent write waits for its receipt
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
    return sendChecked(this.pool, "deposit", [assets, receiver || me, min], this._ifaces, (rc) => {
      const ev = this._event(rc, "Deposited");
      return { hash: rc.hash, assets, shares: ev ? ev.args.shares : null };
    });
  }

  /** Withdraw `shares` (bigint) or `'all'`. Inside the 7-day hold, 0.5% stays with the pool. */
  async withdraw(shares = "all", { receiver } = {}) {
    const me = await this.me();
    const s = shares === "all" ? await this.pool.shares(me) : BigInt(shares);
    if (s === 0n) throw new Error(`${me} holds no pool shares`);
    return sendChecked(this.pool, "withdraw", [s, receiver || me], this._ifaces, (rc) => {
      const ev = this._event(rc, "Withdrawn");
      return { hash: rc.hash, shares: s, assets: ev ? ev.args.assets : null };
    });
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
    const at = await vault.getAddress();
    await this._ensure(token, at, seatSize, "offer");
    return { hash: (await sendChecked(vault, "offer", [agentId], this._ifaces)).hash, seatSize, seatVault: at };
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
    const regAddr = (await reg.getAddress()).toLowerCase();
    const T = ethers.id("Transfer(address,address,uint256)");
    const ZERO = ethers.ZeroHash;
    // a mint not found in a mined receipt is TX_UNCONFIRMED (mined), never an error that invites a second identity
    return sendChecked(reg, "register", [uri], this._ifaces, (rc) => {
      const ours = rc.logs.filter((l) => l.address.toLowerCase() === regAddr && l.topics.length === 4 && l.topics[0] === T && l.topics[1] === ZERO && ethers.getAddress("0x" + l.topics[2].slice(26)).toLowerCase() === me);
      if (ours.length !== 1) throw new Error(`expected one identity minted to ${me}, found ${ours.length}`);
      return Number(BigInt(ours[0].topics[3]));
    });
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
    const at = await vault.getAddress();
    const { consent, sig } = await this.signConsent({ agentId, sponsorId, maxPremiumBps: 0 });
    const rc = await sendChecked(vault, "accept", [agentId, staker, consentTuple(consent), sig], this._ifaces);
    return { hash: rc.hash, sponsorId: Number(sponsorId), seatVault: at };
  }

  // ---- the raise to the second line: treasury v5 (docs/AGENTS.md, "3. Grow") ---------------------------------------

  /**
   * Treasury v5 as the move and the raise read it, once per instance: its root, treasury v4 (its `previous()`) and v4's
   * root, InviteBondV2 (its `bond()`) and InviteBond v1 (its `legacyBond()`; the record's `inviteBond` where v5 cannot
   * say). A recorded `inviteBondV2` that is not v5's bond() is refused: a deposit there would not count.
   */
  async _treasuryV5() {
    const t5 = this._need(this.treasuryV5, "treasuryV5");
    if (this._t5) return this._t5;
    const run = this.signer || this.provider;
    const [root, bondAt, prevAt] = await Promise.all([t5.agentId(), t5.bond(), t5.previous()]);
    let legacyAt;
    try { legacyAt = await t5.legacyBond(); } catch (_) { legacyAt = this.addresses.inviteBond || ethers.ZeroAddress; }
    if (this.addresses.inviteBondV2 && !sameAddr(this.addresses.inviteBondV2, bondAt)) throw new Error(`the addresses file's inviteBondV2 (${this.addresses.inviteBondV2}) is not treasury v5's bond (${bondAt}): fix the addresses file; nothing was sent`);
    const t4 = this.treasury && sameAddr(await this.treasury.getAddress(), prevAt) ? this.treasury : new ethers.Contract(prevAt, TREASURY_V4_ABI, run);
    this._t5 = {
      t5, root: BigInt(root), t4, v4Root: BigInt(await t4.agentId()),
      bondV2: new ethers.Contract(bondAt, INVITE_BOND_ABI, run),
      bondV1: legacyAt && legacyAt !== ethers.ZeroAddress ? new ethers.Contract(legacyAt, INVITE_BOND_ABI, run) : null,
    };
    return this._t5;
  }

  /**
   * Raise `agentId`'s treasury line to its treasury's second line (rules().secondLine: 25 USDG), by its sponsor: on
   * treasury v5's line (`treasuryV5` recorded), v5's raise; on treasury v4's, v4's, refused with nothing sent while v4's
   * rules hold raises (raisesHeld: its minQualified of 1,000,000 since 2026-10-12), saying that moveToTreasuryV5 is the
   * way to the second line. An agent the treasury does not find eligible is refused with what its record lacks
   * (raiseShortfall), nothing sent. Anyone may send a raise, for any agent; the keeper raises eligible v5 lines every 30
   * minutes. Returns { hash, treasury: "treasury v5" | "treasury v4", added, line } (added and line from its Raised
   * event, null if the receipt has none).
   */
  async raise(agentId) {
    this._needSigner();
    const id = BigInt(agentId);
    const a = await this.pool.getAgent(id);
    if (this.treasuryV5 && a.sponsor !== 0n) {
      const t = await this._treasuryV5();
      if (t.root !== 0n && a.sponsor === t.root) return this._raiseOn(t.t5, "treasury v5", id, a);
    }
    if (this.treasury && a.sponsor !== 0n && a.sponsor === (await this.treasury.agentId())) {
      const r = await this.treasury.rules();
      if (raisesHeld(r)) {
        const why = BigInt(r.secondLine) <= BigInt(r.firstLine) ? `its second line (${fmtUsdg(r.secondLine)} USDG) is no bigger than its first` : `its bar of ${r.minQualified} qualified loans holds them`;
        throw new Error(`agent #${id}'s line is treasury v4's, whose raises are on hold (${why}): nothing was sent. ${this.treasuryV5 ? "Treasury v5 raises it: moveToTreasuryV5 (`priors-v2 move`) moves the line there, then raises it." : "Treasury v5, which raises it, is not in this addresses file."}`);
      }
      return this._raiseOn(this.treasury, "treasury v4", id, a);
    }
    throw new Error(`agent #${id} is not on a treasury line (${a.sponsor === 0n ? "it has no sponsor" : `its sponsor is #${a.sponsor}`}): only a treasury line is raised by rule; nothing was sent`);
  }

  /** The raise on treasury `t` (named `which`) of agent `id` (its pool record `a`), once eligibleForRaise says yes. */
  async _raiseOn(t, which, id, a) {
    if (!(await t.eligibleForRaise(id))) throw new Error(`agent #${id} is not eligible for a raise on ${which} yet: ${(await this._raiseWhyNot(t, id, a)).join("; ")}. Nothing was sent`);
    const at = (await t.getAddress()).toLowerCase();
    return sendChecked(t, "raise", [id], this._ifaces, (rc) => {
      const ev = rc.logs.filter((l) => l.address.toLowerCase() === at).map((l) => { try { return t.interface.parseLog(l); } catch (_) { return null; } }).find((x) => x && x.name === "Raised");
      return { hash: rc.hash, treasury: which, added: ev ? ev.args.added : null, line: ev ? ev.args.lineNow : null };
    });
  }

  /** Why treasury `t` would not raise agent `id` now, in plain phrases (its line, its owner, then its record). Treasury
   *  v5 also reads treasury v4's seeded flag (eligibleForRaise does). */
  async _raiseWhyNot(t, id, a) {
    const v4Seeded = this.treasuryV5 && t === this.treasuryV5 ? (await this._treasuryV5()).t4.seeded(id) : false;
    const [r, score, seeded, block, owner] = await Promise.all([t.rules(), t.score(id), Promise.all([t.seeded(id), v4Seeded]).then(([x, y]) => x || y), this.provider.getBlock("latest"), (await this._registry()).ownerOf(id).catch(() => null)]);
    const out = [];
    if (seeded) out.push("its record was seeded by the protocol, and a seeded record is never raised by rule");
    if (a.frozen) out.push("its line is frozen");
    if (a.delegatedIn === 0n) out.push("its line is closed");
    else if (a.delegatedIn >= r.secondLine) out.push(`its line is already ${fmtUsdg(a.delegatedIn)} USDG`);
    if (owner && (await this.pool.ownerDefaults(owner)) !== 0n && !(await this.pool.custodian(owner))) out.push("its owner's wallet was marked by a default");
    const need = raiseShortfall({ agent: a, rules: r, score, now: block.timestamp });
    if (need.length) out.push(`the raise needs ${need.join(", ")}`);
    return out.length ? out : ["the treasury does not say why"];
  }

  /**
   * Move `agentId`, an agent the signer owns that treasury v4 lined, to treasury v5, then raise it to v5's second line
   * (docs/AGENTS.md, "3. Grow": v4 raises nothing; v5 is where a seasoned agent is raised). Refused with nothing sent
   * unless all of these hold: v5 recorded, with its root; the agent on v4's line, or with no sponsor and lined by v4
   * once; never lined by v5; no loan open; not defaulted; its owner not marked by a default; its record not seeded; the
   * record meeting v5's raise rules (raiseShortfall: qualified loans, seasoning, score); room for a first line on v5
   * this epoch and the free backing for it; its InviteBond (v1) bond, if any, releasable once the line is closed (from
   * 4 days after it was posted: v5's move waits until it is gone); the owner's USDG for the InviteBondV2 bond. Then, each
   * step skipped when it is already done:
   *   1. pool.leave(id) while the agent is on v4's line: InviteBondV2 takes a deposit only with no line (or on v5's),
   *      and a v1 bond comes back only with the line closed
   *   2. InviteBond(v1).release(id), when one is posted: the bond goes back to its depositor
   *   3. USDG approve, then InviteBondV2.deposit(id) by the owner (a bond another wallet posted is replaced and refunded)
   *   4. the owner's pool consent naming v5's root, and V5.move(id, consent, sig)
   *   5. V5.raise(id). Not fatal when it cannot go now (the raise budget of the epoch, say): the keeper raises eligible
   *      v5 lines every 30 minutes
   * Run it again after a failure and it goes on from the step that failed. Returns { agentId, steps: [{ step, hash } |
   * { step, skipped }], line } (line: the agent's line after it, null if unread). A step that fails throws its own error
   * with `step` and `steps` (those done) on it, a refusal on chain put in plain words first (MOVE_WORDS: LoanOpen,
   * NotTreasuryLine, NotMovable, NotReleasable); a write whose answer was lost stays TX_UNCONFIRMED (see sendChecked).
   */
  async moveToTreasuryV5(agentId, { deadline } = {}) {
    const me = await this.me();
    const id = BigInt(agentId);
    const t = await this._treasuryV5();
    const no = (why) => new Error(`agent #${id} cannot move to treasury v5: ${why}. Nothing was sent`);
    if (t.root === 0n) throw no("treasury v5 has no root yet (it is still being set up)");
    const owner = await (await this._registry()).ownerOf(id);
    if (!sameAddr(owner, me)) throw no(`it is owned by ${owner}, not by the signer ${me}: only its owner can move it`);
    const a = await this.pool.getAgent(id);
    const steps = [];
    if (a.sponsor === t.root) {
      for (const step of ["leave", "release v1 bond", "bond on InviteBondV2", "move"]) steps.push({ step, skipped: "already on treasury v5's line" });
    } else {
      // ---- every check before the first write ----
      if (a.defaulted) throw no("it has defaulted");
      if (await t.t5.firstLined(id)) throw no("treasury v5 lined it before, and an agent moves once");
      const onV4 = a.sponsor === t.v4Root;
      if (!onV4 && a.sponsor !== 0n) throw no(`its line is #${a.sponsor}'s, not treasury v4's`);
      if (!onV4 && !(await t.t4.firstLined(id))) throw no("treasury v4 never lined it (the move is for agents with a treasury v4 line)");
      if (a.activeLoans !== 0n) throw no("it has a loan open: repay your open loan first");
      if ((await this.pool.ownerDefaults(owner)) !== 0n && !(await this.pool.custodian(owner))) throw no("its owner's wallet was marked by a default");
      if ((await t.t4.seeded(id)) || (await t.t5.seeded(id))) throw no("its record was seeded by the protocol, and treasury v5 never raises a seeded record by rule");
      const [r, score, room, free, block] = await Promise.all([t.t5.rules(), t.t5.score(id), t.t5.epochRoom(), this.pool.freeBacking(t.root), this.provider.getBlock("latest")]);
      const now = BigInt(block.timestamp);
      const need = raiseShortfall({ agent: a, rules: r, score, now });
      if (need.length) throw no(`not yet: the raise on treasury v5 needs ${need.join(", ")}`);
      if (room < r.firstLine) throw no(`treasury v5's first lines for this epoch are used up (${fmtUsdg(room)} USDG of room left): try again next epoch`);
      if (free < r.firstLine) throw no(`treasury v5's free backing (${fmtUsdg(free)} USDG) does not cover a first line now: try again later`);
      const v1 = t.bondV1 ? (await t.bondV1.bonds(id)).depositor : ethers.ZeroAddress;
      const v1Bonded = v1 !== ethers.ZeroAddress;
      if (v1Bonded) {
        const back = await t.bondV1.unusedReleaseAt(id);
        if (back > now) throw no(`its InviteBond (v1) bond comes back only from ${utcAt(back)} (4 days after it was posted), and treasury v5 moves an agent only once that bond is gone: run this again from then`);
      }
      const v2 = (await t.bondV2.bonds(id)).depositor;
      const bondAmount = sameAddr(v2, me) ? 0n : await t.bondV2.amount();
      const usdg = await this._usdg();
      if (bondAmount > 0n && (await usdg.balanceOf(me)) < bondAmount) throw no(`the InviteBondV2 bond takes ${fmtUsdg(bondAmount)} USDG from ${me}, which holds ${fmtUsdg(await usdg.balanceOf(me))}`);

      // ---- the steps ----
      const step = async (name, fn) => {
        try {
          const rc = await fn();
          steps.push({ step: name, hash: rc.hash });
        } catch (e) {
          const words = MOVE_WORDS[(/would revert: (\w+)\(/.exec(String(e?.message)) || [])[1]];
          try { e.step = name; e.steps = steps; e.message = `${name}: ${words ? `${words} (${e.message})` : e.message}${steps.length ? ` (done before it: ${steps.filter((s) => s.hash).map((s) => s.step).join(", ") || "nothing"}; run the move again to go on)` : ""}`; } catch (_) { /* a frozen error keeps its own words */ }
          throw e;
        }
      };
      if (onV4) await step("leave", () => sendChecked(this.pool, "leave", [id], this._ifaces));
      else steps.push({ step: "leave", skipped: "not on treasury v4's line" });
      if (v1Bonded) await step("release v1 bond", () => sendChecked(t.bondV1, "release", [id], this._ifaces));
      else steps.push({ step: "release v1 bond", skipped: "no InviteBond (v1) bond" });
      if (bondAmount > 0n) {
        await step("bond on InviteBondV2", async () => {
          await this._ensure(usdg, await t.bondV2.getAddress(), bondAmount, "the InviteBondV2 bond");
          return sendChecked(t.bondV2, "deposit", [id], this._ifaces);
        });
      } else steps.push({ step: "bond on InviteBondV2", skipped: "the owner's InviteBondV2 bond is posted" });
      await step("move", async () => {
        const { consent, sig } = await this.signConsent({ agentId: id, sponsorId: t.root, maxPremiumBps: 0, deadline });
        return sendChecked(t.t5, "move", [id, consentTuple(consent), sig], this._ifaces);
      });
    }
    // ---- 5. the raise: not fatal (the keeper raises eligible v5 lines every 30 minutes), unless its answer was lost ----
    try {
      if (await t.t5.eligibleForRaise(id)) {
        const r = await sendChecked(t.t5, "raise", [id], this._ifaces);
        steps.push({ step: "raise", hash: r.hash });
      } else {
        steps.push({ step: "raise", skipped: `not eligible yet: ${(await this._raiseWhyNot(t.t5, id, await this.pool.getAgent(id))).join("; ")}` });
      }
    } catch (e) {
      if (e?.code === "TX_UNCONFIRMED") { try { e.step = "raise"; e.steps = steps; } catch (_) { /* as it is */ } throw e; }
      steps.push({ step: "raise", skipped: `${String(e?.shortMessage || e?.message || e).split("\n")[0]}; the keeper raises it within about 30 minutes once it can` });
    }
    let line = null;
    try { line = (await this.pool.getAgent(id)).delegatedIn; } catch (_) { /* the steps are done; the line is read again later */ }
    return { agentId: Number(id), steps, line };
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
   * A borrow whose answer was lost (the broadcast's or the receipt's) throws BORROW_UNCONFIRMED with the amount as
   * `borrowed` (`loanId` and `dueAt` null, `unconfirmed: true`, the tx `hash` and `nonce`): the loan may exist, or the
   * transaction may still be pending, so the open loans alone settle nothing. Borrow again only once `txStatus(hash,
   * { nonce, sentBlock, raw })` says it is final and did not run. A borrow that mined but whose loan cannot be read
   * from its receipt also throws it (`mined: true`): the loan is open. A refusal before sending, a mined revert or a
   * cancelled transaction is an ordinary error (see sendChecked): nothing was borrowed.
   */
  async borrow(agentId, amount, termSeconds, { to, maxFee } = {}) {
    const units = toUnits(amount);
    const term = BigInt(termSeconds);
    const fee = maxFee ?? (await this.pool.quoteFee(agentId, units, term)).fee;
    if (this.vaultV5) this._needSigner();
    const v5 = await v5BeforeBorrow({ signer: this.signer, pool: this.pool, v5: this.vaultV5, v5Root: this.addresses.seatVaultV5AgentId ?? null, agentId, amount: units });
    const recipient = to || (await this.me());
    try {
      return await sendChecked(this.pool, "borrow", [agentId, units, term, recipient, fee], this._ifaces, (rc) => {
        const ev = this._event(rc, "Borrowed");
        if (!ev) throw new Error("no Borrowed event in the receipt");
        return { hash: rc.hash, loanId: Number(ev.args.loanId), principal: ev.args.principal, fee: ev.args.fee, dueAt: Number(ev.args.dueAt), ...(v5.v5 ? { v5Refreshed: v5.refreshed, v5Noted: v5.noted } : {}) };
      });
    } catch (e) {
      if (e?.code !== "TX_UNCONFIRMED") throw e;
      const why = e.cause?.shortMessage || e.cause?.message || String(e.cause);
      const what = `a borrow of ${fmtUsdg(units)} USDG for agent #${agentId}`;
      throw Object.assign(new Error(e.mined
        ? `${what} was mined (tx ${e.hash}) but its loan could not be read from the receipt (${why}): the loan is open. Do not borrow again, and repay it before its due date`
        : `${what} was sent${e.hash ? ` (tx ${e.hash}, nonce ${e.nonce})` : ""} and its answer was lost (${why}): it may have opened a loan, or may still be pending. Do not borrow again until this transaction is final (mined, reverted, or replaced: txStatus); if it opened a loan, repay it before its due date`),
      { code: "BORROW_UNCONFIRMED", borrowed: units, loanId: null, dueAt: null, unconfirmed: true, mined: e.mined, hash: e.hash, nonce: e.nonce, raw: e.raw, sentBlock: e.sentBlock, cause: e.cause });
    }
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

  /**
   * Whether a transaction is final, and whether it ran: for one whose answer was lost (TX_UNCONFIRMED and
   * BORROW_UNCONFIRMED carry its `hash`, `nonce`, `sentBlock` and, signed here, `raw`). `state` is
   *   "mined"     a receipt with status 1: it ran. Its own receipt, or that of a copy of the same call at the same
   *               nonce with another hash (a fee-bumped speed-up: `by` is that hash): never "replaced", never safe to
   *               send again
   *   "reverted"  a receipt with status 0 (its own, or the copy's): it did nothing
   *   "replaced"  the transaction that used its nonce was found, in the block where this sender's nonce count passed
   *               it, and it is a different call (`by`): this one can never run, so it did not run. Telling a copy
   *               from a different call needs the recorded signed bytes (`raw`) or the node's copy of this one; without
   *               either it stays "unsettled"
   *   "included"  the node shows it (or the copy) mined but its receipt is not readable yet: it may have run
   *   "unsettled" its nonce was used, but this node cannot show by which transaction
   *   "pending"   known to this node, its nonce not used yet
   *   "not-found" unknown to this node, its nonce not used (mempools are node-local, so another node may hold it, or it
   *               may still arrive). Settle it by sending the same signed bytes again
   *               (`provider.broadcastTransaction(raw)`: same hash, same nonce, it cannot make a second one), or by having
   *               a wallet cancel the nonce (a 0-value transfer to itself at that nonce, at a higher fee) and waiting for
   *               that nonce to be mined.
   * `final` is true only for mined, reverted or replaced, and only once the deciding block is at or below the chain's
   * finalized block with the canonical hash at its number (`finality`: "finalized"; "waiting" above it, "reorged" when
   * the canonical block there has another hash, "unknown" when either cannot be read). Until then the verdict is shown
   * but may still change. Send the call again only once `final` is true and `ran` false.
   * `from` defaults to the signer's address; `sentBlock` bounds the search for the nonce's block. `seen` (returned, to
   * pass back next time) keeps what was observed: `consumedBy` { block, blockHash, hash }, the block where the nonce's
   * transaction was found, re-read from its body later, since a node can drop the state that found it before that block
   * is finalized; `consumedAt` { block, blockHash }, a block at which the nonce was already counted as used. `explorer`
   * ({ from, nonce, sentBlock }) => hashes (sdk/explorer.mjs) is asked only when the node cannot find the nonce's
   * transaction itself, and only as a pointer: each hash it names is checked on the RPC.
   */
  async txStatus(hash, { nonce, from, sentBlock, raw, seen, explorer } = {}) {
    const p = this.provider;
    const tx = await p.getTransaction(hash);
    const mine = raw ? ethers.Transaction.from(raw) : null;
    const who = tx ? tx.from : mine ? mine.from : from ?? (this.signer ? await this.signer.getAddress() : null);
    const n = tx ? tx.nonce : mine ? mine.nonce : nonce == null ? null : Number(nonce);
    const ref = mine || tx; // the call it makes: what a fee-bumped copy repeats
    const obs = { ...(seen || {}) };
    const out = { hash, from: who, nonce: n };
    const verdict = async (rc, by) => {
      const finality = await finalityOf(p, rc.blockNumber, rc.blockHash);
      return { ...out, state: rc.status === 1 ? "mined" : "reverted", final: finality === "finalized", ran: rc.status === 1, block: rc.blockNumber, finality, ...(by ? { by } : {}), seen: obs };
    };
    const notFinal = (state, more = {}) => ({ ...out, state, final: false, ran: null, ...more, seen: obs });
    const rc = await p.getTransactionReceipt(hash);
    if (rc) return verdict(rc);
    if (tx && tx.blockNumber != null) return notFinal("included", { block: tx.blockNumber });
    const open = notFinal(tx ? "pending" : "not-found");
    if (who == null || n == null) return open;
    let user = null;
    if (obs.consumedBy) {
      try {
        user = await inBlock(p, obs.consumedBy.block, who, n);
        if (!user) delete obs.consumedBy; // that block no longer holds it: search again
      } catch (_) { /* the block cannot be read now: search */ }
    }
    if (!user) {
      // has its nonce been used? Counted at one pinned block; if so, find the transaction that used it
      try {
        const head = await p.getBlock("latest");
        if ((await p.getTransactionCount(who, head.number)) <= n) return open;
        if (!obs.consumedAt) obs.consumedAt = { block: head.number, blockHash: head.hash };
        user = await nonceUser(p, who, n, head.number, sentBlock);
      } catch (_) {
        user = null; // a read this node cannot serve: nothing is claimed
      }
    }
    if (!user && explorer) user = await viaExplorer(p, explorer, who, n, sentBlock).catch(() => null);
    if (!user) return notFinal("unsettled");
    obs.consumedBy = { block: user.block, blockHash: user.blockHash, hash: user.tx.hash };
    const by = user.tx.hash;
    if (by.toLowerCase() === String(hash).toLowerCase()) {
      const again = await p.getTransactionReceipt(hash); // it is ours: final only once its receipt says how it ran
      return again ? verdict(again) : notFinal("included", { block: user.block });
    }
    if (!ref) return notFinal("unsettled", { by, block: user.block }); // nothing to tell a copy from another call
    if (sameCall(ref, user.tx)) {
      const copy = await p.getTransactionReceipt(by);
      return copy ? verdict(copy, by) : notFinal("included", { by, block: user.block });
    }
    const finality = await finalityOf(p, user.block, user.blockHash);
    return { ...out, state: "replaced", final: finality === "finalized", ran: false, by, block: user.block, finality, seen: obs };
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
    const [tRoot, vRoots, sRoot, t5Root] = await Promise.all([this.treasury ? this.treasury.agentId() : 0n, Promise.all(vs.map((v) => v.agentId())), this.stockVault ? this.stockVault.agentId() : 0n, this.treasuryV5 ? this.treasuryV5.agentId() : 0n]);
    const sponsor = a.sponsor;
    const onStock = sponsor !== 0n && sponsor === sRoot;
    const onSeat = sponsor !== 0n && vRoots.includes(sponsor);
    const sponsorKind = sponsor === 0n ? "none" : sponsor === tRoot ? "treasury v4" : sponsor === t5Root ? "treasury v5" : onSeat ? "seat vault" : onStock ? "stock vault" : "backer";
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
    // the position is read after the write: a failed read is TX_UNCONFIRMED (mined), never an error inviting a 2nd deposit
    return sendChecked(v, "open", [BigInt(agentId), ethers.getAddress(token), units, consentTuple(consent), sig], this._ifaces,
      async (rc) => ({ hash: rc.hash, agentId: Number(agentId), position: await this.stockPosition(agentId) }));
  }

  /** Add `amount` of the position's own token (the depositor only): a higher borrow limit. */
  async addCollateral(agentId, amount) {
    const v = this._need(this.stockVault, "stockVault");
    const p = await v.getPosition(BigInt(agentId));
    if (Number(p.status) !== 1) throw new Error(`agent #${agentId} has no open stock position`);
    const units = await this._tokenUnits(p.token, amount);
    await this._ensure(new ethers.Contract(p.token, ERC20_ABI, this.signer), await v.getAddress(), units, `addCollateral(${agentId})`);
    return sendChecked(v, "addCollateral", [BigInt(agentId), units], this._ifaces,
      async (rc) => ({ hash: rc.hash, agentId: Number(agentId), position: await this.stockPosition(agentId) }));
  }

  /** Close agent `agentId`'s stock line (depositor or controller): no new loans; the tokens go back to the depositor
   *  now with no loan open, otherwise with the repayment of the last one. */
  async closeStockLine(agentId) {
    this._needSigner();
    return sendChecked(this._need(this.stockVault, "stockVault"), "close", [BigInt(agentId)], this._ifaces,
      async (rc) => ({ hash: rc.hash, agentId: Number(agentId), position: await this.stockPosition(agentId) }));
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
   `account` (default: the signer's address). A step whose outcome is not known throws TX_UNCONFIRMED (sdk/pt-usdg.mjs):
   check ptPosition before trading again. Its wait is bounded by this instance's waitTimeoutMs. */
const ptTrade = (fn) => async function (amount, opts = {}) {
  const { send = true, account, ...rest } = opts;
  const wallet = send && this.signer ? this.signer : undefined;
  const who = account || (this.signer ? await this.signer.getAddress() : undefined);
  return fn(this.provider, { waitTimeoutMs: this._ifaces?.waitTimeoutMs, ...rest, amount, account: who, wallet });
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
