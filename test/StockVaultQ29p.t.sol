// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./StockVaultJumpWindow.t.sol";

/// GHSA-q29p-rp35-p8v2 (sonson0910): the report's four PoC cases, held to the fixed behaviour.
///   Finding 1: a price tape more than LIVE_ROUNDS rounds behind made the lending hold answer 1, and `_seize` took the
///              whole deposit on any hold: a default (anyone's markDefault, the borrower's own repay releasing a
///              defaulted residual line, anyone's settle) timed to a tape lag confiscated the depositor's rest at an
///              unmoved fresh price. A tape behind says nothing of the price: the default waits (the position stays
///              open), settle reverts TapeBehind(feed) until anyone records it, then seizes owed + the buffer.
///   Finding 2: an unreadable round took the UTC day of the round before it in the same record() call, or today
///              when it was the call's first: splitting the calls moved it (a hold up to 14 days longer), and a new
///              tape's unreadable round after a pre-window round hid on that pre-window day. An unreadable round now
///              counts as recorded the day it is recorded, however the calls are split (never earlier than it was
///              published: a hold is never shortened).
///   Finding 3: with the tape through the round before the latest, the round in force when the window opened (on a
///              day before it) was never compared. The latest day on the tape before the window is compared too.
contract StockVaultQ29pTest is JumpWindowBase {
    bytes4 constant TAPE_BEHIND = bytes4(keccak256("TapeBehind(address)"));

    function _h() internal view returns (StockVaultHolds) {
        return vault.holds();
    }

    /// A $100 loan on half a SPY ($300, a $150 line), past its defaultableAt, with 11 rounds at the same $600 published
    /// since the tape was last recorded: more than the hold reads live. `recordFirst` records them.
    function _lagged(bool recordFirst) internal returns (uint256 loanId) {
        _open(AGENT_PK, AGENT, SHARE / 2);
        loanId = _borrow(agentOp, AGENT, 100 * USDC);
        _record(address(spyFeed));
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        for (uint256 i = 10; i > 0; i--) {
            spyFeed.set(600e8, _now() - i * 6 minutes);
        }
        spyFeed.set(600e8, _now());
        if (recordFirst) _record(address(spyFeed));
    }

    function _status() internal view returns (StockVault.Status) {
        return vault.getPosition(AGENT).status;
    }

    // ---- Finding 1 ----

    function test_F1_tapeBehind_defaultWaits_settleSeizesOwedPlusBufferOnceRecorded() public {
        uint256 loanId = _lagged(false);
        assertEq(vault.lendStatus(address(spy)), vault.HOLD_PRICE_MOVED(), "new credit still waits (the public reason)");
        uint256 b0 = spy.balanceOf(agentOp);
        vm.prank(anyone);
        pool.markDefault(loanId);
        assertEq(spy.balanceOf(treasury), 0, "nothing seized on a tape behind");
        assertEq(uint8(_status()), uint8(StockVault.Status.Open), "the position waits for settle");
        assertEq(spy.balanceOf(address(vault)), SHARE / 2, "the whole deposit stays");
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(TAPE_BEHIND, address(spyFeed)));
        vault.settle(AGENT, 0);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(TAPE_BEHIND, address(spyFeed)));
        vault.reconcile(AGENT, 50);
        _record(address(spyFeed)); // anyone
        vm.prank(anyone);
        vault.settle(AGENT, 0);
        assertEq(spy.balanceOf(treasury), 200_466_666e9, "owed $101 + 20% at $600, rounded up");
        assertEq(spy.balanceOf(agentOp) - b0, SHARE / 2 - 200_466_666e9, "the rest back to the depositor");
        assertEq(uint8(_status()), uint8(StockVault.Status.Seized));
    }

    function test_F1_control_recorded_seizesOwedPlusBuffer() public {
        uint256 loanId = _lagged(true);
        assertEq(vault.lendStatus(address(spy)), 0);
        uint256 b0 = spy.balanceOf(agentOp);
        vm.prank(anyone);
        pool.markDefault(loanId);
        assertEq(spy.balanceOf(treasury), 200_466_666e9);
        assertEq(spy.balanceOf(agentOp) - b0, SHARE / 2 - 200_466_666e9);
    }

    /// A real price move, recorded, still seizes everything (SV-11: the price cannot be used for credit now).
    function test_F1_recordedPriceMove_stillSeizesAll() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrow(agentOp, AGENT, 100 * USDC);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        spyFeed.set(900e8, _now() - 1 hours); // +50% in the window
        spyFeed.set(600e8, _now());
        _record(address(spyFeed));
        assertEq(vault.lendStatus(address(spy)), vault.HOLD_PRICE_MOVED());
        vm.prank(anyone);
        pool.markDefault(loanId);
        assertEq(spy.balanceOf(treasury), SHARE / 2, "a price that cannot be used: everything, as before");
    }

    // ---- Finding 2 ----

    function _gapFeed() internal returns (GapFeed g, uint80 gapId, uint256 b) {
        b = (_now() / 1 days + 1) * 1 days; // a midnight
        vm.warp(b + 1 days);
        g = new GapFeed(8, 40e8); // rounds at b - 29d and b + 1d
        for (uint256 t = b + 1 days + 6 hours; t <= b + 16 days; t += 6 hours) {
            g.set(40e8, t);
        }
        for (uint80 i = 1; i <= g.rounds(); i++) {
            (,,, uint256 at) = g.timeOf(i);
            if (at == b + 2 days + 6 hours) gapId = i;
        }
        g.setGap(gapId); // the round at b + 2d + 6h cannot be read
    }

    function _held(GapFeed g) internal view returns (uint8) {
        return _h().lendStatus(address(vault), address(spy), address(g), treasury, 1 days, 2500, 14 days);
    }

    function _bump(GapFeed a, GapFeed c) internal {
        a.set(40e8, _now());
        c.set(40e8, _now());
        _h().record(address(a), 10_000);
        _h().record(address(c), 10_000);
    }

    /// The report's split (the tape's first round, up to the gap, the gap alone, the rest) and one call give the same
    /// tape: the unreadable round counts from the day it was recorded either way, and is released together.
    function test_F2b_splitRecord_sameTapeAsOneCall() public {
        (GapFeed honest, uint80 gapId, uint256 b) = _gapFeed();
        (GapFeed split,,) = _gapFeed();
        vm.warp(b + 16 days + 1 hours);
        honest.set(40e8, _now());
        split.set(40e8, _now());
        _h().record(address(honest), 10_000);
        _h().record(address(split), 1);
        (uint80 th,) = _h().tapes(address(split));
        _h().record(address(split), gapId - th - 1);
        (th,) = _h().tapes(address(split));
        assertEq(th, gapId - 1);
        _h().record(address(split), 1); // the gap alone, the call's first round
        _h().record(address(split), 10_000);
        assertEq(_held(honest), 1);
        assertEq(_held(split), 1);
        vm.warp(b + 17 days + 1 hours);
        _bump(honest, split);
        assertEq(_held(split), _held(honest), "split or not: the same tape");
        vm.warp(b + 31 days + 1 hours); // the recording day (b + 16d) has left the window
        _bump(honest, split);
        assertEq(_held(honest), 0);
        assertEq(_held(split), 0);
    }

    /// Recorded the day it is published (the keeper's 10-minute run), an unreadable round holds exactly while its own
    /// day is in the window.
    function test_F2_recordedPromptly_heldWhileItsDayIsInTheWindow() public {
        uint256 b = (_now() / 1 days + 1) * 1 days;
        vm.warp(b + 1 days);
        GapFeed g = new GapFeed(8, 40e8);
        for (uint256 t = b + 1 days + 6 hours; t <= b + 2 days + 6 hours; t += 6 hours) {
            g.set(40e8, t);
        }
        g.setGap(uint80(g.rounds())); // the round at b + 2d + 6h
        g.set(40e8, b + 2 days + 7 hours);
        vm.warp(b + 2 days + 7 hours);
        _h().record(address(g), 10_000);
        assertEq(_held(g), 1);
        for (uint256 t = b + 2 days + 12 hours; t <= b + 17 days + 1 hours; t += 6 hours) {
            g.set(40e8, t);
        }
        vm.warp(b + 16 days + 23 hours);
        g.set(40e8, _now());
        _h().record(address(g), 10_000);
        assertEq(_held(g), 1, "its day (b + 2d) is still in the window");
        vm.warp(b + 17 days + 1 hours);
        g.set(40e8, _now());
        _h().record(address(g), 10_000);
        assertEq(_held(g), 0, "released with its day");
    }

    /// 2(a): a new tape begins at a round before the window, and the next round, inside it, cannot be read. It used to
    /// take the pre-window day and was never compared; it holds now.
    function test_F2a_newTape_unreadableRoundAfterAPreWindowRound_holds() public {
        uint256 n0 = (_now() / 1 days + 1) * 1 days + 12 hours; // a noon
        vm.warp(n0);
        GapFeed g = new GapFeed(8, 40e8); // rounds at n0 - 30d and n0
        g.set(40e8, n0 + 1 days); // inside the window below
        g.setGap(3);
        vm.warp(n0 + 15 days - 1 hours); // the tape begins at n0's round (the first after 15 days ago), before the window
        g.set(40e8, _now() - 1 hours);
        _h().record(address(g), 10_000);
        assertEq(_held(g), 1, "the unreadable round of the window holds");
    }

    // ---- Finding 3 ----

    function _fridayMidnight() internal view returns (uint256) {
        return ((_now() / 1 days) + 7 - ((_now() / 1 days + 4) % 7) + 5) * 1 days;
    }

    /// A window shorter than a weekend: the tape through Friday's close compares it, as the live walk does.
    function test_F3_shortWindow_tapeComparesTheRoundBeforeTheWindow() public {
        uint256 fri = _fridayMidnight();
        vm.warp(fri + 20 hours);
        MockFeed a = new MockFeed(8, 40e8);
        MockFeed c = new MockFeed(8, 40e8);
        _h().record(address(c), 10_000); // the tape through Friday's close
        vm.warp(fri + 3 days + 14 hours); // Monday
        a.set(60e8, _now()); // +50% over the weekend
        c.set(60e8, _now());
        uint8 live = _h().lendStatus(address(vault), address(spy), address(a), treasury, 1 days, 2500, 1 hours);
        uint8 taped = _h().lendStatus(address(vault), address(spy), address(c), treasury, 1 days, 2500, 1 hours);
        assertEq(live, 1, "no tape: Friday compared, held");
        assertEq(taped, 1, "tape through Friday: compared, held");
    }

    /// Control: the same weekend at an unmoved price lends.
    function test_F3_shortWindow_quietWeekendLends() public {
        uint256 fri = _fridayMidnight();
        vm.warp(fri + 20 hours);
        MockFeed c = new MockFeed(8, 40e8);
        _h().record(address(c), 10_000);
        vm.warp(fri + 3 days + 14 hours);
        c.set(41e8, _now());
        assertEq(_h().lendStatus(address(vault), address(spy), address(c), treasury, 1 days, 2500, 1 hours), 0);
    }
}
