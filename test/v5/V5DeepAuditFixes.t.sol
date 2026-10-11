// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {V5Base} from "./V5Base.sol";
import {ICreditPoolV2} from "../../src/interfaces/ICreditPoolV2.sol";
import {V5Storage as S} from "../../src/v5/V5Storage.sol";
import {Env, C, IV5Errors} from "../../src/v5/V5Types.sol";
import {V5Auto} from "../../src/v5/V5Auto.sol";
import {V5Pos} from "../../src/v5/V5Pos.sol";
import {V5Math as M} from "../../src/v5/V5Math.sol";

/// @dev Regressions for the deep audit's findings (docs/AUDIT-DEEP-V5.md, docs/AUDIT-DEEP-GAS-INTEGRATION.md), in the
///      builders' suite so branch coverage counts them. Each proof of concept now fails to reproduce.

/// @notice Books whose next first steps trip the breaker: book X has an unreconciled on-time counted repayment, and
///         five other books' $250 of defaults were recorded by the hooks, which never evaluate the breaker (2.8).
abstract contract TripBase is V5Base {
    uint256 internal X;
    address internal ox;
    uint256[] internal yLoans;
    bool internal failFirstHook; // the first default's onDefault hook fails (HookFailed): V5 records it on reconciliation

    function _agentCount() internal pure virtual override returns (uint256) {
        return 7;
    }

    function _poolParams() internal pure virtual override returns (ICreditPoolV2.Params memory p) {
        p = super._poolParams();
        p.feeBps = 500;
        p.sponsorFeeBps = 8500;
    }

    function _dayAt(uint256 day, uint256 hour) internal {
        vm.warp(day * 1 days + hour * 1 hours);
        _keeperPass(P0);
    }

    function _openOthers() internal {
        for (uint256 i = 1; i < 6; i++) {
            _open(agents[i], 150_000 * T); // $50 lines
        }
    }

    function _markOthers() internal {
        for (uint256 i = 0; i < yLoans.length; i++) {
            if (i == 0 && failFirstHook) {
                vm.mockCallRevert(address(v5), abi.encodeWithSelector(v5.onDefault.selector), "");
                pool.markDefault(yLoans[i]);
                vm.clearMockedCalls();
                continue;
            }
            pool.markDefault(yLoans[i]); // each hook records it in the breaker's buckets; none evaluates
        }
        assertFalse(lens.breakerTripped(), "due, not yet tripped");
    }

    function _earn(uint256 id, uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            uint256 l = _borrow(id, 50 * U, 10 days);
            _skipFresh(10 days);
            _repay(l);
            v5.pokeFees(id);
        }
    }
}

/// @notice D-01: a breaker trip inside a compound batch. The PoC (docs/AUDIT-DEEP-V5.md) deposited into A while A's
///         merge was frozen, orphaning a two-day-old bucket; now no item of the batch deposits, every credit waits.
///         Since GHSA-g626's fix the batch evaluates the breaker before any item, so defaults the hooks recorded trip
///         it there; a trip inside the batch comes from an item's reconciliation recording a default its hook did not.
contract V5FixCompoundTripTest is TripBase {
    uint256 internal Y; // a second book with auto-add on, items before X in a batch
    address internal oy;
    uint32 internal dMinus2;
    uint32 internal dDay;
    bool internal reconcileX; // X's last repayment reconciled before the defaults: X's first steps then record nothing

    function setUp() public override {
        super.setUp();
        X = agents[0];
        ox = _owner(X);
        Y = agents[6];
        oy = _owner(Y);
        _open(X, 280_000 * T); // A 150,000 (3 x the T1 ceiling at P0), own backing 130,000
        vm.prank(ox);
        v5.setAutoAdd(X, true);
        _open(Y, 280_000 * T);
        vm.prank(oy);
        v5.setAutoAdd(Y, true);
        _openOthers();
        _earn(X, 25);
        _earn(Y, 3);
        v5.promote(X); // T2: the owner's fees now go into A (question 31)
    }

    /// @dev The PoC's path up to the batch: X's owner bucket of day D-2, X's counted repayment of day D-1 not yet
    ///      reconciled, then five defaults recorded on day D.
    function _toBatchDay() internal {
        uint32 d0 = _today();
        _dayAt(d0 + 2, 1);
        for (uint256 i = 1; i < 6; i++) {
            yLoans.push(_borrow(agents[i], 50 * U, 10 days));
        }
        _dayAt(d0 + 7, 1);
        uint256 lx = _borrow(X, 50 * U, 10 days);
        // Y's fees since its last touch: a loan repaid and poked (nothing of Y is left to reconcile)
        uint256 ly = _borrow(Y, 50 * U, 10 days);
        dMinus2 = d0 + 14;
        _dayAt(dMinus2, 12);
        vm.prank(ox);
        v5.back(X, 5_000 * T, false);
        _repay(ly);
        v5.pokeFees(Y);
        _dayAt(d0 + 15, 12);
        _repay(lx);
        dDay = d0 + 16;
        _dayAt(dDay, 12);
        if (reconcileX) v5.pokeFees(X);
        _markOthers();
        assertEq(dDay % 2, dMinus2 % 2, "same parity");
    }

    function _items1() internal view returns (V5Auto.Item[] memory items) {
        items = new V5Auto.Item[](1);
        items[0] = V5Auto.Item(X, ox);
    }

    function test_D01_tripInsideTheBatch_nothingDeposited_A_paidWhole() public {
        _toBatchDay();
        S.Gen memory g0 = _gen(X);
        uint256 cl0 = lens.claimable(ox);
        (uint256 owed0,,,,,,) = lens.totals();
        vm.prank(keeper);
        v5.compound(_items1(), 0); // no revert: the trip stands
        assertTrue(lens.breakerTripped(), "tripped by the batch's own evaluation, before any item");
        S.Gen memory g = _gen(X);
        assertEq(g.pendingTok[C.OWNER], 5_000 * T, "nothing deposited into A");
        assertEq(g.pendingTok[C.OWN], g0.pendingTok[C.OWN], "nor into the owner's own backing");
        assertTrue(g.liveDay[C.OWNER][(dMinus2 + 1) % 2] == dMinus2 + 1, "the D-2 bucket keeps its slot");
        assertEq(lens.claimable(ox), cl0, "no credit taken");
        (uint256 owed1,,,,,,) = lens.totals();
        // nothing was taken from holdersOwed; it moved only by any split of X's fees (none: X's steps did not run)
        assertApproxEqAbs(owed1 - owed0, (g.index - g0.index) * g.divisor / C.INDEX, 1, "holdersOwed: only the split");

        // the Safe clears the breaker; the next poke merges the D-2 bucket; the owner's A is paid whole
        vm.prank(guardian);
        v5.clear();
        _skipFresh(1 days + 1 hours);
        v5.pokeFees(X);
        g = _gen(X);
        assertEq(g.pendingTok[C.OWNER], 0, "merged");
        assertEq(g.counted[C.OWNER], g0.counted[C.OWNER] + 5_000 * T);
        uint256 a = g.counted[C.OWNER];
        vm.prank(ox);
        v5.close(X, 1);
        _skipFresh(8 days);
        uint256 b0 = priors.balanceOf(ox);
        v5.finishClose(X, 1);
        assertEq(priors.balanceOf(ox) - b0, a, "the closing record pays A whole");
    }

    /// @dev The same corrupted path closed in mode 2 used to wedge the exit queue's head: now the head is served.
    function test_D01_modeTwoClose_queueProgresses() public {
        _toBatchDay();
        vm.prank(keeper);
        v5.compound(_items1(), 0);
        vm.prank(guardian);
        v5.clear();
        _skipFresh(1 days + 1 hours);
        vm.prank(ox);
        v5.close(X, 2);
        uint32 closeDay = _today();
        _skipFresh(8 days);
        vm.prank(keeper);
        v5.queueExit(X, 1, ox, C.OWNER, closeDay);
        (uint256 head,,,,) = lens.exitHead();
        assertGt(head, 0);
        _skipFresh(4 days); // past the window: the head is paid as $PRIORS
        uint256 b0 = priors.balanceOf(ox);
        vm.prank(keeper);
        v5.releaseFor(head, type(uint256).max);
        assertGt(priors.balanceOf(ox), b0, "paid");
        (uint256 next,,,,) = lens.exitHead();
        assertEq(next, 0, "the queue moved on");
    }

    /// @dev An item taken before a later item trips the breaker gets its credit back: the batch deposits nothing. The
    ///      trip comes from the later item's reconciliation: agent 1's default, whose hook failed (`HookFailed`), is
    ///      recorded only there, and with the four the hooks recorded ($200, under the floor) reaches $250.
    function test_D01_tripOnALaterItem_earlierItemsCreditKept() public {
        failFirstHook = true;
        _toBatchDay();
        (,,,,,, uint256 recorded) = lens.totals();
        assertEq(recorded, 4, "the failed hook recorded nothing");
        V5Auto.Item[] memory items = new V5Auto.Item[](2);
        items[0] = V5Auto.Item(Y, oy);
        items[1] = V5Auto.Item(agents[1], _owner(agents[1]));
        uint256 cly = lens.claimable(oy);
        uint256 pend = _gen(Y).pendingTok[C.OWNER] + _gen(Y).pendingTok[C.OWN];
        S.Gen memory g10 = _gen(agents[1]);
        (uint256 owed0,,,,,,) = lens.totals();
        vm.prank(keeper);
        v5.compound(items, 0);
        assertTrue(lens.breakerTripped(), "tripped by agent 1's reconciliation, the batch's second item");
        assertGt(lens.claimable(oy), cly + C.COMPOUND_ITEM_MIN, "Y's own new credit is in claimable");
        assertEq(_gen(Y).pendingTok[C.OWNER] + _gen(Y).pendingTok[C.OWN], pend, "Y got no stake");
        (uint256 owed1,,,,,,) = lens.totals();
        S.Gen memory g1 = _gen(agents[1]);
        // Y's credit taken then given back: holdersOwed moved only by agent 1's split in its first steps
        assertApproxEqAbs(owed1 - owed0, (g1.index - g10.index) * g1.divisor / C.INDEX, 1, "holdersOwed covers it");
        uint256[] memory ids = new uint256[](1);
        ids[0] = Y;
        uint32[] memory gens = new uint32[](1);
        gens[0] = 1;
        uint256 u0 = usdg.balanceOf(oy);
        vm.prank(oy);
        v5.collect(ids, gens);
        assertGt(usdg.balanceOf(oy) - u0, C.COMPOUND_ITEM_MIN, "collected in USDG");
    }

    /// @dev GHSA-g626 in compound: X reconciled before the defaults, so no item's own first steps record anything. On
    ///      the deployed V5 the latch stayed stale and X's credit went into A; now the batch's evaluation trips first.
    function test_GHSA_g626_compoundAfterHookRecordedThreshold_depositsNothing() public {
        reconcileX = true;
        _toBatchDay();
        S.Gen memory g0 = _gen(X);
        uint256 cl0 = lens.claimable(ox);
        vm.prank(keeper);
        v5.compound(_items1(), 0);
        assertTrue(lens.breakerTripped(), "the batch evaluated the breaker before any item");
        assertEq(_gen(X).pendingTok[C.OWNER], g0.pendingTok[C.OWNER], "nothing deposited into A");
        assertEq(_gen(X).pendingTok[C.OWN], g0.pendingTok[C.OWN], "nor into the owner's own backing");
        assertEq(lens.claimable(ox), cl0, "no credit taken");
    }

    /// @dev Control: with nothing to trip, the same batch compounds as before.
    function test_D01_control_noTrip_compounds() public {
        _toBatchDay();
        vm.prank(guardian);
        v5.clear(); // the hooks' records cleared: X's reconciliation finds nothing to trip
        uint256 p0 = _gen(X).pendingTok[C.OWNER];
        vm.prank(keeper);
        v5.compound(_items1(), 0);
        assertFalse(lens.breakerTripped());
        assertGt(_gen(X).pendingTok[C.OWNER], p0, "into A");
    }
}

/// @notice D-01's defence in depth: a deposit that would land in the slot of another day's unmerged bucket reverts.
///         Every path checks its guards after its first steps, so no test reaches it through V5: a harness that runs
///         V5Pos.deposit in its own storage, with the slot the PoC used to overwrite.
contract V5PosHarness {
    function v5Env() external pure returns (Env memory e) {}

    function setLayerDay(uint256 id, uint32 gen, uint8 layer, uint256 slot, uint32 d1) external {
        S.layout().gens[id][gen].liveDay[layer][slot] = d1;
    }

    function setPosDay(uint256 id, uint32 gen, uint8 layer, address holder, uint32 d0, uint32 d1) external {
        S.Pos storage pp = S.layout().pos[id][gen][layer][holder];
        pp.d0 = d0;
        pp.d1 = d1;
        pp.a0 = d0 == 0 ? 0 : 1;
        pp.a1 = d1 == 0 ? 0 : 1;
        if (d0 != 0) S.layout().pend[id][gen][layer][d0 - 1].amount = 1;
        if (d1 != 0) S.layout().pend[id][gen][layer][d1 - 1].amount = 1;
    }

    function deposit(uint256 id, uint32 gen, uint8 layer, address holder, uint256 amount) external {
        Env memory e;
        V5Pos.deposit(e, id, gen, layer, holder, amount);
    }

    function liveDay(uint256 id, uint32 gen, uint8 layer, uint256 slot) external view returns (uint32) {
        return S.layout().gens[id][gen].liveDay[layer][slot];
    }
}

contract V5FixThirdSlotTest is V5Base {
    V5PosHarness internal h;
    address internal who = address(0xB0B);

    function setUp() public override {
        h = new V5PosHarness();
        vm.warp(20_000 days + 12 hours);
    }

    function _d1() internal view returns (uint32) {
        return uint32(block.timestamp / 1 days) + 1;
    }

    /// @dev The layer's slot of today's parity holds an unmerged bucket two days old: ThirdSlot, not an overwrite.
    function test_D01_layerSlotHeldByAnOlderBucket_reverts() public {
        uint32 d1 = _d1();
        h.setLayerDay(1, 1, C.OWNER, d1 % 2, d1 - 2);
        vm.expectRevert(IV5Errors.ThirdSlot.selector);
        h.deposit(1, 1, C.OWNER, who, 1e18);
        assertEq(h.liveDay(1, 1, C.OWNER, d1 % 2), d1 - 2, "the older bucket keeps its slot");
    }

    /// @dev The position's slot of today's parity points at another day's bucket: ThirdSlot.
    function test_D01_positionSlotHeldByAnOlderBucket_reverts() public {
        uint32 d1 = _d1();
        if (d1 % 2 == 0) h.setPosDay(1, 1, C.OWN, who, d1 - 2, 0);
        else h.setPosDay(1, 1, C.OWN, who, 0, d1 - 2);
        vm.expectRevert(IV5Errors.ThirdSlot.selector);
        h.deposit(1, 1, C.OWN, who, 1e18);
    }

    /// @dev Today's own bucket, in the layer and the position: the deposit adds to it.
    function test_D01_todaysSlot_deposits() public {
        uint32 d1 = _d1();
        h.setLayerDay(1, 1, C.OTHERS, d1 % 2, d1);
        if (d1 % 2 == 0) h.setPosDay(1, 1, C.OTHERS, who, d1, 0);
        else h.setPosDay(1, 1, C.OTHERS, who, 0, d1);
        h.deposit(1, 1, C.OTHERS, who, 1e18);
        assertEq(h.liveDay(1, 1, C.OTHERS, d1 % 2), d1);
    }
}

/// @notice D-02: `open`, fills and keeper sells check the breaker after the first steps that can trip it.
contract V5FixGuardOrderTest is TripBase {
    address internal leaver = backer1;
    bool internal reconcileHead; // X's repayment reconciled before the defaults: the head's first steps record nothing

    function setUp() public override {
        super.setUp();
        X = agents[0];
        ox = _owner(X);
        vm.prank(timelock);
        v5.setOpenBacking(true);
    }

    /// @dev Book X closed, its loan repaid on time and never reconciled; $250 of defaults recorded on the reopen day.
    function test_D02_openRefused_whenItsOwnFirstStepsTripTheBreaker() public {
        _open(X, 150_000 * T);
        _openOthers();
        uint32 d0 = _today();
        _dayAt(d0 + 1, 1);
        uint256 lx = _borrow(X, 50 * U, 10 days);
        _dayAt(d0 + 2, 1);
        vm.prank(ox);
        v5.close(X, 1);
        _dayAt(d0 + 10, 1);
        _repay(lx);
        _dayAt(d0 + 20, 1);
        for (uint256 i = 1; i < 6; i++) {
            yLoans.push(_borrow(agents[i], 50 * U, 10 days));
        }
        _dayAt(d0 + 33, 12);
        _markOthers();
        (ICreditPoolV2.Consent memory c, bytes memory sig) = _consent(X, ROOT, 0);
        vm.prank(ox);
        vm.expectRevert(IV5Errors.BreakerOn.selector);
        v5.open(X, 150_000 * T, false, c, sig);
        assertEq(lens.latestGen(X), 1, "no new book");
    }

    /// @dev A queued mode-2 record of book X at the head; X's on-time repayment is not reconciled until the head's
    ///      first steps, which run inside the fill or the sale; the hooks recorded $250 of defaults.
    function _headTrips() internal returns (uint256 head) {
        _open(X, 150_000 * T);
        _openOthers();
        _back(leaver, X, 40_000 * T);
        uint32 d0 = _today();
        _dayAt(d0 + 1, 1);
        for (uint256 i = 1; i < 6; i++) {
            yLoans.push(_borrow(agents[i], 50 * U, 10 days)); // defaultable on d0 + 14, hour 1
        }
        vm.prank(leaver);
        v5.leave(X, 40_000 * T, 2);
        uint32 leaveDay = _today();
        _dayAt(d0 + 2, 1);
        uint256 lx = _borrow(X, 50 * U, 10 days); // after the leave: it does not hold the leave's bucket
        _dayAt(d0 + 11, 3);
        vm.prank(keeper);
        v5.queueExit(X, 1, leaver, C.OTHERS, leaveDay); // the queue's 3-day window runs to d0 + 14, hour 3
        (head,,,,) = lens.exitHead();
        assertGt(head, 0);
        _dayAt(d0 + 11, 4);
        _repay(lx); // on time, counted at the next reconciliation
        if (reconcileHead) v5.pokeFees(X);
        _dayAt(d0 + 14, 2);
        _markOthers();
    }

    function test_D02_fillExit_headsFirstStepsTripTheBreaker_noFill() public {
        uint256 head = _headTrips();
        uint256 bal = priors.balanceOf(bb);
        vm.prank(bb);
        (uint256 taken,) = v5.fillExit(head, type(uint256).max, _sqrtFor(P0));
        assertEq(taken, 0, "no fill under the breaker the head's first steps tripped");
        assertTrue(lens.breakerTripped(), "and the trip stands");
        assertEq(priors.balanceOf(bb), bal);
        (uint256 still,,,,) = lens.exitHead();
        assertEq(still, head, "the head waits");
    }

    function test_D02_keeperSell_headsFirstStepsTripTheBreaker_noSale() public {
        uint256 head = _headTrips();
        uint256 u0 = usdg.balanceOf(leaver);
        vm.prank(keeper);
        v5.releaseFor(head, type(uint256).max);
        assertTrue(lens.breakerTripped());
        assertEq(usdg.balanceOf(leaver), u0, "nothing sold");
        (uint256 still,,,,) = lens.exitHead();
        assertEq(still, head);
    }

    /// @dev GHSA-g626 in the exit paths: the head reconciled before the defaults, so its own first steps record
    ///      nothing. On the deployed V5 the stale latch let the fill run; now the fill evaluates the breaker first.
    function test_GHSA_g626_fillExit_afterHookRecordedThreshold_noFill() public {
        reconcileHead = true;
        uint256 head = _headTrips();
        assertFalse(lens.breakerTripped(), "the hooks recorded $250 and evaluated nothing");
        uint256 bal = priors.balanceOf(bb);
        vm.prank(bb);
        (uint256 taken,) = v5.fillExit(head, type(uint256).max, _sqrtFor(P0));
        assertEq(taken, 0, "no fill under the breaker");
        assertTrue(lens.breakerTripped(), "the fill's own evaluation tripped it, and the trip stands");
        assertEq(priors.balanceOf(bb), bal);
    }

    /// @dev The same for the keeper's sale.
    function test_GHSA_g626_keeperSell_afterHookRecordedThreshold_noSale() public {
        reconcileHead = true;
        uint256 head = _headTrips();
        uint256 u0 = usdg.balanceOf(leaver);
        vm.prank(keeper);
        v5.releaseFor(head, type(uint256).max);
        assertTrue(lens.breakerTripped(), "the sale's own evaluation tripped it, and the trip stands");
        assertEq(usdg.balanceOf(leaver), u0, "nothing sold");
        (uint256 still,,,,) = lens.exitHead();
        assertEq(still, head);
    }

    /// @dev Control: with no trip, the same head is filled.
    function test_D02_control_fillsWhenNothingTrips() public {
        uint256 head = _headTrips();
        vm.prank(guardian);
        v5.clear();
        vm.prank(bb);
        (uint256 taken,) = v5.fillExit(head, type(uint256).max, _sqrtFor(P0));
        assertGt(taken, 0);
    }
}

/// @notice D-03: a swap that stops at its price limit (`paid` < the input) is no sale; the record keeps every unit.
contract V5FixPartialSaleTest is V5Base {
    uint256 internal id;
    uint32 internal d;

    function setUp() public override {
        super.setUp();
        id = agents[0];
        _open(id, 150_001 * T);
        vm.prank(timelock);
        v5.setOpenBacking(true);
        _back(backer1, id, 40_000 * T);
        _skipFresh(1 days);
    }

    function test_D03_release_partialFill_revertsAndKeepsTheRecord() public {
        vm.prank(backer1);
        v5.leave(id, 40_000 * T, 0);
        d = _today();
        _skipFresh(8 days);
        swapper.setPayPart(5_000);
        (uint256 led0,) = _ledger();
        vm.prank(backer1);
        vm.expectRevert(abi.encodeWithSelector(IV5Errors.UsdgPathClosed.selector, 5));
        v5.release(id, 1, d, 1, block.timestamp);
        (uint256 led1,) = _ledger();
        assertEq(led1, led0, "nothing left the ledger");
        assertEq(lens.record(id, 1, C.OTHERS, d, backer1).counted, 40_000 * T, "the record is whole");
        // the whole sale goes through once the pool takes it all; or the record leaves as $PRIORS
        swapper.setPayPart(10_000);
        uint256 u0 = usdg.balanceOf(backer1);
        vm.prank(backer1);
        v5.release(id, 1, d, 1, block.timestamp);
        assertGt(usdg.balanceOf(backer1), u0);
        assertTrue(_solvent());
    }

    function test_D03_keeperSell_partialFill_skipsWritingNothing() public {
        vm.prank(backer1);
        v5.leave(id, 40_000 * T, 2);
        d = _today();
        _skipFresh(8 days);
        vm.prank(keeper);
        v5.queueExit(id, 1, backer1, C.OTHERS, d);
        (uint256 head,,,,) = lens.exitHead();
        swapper.setPayPart(9_990); // 99.9% sold before the limit: over the leg's floor, still not the whole chunk
        S.Rec memory r0 = lens.record(id, 1, C.OTHERS, d, backer1);
        (uint256 led0,) = _ledger();
        uint256 u0 = usdg.balanceOf(backer1);
        vm.prank(keeper);
        v5.releaseFor(head, type(uint256).max);
        S.Rec memory r1 = lens.record(id, 1, C.OTHERS, d, backer1);
        assertEq(r1.counted + r1.uncounted, r0.counted + r0.uncounted, "the record keeps every unit");
        (uint256 led1,) = _ledger();
        assertEq(led1, led0);
        assertEq(usdg.balanceOf(backer1), u0, "the leg was undone");
        (uint256 still,,,,) = lens.exitHead();
        assertEq(still, head, "skipped: the head waits for the next turn or its window");
        assertTrue(_solvent());
    }
}

/// @notice D-04: the owner's compound spends only positions whose own auto-add is on.
contract V5FixOwnerAutoAddTest is V5Base {
    uint256 internal id;
    address internal o;

    function _poolParams() internal pure override returns (ICreditPoolV2.Params memory p) {
        p = super._poolParams();
        p.feeBps = 500;
        p.sponsorFeeBps = 8500;
    }

    function _earn(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            uint256 l = _borrow(id, 50 * U, 10 days);
            _skipFresh(10 days);
            _repay(l);
            v5.pokeFees(id);
        }
    }

    function setUp() public override {
        super.setUp();
        id = agents[0];
        o = _owner(id);
        _open(id, 280_000 * T);
        vm.prank(o);
        v5.setAutoAdd(id, true);
        _earn(25);
    }

    function test_D04_ownerLeftOwnBacking_compoundSpendsOnlyA() public {
        vm.prank(o);
        v5.leave(id, 10_000 * T, 0);
        assertFalse(lens.position(id, 1, C.OWN, o).autoAdd);
        uint256 waiting = lens.claimable(o);
        _earn(12);
        S.Pos memory own = lens.position(id, 1, C.OWN, o);
        S.Pos memory a = lens.position(id, 1, C.OWNER, o);
        (uint256 owed0,,,,,,) = lens.totals();
        V5Auto.Item[] memory items = new V5Auto.Item[](1);
        items[0] = V5Auto.Item(id, o);
        vm.prank(keeper);
        v5.compound(items, 0);
        uint256 idx = _gen(id).index;
        uint256 ownCredit = M.credit(own.counted, own.checkpoint, idx);
        uint256 aCredit = M.credit(a.counted, a.checkpoint, idx);
        assertGt(ownCredit, 1e6, "over 1 USDG of OWN's fees since the leave");
        (uint256 owed1,,,,,,) = lens.totals();
        assertEq(owed0 - owed1, aCredit, "the batch spent A's credit only");
        // A is at 3 x the T1 ceiling, so the tokens join the owner's own backing (question 31); that deposit brings
        // OWN up to date, its credit moved to `claimable` unspent
        assertEq(lens.claimable(o), waiting + ownCredit, "OWN's fees wait for collect");
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint32[] memory gens = new uint32[](1);
        gens[0] = 1;
        uint256 u0 = usdg.balanceOf(o);
        vm.prank(o);
        v5.collect(ids, gens);
        assertGe(usdg.balanceOf(o) - u0, waiting + ownCredit);
    }

    /// @dev A's flag off and OWN's on: the batch spends OWN's credit only (the other half of the per-position read).
    function test_D04_onlyOwnOn_spendsOnlyOwn() public {
        // both flags off, then a top-up with auto-add on: A is at 3 x the ceiling, so it all goes to the owner's own
        // backing and only that position's flag comes back on
        vm.prank(o);
        v5.setAutoAdd(id, false);
        _skipFresh(1 days);
        vm.prank(o);
        v5.back(id, 5_000 * T, true); // A is at 3 x the ceiling: all into OWN, OWN's flag on, A's stays off
        assertTrue(lens.position(id, 1, C.OWN, o).autoAdd);
        assertFalse(lens.position(id, 1, C.OWNER, o).autoAdd);
        _earn(60);
        S.Pos memory a = lens.position(id, 1, C.OWNER, o);
        V5Auto.Item[] memory items = new V5Auto.Item[](1);
        items[0] = V5Auto.Item(id, o);
        vm.prank(keeper);
        v5.compound(items, 0);
        assertEq(lens.position(id, 1, C.OWNER, o).checkpoint, a.checkpoint, "A (auto-add off) not touched");
    }
}

/// @notice D-05: the deferred move of an `onRelease` close skips a generation settled in between, and takes P at the
///         close, not at the move.
contract V5FixDeferredMoveTest is V5Base {
    uint256 internal id;
    address internal o;

    function setUp() public override {
        super.setUp();
        id = agents[0];
        o = _owner(id);
        _open(id, 150_001 * T);
    }

    /// @dev The close inside `onRelease` (V5's root no longer the sponsor), as the pool makes it.
    function _hookClose() internal {
        ICreditPoolV2.Agent memory ag = pool.getAgent(id);
        ag.sponsor = OROOT;
        vm.mockCall(address(pool), abi.encodeWithSelector(pool.getAgent.selector, id), abi.encode(ag));
        vm.prank(address(pool));
        v5.onRelease(ROOT, id, 0, 0);
        vm.clearMockedCalls();
        assertTrue(_gen(id).movePending);
    }

    function test_D05_settledBeforeTheMove_noMove_positionsPaidAtOnce() public {
        uint256 l = _borrow(id, 50 * U, 10 days);
        S.Gen memory g0 = _gen(id);
        uint256 want =
            M.remainderOf(g0.tokens[C.OWNER], C.OWNER_BURN_BPS) + M.remainderOf(g0.tokens[C.OWN], C.BACK_BURN_BPS);
        _hookClose();
        _skipFresh(14 days);
        pool.markDefault(l); // the hook settles the closed generation before any book call
        assertEq(_gen(id).status, C.SETTLED);
        v5.pokeFees(id);
        S.Gen memory g = _gen(id);
        assertFalse(g.movePending);
        assertEq(g.layerEnd[C.OWNER], 0, "no move to leaving on a settled generation (2.5)");
        uint256 b0 = priors.balanceOf(o);
        v5.claimSettled(id, 1, o);
        assertEq(priors.balanceOf(o) - b0, want, "the remainders, at once, from the live positions");
        assertTrue(_solvent());
    }

    function test_D05_deferredMove_takesPAtTheClose() public {
        _hookClose();
        uint160 atClose = _gen(id).movePendingSqrt;
        assertGt(atClose, 0);
        // the price falls before anyone touches the book: pDown() moves, the move keeps the close's P
        _skip(1 hours);
        _setSpot(P0 / 2);
        _keeperPass(P0 / 2);
        v5.pokeFees(id);
        S.Gen memory g = _gen(id);
        assertEq(g.endSqrt[C.OWNER], atClose);
        assertEq(g.endSqrt[C.OTHERS], atClose);
        assertEq(g.endSqrt[C.OWN], atClose);
    }
}

/// @notice H-01 (gas audit): no caller can latch the depth guard, or record an unread fee, by choosing its gas. The
///         mock limiter reads the hook's fee as the real SwapLimiter does (ReadStarved under 100,000 x 64/63 + 5,000).
contract V5FixStarvedReadTest is V5Base {
    function setUp() public override {
        super.setUp();
        limiter.setStarveCheck(true);
        _skipFresh(1 minutes);
    }

    /// @dev Every gas limit from 30,000 to 1,500,000: a sync() either reverts (writing nothing) or reads the guard off
    ///      and the fee as it is. Before the fix a band of budgets latched `depthOn`.
    function test_H01_sync_everyGasLimit_neverLatches() public {
        uint256 reverted;
        uint256 starved;
        uint256 succeeded;
        for (uint256 gl = 30_000; gl <= 1_500_000; gl += 1_499) {
            uint256 snap = vm.snapshotState();
            vm.warp(block.timestamp + 31 minutes);
            sizer.set(_sqrtFor(P0), _sqrtFor(P0));
            (bool ok, bytes memory r) = address(v5).call{gas: gl}(abi.encodeWithSignature("sync()"));
            S.Price memory p = lens.price();
            if (ok) {
                succeeded++;
                assertFalse(p.depthOn, "a successful sync never latches the guard");
                assertTrue(p.feeOk, "and always reads the fee");
            } else {
                reverted++;
                if (r.length == 4 && bytes4(r) == IV5Errors.ReadStarved.selector) starved++;
                assertFalse(p.depthOn);
            }
            vm.revertToState(snap);
        }
        assertGt(starved, 0, "starved budgets revert ReadStarved");
        assertGt(succeeded, 0);
        emit log_named_uint("reverted", reverted);
    }

    /// @dev The guard views and every reader of the depth form refuse when starved, never read "on".
    function test_H01_depthGuardView_starved_reverts() public {
        bool sawStarved;
        for (uint256 gl = 50_000; gl <= 800_000; gl += 997) {
            (bool ok, bytes memory r) = address(v5).staticcall{gas: gl}(abi.encodeCall(lens.depthGuard, ()));
            if (ok) assertFalse(abi.decode(r, (bool)), "never on at a starved budget");
            else if (r.length == 4 && bytes4(r) == IV5Errors.ReadStarved.selector) sawStarved = true;
        }
        assertTrue(sawStarved);
    }

    /// @dev A reverting depth view reverts sync() whole: the guard is never latched by a failed read.
    function test_H01_depthViewReverts_syncReverts_noLatch() public {
        limiter.setViewReverts(true);
        _skip(31 minutes);
        sizer.set(_sqrtFor(P0), _sqrtFor(P0));
        vm.expectRevert(bytes("view down"));
        v5.sync();
        assertFalse(lens.price().depthOn);
    }
}

/// @notice L-01: the settle inside `onDefault` defers the split; the fees owed before the default still go to the
///         generation's holders, through the next first steps, before any credit of the generation is read.
contract V5FixHookSplitTest is V5Base {
    uint256 internal id;
    address internal o;

    function _poolParams() internal pure override returns (ICreditPoolV2.Params memory p) {
        p = super._poolParams();
        p.feeBps = 500;
        p.sponsorFeeBps = 8500;
    }

    function setUp() public override {
        super.setUp();
        id = agents[0];
        o = _owner(id);
        vm.prank(timelock);
        v5.setOpenBacking(true);
        _open(id, 150_001 * T);
        _back(backer1, id, 50_000 * T);
        _skipFresh(1 days + 1);
        v5.pokeFees(id);
    }

    /// @dev A repaid loan's fees not yet split, then a default settled in the hook: the split waits for the next
    ///      first steps, which give it to the generation (not the buffer); `claimSettled` runs them first.
    function test_L01_hookSettle_defersTheSplit_claimSettledPaysTheBackersShare() public {
        uint256 l1 = _borrow(id, 40 * U, 10 days);
        uint256 l2 = _borrowRaw(id, 5 * U, 10 days);
        _skip(9 days);
        _repay(l1);
        _skipFresh(5 days);
        uint256 idx0 = _gen(id).index;
        (uint256 owed0, uint256 buf0,,,,,) = lens.totals();
        pool.markDefault(l2);
        S.Gen memory g = _gen(id);
        assertEq(g.status, C.SETTLED);
        assertTrue(g.splitPending, "the hook only flagged the split");
        assertEq(g.index, idx0, "no split inside the hook");
        (uint256 owed1, uint256 buf1,,,,,) = lens.totals();
        assertEq(owed1, owed0);
        assertEq(buf1, buf0);
        uint256 c0 = lens.claimable(backer1);
        v5.claimSettled(id, 1, backer1);
        g = _gen(id);
        assertFalse(g.splitPending);
        assertGt(g.index, idx0, "the pre-default fees went to the generation's index");
        assertGt(lens.claimable(backer1), c0, "the backer's share credited before its position was paid");
        (uint256 owed2, uint256 buf2,,,,,) = lens.totals();
        assertGt(owed2, owed1);
        assertGt(buf2, buf1, "the buffer's 25%");
        assertTrue(_solvent());
    }

    /// @dev Nothing to split at the default: the flag clears at the next first steps; later fees go to the buffer.
    function test_L01_hookSettle_nothingToSplit_flagClears_laterFeesToBuffer() public {
        uint256 l1 = _borrow(id, 40 * U, 10 days);
        uint256 l2 = _borrowRaw(id, 5 * U, 10 days);
        _skip(9 days);
        _repay(l1);
        v5.pokeFees(id); // split before the default
        _skipFresh(5 days);
        pool.markDefault(l2);
        assertTrue(_gen(id).splitPending);
        v5.pokeFees(id);
        assertFalse(_gen(id).splitPending, "cleared with nothing to split");
        uint256 idx = _gen(id).index;
        (, uint256 buf0,,,,,) = lens.totals();
        // a fee after the settle (the pool credits the sponsor's cut of a later repayment): all to the buffer
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(pool.feesFrom.selector, ROOT, id),
            abi.encode(pool.feesFrom(ROOT, id) + 1_000_000)
        );
        v5.pokeFees(id);
        vm.clearMockedCalls();
        assertEq(_gen(id).index, idx, "a settled generation's index never moves again");
        (, uint256 buf1,,,,,) = lens.totals();
        assertEq(buf1 - buf0, 1_000_000);
    }

    /// @dev The settle made outside a hook (anyone's `settle`) splits at once, as before.
    function test_L01_settleOutsideAHook_splitsAtOnce() public {
        uint256 l1 = _borrow(id, 40 * U, 10 days);
        uint256 l2 = _borrowRaw(id, 5 * U, 10 days);
        _skip(9 days);
        _repay(l1);
        _skipFresh(5 days);
        vm.mockCallRevert(address(v5), abi.encodeWithSelector(v5.onDefault.selector), "starved");
        pool.markDefault(l2);
        vm.clearMockedCalls();
        uint256 idx0 = _gen(id).index;
        v5.settle(id, 1, l2);
        S.Gen memory g = _gen(id);
        assertEq(g.status, C.SETTLED);
        assertFalse(g.splitPending);
        assertGt(g.index, idx0);
    }

    /// @dev claimSettled of a record runs the first steps too.
    function test_L01_claimSettledRecord_runsTheStepsFirst() public {
        vm.prank(backer1);
        v5.leave(id, 50_000 * T, 0);
        uint32 d = _today();
        uint256 l1 = _borrow(id, 40 * U, 10 days);
        uint256 l2 = _borrowRaw(id, 5 * U, 10 days);
        _skip(9 days);
        _repay(l1);
        _skipFresh(5 days);
        pool.markDefault(l2);
        assertTrue(_gen(id).splitPending);
        v5.claimSettled(id, 1, backer1, C.OTHERS, d);
        assertFalse(_gen(id).splitPending);
        assertTrue(_solvent());
    }
}

/// @notice I-01: at most RETIRE_MAX leaving buckets retired a layer a call; the next poke resumes.
contract V5FixRetireCapTest is V5Base {
    function test_I01_backlogRetiresInChunks() public {
        uint256 id = agents[0];
        vm.prank(timelock);
        v5.setOpenBacking(true);
        _open(id, 150_001 * T);
        _back(backer1, id, 70_000 * T);
        _skipFresh(1 days + 1);
        uint256 l = _borrow(id, 25 * U, 10 days); // listed: every later bucket waits for it
        uint256 n = C.RETIRE_MAX + 2;
        for (uint256 i = 0; i < n; i++) {
            _skipFresh(1 days);
            vm.prank(backer1);
            v5.leave(id, 1_000 * T, 0);
        }
        _repay(l); // late: the release rule now holds for every bucket
        _skipFresh(8 days);
        v5.pokeFees(id);
        assertEq(_gen(id).leaveHead[C.OTHERS], C.RETIRE_MAX, "one chunk a call");
        v5.pokeFees(id);
        assertEq(_gen(id).leaveHead[C.OTHERS], n, "the next poke resumes at the head");
        assertTrue(_solvent());
    }
}
