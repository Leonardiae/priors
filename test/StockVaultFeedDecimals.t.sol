// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {StockVault, StockVaultHolds, IPriceFeed} from "../src/StockVault.sol";
import {StockVaultBase} from "./StockVault.t.sol";

/// A Chainlink AggregatorProxy as the vault reads one: `decimals()` and `latestRoundData()` follow the current phase's
/// aggregator, a round id is phase << 64 | the aggregator's round, and `getRoundData` still serves earlier phases.
/// `upgrade` is the proxy owner's confirmAggregator: a new phase, whose aggregator may answer in other decimals.
contract PhasedFeed {
    uint16 public phaseId = 1;
    mapping(uint16 => uint8) internal _decimals;
    mapping(uint16 => uint64) internal _rounds;
    mapping(uint80 => int256) internal _answer;
    mapping(uint80 => uint256) internal _at;
    bool internal _decimalsDown;

    constructor(uint8 d, int256 a) {
        _decimals[1] = d;
        push(a, block.timestamp - 30 days);
        push(a, block.timestamp);
    }

    function upgrade(uint8 d, int256 a, uint256 at) external {
        phaseId += 1;
        _decimals[phaseId] = d;
        push(a, at);
    }

    function push(int256 a, uint256 at) public {
        uint80 id = uint80((uint256(phaseId) << 64) | ++_rounds[phaseId]);
        _answer[id] = a;
        _at[id] = at;
    }

    /// Not something a Chainlink proxy does: another scale without a new phase.
    function setDecimalsInPlace(uint8 d) external {
        _decimals[phaseId] = d;
    }

    function breakDecimals() external {
        _decimalsDown = true;
    }

    function decimals() external view returns (uint8) {
        require(!_decimalsDown, "decimals down");
        return _decimals[phaseId];
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint80 id = uint80((uint256(phaseId) << 64) | _rounds[phaseId]);
        return (id, _answer[id], _at[id], _at[id], id);
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(_at[id] != 0, "No data present");
        return (id, _answer[id], _at[id], _at[id], id);
    }
}

/// GHSA-rwj3-gr68-p93p: `setAsset` reads the feed's decimals once, and the vault priced every later answer on that
/// scale. A Chainlink proxy answers in its current aggregator's decimals, so a proxy its owner moves to an aggregator
/// of more decimals at the same price made the vault value collateral 10^(new - old) times too high (8 to 18: 10^10),
/// once the price guard let the new phase through (its walk never reads across phases). Now a feed that answers in
/// other decimals than `setAsset` read, or whose decimals cannot be read, prices nothing for new credit until the
/// owner's `setAsset` reads it again. Repaying, closing and settling never read a price.
contract StockVaultFeedDecimalsLocalTest is StockVaultBase {
    PhasedFeed feed;
    uint64 constant MAX_AGE = 1 days + 1 hours;
    uint128 constant LINE_CAP = uint128(1000 * USDC);

    function setUp() public override {
        super.setUp();
        feed = new PhasedFeed(8, 600e8); // $600 a share, 8 decimals like the live feeds
        vm.prank(owner);
        vault.setAsset(address(spy), address(feed), MAX_AGE, true, 5000, LINE_CAP);
    }

    /// The guard as loosened on 2026-10-05 (SV-1): the previous round only.
    function _windowZero() internal {
        vm.prank(owner);
        vault.setPriceGuard(2500, 0, 14 days);
    }

    function _openRefusedForThePrice(uint256 id, uint256 pk, uint256 amount) internal {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(id, pk);
        vm.prank(vm.addr(pk));
        vm.expectRevert(abi.encodeWithSelector(StockVault.PriceUnavailable.selector, address(spy)));
        vault.open(id, address(spy), amount, c, sig);
    }

    /// The report: the same $600 from an 18-decimal aggregator; the new phase's first round is held, the second clears
    /// the window-0 guard. 0.0001 SPY is worth $0.06, below any line; the cached scale read it as $600 million.
    function test_decimalsUp_newPhase_noLineOnTheCachedScale() public {
        _windowZero();
        feed.upgrade(18, 600e18, block.timestamp);
        assertEq(vault.lendStatus(address(spy)), vault.HOLD_PRICE_MOVED(), "the new phase's first round is held");
        feed.push(600e18, block.timestamp);
        assertEq(vault.lendStatus(address(spy)), 0, "the second round clears the guard");

        uint256 dust = SHARE / 10_000; // $0.06
        (bool ok, uint256 value) = vault.valueOf(address(spy), dust);
        assertFalse(ok, "no value on the scale setAsset read");
        assertEq(value, 0);
        _openRefusedForThePrice(AGENT, AGENT_PK, dust);
    }

    /// A position opened before the change: every new loan asks canBorrow, which priced the collateral on the cached
    /// scale too. $120 of SPY opened a $60 line; the new aggregator prints $300, so the deposit is worth $60 and $30 can
    /// be drawn. The whole $60 line is refused.
    function test_decimalsUp_openPosition_noLoanPastItsLtv() public {
        _windowZero();
        uint256 line = _open(AGENT_PK, AGENT, SHARE / 5);
        assertEq(line, 60 * USDC);
        feed.upgrade(18, 300e18, block.timestamp);
        feed.push(300e18, block.timestamp);
        assertEq(vault.lendStatus(address(spy)), 0);

        assertEq(vault.borrowRoom(AGENT), 0, "nothing to draw on the cached scale");
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 60 * USDC, 7 days, agentOp, type(uint256).max);
    }

    /// The guard as set on chain since 2026-10-08 (a 14-day window) holds a new phase only until its first round is 14
    /// days old: the walk reads the new phase alone, every round of it on the new scale. It delays the report's path,
    /// it does not close it.
    function test_fourteenDayWindow_holdsTheNewPhaseForItsLengthOnly_thenNoValueOnTheCachedScale() public {
        assertEq(vault.jumpWindow(), 14 days);
        uint256 t = block.timestamp; // kept here: via-IR may reuse block.timestamp across vm.warp in one function
        feed.upgrade(18, 600e18, t);
        for (uint256 d = 1; d <= 15; ++d) {
            t += 1 days;
            vm.warp(t);
            feed.push(600e18, t);
            _tape(address(feed));
            assertEq(vault.lendStatus(address(spy)), d < 14 ? vault.HOLD_PRICE_MOVED() : 0, "held for 14 days only");
        }
        (bool ok,) = vault.valueOf(address(spy), SHARE / 10_000);
        assertFalse(ok, "no value on the scale setAsset read");
        _openRefusedForThePrice(AGENT, AGENT_PK, SHARE / 10_000);
    }

    /// Fewer decimals would understate the deposit (no loss, but a wrong price): refused the same way.
    function test_decimalsDown_refusedNotUnderstated() public {
        _windowZero();
        feed.upgrade(6, 600e6, block.timestamp);
        feed.push(600e6, block.timestamp);
        assertEq(vault.lendStatus(address(spy)), 0);
        (bool ok,) = vault.valueOf(address(spy), SHARE);
        assertFalse(ok, "fewer decimals: refused, not understated");
        _openRefusedForThePrice(AGENT, AGENT_PK, SHARE);
    }

    /// The check is on the decimals, not on the phase: another scale inside one phase is refused too (the walk holds the
    /// rescaled round itself, then the next round on the new scale clears it).
    function test_decimalsChangedWithoutANewPhase_refused() public {
        _windowZero();
        feed.setDecimalsInPlace(18);
        feed.push(600e18, block.timestamp);
        assertEq(vault.lendStatus(address(spy)), vault.HOLD_PRICE_MOVED());
        feed.push(600e18, block.timestamp);
        assertEq(vault.lendStatus(address(spy)), 0);
        (bool ok,) = vault.valueOf(address(spy), SHARE / 10_000);
        assertFalse(ok, "another scale in the same phase: refused");
    }

    /// A feed whose decimals cannot be read is not priced: its scale cannot be checked.
    function test_unreadableDecimals_refused() public {
        feed.breakDecimals();
        (bool ok,) = vault.valueOf(address(spy), SHARE);
        assertFalse(ok, "decimals unreadable: refused");
        _openRefusedForThePrice(AGENT, AGENT_PK, SHARE);
    }

    /// The way back is the owner's: `setAsset` with the same feed (allowed while tokens are held) reads the decimals
    /// again. The position is then valued on the feed's scale and draws within its LTV, and $0.06 opens no line.
    function test_ownerRereadsTheFeed_valuesOnTheNewScale() public {
        _windowZero();
        assertEq(_open(AGENT_PK, AGENT, SHARE / 5), 60 * USDC);
        feed.upgrade(18, 300e18, block.timestamp);
        feed.push(300e18, block.timestamp);

        vm.prank(owner);
        vault.setAsset(address(spy), address(feed), MAX_AGE, true, 5000, LINE_CAP);
        (,,, uint8 cached,,,) = vault.assets(address(spy));
        assertEq(cached, 18);
        (bool ok, uint256 value) = vault.valueOf(address(spy), SHARE / 5);
        assertTrue(ok);
        assertEq(value, 60 * USDC, "0.2 SPY at $300");
        assertEq(vault.borrowRoom(AGENT), 30 * USDC);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 30 * USDC + 1, 7 days, agentOp, type(uint256).max);
        _borrow(agentOp, AGENT, 30 * USDC);

        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT2, AGENT2_PK);
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(StockVault.LineTooSmall.selector, 15_000, 5 * USDC));
        vault.open(AGENT2, address(spy), SHARE / 10_000, c, sig);
    }

    /// Control: a new phase on the same decimals lends as before (one round of hold at window 0, the walk's own rule).
    function test_newPhaseSameDecimals_lendsAsBefore() public {
        _windowZero();
        feed.upgrade(8, 600e8, block.timestamp);
        assertEq(vault.lendStatus(address(spy)), vault.HOLD_PRICE_MOVED());
        feed.push(600e8, block.timestamp);
        (bool ok, uint256 value) = vault.valueOf(address(spy), SHARE / 5);
        assertTrue(ok);
        assertEq(value, 120 * USDC);
        assertEq(_open(AGENT_PK, AGENT, SHARE / 5), 60 * USDC);
    }
}

/// The owner functions of the live feeds' Chainlink proxy (EACAggregatorProxy).
interface IChainlinkProxy {
    function owner() external view returns (address);
    function phaseId() external view returns (uint16);
    function proposeAggregator(address aggregator) external;
    function confirmAggregator(address aggregator) external;
}

interface IProxyAdminOf {
    function owner() external view returns (address);
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
}

interface IRegistryMintFork {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

/// An aggregator that answers in 18 decimals (the proxy adds its phase to the round ids).
contract Aggregator18 {
    uint8 public constant decimals = 18;
    int256[] internal answers;
    uint256[] internal times;

    function push(int256 a, uint256 at) external {
        answers.push(a);
        times.push(at);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 n = answers.length;
        return (uint80(n), answers[n - 1], times[n - 1], times[n - 1], uint80(n));
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(id >= 1 && id <= answers.length, "No data present");
        return (id, answers[id - 1], times[id - 1], times[id - 1], id);
    }
}

/// The same on live state: the deployed vault, the real SPY token and its real Chainlink proxy, moved by the proxy's own
/// owner (impersonated: the trigger is theirs, never a borrower's) to an aggregator of 18 decimals at the live price.
///   FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-contract StockVaultFeedDecimalsForkTest -vv
/// Without FORK_RPC every test is skipped. Nothing is sent to mainnet.
contract StockVaultFeedDecimalsForkTest is Test {
    StockVault constant VAULT = StockVault(0xbEcd07EC689988e16b870C121756C4c2C8cb02B6);
    CreditPoolV2 constant POOL = CreditPoolV2(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    address constant PROXY_ADMIN = 0x5174A18550a295cd25aF59416a56B7e4c38C8Afc;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    uint256 constant OWNER_PK = 0x3A63;
    address agentOwner = vm.addr(OWNER_PK);
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    function _skipUnlessForked() internal {
        if (!forked) vm.skip(true);
    }

    /// The feed's owner confirms an 18-decimal aggregator at the live price; its rounds then run 14 days, so the live
    /// guard's window has passed over the new phase. Returns the live 8-decimal price.
    function _moveSpyFeedTo18Decimals() internal returns (uint256 price8) {
        emit log_named_uint("fork block", block.number);
        (address feed,,, uint8 cached,,,) = VAULT.assets(SPY);
        assertEq(cached, 8);
        (, int256 answer,,,) = IPriceFeed(feed).latestRoundData();
        price8 = uint256(answer);
        Aggregator18 agg = new Aggregator18();
        uint256 t = block.timestamp; // kept here: via-IR may reuse block.timestamp across vm.warp in one function
        agg.push(answer * 1e10, t);
        address feedOwner = IChainlinkProxy(feed).owner();
        emit log_named_address("SPY feed proxy's owner", feedOwner);
        uint16 phase = IChainlinkProxy(feed).phaseId();
        vm.startPrank(feedOwner);
        IChainlinkProxy(feed).proposeAggregator(address(agg));
        IChainlinkProxy(feed).confirmAggregator(address(agg));
        vm.stopPrank();
        assertEq(IChainlinkProxy(feed).phaseId(), phase + 1);
        assertEq(IPriceFeed(feed).decimals(), 18, "the proxy answers in its new aggregator's decimals");
        assertEq(VAULT.lendStatus(SPY), VAULT.HOLD_PRICE_MOVED(), "the live window holds the new phase");
        t += 7 days;
        vm.warp(t);
        agg.push(answer * 1e10, t);
        t += 7 days + 1;
        vm.warp(t);
        agg.push(answer * 1e10, t);
        emit log_named_uint("guard jumpWindow (s)", VAULT.jumpWindow());
        assertEq(VAULT.lendStatus(SPY), 0, "14 days on, the window no longer holds it");
    }

    /// 0.0001 SPY (about $0.08) from a fresh agent: on the cached scale, worth $780 million.
    function _noLineOnTheCachedScale(uint256 price8) internal {
        uint256 dust = 1e14;
        IRegistryMintFork reg = IRegistryMintFork(address(POOL.registry()));
        vm.prank(agentOwner);
        uint256 id = reg.register("https://priors.trade/agents/pvr-rwj3.json");
        deal(SPY, agentOwner, dust);
        vm.prank(agentOwner);
        IERC20(SPY).approve(address(VAULT), dust);
        CreditPoolV2.Consent memory c = CreditPoolV2.Consent({
            agentId: id,
            sponsorId: VAULT.agentId(),
            owner: agentOwner,
            maxPremiumBps: 0,
            nonce: POOL.nonces(id),
            deadline: vm.getBlockTimestamp() + 1 hours // after the helper's warps
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, POOL.consentDigest(c));

        vm.prank(agentOwner);
        (bool opened, bytes memory ret) =
            address(VAULT).call(abi.encodeCall(StockVault.open, (id, SPY, dust, c, abi.encodePacked(r, s, v))));
        if (!opened) {
            assertEq(ret, abi.encodeWithSelector(StockVault.PriceUnavailable.selector, SPY), "refused for the price");
            return;
        }
        uint256 line = abi.decode(ret, (uint256));
        vm.prank(agentOwner);
        POOL.borrow(id, line, 7 days, agentOwner, type(uint256).max);
        emit log_named_uint("deposit's value at the live price (USDG, 6dp)", dust * price8 / 1e20);
        emit log_named_uint("line opened on the cached scale (USDG, 6dp)", line);
        emit log_named_uint("drawn (USDG, 6dp)", POOL.getAgent(id).principalOut);
        assertFalse(opened, "a line opened on the cached scale");
    }

    /// The deployed implementation (and the scheduled GHSA-jgwm one, the same code here): fails while it is live.
    function test_deployedVault_noLineOnTheCachedScale() public {
        _skipUnlessForked();
        _noLineOnTheCachedScale(_moveSpyFeedTo18Decimals());
    }

    /// The fixed source as the vault's implementation (the timelock's upgrade, run in-process).
    function _upgradeToTheFixedSource() internal {
        StockVault impl = new StockVault(POOL);
        vm.prank(IProxyAdminOf(PROXY_ADMIN).owner());
        IProxyAdminOf(PROXY_ADMIN).upgradeAndCall(address(VAULT), address(impl), "");
    }

    /// Nothing honest changes: with today's feeds, the fixed implementation prices and holds every listed token (the
    /// 35 stocks and PT-USDG, whose own feed's decimals are fixed) exactly as the deployed one.
    function test_fixedImplementation_pricesEveryLiveAssetAsBefore() public {
        _skipUnlessForked();
        address[] memory list = VAULT.assetList();
        bool[] memory oks = new bool[](list.length);
        uint256[] memory values = new uint256[](list.length);
        uint8[] memory holds = new uint8[](list.length);
        for (uint256 i; i < list.length; ++i) {
            (oks[i], values[i]) = VAULT.valueOf(list[i], 1e18);
            holds[i] = VAULT.lendStatus(list[i]);
        }
        _upgradeToTheFixedSource();
        _recordEveryFeed(list); // a new implementation's price tape starts empty (GHSA-7gq2-77ph-mw6j)
        uint256 changed;
        for (uint256 i; i < list.length; ++i) {
            (bool ok, uint256 value) = VAULT.valueOf(list[i], 1e18);
            uint8 hold = VAULT.lendStatus(list[i]);
            if (hold != holds[i]) {
                // only the price hold may change: it now compares every round of the window, not a sample of them
                assertTrue(hold <= 1 && holds[i] <= 1, "only the price hold changes");
                changed++;
                continue;
            }
            assertEq(ok, oks[i], "priced as before");
            assertEq(value, values[i], "the same value");
        }
        emit log_named_uint("listed tokens priced and held as before", list.length - changed);
        emit log_named_uint("price holds the full-window check changes", changed);
    }

    /// Records every listed feed on the vault's price tape (anyone may; the upgrade's runbook does it first).
    function _recordEveryFeed(address[] memory list) internal {
        StockVaultHolds h = VAULT.holds();
        for (uint256 i; i < list.length; ++i) {
            (address feed,,,,,,) = VAULT.assets(list[i]);
            h.record(feed, 10_000);
        }
    }

    /// The fixed source: no line, until the Safe's setAsset reads the feed again; then SPY is valued on the feed's
    /// scale.
    function test_fixedImplementation_refusesUntilTheSafeRereadsTheFeed() public {
        _skipUnlessForked();
        _upgradeToTheFixedSource();
        uint256 price8 = _moveSpyFeedTo18Decimals();
        _noLineOnTheCachedScale(price8);

        (address feed, uint64 maxAge,,, bool enabled, uint16 ltv, uint128 cap) = VAULT.assets(SPY);
        vm.prank(VAULT.owner());
        VAULT.setAsset(SPY, feed, maxAge, enabled, ltv, cap);
        (bool ok, uint256 value) = VAULT.valueOf(SPY, 1e18);
        assertTrue(ok);
        assertEq(value, price8 / 100, "one SPY at the live price, 6 decimals");
    }
}
