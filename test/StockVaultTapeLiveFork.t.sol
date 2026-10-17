// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {StockVault, IPriceFeed} from "../src/StockVault.sol";

interface ITapeHolds {
    function tapes(address feed) external view returns (uint80 through, uint48 phaseBegan);
}

interface ITapeRegister {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

/// The live vault once the price tape's upgrade has landed (GHSA-7gq2-77ph-mw6j; sim/tape-upgrade.mjs): what the
/// rehearsal checks on its upgraded anvil fork, and what stays a live check on mainnet after the execute. Before the
/// upgrade it fails ("the vault runs no price tape yet").
///   FORK_RPC=<an RPC of the upgraded chain> forge test --match-path test/StockVaultTapeLiveFork.t.sol -vv
/// Without FORK_RPC every test is skipped. Nothing is sent: the opens and loans run in Forge's in-process fork.
contract StockVaultTapeLiveForkTest is Test {
    StockVault constant VAULT = StockVault(0xbEcd07EC689988e16b870C121756C4c2C8cb02B6);
    CreditPoolV2 constant POOL = CreditPoolV2(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant CRCL = 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5;
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 constant OWNER_PK = 0x7A43;
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

    function _holds() internal view returns (address h) {
        (bool ok, bytes memory r) = address(VAULT).staticcall(abi.encodeWithSignature("holds()"));
        require(ok && r.length == 32, "the vault runs no price tape yet");
        h = abi.decode(r, (address));
    }

    /// The vault's holds is its implementation's StockVaultHolds, and every listed feed's tape lends (at most 7 rounds
    /// behind its feed: 6 read live).
    function test_live_holdsIsTheTape_andEveryTapeFresh() public {
        _skipUnlessForked();
        address h = _holds();
        address impl = address(uint160(uint256(vm.load(address(VAULT), IMPL_SLOT))));
        assertEq(h, vm.computeCreateAddress(impl, 1), "holds is the implementation's first contract");
        address[] memory list = VAULT.assetList();
        uint256 worst;
        for (uint256 i; i < list.length; i++) {
            (address feed,,,,,,) = VAULT.assets(list[i]);
            (uint80 latest,,,,) = IPriceFeed(feed).latestRoundData();
            (uint80 through,) = ITapeHolds(h).tapes(feed);
            assertEq(uint256(through) >> 64, uint256(latest) >> 64, "the tape is the feed's phase");
            assertLe(through, latest);
            uint256 behind = latest - through;
            if (behind > worst) worst = behind;
            assertLe(behind, 7, "a tape at most 7 rounds behind its feed");
        }
        emit log_named_uint("listed feeds", list.length);
        emit log_named_uint("the furthest tape behind its feed (rounds)", worst);
    }

    /// Every listed token's price hold is the rule SV-1 states, read round by round from its feed (the window's first
    /// UTC day whole; a phase younger than the window holds), wherever no token-level hold decides first.
    function test_live_priceHoldIsTheStatedRule_onEveryToken() public {
        _skipUnlessForked();
        _holds();
        address[] memory list = VAULT.assetList();
        uint256 bps = VAULT.maxJumpBps();
        uint256 window = VAULT.jumpWindow();
        uint256 held;
        uint256 checked;
        for (uint256 i; i < list.length; i++) {
            uint8 why = VAULT.lendStatus(list[i]);
            if (why > 1) continue;
            (address feed,,,,,,) = VAULT.assets(list[i]);
            bool rule = _statedRule(feed, bps, window);
            assertEq(why == 1, rule, "the price hold is the stated rule's");
            checked++;
            if (why == 1) held++;
        }
        emit log_named_uint("tokens checked", checked);
        emit log_named_uint("held for the price", held);
    }

    function _statedRule(address feed, uint256 bps, uint256 window) internal view returns (bool) {
        (uint80 id, int256 answer,,,) = IPriceFeed(feed).latestRoundData();
        uint256 since = block.timestamp > window ? block.timestamp - window : 0;
        uint256 dayOne = since / 1 days * 1 days;
        uint256 p = uint256(answer);
        if (uint64(id) == 1) return true;
        for (uint256 k = uint256(id) - 1;; k--) {
            (, int256 old,, uint256 at,) = IPriceFeed(feed).getRoundData(uint80(k));
            if (old <= 0 || at == 0) return true;
            if (window == 0) return _moved(p, uint256(old), bps);
            if (at < dayOne) return false;
            if (_moved(p, uint256(old), bps)) return true;
            if (uint64(k) == 1) return at > since;
        }
    }

    function _moved(uint256 p, uint256 o, uint256 bps) internal pure returns (bool) {
        return (p > o ? p - o : o - p) * 10_000 > o * bps;
    }

    /// A line on SPY and on CRCL (the busiest feed), each from a fresh agent, and a loan on it: the borrow hook
    /// (canBorrow) from cold storage stays under three quarters of the pool's hook gas, and the pool lends.
    function test_live_openAndBorrow_withinTheHookGas() public {
        _skipUnlessForked();
        address h = _holds();
        address[2] memory tokens = [SPY, CRCL];
        uint256 lent;
        for (uint256 i; i < 2; i++) {
            if (VAULT.lendStatus(tokens[i]) != 0) continue; // a hold today: nothing to measure on it
            (uint256 id, uint256 line) = _open(tokens[i], i);
            vm.cool(address(VAULT));
            vm.cool(address(uint160(uint256(vm.load(address(VAULT), IMPL_SLOT)))));
            vm.cool(h);
            vm.cool(address(POOL));
            vm.cool(tokens[i]);
            (address feed,,,,,,) = VAULT.assets(tokens[i]);
            vm.cool(feed);
            (bool ok, bytes memory agg) = feed.staticcall(abi.encodeWithSignature("aggregator()"));
            if (ok && agg.length >= 32) vm.cool(abi.decode(agg, (address)));
            uint256 g = gasleft();
            bool allowed = VAULT.canBorrow(VAULT.agentId(), id, line, 7 days, 0, agentOwner, agentOwner, agentOwner);
            uint256 used = g - gasleft();
            emit log_named_uint(i == 0 ? "canBorrow gas, cold, SPY" : "canBorrow gas, cold, CRCL", used);
            assertTrue(allowed, "the hook lends on a fresh tape");
            assertLt(used, POOL.HOOK_GAS() * 3 / 4, "under three quarters of the pool's hook gas");
            uint256 before = POOL.usdg().balanceOf(agentOwner);
            vm.prank(agentOwner);
            POOL.borrow(id, line, 7 days, agentOwner, type(uint256).max);
            assertEq(POOL.usdg().balanceOf(agentOwner) - before, line, "the pool lent the line");
            lent++;
        }
        assertGt(lent, 0, "at least one of SPY and CRCL lends today");
    }

    function _open(address token, uint256 salt) internal returns (uint256 id, uint256 line) {
        ITapeRegister reg = ITapeRegister(address(POOL.registry()));
        vm.prank(agentOwner);
        id = reg.register(string.concat("https://priors.trade/agents/tape-live-", vm.toString(salt), ".json"));
        (address feed,,,,,,) = VAULT.assets(token);
        (, int256 answer,,,) = IPriceFeed(feed).latestRoundData();
        uint256 amount = 40e6 * 1e20 / uint256(answer); // ~$40
        deal(token, agentOwner, amount);
        vm.prank(agentOwner);
        IERC20(token).approve(address(VAULT), amount);
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
        line = VAULT.open(id, token, amount, c, abi.encodePacked(r, s, v));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
