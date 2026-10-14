// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {CreditPoolV2Base} from "./CreditPoolV2.t.sol";

/// @title GHSA-2899-mwvp-gpvc: a fresh deposit into an aged wallet inherits its share-weighted hold clock
/// @notice `deposit` moves the receiver's one clock to the share-weighted mean of its old clock and now
///         (src/CreditPoolV2.sol:428-433) and `withdraw` charges 0.5% only while that clock is under MIN_HOLD
///         (:443-444). A deposit of D shares into H shares aged `age` keeps the clock outside MIN_HOLD while
///         D <= H * (age - MIN_HOLD) / MIN_HOLD, so a 0-second-old deposit can leave with no early-exit fee right after
///         a fee lands (a repayment, or anyone's `markDefault` past grace).
///
///         Each test PASSES by demonstrating the behaviour and its bounds, on a local pool at the live parameters and
///         size (getParams() and totalAssets() of 0x2812…DE21 at block 87,427,387, 2026-10-13 10:04 UTC: feeBps 100,
///         sponsor 25% and reserve 25% of the base fee, lenders 50%, maxLoan 500, totalAssets 6,544.416378 USDG):
///         - the exit fee is skipped for the JIT money (a fresh wallet doing the same pays 0.5% and loses money);
///         - what the JIT money takes is D/(TA+D) of the fee the event lands: F-2's bound around a repayment (one
///           repayment's lender share) and SO-2's around a default (that loan's fee), the same move through a root;
///         - the root door (`enrollRoot` then `unlock`, F-2) takes the same with no anchor, no aging and no fee;
///         - the fee-free room is the anchor's age, spent by each use: `withdraw` never moves the clock, so after one
///           JIT the same anchor cannot bring the same amount again until it has aged again.
///
///   forge test --match-contract Pvr2899Test -vv
contract Pvr2899Test is CreditPoolV2Base {
    uint256 constant LIVE_TA = 6_544_416378; // totalAssets() of the live pool, block 87,427,387
    uint256 constant ANCHOR = 100 * USDC; // the report's anchor
    uint256 constant JIT = 5_000 * USDC; // the report's JIT deposit
    uint256 constant AGE = 400 days; // the report's anchor age
    uint256 constant MAX_LOAN = 500 * USDC;

    enum Door {
        AnchorOnly, // the aged wallet stays as it is: what its anchor earns from the event anyway
        AgedLender, // the report: JIT through the aged wallet's deposit, then withdraw everything
        FreshLender, // the same JIT through a wallet with no anchor: README's "zero-duration position loses money"
        Root // F-2: the same JIT through a fresh identity enrolled as a root, then unlock
    }

    address attacker = makeAddr("aged-wallet");
    address fresh = makeAddr("fresh-wallet");
    address jitRoot = makeAddr("jit-root");
    uint256 t0;

    function setUp() public override {
        super.setUp();
        // the live fee split and settings (the base fixture has reserve 15%, utilization 90%, a bounty)
        CreditPoolV2.Params memory p = pool.getParams();
        p.protocolFeeBps = 2500;
        p.maxUtilizationBps = 10_000;
        p.keeperBounty = 0;
        vm.prank(owner);
        pool.setParams(p);
        // the event's backer: stake for the largest line and its fee lock
        vm.prank(rootOwner);
        pool.addStake(ROOT, 500 * USDC);

        address[3] memory who = [attacker, fresh, jitRoot];
        for (uint256 i = 0; i < who.length; i++) {
            usdc.mint(who[i], 1_000_000 * USDC);
            vm.prank(who[i]);
            usdc.approve(address(pool), type(uint256).max);
        }
        t0 = block.timestamp;
        vm.prank(attacker);
        pool.deposit(ANCHOR, attacker, 0); // an honest lender's anchor, then left alone
        uint256 others = LIVE_TA - pool.totalAssets();
        vm.prank(lender);
        pool.deposit(others, lender, 0); // the other lenders, to the live pool's size
        assertEq(pool.totalAssets(), LIVE_TA);
    }

    /// The largest loan the live parameters allow without a premium (500 USDG for 30 days: fee 5 USDG, of which 2.5
    /// goes to lenders on a repayment, and all 5 to the remaining shares on a default), due at `t0 + AGE`.
    function _maxLoanDue() internal returns (uint256 loanId) {
        vm.warp(t0 + AGE - 30 days);
        _sponsor(ROOT, rootOwner, AGENT, AGENT_PK, MAX_LOAN);
        loanId = _borrow(agentOwner, AGENT, MAX_LOAN, 30 days);
        vm.warp(t0 + AGE);
    }

    /// One JIT of `d` through `door` around the max loan's repayment (or its default): the exit fee charged, and the
    /// wallet's gain in USDG units (for the aged wallet, net of its anchor coming back too).
    function _jit(Door door, uint256 d, bool viaDefault) internal returns (uint256 fee, int256 gain) {
        uint256 loanId = _maxLoanDue();
        if (viaDefault) vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        address who = door == Door.FreshLender ? fresh : door == Door.Root ? jitRoot : attacker;
        uint256 before = usdc.balanceOf(who);
        uint256 rootId;
        uint256 priceBefore = _price();
        vm.startPrank(who);
        if (door == Door.AgedLender || door == Door.FreshLender) pool.deposit(d, who, 0);
        if (door == Door.Root) {
            rootId = reg.register("jit-root");
            pool.enrollRoot(rootId, d);
        }
        vm.stopPrank();
        if (viaDefault) {
            vm.prank(anyone);
            pool.markDefault(loanId); // permissionless past grace
        } else {
            _repay(agentOwner, loanId);
        }
        vm.startPrank(who);
        if (door == Door.Root) {
            pool.unlock(rootId, pool.rootShares(rootId), who); // no fee on unlock (F-2)
        } else {
            uint256 sh = pool.shares(who);
            uint256 assets = pool.convertToAssets(sh);
            fee = assets - pool.withdraw(sh, who);
        }
        vm.stopPrank();
        gain = int256(usdc.balanceOf(who)) - int256(before); // the deposit went in and came back out
        if (door == Door.AgedLender || door == Door.AnchorOnly) gain -= int256(ANCHOR);
        assertGe(_price(), priceBefore, "the share price never falls: lenders' principal is not reached");
    }

    function _all(uint256 d, bool viaDefault)
        internal
        returns (int256 anchorOnly, int256 aged, int256 freshGain, int256 root, uint256 feeAged, uint256 feeFresh)
    {
        uint256 s = vm.snapshotState();
        (, anchorOnly) = _jit(Door.AnchorOnly, 0, viaDefault);
        vm.revertToState(s);
        (feeAged, aged) = _jit(Door.AgedLender, d, viaDefault);
        vm.revertToState(s);
        (feeFresh, freshGain) = _jit(Door.FreshLender, d, viaDefault);
        vm.revertToState(s);
        (, root) = _jit(Door.Root, d, viaDefault);
        vm.revertToState(s);
    }

    function _check(string memory what, uint256 d, bool viaDefault, uint256 landed) internal {
        (int256 anchorOnly, int256 aged, int256 freshGain, int256 root, uint256 feeAged, uint256 feeFresh) =
            _all(d, viaDefault);
        emit log_string(what);
        emit log_named_decimal_int("  anchor alone (100 USDG aged 400 d), its own share  ", anchorOnly, 6);
        emit log_named_decimal_int("  aged wallet + JIT deposit, fee-free exit           ", aged, 6);
        emit log_named_decimal_int("  fresh wallet, same JIT, pays the 0.5% exit fee     ", freshGain, 6);
        emit log_named_decimal_uint("    its exit fee                                    ", feeFresh, 6);
        emit log_named_decimal_int("  fresh root, same JIT, enrollRoot -> unlock (F-2)  ", root, 6);
        emit log_named_decimal_uint("  fee the event lands on the shares                 ", landed, 6);

        // the report's claim: the JIT money leaves fee-free through the aged wallet, a fresh wallet pays and loses
        assertEq(feeAged, 0, "aged wallet: no early-exit fee on 0-second-old money");
        assertGt(feeFresh, 0, "fresh wallet: the 0.5% fee");
        assertLt(freshGain, 0, "fresh wallet: a zero-duration position loses money (README)");
        assertGt(aged - anchorOnly, 0, "the JIT money gains");
        // ...and what it gains is what the root door already gives anyone, fee-free, with no anchor: the aged wallet
        // takes at most the root's JIT gain plus what its anchor earns on its own
        assertGt(root, 0, "root door: fee captured, no exit fee (F-2)");
        assertLe(aged, root + anchorOnly + 2, "the aged wallet takes no more than the root door plus its own anchor");
        // the stated bound: a share of the fee this one event lands, never more (F-2 / SO-2)
        assertLe(uint256(root), landed, "within the event's landed fee");
        assertLe(uint256(aged), landed, "within the event's landed fee");
    }

    /// The report's flow around a repayment of the largest loan: 2.5 USDG lands on the shares.
    function test_2899_aroundRepay_agedWalletSkipsTheFee_rootDoorTakesTheSame() public {
        _check("around repay(500 USDG, 30 d): gain in USDG", JIT, false, 2_500000);
    }

    /// The report's flow around anyone's markDefault on the largest loan past grace: its unpaid 5 USDG fee lands.
    function test_2899_aroundMarkDefault_agedWalletSkipsTheFee_rootDoorTakesTheSame() public {
        _check("around markDefault(500 USDG, 30 d): gain in USDG", JIT, true, 5_000000);
    }

    /// The fee-free bound, exact: D <= H * (age - MIN_HOLD) / MIN_HOLD in shares. One share more puts the clock inside.
    function test_2899_feeFreeBoundIsTheAnchorsAge() public {
        vm.warp(t0 + AGE);
        uint256 h = pool.shares(attacker);
        uint256 hold = pool.MIN_HOLD();
        uint256 maxShares = h * (AGE - hold) / hold;
        uint256 maxAssets = pool.convertToAssets(maxShares);
        emit log_named_decimal_uint("fee-free JIT a 100 USDG anchor aged 400 d can bring (USDG)", maxAssets, 6);
        uint256 s = vm.snapshotState();
        vm.prank(attacker);
        pool.deposit(maxAssets, attacker, 0);
        assertLe(uint256(pool.lastDepositAt(attacker)) + hold, block.timestamp, "at the bound: still fee-free");
        vm.revertToState(s);
        vm.prank(attacker);
        pool.deposit(maxAssets + 2 * USDC, attacker, 0);
        assertGt(uint256(pool.lastDepositAt(attacker)) + hold, block.timestamp, "past the bound: inside the window");
    }

    /// `withdraw` never moves the clock: a JIT that takes its own shares back out leaves the anchor's clock averaged
    /// toward now, so the same JIT again right after pays the fee. The anchor's age is a budget, not a key.
    function test_2899_eachUseSpendsTheAnchorsAge() public {
        vm.warp(t0 + AGE);
        uint256 hold = pool.MIN_HOLD();
        uint256 d = pool.convertToAssets(pool.shares(attacker) * (AGE - hold) / hold); // the whole budget at once
        vm.startPrank(attacker);
        uint256 minted = pool.deposit(d, attacker, 0);
        uint256 a1 = pool.convertToAssets(minted);
        uint256 out1 = pool.withdraw(minted, attacker); // the JIT shares only; the anchor stays
        assertEq(out1, a1, "first use: fee-free");
        uint256 left = block.timestamp - pool.lastDepositAt(attacker);
        emit log_named_decimal_uint("anchor clock age left after one full use (days)", left * 1e6 / 1 days, 6);
        minted = pool.deposit(d, attacker, 0);
        uint256 a2 = pool.convertToAssets(minted);
        uint256 out2 = pool.withdraw(minted, attacker);
        vm.stopPrank();
        assertEq(a2 - out2, a2 * pool.EARLY_EXIT_BPS() / 10_000, "second use at once: the 0.5% fee");
    }
}
