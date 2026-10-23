// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {StockVault, StockVaultHolds} from "../src/StockVault.sol";
import {PtLinearDiscountFeed} from "../src/PtLinearDiscountFeed.sol";

/// GHSA-3vg6-2f3m-j5qm on the live vault, its live PT-USDG feed and its live ProxyAdmin, forked at block 95,334,277
/// (2026-10-22 18:54:14 UTC: implementation 0xd30396…2c72, the feed at round 393, its tape current):
///   FORK_RPC=<archive RPC> forge test --match-path test/StockVault3vg6Fork.t.sol -vv
/// The feed is pushed at its live pace (one round an hour, anyone may) to round 2,048, the keeper recording the live
/// tape every 12 rounds; then this tree's StockVault is deployed as a new implementation and put live through the
/// timelock, and its new tape recorded, as an upgrade does. Skipped without FORK_RPC.
contract StockVault3vg6ForkTest is Test {
    StockVault constant VAULT = StockVault(0xbEcd07EC689988e16b870C121756C4c2C8cb02B6);
    CreditPoolV2 constant POOL = CreditPoolV2(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    PtLinearDiscountFeed constant FEED = PtLinearDiscountFeed(0x95961f54F9c8a29A1393ADB5719053C98914B259);
    address constant PT = 0x6982e39521A070a3C40782548bfBED6Dc8F566ef;
    ProxyAdmin constant ADMIN = ProxyAdmin(0x5174A18550a295cd25aF59416a56B7e4c38C8Afc);
    address constant TIMELOCK = 0x5d984C274035F81BB327d532897a902C5125F87c;
    address constant LIVE_IMPL = 0xd30396A79D6b5BDB86D09B8c7907aD2820a42c72;
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 constant RECORDED = keccak256("Recorded(address,uint80,uint80)");
    uint256 constant FORK_BLOCK = 95_334_277;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, FORK_BLOCK);
        forked = true;
    }

    function _record() internal returns (uint256 from) {
        vm.recordLogs();
        VAULT.holds().record(address(FEED), 10_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == RECORDED) (from,) = abi.decode(logs[i].data, (uint80, uint80));
        }
    }

    /// The first round the feed serves published after `cut`, walking down from its latest (not the tape's search).
    function _firstAfter(uint256 cut) internal view returns (uint256 first) {
        for (uint256 id = FEED.latestRound(); id >= 1; --id) {
            try FEED.getRoundData(uint80(id)) returns (uint80, int256, uint256, uint256 at, uint80) {
                if (at <= cut) break;
                first = id;
            } catch {
                break;
            }
        }
    }

    function test_fork_ptFeedPastTwoRings_upgrade_newTapeBeginsAtTheCut_andPtLends() public {
        if (!forked) vm.skip(true);
        assertEq(address(uint160(uint256(vm.load(address(VAULT), IMPL_SLOT)))), LIVE_IMPL, "the fork is the live vault");
        assertEq(FEED.latestRound(), 393);
        assertEq(VAULT.lendStatus(PT), 0, "PT credit lends today");
        while (FEED.latestRound() < 2048) {
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            FEED.push();
            if (FEED.latestRound() % 12 == 0) VAULT.holds().record(address(FEED), 10_000); // the keeper
        }
        VAULT.holds().record(address(FEED), 10_000);
        vm.expectRevert(abi.encodeWithSelector(PtLinearDiscountFeed.NoRound.selector, uint80(1024)));
        FEED.getRoundData(1024);
        assertEq(VAULT.lendStatus(PT), 0, "the live tape, recorded all along: no hold");

        StockVault impl = new StockVault(POOL); // this tree's source
        vm.prank(TIMELOCK);
        ADMIN.upgradeAndCall(ITransparentUpgradeableProxy(address(VAULT)), address(impl), "");
        uint256 first = _firstAfter(vm.getBlockTimestamp() - 20 days);
        uint256 from = _record(); // the new holds' tape
        emit log_named_uint("new tape from", from);
        emit log_named_uint("first round of the last 20 days", first);
        (, uint48 phaseBegan) = VAULT.holds().tapes(address(FEED));
        emit log_named_uint("phaseBegan", phaseBegan);
        assertEq(from, first, "the new tape begins at the first round of the last 20 days");
        assertEq(phaseBegan, 0, "a feed 85 days old is not a phase begun now");
        assertEq(VAULT.lendStatus(PT), 0, "nothing moved: PT credit still lends");
        (bool ok,) = VAULT.valueOf(PT, 1e6);
        assertTrue(ok, "PT priced for new credit");
    }
}
