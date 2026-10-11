// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICreditPoolV2} from "../interfaces/ICreditPoolV2.sol";
import {Env, C, IV5Events, IV5Errors} from "./V5Types.sol";
import {V5Storage as S} from "./V5Storage.sol";
import {V5Math as M} from "./V5Math.sol";
import {V5Core as K} from "./V5Core.sol";
import {V5Pos} from "./V5Pos.sol";
import {V5Steps} from "./V5Steps.sol";

/// @title V5Records
/// @notice The pool's hooks and the permissionless accounting calls (docs/PRIORS-UNDERWRITING-SPEC.md rev 5, 2.3,
///         2.4, 2.6, 2.8): `onBorrow` (an O(1) append), `onDefault` (split, burn, one breaker record, one points flag),
///         `onRelease` (a close with no burn when V5 no longer backs the agent), `recordLoan`, `recordDefault`,
///         `settle`, `pokeFees` / `recordRepay`, `promote` and `refresh`. A linked library run by DELEGATECALL.
library V5Records {
    // ------------------------------------------------------------------
    // hooks (the pool calls them inside its own lock; V5 skips them while it holds its own)
    // ------------------------------------------------------------------

    /// @notice An O(1) append (2.3): the loan with the generation, tier and `tierStep` at this moment, its `seen` bit,
    ///         and on a generation's first loan the open room's charge. It never calls the pool.
    function onBorrow(uint256 id, uint256 loanId) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        uint32 genNo = l.latest[id];
        S.Gen storage g = l.gens[id][genNo];
        S.LoanRec storage lr = l.loans[loanId];
        if (genNo == 0 || g.status != C.OPEN || lr.seen) return;
        lr.seen = true;
        lr.gen = genNo;
        lr.tier = g.tier;
        lr.tierStep = g.tierStep;
        lr.viaHook = true;
        g.list[g.listLen] = loanId;
        g.listLen += 1;
        if (!g.openRoomCharged) K.chargeOpenRoom(e, id, genNo, g);
        emit IV5Events.LoanRecorded(id, genNo, loanId, g.tier, true);
    }

    /// @notice A loan of V5's root defaulted (2.6). Inside the hook: one breaker record (no evaluation), and for a
    ///         loan of the agent's latest unsettled generation the split-only poke, the burn in one `_burn` and the
    ///         `pointsVoid` flag. O(1): it reads the pool only for a loan V5 had not seen.
    function onDefault(uint256 id, uint256 loanId, uint256 principal) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        S.LoanRec storage lr = l.loans[loanId];
        if (!lr.breakerSeen) {
            lr.breakerSeen = true;
            l.recordedDefaults += 1;
            uint32 day = K.today();
            if (block.timestamp > l.clearedAt) {
                K.addDay(l.defB, day, principal);
                emit IV5Events.BreakerRecorded(loanId, principal, day, true); // only a counted default (audit L-03)
            }
        }
        uint32 genNo = l.latest[id];
        if (genNo == 0) return;
        S.Gen storage g = l.gens[id][genNo];
        if (!lr.seen) {
            ICreditPoolV2.Loan memory ln = e.pool.getLoan(loanId);
            if (ln.issuedAt < g.openedAt) return;
            lr.seen = true;
            lr.gen = genNo;
            lr.tier = g.tier;
            lr.tierStep = g.tierStep;
        }
        if (lr.gen != genNo || g.status == C.SETTLED) return;
        V5Steps.settle(e, id, genNo, loanId, true);
    }

    /// @notice The sponsorship ended in the pool (leave, handoff, a frozen line's last loan, an unvouch of all of it):
    ///         the book closes with no burn, unless a default of its generation is known or may be unseen, which
    ///         `settle` or `sync(id)` then ends (2.6). A release of part of the line changes nothing.
    function onRelease(uint256 id) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        uint32 genNo = l.latest[id];
        S.Gen storage g = l.gens[id][genNo];
        if (genNo == 0 || g.status != C.OPEN) return;
        ICreditPoolV2.Agent memory ag = e.pool.getAgent(id);
        if (ag.sponsor == e.root) return;
        if (ag.defaulted) {
            if (g.defaultProof != 0 || K.defaultUnseen(e, ag)) return;
            ICreditPoolV2.Loan[] memory ls = K.fetchList(e, g);
            for (uint256 i = 0; i < ls.length; i++) {
                if (ls[i].status == ICreditPoolV2.LoanStatus.Defaulted) return;
            }
        }
        V5Pos.closeGen(e, id, genNo, 1, false, 4, true);
    }

    // ------------------------------------------------------------------
    // permissionless accounting
    // ------------------------------------------------------------------

    /// @notice `pokeFees` and `recordRepay`: 2.2's first steps on the agent's latest generation (reconciliation, then
    ///         the poke: the split, `releasableAt`, retirements, merges). Accounting only.
    function poke(uint256 id) external {
        Env memory e = K.env();
        if (S.layout().latest[id] == 0) revert IV5Errors.BookNotOpen();
        V5Steps.firstSteps(e, id, false);
    }

    /// @notice `recordLoan` (2.3): a loan of V5's root whose `onBorrow` failed, issued at or after the latest
    ///         generation's opening, recorded with that generation. Never counted. An open one is listed (and charges
    ///         the open room on a first loan); a repaid one applies only its lateness; a defaulted one is listed as the
    ///         settle's proof and entered in the breaker. Then the first steps run (a defaulted one settles there).
    function recordLoan(uint256 loanId) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        ICreditPoolV2.Loan memory ln = e.pool.getLoan(loanId);
        if (ln.sponsorId != e.root || ln.agentId == 0) revert IV5Errors.NotOurLoan();
        S.LoanRec storage lr = l.loans[loanId];
        if (lr.seen) revert IV5Errors.AlreadySeen();
        uint256 id = ln.agentId;
        uint32 genNo = l.latest[id];
        S.Gen storage g = l.gens[id][genNo];
        if (genNo == 0 || ln.issuedAt < g.openedAt) revert IV5Errors.NotOurLoan();
        lr.seen = true;
        lr.gen = genNo;
        lr.tier = g.tier;
        lr.tierStep = g.tierStep;
        if (!g.openRoomCharged) K.chargeOpenRoom(e, id, genNo, g);
        if (ln.status == ICreditPoolV2.LoanStatus.Repaid) {
            if (ln.closedAt > ln.dueAt) {
                lr.lateDone = true;
                V5Steps.applyLate(e, id, genNo, g, ln.closedAt);
            }
        } else if (ln.status == ICreditPoolV2.LoanStatus.Defaulted) {
            if (K.breakerDefault(e, loanId, ln)) K.breakerEval();
            if (g.defaultProof == 0) g.defaultProof = loanId;
        } else {
            g.list[g.listLen] = loanId;
            g.listLen += 1;
        }
        emit IV5Events.LoanRecorded(id, genNo, loanId, g.tier, false);
        V5Steps.firstSteps(e, id, false);
    }

    /// @notice `recordDefault` (2.6, 2.8): enters a defaulted loan of V5's root in the breaker once, whatever its
    ///         generation's state; for a loan of the agent's latest generation V5 had not seen, it also keeps it as that
    ///         generation's proof, so its payout paths settle with it.
    function recordDefault(uint256 loanId) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        ICreditPoolV2.Loan memory ln = e.pool.getLoan(loanId);
        if (ln.sponsorId != e.root || ln.status != ICreditPoolV2.LoanStatus.Defaulted) revert IV5Errors.NotOurLoan();
        bool rec = K.breakerDefault(e, loanId, ln);
        S.LoanRec storage lr = l.loans[loanId];
        uint32 genNo = l.latest[ln.agentId];
        S.Gen storage g = l.gens[ln.agentId][genNo];
        if (!lr.seen && genNo != 0 && ln.issuedAt >= g.openedAt) {
            lr.seen = true;
            lr.gen = genNo;
            lr.tier = g.tier;
            lr.tierStep = g.tierStep;
            if (g.status != C.SETTLED && g.defaultProof == 0) g.defaultProof = loanId;
            rec = true;
        }
        if (!rec) revert IV5Errors.AlreadySeen();
        K.breakerEval();
    }

    /// @notice `settle(id, gen, loanId)` (2.6): anyone, with a `Defaulted` loan of V5's root recorded with generation
    ///         `gen` (or, unseen, issued at or after its opening) as proof. Only the agent's latest generation can
    ///         meet it. Splits first, then burns once; on a settled generation the loan only enters the breaker.
    function settle(uint256 id, uint32 gen, uint256 loanId) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        uint32 genNo = l.latest[id];
        if (gen != genNo || genNo == 0) revert IV5Errors.BadProof();
        S.Gen storage g = l.gens[id][genNo];
        ICreditPoolV2.Loan memory ln = e.pool.getLoan(loanId);
        S.LoanRec storage lr = l.loans[loanId];
        // a Defaulted loan of V5's root and this agent, of this generation: recorded with it, or (unseen) issued at or
        // after its opening
        if (
            ln.status != ICreditPoolV2.LoanStatus.Defaulted || ln.sponsorId != e.root || ln.agentId != id || loanId == 0
                || (lr.seen ? lr.gen != genNo : ln.issuedAt < g.openedAt)
        ) revert IV5Errors.BadProof();
        if (!lr.seen) {
            lr.seen = true;
            lr.gen = genNo;
            lr.tier = g.tier;
            lr.tierStep = g.tierStep;
        }
        if (K.breakerDefault(e, loanId, ln)) K.breakerEval();
        if (g.status == C.SETTLED) return;
        if (g.defaultProof == 0) g.defaultProof = loanId;
        V5Steps.firstSteps(e, id, false);
    }

    // ------------------------------------------------------------------
    // tiers and the vouch
    // ------------------------------------------------------------------

    /// @notice `promote` (2.4): anyone, when 14 days have passed since `tierSince`, 3 loans counted at the current
    ///         `tierStep` (each at least 50% of the current ceiling), no late repayment listed or unreconciled, the
    ///         breaker, the depth guard and V5's pause off. One tier step per book per epoch follows from the wait:
    ///         every step sets `tierSince`, and 14 days on is always a later epoch. Grants `promoCredit`.
    function promote(uint256 id) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        K.Steps memory st = V5Steps.firstSteps(e, id, false);
        S.Gen storage g = l.gens[id][st.genNo];
        if (!st.hasBook || g.status != C.OPEN) revert IV5Errors.BookNotOpen();
        if (!st.readOk || g.ownerChanged) revert IV5Errors.OwnerChangedLatch();
        if (K.paused()) revert IV5Errors.Paused();
        K.breakerEval(); // defaults a hook recorded count before the latch is read (GHSA-g626)
        if (l.tripped) revert IV5Errors.BreakerOn();
        if (K.depthGuard(e)) revert IV5Errors.DepthGuardOn();
        uint64 ep = K.epochNow(e);
        if (g.tier >= 5) revert IV5Errors.NotPromotable(1);
        if (block.timestamp < uint256(g.tierSince) + C.PROMO_WAIT) revert IV5Errors.NotPromotable(2);
        if (g.countedAtTier < C.PROMO_COUNT) revert IV5Errors.NotPromotable(3);
        if (K.lateGuard(g, st.ls)) revert IV5Errors.NotPromotable(4);
        uint256 old = C.ceiling(g.tier);
        g.tier += 1;
        g.tierStep += 1;
        g.countedAtTier = 0;
        g.tierSince = uint64(block.timestamp);
        g.promoCredit = C.ceiling(g.tier) - old;
        g.promoEpoch = ep;
        emit IV5Events.Promoted(id, st.genNo, g.tier);
    }

    /// @dev `refresh`'s working values.
    struct Rf {
        uint256 v; // vouched now
        uint256 po; // principal out
        uint256 target;
        uint256 add;
        uint256 freeAdd;
        uint256 promoCharge;
        uint256 stakeCharge;
        uint160 sp;
        uint160 ob;
    }

    /// @notice `refresh` (2.3, 2.8, questions 37 and 40). Up: only the bound owner or its delegate recorded for 24 h
    ///         and still the agent's controller at the pool, and only with no guard on (the breaker evaluated first),
    ///         raises the pool's vouch toward the line valued as `canBorrow` values it,
    ///         free of room up to the room-charged line, above it charged to the promotion share (up to `promoCredit`)
    ///         and the stake share (within its per-book cap), within the fee headroom and `vouchCap`, rounded down to
    ///         $5. Down: the owner's (or delegate's) own refresh that may raise lowers only to max(that line, principal
    ///         out, $5); otherwise anyone lowers an undrawn vouch to max(principal out, $5) once an hour has passed since
    ///         the book's latest raise, and before that to the line valued at min(median, week low) at kEff.
    function refresh(uint256 id) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        K.Steps memory st = V5Steps.firstSteps(e, id, false);
        S.Gen storage g = l.gens[id][st.genNo];
        if (!st.hasBook) revert IV5Errors.BookNotOpen();
        if (!K.cacheSet()) revert IV5Errors.NoPrice();
        ICreditPoolV2.Agent memory ag = e.pool.getAgent(id);
        if (ag.sponsor != e.root) return;
        Rf memory r;
        r.v = ag.delegatedIn;
        r.po = ag.principalOut;
        r.sp = K.spot(e);
        r.ob = K.lastObs(e);
        uint256 floor_ = M.max256(r.po, C.LINE_STEP);
        uint256 dt = floor_;
        // defaults a hook recorded count before `_mayRaise` reads the latch; a trip here stands (GHSA-g626)
        K.breakerEval();
        if (_mayRaise(e, id, g, st.readOk)) {
            uint256 lineUp =
                M.line(g.counted[C.OWNER], K.pFull(r.sp, r.ob), C.ceiling(g.tier), K.kEff(r.sp, r.ob, true));
            if (lineUp > r.v) {
                _raise(e, id, st.genNo, g, r, lineUp);
                return;
            }
            // the owner's (or its delegate's) own refresh lowers only to its line: never under what it still covers
            dt = M.max256(lineUp, floor_);
        } else if (block.timestamp < uint256(g.lastRaiseAt) + C.RAISE_HOLD && g.status == C.OPEN) {
            uint256 lineDown = M.line(g.counted[C.OWNER], K.pDown(), C.ceiling(g.tier), K.kEff(0, 0, false));
            dt = M.max256(lineDown, floor_);
        }
        if (r.v > dt) {
            e.pool.unvouch(e.root, id, r.v - dt);
            emit IV5Events.Refreshed(id, st.genNo, dt);
        }
    }

    function _mayRaise(Env memory e, uint256 id, S.Gen storage g, bool readOk) private view returns (bool) {
        S.Layout storage l = S.layout();
        if (g.status != C.OPEN || g.ownerChanged || !readOk) return false;
        if (msg.sender != g.owner) {
            S.Delegate storage d = l.delegates[id];
            if (msg.sender != d.who || d.who == address(0) || block.timestamp < uint256(d.at) + C.DELEGATE_WAIT) {
                return false;
            }
            // and still the agent's controller at the pool: a key the owner cleared or replaced there raises nothing,
            // whether or not anyone has called `noteDelegate` since (GHSA-8pxr)
            if (!e.pool.isController(id, msg.sender)) return false;
        }
        S.Price storage p = l.price;
        if (K.paused() || l.tripped || !K.cacheFresh() || !p.feeOk || p.feeBps > C.FEE_CEILING_BPS) return false;
        return !K.depthGuard(e);
    }

    function _raise(Env memory e, uint256 id, uint32 genNo, S.Gen storage g, Rf memory r, uint256 lineUp) private {
        K.rollRooms(e);
        _shares(e, g, r, lineUp);
        _limit(e, r);
        if (r.add == 0) return; // nothing the rooms, the headroom or the cap allow now
        _charge(e, id, genNo, g, r);
        g.lastRaiseAt = uint64(block.timestamp);
        e.pool.vouch(e.root, id, r.add);
        emit IV5Events.Refreshed(id, genNo, r.v + r.add);
    }

    /// @dev 2.8's attribution: free up to the room-charged line; above it, the part above max(paid,
    ///      ceiling[tier − 1]) to the promotion share up to `promoCredit` (usable until the end of the epoch after the
    ///      promotion), the rest to the stake share within its per-book cap.
    function _shares(Env memory e, S.Gen storage g, Rf memory r, uint256 lineUp) private view {
        uint256 paid = M.max256(g.roomLine, r.v);
        uint256 free_ = lineUp < g.roomLine ? lineUp : g.roomLine;
        r.freeAdd = free_ > r.v ? free_ - r.v : 0;
        uint256 charged = lineUp - r.v - r.freeAdd;
        if (charged != 0) {
            uint256 promoBase = M.max256(paid, g.tier > 1 ? C.ceiling(g.tier - 1) : 0);
            uint256 promoPart = lineUp > promoBase ? M.min256(lineUp - promoBase, charged) : 0;
            r.promoCharge = M.min256(promoPart, _promoLeft(e, g));
            // the rest of the raise (the part under ceiling[tier − 1] and what promoCredit does not cover)
            r.stakeCharge = M.min256(charged - r.promoCharge, _stakeLeft(e, g));
        }
        r.add = r.freeAdd + r.promoCharge + r.stakeCharge;
    }

    function _promoLeft(Env memory e, S.Gen storage g) private view returns (uint256) {
        S.Layout storage l = S.layout();
        uint256 promoShare = l.raiseRoom * C.PROMO_SHARE_BPS / 10_000;
        uint256 credit = K.epochNow(e) <= uint256(g.promoEpoch) + 1 ? g.promoCredit : 0;
        uint256 room = promoShare > l.promoUsed ? promoShare - l.promoUsed : 0;
        return M.min256(credit, room);
    }

    function _stakeLeft(Env memory e, S.Gen storage g) private view returns (uint256) {
        S.Layout storage l = S.layout();
        uint256 stakeShare = l.raiseRoom - l.raiseRoom * C.PROMO_SHARE_BPS / 10_000;
        uint256 room = stakeShare > l.stakeUsed ? stakeShare - l.stakeUsed : 0;
        uint256 bookCap = l.raiseRoom * C.STAKE_BOOK_BPS / 10_000;
        uint256 bookUsed = g.stakeEpoch == K.epochNow(e) + 1 ? g.stakeRaised : 0;
        uint256 bookLeft = bookCap > bookUsed ? bookCap - bookUsed : 0;
        return M.min256(room, bookLeft);
    }

    /// @dev The fee headroom on every vouch and the stage cap (2.3, question 34), rounded down to $5.
    function _limit(Env memory e, Rf memory r) private view {
        S.Layout storage l = S.layout();
        uint256 dOut = e.pool.getAgent(e.root).delegatedOut;
        uint256 hm = M.maxVouch(e.pool.freeBacking(e.root), dOut, l.premiumCap);
        if (r.add > hm) r.add = hm;
        uint256 capLeft = l.vouchCap > dOut ? l.vouchCap - dOut : 0;
        if (r.add > capLeft) r.add = capLeft;
        r.add = M.floor5(r.add);
    }

    /// @dev Charge only what is vouched: the free part first, then the promotion share, then the stake share.
    function _charge(Env memory e, uint256 id, uint32 genNo, S.Gen storage g, Rf memory r) private {
        S.Layout storage l = S.layout();
        uint256 rest = r.add > r.freeAdd ? r.add - r.freeAdd : 0;
        uint256 pc = M.min256(rest, r.promoCharge);
        uint256 sc = rest - pc;
        if (pc != 0) {
            g.promoCredit -= pc;
            l.promoUsed += pc;
            emit IV5Events.RoomCharged(id, genNo, 1, pc);
        }
        if (sc != 0) {
            uint64 ep1 = K.epochNow(e) + 1;
            if (g.stakeEpoch != ep1) {
                g.stakeEpoch = ep1;
                g.stakeRaised = 0;
            }
            g.stakeRaised += sc;
            l.stakeUsed += sc;
            emit IV5Events.RoomCharged(id, genNo, 2, sc);
        }
        g.roomLine += pc + sc;
    }

    // ------------------------------------------------------------------
    // the bound owner's switches, and per-position settings
    // ------------------------------------------------------------------

    /// @notice Auto-add on or off for the caller's positions in the agent's open generation (2A.1). Turning it on
    ///         refuses after an owner change or a failed registry read.
    function setAutoAdd(uint256 id, bool on) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        K.Steps memory st = V5Steps.firstSteps(e, id, false);
        S.Gen storage g = l.gens[id][st.genNo];
        if (!st.hasBook || g.status != C.OPEN) revert IV5Errors.BookNotOpen();
        if (on && (!st.readOk || g.ownerChanged)) revert IV5Errors.OwnerChangedLatch();
        uint8 layer = K.backLayer(e, g, msg.sender);
        l.pos[id][st.genNo][layer][msg.sender].autoAdd = on;
        if (msg.sender == g.owner) l.pos[id][st.genNo][C.OWNER][msg.sender].autoAdd = on;
        emit IV5Events.AutoAddSet(id, msg.sender, on);
    }

    /// @notice The bound owner's protocol-backing switch (question 11). Off moves C to leaving (mode 1) and erases the
    ///         book's points; on a settled generation it only sets the flag. On refuses after an owner change.
    function setProtocolBacking(uint256 id, bool on) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        K.Steps memory st = V5Steps.firstSteps(e, id, false);
        S.Gen storage g = l.gens[id][st.genNo];
        if (!st.hasBook) revert IV5Errors.BookNotOpen();
        if (msg.sender != g.owner) revert IV5Errors.NotOwner();
        if (on) {
            if (!st.readOk || g.ownerChanged) revert IV5Errors.OwnerChangedLatch();
            g.optOut = false;
        } else {
            g.optOut = true;
            if (g.status == C.OPEN) {
                V5Pos.moveOne(e, id, st.genNo, C.OWN, e.buyAndBack, K.pDown());
                K.erasePoints(e, g);
            }
        }
        emit IV5Events.ProtocolBackingSet(id, on);
    }

    /// @notice The bound owner's switch for others' backing (question 22, dormant until `openBacking`). Off refuses
    ///         new backs from anyone but the owner and BuyAndBack and moves others' backing to leaving, where it stays
    ///         burnable until released; once moved, the layer stays closed for this generation.
    function setOthersBacking(uint256 id, bool on) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        K.Steps memory st = V5Steps.firstSteps(e, id, false);
        S.Gen storage g = l.gens[id][st.genNo];
        if (!st.hasBook || g.status != C.OPEN) revert IV5Errors.BookNotOpen();
        if (msg.sender != g.owner) revert IV5Errors.NotOwner();
        if (on) {
            if (!st.readOk || g.ownerChanged || g.layerEnd[C.OTHERS] != 0) revert IV5Errors.BackingClosed();
            g.othersOff = false;
        } else {
            g.othersOff = true;
            V5Pos.endLayer(e, id, st.genNo, C.OTHERS, 1, K.pDown(), uint64(block.timestamp));
        }
        emit IV5Events.OthersBackingSet(id, on);
    }

    /// @notice `reconsent` (2.9): the bound owner signs a new consent, refused above V5's premium cap or under the
    ///         book's `targetPremiumBps`; forwarded with an amount of 0 and V5's own target premium.
    function reconsent(uint256 id, ICreditPoolV2.Consent memory c, bytes memory sig) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        K.Steps memory st = V5Steps.firstSteps(e, id, false);
        S.Gen storage g = l.gens[id][st.genNo];
        if (!st.hasBook || g.status != C.OPEN) revert IV5Errors.BookNotOpen();
        if (msg.sender != g.owner) revert IV5Errors.NotOwner();
        if (!st.readOk || g.ownerChanged) revert IV5Errors.OwnerChangedLatch();
        uint256 t = l.targetPremium[id];
        if (c.maxPremiumBps > l.premiumCap || c.maxPremiumBps < t) revert IV5Errors.PremiumCap();
        e.pool.vouchWithConsent(e.root, id, 0, t, c, sig);
    }

    /// @notice `noteDelegate` (C-F9): records the agent's pool delegate and the time, only when it differs from the
    ///         recorded one, so an unchanged delegate keeps its clock.
    function noteDelegate(uint256 id) external {
        Env memory e = K.env();
        _noteDelegate(e, id);
    }

    function _noteDelegate(Env memory e, uint256 id) private {
        S.Delegate storage d = S.layout().delegates[id];
        address who = e.pool.delegateOf(id);
        if (who == d.who) return;
        d.who = who;
        d.at = uint64(block.timestamp);
        emit IV5Events.DelegateNoted(id, who);
    }
}
