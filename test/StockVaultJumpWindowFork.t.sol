// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {StockVault, IPriceFeed} from "../src/StockVault.sol";

interface IJumpWindowProxyAdmin {
    function owner() external view returns (address);
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
}

interface IJumpWindowRegister {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

/// GHSA-7gq2-77ph-mw6j on live state, at the report's block (87,601,461, 2026-10-13 14:59:00 UTC): IONQ's feed answers
/// $35.00259999, and its round 325 back, $47.0365, published 83,038 s inside the 14-day window, is 25.58% away; the
/// walk read 1, 2, 4 … 256 and 512 (before the window) and lent. The vault's implementation is replaced in-process by
/// this copy's source (the timelock's upgrade), the feeds' price tapes are recorded (anyone may), and new credit is
/// compared with what SECURITY-v2's SV-1 states: a move over 25% against any round of the last 14 days.
///   FORK_RPC=<an archive endpoint> forge test --match-path test/StockVaultJumpWindowFork.t.sol -vv
/// Without FORK_RPC every test is skipped. Nothing is sent to mainnet.
contract StockVaultJumpWindowForkTest is Test {
    StockVault constant VAULT = StockVault(0xbEcd07EC689988e16b870C121756C4c2C8cb02B6);
    CreditPoolV2 constant POOL = CreditPoolV2(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    address constant PROXY_ADMIN = 0x5174A18550a295cd25aF59416a56B7e4c38C8Afc;
    address constant DEPLOYED = 0x02f0bF6259bDFef1Dad13D63b6D684c98596af5d; // the implementation at the block
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address constant IONQ = 0x558378E000D634A36593E338eBacdd6207640EfE;
    address constant IONQ_FEED = 0x22EfeC4919baf55F360E0EDee4AbEB26DE4971eb;
    uint256 constant REPORT_BLOCK = 87_601_461;
    uint80 constant LATEST_ROUND = 18_446_744_073_709_556_472;
    uint256 constant OWNER_PK = 0x7A42;
    address agentOwner = vm.addr(OWNER_PK);
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, REPORT_BLOCK);
        forked = true;
    }

    function _skipUnlessForked() internal {
        if (!forked) vm.skip(true);
    }

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(VAULT), IMPL_SLOT))));
    }

    /// The source as the vault's implementation (the timelock's upgrade, run in-process).
    function _upgradeToTheSource() internal {
        StockVault impl = new StockVault(POOL);
        vm.prank(IJumpWindowProxyAdmin(PROXY_ADMIN).owner());
        IJumpWindowProxyAdmin(PROXY_ADMIN).upgradeAndCall(address(VAULT), address(impl), "");
    }

    /// Records `feed` on the vault's price tape, in pages; a no-op on an implementation without a tape. Returns the gas.
    function _record(address feed) internal returns (uint256 used) {
        address holds = vm.computeCreateAddress(_impl(), 1); // the first contract the implementation created
        for (uint256 page; page < 20; page++) {
            uint256 g = gasleft();
            (bool ok, bytes memory r) =
                holds.call(abi.encodeWithSignature("record(address,uint256)", feed, uint256(1_000)));
            used += g - gasleft();
            if (!ok) return used;
            (uint80 latest,,,,) = IPriceFeed(feed).latestRoundData();
            if (abi.decode(r, (uint80)) == latest) return used;
        }
    }

    /// The stated rule, read from the feed itself, round by round: some round of the window is more than `bps` away
    /// from the latest answer, the window's first UTC day counted whole (as the tape counts it); also true for a phase
    /// younger than the window. `n`: the rounds read.
    function _statedRuleHolds(address feed, uint256 bps, uint256 window) internal view returns (bool held, uint256 n) {
        (uint80 id, int256 answer,,,) = IPriceFeed(feed).latestRoundData();
        uint256 dayOne = (block.timestamp - window) / 1 days * 1 days;
        uint256 p = uint256(answer);
        for (uint256 k = uint256(id) - 1;; k--) {
            (, int256 old,, uint256 at,) = IPriceFeed(feed).getRoundData(uint80(k));
            n++;
            if (at < dayOne) return (false, n);
            uint256 o = uint256(old);
            if ((p > o ? p - o : o - p) * 10_000 > o * bps) return (true, n);
            if (uint64(k) == 1) return (true, n);
        }
    }

    function _ionqLine(uint256 amount) internal returns (bool opened, bytes memory ret) {
        IJumpWindowRegister reg = IJumpWindowRegister(address(POOL.registry()));
        vm.prank(agentOwner);
        uint256 id = reg.register("https://priors.trade/agents/pvr-7gq2.json");
        deal(IONQ, agentOwner, amount);
        vm.prank(agentOwner);
        IERC20(IONQ).approve(address(VAULT), amount);
        CreditPoolV2.Consent memory c = CreditPoolV2.Consent({
            agentId: id,
            sponsorId: VAULT.agentId(),
            owner: agentOwner,
            maxPremiumBps: 0,
            nonce: POOL.nonces(id),
            deadline: vm.getBlockTimestamp() + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, POOL.consentDigest(c));
        vm.prank(agentOwner);
        (opened, ret) =
            address(VAULT).call(abi.encodeCall(StockVault.open, (id, IONQ, amount, c, abi.encodePacked(r, s, v))));
    }

    /// The report, read on the deployed vault: the round between the samples, and the vault lending through it.
    function test_deployedVault_reportBlock_lendsThroughARoundOfTheWindow() public {
        _skipUnlessForked();
        assertEq(_impl(), DEPLOYED, "0x02f0 at the report's block");
        (uint80 id, int256 latest,,,) = IPriceFeed(IONQ_FEED).latestRoundData();
        assertEq(id, LATEST_ROUND);
        uint256 since = block.timestamp - VAULT.jumpWindow();
        (, int256 a325,, uint256 t325,) = IPriceFeed(IONQ_FEED).getRoundData(id - 325);
        (, int256 a256,, uint256 t256,) = IPriceFeed(IONQ_FEED).getRoundData(id - 256);
        (, int256 a512,, uint256 t512,) = IPriceFeed(IONQ_FEED).getRoundData(id - 512);
        assertEq(t325 - since, 83_038, "offset 325: 83,038 s inside the window");
        assertGt(t256, since, "offset 256 inside the window");
        assertLe(t512, since, "offset 512 before it: the walk settles there");
        uint256 p = uint256(latest);
        assertGt((uint256(a325) - p) * 10_000, uint256(a325) * 2500, "offset 325: more than 25% away (25.58%)");
        assertLe((uint256(a256) - p) * 10_000, uint256(a256) * 2500, "offset 256: within 25% (20.5%)");
        assertLe((uint256(a512) - p) * 10_000, uint256(a512) * 2500, "offset 512: within 25% (21.7%)");
        assertEq(VAULT.lendStatus(IONQ), 0, "the deployed walk lends");
        (bool opened,) = _ionqLine((2_000e6 * 1e20 + p - 1) / p); // the report's 57.1386 IONQ, $2,000 at the feed
        assertTrue(opened, "and opens the report's $500 line");
    }

    /// The source: IONQ waits at the report's block, and the report's line is refused.
    function test_fixedImplementation_reportBlock_holdsIonq() public {
        _skipUnlessForked();
        _upgradeToTheSource();
        uint256 g = _record(IONQ_FEED);
        emit log_named_uint("record(IONQ feed): gas, the whole tape", g);
        assertEq(VAULT.lendStatus(IONQ), 1, "HOLD_PRICE_MOVED: offset 325 is 25.58% away, inside the window");
        (, int256 latest,,,) = IPriceFeed(IONQ_FEED).latestRoundData();
        uint256 p = uint256(latest);
        (bool opened, bytes memory ret) = _ionqLine((2_000e6 * 1e20 + p - 1) / p);
        assertFalse(opened, "no line");
        assertEq(ret, abi.encodeWithSelector(StockVault.LendingHeld.selector, IONQ, uint8(1)));
    }

    /// The source: the hold ends when offset 325's UTC day leaves the window (2026-10-15 00:00 UTC; the stated rule's
    /// own end is 2026-10-14 14:02:58 UTC, 23.07 h after the block), at the same price.
    function test_fixedImplementation_releasesIonqWhenTheRoundLeavesTheWindow() public {
        _skipUnlessForked();
        _upgradeToTheSource();
        _record(IONQ_FEED);
        (,,, uint256 t325,) = IPriceFeed(IONQ_FEED).getRoundData(LATEST_ROUND - 325);
        uint256 release = (t325 / 1 days + 1) * 1 days + 14 days;
        assertEq(release, 1_792_022_400, "2026-10-15 00:00:00 UTC");
        assertEq(VAULT.lendStatus(IONQ), 1);
        vm.warp(t325 + 14 days + 1); // past the stated rule's end: the tape still counts that day
        assertEq(VAULT.lendStatus(IONQ), 1, "held to the end of the round's UTC day");
        vm.warp(release);
        assertEq(VAULT.lendStatus(IONQ), 0, "released");
    }

    /// The source, every listed asset at the report's block: once its tape is recorded, its price hold is the stated
    /// rule's (with the window's first day whole), and a valuation stays inside the pool's hook gas.
    function test_fixedImplementation_everyAsset_holdsAsTheStatedRule_withinTheHookGas() public {
        _skipUnlessForked();
        _upgradeToTheSource();
        address[] memory list = VAULT.assetList();
        uint256 bps = VAULT.maxJumpBps();
        uint256 window = VAULT.jumpWindow();
        uint256 worst;
        uint256 heldCount;
        for (uint256 i; i < list.length; i++) {
            (address feed,,,,,,) = VAULT.assets(list[i]);
            uint256 g = _record(feed);
            uint8 why = VAULT.lendStatus(list[i]);
            (bool held, uint256 n) = _statedRuleHolds(feed, bps, window);
            emit log_named_uint(
                string.concat(vm.toString(list[i]), " hold*1e7 + rounds read by the rule"), uint256(why) * 1e7 + n
            );
            emit log_named_uint("  record gas", g);
            if (why == 0 || why == 1) assertEq(why == 1, held, "the price hold is the stated rule's");
            if (why == 1) heldCount++;
            vm.cool(address(VAULT));
            vm.cool(feed);
            vm.cool(vm.computeCreateAddress(_impl(), 1));
            uint256 g2 = gasleft();
            VAULT.valueOf(list[i], 1e18); // the price and every hold, as canBorrow runs them
            uint256 used = g2 - gasleft();
            if (used > worst) worst = used;
        }
        emit log_named_uint("assets held for the price", heldCount);
        emit log_named_uint("worst valuation gas (cold, tape current)", worst);
        assertLt(worst + 60_000, POOL.HOOK_GAS(), "the hook keeps room for the pool read and its own overhead");
    }

    /// The source: the whole borrow hook (canBorrow) from cold storage on a position backed by the busiest feed
    /// (CRCL), with its tape as far behind as a hold still reads live (7 rounds: 6 read from the feed, then the
    /// tape's days), stays under three quarters of the pool's hook gas, the bound StockVaultFork.t.sol sets.
    function test_fixedImplementation_canBorrowOnTheBusiestFeed_tapeBehind_withinTheHookGas() public {
        _skipUnlessForked();
        _upgradeToTheSource();
        address crcl = 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5;
        address feed = 0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a;
        _record(feed);
        assertEq(VAULT.lendStatus(crcl), 0, "CRCL lends at the report's block");
        IJumpWindowRegister reg = IJumpWindowRegister(address(POOL.registry()));
        vm.prank(agentOwner);
        uint256 id = reg.register("https://priors.trade/agents/pvr-7gq2-gas.json");
        (, int256 answer,,,) = IPriceFeed(feed).latestRoundData();
        uint256 amount = 40e6 * 1e20 / uint256(answer); // ~$40 of CRCL
        deal(crcl, agentOwner, amount);
        vm.prank(agentOwner);
        IERC20(crcl).approve(address(VAULT), amount);
        CreditPoolV2.Consent memory c = CreditPoolV2.Consent({
            agentId: id,
            sponsorId: VAULT.agentId(),
            owner: agentOwner,
            maxPremiumBps: 0,
            nonce: POOL.nonces(id),
            deadline: vm.getBlockTimestamp() + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, POOL.consentDigest(c));
        vm.prank(agentOwner);
        VAULT.open(id, crcl, amount, c, abi.encodePacked(r, s, v));
        // the tape 7 rounds behind the feed: tapes[feed] is the holds contract's first slot's mapping
        address holds = vm.computeCreateAddress(_impl(), 1);
        bytes32 slot = keccak256(abi.encode(feed, uint256(0)));
        uint256 word = uint256(vm.load(holds, slot));
        (uint80 latest,,,,) = IPriceFeed(feed).latestRoundData();
        assertEq(uint80(word), latest, "the tape is current");
        vm.store(holds, slot, bytes32((word >> 80 << 80) | (uint256(latest) - 7)));
        vm.cool(address(VAULT));
        vm.cool(_impl());
        vm.cool(holds);
        vm.cool(address(POOL));
        vm.cool(crcl);
        vm.cool(feed);
        (bool ok, bytes memory agg) = feed.staticcall(abi.encodeWithSignature("aggregator()"));
        if (ok && agg.length >= 32) vm.cool(abi.decode(agg, (address)));
        uint256 g = gasleft();
        bool allowed = VAULT.canBorrow(VAULT.agentId(), id, 5e6, 7 days, 0, agentOwner, agentOwner, agentOwner);
        uint256 used = g - gasleft();
        emit log_named_uint("canBorrow gas, cold, CRCL, tape 7 rounds behind", used);
        assertTrue(allowed, "the six rounds read live and the tape's days: no hold");
        assertLt(used, POOL.HOOK_GAS() * 3 / 4, "under three quarters of the pool's hook gas");
    }
}
