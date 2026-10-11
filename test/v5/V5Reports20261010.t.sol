// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {V5Base} from "./V5Base.sol";
import {ICreditPoolV2} from "../../src/interfaces/ICreditPoolV2.sol";
import {IV5Errors, C} from "../../src/v5/V5Types.sol";

/// @dev Regressions for two reports filed on 2026-10-10 against SeatVaultV5 (root #8641) by @SuperSmile0426,
///      GHSA-g626-94q6-4c84 and GHSA-8pxr-7299-3f6j, both fixed in the next SeatVaultV5. Each `test_GHSA_*` fails on
///      the deployed source (11c1d28) and passes on the fixed one; the controls pass on both.

interface IMarkDefault {
    function markDefault(uint256 loanId) external;
}

interface IRefresh {
    function refresh(uint256 id) external;
}

/// @dev One transaction: mark the defaults that reach the breaker's threshold, then raise a line this contract may
///      raise (the agent's pool delegate, recorded by V5 more than 24 h earlier). No keeper can put a sync() between.
contract G626AtomicRaiser {
    function run(address pool, address v5, uint256[] calldata loans, uint256 id) external {
        for (uint256 i; i < loans.length; ++i) {
            IMarkDefault(pool).markDefault(loans[i]);
        }
        IRefresh(v5).refresh(id);
    }
}

/// @dev GHSA-g626-94q6-4c84: `onDefault` records a default in the breaker's buckets without evaluating them (spec 2.8,
///      "hooks record; they never evaluate"). On the deployed V5 (11c1d28) the paths that add a line or stake read the
///      stored latch `tripped`, so between hook records that reach the threshold and the next evaluation owners still
///      raised and opened. The fixed V5 evaluates the breaker in each of those paths before it reads the latch. Agents
///      0-4 default $50 each ($250, the floor); 5, 7 and 8 opened beforehand, unvouched. Every `test_GHSA_*` here fails
///      on the deployed source.
contract V5ReportG626BreakerTest is V5Base {
    uint256[5] internal defaulted;
    G626AtomicRaiser internal raiser;

    function _agentCount() internal pure override returns (uint256) {
        return 9;
    }

    function setUp() public override {
        super.setUp();
        raiser = new G626AtomicRaiser();
        // book 8 names the raiser as its pool delegate before it opens: open records it, its 24 h run from there
        vm.prank(_owner(agents[8]));
        pool.setDelegate(agents[8], address(raiser));
        for (uint256 i; i < 5; ++i) {
            _open(agents[i], 150_000 * T);
            defaulted[i] = _borrow(agents[i], 50 * U, 1 days);
        }
        _open(agents[5], 150_000 * T);
        _open(agents[7], 150_000 * T);
        _open(agents[8], 150_000 * T);
        // a keeper pass: the five loans are past their grace, nothing is recorded yet, so this sync() trips nothing
        _skipFresh(4 days + 1);
    }

    function _markFive() internal {
        for (uint256 i; i < 5; ++i) {
            pool.markDefault(defaulted[i]);
        }
        (,,,,,, uint256 recorded) = lens.totals();
        assertEq(recorded, 5, "the five onDefault hooks recorded their defaults");
        assertFalse(lens.breakerTripped(), "$250 recorded (the floor), the hooks evaluate nothing");
    }

    /// @dev The report's first case: a book opened before the defaults. Its owner's refresh evaluates the breaker
    ///      first, which trips, and raises nothing; no new root vouch.
    function test_GHSA_g626_refreshAfterHookRecordedThreshold_tripsAndRaisesNothing() public {
        _markFive();
        uint256 outBefore = pool.getAgent(ROOT).delegatedOut;
        vm.prank(_owner(agents[5]));
        v5.refresh(agents[5]);
        assertTrue(lens.breakerTripped(), "refresh evaluated the breaker before reading the latch");
        assertEq(pool.getAgent(agents[5]).delegatedIn, 0, "and raised nothing");
        assertEq(pool.getAgent(ROOT).delegatedOut, outBefore, "no root vouch added after the threshold");
        vm.prank(_owner(agents[7]));
        v5.refresh(agents[7]);
        assertEq(pool.getAgent(agents[7]).delegatedIn, 0);
    }

    /// @dev The report's second case: a book opened after the defaults. `open` evaluates first and refuses.
    function test_GHSA_g626_openAfterHookRecordedThreshold_refused() public {
        _markFive();
        (ICreditPoolV2.Consent memory c, bytes memory sig) = _consent(agents[6], ROOT, 0);
        vm.prank(_owner(agents[6]));
        vm.expectRevert(IV5Errors.BreakerOn.selector);
        v5.open(agents[6], 150_000 * T, false, c, sig);
    }

    /// @dev New stake: the owner's `back` evaluates first and refuses.
    function test_GHSA_g626_backAfterHookRecordedThreshold_refused() public {
        _markFive();
        vm.prank(_owner(agents[5]));
        vm.expectRevert(IV5Errors.BreakerOn.selector);
        v5.back(agents[5], 10_000 * T, false);
    }

    /// @dev Marking the threshold's defaults and raising in one transaction (no keeper can come between) raises
    ///      nothing: the raise's own evaluation trips the breaker, and the trip stands.
    function test_GHSA_g626_atomicMarkAndRaise_raisesNothing() public {
        uint256[] memory loans = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            loans[i] = defaulted[i];
        }
        raiser.run(address(pool), address(v5), loans, agents[8]);
        (,,,,,, uint256 recorded) = lens.totals();
        assertEq(recorded, 5);
        assertEq(pool.getAgent(agents[8]).delegatedIn, 0, "nothing raised in the transaction that recorded $250");
        assertTrue(lens.breakerTripped(), "the raise's evaluation tripped the breaker");
    }

    /// @dev `promote` grants promotion credit (a larger line): it evaluates first and refuses. Book 5 earns its step
    ///      (three counted $25 loans held 7 days, 14 days at T1) before the defaults are marked.
    function test_GHSA_g626_promoteAfterHookRecordedThreshold_refused() public {
        uint256 a = _borrow(agents[5], 25 * U, 8 days);
        uint256 b = _borrow(agents[5], 25 * U, 8 days);
        _skipFresh(7 days + 1);
        _repay(a);
        _repay(b);
        uint256 c0 = _borrow(agents[5], 25 * U, 8 days);
        _skipFresh(7 days + 1);
        _repay(c0);
        // reconciled now: promote's own first steps then record nothing new (a new record evaluates the breaker)
        v5.pokeFees(agents[5]);
        uint256 snap = vm.snapshotState();
        v5.promote(agents[5]);
        assertEq(_gen(agents[5]).tier, 2, "control: the book is promotable");
        vm.revertToState(snap);
        _markFive();
        vm.expectRevert(IV5Errors.BreakerOn.selector);
        v5.promote(agents[5]);
    }

    /// @dev The owner's pending stake waits while the breaker is on (2.7): a refresh's first steps would merge a warm
    ///      top-up into A; they evaluate the breaker before that merge, which trips, and the top-up keeps waiting.
    function test_GHSA_g626_ownerStakeDoesNotMergeAfterHookRecordedThreshold() public {
        _open(agents[6], 100_000 * T); // A under 3 x the T1 ceiling: the owner's top-up goes to A
        vm.prank(_owner(agents[6]));
        v5.back(agents[6], 10_000 * T, false);
        uint256 pend = _gen(agents[6]).pendingTok[C.OWNER];
        assertGt(pend, 0, "the top-up waits as A's pending stake");
        _skipFresh(1 days + 1);
        _markFive();
        vm.prank(_owner(agents[6]));
        v5.refresh(agents[6]);
        assertTrue(lens.breakerTripped(), "the merge's freeze evaluated the breaker");
        assertEq(_gen(agents[6]).pendingTok[C.OWNER], pend, "A's warm top-up does not merge while the breaker is on");
    }

    /// @dev What the fix keeps: a line vouched before the trip still draws after it (lines already vouched, as
    ///      documented), and a sync() still trips on its own.
    function test_GHSA_g626_lineVouchedBeforeTheTripStillDraws() public {
        vm.prank(_owner(agents[5]));
        v5.refresh(agents[5]);
        assertEq(pool.getAgent(agents[5]).delegatedIn, 50 * U, "raised before any default is marked");
        _markFive();
        v5.sync();
        assertTrue(lens.breakerTripped(), "sync() trips at $250");
        _borrowRaw(agents[5], 50 * U, 1 days);
        assertEq(pool.getAgent(agents[5]).principalOut, 50 * U, "the line vouched before the trip draws after it");
    }
}

/// @dev GHSA-8pxr-7299-3f6j: V5 keeps its own record of the agent's pool delegate (`open` and `noteDelegate` write it).
///      On the deployed V5 `refresh`'s `_mayRaise` and `canBorrow` accepted that record once 24 h old without asking the
///      pool, so a key the owner revoked at the pool still raised the line. The fixed V5 also requires the caller to be
///      the agent's controller at the pool now (`isController`, the check the pool's own borrow makes).
contract V5Report8pxrDelegateTest is V5Base {
    uint256 internal id;
    address internal formerKey = makeAddr("formerKey");
    address internal newKey = makeAddr("newKey");

    function setUp() public override {
        super.setUp();
        id = agents[0];
        vm.prank(_owner(id));
        pool.setDelegate(id, formerKey);
        _open(id, 150_000 * T); // open records the pool delegate and the time (V5Book._noteDelegate)
        _skipFresh(1 days); // DELEGATE_WAIT has run
    }

    /// @dev Control: a delegate still named at the pool, recorded 24 h ago, raises the line and reads as able to
    ///      borrow, on the deployed and the fixed V5 alike.
    function test_GHSA_8pxr_control_aCurrentDelegateStillRaises() public {
        assertTrue(v5.canBorrow(ROOT, id, 5 * U, 1 days, 0, formerKey, _owner(id), formerKey));
        vm.prank(formerKey);
        v5.refresh(id);
        assertEq(pool.getAgent(id).delegatedIn, 50 * U, "the named delegate raises the line");
    }

    /// @dev The report: the owner clears the key at the pool and nothing tells V5. The revoked key raises nothing,
    ///      reserves none of the root's backing, and `canBorrow` no longer names it.
    function test_GHSA_8pxr_revokedPoolDelegate_raisesNothing() public {
        vm.prank(_owner(id));
        pool.setDelegate(id, address(0));
        (address who,) = lens.delegateOf(id);
        assertEq(who, formerKey, "V5's record still names the revoked key (no noteDelegate)");
        uint256 freeBefore = pool.freeBacking(ROOT);
        vm.prank(formerKey);
        v5.refresh(id);
        assertEq(pool.getAgent(id).delegatedIn, 0, "the revoked key raises nothing");
        assertEq(pool.freeBacking(ROOT), freeBefore, "and reserves none of the root's backing");
        assertFalse(v5.canBorrow(ROOT, id, 5 * U, 1 days, 0, formerKey, _owner(id), formerKey), "the view agrees");
        // the owner's own refresh is unaffected
        vm.prank(_owner(id));
        v5.refresh(id);
        assertEq(pool.getAgent(id).delegatedIn, 50 * U);
    }

    /// @dev The owner replaces the key: the old one raises nothing at once, and the new one waits its own 24 h from
    ///      the moment V5 records it, as before.
    function test_GHSA_8pxr_replacedPoolDelegate_oldKeyRaisesNothing() public {
        vm.prank(_owner(id));
        pool.setDelegate(id, newKey);
        vm.prank(formerKey);
        v5.refresh(id);
        assertEq(pool.getAgent(id).delegatedIn, 0, "the replaced key raises nothing");
        assertFalse(v5.canBorrow(ROOT, id, 5 * U, 1 days, 0, formerKey, _owner(id), formerKey));
        vm.prank(newKey);
        v5.refresh(id);
        assertEq(pool.getAgent(id).delegatedIn, 0, "the new key is not V5's record yet");
        v5.noteDelegate(id);
        _skipFresh(1 days);
        vm.prank(newKey);
        v5.refresh(id);
        assertEq(pool.getAgent(id).delegatedIn, 50 * U, "24 h after V5 recorded it, the new key raises");
    }
}
