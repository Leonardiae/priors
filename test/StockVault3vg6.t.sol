// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./StockVaultJumpWindow.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {PtLinearDiscountFeed} from "../src/PtLinearDiscountFeed.sol";
import {IPPrincipalToken} from "../src/interfaces/IPendle.sol";

/// Pendle's reads the PT feed makes: an SY at 1:1, not paused, and its YT's index.
contract RingSy {
    function exchangeRate() external pure returns (uint256) {
        return 1e18;
    }

    function paused() external pure returns (bool) {
        return false;
    }
}

contract RingYt {
    function pyIndexStored() external pure returns (uint256) {
        return 1e18;
    }
}

/// The PT as the vault's collateral: 6 decimals, like PT-USDG.
contract RingPt is ERC20 {
    address public immutable SY;
    address public immutable YT;
    uint256 public immutable expiry;

    constructor(address sy, address yt, uint256 expiry_) ERC20("PT-USDG", "PT-USDG") {
        SY = sy;
        YT = yt;
        expiry = expiry_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// A feed that, like PtLinearDiscountFeed, serves only its last `ring` rounds: an older one reverts.
contract RingFeed {
    uint8 public constant decimals = 8;
    uint256 public immutable ring;
    int256[] internal answers;
    uint256[] internal times;

    constructor(uint256 r) {
        ring = r;
    }

    function set(int256 a, uint256 at) external {
        answers.push(a);
        times.push(at);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 n = answers.length;
        return (uint80(n), answers[n - 1], times[n - 1], times[n - 1], uint80(n));
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 n = answers.length;
        require(id >= 1 && id <= n && n - id < ring, "NoRound");
        return (id, answers[id - 1], times[id - 1], times[id - 1], id);
    }
}

/// A MockFeed any of whose rounds can be made unreadable.
contract GapsFeed {
    uint8 public decimals;
    int256[] internal answers;
    uint256[] internal times;
    mapping(uint80 => bool) public gap;

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
        gap[id] = true;
    }

    function rounds() external view returns (uint256) {
        return answers.length;
    }

    function timeOf(uint80 id) external view returns (uint80, int256, uint256, uint256) {
        return (id, answers[id - 1], times[id - 1], times[id - 1]);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 n = answers.length;
        return (uint80(n), answers[n - 1], times[n - 1], times[n - 1], uint80(n));
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(id >= 1 && id <= answers.length && !gap[id], "No data present");
        return (id, answers[id - 1], times[id - 1], times[id - 1], id);
    }
}

/// GHSA-3vg6-2f3m-j5qm (hey-research-lab): a new price tape begins where a binary search over the feed's rounds 1 to
/// latest finds the first round of the last TAPE_FROM (20 days), and the search counted a round it cannot read as
/// recent. PtLinearDiscountFeed (PT-USDG's feed) serves only its last 1,024 rounds, so from round 2,048 on the search's
/// first probe cannot be read, every later probe is below it, and the tape begins at round 1: unreadable, read as a
/// phase begun now (`phaseBegan`), with the rounds the feed has dropped recorded as today's, unreadable. New credit then
/// waits for the whole 14-day window with nothing moved, and a default in it seizes every token instead of what is owed
/// plus 20%. Every implementation deploys its own StockVaultHolds, so every upgrade starts every tape again.
///
/// Each expected start below is read from the feed by the test (the first round it serves published after the cut),
/// not from the code under test.
contract StockVault3vg6Test is JumpWindowBase {
    bytes32 constant RECORDED = keccak256("Recorded(address,uint80,uint80)");
    uint256 constant PT_UNIT = 1e6;

    RingPt pt;
    PtLinearDiscountFeed feed;

    function setUp() public override {
        super.setUp();
        pt = new RingPt(address(new RingSy()), address(new RingYt()), block.timestamp + 500 days);
        feed = new PtLinearDiscountFeed(IPPrincipalToken(address(pt)), 600, owner);
        feed.push();
        vm.prank(owner);
        vault.setAsset(address(pt), address(feed), 26 hours, true, 5000, uint128(1000 * USDC));
        pt.mint(agentOp, 1000 * PT_UNIT);
        vm.prank(agentOp);
        pt.approve(address(vault), type(uint256).max);
    }

    /// `n` more rounds of the PT feed, `every` apart (hourly is the live pace; 50 minutes, MIN_INTERVAL, the fastest
    /// anyone may push), the vault's live tape recorded every `recordEvery` rounds (0: never, no tape yet).
    function _push(uint256 n, uint256 every, uint256 recordEvery) internal {
        for (uint256 i; i < n; ++i) {
            vm.warp(_now() + every);
            feed.push();
            if (recordEvery != 0 && i % recordEvery == recordEvery - 1) _record(address(feed));
        }
        if (recordEvery != 0) _record(address(feed));
    }

    /// The first round `f` serves that was published after `cut`, walking down from its latest (independent of the
    /// tape's search).
    function _firstAfter(address f, uint256 cut) internal view returns (uint256 first) {
        (uint80 latest,,,,) = IPriceFeed(f).latestRoundData();
        for (uint256 id = latest; id >= 1; --id) {
            try IPriceFeed(f).getRoundData(uint80(id)) returns (uint80, int256, uint256, uint256 at, uint80) {
                if (at <= cut) break;
                first = id;
            } catch {
                break;
            }
        }
    }

    /// Records `f` on the vault's holds, as one call (the keeper's, or the operator's after an upgrade), and returns the
    /// round a new tape began at, from the holds' Recorded event.
    function _recordNew(address f) internal returns (uint256 from) {
        vm.recordLogs();
        _record(f);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == RECORDED && logs[i].topics[1] == bytes32(uint256(uint160(f)))) {
                (uint80 fromRound,) = abi.decode(logs[i].data, (uint80, uint80));
                return fromRound;
            }
        }
        revert("not recorded");
    }

    /// The same code as a new implementation, through the vault's ProxyAdmin: only its StockVaultHolds is new.
    function _upgrade() internal {
        ProxyAdmin admin = ProxyAdmin(address(uint160(uint256(vm.load(address(vault), ERC1967Utils.ADMIN_SLOT)))));
        StockVault impl = new StockVault(pool);
        vm.prank(owner);
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(vault)), address(impl), "");
    }

    function _phaseBegan(address f) internal view returns (uint48 began) {
        (, began) = vault.holds().tapes(f);
    }

    /// The report's case at the live pace (one round an hour): at round 2,048 a new tape begins at the first round of
    /// the last 20 days, not at round 1, and PT credit lends.
    function test_ringFeedPastTwoRings_newTapeBeginsAtTheCut_andLends() public {
        _push(2047, 1 hours, 0);
        assertEq(feed.latestRound(), 2048);
        vm.expectRevert(abi.encodeWithSelector(PtLinearDiscountFeed.NoRound.selector, uint80(1024)));
        feed.getRoundData(1024); // (1 + 2,048) / 2: the search's first probe
        uint256 first = _firstAfter(address(feed), _now() - 20 days);
        assertEq(first, 2048 - 20 * 24 + 1, "the last 20 days: 480 hourly rounds");
        assertEq(_recordNew(address(feed)), first, "the tape begins at the first round of the last 20 days");
        assertEq(_phaseBegan(address(feed)), 0, "a feed 85 days old is not a phase begun now");
        assertEq(vault.lendStatus(address(pt)), 0, "nothing moved: no hold");
        (bool ok,) = vault.valueOf(address(pt), 100 * PT_UNIT);
        assertTrue(ok, "PT priced for new credit");
    }

    /// The fastest pace anyone may push (50 minutes, 576 rounds in 20 days): the round 512 back is recent, the one 1,024
    /// back already dropped, so a search that only doubles back from the latest would miss the window's start too.
    function test_ringFeedAtTheFastestPace_newTapeBeginsAtTheCut_andLends() public {
        _push(2100, 50 minutes, 0);
        uint256 first = _firstAfter(address(feed), _now() - 20 days);
        assertEq(first, 2101 - 576 + 1, "the last 20 days: 576 rounds");
        assertEq(_recordNew(address(feed)), first);
        assertEq(_phaseBegan(address(feed)), 0);
        assertEq(vault.lendStatus(address(pt)), 0);
    }

    /// The report's default: a $200 loan on 500 PT, defaulted after an upgrade at round 2,048 on, seizes what is owed
    /// plus 20% at the feed's price and gives the rest back, as on the tape it replaced.
    function test_ringFeed_defaultAfterAnUpgrade_seizesOwedPlusBuffer() public {
        _push(2047, 1 hours, 12);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(agentOp);
        vault.open(AGENT, address(pt), 500 * PT_UNIT, c, sig);
        uint256 loanId = _borrow(agentOp, AGENT, 200 * USDC);
        _push(245, 1 hours, 12); // past its defaultableAt (7 days, then 3 of grace), the live tape recorded all along
        assertEq(vault.lendStatus(address(pt)), 0, "the live tape: no hold");
        _upgrade();
        _record(address(feed)); // the new holds' tape, as the operator records it after an upgrade
        assertEq(vault.lendStatus(address(pt)), 0, "the new tape: no hold either");
        CreditPoolV2.Loan memory l = pool.getLoan(loanId);
        uint256 owed = l.principal + l.fee;
        (, int256 answer,,,) = feed.latestRoundData();
        uint256 b0 = pt.balanceOf(agentOp);
        vm.prank(anyone);
        pool.markDefault(loanId);
        uint256 seized = pt.balanceOf(treasury);
        // PT 6 decimals, the feed 18: a PT base unit is worth answer / 1e18 USDG base units (compared exactly, scaled)
        uint256 due = owed * 12_000 * 1e18; // owed + 20%, times 10,000 and 1e18
        assertGe(seized * uint256(answer) * 10_000, due, "at least owed + 20% at the feed's price");
        assertLt((seized - 1) * uint256(answer) * 10_000, due, "and not a base unit more");
        assertLt(seized, 500 * PT_UNIT, "not the whole deposit");
        assertEq(pt.balanceOf(agentOp) - b0, 500 * PT_UNIT - seized, "the rest back to the depositor");
    }

    /// Fail-closed kept: a ring too short to reach back 20 days (40 rounds, 6 hours apart) cannot show the window's
    /// start, so a new tape still holds new credit.
    function test_ringTooShortForTheWindow_stillHolds() public {
        MockStock tok = new MockStock("RING");
        RingFeed r = new RingFeed(40);
        for (uint256 h = 30 * 24; h > 0; h -= 6) {
            r.set(40e8, _now() - h * 1 hours);
        }
        r.set(40e8, _now());
        vm.prank(owner);
        vault.setAsset(address(tok), address(r), 4 days, true, 2500, uint128(500 * USDC));
        _record(address(r));
        assertEq(vault.lendStatus(address(tok)), vault.HOLD_PRICE_MOVED(), "history that cannot be read holds");
        assertEq(_phaseBegan(address(r)), _now(), "round 1 cannot be read: the phase counts as begun now");
    }

    /// Fail-closed kept: an unreadable round inside the last 20 days, where the search reads first. The tape still
    /// begins at the first round after the cut, below it, and the round holds new credit.
    function test_unreadableRecentRound_tapeStillBeginsAtTheCut_andHolds() public {
        uint256 t0 = _now();
        GapFeed g = new GapFeed(8, 40e8); // rounds 1 and 2: t0 - 30 days, t0
        vm.warp(t0 + 25 days);
        for (uint256 t = t0 + 1 days; t <= _now(); t += 6 hours) {
            g.set(40e8, t);
        }
        uint256 latest = g.rounds();
        uint256 mid = (1 + latest) / 2;
        (,,, uint256 atMid) = g.timeOf(uint80(mid));
        assertGt(atMid, _now() - 20 days, "the search's first probe is a recent round");
        uint256 first = _firstAfter(address(g), _now() - 20 days);
        assertLt(first, mid);
        g.setGap(uint80(mid));
        MockStock tok = new MockStock("GAP");
        vm.prank(owner);
        vault.setAsset(address(tok), address(g), 4 days, true, 2500, uint128(500 * USDC));
        assertEq(_recordNew(address(g)), first, "the tape begins at the cut, before the round it cannot read");
        assertEq(vault.lendStatus(address(tok)), vault.HOLD_PRICE_MOVED(), "the unreadable round holds");
    }

    /// The same with a second unreadable round in the last 20 days, where the search below the first one reads first:
    /// the tape still begins at the first round after the cut, before both.
    function test_twoUnreadableRecentRounds_tapeStillBeginsAtTheCut() public {
        uint256 t0 = _now();
        GapsFeed g = new GapsFeed(8, 40e8); // rounds 1 and 2: t0 - 30 days, t0
        vm.warp(t0 + 25 days);
        for (uint256 t = t0 + 1 days; t <= _now(); t += 6 hours) {
            g.set(40e8, t);
        }
        uint256 mid = (1 + g.rounds()) / 2; // the first search's first probe
        uint256 below = (1 + mid) / 2; // the first probe of a search below it
        (,,, uint256 atBelow) = g.timeOf(uint80(below));
        assertGt(atBelow, _now() - 20 days, "both are recent rounds");
        uint256 first = _firstAfter(address(g), _now() - 20 days);
        assertLt(first, below);
        g.setGap(uint80(mid));
        g.setGap(uint80(below));
        MockStock tok = new MockStock("GAPS");
        vm.prank(owner);
        vault.setAsset(address(tok), address(g), 4 days, true, 2500, uint128(500 * USDC));
        assertEq(_recordNew(address(g)), first, "the tape begins at the cut, before both");
        assertEq(vault.lendStatus(address(tok)), vault.HOLD_PRICE_MOVED());
    }

    /// Unchanged where every round can be read (the 35 stock feeds): the tape begins at the first round of the last 20
    /// days.
    function test_feedThatServesEveryRound_newTapeBeginsAtTheCut() public {
        MockStock tok = new MockStock("ALL");
        MockFeed f = new MockFeed(8, 40e8);
        vm.warp(_now() + 40 days);
        for (uint256 h = 35 * 24; h > 0; h -= 3) {
            f.set(40e8, _now() - h * 1 hours);
        }
        f.set(40e8, _now());
        vm.prank(owner);
        vault.setAsset(address(tok), address(f), 4 days, true, 2500, uint128(500 * USDC));
        uint256 first = _firstAfter(address(f), _now() - 20 days);
        assertEq(_recordNew(address(f)), first);
        assertEq(vault.lendStatus(address(tok)), 0);
    }
}
