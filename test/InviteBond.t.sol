// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TreasuryV4Base} from "./TreasurySponsorV4.t.sol";
import {InviteBond, ITreasuryRules} from "../src/InviteBond.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";

/// InviteBond against the real CreditPoolV2 and TreasurySponsorV4 (TreasuryV4Base's fixture: $5 first line,
/// minQualified 3, minScoreTerm 7 days). Expected values are the fixture's numbers, worked by hand.
contract InviteBondTest is TreasuryV4Base {
    InviteBond bond;
    address safe = makeAddr("safe");
    uint256 constant BOND = 5e6;
    uint64 constant UNUSED = 4 days;

    function setUp() public override {
        super.setUp();
        bond =
            new InviteBond(pool, IERC8004Identity(address(reg)), ITreasuryRules(address(treasury)), safe, BOND, UNUSED);
        _funded();
        vm.prank(agentOp);
        usdc.approve(address(bond), type(uint256).max);
        vm.prank(agentOp2);
        usdc.approve(address(bond), type(uint256).max);
    }

    function _deposit(address who, uint256 id) internal {
        vm.prank(who);
        bond.deposit(id);
    }

    // ------------------------------------------------------------------
    // Deposit
    // ------------------------------------------------------------------

    function test_deposit_ownerOnly_oncePerAgent() public {
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(InviteBond.NotOwner.selector, AGENT));
        bond.deposit(AGENT);

        uint256 before = usdc.balanceOf(agentOp);
        _deposit(agentOp, AGENT);
        assertEq(usdc.balanceOf(agentOp), before - BOND, "5 USDG taken");
        assertEq(usdc.balanceOf(address(bond)), BOND);
        assertTrue(bond.isBonded(AGENT));
        InviteBond.Bond memory b = bond.bonds(AGENT);
        assertEq(b.depositor, agentOp);
        assertEq(b.amount, BOND);
        assertEq(bond.activeCount(), 1);

        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(InviteBond.AlreadyBonded.selector, AGENT));
        bond.deposit(AGENT);
    }

    function test_deposit_refusedForDefaultedAgent() public {
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _default(loan);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(InviteBond.AgentDefaulted.selector, AGENT));
        bond.deposit(AGENT);
    }

    // ------------------------------------------------------------------
    // Release
    // ------------------------------------------------------------------

    function test_release_afterSeasoning_toDepositor() public {
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        // two qualified repayments: not yet (minQualified is 3)
        for (uint256 i = 0; i < 2; i++) {
            uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
            vm.warp(vm.getBlockTimestamp() + 7 days);
            _repay(agentOp, loan);
        }
        (uint256 repaid, uint256 needed) = bond.progress(AGENT);
        assertEq(repaid, 2);
        assertEq(needed, 3);
        assertFalse(bond.releasable(AGENT));
        vm.expectRevert(abi.encodeWithSelector(InviteBond.NotReleasable.selector, AGENT));
        bond.release(AGENT);

        // the third, but still open: not while a loan is out
        uint256 third = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertFalse(bond.releasable(AGENT), "loan open");
        _repay(agentOp, third);

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
        vm.expectRevert(abi.encodeWithSelector(InviteBond.NoBond.selector, AGENT));
        bond.release(AGENT);
    }

    // ------------------------------------------------------------------
    // Slash
    // ------------------------------------------------------------------

    function test_slash_onlyAfterDefault_toBeneficiary() public {
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        vm.expectRevert(abi.encodeWithSelector(InviteBond.NotDefaulted.selector, AGENT));
        bond.slash(AGENT);
        // past due but not yet marked: still no release (the loan is open)
        vm.warp(pool.getLoan(loan).defaultableAt + 1);
        assertFalse(bond.releasable(AGENT));
        pool.markDefault(loan);
        assertTrue(bond.slashable(AGENT));
        assertFalse(bond.releasable(AGENT));
        vm.expectRevert(abi.encodeWithSelector(InviteBond.NotReleasable.selector, AGENT));
        bond.release(AGENT);
        vm.prank(anyone);
        bond.slash(AGENT);
        assertEq(usdc.balanceOf(safe), BOND);
        assertFalse(bond.isBonded(AGENT));
        vm.expectRevert(abi.encodeWithSelector(InviteBond.NoBond.selector, AGENT));
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
        vm.expectRevert(abi.encodeWithSelector(InviteBond.NotReleasable.selector, AGENT));
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
        vm.expectRevert(abi.encodeWithSelector(InviteBond.NotReleasable.selector, AGENT));
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
        vm.expectRevert(abi.encodeWithSelector(InviteBond.NotOwner.selector, AGENT));
        bond.deposit(AGENT); // the seller cannot post for it any more

        uint256 sellerBefore = usdc.balanceOf(agentOp);
        uint256 buyerBefore = usdc.balanceOf(agentOp2);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        _deposit(agentOp2, AGENT);
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND, "the old bond went back to its depositor");
        assertEq(usdc.balanceOf(agentOp2), buyerBefore - BOND, "the buyer posted one bond");
        assertEq(usdc.balanceOf(address(bond)), BOND, "exactly one bond covers the agent");
        assertEq(bond.activeCount(), 1, "still one entry");
        InviteBond.Bond memory b = bond.bonds(AGENT);
        assertEq(b.depositor, agentOp2);
        assertEq(b.at, vm.getBlockTimestamp(), "a fresh date: the 4-day wait restarts");

        // the buyer cannot post twice, nor take it back at once while the line exists
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(InviteBond.AlreadyBonded.selector, AGENT));
        bond.deposit(AGENT);
        assertFalse(bond.releasable(AGENT));
        // and a default now forfeits the buyer's bond, not the seller's
        uint256 loan = _borrow(agentOp2, AGENT, 5 * USDC, 7 days);
        _default(loan);
        bond.slash(AGENT);
        assertEq(usdc.balanceOf(safe), BOND);
    }

    /// GHSA-qvp5-99xq-gqxm: the report's sequence. Wallet A bonds, borrows its first line and keeps the loan open, then
    /// moves the agent to its own wallet B, which bonds and refunds A; B lets the loan default. The replacement takes
    /// B's bond before it refunds A's, so one bond stays locked throughout and the default forfeits it: the two wallets
    /// together end where A alone would have, the loan's 5 USDG against one 5 USDG bond.
    function test_qvp5_replacementWithAnOpenLoan_keepsOneBondAtRisk() public {
        uint256 together = usdc.balanceOf(agentOp) + usdc.balanceOf(agentOp2); // before A's bond
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days); // open, its 5 USDG with A
        vm.prank(agentOp);
        reg.transferFrom(agentOp, agentOp2, AGENT);
        _deposit(agentOp2, AGENT); // B's bond in, A's back
        assertEq(usdc.balanceOf(address(bond)), BOND, "one bond locked while the loan is open");
        assertFalse(bond.releasable(AGENT), "B cannot take it back while the loan is open");
        _default(loan);
        bond.slash(AGENT);
        assertEq(usdc.balanceOf(safe), BOND, "the default forfeits the bond that replaced A's");
        assertEq(
            usdc.balanceOf(agentOp) + usdc.balanceOf(agentOp2),
            together,
            "A and B together: the loan, less one bond, nets nothing"
        );
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
        vm.expectRevert(InviteBond.ZeroAddress.selector);
        new InviteBond(
            pool, IERC8004Identity(address(reg)), ITreasuryRules(address(treasury)), address(0), BOND, UNUSED
        );
        vm.expectRevert(InviteBond.ZeroAmount.selector);
        new InviteBond(pool, IERC8004Identity(address(reg)), ITreasuryRules(address(treasury)), safe, 0, UNUSED);
    }
}
