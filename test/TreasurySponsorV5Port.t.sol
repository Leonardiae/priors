// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CreditPool} from "../src/CreditPool.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {TreasurySponsorV5} from "../src/TreasurySponsorV5.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";
import {MockPonsFeeEscrow} from "../src/mocks/MockPonsFeeEscrow.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {IPonsFeeEscrow, IPonsFactoryCreator} from "../src/interfaces/IPonsFeeEscrow.sol";
import {TreasuryV5Base} from "./TreasurySponsorV5.t.sol";
import {ReentrantEscrow, LyingEscrow, StuckEscrow} from "./audit-v2/TreasuryV4Exploits.t.sol";

// v4's own tests, run against TreasurySponsorV5 on TreasuryV5Base (the same fixture plus an InviteBondV2 nobody
// deposits in unless the test says so). Copied from, in order:
//   test/TreasurySponsorV4.t.sol                 TreasurySponsorV4Test, TreasurySponsorV4MigrationTest
//   test/audit-v2/TreasuryV4Exploits.t.sol       TreasuryV4ExploitsTest (T07 and T14 changed for v5, said where)
//   test/audit-final/FinalAuditTreasury.t.sol    FinalAuditTreasuryImport
// with TreasurySponsorV4 renamed TreasurySponsorV5 and nothing else changed unless a comment says "v5:".
// test/TreasurySponsorV4Invariants.t.sol is ported in test/TreasurySponsorV5Invariants.t.sol, test/InviteBond.t.sol in
// test/InviteBondV2.t.sol (against InviteBondV2, the bond v5 reads).

contract TreasurySponsorV5PortTest is TreasuryV5Base {
    // ------------------------------------------------------------------
    // Identity
    // ------------------------------------------------------------------

    function test_adopt_onceOwnedAndFresh() public {
        TreasurySponsorV5 t = _newTreasury();
        vm.prank(agentOp);
        uint256 other = reg.register("other");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotOurs.selector, other));
        t.adopt(other);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        t.adopt(other);
        // an identity with a record (here: a root already) is refused even when it is ours
        vm.prank(rootOp);
        uint256 root = reg.register("root");
        vm.prank(rootOp);
        pool.enrollRoot(root, 10 * USDC);
        vm.prank(rootOp);
        reg.safeTransferFrom(rootOp, address(t), root);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotOurs.selector, root));
        t.adopt(root);
        // a fresh one, once
        vm.prank(owner);
        uint256 fresh = reg.register("fresh");
        vm.prank(owner);
        reg.safeTransferFrom(owner, address(t), fresh);
        vm.prank(owner);
        t.adopt(fresh);
        assertEq(t.agentId(), fresh);
        vm.prank(owner);
        vm.expectRevert(TreasurySponsorV5.AlreadyAdopted.selector);
        t.adopt(fresh);
    }

    // ------------------------------------------------------------------
    // Sweep
    // ------------------------------------------------------------------

    function test_sweep_splitsCreatorFeesIntoReserveAndStakeShares() public {
        _creatorFees(200 * USDC);
        uint256 reserveBefore = pool.reserve();
        vm.prank(anyone);
        (uint256 toReserve, uint256 toStake) = treasury.sweep();
        assertEq(toReserve, 100 * USDC);
        assertEq(toStake, 100 * USDC);
        assertEq(pool.reserve(), reserveBefore + 100 * USDC);
        CreditPoolV2.Agent memory r = pool.getAgent(TREASURY_ID);
        assertTrue(r.isRoot);
        assertApproxEqAbs(pool.backing(TREASURY_ID), 100 * USDC, 1);
        assertGt(pool.rootShares(TREASURY_ID), 0, "the stake is held as pool shares");
        _creatorFees(50 * USDC);
        treasury.sweep();
        assertApproxEqAbs(pool.backing(TREASURY_ID), 125 * USDC, 2);
        assertEq(treasury.totalStaked(), 125 * USDC);
        assertEq(treasury.totalToReserve(), 125 * USDC);
        assertEq(treasury.pendingStake(), 0);
        assertEq(usdc.balanceOf(address(treasury)), 0);
    }

    function test_sweep_holdsStakeUntilAdopted() public {
        TreasurySponsorV5 fresh = _newTreasury();
        usdc.mint(address(fresh), 40 * USDC);
        (uint256 toReserve, uint256 toStake) = fresh.sweep();
        assertEq(toReserve, 20 * USDC);
        assertEq(toStake, 0);
        assertEq(fresh.pendingStake(), 20 * USDC);
        assertEq(usdc.balanceOf(address(fresh)), 20 * USDC, "the stake half waits for an identity");
    }

    /// A paused pool refuses new stake; the sweep still funds the reserve and keeps the stake share waiting.
    function test_sweep_holdsStakeWhilePoolPaused() public {
        _creatorFees(100 * USDC);
        treasury.sweep();
        vm.prank(timelock);
        pool.pause();
        _creatorFees(40 * USDC);
        (uint256 toReserve, uint256 toStake) = treasury.sweep();
        assertEq(toReserve, 20 * USDC);
        assertEq(toStake, 0);
        assertEq(treasury.pendingStake(), 20 * USDC);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        (toReserve, toStake) = treasury.sweep();
        assertEq(toReserve, 0, "the waiting share is not split again");
        assertEq(toStake, 20 * USDC);
        assertEq(treasury.totalStaked(), 70 * USDC);
    }

    /// The stake share that waits below the minimum stake is not split again on the next sweep (v3 audit).
    function test_sweep_keepsAWaitingStakeShareOutOfTheReserve() public {
        TreasurySponsorV5 t = _newTreasury();
        vm.startPrank(owner);
        uint256 id = reg.register("priors-treasury-2");
        reg.safeTransferFrom(owner, address(t), id);
        t.adopt(id);
        vm.stopPrank();
        usdc.mint(address(t), 10 * USDC);
        uint256 reserve0 = pool.reserve();
        (uint256 toReserve, uint256 toStake) = t.sweep();
        assertEq(toReserve, 5 * USDC);
        assertEq(toStake, 0, "below the minimum: waits");
        for (uint256 i = 0; i < 25; i++) {
            vm.prank(anyone);
            (toReserve, toStake) = t.sweep();
            assertEq(toReserve, 0);
            assertEq(toStake, 0);
        }
        assertEq(pool.reserve(), reserve0 + 5 * USDC, "the reserve got its half once");
        usdc.mint(address(t), 10 * USDC);
        (toReserve, toStake) = t.sweep();
        assertEq(toReserve, 5 * USDC);
        assertEq(toStake, 10 * USDC);
        assertEq(t.pendingStake(), 0);
        assertTrue(pool.getAgent(id).isRoot);
        assertEq(t.totalToReserve(), 10 * USDC);
        assertEq(t.totalStaked(), 10 * USDC);
    }

    /// A unit of dust that would mint no share does not brick the permissionless sweep.
    function test_sweep_dustWaitsInsteadOfReverting() public {
        _funded();
        // raise the share price a little so one unit mints zero shares
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 30 days);
        _repay(agentOp, loan);
        assertEq(pool.convertToShares(1), 0);
        TreasurySponsorV5.Rules memory r = _rules();
        r.reserveBps = 0;
        vm.prank(owner);
        treasury.setRules(r);
        usdc.mint(address(treasury), 1);
        (uint256 toReserve, uint256 toStake) = treasury.sweep();
        assertEq(toReserve + toStake, 0);
        assertEq(treasury.pendingStake(), 1);
    }

    // ------------------------------------------------------------------
    // First line: invite + consent
    // ------------------------------------------------------------------

    /// One signature for the agent's owner: the inviter signed the invite, the owner signs the pool consent,
    /// anyone submits. The line opens and the agent can borrow at once.
    function test_firstLine_inviteAndConsent_anyoneSubmits() public {
        _funded();
        uint256 room = treasury.epochRoom();
        _firstLine(AGENT, AGENT_PK);
        CreditPoolV2.Agent memory a = pool.getAgent(AGENT);
        assertEq(a.sponsor, TREASURY_ID);
        assertEq(a.delegatedIn, 5 * USDC);
        assertEq(a.premiumBps, 0, "treasury lines carry no premium");
        assertEq(pool.nonces(AGENT), 1, "the consent was used");
        assertTrue(treasury.firstLined(AGENT));
        assertEq(treasury.lineAt(AGENT), vm.getBlockTimestamp());
        assertEq(treasury.epochRoom(), room - 5 * USDC);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        assertEq(pool.getLoan(loan).sponsorId, TREASURY_ID);
        // a line open now cannot be opened again, whatever the signatures
        bytes memory inv = _invite(AGENT, FAR - 1);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.AlreadyLined.selector, AGENT));
        treasury.firstLine(AGENT, FAR - 1, inv, c, sig);
    }

    /// Registration is permissionless; treasury money is not. Without an invite from a named inviter there is
    /// no line, whoever signs the consent.
    function test_firstLine_needsAnInvite() public {
        _funded();
        uint256 room = treasury.epochRoom();
        uint256 strangerPk = 0xBAD;
        bytes memory inv = _inviteBy(strangerPk, AGENT, FAR);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotInvited.selector, AGENT, vm.addr(strangerPk)));
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        assertEq(treasury.epochRoom(), room, "nothing spent");
        assertEq(pool.getAgent(AGENT).sponsor, 0);
    }

    /// The cheapest attack on the cap is lining identities that already exist. An invite alone does not do it:
    /// the identity's owner has to sign the consent, and a stranger's signature or a consent for another
    /// sponsor is refused by the pool. Nothing is spent.
    function test_firstLine_strangersCannotBurnTheCapOnOtherPeoplesIdentities() public {
        _funded();
        uint256 room = treasury.epochRoom();
        bytes memory inv = _invite(AGENT, FAR);
        // signed by a stranger claiming to own it
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, 0xBAD);
        vm.prank(anyone);
        vm.expectRevert(CreditPoolV2.BadConsent.selector);
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        // the owner's real signature, but naming another sponsor
        vm.prank(rootOp);
        uint256 root = reg.register("root");
        (c, sig) = _consentFor(AGENT, root, AGENT_PK);
        vm.prank(anyone);
        vm.expectRevert(CreditPoolV2.BadConsent.selector);
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        // a consent for another agent does not carry over either
        (c, sig) = _consent(AGENT2, AGENT2_PK);
        vm.prank(anyone);
        vm.expectRevert(CreditPoolV2.BadConsent.selector);
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        assertEq(treasury.epochRoom(), room, "nothing spent");
        assertFalse(treasury.inviteUsed(treasury.inviteDigest(AGENT, FAR)), "the invite is still good");
        // and the real pair works
        _firstLine(AGENT, AGENT_PK);
        assertEq(_line(AGENT), 5 * USDC);
    }

    /// A consent does not survive the NFT changing hands, and a delegate cannot consent for the owner.
    function test_firstLine_consentFollowsTheOwnerNotTheDelegate() public {
        _funded();
        bytes memory inv = _invite(AGENT, FAR);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(agentOp);
        reg.transferFrom(agentOp, agentOp2, AGENT);
        vm.expectRevert(CreditPoolV2.BadConsent.selector);
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        // the new owner's delegate signs: refused, consent is the owner's alone
        uint256 hotPk = 0x407;
        vm.prank(agentOp2);
        pool.setDelegate(AGENT, vm.addr(hotPk));
        (c, sig) = _consent(AGENT, hotPk);
        vm.expectRevert(CreditPoolV2.BadConsent.selector);
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        (c, sig) = _consent(AGENT, AGENT2_PK);
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        assertEq(_line(AGENT), 5 * USDC);
    }

    /// An invite names one identity and one deadline; it seats an agent once.
    function test_invite_isBoundToTheIdentityAndTheDeadline() public {
        _funded();
        bytes memory forAgent = _invite(AGENT, FAR);
        (CreditPoolV2.Consent memory c2, bytes memory sig2) = _consent(AGENT2, AGENT2_PK);
        vm.expectRevert(); // recovers to a different, un-named signer
        treasury.firstLine(AGENT2, FAR, forAgent, c2, sig2);
        uint64 soon = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes memory brief = _invite(AGENT, soon);
        vm.warp(soon + 1);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.InviteExpired.selector, AGENT, soon));
        treasury.firstLine(AGENT, soon, brief, c, sig);
        treasury.firstLine(AGENT, FAR, forAgent, c, sig);
        assertTrue(treasury.inviteUsed(treasury.inviteDigest(AGENT, FAR)));
    }

    function test_owner_revokesAnInviter() public {
        _funded();
        bytes memory inv = _invite(AGENT, FAR);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(owner);
        treasury.setInviter(inviter, false);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotInvited.selector, AGENT, inviter));
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        treasury.setInviter(anyone, true);
    }

    /// An agent backed elsewhere with no loan open moves to the treasury (the pool's handoff); with a loan open
    /// it cannot, and nothing is spent.
    function test_firstLine_handsOffFromAnotherSponsorOnlyWithNoLoanOpen() public {
        _funded();
        vm.prank(rootOp);
        uint256 root = reg.register("root");
        vm.prank(rootOp);
        pool.enrollRoot(root, 100 * USDC);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consentFor(AGENT, root, AGENT_PK);
        vm.prank(rootOp);
        pool.vouchWithConsent(root, AGENT, 20 * USDC, 0, c, sig);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        uint256 room = treasury.epochRoom();
        bytes memory inv = _invite(AGENT, FAR);
        (c, sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.LoanOpen.selector, AGENT));
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        assertEq(treasury.epochRoom(), room);
        _repay(agentOp, loan);
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        assertEq(pool.getAgent(AGENT).sponsor, TREASURY_ID);
        assertEq(_line(AGENT), 5 * USDC);
        assertEq(pool.getAgent(root).delegatedOut, 0, "the old sponsor got its line back");
    }

    /// An owner a default marked cannot borrow, so the treasury does not spend a line on it; a defaulted agent
    /// is refused by the pool.
    function test_firstLine_refusesMarkedOwnersAndDefaultedAgents() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 1 days);
        _default(loan);
        vm.prank(agentOp);
        uint256 fresh = reg.register("fresh");
        bytes memory inv = _invite(fresh, FAR);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(fresh, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.OwnerDefaulted.selector, agentOp));
        treasury.firstLine(fresh, FAR, inv, c, sig);
        inv = _invite(AGENT, FAR - 1);
        vm.prank(agentOp);
        reg.transferFrom(agentOp, agentOp2, AGENT);
        (c, sig) = _consent(AGENT, AGENT2_PK);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.AgentDefaulted.selector, AGENT));
        treasury.firstLine(AGENT, FAR - 1, inv, c, sig);
    }

    function test_epochCap_boundsWhatASybilCanDrain() public {
        _creatorFees(2_000 * USDC);
        treasury.sweep();
        uint256 n = 100 * USDC / (5 * USDC);
        uint256 pk = 0x5000;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(vm.addr(pk + i));
            uint256 id = reg.register("sybil");
            _firstLine(id, pk + i);
        }
        vm.prank(vm.addr(pk + n));
        uint256 extra = reg.register("sybil");
        bytes memory inv = _invite(extra, FAR);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(extra, pk + n);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.EpochCapReached.selector, 5 * USDC, 0));
        treasury.firstLine(extra, FAR, inv, c, sig);
        assertEq(treasury.epochRoom(), 0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(treasury.epochRoom(), 100 * USDC);
        (c, sig) = _consent(extra, pk + n);
        treasury.firstLine(extra, FAR, inv, c, sig);
    }

    /// Lines stand on the treasury's free backing: past it, the pool refuses and nothing is spent.
    function test_firstLine_boundedByTheTreasurysStake() public {
        _creatorFees(20 * USDC);
        treasury.sweep(); // 10 staked
        _firstLine(AGENT, AGENT_PK);
        _firstLine(AGENT2, AGENT2_PK);
        vm.prank(anyone);
        uint256 third = reg.register("third");
        uint256 room = treasury.epochRoom();
        bytes memory inv = _invite(third, FAR);
        uint256 thirdPk = 0x333;
        vm.prank(anyone);
        reg.transferFrom(anyone, vm.addr(thirdPk), third);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(third, thirdPk);
        vm.expectRevert();
        treasury.firstLine(third, FAR, inv, c, sig);
        assertEq(treasury.epochRoom(), room);
    }

    // ------------------------------------------------------------------
    // Reclaim: the pool's own timestamps, no watermark
    // ------------------------------------------------------------------

    function test_reclaim_anIdleLineGoesBackToTheTreasury() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        uint256 freeBefore = pool.freeBacking(TREASURY_ID);
        uint256 at = vm.getBlockTimestamp() + _idle();
        assertEq(treasury.reclaimableAt(AGENT), at);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotIdle.selector, AGENT, at));
        treasury.reclaim(AGENT);
        vm.warp(at);
        vm.prank(anyone);
        assertEq(treasury.reclaim(AGENT), 5 * USDC);
        CreditPoolV2.Agent memory a = pool.getAgent(AGENT);
        assertEq(a.delegatedIn, 0, "the vouch is gone");
        assertEq(a.sponsor, 0, "the sponsorship ended");
        assertTrue(a.enrolledAt != 0, "the record stays");
        assertEq(pool.freeBacking(TREASURY_ID), freeBefore + 5 * USDC, "capacity is back");
        assertEq(treasury.reclaimableAt(AGENT), 0);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NothingToReclaim.selector, AGENT));
        treasury.reclaim(AGENT);
        // the spent invite does not reopen the seat
        bytes memory old = _invite(AGENT, FAR);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.InviteUsed.selector, AGENT));
        treasury.firstLine(AGENT, FAR, old, c, sig);
    }

    /// Borrowing or repaying is activity (read from the pool); an open loan is never idle.
    function test_reclaim_sparesAnAgentThatUsesItsLine() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        uint256 lined = vm.getBlockTimestamp();
        vm.warp(lined + 20 days);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        // 31 days after the borrow the idle clock has run out, but the loan is still open (late, not yet marked)
        vm.warp(lined + 51 days);
        assertEq(treasury.reclaimableAt(AGENT), 0);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.LoanOpen.selector, AGENT));
        treasury.reclaim(AGENT);
        _repay(agentOp, loan);
        uint256 at = lined + 51 days + _idle();
        assertEq(treasury.reclaimableAt(AGENT), at, "the clock runs from the repayment");
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotIdle.selector, AGENT, at));
        treasury.reclaim(AGENT);
        vm.warp(at);
        assertEq(treasury.reclaim(AGENT), 5 * USDC);
    }

    /// The borrow clock alone also counts: a loan borrowed and still inside its term keeps the line.
    function test_reclaim_lastBorrowCountsEvenBeforeARepayment() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        vm.warp(vm.getBlockTimestamp() + 25 days);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 30 days);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        _repay(agentOp, loan); // repaid early, 35 days after the line opened
        assertEq(treasury.reclaimableAt(AGENT), vm.getBlockTimestamp() + _idle());
    }

    function test_reclaim_hasNothingToTakeFromADefault() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _default(loan);
        vm.warp(vm.getBlockTimestamp() + 60 days);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NothingToReclaim.selector, AGENT));
        treasury.reclaim(AGENT);
    }

    /// Reopening a reclaimed seat is a person's fresh decision: a new invite (and a new consent) works, the
    /// old invite does not, and the reopened line is the first line with a new idle clock.
    function test_firstLine_reopensAReclaimedSeatOnlyWithAFreshInvite() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        vm.warp(vm.getBlockTimestamp() + _idle());
        assertEq(treasury.reclaim(AGENT), 5 * USDC);
        uint64 later = uint64(vm.getBlockTimestamp() + 3 days);
        uint256 room = treasury.epochRoom();
        _firstLineWith(AGENT, AGENT_PK, later);
        assertEq(_line(AGENT), 5 * USDC);
        assertEq(treasury.epochRoom(), room - 5 * USDC);
        assertEq(treasury.reclaimableAt(AGENT), vm.getBlockTimestamp() + _idle());
    }

    // ------------------------------------------------------------------
    // Raise: a top-up vouch out of the treasury's own stake
    // ------------------------------------------------------------------

    function test_raise_onlyAfterACleanSeasonedRecord() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotEligible.selector, AGENT));
        treasury.raise(AGENT);
        _qualify(agentOp, AGENT);
        CreditPoolV2.Agent memory a = pool.getAgent(AGENT);
        assertEq(a.qualifiedRepaid, 3);
        assertGe(treasury.score(AGENT), 100);
        assertEq(treasury.score(AGENT), lens.score(AGENT), "same formula as the lens");
        assertTrue(treasury.eligibleForRaise(AGENT), "three qualified loans over 21 days, clean");
    }

    function test_raise_needsSeasoningAndQualifiedLoans() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        TreasurySponsorV5.Rules memory r = _rules();
        r.minSeasoning = 30 days;
        vm.prank(owner);
        treasury.setRules(r);
        _qualify(agentOp, AGENT);
        assertFalse(treasury.eligibleForRaise(AGENT), "21 days is not 30");
        vm.warp(vm.getBlockTimestamp() + 9 days);
        assertTrue(treasury.eligibleForRaise(AGENT));
        r.minQualified = 4;
        vm.prank(owner);
        treasury.setRules(r);
        assertFalse(treasury.eligibleForRaise(AGENT));
        r.minQualified = 3;
        r.minScore = 1001;
        vm.prank(owner);
        treasury.setRules(r);
        assertFalse(treasury.eligibleForRaise(AGENT));
    }

    function test_raise_topsUpToTheSecondTierAndChargesTheRaiseBudget() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertTrue(treasury.eligibleForRaise(AGENT));
        uint256 room = treasury.epochRoom();
        uint256 raiseRoom = treasury.raiseRoom();
        uint256 free = pool.freeBacking(TREASURY_ID);
        vm.prank(anyone);
        treasury.raise(AGENT);
        assertEq(_line(AGENT), 50 * USDC);
        assertEq(treasury.raiseRoom(), raiseRoom - 45 * USDC, "only the top-up is charged");
        assertEq(treasury.epochRoom(), room, "the first lines' room is untouched (M6)");
        assertEq(pool.freeBacking(TREASURY_ID), free - 45 * USDC, "out of the treasury's own stake");
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotEligible.selector, AGENT));
        treasury.raise(AGENT);
        // the raised line is usable at once
        _borrow(agentOp, AGENT, 50 * USDC, 7 days);
    }

    function test_raise_boundedByTheRaiseCap() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);
        vm.prank(owner);
        treasury.setRaiseCap(30 * USDC);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.RaiseCapReached.selector, 45 * USDC, 30 * USDC));
        treasury.raise(AGENT);
    }

    /// A reclaimed seat is closed: raise() does not reopen it, so reclaim/raise cannot be alternated to spend
    /// the epoch's budget on a line nobody holds (v3 audit).
    function test_raise_doesNotReopenAReclaimedSeat() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);
        vm.warp(vm.getBlockTimestamp() + _idle());
        assertEq(treasury.reclaim(AGENT), 5 * USDC);
        uint256 room = treasury.epochRoom();
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotEligible.selector, AGENT));
        treasury.raise(AGENT);
        assertEq(treasury.epochRoom(), room, "nothing spent");
    }

    /// A raise is activity: the bigger line gets its own idleAfter before anyone can take it back.
    function test_raise_refreshesTheIdleClock() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);
        vm.warp(vm.getBlockTimestamp() + _idle() - 1 days);
        treasury.raise(AGENT);
        uint256 at = vm.getBlockTimestamp() + _idle();
        assertEq(treasury.reclaimableAt(AGENT), at);
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotIdle.selector, AGENT, at));
        treasury.reclaim(AGENT);
        vm.warp(at);
        assertEq(treasury.reclaim(AGENT), 50 * USDC);
    }

    /// A frozen line is on its way back; it is never raised.
    function test_raise_refusesAFrozenLine() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);
        _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        vm.prank(owner);
        treasury.freeze(AGENT, true);
        assertFalse(treasury.eligibleForRaise(AGENT));
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotEligible.selector, AGENT));
        treasury.raise(AGENT);
    }

    /// An agent whose owner a default marked (with another identity) is not raised.
    function test_raise_refusesAMarkedOwner() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);
        vm.prank(agentOp);
        uint256 other = reg.register("other");
        _firstLine(other, AGENT_PK);
        uint256 bad = _borrow(agentOp, other, 5 * USDC, 1 days);
        _default(bad);
        assertFalse(treasury.eligibleForRaise(AGENT));
    }

    function test_raise_seededAgentsAreNeverRaisedByRule() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);
        uint256[] memory ids = new uint256[](1);
        ids[0] = AGENT;
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        treasury.setSeeded(ids, true);
        vm.prank(owner);
        treasury.setSeeded(ids, true);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotEligible.selector, AGENT));
        treasury.raise(AGENT);
        vm.prank(owner);
        treasury.setSeeded(ids, false);
        treasury.raise(AGENT);
        assertEq(_line(AGENT), 50 * USDC);
    }

    // ------------------------------------------------------------------
    // Defaults, fees
    // ------------------------------------------------------------------

    /// A default burns the treasury's own shares worth the principal and the unpaid fee (fee lock, 2026-09-24).
    /// Lenders do not move by a unit.
    function test_default_slashesTheTreasuryLendersUntouched() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        uint256 backing0 = pool.backing(TREASURY_ID) - 5 * USDC - pool.getLoan(loan).fee;
        uint256 lenderValue = pool.convertToAssets(pool.shares(lender));
        _default(loan);
        backing0 += pool.getLoan(loan).fee * pool.rootShares(TREASURY_ID) / pool.totalShares(); // its cut of the fee
        assertApproxEqAbs(pool.backing(TREASURY_ID), backing0, 1, "the treasury pays");
        assertGe(pool.convertToAssets(pool.shares(lender)), lenderValue, "lenders whole");
        assertEq(pool.totalBadDebt(), 0);
        assertEq(pool.getAgent(TREASURY_ID).childrenDefaulted, 1);
        assertEq(pool.getAgent(TREASURY_ID).delegatedOut, 0, "the leftover came back");
    }

    function test_collect_sendsSponsorFeesToTheBuybackWallet() public {
        _funded();
        assertEq(treasury.collect(), 0, "nothing yet: no revert");
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 30 days);
        _repay(agentOp, loan);
        uint256 owed = pool.sponsorFees(TREASURY_ID);
        assertEq(owed, pool.getLoan(loan).sponsorCut);
        assertEq(pool.feesFrom(TREASURY_ID, AGENT), owed);
        vm.prank(anyone);
        assertEq(treasury.collect(), owed);
        assertEq(usdc.balanceOf(sink), owed);
        assertEq(treasury.totalCollected(), owed);
    }

    /// The treasury's stake earns the pool's lender yield; the owner takes free stake back as cash.
    function test_retire_unlocksFreeStakeWithItsYield() public {
        _creatorFees(200 * USDC);
        treasury.sweep(); // 100 staked
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 30 days);
        _repay(agentOp, loan);
        assertGt(pool.backing(TREASURY_ID), 100 * USDC, "lender yield on the stake");
        uint256 all = pool.rootShares(TREASURY_ID);
        vm.prank(owner);
        vm.expectRevert(); // 5 is still vouched
        treasury.retire(all, owner);
        uint256 free = pool.convertToShares(pool.freeBacking(TREASURY_ID));
        vm.prank(owner);
        uint256 out = treasury.retire(free, owner);
        assertGt(out, 95 * USDC);
        assertEq(usdc.balanceOf(owner), out);
        assertGe(pool.backing(TREASURY_ID), 5 * USDC);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        treasury.retire(1, anyone);
    }

    /// The treasury holds its root NFT, so only it can move the root's money or lines; nobody else, including
    /// the treasury's owner, can go around the rules at the pool.
    function test_rootIsOnlyReachableThroughTheTreasury() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotOwnerOf.selector, TREASURY_ID, owner));
        pool.unlock(TREASURY_ID, 1, owner);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotOwnerOf.selector, TREASURY_ID, owner));
        pool.vouch(TREASURY_ID, AGENT, 1 * USDC);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotOwnerOf.selector, TREASURY_ID, owner));
        pool.unvouch(TREASURY_ID, AGENT, 1 * USDC);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotOwnerOf.selector, TREASURY_ID, owner));
        pool.freeze(AGENT, true);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotOwnerOf.selector, TREASURY_ID, owner));
        pool.claimSponsorFees(TREASURY_ID, owner);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    /// Wind-down: freeze stops new borrows; loans out run to term and the line comes back as they close.
    function test_freeze_windsDownALineWithALoanOut() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        treasury.freeze(AGENT, true);
        vm.prank(owner);
        treasury.freeze(AGENT, true);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.IsFrozen.selector, AGENT));
        pool.borrow(AGENT, 5 * USDC, 7 days, agentOp, type(uint256).max);
        _repay(agentOp, loan);
        assertEq(pool.getAgent(AGENT).sponsor, 0);
        assertEq(pool.getAgent(TREASURY_ID).delegatedOut, 0);
        // a frozen seat is reopened only by a fresh invite
        _firstLineWith(AGENT, AGENT_PK, FAR - 7);
        assertEq(_line(AGENT), 5 * USDC);
    }

    function test_ownerControls_rulesSinkRecipientRescue() public {
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        treasury.setFeeSink(anyone);
        vm.startPrank(owner);
        vm.expectRevert(TreasurySponsorV5.InvalidAddress.selector);
        treasury.setFeeSink(address(0));
        treasury.setFeeSink(anyone);
        assertEq(treasury.feeSink(), anyone);
        TreasurySponsorV5.Rules memory r = TreasurySponsorV5.Rules({
            reserveBps: 3000,
            firstLine: 10 * USDC,
            secondLine: 80 * USDC,
            epochCap: 200 * USDC,
            epochLength: 1 days,
            minSeasoning: 1 days,
            minQualified: 1,
            minScore: 50,
            idleAfter: 10 days
        });
        treasury.setRules(r);
        assertEq(_rules().reserveBps, 3000);
        r.secondLine = 1 * USDC;
        vm.expectRevert(TreasurySponsorV5.InvalidRules.selector);
        treasury.setRules(r);
        r.secondLine = 80 * USDC;
        r.idleAfter = 0;
        vm.expectRevert(TreasurySponsorV5.InvalidRules.selector);
        treasury.setRules(r);
        r.idleAfter = 10 days;
        r.epochLength = 366 days;
        vm.expectRevert(TreasurySponsorV5.InvalidRules.selector);
        treasury.setRules(r);
        r.epochLength = 1 days;
        r.reserveBps = 10_001;
        vm.expectRevert(TreasurySponsorV5.InvalidRules.selector);
        treasury.setRules(r);
        treasury.transferCreatorFeeRecipient(launchToken, owner);
        assertEq(escrow.feeRecipientOf(launchToken), owner);
        vm.expectRevert(TreasurySponsorV5.UseSweep.selector);
        treasury.rescue(address(usdc), owner);
        vm.stopPrank();
        // another token credited by the escrow, and ETH
        MockUSDC other = new MockUSDC();
        other.mint(address(this), 7);
        other.approve(address(escrow), 7);
        escrow.creditToken(address(treasury), address(other), 7);
        vm.deal(address(this), 1 ether);
        escrow.credit{value: 1 ether}(address(treasury));
        vm.startPrank(owner);
        treasury.rescue(address(other), owner);
        treasury.rescue(address(0), owner);
        vm.stopPrank();
        assertEq(other.balanceOf(owner), 7);
        assertEq(owner.balance, 1 ether);
    }
}

/// v1 → v4: an agent with a v1 record may be invited (v3 refused any identity the pool knew), keeps its record,
/// and is raised by rule unless the owner flagged its v1 volume as protocol-seeded.
contract TreasurySponsorV5PortMigrationTest is TreasuryV5Base {
    CreditPool v1;
    address v1Owner = makeAddr("v1owner");

    function setUp() public override {
        usdc = new MockUSDC();
        reg = new MockIdentityRegistry();
        escrow = new MockPonsFeeEscrow();
        v1 = new CreditPool(IERC20(address(usdc)), IERC8004Identity(address(reg)), v1Owner);
        _deployPool(v1);
        _setUpTreasury();
        // v1 history: AGENT repays three week-long loans under a v1 root
        usdc.mint(lender, 1_000 * USDC);
        vm.startPrank(lender);
        usdc.approve(address(v1), type(uint256).max);
        v1.deposit(1_000 * USDC, lender);
        vm.stopPrank();
        vm.startPrank(rootOp);
        uint256 v1root = reg.register("v1root");
        usdc.approve(address(v1), type(uint256).max);
        v1.enrollRoot(v1root, 100 * USDC);
        v1.vouch(v1root, AGENT, 10 * USDC);
        vm.stopPrank();
        vm.prank(agentOp);
        usdc.approve(address(v1), type(uint256).max);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(agentOp);
            uint256 l = v1.borrow(AGENT, 5 * USDC, 7 days, agentOp);
            vm.warp(vm.getBlockTimestamp() + 7 days);
            vm.prank(agentOp);
            v1.repay(l);
        }
    }

    function test_importedAgent_canBeInvitedAndRaisedByItsRecord() public {
        pool.importFromV1(AGENT);
        assertTrue(pool.getAgent(AGENT).enrolledAt != 0, "known to v2");
        _funded();
        _firstLine(AGENT, AGENT_PK);
        assertEq(_line(AGENT), 5 * USDC);
        assertTrue(treasury.eligibleForRaise(AGENT), "the v1 record counts");
        treasury.raise(AGENT);
        assertEq(_line(AGENT), 50 * USDC);
    }

    function test_importedAgent_seededIsInvitedButNotRaised() public {
        pool.importFromV1(AGENT);
        uint256[] memory ids = new uint256[](1);
        ids[0] = AGENT;
        vm.prank(owner);
        treasury.setSeeded(ids, true);
        _funded();
        _firstLine(AGENT, AGENT_PK);
        assertEq(_line(AGENT), 5 * USDC);
        assertFalse(treasury.eligibleForRaise(AGENT));
    }

    /// A v1 loan open blocks a v2 line; nothing is spent.
    function test_v1LoanOpen_blocksTheFirstLine() public {
        _funded();
        vm.prank(agentOp);
        v1.borrow(AGENT, 5 * USDC, 7 days, agentOp);
        uint256 room = treasury.epochRoom();
        bytes memory inv = _invite(AGENT, FAR);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.V1Busy.selector, AGENT));
        treasury.firstLine(AGENT, FAR, inv, c, sig);
        assertEq(treasury.epochRoom(), room);
    }
}

contract TreasuryV5PortExploitsTest is TreasuryV5Base {
    uint256 constant MALLORY_PK = 0xBAD;
    address mallory = vm.addr(MALLORY_PK);

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /// A second treasury on the same pool, wired to `e`, adopted and named the same inviter.
    function _treasuryWith(address e) internal returns (TreasurySponsorV5 t, uint256 rootId) {
        t = _deployTreasury(IPonsFeeEscrow(e), IPonsFactoryCreator(e)); // v5: with its own InviteBondV2
        vm.startPrank(owner);
        rootId = reg.register("priors-treasury-alt");
        reg.safeTransferFrom(owner, address(t), rootId);
        t.adopt(rootId);
        t.setInviter(inviter, true);
        vm.stopPrank();
    }

    function _digestFor(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifying,
        uint256 id,
        uint64 expiry
    ) internal view returns (bytes32) {
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", ds, keccak256(abi.encode(TH, id, expiry))));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ==================================================================
    // T01  USDG drain of the treasury: no path for a stranger or even the owner via rescue
    // ==================================================================
    function test_T01_refuted_noStrangerPathMovesTreasuryUsdgAnywhereButThePool() public {
        _creatorFees(400 * USDC);
        usdc.mint(address(treasury), 100 * USDC); // direct funding (runbook 6.6)
        uint256 poolBefore = usdc.balanceOf(address(pool));
        uint256 strangerBefore = usdc.balanceOf(anyone);

        vm.startPrank(anyone);
        treasury.sweep();
        treasury.collect();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        treasury.retire(1, anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        treasury.rescue(address(usdc), anyone);
        vm.stopPrank();

        // the owner cannot pull the pool asset through rescue either
        vm.prank(owner);
        vm.expectRevert(TreasurySponsorV5.UseSweep.selector);
        treasury.rescue(address(usdc), owner);

        assertEq(usdc.balanceOf(address(treasury)), 0, "all swept");
        assertEq(usdc.balanceOf(address(pool)) - poolBefore, 500 * USDC, "every unit went to the pool");
        assertEq(usdc.balanceOf(anyone), strangerBefore, "stranger got nothing");
        assertEq(treasury.totalToReserve() + treasury.totalStaked(), 500 * USDC);
    }

    // ==================================================================
    // T02  fee theft / misrouting: collect always pays the sink, whoever calls
    // ==================================================================
    function test_T02_refuted_sponsorFeesOnlyReachTheSink() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 30 days);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _repay(agentOp, loan);
        uint256 owed = pool.sponsorFees(TREASURY_ID);
        assertGt(owed, 0);

        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        treasury.setFeeSink(anyone);
        // nobody but the treasury can claim its root's sponsor fees on the pool
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotOwnerOf.selector, TREASURY_ID, anyone));
        pool.claimSponsorFees(TREASURY_ID, anyone);

        uint256 sinkBefore = usdc.balanceOf(sink);
        vm.prank(anyone);
        treasury.collect();
        assertEq(usdc.balanceOf(sink) - sinkBefore, owed, "fees to the sink");
        assertEq(treasury.collect(), 0, "nothing twice");
    }

    // ==================================================================
    // T03  sweep() re-entered from an adversarial escrow (before and after paying)
    // ==================================================================
    function _reentrantRun(uint256 mode) internal {
        ReentrantEscrow e = new ReentrantEscrow();
        e.setMode(mode);
        (TreasurySponsorV5 t,) = _treasuryWith(address(e));
        uint256 amount = 400 * USDC;
        usdc.mint(address(this), amount);
        usdc.approve(address(e), amount);
        e.creditToken(address(t), address(usdc), amount);

        uint256 reserveBefore = pool.reserve();
        t.sweep();
        // nothing double counted: exactly half the arrival to the reserve, the other half staked, no residue
        assertEq(pool.reserve() - reserveBefore, amount / 2, "reserve got exactly its share");
        assertEq(t.totalToReserve(), amount / 2, "totalToReserve");
        assertEq(t.totalStaked(), amount / 2, "totalStaked");
        assertEq(t.pendingStake(), 0, "pendingStake");
        assertEq(usdc.balanceOf(address(t)), 0, "nothing left behind");
        assertApproxEqAbs(pool.backing(t.agentId()), amount / 2, 1, "stake behind the root");
    }

    function test_T03_refuted_reentrantEscrowBeforePaying() public {
        _reentrantRun(1);
    }

    function test_T03_refuted_reentrantEscrowAfterPaying() public {
        _reentrantRun(2);
    }

    /// Same, while the stake share must wait (pool paused): the waiting share is never split twice.
    function test_T03_refuted_reentrantEscrowWhileStakeWaits() public {
        ReentrantEscrow e = new ReentrantEscrow();
        e.setMode(1);
        (TreasurySponsorV5 t,) = _treasuryWith(address(e));
        usdc.mint(address(this), 400 * USDC);
        usdc.approve(address(e), 400 * USDC);
        e.creditToken(address(t), address(usdc), 400 * USDC);
        vm.prank(timelock);
        pool.pause();
        t.sweep();
        assertEq(t.totalToReserve(), 200 * USDC);
        assertEq(t.pendingStake(), 200 * USDC);
        // a second (and third) sweep while paused never carves the waiting share
        t.sweep();
        t.sweep();
        assertEq(t.totalToReserve(), 200 * USDC);
        assertEq(t.pendingStake(), 200 * USDC);
    }

    // ==================================================================
    // T04  lying balanceOfToken / short payment: only what arrives is split
    // ==================================================================
    function test_T04_refuted_lyingEscrowOnlyMovesWhatArrived() public {
        LyingEscrow e = new LyingEscrow();
        (TreasurySponsorV5 t,) = _treasuryWith(address(e));
        usdc.mint(address(e), 40 * USDC);
        e.set(1_000_000 * USDC, 40 * USDC); // claims a million, pays 40
        uint256 reserveBefore = pool.reserve();
        (uint256 toReserve, uint256 toStake) = t.sweep();
        assertEq(toReserve, 20 * USDC);
        assertEq(toStake, 20 * USDC);
        assertEq(pool.reserve() - reserveBefore, 20 * USDC);
        // reports a balance but pays nothing: sweep still settles what the treasury holds, no revert
        e.set(5 * USDC, 0);
        t.sweep();
        assertEq(t.totalToReserve(), 20 * USDC);
    }

    // ==================================================================
    // T06  EXPLOIT (Low, conditional): a claim that reverts bricks sweep(), and sweep() is the ONLY way USDG
    //      leaves the treasury, so directly funded USDG is stuck for as long as the escrow claim fails.
    // ==================================================================
    function test_T06_exploit_escrowClaimFailureStrandsTreasuryUsdg() public {
        StuckEscrow e = new StuckEscrow();
        (TreasurySponsorV5 t,) = _treasuryWith(address(e));
        // the Safe funds v4 directly (runbook 6.6)
        usdc.mint(address(t), 1_000 * USDC);

        vm.expectRevert(bytes("frozen"));
        t.sweep();

        vm.startPrank(owner);
        vm.expectRevert(TreasurySponsorV5.UseSweep.selector);
        t.rescue(address(usdc), owner); // the pool asset "only ever leaves through sweep"
        vm.expectRevert(); // no root stake to unlock: the money never reached the pool
        t.retire(1, owner);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(t)), 1_000 * USDC, "1,000 USDG stuck in the treasury");
    }

    // ==================================================================
    // T07  invite signature: cross-contract (v4 domain), other deployment, other chain, replay, malleability
    // ==================================================================
    /// v5: v4's test signed with version "3" (what the bot signed before v4) and expected "4" to work. On v5 the
    /// stale version is "4" (what the bot signs for v4 today) and the working one is "5". The bot reads the version
    /// from the treasury's eip712Domain(), so pointing it at v5 is the whole switch.
    function test_T07_refuted_v4DomainInviteIsRejected_v5DomainWorks() public {
        _funded();
        uint64 expiry = uint64(vm.getBlockTimestamp() + 3 days);
        bytes memory v4Sig =
            _sign(INVITER_PK, _digestFor("Priors Treasury", "4", block.chainid, address(treasury), AGENT, expiry));
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectPartialRevert(TreasurySponsorV5.NotInvited.selector);
        treasury.firstLine(AGENT, expiry, v4Sig, c, sig);

        // sanity: the correct v5 domain works with the same key
        bytes memory v5Sig =
            _sign(INVITER_PK, _digestFor("Priors Treasury", "5", block.chainid, address(treasury), AGENT, expiry));
        treasury.firstLine(AGENT, expiry, v5Sig, c, sig);
        assertEq(_line(AGENT), 5 * USDC);
        (, string memory name, string memory version,, address verifying,,) = treasury.eip712Domain();
        assertEq(name, "Priors Treasury");
        assertEq(version, "5");
        assertEq(verifying, address(treasury));
    }

    function test_T07_refuted_inviteBoundToContractAndChain() public {
        _funded();
        (TreasurySponsorV5 other,) = _treasuryWith(address(escrow));
        uint64 expiry = uint64(vm.getBlockTimestamp() + 3 days);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);

        // signed for another V4 deployment with the same inviter key
        bytes memory forOther = _sign(INVITER_PK, other.inviteDigest(AGENT, expiry));
        vm.expectPartialRevert(TreasurySponsorV5.NotInvited.selector);
        treasury.firstLine(AGENT, expiry, forOther, c, sig);

        // signed for this contract on another chain id
        bytes memory otherChain =
            _sign(INVITER_PK, _digestFor("Priors Treasury", "5", 1, address(treasury), AGENT, expiry)); // v5: "5"
        vm.expectPartialRevert(TreasurySponsorV5.NotInvited.selector);
        treasury.firstLine(AGENT, expiry, otherChain, c, sig);

        // after a chain fork the domain is recomputed: an invite signed pre-fork dies on the fork
        bytes memory here = _sign(INVITER_PK, treasury.inviteDigest(AGENT, expiry));
        vm.chainId(block.chainid + 1);
        (c, sig) = _consent(AGENT, AGENT_PK); // pool consent re-signed for the new chain, still valid
        vm.expectPartialRevert(TreasurySponsorV5.NotInvited.selector);
        treasury.firstLine(AGENT, expiry, here, c, sig);
    }

    function test_T07_refuted_replayAndMalleability() public {
        _funded();
        uint64 expiry = uint64(vm.getBlockTimestamp() + 3 days);
        bytes32 digest = treasury.inviteDigest(AGENT, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(INVITER_PK, digest);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        treasury.firstLine(AGENT, expiry, abi.encodePacked(r, s, v), c, sig);

        // the agent leaves, then tries the same invite again (and its malleated twin)
        vm.prank(agentOp);
        pool.leave(AGENT);
        (c, sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.InviteUsed.selector, AGENT));
        treasury.firstLine(AGENT, expiry, abi.encodePacked(r, s, v), c, sig);

        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.InviteUsed.selector, AGENT));
        treasury.firstLine(AGENT, expiry, twin, c, sig); // keyed by digest, so the twin is dead too

        // a fresh (unused) digest with a high-s signature is refused by OZ ECDSA outright
        uint64 expiry2 = expiry + 1;
        (v, r, s) = vm.sign(INVITER_PK, treasury.inviteDigest(AGENT, expiry2));
        twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, bytes32(n - uint256(s))));
        treasury.firstLine(AGENT, expiry2, twin, c, sig);
    }

    // ==================================================================
    // T08  EXPLOIT (Low): an invite is bound to the agent id, not to the person the inviter vetted.
    //      After the NFT changes hands, the buyer redeems the old invite, borrows and defaults.
    // ==================================================================
    /// v5: unchanged for an invite with no bond behind it (an admin-approved invite), which is what this test plays:
    /// v5 refuses the buyer only when a bond by another wallet sits on the agent. The bonded case is refused in
    /// TreasurySponsorV5Test.test_w9xg_buyerRedeemsSellersInvite_cannotBorrow_sellerBondComesBack.
    function test_T08_exploit_nftBuyerRedeemsSomeoneElsesInvite() public {
        _funded();
        uint64 expiry = uint64(vm.getBlockTimestamp() + 30 days); // the bot allows up to 720 h
        bytes memory inviteForAlice = _invite(AGENT, expiry); // the inviter vetted agentOp (Alice)

        // Alice sells / hands the identity to Mallory before redeeming
        vm.prank(agentOp);
        reg.transferFrom(agentOp, mallory, AGENT);

        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, MALLORY_PK);
        vm.prank(mallory);
        treasury.firstLine(AGENT, expiry, inviteForAlice, c, sig);
        assertEq(_line(AGENT), 5 * USDC, "Mallory holds a treasury line she was never invited to");

        uint256 stakeBefore = pool.backing(TREASURY_ID);
        vm.prank(mallory);
        uint256 loan = pool.borrow(AGENT, 5 * USDC, 30 days, mallory, type(uint256).max);
        _default(loan);
        assertEq(usdc.balanceOf(mallory), 5 * USDC, "Mallory keeps the principal");
        // since the 2026-09-24 fee lock the treasury also pays the unpaid fee, less its own cut of it
        uint256 fee = pool.getLoan(loan).fee;
        uint256 burnt = 5 * USDC + fee - fee * pool.rootShares(TREASURY_ID) / pool.totalShares();
        assertApproxEqAbs(stakeBefore - pool.backing(TREASURY_ID), burnt, 1, "treasury stake burnt");
    }

    // ==================================================================
    // T09  cap burning by strangers: a failing firstLine never charges the epoch
    // ==================================================================
    function test_T09_refuted_failedFirstLineDoesNotBurnTheCap() public {
        _funded();
        uint256 roomBefore = treasury.epochRoom();
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 days);
        bytes memory inv = _invite(AGENT, expiry);
        // a stranger holding a leaked invite but no owner consent
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, MALLORY_PK);
        vm.prank(mallory);
        vm.expectRevert(CreditPoolV2.BadConsent.selector);
        treasury.firstLine(AGENT, expiry, inv, c, sig);
        // a stranger self-signing an invite
        (c, sig) = _consent(AGENT, AGENT_PK);
        vm.prank(mallory);
        vm.expectPartialRevert(TreasurySponsorV5.NotInvited.selector);
        treasury.firstLine(AGENT, expiry, _inviteBy(MALLORY_PK, AGENT, expiry), c, sig);
        assertEq(treasury.epochRoom(), roomBefore, "cap untouched");
        assertFalse(treasury.inviteUsed(treasury.inviteDigest(AGENT, expiry)), "invite not burnt");
    }

    // ==================================================================
    // T10  EXPLOIT (Medium, economic): one invite -> a few cents of fees -> a permissionless raise to the second
    //      tier -> default. The treasury loses `secondLine` (50 USDG) per invite, 10x the first line.
    // ==================================================================
    function test_T10_exploit_farmRaiseThenDefault() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        uint256 opStart = usdc.balanceOf(agentOp);
        uint256 stakeStart = pool.backing(TREASURY_ID);

        // the cheapest record that passes the rules: 3 x minLoan (5 USDG) held exactly minScoreTerm (7 days)
        _qualify(agentOp, AGENT);
        assertTrue(treasury.eligibleForRaise(AGENT), "eligible after 21 days and ~3.5 cents of fees");
        assertGe(treasury.score(AGENT), 100);

        vm.prank(mallory); // anyone may raise
        treasury.raise(AGENT);
        assertEq(_line(AGENT), 50 * USDC);

        uint256 loan = _borrow(agentOp, AGENT, 50 * USDC, 30 days);
        vm.prank(agentOp);
        usdc.transfer(mallory, 50 * USDC); // walk away with it
        _default(loan);

        uint256 opEnd = usdc.balanceOf(agentOp) + usdc.balanceOf(mallory);
        uint256 profit = opEnd - opStart;
        emit log_named_decimal_uint("attacker net profit (USDG)", profit, 6);
        emit log_named_decimal_uint("treasury stake lost (USDG)", stakeStart - pool.backing(TREASURY_ID), 6);
        assertGt(profit, 49_900_000, "attacker nets ~50 USDG for one invite");
        assertGe(stakeStart - pool.backing(TREASURY_ID), 49 * USDC, "treasury loses the whole second line");
    }

    // ==================================================================
    // T11  reclaim / retire abuse
    // ==================================================================
    function test_T11_refuted_reclaimAndRetireCannotBeAbused() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        // a stranger cannot reclaim a live line before it is idle
        vm.prank(mallory);
        vm.expectPartialRevert(TreasurySponsorV5.NotIdle.selector);
        treasury.reclaim(AGENT);
        // an open loan blocks reclaim even when "idle" by the clock
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 30 days);
        vm.warp(vm.getBlockTimestamp() + 31 days);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.LoanOpen.selector, AGENT));
        treasury.reclaim(AGENT);
        _repay(agentOp, loan);
        // reclaim only returns the line to the treasury's own free backing; a stranger gains nothing
        uint256 malloryBefore = usdc.balanceOf(mallory);
        vm.warp(vm.getBlockTimestamp() + 31 days);
        vm.prank(mallory);
        treasury.reclaim(AGENT);
        assertEq(usdc.balanceOf(mallory), malloryBefore);
        assertEq(_line(AGENT), 0);
        // retire is owner-only and the pool refuses to unlock backing a line still uses
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        treasury.retire(1, mallory);
        _firstLineWith(AGENT2, AGENT2_PK, FAR);
        uint256 all = pool.rootShares(TREASURY_ID);
        vm.prank(owner);
        vm.expectPartialRevert(CreditPoolV2.InsufficientBacking.selector);
        treasury.retire(all, owner);
    }

    // ==================================================================
    // T12  adopt() front-running / making the adopted id non-fresh before its first sweep
    // ==================================================================
    function test_T12_refuted_nobodyCanTouchTheAdoptedIdBeforeEnrollment() public {
        // TREASURY_ID is adopted but not yet a root (no sweep yet). A hostile root tries to seat it as a child.
        vm.startPrank(rootOp);
        uint256 hostile = reg.register("hostile-root");
        pool.enrollRoot(hostile, 20 * USDC);
        CreditPoolV2.Consent memory c = CreditPoolV2.Consent({
            agentId: TREASURY_ID,
            sponsorId: hostile,
            owner: address(treasury),
            maxPremiumBps: 0,
            nonce: 0,
            deadline: block.timestamp + 1 days
        });
        vm.expectRevert(); // the treasury has no EIP-1271: no consent can ever validate for its id
        pool.vouchWithConsent(hostile, TREASURY_ID, 5 * USDC, 0, c, hex"");
        vm.stopPrank();
        // no v1 on this pool; with the runbook v1 is paused and a fresh id has no v1 record to import
        vm.expectRevert(CreditPoolV2.NoV1.selector);
        pool.importFromV1(TREASURY_ID);
        // the owner cannot be tricked into adopting a second, foreign id
        vm.prank(owner);
        vm.expectRevert(TreasurySponsorV5.AlreadyAdopted.selector);
        treasury.adopt(AGENT);
        // and the first sweep enrolls the root
        _funded();
        assertTrue(pool.getAgent(TREASURY_ID).isRoot);
    }

    // ==================================================================
    // T14  pool hooks: the treasury root's hook is the treasury itself, nobody can repoint it, and it never blocks exits
    // ==================================================================
    /// v5: v4 asserted the root had no hook. On v5 the hook is the treasury (set by the enrolling sweep); the rest of
    /// the test is v4's: nobody else can point it elsewhere, borrows and repayments pass for an unbonded agent, and
    /// leaving is never gated (a release notification cannot block, and the treasury's never fails).
    function test_T14_refuted_hookIsTheTreasuryItself_exitsNeverGated() public {
        _funded();
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotOwnerOf.selector, TREASURY_ID, anyone));
        pool.setHook(TREASURY_ID, address(escrow));
        assertEq(pool.hook(TREASURY_ID), address(treasury));
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _repay(agentOp, loan);
        vm.prank(agentOp);
        pool.leave(AGENT); // exit is never gated by the treasury
        assertEq(pool.getAgent(AGENT).sponsor, 0);
    }

    // ==================================================================
    // T15  rescue cannot pull the pool asset or the staked funds
    // ==================================================================
    function test_T15_refuted_rescueCannotReachAssetOrStake() public {
        _funded();
        uint256 shares = pool.rootShares(TREASURY_ID);
        vm.startPrank(owner);
        vm.expectRevert(TreasurySponsorV5.UseSweep.selector);
        treasury.rescue(address(usdc), owner);
        vm.expectRevert(); // pool shares are not a token: nothing to transfer
        treasury.rescue(address(pool), owner);
        treasury.rescue(address(0), owner); // ETH path: nothing there, sends 0
        vm.stopPrank();
        assertEq(pool.rootShares(TREASURY_ID), shares);
    }

    // ==================================================================
    // T16  creator-fee recipient: only the owner redirects, and fees already credited stay sweepable
    // ==================================================================
    function test_T16_refuted_recipientRedirectIsOwnerOnlyAndLeavesCreditedFeesSweepable() public {
        _creatorFees(100 * USDC); // credited while v4 is the recipient
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        treasury.transferCreatorFeeRecipient(launchToken, mallory);

        vm.prank(owner);
        treasury.transferCreatorFeeRecipient(launchToken, sink);
        assertEq(escrow.feeRecipientOf(launchToken), sink);
        // what the escrow owed v4 before the redirect is still v4's
        treasury.sweep();
        assertEq(treasury.totalToReserve() + treasury.totalStaked(), 100 * USDC);
    }

    // ==================================================================
    // T17  the pool cannot lose lender USDG through the treasury: a default burns only treasury shares
    // ==================================================================
    function test_T17_refuted_treasuryDefaultsNeverReachLenders() public {
        _funded();
        uint256 lenderAssets = pool.convertToAssets(pool.shares(lender));
        _firstLine(AGENT, AGENT_PK);
        _firstLine(AGENT2, AGENT2_PK);
        _default(_borrow(agentOp, AGENT, 5 * USDC, 30 days));
        _default(_borrow(agentOp2, AGENT2, 5 * USDC, 30 days));
        assertGe(pool.convertToAssets(pool.shares(lender)), lenderAssets, "lender value never falls");
        assertEq(pool.totalBadDebt(), 0);
    }
}

/// Final pre-mainnet audit, 2026-09-24: treasury v4 on a pool with a real v1 behind it (the importFromV1 path).
contract FinalAuditTreasuryV5PortImport is TreasuryV5Base {
    CreditPool v1;
    address v1Owner = makeAddr("v1-safe");
    uint256 v1Root;

    function setUp() public override {
        usdc = new MockUSDC();
        reg = new MockIdentityRegistry();
        escrow = new MockPonsFeeEscrow();
        v1 = new CreditPool(IERC20(address(usdc)), IERC8004Identity(address(reg)), v1Owner);
        _deployPool(v1);
        _setUpTreasury();
        vm.startPrank(timelock);
        _setBountyZero(); // launch value
        vm.stopPrank();

        // a v1 history: 3 week-long 5 USDG loans, repaid, before the cutover
        usdc.mint(rootOp, 1_000 * USDC);
        vm.startPrank(rootOp);
        usdc.approve(address(v1), type(uint256).max);
        v1.deposit(500 * USDC, rootOp);
        v1Root = reg.register("v1-root");
        v1.enrollRoot(v1Root, 50 * USDC);
        v1.vouch(v1Root, AGENT, 10 * USDC);
        vm.stopPrank();
        vm.prank(agentOp);
        usdc.approve(address(v1), type(uint256).max);
        for (uint256 i; i < 3; i++) {
            vm.prank(agentOp);
            uint256 l = v1.borrow(AGENT, 5 * USDC, 7 days, agentOp);
            vm.warp(vm.getBlockTimestamp() + 7 days);
            vm.prank(agentOp);
            v1.repay(l);
        }
        vm.prank(v1Owner);
        v1.pause(); // runbook 1.2
    }

    function _setBountyZero() internal {
        CreditPoolV2.Params memory p = pool.getParams();
        p.keeperBounty = 0;
        pool.setParams(p);
    }

    /// Info (T10 variant, not a larger bound): an imported v1 record with 3 qualified loans passes `raise` the
    /// moment `firstLine` lands, with no v2 loan and no seasoning on v2. Runbook §6 never calls `setSeeded`, and
    /// `seeded` only covers protocol-seeded records anyway. The loss per invite is the same `secondLine` as T10,
    /// and still bounded per epoch, by `raiseCap` on v5.
    function test_N4_importedRecordRaisesImmediatelyAfterFirstLine() public {
        _funded();
        pool.importFromV1(AGENT);
        assertEq(pool.getAgent(AGENT).qualifiedRepaid, 3);
        _firstLine(AGENT, AGENT_PK);
        assertTrue(treasury.eligibleForRaise(AGENT), "eligible in the same block as the first line");
        treasury.raise(AGENT);
        assertEq(_line(AGENT), 50 * USDC);

        uint256 before = pool.backing(TREASURY_ID);
        uint256 loan = _borrow(agentOp, AGENT, 50 * USDC, 1 days);
        _default(loan);
        assertGe(before - pool.backing(TREASURY_ID), 50 * USDC - 1, "treasury stake loses the whole second line");
    }
}
