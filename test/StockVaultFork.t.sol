// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {StockVault, StockVaultHolds, IPriceFeed} from "../src/StockVault.sol";
import {deployStockVault} from "./StockVaultDeploy.sol";

interface IRegistryMint {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// The stock vault on live Robinhood Chain state: the real CreditPoolV2, ERC-8004 registry, USDG, and a real
/// Robinhood stock token (SPY) priced by its real Chainlink feed. Nothing is sent to mainnet: the vault is deployed on
/// the fork only.
///   FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/StockVaultFork.t.sol -vv
/// Without FORK_RPC every test is skipped (and says so).
contract StockVaultForkTest is Test {
    bytes32 constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    CreditPoolV2 constant POOL = CreditPoolV2(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C; // deployments/stock-assets.4663.json
    address constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    uint64 constant MAX_AGE = 4 days; // a weekend and a holiday at the last close (feeds update 24/5)

    StockVault vault;
    IERC20 usdg;
    IRegistryMint reg;
    uint256 vaultId;
    uint256 agent;
    uint256 constant OWNER_PK = 0xF0C4;
    address agentOwner = vm.addr(OWNER_PK);
    address treasury = makeAddr("treasury");
    address sink = makeAddr("sink");
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        usdg = POOL.usdg();
        reg = IRegistryMint(address(POOL.registry()));
        vault = deployStockVault(
            POOL,
            address(this),
            treasury,
            sink,
            StockVault.Params({ltvBps: 5000, maxLine: 250e6, epochCap: 1000e6, epochLength: 7 days}),
            address(this)
        );
        vault.setAsset(SPY, SPY_FEED, MAX_AGE, true, 5000, type(uint128).max);
        vault.holds().record(SPY_FEED, 10_000); // the price tape (GHSA-7gq2-77ph-mw6j): anyone records it
        vaultId = reg.register("https://priors.trade/agents/stock-vault-fork.json");
        reg.transferFrom(address(this), address(vault), vaultId);
        vault.adopt(vaultId);
        deal(address(usdg), address(this), 200e6);
        usdg.approve(address(vault), 200e6);
        vault.fund(200e6);

        vm.prank(agentOwner);
        agent = reg.register("https://priors.trade/agents/stock-fork-agent.json");
        deal(SPY, agentOwner, 1e18);
        vm.prank(agentOwner);
        IERC20(SPY).approve(address(vault), type(uint256).max);
    }

    /// The live registry mints with safeMint: this test contract receives the vault's identity before handing it over.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function _skipUnlessForked() internal {
        if (!forked) vm.skip(true);
    }

    function _consent() internal view returns (CreditPoolV2.Consent memory c, bytes memory sig) {
        c = CreditPoolV2.Consent({
            agentId: agent,
            sponsorId: vaultId,
            owner: agentOwner,
            maxPremiumBps: 0,
            nonce: POOL.nonces(agent),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, POOL.consentDigest(c));
        sig = abi.encodePacked(r, s, v);
    }

    /// Enough SPY for about `usd` of value at the live price.
    function _amountFor(uint256 usd) internal view returns (uint256 amount, uint256 price) {
        (, int256 answer,,,) = IPriceFeed(SPY_FEED).latestRoundData();
        price = uint256(answer);
        amount = usd * 1e20 / price; // value(6 dp) = amount(18 dp) * price(8 dp) / 1e20
    }

    function _open(uint256 amount) internal returns (uint256 line) {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent();
        vm.prank(agentOwner);
        line = vault.open(agent, SPY, amount, c, sig);
    }

    // Criteria 8a, 8b, 8c
    function test_fork_depositLiveSpy_lineIsHalfItsChainlinkValue_borrowToTheLine_oneMoreRefused() public {
        _skipUnlessForked();
        (uint256 amount, uint256 price) = _amountFor(24e6); // ~$24 of SPY
        uint256 value = amount * price / 1e20;
        uint256 line = _open(amount);

        // 8a: the vault holds the deposit and records it
        assertEq(IERC20(SPY).balanceOf(address(vault)), amount);
        assertEq(vault.getPosition(agent).amount, amount);
        // 8b: the line is 50% of the Chainlink value at deposit
        assertEq(line, value * 5000 / 10_000);
        assertEq(POOL.getAgent(agent).delegatedIn, line);
        emit log_named_decimal_uint("SPY price (USD)", price, 8);
        emit log_named_decimal_uint("deposit (SPY)", amount, 18);
        emit log_named_decimal_uint("line (USDG)", line, 6);

        // 8c: borrow the whole line, then one more USDG is refused
        uint256 before = usdg.balanceOf(agentOwner);
        vm.prank(agentOwner);
        POOL.borrow(agent, line, 7 days, agentOwner, type(uint256).max);
        assertEq(usdg.balanceOf(agentOwner) - before, line);
        vm.prank(agentOwner);
        vm.expectRevert();
        POOL.borrow(agent, 1e6, 7 days, agentOwner, type(uint256).max);
    }

    // Criterion 10
    function test_fork_defaultSeizesTheLiveSpy_neverBackToTheOwner() public {
        _skipUnlessForked();
        (uint256 amount,) = _amountFor(24e6);
        uint256 line = _open(amount);
        vm.prank(agentOwner);
        uint256 loanId = POOL.borrow(agent, line, 7 days, agentOwner, type(uint256).max);
        vm.warp(POOL.getLoan(loanId).defaultableAt + 1);
        POOL.markDefault(loanId);
        assertEq(uint256(vault.getPosition(agent).status), uint256(StockVault.Status.Seized));
        assertEq(IERC20(SPY).balanceOf(treasury), amount);
        assertEq(IERC20(SPY).balanceOf(agentOwner), 1e18 - amount);
        assertEq(vault.held(SPY), 0);
    }

    /// The lending holds (audit M1, M2) read every live stock token and feed: each answers a reason, and the whole
    /// valuation (price, holds, history walk) from cold storage stays well inside the pool's borrow-hook gas.
    function test_fork_lendingHolds_readEveryLiveToken_withinTheHookGas() public {
        _skipUnlessForked();
        string memory json = vm.readFile("deployments/stock-assets.4663.json");
        assertTrue(vm.keyExistsJson(json, ".assets[34]") && !vm.keyExistsJson(json, ".assets[35]"), "35 assets");
        uint256 worst;
        for (uint256 i; i < 35; i++) {
            string memory at = string.concat(".assets[", vm.toString(i), "]");
            address token = vm.parseJsonAddress(json, string.concat(at, ".token"));
            address feed = vm.parseJsonAddress(json, string.concat(at, ".feed"));
            vault.setAsset(token, feed, MAX_AGE, true, 5000, type(uint128).max);
            vault.holds().record(feed, 10_000);
            _cool(token, feed);
            uint256 g = gasleft();
            vault.valueOf(token, 1e18); // _valueOf and every hold, as canBorrow runs them
            uint256 used = g - gasleft();
            if (used > worst) worst = used;
            uint8 why = vault.lendStatus(token);
            assertLe(why, 4);
            emit log_named_uint(
                string.concat(vm.parseJsonString(json, string.concat(at, ".symbol")), " hold*1e6 + gas"),
                uint256(why) * 1e6 + used
            );
        }
        emit log_named_uint("worst valuation gas", worst);
        assertLt(worst + 60_000, POOL.HOOK_GAS(), "the hook keeps room for the pool read and its own overhead");
    }

    /// The whole borrow hook (canBorrow: the position, the price, every hold and the 14-day history walk, the pool's
    /// agent read) from cold storage, on a position backed by the busiest live feed (CRCL: 650 rounds in the 14 days to
    /// 2026-09-28), stays inside the pool's HOOK_GAS with room to spare.
    function test_fork_canBorrow_onTheBusiestFeed_withinTheHookGas() public {
        _skipUnlessForked();
        string memory json = vm.readFile("deployments/stock-assets.4663.json");
        address token;
        address feed;
        for (uint256 i; i < 35; i++) {
            string memory at = string.concat(".assets[", vm.toString(i), "]");
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(at, ".symbol")))) == keccak256("CRCL")) {
                token = vm.parseJsonAddress(json, string.concat(at, ".token"));
                feed = vm.parseJsonAddress(json, string.concat(at, ".feed"));
            }
        }
        assertTrue(token != address(0), "CRCL is in the asset file");
        vault.setAsset(token, feed, MAX_AGE, true, 5000, type(uint128).max);
        vault.holds().record(feed, 10_000);
        // the launch's record bonus (deployments/stock-ltv.4663.json): canBorrow reads the pool's fee ledger per root
        string memory ltv = vm.readFile("deployments/stock-ltv.4663.json");
        vault.setRecordBonus(
            vm.parseJsonUintArray(ltv, ".recordBonus.trustedRoots"),
            vm.parseJsonUint(ltv, ".recordBonus.feeStep"),
            uint16(vm.parseJsonUint(ltv, ".recordBonus.bpsPerStep")),
            uint16(vm.parseJsonUint(ltv, ".recordBonus.maxBonusBps"))
        );
        (, int256 answer,,,) = IPriceFeed(feed).latestRoundData();
        uint256 amount = 40e6 * 1e20 / uint256(answer); // ~$40 of CRCL: a $20 line
        deal(token, agentOwner, amount);
        vm.prank(agentOwner);
        IERC20(token).approve(address(vault), type(uint256).max);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent();
        vm.prank(agentOwner);
        vault.open(agent, token, amount, c, sig);
        _cool(token, feed);
        vm.cool(address(vault));
        vm.cool(address(uint160(uint256(vm.load(address(vault), IMPLEMENTATION_SLOT))))); // the proxy's code too
        vm.cool(address(POOL));
        uint256 g = gasleft();
        bool allowed = vault.canBorrow(vaultId, agent, 5e6, 7 days, 0, agentOwner, agentOwner, agentOwner);
        uint256 used = g - gasleft();
        emit log_named_uint("canBorrow gas, cold, CRCL", used);
        emit log_named_uint("CRCL hold", vault.lendStatus(token));
        assertTrue(allowed || vault.lendStatus(token) != 0, "allowed unless a hold applies");
        assertLt(used, POOL.HOOK_GAS() * 3 / 4, "under three quarters of the pool's hook gas");
    }

    function _cool(address token, address feed) internal {
        vm.cool(token);
        vm.cool(feed);
        vm.cool(address(vault.holds())); // its price tape too
        (bool ok, bytes memory r) = feed.staticcall(abi.encodeWithSignature("aggregator()"));
        if (ok && r.length >= 32) vm.cool(abi.decode(r, (address)));
        (ok, r) = token.staticcall(abi.encodeWithSignature("ACCESS_CONTROLLED_REGISTRY()"));
        if (ok && r.length >= 32) {
            address reg = abi.decode(r, (address));
            vm.cool(reg);
            (ok, r) = reg.staticcall(abi.encodeWithSignature("implementation()"));
            if (ok && r.length >= 32) vm.cool(abi.decode(r, (address)));
        }
    }

    // Criterion 9a on live data: past MAX_AGE the live feed's last round is refused
    function test_fork_theLivePriceIsRefusedOnceOlderThanMaxAge() public {
        _skipUnlessForked();
        (uint256 amount,) = _amountFor(24e6);
        _open(amount);
        (,,, uint256 updatedAt,) = IPriceFeed(SPY_FEED).latestRoundData();
        vm.warp(updatedAt + MAX_AGE + 1);
        vm.prank(agentOwner);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, vaultId));
        POOL.borrow(agent, 5e6, 7 days, agentOwner, type(uint256).max);
    }
}
