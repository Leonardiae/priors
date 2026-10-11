// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {StockVault, IPriceFeed} from "../src/StockVault.sol";
import {StockVaultBase, MockStock} from "./StockVault.t.sol";

/// A stock token's implementation as its beacon serves it: the test token's storage and functions, answering the
/// precision built into this implementation (a constant in the code, as the live implementation's `decimals()` is).
contract StockTokenImpl is MockStock {
    uint8 internal immutable _precision;

    constructor(uint8 d) MockStock("") {
        _precision = d;
    }

    function decimals() public view override returns (uint8) {
        return _precision;
    }
}

/// An implementation whose `decimals()` cannot be read.
contract StockTokenImplNoDecimals is MockStock {
    constructor() MockStock("") {}

    function decimals() public pure override returns (uint8) {
        revert("no decimals");
    }
}

/// Implementations whose `decimals()` answers in a way a plain call would mis-read (the audits of the fix, 2026-10-11):
/// mode 1, the cached 18 followed by 64 KB (a high-level call takes the first word and pays to copy the rest); mode 2, a
/// word above 255 (a high-level call reverts decoding it); mode 3, one byte; mode 4, a loop that burns every unit of gas.
contract StockTokenImplHostile is MockStock {
    uint8 internal immutable _mode;

    constructor(uint8 m) MockStock("") {
        _mode = m;
    }

    function decimals() public view override returns (uint8) {
        uint8 m = _mode;
        assembly {
            if eq(m, 1) {
                mstore(0, 18)
                return(0, 65536)
            }
            if eq(m, 2) {
                mstore(0, 256)
                return(0, 32)
            }
            if eq(m, 3) {
                mstore8(0, 18)
                return(0, 1)
            }
            for {} 1 {} {}
        }
        return 18;
    }
}

/// GHSA-855q-24q2-qwph (and GHSA-f53r-79xm-679j, the same cause): `setAsset` reads the token's decimals once, and the
/// vault priced every later amount on that scale. The 35 stock tokens are beacon proxies of one beacon: an issuer who
/// points it at an implementation of another precision made the vault value collateral 10^(new - old) times too high
/// (18 to 24: 10^6), at once and with no hold to catch it (the feed does not move). Now a token that answers in other
/// decimals than `setAsset` read, or whose decimals cannot be read, prices nothing for new credit until the owner's
/// `setAsset` reads it again, as a feed does since GHSA-rwj3. Repaying, closing and settling never read a price.
contract StockVaultTokenDecimalsLocalTest is StockVaultBase {
    UpgradeableBeacon beacon;
    address issuer = makeAddr("issuer");
    uint64 constant MAX_AGE = 1 days + 1 hours;
    uint128 constant LINE_CAP = uint128(1000 * USDC);

    function setUp() public override {
        super.setUp();
        beacon = new UpgradeableBeacon(address(new StockTokenImpl(18)), issuer);
        spy = MockStock(address(new BeaconProxy(address(beacon), "")));
        vm.prank(owner);
        vault.setAsset(address(spy), address(spyFeed), MAX_AGE, true, 5000, LINE_CAP);
        spy.mint(agentOp, 10 * SHARE);
        spy.mint(agentOp2, 10 * SHARE);
        vm.prank(agentOp);
        spy.approve(address(vault), type(uint256).max);
        vm.prank(agentOp2);
        spy.approve(address(vault), type(uint256).max);
    }

    /// The issuer's beacon upgrade: every token of the beacon answers the new implementation at once, balances untouched.
    function _issuerUpgrade(address impl) internal {
        vm.prank(issuer);
        beacon.upgradeTo(impl);
    }

    function _openRefusedForThePrice(uint256 id, uint256 pk, uint256 amount) internal {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(id, pk);
        vm.prank(vm.addr(pk));
        vm.expectRevert(abi.encodeWithSelector(StockVault.PriceUnavailable.selector, address(spy)));
        vault.open(id, address(spy), amount, c, sig);
    }

    /// The reports: the token moves to 24 decimals. 2e17 raw, 0.2 SPY ($120) on the old scale, is 0.0000002 SPY
    /// ($0.00012) now; the cached scale read it as $120 and opened a $60 line. No hold applies: the feed did not move.
    function test_tokenDecimalsUp_noLineOnTheCachedScale() public {
        _issuerUpgrade(address(new StockTokenImpl(24)));
        assertEq(spy.decimals(), 24);
        assertEq(vault.lendStatus(address(spy)), 0, "no hold: the feed did not move");
        (bool ok, uint256 value) = vault.valueOf(address(spy), SHARE / 5);
        assertFalse(ok, "no value on the scale setAsset read");
        assertEq(value, 0);
        _openRefusedForThePrice(AGENT, AGENT_PK, SHARE / 5);
    }

    /// A position opened before the change: every new loan asks canBorrow, which priced the collateral on the cached
    /// scale too. 0.2 SPY opened a $60 line; after the upgrade the same raw amount is worth $0.00012. Nothing is drawn.
    function test_tokenDecimalsUp_openPosition_noLoanPastItsLtv() public {
        assertEq(_open(AGENT_PK, AGENT, SHARE / 5), 60 * USDC);
        _issuerUpgrade(address(new StockTokenImpl(24)));
        assertEq(vault.borrowRoom(AGENT), 0, "nothing to draw on the cached scale");
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 60 * USDC, 7 days, agentOp, type(uint256).max);
    }

    /// Fewer decimals would understate the deposit (no loss, but a wrong price): refused the same way.
    function test_tokenDecimalsDown_refusedNotUnderstated() public {
        _issuerUpgrade(address(new StockTokenImpl(6)));
        (bool ok,) = vault.valueOf(address(spy), SHARE);
        assertFalse(ok, "fewer decimals: refused, not understated");
        _openRefusedForThePrice(AGENT, AGENT_PK, SHARE);
    }

    /// A token whose decimals cannot be read is not priced: its scale cannot be checked.
    function test_unreadableTokenDecimals_refused() public {
        _issuerUpgrade(address(new StockTokenImplNoDecimals()));
        (bool ok,) = vault.valueOf(address(spy), SHARE);
        assertFalse(ok, "decimals unreadable: refused");
        _openRefusedForThePrice(AGENT, AGENT_PK, SHARE);
    }

    /// A `decimals()` that answers anything but exactly one word of at most 255, or does not answer within the read's
    /// budget, is refused as unreadable: never read as its first word, never a revert, never the borrow hook's whole
    /// budget. Each mode on its own: valueOf says no, and a loan on a position opened before refuses as the backer's
    /// (`BorrowBlockedByBacker`, not `HookStarved`).
    function test_hostileTokenDecimals_refusedNotMisread() public {
        assertEq(_open(AGENT_PK, AGENT, SHARE / 5), 60 * USDC);
        for (uint8 m = 1; m <= 4; m++) {
            uint256 snap = vm.snapshotState();
            _issuerUpgrade(address(new StockTokenImplHostile(m)));
            (bool ok, uint256 value) = vault.valueOf(address(spy), SHARE / 5);
            assertFalse(ok, string.concat("mode ", vm.toString(m), ": refused"));
            assertEq(value, 0);
            assertFalse(
                vault.canBorrow(VAULT_ID, AGENT, 5 * USDC, 7 days, 0, agentOp, agentOp, agentOp), "canBorrow says no"
            );
            vm.prank(agentOp);
            vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
            pool.borrow(AGENT, 5 * USDC, 7 days, agentOp, type(uint256).max);
            vm.revertToState(snap);
        }
    }

    /// The way back is the owner's: `setAsset` with the same feed (allowed while tokens are held) reads the token
    /// again. Amounts are then valued on the token's new scale: the open position's 2e17 raw is $0.00012, a dust deposit
    /// opens no line, and 0.2 SPY on the new scale (2e23 raw) opens the $60 line it always did.
    function test_ownerRereadsTheToken_valuesOnTheNewScale() public {
        assertEq(_open(AGENT_PK, AGENT, SHARE / 5), 60 * USDC);
        _issuerUpgrade(address(new StockTokenImpl(24)));

        vm.prank(owner);
        vault.setAsset(address(spy), address(spyFeed), MAX_AGE, true, 5000, LINE_CAP);
        (,, uint8 cached,,,,) = vault.assets(address(spy));
        assertEq(cached, 24);
        (bool ok, uint256 value) = vault.valueOf(address(spy), SHARE / 5);
        assertTrue(ok);
        assertEq(value, 120, "0.0000002 SPY at $600: 120 units of 6-decimal USDG");
        assertEq(vault.borrowRoom(AGENT), 60, "the open position draws within its LTV of that");

        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT2, AGENT2_PK);
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(StockVault.LineTooSmall.selector, 60, 5 * USDC));
        vault.open(AGENT2, address(spy), SHARE / 5, c, sig);
        spy.mint(agentOp2, 2e23);
        assertEq(_open(AGENT2_PK, AGENT2, 2e23), 60 * USDC, "0.2 SPY on the new scale");
    }

    /// Control: an upgrade that keeps 18 decimals lends as before.
    function test_tokenUpgradeSameDecimals_lendsAsBefore() public {
        _issuerUpgrade(address(new StockTokenImpl(18)));
        (bool ok, uint256 value) = vault.valueOf(address(spy), SHARE / 5);
        assertTrue(ok);
        assertEq(value, 120 * USDC);
        assertEq(_open(AGENT_PK, AGENT, SHARE / 5), 60 * USDC);
    }

    /// Control: repaying and closing read no price, so a changed precision never traps a depositor's tokens.
    function test_tokenDecimalsChanged_repayAndCloseStillWork() public {
        _open(AGENT_PK, AGENT, SHARE / 5);
        uint256 loanId = _borrow(agentOp, AGENT, 50 * USDC);
        _issuerUpgrade(address(new StockTokenImpl(24)));
        vm.prank(agentOp);
        vault.close(AGENT);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE, "every token back");
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
    }

    /// Control: a default still seizes the whole deposit after a change of precision.
    function test_tokenDecimalsChanged_aDefaultStillSeizes() public {
        _open(AGENT_PK, AGENT, SHARE / 5);
        uint256 loanId = _borrow(agentOp, AGENT, 50 * USDC);
        _issuerUpgrade(address(new StockTokenImpl(24)));
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        pool.markDefault(loanId);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Seized));
        assertEq(spy.balanceOf(treasury), SHARE / 5);
        assertEq(vault.held(address(spy)), 0);
    }
}

/// The live stock tokens' shared beacon: `upgradeTo` is gated by BEACON_UPGRADER_ROLE.
interface IStockTokenBeacon {
    function implementation() external view returns (address);
    function upgradeTo(address newImplementation) external;
    function hasRole(bytes32 role, address account) external view returns (bool);
}

interface IStockVaultProxyAdmin {
    function owner() external view returns (address);
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
}

interface IIdentityRegister {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

/// The same on live state: the deployed vault, the real SPY token and its real beacon, upgraded by the account that
/// holds the beacon's BEACON_UPGRADER_ROLE (impersonated: the trigger is the issuer's, never a borrower's) to the live
/// implementation with its one `decimals()` constant changed, the successor a re-denomination would install.
///   FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-contract StockVaultTokenDecimalsForkTest -vv
/// Without FORK_RPC every test is skipped. Nothing is sent to mainnet.
contract StockVaultTokenDecimalsForkTest is Test {
    StockVault constant VAULT = StockVault(0xbEcd07EC689988e16b870C121756C4c2C8cb02B6);
    CreditPoolV2 constant POOL = CreditPoolV2(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    address constant PROXY_ADMIN = 0x5174A18550a295cd25aF59416a56B7e4c38C8Afc;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    IStockTokenBeacon constant BEACON = IStockTokenBeacon(0xe10b6f6B275de231345c20D14Ab812db62151b00);
    address constant UPGRADER = 0xCd8C6182e7C6Ca3B5156D6a90a67719d7e2Be094; // BEACON_UPGRADER_ROLE, read 2026-10-11
    bytes32 constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    uint256 constant OWNER_PK = 0x7D3C;
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

    function _spyPrice() internal view returns (uint256) {
        (address feed,,,,,,) = VAULT.assets(SPY);
        (, int256 answer,,,) = IPriceFeed(feed).latestRoundData();
        return uint256(answer);
    }

    /// The issuer's upgrade: the live implementation's code with its `decimals()` constant (18) set to `d`, installed on
    /// the shared beacon by the role holder. Storage stays in the proxies: balances are untouched.
    function _issuerMovesTheStockTokensTo(uint8 d) internal {
        emit log_named_uint("fork block", block.number);
        assertEq(address(uint160(uint256(vm.load(SPY, BEACON_SLOT)))), address(BEACON), "SPY is a proxy of the beacon");
        assertTrue(BEACON.hasRole(keccak256("BEACON_UPGRADER_ROLE"), UPGRADER), "the upgrader holds its role");
        (,, uint8 cached,,,,) = VAULT.assets(SPY);
        assertEq(cached, 18, "setAsset read 18");
        assertEq(IERC20Metadata(SPY).decimals(), 18);
        uint256 supply = IERC20(SPY).totalSupply();
        bytes memory code = BEACON.implementation().code;
        // decimals(): PUSH1 0x40 MLOAD PUSH1 0x12 DUP2 MSTORE ... (returns the constant 18)
        bytes memory pat = hex"60405160128152";
        uint256 hits;
        for (uint256 i; i + pat.length <= code.length; ++i) {
            bool hit = true;
            for (uint256 j; j < pat.length; ++j) {
                if (code[i + j] != pat[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) {
                code[i + 4] = bytes1(d);
                hits += 1;
            }
        }
        assertEq(hits, 1, "one decimals() constant in the live implementation");
        address successor = makeAddr("stockTokenImplRedenominated");
        vm.etch(successor, code);
        vm.prank(UPGRADER);
        BEACON.upgradeTo(successor);
        assertEq(BEACON.implementation(), successor);
        assertEq(IERC20Metadata(SPY).decimals(), d, "SPY answers the successor's decimals");
        assertEq(IERC20(SPY).totalSupply(), supply, "balances untouched");
    }

    /// 1e20 raw from a fresh agent: 100 SPY on the old scale, 0.0001 SPY (about $0.08) on 24 decimals.
    function _noLineOnTheCachedTokenScale(uint256 price8) internal {
        uint256 dust = 1e20;
        IIdentityRegister reg = IIdentityRegister(address(POOL.registry()));
        vm.prank(agentOwner);
        uint256 id = reg.register("https://priors.trade/agents/pvr-token-decimals.json");
        deal(SPY, agentOwner, dust);
        vm.prank(agentOwner);
        IERC20(SPY).approve(address(VAULT), dust);
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
        (bool opened, bytes memory ret) =
            address(VAULT).call(abi.encodeCall(StockVault.open, (id, SPY, dust, c, abi.encodePacked(r, s, v))));
        if (!opened) {
            assertEq(ret, abi.encodeWithSelector(StockVault.PriceUnavailable.selector, SPY), "refused for the price");
            return;
        }
        uint256 line = abi.decode(ret, (uint256));
        vm.prank(agentOwner);
        POOL.borrow(id, line, 7 days, agentOwner, type(uint256).max);
        emit log_named_uint("deposit's value at the live price (USDG, 6dp)", dust * price8 / 1e26);
        emit log_named_uint("line opened on the cached token scale (USDG, 6dp)", line);
        emit log_named_uint("drawn (USDG, 6dp)", POOL.getAgent(id).principalOut);
        assertFalse(opened, "a line opened on the cached token scale");
    }

    /// The deployed implementation: fails while it is live.
    function test_deployedVault_noLineOnTheCachedTokenScale() public {
        _skipUnlessForked();
        uint256 price8 = _spyPrice();
        _issuerMovesTheStockTokensTo(24);
        assertEq(VAULT.lendStatus(SPY), 0, "no hold catches it: the feed did not move");
        _noLineOnTheCachedTokenScale(price8);
    }

    /// The source as the vault's implementation (the timelock's upgrade, run in-process).
    function _upgradeToTheSource() internal {
        StockVault impl = new StockVault(POOL);
        vm.prank(IStockVaultProxyAdmin(PROXY_ADMIN).owner());
        IStockVaultProxyAdmin(PROXY_ADMIN).upgradeAndCall(address(VAULT), address(impl), "");
    }

    /// The source: no line, until the Safe's setAsset reads the token again; then SPY is valued on its new scale.
    function test_fixedImplementation_refusesUntilTheSafeRereadsTheToken() public {
        _skipUnlessForked();
        _upgradeToTheSource();
        uint256 price8 = _spyPrice();
        _issuerMovesTheStockTokensTo(24);
        _noLineOnTheCachedTokenScale(price8);

        (address feed, uint64 maxAge,,, bool enabled, uint16 ltv, uint128 cap) = VAULT.assets(SPY);
        vm.prank(VAULT.owner());
        VAULT.setAsset(SPY, feed, maxAge, enabled, ltv, cap);
        (,, uint8 cached,,,,) = VAULT.assets(SPY);
        assertEq(cached, 24, "setAsset read the token again");
        (bool ok, uint256 value) = VAULT.valueOf(SPY, 1e24);
        assertTrue(ok);
        assertEq(value, price8 / 100, "one SPY at the live price, on the token's new scale");
    }

    /// Nothing honest changes: with today's tokens, the source prices and holds every listed token (the 35 stocks and
    /// PT-USDG) exactly as the deployed implementation.
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
        _upgradeToTheSource();
        for (uint256 i; i < list.length; ++i) {
            (bool ok, uint256 value) = VAULT.valueOf(list[i], 1e18);
            assertEq(ok, oks[i], "priced as before");
            assertEq(value, values[i], "the same value");
            assertEq(VAULT.lendStatus(list[i]), holds[i], "the same hold");
        }
        emit log_named_uint("listed tokens priced as before", list.length);
    }
}
