// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StockVault} from "../src/StockVault.sol";
import {StockVaultBase} from "./StockVault.t.sol";

/// Regression for GHSA-f8mq-9j3m-c2f4: a depositor's close requested with a loan open must give the line back to this
/// epoch's budget when the last repayment ends the position, as a close after the repayment does. Otherwise four
/// close-with-loan cycles fill the $1,000 weekly cap with nothing open, and no new line opens until the epoch rolls.
/// The properties, not a particular fix: an owner eviction (`freezePosition`) keeps the spend whatever the depositor
/// does around it, `leave` keeps refunding, a default never refunds, and no refund carries over to the next position.
/// The base's live values: maxLine 250, epochCap 1000, 7-day epoch, pool fee 100 bps per 30 days, minLoan 5,
/// minTerm 1 day.
contract StockVaultEpochRefundTest is StockVaultBase {
    uint256 constant LINE = 250 * USDC;
    uint256 constant DRAW = 5 * USDC;
    uint256 constant TERM = 1 days;

    function _openMax(uint256 pk, uint256 id) internal returns (uint256 line) {
        line = _open(pk, id, 2 * SHARE); // $1,200 of SPY at 50% = $600, capped at maxLine
        assertEq(line, LINE);
    }

    function _draw(address op, uint256 id) internal returns (uint256 loanId) {
        vm.prank(op);
        loanId = pool.borrow(id, DRAW, uint64(TERM), op, type(uint256).max);
    }

    function _repay(address op, uint256 loanId, uint256 id) internal {
        vm.prank(op);
        pool.repay(loanId, id, type(uint256).max);
    }

    /// open 250, borrow 5 for 1 day, close while it is open, repay
    function _closeThenRepay(uint256 pk, uint256 id) internal {
        address op = vm.addr(pk);
        _openMax(pk, id);
        uint256 loanId = _draw(op, id);
        vm.prank(op);
        vault.close(id);
        _repay(op, loanId, id);
        assertEq(uint256(vault.getPosition(id).status), uint256(StockVault.Status.Closed));
        assertEq(vault.openLines(), 0);
    }

    function test_closeWithLoanOpen_refundsTheEpochOnTheLastRepay() public {
        _openMax(AGENT_PK, AGENT);
        uint256 loanId = _draw(agentOp, AGENT);
        vm.prank(agentOp);
        vault.close(AGENT);
        assertEq(vault.linedThisEpoch(), LINE, "still spent while the loan is open (the line is frozen, not ended)");
        _repay(agentOp, loanId, AGENT);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(spy.balanceOf(agentOp), 10 * SHARE);
        assertEq(vault.linedThisEpoch(), 0, "close-then-repay refunds like repay-then-close");
        assertEq(vault.epochRoom(), 1000 * USDC);
    }

    function test_fourCloseThenRepayCycles_doNotFillTheCap() public {
        for (uint256 i; i < 4; ++i) {
            _closeThenRepay(AGENT_PK, AGENT);
        }
        assertEq(_openMax(AGENT2_PK, AGENT2), LINE, "another depositor still opens");
    }

    /// The owner's eviction keeps the spend, with or without a loan open, whatever the depositor does around it.
    function test_freezeWithLoanOpen_keepsTheSpend() public {
        _openMax(AGENT_PK, AGENT);
        uint256 loanId = _draw(agentOp, AGENT);
        vm.prank(owner);
        vault.freezePosition(AGENT);
        _repay(agentOp, loanId, AGENT);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(vault.linedThisEpoch(), LINE);
    }

    function test_closeThenFreeze_evictionWins() public {
        _openMax(AGENT_PK, AGENT);
        uint256 loanId = _draw(agentOp, AGENT);
        vm.prank(agentOp);
        vault.close(AGENT);
        vm.prank(owner);
        vault.freezePosition(AGENT);
        _repay(agentOp, loanId, AGENT);
        assertEq(vault.linedThisEpoch(), LINE);
    }

    function test_freezeThenClose_evictionWins() public {
        _openMax(AGENT_PK, AGENT);
        uint256 loanId = _draw(agentOp, AGENT);
        vm.prank(owner);
        vault.freezePosition(AGENT);
        vm.prank(agentOp);
        vault.close(AGENT); // the depositor cannot buy the refund back after an eviction
        _repay(agentOp, loanId, AGENT);
        assertEq(vault.linedThisEpoch(), LINE);
    }

    /// leave (and a handoff) end a line with no loan open and refund today: a fix must keep that, or open+leave strands
    /// the cap with no fee at all.
    function test_leave_refunds_soOpenLeaveCannotFillTheCap() public {
        for (uint256 i; i < 4; ++i) {
            _openMax(AGENT_PK, AGENT);
            vm.prank(agentOp);
            pool.leave(AGENT);
            assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        }
        assertEq(vault.linedThisEpoch(), 0, "leave refunds");
        assertEq(_openMax(AGENT2_PK, AGENT2), LINE);
    }

    /// A closing position that defaults is seized and never refunds (the cap still bounds lines that went bad).
    function test_closeWithLoanOpen_thenDefault_seizes_noRefund() public {
        _openMax(AGENT_PK, AGENT);
        uint256 loanId = _draw(agentOp, AGENT);
        vm.prank(agentOp);
        vault.close(AGENT);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        pool.markDefault(loanId);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Seized));
        assertEq(spy.balanceOf(treasury), 2 * SHARE);
        assertEq(vault.linedThisEpoch(), LINE);
    }

    // ---- settle(): the same ending when the pool's last onRelease call failed (reported by Muse, 2026-10-04). Before
    // the fix settle() always ended with no refund, so whoever called it first kept the depositor's line counted. ----

    /// The pool's onRelease call into the vault fails once (a token paused at the repay block, say): the pool carries
    /// on (HookFailed), the sponsor is gone, the position is still open in the vault.
    function _withFailedRelease(function() internal action) internal {
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        action();
        vm.clearMockedCalls();
        assertEq(pool.getAgent(AGENT).sponsor, 0);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Open));
    }

    uint256 internal loan_;

    function _repayLoan() internal {
        _repay(agentOp, loan_, AGENT);
    }

    function _leave() internal {
        vm.prank(agentOp);
        pool.leave(AGENT);
    }

    function test_closeWithLoanOpen_failedHook_settleByAnyone_refunds() public {
        _openMax(AGENT_PK, AGENT);
        loan_ = _draw(agentOp, AGENT);
        vm.prank(agentOp);
        vault.close(AGENT);
        _withFailedRelease(_repayLoan);
        vm.prank(anyone);
        vault.settle(AGENT, 0);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(spy.balanceOf(agentOp), 10 * SHARE, "every token back");
        assertEq(vault.linedThisEpoch(), 0, "settle refunds the deferred close as onRelease would");
        assertEq(vault.epochRoom(), 1000 * USDC);
    }

    function test_freezeWithLoanOpen_failedHook_settle_keepsTheSpend() public {
        _openMax(AGENT_PK, AGENT);
        loan_ = _draw(agentOp, AGENT);
        vm.prank(owner);
        vault.freezePosition(AGENT);
        _withFailedRelease(_repayLoan);
        vm.prank(anyone);
        vault.settle(AGENT, 0);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(vault.linedThisEpoch(), LINE, "an owner eviction keeps its spend through settle too");
    }

    function test_leave_failedHook_settle_refunds() public {
        _openMax(AGENT_PK, AGENT);
        _withFailedRelease(_leave);
        vm.prank(anyone);
        vault.settle(AGENT, 0);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(vault.linedThisEpoch(), 0, "a leave refunds through settle as through onRelease");
    }

    // ---- close() on the state a failed last onRelease leaves (GHSA-jgwm-4r5q-r2mf, @byfor8, 2026-10-05). The sponsor
    // is gone, the position is still open and closing: close() reached _end with its caller's refund and gave an
    // evicted position its line back, where settle() and onRelease keep it counted. ----

    /// Builds the stuck state: open, borrow, the given requests while the loan is open, then the last repayment with a
    /// failing onRelease.
    function _stuck(bool depositorClose, bool evict) internal {
        _openMax(AGENT_PK, AGENT);
        loan_ = _draw(agentOp, AGENT);
        if (depositorClose) {
            vm.prank(agentOp);
            vault.close(AGENT);
        }
        if (evict) {
            vm.prank(owner);
            vault.freezePosition(AGENT);
        }
        _withFailedRelease(_repayLoan);
        assertTrue(vault.getPosition(AGENT).closing);
    }

    /// The same stuck state ends the same way whoever ends it: settle() by anyone, or the depositor's close().
    function _settleAndCloseAgree(bool depositorClose, bool evict, uint256 expected) internal {
        _stuck(depositorClose, evict);
        uint256 snap = vm.snapshotState();
        vm.prank(anyone);
        vault.settle(AGENT, 0);
        uint256 bySettle = vault.linedThisEpoch();
        vm.revertToState(snap);
        vm.prank(agentOp);
        vault.close(AGENT);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(spy.balanceOf(agentOp), 10 * SHARE, "every token back");
        assertEq(vault.linedThisEpoch(), bySettle, "close and settle end the same stuck state the same way");
        assertEq(bySettle, expected);
    }

    function test_closeThenFreeze_failedHook_depositorClose_keepsTheSpend() public {
        _settleAndCloseAgree(true, true, LINE); // the reporter's ordering
    }

    function test_freezeWithLoanOpen_failedHook_depositorClose_keepsTheSpend() public {
        _settleAndCloseAgree(false, true, LINE); // an eviction alone, then the depositor's close
    }

    function test_closeWithLoanOpen_failedHook_depositorClose_refunds() public {
        _settleAndCloseAgree(true, false, 0); // no eviction: the deferred close keeps its refund
    }

    /// No stale intent: a position that ended after a deferred close does not hand its refund to the next one.
    function test_nextPositionStartsClean() public {
        _closeThenRepay(AGENT_PK, AGENT);
        uint256 spent = vault.linedThisEpoch();
        _openMax(AGENT_PK, AGENT);
        uint256 loanId = _draw(agentOp, AGENT);
        vm.prank(owner);
        vault.freezePosition(AGENT);
        _repay(agentOp, loanId, AGENT);
        assertEq(vault.linedThisEpoch(), spent + LINE, "the eviction keeps its own spend");
    }
}
