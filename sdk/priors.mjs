// Priors SDK: everything an agent needs to build a credit history, in one small ESM module on ethers v6.
//
//   import { Priors } from "./sdk/priors.mjs";
//   const s = new Priors({ rpc, pool, treasury, signer });   // signer: the wallet that owns the ERC-8004 id
//   await s.firstLine(agentId, inviteCode);                    // the treasury vouches $5, against a signed invite
//   const loanId = await s.borrow(agentId, 5, 7);              // $5 for 7 days
//   await s.repay(loanId);                                     // principal + fee; approves USDG if needed
//   await s.score(agentId);                                    // 0..1000, straight from the contract
//
// Amounts are in whole dollars (USDG has 6 decimals; the SDK converts). Every call is one transaction or one
// view; nothing is stored anywhere but the chain.
//
// PT-USDG (Pendle's principal token for USDG; the markets of deployments/pendle.4663.json) from the same entry, sdk/pt-usdg.mjs:
//   import { ptQuote, ptBuy, ptSell, ptRedeem, ptPosition } from "./sdk/priors.mjs";
//   await ptQuote(rpc, { side: "buy", amount: 100 }); const { calls } = await ptBuy(rpc, { account, amount: 100 });
import { ethers } from "ethers";
export { PT_USDG, PT_MARKETS, ptQuote, ptBuy, ptSell, ptRedeem, ptPosition, ptListing, impliedApy } from "./pt-usdg.mjs";

const USDC = 1_000_000n;
export const POOL_ABI = [
  "function borrow(uint256 agentId, uint256 amount, uint64 term, address to) returns (uint256 loanId)",
  "function repay(uint256 loanId)",
  "function score(uint256 agentId) view returns (uint256)",
  "function available(uint256 agentId) view returns (uint256)",
  "function creditReport(uint256) view returns (tuple(bool enrolled,bool isRoot,bool defaulted,uint256 sponsor,uint256 capacity,uint256 available,uint256 delegatedIn,uint256 delegatedOut,uint256 earned,uint256 stake,uint256 principalOut,uint256 activeLoans,uint256 loansRepaid,uint256 volumeRepaid,uint256 feesPaid,uint256 recourseHonored,uint256 childrenDefaulted,uint64 enrolledAt,uint256 score,uint256 qualifiedRepaid,uint256 dollarSecondsRepaid))",
  "function getLoan(uint256) view returns (tuple(uint256 agentId,uint256 principal,uint256 fee,uint64 issuedAt,uint64 dueAt,uint64 closedAt,uint8 status,bool isRecourse,uint256 recourseFor))",
  "function loansOf(uint256 agentId) view returns (uint256[])",
  "function getParams() view returns (tuple(uint256 minLoan,uint256 maxLoan,uint64 minTerm,uint64 maxTerm,uint64 grace,uint64 recourseTerm,uint256 feeBps,uint256 growthBps,uint256 maxEarned,uint256 maxEarnPerEpoch,uint64 epochLength,uint64 minSeasoning,uint256 minStake,uint256 sponsorFeeBps,uint256 protocolFeeBps,uint64 minScoreTerm))",
  // Asked of the contract rather than re-derived in JS - see quote().
  "function quoteFee(uint256 amount, uint64 term) view returns (uint256)",
  "function usdc() view returns (address)",
  "function registry() view returns (address)",
  "function vouch(uint256 sponsorId, uint256 agentId, uint256 amount)",
  "function enrollRoot(uint256 agentId, uint256 stakeAmount)",
  "function setDelegate(uint256 agentId, address delegate)",
  "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, uint64 dueAt, address to)",
  /* The pool reverts with custom errors, which are four bytes on the wire. Without these in the ABI every
     failure reaches an integrator as an undecoded selector - "0x1f2a2005" instead of
     "InsufficientCapacity(462, 11000000, 5000000)", which is the difference between a two-minute fix and
     an afternoon. */
  "error NotController(uint256 agentId, address caller)",
  "error InvalidAgent(uint256 agentId)",
  "error AlreadyEnrolled(uint256 agentId)",
  "error NotEnrolled(uint256 agentId)",
  "error AgentDefaulted(uint256 agentId)",
  "error IsRoot(uint256 agentId)",
  "error NotRoot(uint256 agentId)",
  "error WrongSponsor(uint256 agentId, uint256 currentSponsor)",
  "error InsufficientCapacity(uint256 agentId, uint256 requested, uint256 available)",
  "error DelegationInUse(uint256 agentId, uint256 requested, uint256 releasable)",
  "error ImportOutOfRange(uint256 agentId)",
  "error InsufficientLiquidity(uint256 requested, uint256 available)",
  "error LoanSizeOutOfRange(uint256 amount)",
  "error TermOutOfRange(uint64 term)",
  "error LoanNotActive(uint256 loanId)",
  "error LoanNotDue(uint256 loanId, uint64 dueAt)",
  "error ZeroAmount()",
  "error BelowMinStake(uint256 amount, uint256 minStake)",
  "error InvalidParams()",
  "error DelegationExceedsEarned(uint256 agentId, uint256 requested, uint256 earnedRoom)",
  "error ReserveLocked(uint256 requested, uint256 free)",
  "error ImportsAreSealed()",
  "error RecordAlreadyLive(uint256 agentId)",
  "error BadEnrolmentDate(uint256 agentId, uint64 enrolledAt)",
];
export const TREASURY_ABI = [
  // v3 takes an invite; v2 did not. Both are listed because an integrator may still be pointed at a v2
  // treasury, and ethers needs the full signature to pick between them - see firstLine() below.
  "function firstLine(uint256 agentId, uint64 expiry, bytes invite)",
  "function firstLine(uint256 agentId)",
  "function inviteDigest(uint256 agentId, uint64 expiry) view returns (bytes32)",
  "function inviters(address) view returns (bool)",
  "function raise(uint256 agentId)",
  "function epochRoom() view returns (uint256)",
  "function firstLined(uint256) view returns (bool)",
  "function eligibleForRaise(tuple(bool enrolled,bool isRoot,bool defaulted,uint256 sponsor,uint256 capacity,uint256 available,uint256 delegatedIn,uint256 delegatedOut,uint256 earned,uint256 stake,uint256 principalOut,uint256 activeLoans,uint256 loansRepaid,uint256 volumeRepaid,uint256 feesPaid,uint256 recourseHonored,uint256 childrenDefaulted,uint64 enrolledAt,uint256 score,uint256 qualifiedRepaid,uint256 dollarSecondsRepaid)) view returns (bool)",
  "function agentId() view returns (uint256)",
  "error NotAdopted()",
  "error NotOurs(uint256 agentId)",
  "error AlreadyLined(uint256 agentId)",
  "error AlreadyEnrolled(uint256 agentId)",
  "error NotEligible(uint256 agentId)",
  "error EpochCapReached(uint256 wanted, uint256 left)",
  "error NotController(uint256 agentId, address caller)",
  "error NotInvited(uint256 agentId, address signer)",
  "error InviteExpired(uint256 agentId, uint64 expiry)",
  "error InviteUsed(uint256 agentId)",
  "error NotIdle(uint256 agentId, uint256 reclaimableAt)",
  "error NothingToReclaim(uint256 agentId)",
  "error InvalidRules()",
];

/**
 * Pull apart an invite code as the invite script prints it and the bot hands it over:
 * `priors-invite:<agentId>:<expiry>:<signature>`.
 *
 * Checked here rather than on chain because every one of these is a mistake a caller can fix in a second -
 * wrong agent, stale code - while the same mistake sent as a transaction costs gas to be told the same thing.
 */
export function parseInvite(code, agentId) {
  const m = /^priors-invite:(\d{1,10}):(\d{1,12}):(0x[0-9a-fA-F]{130})$/.exec(String(code || "").trim());
  if (!m) throw new Error("not an invite code (expected priors-invite:<agentId>:<expiry>:<signature>)");
  if (agentId != null && Number(m[1]) !== Number(agentId)) throw new Error(`this invite is for agent #${m[1]}, not #${agentId}`);
  const expiry = Number(m[2]);
  if (expiry * 1000 < Date.now()) throw new Error(`this invite expired on ${new Date(expiry * 1000).toISOString()}`);
  return { agentId: Number(m[1]), expiry, signature: m[3] };
}
const ERC20_ABI = ["function approve(address,uint256)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
const REGISTRY_ABI = ["function ownerOf(uint256) view returns (address)", "function register(string) returns (uint256)", "event Registered(uint256 indexed agentId, address indexed owner, string agentURI)"];

const toUnits = (dollars) => (typeof dollars === "bigint" ? dollars : BigInt(Math.round(Number(dollars) * 1e6)));
const toDollars = (units) => Number(units) / 1e6;

/**
 * Turn a revert into a sentence. ethers surfaces a failed call as an error carrying four bytes of selector
 * and prints the whole transaction object around it, so the useful part - which rule you broke - is the one
 * thing not visible. Decoded against the contract's own ABI it reads
 * `InsufficientCapacity(462, 11000000, 5000000)`: the agent, what it asked for, what it had.
 */
export function explainRevert(err, ifaces) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data || err?.transaction?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    for (const iface of ifaces) {
      try {
        const d = iface.parseError(data);
        if (d) return `${d.name}(${d.args.map((a) => String(a)).join(", ")})`;
      } catch (_) { /* not this ABI's error */ }
    }
  }
  return err?.shortMessage || err?.message || String(err);
}

/**
 * Simulate, then send.
 *
 * A doomed transaction otherwise costs gas to discover, and on a chain that mines it anyway it comes back
 * with status 0 and NO revert data at all - the reason only exists before the send. One `eth_call` buys a
 * readable failure and a refund.
 */
async function sendChecked(contract, method, args, ifaces) {
  try {
    await contract[method].staticCall(...args);
  } catch (err) {
    throw new Error(`${method}(${args.map((a) => String(a)).join(", ")}) would revert: ${explainRevert(err, ifaces)}`);
  }
  /* ethers sends the gas estimate verbatim, with no headroom. That is a real footgun here: `repay` runs
     `_grow`, whose cost depends on seasoning and the epoch counters, so a branch taken at send time that
     the estimate did not take costs slightly more - and the transaction mines with status 0 and NO revert
     data, which is indistinguishable from a rule being broken. `test-reader-cache.mjs` documents the same
     trap at about one run in five. Unused gas is refunded, so 25% of headroom costs nothing and removes
     the flake. */
  let overrides = {};
  try {
    const est = await contract[method].estimateGas(...args);
    overrides = { gasLimit: est + est / 4n };
  } catch (_) { /* node refuses to estimate: let ethers try its own way rather than fail here */ }
  const tx = await contract[method](...args, overrides);
  return tx.wait();
}

export class Priors {
  /** @param {{rpc?: string, provider?: any, pool: string, treasury?: string, signer?: any}} opts */
  constructor(opts) {
    // cacheTimeout off: on chains that mine instantly, ethers' 250 ms result cache hands back stale nonces
    this.provider = opts.provider || new ethers.JsonRpcProvider(opts.rpc, undefined, { cacheTimeout: -1 });
    this.signer = opts.signer ? (opts.signer.provider ? opts.signer : opts.signer.connect(this.provider)) : null;
    const runner = this.signer || this.provider;
    this.pool = new ethers.Contract(opts.pool, POOL_ABI, runner);
    this.treasury = opts.treasury ? new ethers.Contract(opts.treasury, TREASURY_ABI, runner) : null;
    // Both, in order: a treasury call can revert with a pool error, since firstLine() ends up in vouch().
    this._ifaces = [this.pool.interface, ...(this.treasury ? [this.treasury.interface] : [])];
  }

  // ---- read ----
  async score(agentId) { return Number(await this.pool.score(agentId)); }
  async report(agentId) {
    const r = await this.pool.creditReport(agentId);
    return {
      enrolled: r.enrolled, isRoot: r.isRoot, defaulted: r.defaulted, sponsor: Number(r.sponsor), score: Number(r.score),
      capacity: toDollars(r.capacity), available: toDollars(r.available), delegatedIn: toDollars(r.delegatedIn), earned: toDollars(r.earned), stake: toDollars(r.stake),
      principalOut: toDollars(r.principalOut), activeLoans: Number(r.activeLoans), loansRepaid: Number(r.loansRepaid), qualifiedRepaid: Number(r.qualifiedRepaid),
      dollarDaysRepaid: Number(r.dollarSecondsRepaid / 86400n) / 1e6, volumeRepaid: toDollars(r.volumeRepaid), feesPaid: toDollars(r.feesPaid),
      recourseHonored: Number(r.recourseHonored), childrenDefaulted: Number(r.childrenDefaulted), enrolledAt: Number(r.enrolledAt),
    };
  }
  async loans(agentId) {
    const ids = await this.pool.loansOf(agentId);
    return Promise.all(ids.map(async (id) => { const l = await this.pool.getLoan(id); return { loanId: Number(id), principal: toDollars(l.principal), fee: toDollars(l.fee), issuedAt: Number(l.issuedAt), dueAt: Number(l.dueAt), status: ["none", "active", "repaid", "defaulted"][Number(l.status)], isRecourse: l.isRecourse }; }));
  }
  /**
   * Fee for a loan of `dollars` over `days`, in dollars, asked of the contract.
   *
   * This used to re-derive `amount * feeBps * term / (10000 * 30 days)` in JavaScript. The two agree on
   * every value tested, so it was never a wrong number - but it was the same rule written twice, and the
   * copy in here is the one that cannot be redeployed in step with the other. `quoteFee` is a view; there
   * is no reason to guess what it would say.
   */
  async quote(dollars, days) {
    const units = toUnits(dollars);
    const term = BigInt(Math.round(days * 86400));
    const [fee, p] = await Promise.all([this.pool.quoteFee(units, term), this.pool.getParams()]);
    return {
      fee: toDollars(fee),
      total: toDollars(units + fee),
      qualifiesForScore: term >= p.minScoreTerm,
      withinTermLimits: term >= p.minTerm && term <= p.maxTerm,
      withinSizeLimits: units >= p.minLoan && units <= p.maxLoan,
    };
  }

  // ---- write ----
  _needSigner() { if (!this.signer) throw new Error("this call needs a signer"); }
  /**
   * Ask the treasury for a first line, for an ERC-8004 identity that was never enrolled.
   *
   * Treasury v3 needs two people to agree: the identity's own controller signs the transaction, and an
   * inviter the treasury's owner named has signed `Invite(agentId, expiry)` for it. Pass the invite code
   * you were handed: registration is open to everyone, treasury money is not.
   *
   * Omit `invite` only against a v2 treasury, where first lines had no invite. Against v3 that call does
   * not exist, so leaving it out there fails at the ABI rather than quietly doing something else.
   */
  async firstLine(agentId, invite) {
    this._needSigner();
    if (!this.treasury) throw new Error("no treasury address configured");
    if (invite == null) {
      return (await sendChecked(this.treasury, "firstLine(uint256)", [agentId], this._ifaces)).hash;
    }
    const { expiry, signature } = parseInvite(invite, agentId);
    return (await sendChecked(this.treasury, "firstLine(uint256,uint64,bytes)", [agentId, expiry, signature], this._ifaces)).hash;
  }
  /**
   * Sign an invite that seats `agentId`, as the inviter. Only useful if this signer is one the treasury's
   * owner has named with `setInviter`: anyone else's signature is a valid signature of the wrong thing, and
   * the contract refuses it with `NotInvited`.
   *
   * Returns the code in the one format everything else here reads: `priors-invite:<id>:<expiry>:<signature>`.
   */
  async signInvite(agentId, hours = 72) {
    this._needSigner();
    if (!this.treasury) throw new Error("no treasury address configured");
    const expiry = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
    const { chainId } = await this.provider.getNetwork();
    const domain = { name: "Priors Treasury", version: "3", chainId, verifyingContract: await this.treasury.getAddress() };
    const types = { Invite: [{ name: "agentId", type: "uint256" }, { name: "expiry", type: "uint64" }] };
    const signature = await this.signer.signTypedData(domain, types, { agentId: BigInt(agentId), expiry: BigInt(expiry) });
    return { agentId: Number(agentId), expiry, inviter: await this.signer.getAddress(), signature, code: `priors-invite:${agentId}:${expiry}:${signature}` };
  }
  /** Raise a treasury-sponsored agent's line once its record qualifies. */
  async raise(agentId) {
    this._needSigner();
    if (!this.treasury) throw new Error("no treasury address configured");
    return (await sendChecked(this.treasury, "raise", [agentId], this._ifaces)).hash;
  }
  // Array.from is load-bearing: creditReport() hands back a frozen ethers Result, and the tuple encoder for
  // eligibleForRaise writes into the array it is given, so passing the Result straight through throws
  // "Cannot assign to read only property '0'" for every agent, eligible or not.
  async canRaise(agentId) { return this.treasury.eligibleForRaise(Array.from(await this.pool.creditReport(agentId))); }
  /** Borrow `dollars` for `days`; USDG lands in `to` (default: the signer). Returns the loanId. */
  async borrow(agentId, dollars, days, to) {
    this._needSigner();
    const rc = await sendChecked(
      this.pool,
      "borrow",
      [agentId, toUnits(dollars), BigInt(Math.round(days * 86400)), to || (await this.signer.getAddress())],
      this._ifaces
    );
    for (const log of rc.logs) { try { const ev = this.pool.interface.parseLog(log); if (ev && ev.name === "Borrowed") return Number(ev.args.loanId); } catch (_) {} }
    throw new Error("Borrowed event not found");
  }
  /** Repay principal + fee. Approves the pool for exactly what is due if the allowance is short. */
  async repay(loanId) {
    this._needSigner();
    const l = await this.pool.getLoan(loanId);
    const due = l.principal + l.fee;
    const usdc = new ethers.Contract(await this.pool.usdc(), ERC20_ABI, this.signer);
    const me = await this.signer.getAddress();
    const poolAddr = await this.pool.getAddress();
    if ((await usdc.allowance(me, poolAddr)) < due) await (await usdc.approve(poolAddr, due)).wait();
    /* Checked after the approval, not before: repay pulls with transferFrom, so simulating a repayment the
       allowance cannot yet cover would fail for a reason that is about to stop being true. */
    if ((await usdc.balanceOf(me)) < due) {
      throw new Error(`repay(${loanId}) needs ${toDollars(due)} USDG but ${me} holds ${toDollars(await usdc.balanceOf(me))}`);
    }
    return (await sendChecked(this.pool, "repay", [loanId], this._ifaces)).hash;
  }
  /**
   * Register a new ERC-8004 identity on registries that expose register(string). Returns the agentId.
   *
   * The id is read from the ERC-721 `Transfer` mint log, not from a `Registered` event: an identity registry is
   * an ERC-721, so every one of them emits `Transfer(0x0, owner, tokenId)`, while the registry-specific event
   * differs between implementations. Robinhood Chain's `AgentIdentity` emits
   * `Registered(uint256,string,address)` — the same name as the dev registry's
   * `Registered(uint256,address,string)` but a different argument order, so decoding by name found nothing and
   * this threw for every real registration.
   */
  async register(uri) {
    this._needSigner();
    const registry = await this.pool.registry();
    const reg = new ethers.Contract(registry, REGISTRY_ABI, this.signer);
    const rc = await sendChecked(reg, "register", [uri || ""], this._ifaces);
    const MINT = ethers.id("Transfer(address,address,uint256)");
    const ZERO = "0x" + "0".repeat(64);
    const me = (await this.signer.getAddress()).toLowerCase();
    // ERC-721 Transfer indexes all three args, so a mint is topics = [sig, 0x0, to, tokenId].
    const mints = rc.logs.filter(
      (log) => log.address.toLowerCase() === registry.toLowerCase() && log.topics.length === 4 && log.topics[0] === MINT && log.topics[1] === ZERO
    );
    // Match on the recipient rather than taking the first mint: a registry that minted a second, companion token
    // in the same transaction would otherwise hand back somebody else's id, and the caller would go on to build a
    // credit history against an identity it does not own.
    const ours = mints.filter((log) => ethers.getAddress("0x" + log.topics[2].slice(26)).toLowerCase() === me);
    if (ours.length === 1) return Number(BigInt(ours[0].topics[3]));
    if (ours.length > 1) throw new Error(`registry ${registry} minted ${ours.length} identities to ${me} in tx ${rc.hash}; cannot tell which one is yours`);
    if (mints.length) throw new Error(`registry ${registry} minted in tx ${rc.hash}, but to someone other than ${me}`);
    throw new Error(`no ERC-721 mint log from the registry ${registry} in tx ${rc.hash}; is it an ERC-8004 identity registry?`);
  }
}
export default Priors;
