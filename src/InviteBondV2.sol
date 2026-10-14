// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CreditPoolV2} from "./CreditPoolV2.sol";
import {ITreasuryRules} from "./InviteBond.sol";
import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";

/// @notice The treasury's root on the pool (TreasurySponsorV5.agentId; 0 until it adopts one).
interface ITreasuryRoot {
    function agentId() external view returns (uint256);
}

/// @title InviteBondV2
/// @notice InviteBond (src/InviteBond.sol) with one rule added: a bond is posted only on an agent with no loan open,
///         a first bond and a replacement alike. Deployed with TreasurySponsorV5, which reads it.
///
///         Why. TreasurySponsorV5 refuses a borrow while the agent's bond was posted by a wallet that is not its owner,
///         so a buyer of a bonded agent has to post a bond of its own before it can borrow. On InviteBond that deposit
///         replaces the seller's bond and refunds it at once, even while a loan the seller took is still open; if the
///         seller then defaults, `slash` takes the buyer's bond. A seller could do it on purpose: borrow, sell, let the
///         buyer bond, default. Here the buyer's deposit waits until the seller's loan is closed: repaid (then the
///         replacement refunds the seller as before) or defaulted (then the agent is defaulted, nobody can bond it, and
///         `slash` takes the seller's own bond). So a bond only ever starts on an agent with nothing outstanding, and
///         it answers only for loans taken after it.
///
///         Everything else is InviteBond's, unchanged: what an automatic invite costs. The invite bot signs a first
///         line only for an agent whose owner has locked `amount` USDG here. The bond goes back to the depositor once
///         the agent's line is closed, and to `beneficiary` if the agent defaults. With the bond equal to the first
///         line, borrowing a first line and walking away nets the borrower nothing.
///
///         Released (anyone may call, the USDG goes to the depositor) when the agent has not defaulted, has no
///         loan open, holds no line at all (its owner's `leave`, a reclaim, or a line never opened), and
///         `unusedAfter` seconds have passed since the deposit (longer than any invite lives). The bond covers the
///         line for as long as the line is open: InviteBond also released it after the treasury's `minQualified`
///         qualified loans with the line still open, so an owner could take the bond back, borrow the line and
///         default for a net gain of one line (audit 2026-10-10 H1). No record of repayments brings it back here,
///         and no treasury rule is read to decide it.
///
///         Slashed (anyone may call, the USDG goes to `beneficiary`) once the pool has marked the agent defaulted.
///         A defaulted agent can never be released, and an agent past due still has its loan open, so the
///         depositor cannot take the bond back ahead of the mark.
///
///         No owner, no admin, no upgrade: every parameter is fixed at deploy. Changing the bond means deploying
///         a new InviteBond and pointing the bot at it; bonds already here keep their rules.
contract InviteBondV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Bond {
        address depositor;
        uint64 at;
        uint256 amount;
    }

    CreditPoolV2 public immutable pool;
    IERC20 public immutable usdg;
    IERC8004Identity public immutable registry;
    ITreasuryRules public immutable treasury;
    address public immutable beneficiary;
    uint256 public immutable amount;
    uint64 public immutable unusedAfter;

    mapping(uint256 => Bond) internal _bonds;
    uint256[] internal _active;
    mapping(uint256 => uint256) internal _slot; // agentId => index in _active, plus one

    event Bonded(uint256 indexed agentId, address indexed depositor, uint256 amount);
    event Released(uint256 indexed agentId, address indexed depositor, uint256 amount);
    event Slashed(uint256 indexed agentId, address indexed beneficiary, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error AlreadyBonded(uint256 agentId);
    error NotOwner(uint256 agentId);
    error AgentDefaulted(uint256 agentId);
    error LoanOpen(uint256 agentId);
    error NotTreasuryLine(uint256 agentId);
    error NoBond(uint256 agentId);
    error NotReleasable(uint256 agentId);
    error NotDefaulted(uint256 agentId);

    constructor(
        CreditPoolV2 pool_,
        IERC8004Identity registry_,
        ITreasuryRules treasury_,
        address beneficiary_,
        uint256 amount_,
        uint64 unusedAfter_
    ) {
        if (
            address(pool_) == address(0) || address(registry_) == address(0) || address(treasury_) == address(0)
                || beneficiary_ == address(0)
        ) revert ZeroAddress();
        if (amount_ == 0 || unusedAfter_ == 0) revert ZeroAmount();
        pool = pool_;
        usdg = pool_.usdg();
        registry = registry_;
        treasury = treasury_;
        beneficiary = beneficiary_;
        amount = amount_;
        unusedAfter = unusedAfter_;
    }

    /// @notice Lock `amount` USDG behind agent `agentId`. Only the agent's owner, never for an agent that has
    ///         defaulted, and never while the agent has a loan open (with any sponsor). Needs `amount` of USDG
    ///         approved to this contract.
    ///
    ///         No loan open: a bond answers only for loans taken after it. A first bond cannot cover a loan already
    ///         out, and a replacement cannot take over a loan the previous owner took: that loan stays on the previous
    ///         owner's bond until it is repaid (then the replacement refunds it) or defaulted (then `slash` takes it).
    ///
    ///         Only on an agent the treasury sponsors, or that nobody sponsors: the bond is there for the treasury's
    ///         line. Posted under another sponsor's line, it could be slashed for a default on that line, after a sale
    ///         a buyer's (review 2026-10-14). An agent on another sponsor's line leaves it first (the pool's `leave`).
    ///
    ///         One bond per agent. If the agent changed hands since its bond was posted, the new owner's deposit
    ///         replaces it: the old bond goes back to its depositor in the same transaction, so the agent stays
    ///         covered by exactly one bond and a stale bond never locks a new owner out. The new bond starts fresh
    ///         (its own date): inheriting the old date would let a buyer bond, get an invite,
    ///         release at once through the no-line path and redeem the invite unbonded. Moving the agent between
    ///         one's own wallets gains nothing: the amount locked against it never drops. The depositor itself
    ///         cannot post twice.
    function deposit(uint256 agentId) external nonReentrant {
        if (registry.ownerOf(agentId) != msg.sender) revert NotOwner(agentId);
        CreditPoolV2.Agent memory a = pool.getAgent(agentId);
        if (a.defaulted) revert AgentDefaulted(agentId);
        if (a.activeLoans != 0) revert LoanOpen(agentId);
        if (a.sponsor != 0 && a.sponsor != ITreasuryRoot(address(treasury)).agentId()) revert NotTreasuryLine(agentId);
        Bond memory old = _bonds[agentId];
        if (old.depositor == msg.sender) revert AlreadyBonded(agentId);
        _bonds[agentId] = Bond({depositor: msg.sender, at: uint64(block.timestamp), amount: amount});
        if (old.depositor == address(0)) {
            _active.push(agentId);
            _slot[agentId] = _active.length;
        }
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        if (old.depositor != address(0)) {
            usdg.safeTransfer(old.depositor, old.amount);
            emit Released(agentId, old.depositor, old.amount);
        }
        emit Bonded(agentId, msg.sender, amount);
    }

    /// @notice Return the bond to its depositor, once `releasable` says so. Anyone may call.
    function release(uint256 agentId) external nonReentrant {
        Bond memory b = _bonds[agentId];
        if (b.depositor == address(0)) revert NoBond(agentId);
        if (!_releasable(agentId, b)) revert NotReleasable(agentId);
        _close(agentId);
        usdg.safeTransfer(b.depositor, b.amount);
        emit Released(agentId, b.depositor, b.amount);
    }

    /// @notice Send the bond of a defaulted agent to `beneficiary`. Anyone may call.
    function slash(uint256 agentId) external nonReentrant {
        Bond memory b = _bonds[agentId];
        if (b.depositor == address(0)) revert NoBond(agentId);
        if (!pool.getAgent(agentId).defaulted) revert NotDefaulted(agentId);
        _close(agentId);
        usdg.safeTransfer(beneficiary, b.amount);
        emit Slashed(agentId, beneficiary, b.amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function bonds(uint256 agentId) external view returns (Bond memory) {
        return _bonds[agentId];
    }

    function isBonded(uint256 agentId) external view returns (bool) {
        return _bonds[agentId].depositor != address(0);
    }

    function releasable(uint256 agentId) external view returns (bool) {
        Bond memory b = _bonds[agentId];
        return b.depositor != address(0) && _releasable(agentId, b);
    }

    function slashable(uint256 agentId) external view returns (bool) {
        return _bonds[agentId].depositor != address(0) && pool.getAgent(agentId).defaulted;
    }

    /// @notice When the no-line release opens for `agentId` (0 without a bond). It still needs no line and no loan.
    function unusedReleaseAt(uint256 agentId) external view returns (uint256) {
        Bond memory b = _bonds[agentId];
        return b.depositor == address(0) ? 0 : uint256(b.at) + unusedAfter;
    }

    function activeCount() external view returns (uint256) {
        return _active.length;
    }

    /// @notice Agents with a bond, `count` of them from index `start` (order changes as bonds close).
    function activeIds(uint256 start, uint256 count) external view returns (uint256[] memory ids) {
        uint256 n = _active.length;
        if (start >= n) return new uint256[](0);
        uint256 end = start + count > n ? n : start + count;
        ids = new uint256[](end - start);
        for (uint256 i = start; i < end; i++) {
            ids[i - start] = _active[i];
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// The bond covers the line for as long as the line is open (audit 2026-10-10 H1): no record of qualified loans,
    /// however long, brings it back while the agent could still borrow on the line and default. It comes back once
    /// the agent holds no line (its owner's `leave`, a reclaim, or a line never opened) with no loan open, and
    /// `unusedAfter` past the deposit (longer than any invite lives, so a bond cannot be taken back between an
    /// invite and its redemption). Nothing outside the pool decides it: no treasury rule is read here.
    function _releasable(uint256 agentId, Bond memory b) internal view returns (bool) {
        CreditPoolV2.Agent memory a = pool.getAgent(agentId);
        if (a.defaulted || a.activeLoans != 0) return false;
        return a.delegatedIn == 0 && block.timestamp >= uint256(b.at) + unusedAfter;
    }

    function _close(uint256 agentId) internal {
        delete _bonds[agentId];
        uint256 slot = _slot[agentId];
        uint256 last = _active[_active.length - 1];
        _active[slot - 1] = last;
        _slot[last] = slot;
        _active.pop();
        delete _slot[agentId];
    }
}
