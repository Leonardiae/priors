// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TreasuryV5Base} from "./TreasurySponsorV5.t.sol";
import {InviteBondV2} from "../src/InviteBondV2.sol";
import {InviteBond, ITreasuryRules} from "../src/InviteBond.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";

/// InviteBondV2 against the real CreditPoolV2 and TreasurySponsorV5 (TreasuryV5Base's fixture: $5 first line, bond 5 USDG,
/// unusedAfter 4 days, minQualified 3, minScoreTerm 7 days). Expected values are the fixture's numbers, worked by hand.
///
/// First, test/InviteBond.t.sol's InviteBondTest, ported as is (InviteBond renamed InviteBondV2). The new rule changes
/// none of their outcomes: every deposit they make is on an agent with no loan open (the seller's line in
/// test_newOwner_replacesStaleBond_oldDepositorRefunded is open but undrawn). Then the rule itself: a deposit is refused
/// while the agent has a loan open, a first bond and a replacement alike.
contract InviteBondV2Test is TreasuryV5Base {
    function setUp() public override {
        super.setUp();
        _funded();
    }

    // ------------------------------------------------------------------
    // Deposit
    // ------------------------------------------------------------------

    function test_deposit_ownerOnly_oncePerAgent() public {
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotOwner.selector, AGENT));
        bond.deposit(AGENT);

        uint256 before = usdc.balanceOf(agentOp);
        _deposit(agentOp, AGENT);
        assertEq(usdc.balanceOf(agentOp), before - BOND, "5 USDG taken");
        assertEq(usdc.balanceOf(address(bond)), BOND);
        assertTrue(bond.isBonded(AGENT));
        InviteBondV2.Bond memory b = bond.bonds(AGENT);
        assertEq(b.depositor, agentOp);
        assertEq(b.amount, BOND);
        assertEq(bond.activeCount(), 1);

        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.AlreadyBonded.selector, AGENT));
        bond.deposit(AGENT);
    }

    function test_deposit_refusedForDefaultedAgent() public {
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _default(loan);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.AgentDefaulted.selector, AGENT));
        bond.deposit(AGENT);
    }

    // ------------------------------------------------------------------
    // Release
    // ------------------------------------------------------------------

    /// Audit 2026-10-10 H1: the bond covers the line for as long as the line is open. A record of qualified loans,
    /// however long, never brings it back while the line could still be borrowed on and defaulted; closing the line
    /// does (the owner's `leave`, then anyone's `release`).
    function test_release_onlyOnceTheLineIsClosed_whateverTheRecord() public {
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        for (uint256 i = 0; i < 5; i++) {
            uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
            vm.warp(vm.getBlockTimestamp() + 7 days);
            _repay(agentOp, loan);
        }
        assertEq(pool.getAgent(AGENT).qualifiedRepaid, 5, "five qualified repayments");
        assertGt(_line(AGENT), 0, "the line is still open");
        assertFalse(bond.releasable(AGENT), "the open line is still covered by the bond");
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotReleasable.selector, AGENT));
        bond.release(AGENT);

        // the owner closes the line: the bond comes back to its depositor
        vm.prank(agentOp);
        pool.leave(AGENT);
        assertEq(_line(AGENT), 0);
        assertTrue(bond.releasable(AGENT));
        uint256 before = usdc.balanceOf(agentOp);
        vm.prank(anyone); // anyone may trigger it; the money goes to the depositor
        bond.release(AGENT);
        assertEq(usdc.balanceOf(agentOp), before + BOND);
        assertFalse(bond.isBonded(AGENT));
        assertEq(bond.activeCount(), 0);
        assertEq(usdc.balanceOf(address(bond)), 0);
    }

    function test_release_unusedAfterWait_noLine() public {
        _deposit(agentOp, AGENT);
        vm.warp(vm.getBlockTimestamp() + UNUSED - 1);
        assertFalse(bond.releasable(AGENT), "before the wait");
        vm.warp(vm.getBlockTimestamp() + 1);
        assertTrue(bond.releasable(AGENT), "no line, no loan, wait over");
        bond.release(AGENT);
        assertEq(usdc.balanceOf(agentOp), 10_000 * USDC);
    }

    function test_release_afterLineReclaimed() public {
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        vm.warp(vm.getBlockTimestamp() + UNUSED + 1);
        assertFalse(bond.releasable(AGENT), "the line is still open");
        vm.warp(vm.getBlockTimestamp() + _idle());
        treasury.reclaim(AGENT);
        assertEq(_line(AGENT), 0);
        assertTrue(bond.releasable(AGENT), "line reclaimed, never borrowed");
        bond.release(AGENT);
        assertFalse(bond.isBonded(AGENT));
    }

    function test_release_noBond_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NoBond.selector, AGENT));
        bond.release(AGENT);
    }

    // ------------------------------------------------------------------
    // Slash
    // ------------------------------------------------------------------

    function test_slash_onlyAfterDefault_toBeneficiary() public {
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotDefaulted.selector, AGENT));
        bond.slash(AGENT);
        // past due but not yet marked: still no release (the loan is open)
        vm.warp(pool.getLoan(loan).defaultableAt + 1);
        assertFalse(bond.releasable(AGENT));
        pool.markDefault(loan);
        assertTrue(bond.slashable(AGENT));
        assertFalse(bond.releasable(AGENT));
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotReleasable.selector, AGENT));
        bond.release(AGENT);
        vm.prank(anyone);
        bond.slash(AGENT);
        assertEq(usdc.balanceOf(safe), BOND);
        assertFalse(bond.isBonded(AGENT));
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NoBond.selector, AGENT));
        bond.slash(AGENT);
    }

    // ------------------------------------------------------------------
    // Criterion 4: the farm does not pay
    // ------------------------------------------------------------------

    function test_farm_repayOnceThenDefault_netsNothing() public {
        uint256 start = usdc.balanceOf(agentOp);
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);

        // one clean loan, to try to get the bond back
        uint256 first = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _repay(agentOp, first);
        assertFalse(bond.releasable(AGENT), "one repayment does not release");
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotReleasable.selector, AGENT));
        bond.release(AGENT);
        // nor does waiting: the line is still there
        vm.warp(vm.getBlockTimestamp() + UNUSED + 1);
        assertFalse(bond.releasable(AGENT), "line still open");

        // then take the line and walk away
        _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        uint256 second = pool.loanCount();
        _default(second);
        bond.slash(AGENT);

        int256 net = int256(usdc.balanceOf(agentOp)) - int256(start);
        assertLe(net, 0, "the farmer ends with no gain");
        assertEq(usdc.balanceOf(safe), BOND, "the bond covers the treasury's loss");
    }

    // ------------------------------------------------------------------
    // Criterion 5: no withdrawal while the line is usable
    // ------------------------------------------------------------------

    function test_noEarlyWithdraw_whileLineOrLoan() public {
        _deposit(agentOp, AGENT);
        assertFalse(bond.releasable(AGENT), "day 0, no line yet: the invite may still be redeemed");
        _firstLine(AGENT, AGENT_PK);
        vm.warp(vm.getBlockTimestamp() + UNUSED + 1);
        assertFalse(bond.releasable(AGENT), "wait over, line open");
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        assertFalse(bond.releasable(AGENT), "loan open");
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotReleasable.selector, AGENT));
        bond.release(AGENT);
        loan; // repaid or defaulted later, either way not here
    }

    // ------------------------------------------------------------------
    // A new owner is never locked out by the old owner's bond (changes review, should_fix)
    // ------------------------------------------------------------------

    function test_newOwner_replacesStaleBond_oldDepositorRefunded() public {
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK); // a line opened under the old bond, never used
        vm.prank(agentOp);
        reg.transferFrom(agentOp, agentOp2, AGENT);

        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotOwner.selector, AGENT));
        bond.deposit(AGENT); // the seller cannot post for it any more

        uint256 sellerBefore = usdc.balanceOf(agentOp);
        uint256 buyerBefore = usdc.balanceOf(agentOp2);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        _deposit(agentOp2, AGENT);
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND, "the old bond went back to its depositor");
        assertEq(usdc.balanceOf(agentOp2), buyerBefore - BOND, "the buyer posted one bond");
        assertEq(usdc.balanceOf(address(bond)), BOND, "exactly one bond covers the agent");
        assertEq(bond.activeCount(), 1, "still one entry");
        InviteBondV2.Bond memory b = bond.bonds(AGENT);
        assertEq(b.depositor, agentOp2);
        assertEq(b.at, vm.getBlockTimestamp(), "a fresh date: the 4-day wait restarts");

        // the buyer cannot post twice, nor take it back at once while the line exists
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.AlreadyBonded.selector, AGENT));
        bond.deposit(AGENT);
        assertFalse(bond.releasable(AGENT));
        // and a default now forfeits the buyer's bond, not the seller's
        uint256 loan = _borrow(agentOp2, AGENT, 5 * USDC, 7 days);
        _default(loan);
        bond.slash(AGENT);
        assertEq(usdc.balanceOf(safe), BOND);
    }

    function test_superseding_restartsTheUnusedWait() public {
        _deposit(agentOp, AGENT);
        vm.warp(vm.getBlockTimestamp() + UNUSED + 1); // the old bond is past its wait, no line
        vm.prank(agentOp);
        reg.transferFrom(agentOp, agentOp2, AGENT);
        _deposit(agentOp2, AGENT);
        assertFalse(bond.releasable(AGENT), "a buyer cannot bond, get an invite and release at once");
        vm.warp(vm.getBlockTimestamp() + UNUSED);
        assertTrue(bond.releasable(AGENT));
    }

    // ------------------------------------------------------------------
    // Bookkeeping
    // ------------------------------------------------------------------

    function test_activeIds_swapPop() public {
        _deposit(agentOp, AGENT);
        _deposit(agentOp2, AGENT2);
        uint256[] memory ids = bond.activeIds(0, 10);
        assertEq(ids.length, 2);
        assertEq(ids[0], AGENT);
        assertEq(ids[1], AGENT2);
        vm.warp(vm.getBlockTimestamp() + UNUSED);
        bond.release(AGENT);
        ids = bond.activeIds(0, 10);
        assertEq(ids.length, 1);
        assertEq(ids[0], AGENT2);
        assertEq(bond.activeIds(5, 10).length, 0);
        // a released agent can bond again
        _deposit(agentOp, AGENT);
        assertEq(bond.activeCount(), 2);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(InviteBondV2.ZeroAddress.selector);
        new InviteBondV2(
            pool, IERC8004Identity(address(reg)), ITreasuryRules(address(treasury)), address(0), BOND, UNUSED
        );
        vm.expectRevert(InviteBondV2.ZeroAmount.selector);
        new InviteBondV2(pool, IERC8004Identity(address(reg)), ITreasuryRules(address(treasury)), safe, 0, UNUSED);
    }

    // ------------------------------------------------------------------
    // InviteBondV2: no deposit while a loan is open
    // ------------------------------------------------------------------

    /// The review's attack: the seller borrows on its own bond, sells, and lets the buyer bond before defaulting. The
    /// buyer's deposit is refused while the seller's loan is open, so the default forfeits the seller's own bond and
    /// the buyer loses nothing.
    function test_v2_sellerBorrowsThenSells_buyerCannotBond_sellerDefaultSlashesTheSellersBond() public {
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _sell(AGENT, agentOp, agentOp2);
        uint256 buyerBefore = usdc.balanceOf(agentOp2);
        uint256 sellerBefore = usdc.balanceOf(agentOp);

        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.LoanOpen.selector, AGENT));
        bond.deposit(AGENT);
        assertEq(bond.bonds(AGENT).depositor, agentOp, "the seller's bond still answers for the seller's loan");

        _default(loan);
        vm.prank(anyone);
        bond.slash(AGENT);
        assertEq(usdc.balanceOf(safe), BOND, "the seller's own bond pays for the seller's default");
        assertEq(usdc.balanceOf(agentOp2), buyerBefore, "the buyer lost nothing");
        assertEq(usdc.balanceOf(agentOp), sellerBefore, "and the seller got nothing back");
        assertEq(pool.ownerDefaults(agentOp), 1, "the default marks the seller");
        assertEq(pool.ownerDefaults(agentOp2), 0);
        assertEq(usdc.balanceOf(address(bond)), 0);
        // a defaulted agent can never be bonded again
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.AgentDefaulted.selector, AGENT));
        bond.deposit(AGENT);
    }

    /// The same moves on InviteBond (v1), for reference: its deposit replaces the seller's bond under the seller's open
    /// loan and refunds the seller at once, and the seller's default then takes the buyer's bond.
    function test_v1Reference_sameMoves_buyersBondPaysForTheSellersDefault() public {
        InviteBond v1 =
            new InviteBond(pool, IERC8004Identity(address(reg)), ITreasuryRules(address(treasury)), safe, BOND, UNUSED);
        vm.prank(agentOp);
        usdc.approve(address(v1), type(uint256).max);
        vm.prank(agentOp2);
        usdc.approve(address(v1), type(uint256).max);
        vm.prank(agentOp);
        v1.deposit(AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _sell(AGENT, agentOp, agentOp2);
        uint256 buyerBefore = usdc.balanceOf(agentOp2);
        uint256 sellerBefore = usdc.balanceOf(agentOp);
        vm.prank(agentOp2);
        v1.deposit(AGENT); // accepted
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND, "v1 refunds the seller under its open loan");
        _default(loan);
        v1.slash(AGENT);
        assertEq(usdc.balanceOf(agentOp2), buyerBefore - BOND, "v1: the buyer's bond paid for the seller's default");
    }

    /// The seller repays: the buyer's deposit now goes through, refunds the seller, and the buyer borrows on v5.
    function test_v2_sellerRepays_thenBuyerBonds_sellerRefunded_buyerBorrows() public {
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _sell(AGENT, agentOp, agentOp2);
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.LoanOpen.selector, AGENT));
        bond.deposit(AGENT);

        vm.warp(vm.getBlockTimestamp() + 7 days);
        _repay(agentOp, loan);
        uint256 sellerBefore = usdc.balanceOf(agentOp);
        uint256 buyerBefore = usdc.balanceOf(agentOp2);
        _deposit(agentOp2, AGENT);
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND, "the seller refunded");
        assertEq(usdc.balanceOf(agentOp2), buyerBefore - BOND);
        assertEq(bond.bonds(AGENT).depositor, agentOp2);
        uint256 next = _borrow(agentOp2, AGENT, 5 * USDC, 7 days);
        assertEq(pool.getLoan(next).owner, agentOp2, "the buyer borrows on its own bond");
    }

    /// Repayment is open to anyone: a buyer may close the seller's loan itself, then bond.
    function test_v2_buyerRepaysTheSellersLoan_thenBonds() public {
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _sell(AGENT, agentOp, agentOp2);
        _repay(agentOp2, loan);
        _deposit(agentOp2, AGENT);
        assertEq(bond.bonds(AGENT).depositor, agentOp2);
    }

    /// A first bond is refused too while the agent has a loan open, here under another sponsor's line: a bond never
    /// starts under a loan already out. Repaid, it is still refused while that sponsor's line is there: a bond is never
    /// posted under another sponsor's line, whose default (after a sale, a buyer's) it would pay (review 2026-10-14).
    /// Once the agent leaves that line, the deposit goes through.
    function test_v2_firstDepositRefused_whileALoanIsOpenWithAnotherSponsor() public {
        vm.prank(rootOp);
        uint256 root = reg.register("other-root");
        vm.prank(rootOp);
        pool.enrollRoot(root, 100 * USDC);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consentFor(AGENT, root, AGENT_PK);
        vm.prank(rootOp);
        pool.vouchWithConsent(root, AGENT, 20 * USDC, 0, c, sig);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);

        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.LoanOpen.selector, AGENT));
        bond.deposit(AGENT);
        assertFalse(bond.isBonded(AGENT));
        assertEq(bond.activeCount(), 0);
        assertEq(usdc.balanceOf(address(bond)), 0);

        _repay(agentOp, loan);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotTreasuryLine.selector, AGENT));
        bond.deposit(AGENT);
        vm.prank(agentOp);
        pool.leave(AGENT);
        _deposit(agentOp, AGENT);
        assertTrue(bond.isBonded(AGENT));
    }
}
