// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./StockVault.t.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPriceFeed} from "../src/StockVault.sol";

/// GHSA-7gq2-77ph-mw6j: the price-jump hold compared the latest answer with the rounds 1, 2, 4 … 4,096 back only, and
/// stopped at the first of them published before its window, so a round of the window between two of them (offset 325
/// between 256 and 512 on IONQ at block 87,601,461) was never compared: SECURITY-v2's SV-1 states "a move over 25%
/// against any round of the last 14 days". These tests hold new credit against every round of the window.
///
/// The feed's history (the hold reads the newest rounds live, and the rest from the price tape StockVaultHolds keeps)
/// is recorded with `record(feed, n)` on the vault's holds contract, which anyone may call; on an implementation without
/// a tape that call fails and changes nothing, so these tests compile and run against both.
/// A MockFeed one of whose rounds cannot be read ("No data present"), as an aggregator round with no answer.
contract GapFeed {
    uint8 public decimals;
    int256[] internal answers;
    uint256[] internal times;
    uint80 public gap;

    constructor(uint8 d, int256 a) {
        decimals = d;
        set(a, block.timestamp - 30 days);
        set(a, block.timestamp);
    }

    function set(int256 a, uint256 at) public {
        answers.push(a);
        times.push(at);
    }

    function setGap(uint80 id) external {
        gap = id;
    }

    function rounds() external view returns (uint256) {
        return answers.length;
    }

    /// The time of round `id`, as the test knows it (the feed itself will not say).
    function timeOf(uint80 id) external view returns (uint80, int256, uint256, uint256) {
        return (id, answers[id - 1], times[id - 1], times[id - 1]);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 n = answers.length;
        return (uint80(n), answers[n - 1], times[n - 1], times[n - 1], uint80(n));
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(id >= 1 && id <= answers.length && id != gap, "No data present");
        return (id, answers[id - 1], times[id - 1], times[id - 1], id);
    }
}

abstract contract JumpWindowBase is StockVaultBase {
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// The vault's StockVaultHolds: the first contract its implementation created.
    function _holds() internal view returns (address) {
        address impl = address(uint160(uint256(vm.load(address(vault), IMPL_SLOT))));
        return vm.computeCreateAddress(impl, 1);
    }

    /// Records `feed`'s rounds on the vault's price tape (anyone may; a no-op where there is none).
    function _record(address feed) internal {
        vm.prank(anyone);
        (bool ok,) = _holds().call(abi.encodeWithSignature("record(address,uint256)", feed, 10_000));
        ok; // false on an implementation without a tape
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }
}

contract StockVaultJumpWindowTest is JumpWindowBase {
    MockStock ionq;
    MockFeed ionqFeed;

    // the report's IONQ rounds (block 87,601,461): the latest and the three that decide the walk
    uint256 constant T = 1_791_903_540; // the report's block time, 2026-10-13 14:59:00 UTC
    int256 constant LATEST = 3_500_259_999; // $35.00259999
    int256 constant AT_256 = 4_401_000_000; // $44.01, sampled, 20.5% away
    int256 constant AT_325 = 4_703_650_000; // $47.0365, never sampled, 25.58% away
    int256 constant AT_512 = 4_468_800_000; // $44.688, sampled, 21.7% away, before the window: the walk stops here
    int256 constant OTHERS = 4_000_000_000; // $40: every other round, 12.5% away
    uint256 constant DT = 3466; // seconds between rounds: offset 325 is 83,038 s inside the window, 512 outside
    uint256 constant ROUNDS = 600;

    function setUp() public override {
        super.setUp();
        ionq = new MockStock("IONQ");
        // the feed's history: ROUNDS rounds DT apart, the last at T (its constructor adds two older ones)
        vm.warp(T - ROUNDS * DT);
        ionqFeed = new MockFeed(8, OTHERS);
        for (uint256 off = ROUNDS - 1;; off--) {
            int256 a = off == 0 ? LATEST : off == 256 ? AT_256 : off == 325 ? AT_325 : off == 512 ? AT_512 : OTHERS;
            ionqFeed.set(a, T - off * DT);
            if (off == 0) break;
        }
        vm.warp(T);
        vm.prank(owner);
        vault.setAsset(address(ionq), address(ionqFeed), 4 days, true, 2500, uint128(500 * USDC));
        ionq.mint(agentOp, 100 * SHARE);
        vm.prank(agentOp);
        ionq.approve(address(vault), type(uint256).max);
    }

    function _openIonq(uint256 amount) internal returns (uint256 line) {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(agentOp);
        line = vault.open(AGENT, address(ionq), amount, c, sig);
    }

    function _expectIonqHeld(uint256 amount) internal {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(StockVault.LendingHeld.selector, address(ionq), 1));
        vault.open(AGENT, address(ionq), amount, c, sig);
    }

    /// The report's shape: the walk's samples (1 … 256, then 512 before the window) are all within 25% of the latest,
    /// and offset 325, inside the window, is 25.58% away. New credit waits.
    function test_roundBetweenTwoSamples_holdsNewLines() public {
        uint256 since = T - 14 days;
        (, int256 a325,, uint256 t325,) = ionqFeed.getRoundData(uint80(ionqFeed.rounds() - 325));
        assertEq(a325, AT_325);
        assertGt(t325, since, "offset 325 is inside the window (on IONQ's feed: 83,038 s inside)");
        (,,, uint256 t512,) = ionqFeed.getRoundData(uint80(ionqFeed.rounds() - 512));
        assertLe(t512, since, "offset 512 is before it");
        _record(address(ionqFeed));
        assertEq(vault.lendStatus(address(ionq)), vault.HOLD_PRICE_MOVED(), "a round of the window moved over 25%");
        (bool ok,) = vault.valueOf(address(ionq), SHARE);
        assertFalse(ok, "no price for new credit");
        _expectIonqHeld(10 * SHARE);
    }

    /// The hold lasts until that round leaves the window (the tape counts whole UTC days: until the end of its day,
    /// plus the window), then the same price lends.
    function test_roundBetweenTwoSamples_heldUntilItLeavesTheWindow() public {
        (,,, uint256 t325,) = ionqFeed.getRoundData(uint80(ionqFeed.rounds() - 325));
        uint256 release = (t325 / 1 days + 1) * 1 days + 14 days; // the end of its UTC day, plus the window
        vm.warp(t325 + 14 days - 1); // the stated rule still holds here
        ionqFeed.set(LATEST, _now());
        _record(address(ionqFeed));
        _expectIonqHeld(10 * SHARE);
        vm.warp(release + 1);
        ionqFeed.set(LATEST, _now());
        _record(address(ionqFeed));
        assertEq(vault.lendStatus(address(ionq)), 0, "the round left the window");
        uint256 line = _openIonq(10 * SHARE);
        assertEq(line, 10 * uint256(LATEST) / 100 * 25 / 100, "25% of $350.026");
    }

    /// An open line: once a one-round spike sits between two samples (offset 3: the walk reads 1, 2, 4 …), a new loan
    /// against it is still refused while the spike is in the window; repaying and closing never wait.
    function test_spikeBetweenSamples_refusesNewLoansOnAnOpenLine() public {
        // a quiet stretch: the 14 days before now at $40, so a line opens
        vm.warp(T + 15 days);
        for (uint256 h = 15 * 24; h > 0; h -= 6) {
            ionqFeed.set(OTHERS, _now() - h * 1 hours);
        }
        ionqFeed.set(OTHERS, _now());
        _record(address(ionqFeed));
        assertEq(vault.lendStatus(address(ionq)), 0, "a quiet window lends");
        _openIonq(10 * SHARE); // a $100 line on $400
        uint256 loanId = _borrow(agentOp, AGENT, 20 * USDC);
        // one round at $55 (37.5% up), then three back at $40
        ionqFeed.set(5_500_000_000, _now() + 1 hours);
        for (uint256 i = 2; i <= 4; i++) {
            ionqFeed.set(OTHERS, _now() + i * 1 hours);
        }
        vm.warp(_now() + 4 hours);
        _record(address(ionqFeed));
        assertEq(vault.lendStatus(address(ionq)), vault.HOLD_PRICE_MOVED(), "the $55 round, 27.3% from $40, is held");
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
        assertEq(vault.borrowRoom(AGENT), 0);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        vm.prank(agentOp);
        vault.close(AGENT);
        assertEq(ionq.balanceOf(agentOp), 100 * SHARE, "the hold never keeps a depositor's tokens");
    }

    /// More rounds in the window than the hold reads from the feed, and none of them recorded: new credit waits until
    /// someone records the feed (history that cannot be checked is not trusted), then the same price lends.
    function test_windowNotRecorded_holdsUntilRecorded() public {
        (,,, uint256 t325,) = ionqFeed.getRoundData(uint80(ionqFeed.rounds() - 325));
        uint256 t = (t325 / 1 days + 1) * 1 days + 14 days + 1; // offset 325's day has left the window
        vm.warp(t + 10 hours);
        for (uint256 h; h <= 10; h++) {
            ionqFeed.set(LATEST, t + h * 1 hours);
        }
        assertEq(vault.lendStatus(address(ionq)), vault.HOLD_PRICE_MOVED(), "not recorded: held");
        _record(address(ionqFeed));
        assertEq(vault.lendStatus(address(ionq)), 0, "recorded, nothing over 25% in the window");
    }

    /// A round of the window that cannot be read holds new credit while it is in the window: read from the feed, for
    /// its own day; recorded on the tape, from the UTC day it was recorded (its own is unknown; GHSA-q29p-rp35-p8v2),
    /// so a backfill holds it up to that much longer, never shorter.
    function test_unreadableRoundInTheWindow_holds() public {
        GapFeed g = new GapFeed(8, OTHERS);
        vm.warp(T + 20 days);
        for (uint256 h = 15 * 24; h > 0; h -= 6) {
            g.set(OTHERS, _now() - h * 1 hours);
        }
        g.set(OTHERS, _now());
        uint256 gapId = (1 + g.rounds()) / 2; // the first round a new tape's start search reads
        assertEq(g.rounds() - gapId, 31, "offset 31: between the walk's samples 16 and 32");
        g.setGap(uint80(gapId));
        vm.prank(owner);
        vault.setAsset(address(ionq), address(g), 4 days, true, 2500, uint128(500 * USDC));
        _record(address(g));
        uint256 recorded = _now() / 1 days;
        assertEq(vault.lendStatus(address(ionq)), vault.HOLD_PRICE_MOVED(), "a round of the window cannot be read");
        (,,, uint256 at) = g.timeOf(uint80(gapId));
        vm.warp((at / 1 days + 1) * 1 days + 14 days + 1);
        g.set(OTHERS, _now());
        _record(address(g));
        assertEq(
            vault.lendStatus(address(ionq)),
            vault.HOLD_PRICE_MOVED(),
            "its own day has left, the day it was recorded not"
        );
        vm.warp((recorded + 1) * 1 days + 14 days + 1);
        g.set(OTHERS, _now());
        _record(address(g));
        assertEq(vault.lendStatus(address(ionq)), 0, "the day it was recorded has left the window");
    }

    /// With no window (the guard as loosened on 2026-10-05), only the round before the latest is compared, recorded
    /// tape or not.
    function test_windowZero_withATape_comparesThePreviousRoundOnly() public {
        vm.prank(owner);
        vault.setPriceGuard(2500, 0, 1 days);
        vm.warp(T + 2 hours);
        ionqFeed.set(6_000_000_000, T + 1 hours); // +71% on the latest
        _record(address(ionqFeed));
        assertEq(vault.lendStatus(address(ionq)), vault.HOLD_PRICE_MOVED(), "the jump's own round");
        ionqFeed.set(6_000_000_000, T + 2 hours);
        _record(address(ionqFeed));
        assertEq(vault.lendStatus(address(ionq)), 0, "the next round: only the previous one is compared");
    }

    /// A day recorded in two parts keeps its extremes: a spike recorded in the morning still holds after the rest of
    /// the day (and the next days) is recorded.
    function test_aDayRecordedTwice_keepsItsSpike() public {
        uint256 d0 = (T / 1 days + 20) * 1 days; // a midnight, 20 days after the report's block
        vm.warp(d0 + 9 hours);
        for (uint256 h = 15 * 24; h > 0; h -= 6) {
            ionqFeed.set(OTHERS, d0 - h * 1 hours);
        }
        ionqFeed.set(5_500_000_000, d0 + 9 hours); // $55 at 09:00
        _record(address(ionqFeed));
        vm.warp(d0 + 2 days);
        // the rest of the day, and more
        for (uint256 h = 10; h < 48; h += 2) {
            ionqFeed.set(OTHERS, d0 + h * 1 hours);
        }
        _record(address(ionqFeed));
        assertEq(vault.lendStatus(address(ionq)), vault.HOLD_PRICE_MOVED(), "the morning's $55 is still in the window");
    }

    /// Control, held on every implementation: a step inside the window that the latest answer still carries.
    function test_stepThatPersists_isHeld() public {
        vm.warp(T + 301 minutes);
        // $60 from $40: 50%
        for (uint256 i; i < 300; i++) {
            ionqFeed.set(6_000_000_000, T + (i + 1) * 1 minutes);
        }
        _record(address(ionqFeed));
        assertEq(vault.lendStatus(address(ionq)), vault.HOLD_PRICE_MOVED());
    }
}
