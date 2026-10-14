// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {CreditPoolV2, IBackerHook} from "./CreditPoolV2.sol";
import {InviteBondV2} from "./InviteBondV2.sol";
import {ScoreLib} from "./libraries/ScoreLib.sol";
import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";
import {IPonsFeeEscrow, IPonsFactoryCreator} from "./interfaces/IPonsFeeEscrow.sol";

/// @notice The treasury v5 replaces (TreasurySponsorV4): which agents it lined, which it flagged as protocol-seeded, and
///         its root.
interface IPreviousTreasury {
    function firstLined(uint256 agentId) external view returns (bool);
    function seeded(uint256 agentId) external view returns (bool);
    function agentId() external view returns (uint256);
}

/// @notice The previous treasury's invite bond (InviteBond v1): whether an agent still has a bond there.
interface ILegacyBond {
    function isBonded(uint256 agentId) external view returns (bool);
}

/// @title TreasurySponsorV5
/// @notice Treasury v4, unchanged, plus one rule at borrow time: a line whose agent carries an invite bond posted by
///         someone other than the agent's owner cannot be borrowed on (GHSA-w9xg).
///
///         Why. InviteBond binds its bond to (agent, depositor), while a treasury line follows the agent's NFT. On v4,
///         after an owner sells the agent, the buyer can borrow on the line that is already open, or redeem the
///         seller's unused invite (an invite names only the agent), then default; `InviteBond.slash` then takes the
///         seller's bond. Returning the bond to the seller when the NFT moves would be worse: bond, move the agent to
///         one's own second wallet, borrow, default, and get the bond back.
///
///         The rule. The treasury is its own root's backer hook (`IBackerHook`): the pool asks `canBorrow` before
///         every borrow on a line this root backs and refuses the borrow unless the answer is yes. The answer is no
///         exactly when `bond.bonds(agentId).depositor` is set and is not the agent's owner at borrow time (the
///         `owner` the pool passes, the address a default would mark). A new owner unblocks the line by posting its
///         own bond: `InviteBondV2.deposit` replaces the old bond and returns it to the old depositor in the same
///         transaction, so the agent stays covered by exactly one bond, the borrower's. Moving the agent between
///         one's own wallets still gains nothing: the second wallet has to lock a bond of its own before it can
///         borrow, and its default forfeits that bond. An agent with no bond (an admin-approved invite) borrows as
///         on v4. A bond is never released while the agent holds a line (InviteBondV2), so a bonded line stays
///         bonded, raised or not, for as long as it is open.
///
///         The bond is InviteBondV2, not InviteBond: a deposit is refused while the agent has a loan open. Asking a
///         buyer to bond would otherwise let the buyer's deposit replace the seller's bond under a loan the seller
///         took, and the seller's default would then be slashed from the buyer's bond. With V2 the seller's loan stays
///         on the seller's bond until it is repaid or defaulted, and a buyer can only bond an agent with nothing
///         outstanding. V2 also releases a bond only once the agent's line is closed (no record of repayments
///         releases it early, audit 2026-10-10 H1); the constructor checks that the bond names this treasury.
///
///         The hook is set by the sweep that enrolls the root, in the same call. The pool applies a hook at once
///         only while the root backs nothing, and a root cannot back anything before it is enrolled, so no line of
///         this treasury ever exists without the hook. Nothing in this contract can change or remove the hook
///         afterwards (only the root's owner, this contract, could call the pool's `setHook` or `retireRoot`). The
///         pool's notifications (`onBorrow`, `onDefault`, `onRelease`) are accepted and ignored, so they never fail.
///
///         Everything else is v4's. Creator fees the project token earns on Pons can be routed here; a sweep sends a
///         share to the pool's reserve and stakes the rest as pool shares under the treasury's own ERC-8004 identity,
///         a root backer. The treasury holds that identity's NFT, so it is the only caller of the pool's owner-only
///         root functions (vouchWithConsent, vouch, unvouch, freeze, unlock, claimSponsorFees, setHook) for it.
///         From that stake it vouches by rule, not by judgement:
///
///           firstLine(agent)  a small first line, only with TWO signatures: an invite from an inviter the
///                             owner named (EIP-712, "Priors Treasury" version "5"), and the agent owner's
///                             pool consent. Anyone may submit them (a relayer, the invite bot, the owner),
///                             so it is one signature for the agent's owner. Registration is permissionless;
///                             treasury money is not.
///           move(agent)       an agent the previous treasury (v4) lined gets its first line here instead,
///                             with the owner's consent and the owner's InviteBondV2 bond, no invite.
///           raise(agent)      a seasoned, clean line the treasury backs is topped up to the second tier.
///           reclaim(agent)    a line nobody has borrowed or repaid on for `idleAfter` goes back to the
///                             treasury, so the capacity seats the next agent instead of a dead identity.
///
///         Every line is 100% the treasury's own stake (no earned credit), and a default burns the treasury's shares
///         worth the principal and the unpaid fee. Lenders never take a loss. A raise is a top-up vouch out of the
///         treasury's own free backing. Two budgets on one epoch clock bound how much new exposure the rules can open
///         per epoch: `epochCap` for first lines, `raiseCap` for raises, so raises never use up the newcomers' room.
///         A raise is backed by the agent's record, not by a bond (the invite bond stays at the first line's
///         amount): `raiseCap` is what such trust can cost per epoch. Reclaim reads the pool's own `lastBorrowAt`/`lastRepayAt`; an open loan
///         always counts as activity. Imported v1 agents may be invited; an agent whose v1 record was
///         protocol-seeded is flagged by the owner and never raised by rule. Premium is 0: treasury lines cost the
///         base fee only. A raise only tops up a line that is open right now (a reclaimed seat stays closed until a
///         fresh invite reopens it), an invite seats an agent once (inviteUsed by digest), and a sweep never splits a
///         waiting stake share again.
///
///         Sweep, raise, reclaim and collect are permissionless. The owner changes parameters, names inviters,
///         can freeze a treasury line (wind-down: new borrows stop and the line comes back as its loans close),
///         and pulls back stake that backs nothing. The stake's lender yield compounds into the treasury's
///         backing; sponsor fees go to the fee sink (a fee wallet the owner sets).
contract TreasurySponsorV5 is Ownable2Step, IERC721Receiver, EIP712, IBackerHook {
    using SafeERC20 for IERC20;

    /// @dev EIP-712: Invite(uint256 agentId,uint64 expiry). Bound to this contract and chain by the domain.
    bytes32 public constant INVITE_TYPEHASH = keccak256("Invite(uint256 agentId,uint64 expiry)");
    uint64 public constant MAX_EPOCH = 365 days;

    struct Rules {
        uint256 reserveBps; // share of each sweep that goes to the reserve; the rest is staked
        uint256 firstLine; // USDG, line for an invited identity
        uint256 secondLine; // USDG, line after a clean record
        uint256 epochCap; // USDG vouched in first lines per epoch (raises have their own `raiseCap`)
        uint64 epochLength; // seconds
        uint64 minSeasoning; // seconds since enrollment before a raise
        uint256 minQualified; // qualified loans repaid before a raise
        uint256 minScore; // score before a raise
        uint64 idleAfter; // seconds without a borrow, a repayment or a line change before a line can be reclaimed
    }

    CreditPoolV2 public immutable pool;
    IERC20 public immutable asset;
    IERC8004Identity public immutable registry;
    IPonsFeeEscrow public immutable escrow; // may be zero on chains without Pons
    IPonsFactoryCreator public immutable factory;
    InviteBondV2 public immutable bond; // the invite bonds the borrow check reads
    IPreviousTreasury public immutable previous; // the treasury whose agents `move` takes over (zero: none)
    ILegacyBond public immutable legacyBond; // its invite bond: `move` waits until the agent's bond there is gone

    uint256 public agentId; // the treasury's own ERC-8004 identity (its root), once adopted
    address public feeSink; // where collected sponsor fees go (a fee wallet the owner sets)
    Rules public rules;

    uint64 public epochStart;
    uint256 public vouchedThisEpoch; // first lines this epoch, against rules.epochCap
    uint256 public raiseCap; // USDG raises may add per epoch, apart from first lines (audit 2026-10-10 M6)
    uint256 public raisedThisEpoch; // raises this epoch, against raiseCap
    mapping(address => bool) public inviters; // keys whose signature seats an agent
    mapping(bytes32 => bool) public inviteUsed; // a signed invite seats an agent once, reopening included
    mapping(uint256 => bool) public firstLined; // ever lined by this treasury
    mapping(uint256 => uint64) public lineAt; // when the line was last opened or raised (activity for reclaim)
    mapping(uint256 => bool) public seeded; // protocol-seeded v1 record: never raised by rule
    uint256 public pendingStake; // asset already split for stake but not yet staked

    uint256 public totalToReserve;
    uint256 public totalStaked;
    uint256 public totalCollected;

    event Adopted(uint256 indexed agentId);
    event Swept(address indexed caller, uint256 claimed, uint256 toReserve, uint256 toStake);
    event FirstLine(uint256 indexed agentId, uint256 amount, address indexed caller);
    event Invited(uint256 indexed agentId, address indexed inviter, uint64 expiry);
    event InviterSet(address indexed inviter, bool allowed);
    event Raised(uint256 indexed agentId, uint256 added, uint256 lineNow);
    event Moved(uint256 indexed agentId, address indexed owner);
    event Reclaimed(uint256 indexed agentId, uint256 amount, address indexed caller);
    event Collected(uint256 amount, address indexed to);
    event RulesUpdated(Rules rules);
    event RaiseCapUpdated(uint256 raiseCap);
    event FeeSinkUpdated(address indexed feeSink);
    event SeededSet(uint256 indexed agentId, bool seeded);
    event Retired(uint256 shares, uint256 assets, address indexed to);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error NotAdopted();
    error AlreadyAdopted();
    error NotOurs(uint256 agentId);
    error AlreadyLined(uint256 agentId);
    error NotEligible(uint256 agentId);
    error NotMovable(uint256 agentId);
    error OwnerDefaulted(address owner);
    error EpochCapReached(uint256 wanted, uint256 left);
    error RaiseCapReached(uint256 wanted, uint256 left);
    error NotInvited(uint256 agentId, address signer);
    error InviteExpired(uint256 agentId, uint64 expiry);
    error InviteUsed(uint256 agentId);
    error NotIdle(uint256 agentId, uint256 reclaimableAt);
    error LoanOpen(uint256 agentId);
    error NothingToReclaim(uint256 agentId);
    error InvalidRules();
    error InvalidAddress();
    error UseSweep();
    error TransferFailed();

    /// @param bond_ The InviteBondV2 whose bonds the borrow check reads. It must stand on the same pool and registry
    ///        and name this treasury: deploy it first, naming the address this contract will get.
    /// @param previous_ The treasury this one replaces (TreasurySponsorV4), whose agents `move` may take over; zero
    ///        for none.
    /// @param legacyBond_ The previous treasury's invite bond (InviteBond v1); zero for none.
    constructor(
        CreditPoolV2 pool_,
        IPonsFeeEscrow escrow_,
        IPonsFactoryCreator factory_,
        address owner_,
        address feeSink_,
        InviteBondV2 bond_,
        IPreviousTreasury previous_,
        ILegacyBond legacyBond_
    ) Ownable(owner_) EIP712("Priors Treasury", "5") {
        if (
            address(bond_) == address(0) || address(bond_.pool()) != address(pool_)
                || address(bond_.registry()) != address(pool_.registry()) || address(bond_.treasury()) != address(this)
        ) revert InvalidAddress();
        pool = pool_;
        asset = pool_.usdg();
        registry = pool_.registry();
        escrow = escrow_;
        factory = factory_;
        bond = bond_;
        previous = previous_;
        legacyBond = legacyBond_;
        feeSink = feeSink_ == address(0) ? owner_ : feeSink_;
        rules = Rules({
            reserveBps: 5000,
            firstLine: 5e6,
            secondLine: 50e6,
            epochCap: 100e6,
            epochLength: 7 days,
            minSeasoning: 14 days,
            minQualified: 3,
            minScore: 100,
            idleAfter: 30 days
        });
        raiseCap = 100e6;
        epochStart = uint64(block.timestamp);
        asset.forceApprove(address(pool_), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Identity
    // ------------------------------------------------------------------

    /// @notice Bind the treasury to a fresh ERC-8004 identity it owns: register one, transfer it here, adopt.
    ///         Once only; the identity becomes a root, with this contract as its backer hook, on the first sweep
    ///         that meets the pool's minimum stake.
    function adopt(uint256 id) external onlyOwner {
        if (agentId != 0) revert AlreadyAdopted();
        if (registry.ownerOf(id) != address(this)) revert NotOurs(id);
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (a.enrolledAt != 0 || a.isRoot) revert NotOurs(id); // fresh: no record, no hook, no line
        agentId = id;
        emit Adopted(id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ------------------------------------------------------------------
    // Money in: creator fees -> reserve + stake
    // ------------------------------------------------------------------

    /// @notice Claim what the Pons escrow owes in the pool asset, then split what arrived since the last sweep:
    ///         a share to the reserve, the rest staked as pool shares behind the treasury's root. Permissionless.
    ///         The stake share waits here as `pendingStake` while there is no identity, the pool is paused, or
    ///         it is below the pool's minimum stake (first enrollment) or too small to mint a share. The sweep that
    ///         enrolls the root also makes this contract the root's backer hook.
    function sweep() external returns (uint256 toReserve, uint256 toStake) {
        uint256 claimed;
        if (address(escrow) != address(0)) {
            claimed = escrow.balanceOfToken(address(this), address(asset));
            if (claimed > 0) escrow.claimToken(address(asset));
        }
        uint256 bal = asset.balanceOf(address(this));
        if (bal == 0) {
            emit Swept(msg.sender, claimed, 0, 0);
            return (0, 0);
        }
        /* Only money that arrived since the last sweep is split (v3 audit): the waiting stake share must not
           have the reserve share carved out of it again by a permissionless sweep. */
        uint256 fresh = bal > pendingStake ? bal - pendingStake : 0;
        toReserve = fresh * rules.reserveBps / 10_000;
        toStake = bal - toReserve;
        if (toReserve > 0) {
            pool.fundReserve(toReserve); // never paused
            totalToReserve += toReserve;
        }
        if (toStake > 0) {
            bool staked;
            if (agentId != 0 && block.timestamp >= pool.pausedUntil() && pool.convertToShares(toStake) > 0) {
                if (!pool.getAgent(agentId).isRoot) {
                    if (toStake >= pool.getParams().minStake) {
                        pool.enrollRoot(agentId, toStake);
                        /* The root backs nothing yet, so the pool sets the hook now, not after its 48 hours. Every
                           line this treasury will ever open is opened after this line runs. */
                        pool.setHook(agentId, address(this));
                        staked = true;
                    }
                } else {
                    pool.addStake(agentId, toStake);
                    staked = true;
                }
            }
            if (staked) {
                totalStaked += toStake;
                pendingStake = 0;
            } else {
                pendingStake = toStake;
                toStake = 0;
            }
        }
        emit Swept(msg.sender, claimed, toReserve, toStake);
    }

    /// @notice What a sweep would move right now.
    function sweepable() external view returns (uint256) {
        uint256 c = address(escrow) != address(0) ? escrow.balanceOfToken(address(this), address(asset)) : 0;
        return c + asset.balanceOf(address(this));
    }

    // ------------------------------------------------------------------
    // Vouching by rule
    // ------------------------------------------------------------------

    /// @notice Open a first line behind `id`. Two people have agreed: an inviter the owner named signed
    ///         `Invite(id, expiry)`, and the agent's NFT owner signed the pool consent `c` naming this treasury's
    ///         root (EIP-712 on the pool; EIP-1271 for a contract owner). Anyone may submit both, so the agent's
    ///         owner signs once and a relayer pays the gas. The consent is forwarded to the pool as is.
    ///
    ///         Any identity that is not a root, has never defaulted (here or on v1) and is not already on a
    ///         treasury line qualifies, including agents imported from v1 and agents whose line was reclaimed.
    ///         An agent sponsored elsewhere with no loan open moves over (the pool's handoff). An invite seats
    ///         an agent once: reopening a reclaimed seat needs a fresh invite. A line opened for an agent whose
    ///         bond another wallet posted cannot be borrowed on until its owner posts its own (see `canBorrow`).
    function firstLine(
        uint256 id,
        uint64 expiry,
        bytes calldata invite,
        CreditPoolV2.Consent calldata c,
        bytes calldata consentSig
    ) external {
        uint256 root = agentId;
        if (root == 0) revert NotAdopted();
        if (pool.getAgent(id).sponsor == root) revert AlreadyLined(id);
        if (block.timestamp > expiry) revert InviteExpired(id, expiry);
        bytes32 digest = inviteDigest(id, expiry);
        if (inviteUsed[digest]) revert InviteUsed(id);
        address signer = ECDSA.recover(digest, invite);
        if (!inviters[signer]) revert NotInvited(id, signer);
        // an owner a default marked cannot borrow: a line behind it would only sit idle on the budget
        if (pool.ownerDefaults(c.owner) != 0 && !pool.custodian(c.owner)) revert OwnerDefaulted(c.owner);
        inviteUsed[digest] = true;
        uint256 line = rules.firstLine;
        _spend(line);
        firstLined[id] = true;
        lineAt[id] = uint64(block.timestamp);
        pool.vouchWithConsent(root, id, line, 0, c, consentSig);
        emit Invited(id, signer, expiry);
        emit FirstLine(id, line, msg.sender);
    }

    /// @notice A first line, without an invite, for an agent the previous treasury lined: its invite there was the
    ///         vetting, and moving it here is how its line reaches this treasury's raise. Anyone may submit it with the
    ///         owner's pool consent. Only an agent `previous` lined and this treasury never did, sponsored by nobody
    ///         or by `previous`'s root (the pool's handoff takes that line back to it), never defaulted, and only with
    ///         an InviteBondV2 bond posted by the owner who consents, so the line is bonded from its first block and
    ///         its bond stays until the line is closed. Charged to `epochCap` like any first line.
    ///
    ///         Not while the agent still has a bond in the previous treasury's InviteBond (v1): that bond would stay
    ///         locked under this line and a default here would slash it too, a seller's bond for a buyer's default
    ///         after a sale. The owner leaves the previous line (the pool's `leave`), the v1 bond comes back through
    ///         its no-line path, then the agent moves. A `seeded` flag on the previous treasury comes along: a
    ///         protocol-seeded record is never raised by rule here either.
    function move(uint256 id, CreditPoolV2.Consent calldata c, bytes calldata consentSig) external {
        uint256 root = agentId;
        if (root == 0) revert NotAdopted();
        IPreviousTreasury prev = previous;
        if (address(prev) == address(0) || firstLined[id] || !prev.firstLined(id)) revert NotMovable(id);
        uint256 sponsor = pool.getAgent(id).sponsor;
        if (sponsor != 0 && sponsor != prev.agentId()) revert NotMovable(id);
        if (address(legacyBond) != address(0) && legacyBond.isBonded(id)) revert NotMovable(id);
        // the pool checks that c.owner is the agent's owner and signed
        if (bond.bonds(id).depositor != c.owner) revert NotMovable(id);
        if (pool.ownerDefaults(c.owner) != 0 && !pool.custodian(c.owner)) revert OwnerDefaulted(c.owner);
        uint256 line = rules.firstLine;
        _spend(line);
        firstLined[id] = true;
        lineAt[id] = uint64(block.timestamp);
        if (prev.seeded(id) && !seeded[id]) {
            seeded[id] = true;
            emit SeededSet(id, true);
        }
        pool.vouchWithConsent(root, id, line, 0, c, consentSig);
        emit Moved(id, c.owner);
        emit FirstLine(id, line, msg.sender);
    }

    /// @notice The EIP-712 digest an inviter signs to seat `id` until `expiry`. Off-chain signers use the same
    ///         domain: name "Priors Treasury", version "5", this chain, this contract.
    function inviteDigest(uint256 id, uint64 expiry) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INVITE_TYPEHASH, id, expiry)));
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Take back the line of a treasury agent with no loan open that has not borrowed, repaid, or had its
    ///         line opened or raised for `idleAfter`. Anyone. The whole line goes back to the treasury's free
    ///         backing and the sponsorship ends; the identity keeps its record and may be invited again.
    function reclaim(uint256 id) external returns (uint256 amount) {
        uint256 root = agentId;
        if (root == 0) revert NotAdopted();
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (a.sponsor != root || a.defaulted || a.delegatedIn == 0) revert NothingToReclaim(id);
        if (a.activeLoans != 0) revert LoanOpen(id); // an open loan is activity; a frozen line comes back by itself
        uint256 at = _idleSince(id, a) + rules.idleAfter;
        if (block.timestamp < at) revert NotIdle(id, at);
        amount = a.delegatedIn;
        pool.unvouch(root, id, amount);
        emit Reclaimed(id, amount, msg.sender);
    }

    /// @notice When `reclaim(id)` succeeds if nothing else happens; 0 if there is nothing to reclaim or a loan is
    ///         open.
    function reclaimableAt(uint256 id) external view returns (uint256) {
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (agentId == 0 || a.sponsor != agentId || a.defaulted || a.delegatedIn == 0 || a.activeLoans != 0) {
            return 0;
        }
        return _idleSince(id, a) + rules.idleAfter;
    }

    function _idleSince(uint256 id, CreditPoolV2.Agent memory a) internal view returns (uint256 t) {
        t = lineAt[id];
        if (a.lastBorrowAt > t) t = a.lastBorrowAt;
        if (a.lastRepayAt > t) t = a.lastRepayAt;
    }

    /// @notice Top up the line of an agent this treasury backs to the second tier, once its record qualifies.
    ///         Anyone. The top-up is the treasury's own stake, like the first line, and it is charged to the
    ///         raise budget (`raiseCap` per epoch), never to the first lines' `epochCap`: raises cannot use up the
    ///         week's room for newcomers (audit 2026-10-10 M6). Only a line open right now (not frozen) is raised,
    ///         so a reclaimed seat stays closed until a fresh invite reopens it. A raise counts as activity for
    ///         `reclaim`.
    function raise(uint256 id) external {
        if (!eligibleForRaise(id)) revert NotEligible(id);
        uint256 lineNow = pool.getAgent(id).delegatedIn;
        uint256 add = rules.secondLine - lineNow;
        _spendRaise(add);
        lineAt[id] = uint64(block.timestamp);
        pool.vouch(agentId, id, add);
        emit Raised(id, add, lineNow + add);
    }

    /// @notice Whether `raise(id)` would pass the record checks now (it still needs raise room and free backing).
    function eligibleForRaise(uint256 id) public view returns (bool) {
        uint256 root = agentId;
        // a seeded flag the previous treasury sets after the move still holds (review 2026-10-14); clearing one takes
        // both treasuries' `setSeeded`
        if (root == 0 || seeded[id] || (address(previous) != address(0) && previous.seeded(id))) return false;
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (
            a.sponsor != root || a.defaulted || a.frozen || a.childrenDefaulted != 0 || a.delegatedIn == 0
                || a.delegatedIn >= rules.secondLine || a.qualifiedRepaid < rules.minQualified
                || block.timestamp < uint256(a.enrolledAt) + rules.minSeasoning || _score(a) < rules.minScore
        ) return false;
        address o = registry.ownerOf(id);
        return pool.ownerDefaults(o) == 0 || pool.custodian(o);
    }

    /// @notice The v1 score, computed from the pool's v2 record (the same formula as CreditLensV2).
    function score(uint256 id) external view returns (uint256) {
        return _score(pool.getAgent(id));
    }

    function _score(CreditPoolV2.Agent memory a) internal view returns (uint256) {
        if (a.enrolledAt == 0) return 0;
        return ScoreLib.score(
            ScoreLib.Inputs({
                defaulted: a.defaulted,
                qualifiedRepaid: a.qualifiedRepaid,
                dollarSecondsRepaid: a.dollarSecondsRepaid,
                backing: a.delegatedIn,
                recourseHonored: a.recourseHonored,
                childrenDefaulted: a.childrenDefaulted,
                ageSeconds: block.timestamp - a.enrolledAt
            })
        );
    }

    /// @notice How much the treasury may still vouch in first lines this epoch.
    function epochRoom() public view returns (uint256) {
        uint256 used = block.timestamp >= epochStart + rules.epochLength ? 0 : vouchedThisEpoch;
        return rules.epochCap > used ? rules.epochCap - used : 0;
    }

    /// @notice How much raises may still add this epoch.
    function raiseRoom() public view returns (uint256) {
        uint256 used = block.timestamp >= epochStart + rules.epochLength ? 0 : raisedThisEpoch;
        return raiseCap > used ? raiseCap - used : 0;
    }

    /// One epoch clock for both budgets: a new epoch empties both.
    function _roll() internal {
        if (block.timestamp >= epochStart + rules.epochLength) {
            epochStart = uint64(block.timestamp);
            vouchedThisEpoch = 0;
            raisedThisEpoch = 0;
        }
    }

    function _spend(uint256 amount) internal {
        _roll();
        uint256 left = rules.epochCap > vouchedThisEpoch ? rules.epochCap - vouchedThisEpoch : 0;
        if (amount > left) revert EpochCapReached(amount, left);
        vouchedThisEpoch += amount;
    }

    function _spendRaise(uint256 amount) internal {
        _roll();
        uint256 left = raiseCap > raisedThisEpoch ? raiseCap - raisedThisEpoch : 0;
        if (amount > left) revert RaiseCapReached(amount, left);
        raisedThisEpoch += amount;
    }

    // ------------------------------------------------------------------
    // Backer hook: the pool asks before a borrow, and tells after
    // ------------------------------------------------------------------

    /// @notice The pool's question before every borrow on a line this treasury backs. Yes when the agent has no
    ///         invite bond, or when its bond was posted by `owner`, the agent's owner at borrow time (the address
    ///         the loan records and a default marks). No when another wallet posted the bond: the agent changed
    ///         hands since, and the line stays shut until its owner posts a bond of its own (InviteBondV2 takes it
    ///         once no loan is open), which also sends the old one back to its depositor. The other arguments do not
    ///         matter here.
    function canBorrow(uint256, uint256 id, uint256, uint64, uint256, address, address owner_, address)
        external
        view
        returns (bool)
    {
        address depositor = bond.bonds(id).depositor;
        return depositor == address(0) || depositor == owner_;
    }

    /// @notice Pool notification after a borrow. Nothing to do: accepted so the call never fails.
    function onBorrow(uint256, uint256, uint256) external pure {}

    /// @notice Pool notification after a default. Nothing to do here (`InviteBondV2.slash` is permissionless and the
    ///         keeper calls it); accepted so the call never fails.
    function onDefault(uint256, uint256, uint256, uint256, bool) external pure {}

    /// @notice Pool notification when a line comes back to the root (unvouch, leave, handoff, freeze, default
    ///         residual). Nothing to do: accepted so the call never fails.
    function onRelease(uint256, uint256, uint256, uint8) external pure {}

    // ------------------------------------------------------------------
    // Money out: sponsor fees -> fee wallet
    // ------------------------------------------------------------------

    /// @notice Send the sponsor fees the treasury's agents have paid to the fee sink. Anyone; 0 if none.
    function collect() external returns (uint256 amount) {
        uint256 root = agentId;
        if (root == 0) revert NotAdopted();
        if (pool.sponsorFees(root) == 0) return 0;
        amount = pool.claimSponsorFees(root, feeSink);
        totalCollected += amount;
        emit Collected(amount, feeSink);
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    function setRules(Rules calldata r) external onlyOwner {
        if (
            r.reserveBps > 10_000 || r.epochLength == 0 || r.epochLength > MAX_EPOCH || r.firstLine == 0
                || r.secondLine < r.firstLine || r.idleAfter == 0
        ) revert InvalidRules();
        rules = r;
        emit RulesUpdated(r);
    }

    /// @notice What raises may add per epoch, apart from first lines. 0 stops raises; the week's first lines are
    ///         never touched by it. It bounds what a raised line can lose in a week (a raise is unsecured trust on
    ///         the record).
    function setRaiseCap(uint256 cap) external onlyOwner {
        raiseCap = cap;
        emit RaiseCapUpdated(cap);
    }

    /// @notice Name or revoke a key whose signed invites seat agents. A revoked key's invites stop at once.
    function setInviter(address who, bool allowed) external onlyOwner {
        inviters[who] = allowed;
        emit InviterSet(who, allowed);
    }

    function setFeeSink(address sink) external onlyOwner {
        if (sink == address(0)) revert InvalidAddress();
        feeSink = sink;
        emit FeeSinkUpdated(sink);
    }

    /// @notice Flag agents whose v1 volume the protocol seeded: they may still be invited, never raised by rule.
    function setSeeded(uint256[] calldata ids, bool flag) external onlyOwner {
        for (uint256 i = 0; i < ids.length; i++) {
            seeded[ids[i]] = flag;
            emit SeededSet(ids[i], flag);
        }
    }

    /// @notice Stop (or restart) new borrows on a treasury line. Loans out run to term; the pool hands the line
    ///         back as they close. The wind-down path: freeze every line, then `retire` as backing frees up.
    function freeze(uint256 id, bool frozen) external onlyOwner {
        pool.freeze(id, frozen);
    }

    /// @notice Unlock pool shares of the treasury's stake that back nothing, as cash (principal plus the lender
    ///         yield they earned). The pool refuses anything that would leave a line unbacked.
    function retire(uint256 shares, address to) external onlyOwner returns (uint256 assets) {
        assets = pool.unlock(agentId, shares, to);
        emit Retired(shares, assets, to);
    }

    /// @notice Redirect the launch token's future creator fees elsewhere. Claim first.
    function transferCreatorFeeRecipient(address launchToken, address newRecipient) external onlyOwner {
        factory.transferCreatorFeeRecipient(launchToken, newRecipient);
    }

    /// @notice Withdraw any other asset the escrow credited here (ETH, vested launch tokens). The pool asset only
    ///         ever leaves through `sweep`.
    function rescue(address token, address to) external onlyOwner {
        if (token == address(0)) {
            if (address(escrow) != address(0) && escrow.balanceOf(address(this)) > 0) escrow.claim();
            uint256 bal = address(this).balance;
            (bool ok,) = to.call{value: bal}("");
            if (!ok) revert TransferFailed();
            emit Rescued(address(0), to, bal);
        } else {
            if (token == address(asset)) revert UseSweep();
            if (address(escrow) != address(0) && escrow.balanceOfToken(address(this), token) > 0) {
                escrow.claimToken(token);
            }
            uint256 bal = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransfer(to, bal);
            emit Rescued(token, to, bal);
        }
    }

    receive() external payable {}
}
