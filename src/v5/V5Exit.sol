// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICreditPoolV2} from "../interfaces/ICreditPoolV2.sol";
import {Env, C, IV5Events, IV5Errors} from "./V5Types.sol";
import {V5Storage as S} from "./V5Storage.sol";
import {V5Math as M} from "./V5Math.sol";
import {V5Core as K} from "./V5Core.sol";
import {V5Pos} from "./V5Pos.sol";
import {V5Steps} from "./V5Steps.sol";

/// @notice The inner leg of a keeper sell, which V5 calls on itself so a failure undoes it whole (2A.1 step 4).
interface IV5SellLeg {
    function sellLeg(uint256 tokens, uint256 minOut, address to, uint256 usdgValue) external returns (uint256 out);
}

/// @title V5Exit
/// @notice Every way stake leaves SeatVaultV5 (docs/PRIORS-UNDERWRITING-SPEC.md rev 5, 2.5, 2.6, 2A.1): the release
///         rule every payout path runs, `release`, both `releaseFor`s, `finishClose`, the exit queue (`queueExit`,
///         `fillExit`, keeper sells, `returnExit`), `claimSettled`, `collect` and `flush`. None calls a pausable pool
///         function, BuyAndBack, or a USDG transfer whose failure would revert a $PRIORS exit. A linked library.
library V5Exit {
    using SafeERC20 for IERC20;

    uint8 internal constant SKIP_RULE = 1;
    uint8 internal constant SKIP_WINDOW = 2;
    uint8 internal constant SKIP_FLOOR = 3;
    uint8 internal constant SKIP_DUST = 4;
    uint8 internal constant SKIP_FROZEN = 5;
    uint8 internal constant SKIP_LEG = 6;
    // V4SwapOnce's errors (IV4SwapOnce), by signature
    bytes4 internal constant TOO_LITTLE_OUT = bytes4(keccak256("TooLittleOut(uint256,uint256)"));
    bytes4 internal constant EXPIRED = bytes4(keccak256("Expired()"));
    uint256 internal constant NO_PER_SWAP_LIMIT = type(uint256).max; // a holder's own sale: only the live cap binds

    // ------------------------------------------------------------------
    // the release rule (2.5)
    // ------------------------------------------------------------------

    /// @notice 2.2's first steps for a payout path, then whether the generation's own conditions let a payout run:
    ///         a superseded generation needs nothing more (it can never burn); the latest needs no listed loan past
    ///         `defaultableAt` still `Active` after its `markDefault` attempt, every default of V5's root recorded
    ///         while the agent is defaulted, and, while V5's root sponsors it, the listed open loans equal to the pool's
    ///         `activeLoans`. A settled generation pays its remainders at once.
    function prep(Env memory e, uint256 id, uint32 genNo) internal returns (bool ok, bool settled) {
        K.Steps memory st = V5Steps.stepsFor(e, id, genNo, true);
        S.Gen storage g = S.layout().gens[id][genNo];
        if (g.status == C.SETTLED) return (true, true);
        if (S.layout().latest[id] != genNo) return (true, false);
        for (uint256 i = 0; i < g.listLen; i++) {
            if (st.ls[i].status == ICreditPoolV2.LoanStatus.Active && block.timestamp > st.ls[i].defaultableAt) {
                return (false, false);
            }
        }
        ICreditPoolV2.Agent memory ag = e.pool.getAgent(id);
        if (K.defaultUnseen(e, ag)) return (false, false);
        if (ag.sponsor == e.root && ag.activeLoans != g.listLen) return (false, false);
        return (true, false);
    }

    function ready(S.Leaving storage b) internal view returns (bool) {
        return b.releasableAt != 0 && block.timestamp >= b.releasableAt;
    }

    function _rec(uint256 id, uint32 genNo, uint8 layer, uint32 day, address holder)
        private
        view
        returns (S.Rec storage)
    {
        return S.layout().recs[id][genNo][layer][day][holder];
    }

    function _send(Env memory e, address to, uint256 tokens) private {
        if (tokens == 0) return;
        if (to == e.buyAndBack) S.layout().cReturned += tokens;
        e.priors.safeTransfer(to, tokens);
    }

    /// @dev A record's whole rest, paid as $PRIORS to its holder; unlinked from the queue if it was in it.
    function _payRest(Env memory e, uint256 id, uint32 genNo, uint8 layer, uint32 day, address holder)
        private
        returns (uint256 tokens)
    {
        S.Rec storage r = _rec(id, genNo, layer, day, holder);
        uint256 units = r.counted + r.uncounted;
        if (r.entry != 0) unlink(r.entry);
        tokens = V5Pos.debitRec(e, id, genNo, layer, day, holder, units);
        _send(e, holder, tokens);
    }

    /// @dev Bring the holder's position into its forced-move record when its layer has moved to leaving.
    function _materialize(Env memory e, uint256 id, uint32 genNo, uint8 layer, address holder) private {
        if (S.layout().gens[id][genNo].layerEnd[layer] != 0) V5Pos.resolve(e, id, genNo, layer, holder);
    }

    // ------------------------------------------------------------------
    // payouts
    // ------------------------------------------------------------------

    /// @notice `release` (2.5): the holder's own record in that day's backing-layer bucket. `minUsdgOut` 0 pays
    ///         $PRIORS and never swaps; above 0, a frozen holder is paid $PRIORS (`ReleasedFrozen`), else the stake is
    ///         sold in the holder's own transaction with the holder as the swap's recipient, every failure mapped to
    ///         `UsdgPathClosed`, `SplitNeeded`, or the swapper's own `TooLittleOut` and `Expired`.
    function release(uint256 id, uint32 genNo, uint32 day, uint256 minUsdgOut, uint256 deadline) external {
        Env memory e = K.env();
        uint256 tokens = _releaseDebit(e, id, genNo, day);
        if (minUsdgOut == 0) {
            _send(e, msg.sender, tokens);
            emit IV5Events.Released(id, genNo, msg.sender, tokens, 0);
            return;
        }
        (bool okRead, bool frozen) = K.isFrozen(e, msg.sender);
        if (!okRead) revert IV5Errors.UsdgPathClosed(3);
        if (frozen) {
            _send(e, msg.sender, tokens);
            emit IV5Events.ReleasedFrozen(id, genNo, msg.sender, tokens);
            return;
        }
        uint256 out = _sellOwn(e, tokens, minUsdgOut, deadline);
        emit IV5Events.Released(id, genNo, msg.sender, tokens, out);
    }

    /// @dev `release`'s release rule and debit: the caller's whole record in that day's bucket of its backing layer.
    function _releaseDebit(Env memory e, uint256 id, uint32 genNo, uint32 day) private returns (uint256) {
        S.Layout storage l = S.layout();
        S.Gen storage g = l.gens[id][genNo];
        if (g.status == C.NONE) revert IV5Errors.NoRecord();
        uint8 layer = K.backLayer(e, g, msg.sender);
        (bool ok, bool settled) = prep(e, id, genNo);
        _materialize(e, id, genNo, layer, msg.sender);
        S.Rec storage r = _rec(id, genNo, layer, day, msg.sender);
        uint256 units = r.counted + r.uncounted;
        if (units == 0) revert IV5Errors.NoRecord();
        if (!settled && (!ok || !ready(l.leaving[id][genNo][layer][day]))) revert IV5Errors.ReleaseNotReady();
        if (r.entry != 0) unlink(r.entry);
        return V5Pos.debitRec(e, id, genNo, layer, day, msg.sender, units);
    }

    /// @dev A holder's own sale (2.5): closed under the depth guard, a cache over 45 min or a snapshot over 2 h old;
    ///      at most the live cap, counted with this transaction's other user swaps.
    function _sellOwn(Env memory e, uint256 tokens, uint256 minUsdgOut, uint256 deadline)
        private
        returns (uint256 out)
    {
        if (K.depthGuard(e)) revert IV5Errors.UsdgPathClosed(4);
        uint160 sp = K.spot(e);
        K.userSwapCheck(e, M.value(tokens, sp), NO_PER_SWAP_LIMIT);
        e.priors.forceApprove(address(e.swapper), tokens);
        try e.swapper
        .swapExactIn(e.key, false, uint128(tokens), minUsdgOut, C.MAX_SQRT_MINUS_ONE, msg.sender, deadline) returns (
            uint256 paid, uint256 o
        ) {
            // a swap that stopped at its price limit sold only `paid`: the whole sale is refused and the record stays
            // the holder's, releasable as $PRIORS or again later (deep audit D-03)
            if (paid != tokens) revert IV5Errors.UsdgPathClosed(5);
            out = o;
        } catch (bytes memory err) {
            bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
            if (sel == TOO_LITTLE_OUT || sel == EXPIRED) {
                assembly {
                    revert(add(err, 0x20), mload(err))
                }
            }
            revert IV5Errors.UsdgPathClosed(5);
        }
        e.priors.forceApprove(address(e.swapper), 0);
    }

    /// @notice `releaseFor(id, gen, holder, day)` (2.5, 2A.1): anyone pays that backing-layer record to its holder as
    ///         $PRIORS: a mode-1 record once releasable; any record from `releasableAt` + 3 days; a queued one once its
    ///         3-day window has ended; a settled generation's at once.
    function releaseFor(uint256 id, uint32 genNo, address holder, uint32 day) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        S.Gen storage g = l.gens[id][genNo];
        if (g.status == C.NONE) revert IV5Errors.NoRecord();
        uint8 layer = K.backLayer(e, g, holder);
        (bool ok, bool settled) = prep(e, id, genNo);
        _materialize(e, id, genNo, layer, holder);
        S.Rec storage r = _rec(id, genNo, layer, day, holder);
        if (r.counted + r.uncounted == 0) revert IV5Errors.NoRecord();
        if (!settled) {
            S.Leaving storage b = l.leaving[id][genNo][layer][day];
            if (!ok || !ready(b)) revert IV5Errors.ReleaseNotReady();
            if (r.entry != 0) {
                if (block.timestamp < uint256(l.entries[r.entry].joinedAt) + C.USDG_WINDOW) {
                    revert IV5Errors.ReleaseNotReady();
                }
            } else if (r.mode != 1 && block.timestamp < uint256(b.releasableAt) + C.USDG_WINDOW) {
                revert IV5Errors.ReleaseNotReady();
            }
        }
        uint256 tokens = _payRest(e, id, genNo, layer, day, holder);
        emit IV5Events.Released(id, genNo, holder, tokens, 0);
    }

    /// @notice `finishClose` (2.5): pays the owner's closing record to the address that posted A, as $PRIORS, never
    ///         swapping: in modes 0 and 1 once its release rule holds; in mode 2 once its queue window has ended, or,
    ///         never queued, from `releasableAt` + 3 days; a settled generation's at once.
    function finishClose(uint256 id, uint32 genNo) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        S.Gen storage g = l.gens[id][genNo];
        if (g.status == C.NONE) revert IV5Errors.NoRecord();
        (bool ok, bool settled) = prep(e, id, genNo);
        uint64 end = g.layerEnd[C.OWNER];
        if (end == 0) revert IV5Errors.NoRecord();
        uint32 day = uint32(uint256(end) / 1 days);
        address holder = g.owner;
        V5Pos.resolve(e, id, genNo, C.OWNER, holder);
        S.Rec storage r = _rec(id, genNo, C.OWNER, day, holder);
        if (r.counted + r.uncounted == 0) revert IV5Errors.NoRecord();
        if (!settled) {
            S.Leaving storage b = l.leaving[id][genNo][C.OWNER][day];
            if (!ok || !ready(b)) revert IV5Errors.ReleaseNotReady();
            if (r.entry != 0) {
                if (block.timestamp < uint256(l.entries[r.entry].joinedAt) + C.USDG_WINDOW) {
                    revert IV5Errors.ReleaseNotReady();
                }
            } else if (r.mode == 2 && block.timestamp < uint256(b.releasableAt) + C.USDG_WINDOW) {
                revert IV5Errors.ReleaseNotReady();
            }
        }
        uint256 tokens = _payRest(e, id, genNo, C.OWNER, day, holder);
        emit IV5Events.Released(id, genNo, holder, tokens, 0);
    }

    /// @notice `claimSettled(id, gen, holder)` (2.6): anyone pays a settled generation's position of `holder` (every
    ///         layer, pending stake included, and the record its layer's forced move made of it) at once, as $PRIORS.
    function claimSettledPosition(uint256 id, uint32 genNo, address holder) external {
        Env memory e = K.env();
        // the first steps, as every payout path: a settle a hook made splits its fees here before any credit is read
        // (deep audit L-01), and a default only recorded, or overdue, settles here
        (, bool settled) = prep(e, id, genNo);
        if (!settled) revert IV5Errors.NotSettled();
        uint256 units;
        uint256 tokens;
        for (uint8 layer = 0; layer < 3; layer++) {
            (uint256 u, uint256 t) = _claimLayer(e, id, genNo, layer, holder);
            units += u;
            tokens += t;
        }
        if (units == 0) revert IV5Errors.NoRecord();
        _send(e, holder, tokens);
        emit IV5Events.SettledClaimed(id, genNo, holder, tokens);
    }

    /// @dev One layer of a settled position: the live position, or the record its layer's forced move made of it.
    function _claimLayer(Env memory e, uint256 id, uint32 genNo, uint8 layer, address holder)
        private
        returns (uint256 units, uint256 tokens)
    {
        S.Layout storage l = S.layout();
        S.Gen storage g = l.gens[id][genNo];
        V5Pos.resolve(e, id, genNo, layer, holder);
        uint64 end = g.layerEnd[layer];
        if (end != 0) {
            uint32 day = uint32(uint256(end) / 1 days);
            S.Rec storage r = _rec(id, genNo, layer, day, holder);
            units = r.counted + r.uncounted;
            if (units == 0) return (0, 0);
            if (r.entry != 0) unlink(r.entry);
            return (units, V5Pos.debitRec(e, id, genNo, layer, day, holder, units));
        }
        S.Pos storage pp = l.pos[id][genNo][layer][holder];
        units = pp.counted + pp.a0 + pp.a1;
        if (units == 0) return (0, 0);
        if (pp.d0 != 0) l.pend[id][genNo][layer][pp.d0 - 1].amount -= uint128(pp.a0);
        if (pp.d1 != 0) l.pend[id][genNo][layer][pp.d1 - 1].amount -= uint128(pp.a1);
        g.counted[layer] -= pp.counted;
        g.divisor -= pp.counted;
        g.pendingTok[layer] -= pp.a0 + pp.a1;
        if (holder == e.buyAndBack) g.cLive -= units; // C's live part leaves with it, as in `debitRec`
        pp.counted = 0;
        pp.a0 = 0;
        pp.a1 = 0;
        pp.d0 = 0;
        pp.d1 = 0;
        tokens = K.payUnits(e, g, layer, holder, units);
    }

    /// @notice `claimSettled(id, gen, holder, layer, day)` (2.6): one leaving record of a settled generation, at once.
    function claimSettledRecord(uint256 id, uint32 genNo, address holder, uint8 layer, uint32 day) external {
        Env memory e = K.env();
        (, bool settled) = prep(e, id, genNo); // as `claimSettledPosition`
        if (!settled) revert IV5Errors.NotSettled();
        if (layer > 2) revert IV5Errors.NoRecord();
        _materialize(e, id, genNo, layer, holder);
        S.Rec storage r = _rec(id, genNo, layer, day, holder);
        if (r.counted + r.uncounted == 0) revert IV5Errors.NoRecord();
        uint256 tokens = _payRest(e, id, genNo, layer, day, holder);
        emit IV5Events.SettledClaimed(id, genNo, holder, tokens);
    }

    // ------------------------------------------------------------------
    // the exit queue (2A.1)
    // ------------------------------------------------------------------

    /// @notice `queueExit` (2A.1): links one mode-2 record into the exit queue once its release rule holds; O(1). Only
    ///         the record's holder or V5's keeper (its pass, 2A.6) may call it (audit L-04): nobody else can choose the
    ///         moment a record is judged against the floor. A record worth less than $25 (question 43), valued at
    ///         min(cached median, week low) and never at live spot, is set to mode 1 instead and returns through
    ///         `releaseFor`; a record nobody queues still comes back as $PRIORS through anyone's `releaseFor` from
    ///         `releasableAt` + 3 days (2.5).
    function queueExit(uint256 id, uint32 genNo, address holder, uint8 layer, uint32 day) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        if (msg.sender != holder && msg.sender != l.keeper) revert IV5Errors.NotOwner();
        uint256 units = _queueable(e, id, genNo, holder, layer, day);
        S.Rec storage r = _rec(id, genNo, layer, day, holder);
        if (M.value(units, K.pDown()) < C.MODE2_FLOOR) {
            r.mode = 1;
            emit IV5Events.ExitSkipped(0, SKIP_DUST);
            return;
        }
        uint64 eid = ++l.nextEntry;
        l.entries[eid] = S.Entry({
            id: id,
            gen: genNo,
            layer: layer,
            day: day,
            holder: holder,
            joinedAt: uint64(block.timestamp),
            prev: 0,
            next: 0
        });
        r.entry = eid;
        _linkTail(eid);
        emit IV5Events.ExitQueued(eid, id, genNo, holder, units);
    }

    /// @dev `queueExit`'s checks: a mode-2 record of the holder's own layer, not queued, whose release rule holds now
    ///      (its first steps run), on a generation that is not settled.
    function _queueable(Env memory e, uint256 id, uint32 genNo, address holder, uint8 layer, uint32 day)
        private
        returns (uint256 units)
    {
        S.Gen storage g = S.layout().gens[id][genNo];
        if (g.status == C.NONE || layer > 2) revert IV5Errors.NoRecord();
        if (layer == C.OWNER ? holder != g.owner : layer != K.backLayer(e, g, holder)) revert IV5Errors.NoRecord();
        (bool ok, bool settled) = prep(e, id, genNo);
        _materialize(e, id, genNo, layer, holder);
        S.Rec storage r = _rec(id, genNo, layer, day, holder);
        units = r.counted + r.uncounted;
        if (units == 0 || r.mode != 2) revert IV5Errors.NoRecord();
        if (r.entry != 0) revert IV5Errors.AlreadyQueued();
        if (settled || !ok || !ready(S.layout().leaving[id][genNo][layer][day])) revert IV5Errors.ReleaseNotReady();
    }

    function _linkTail(uint64 eid) private {
        S.Layout storage l = S.layout();
        S.Entry storage en = l.entries[eid];
        en.prev = l.qTail;
        en.next = 0;
        if (l.qTail != 0) l.entries[l.qTail].next = eid;
        else l.qHead = eid;
        l.qTail = eid;
    }

    function _unlinkOnly(uint64 eid) private {
        S.Layout storage l = S.layout();
        S.Entry storage en = l.entries[eid];
        if (en.prev != 0) l.entries[en.prev].next = en.next;
        else l.qHead = en.next;
        if (en.next != 0) l.entries[en.next].prev = en.prev;
        else l.qTail = en.prev;
    }

    /// @notice Remove an entry wherever it sits, O(1), and clear its record's link.
    function unlink(uint64 eid) internal {
        S.Layout storage l = S.layout();
        S.Entry storage en = l.entries[eid];
        _unlinkOnly(eid);
        l.recs[en.id][en.gen][en.layer][en.day][en.holder].entry = 0;
        delete l.entries[eid];
    }

    function _toTail(uint64 eid) private {
        if (S.layout().qTail == eid) return;
        _unlinkOnly(eid);
        _linkTail(eid);
    }

    /// @notice Whether fills may run now (`exitServiceOpen`): V5 not paused, the breaker, the spot guard and the depth
    ///         guard off, the cache at most 45 min old, and D readable.
    function serviceOpen(Env memory e) internal view returns (bool) {
        if (K.paused() || S.layout().tripped || !K.cacheFresh()) return false;
        if (K.spotGuard(K.spot(e)) || K.depthGuard(e)) return false;
        (, bool ok) = e.limiter.liveDepth();
        return ok;
    }

    /// @dev The head, in 2A.1's order (after the release rule's first steps): a settled generation's entry is paid as
    ///      $PRIORS; one whose rule fails moves to the tail; one past its 3-day window is paid as $PRIORS. Returns
    ///      true when the entry may be served by a fill or a sale.
    function _headCheck(Env memory e, uint64 eid) private returns (bool serve) {
        S.Entry memory en = S.layout().entries[eid];
        (bool ok, bool settled) = prep(e, en.id, en.gen);
        if (settled || (ok && block.timestamp >= uint256(en.joinedAt) + C.USDG_WINDOW)) {
            uint256 t = _payRest(e, en.id, en.gen, en.layer, en.day, en.holder);
            emit IV5Events.ExitSkipped(eid, SKIP_WINDOW);
            emit IV5Events.ExitReturned(eid, t);
            return false;
        }
        if (!ok) {
            _toTail(eid);
            emit IV5Events.ExitSkipped(eid, SKIP_RULE);
            return false;
        }
        return true;
    }

    function _restOf(uint64 eid) private view returns (uint256) {
        S.Entry storage en = S.layout().entries[eid];
        S.Rec storage r = S.layout().recs[en.id][en.gen][en.layer][en.day][en.holder];
        return r.counted + r.uncounted;
    }

    /// @notice `fillExit` (2A.1, 2A.2), BuyAndBack only: an internal fill of the head at `sqrtFill`. `taken` is the
    ///         $PRIORS sent to BuyAndBack, min(maxTokens, V5's exit chunk, the entry's rest), or 0 with no transfer when
    ///         the head was paid as $PRIORS or moved to the tail. Never reverts on the release rule or the floor.
    function fillExit(uint256 entryId, uint256 maxTokens, uint160 sqrtFill)
        external
        returns (uint256 taken, address holder)
    {
        Env memory e = K.env();
        uint64 eid = uint64(entryId);
        if (eid == 0 || eid != S.layout().qHead) revert IV5Errors.NotHead();
        holder = S.layout().entries[eid].holder;
        K.breakerEval(); // defaults a hook recorded count before the latch is read (GHSA-g626); a trip here stands
        if (!serviceOpen(e) || sqrtFill == 0) return (0, holder);
        if (!_headCheck(e, eid)) return (0, holder);
        // the head's first steps may trip the breaker: no fill under it (2.2's order, deep audit D-02)
        if (S.layout().tripped) return (0, holder);
        taken = _fill(e, eid, maxTokens, sqrtFill);
    }

    function _fill(Env memory e, uint64 eid, uint256 maxTokens, uint160 sqrtFill) private returns (uint256 taken) {
        S.Entry memory en = S.layout().entries[eid];
        S.Rec storage r = _rec(en.id, en.gen, en.layer, en.day, en.holder);
        if (!M.meetsLeaveFloor(r.sqrtLeave, sqrtFill)) {
            _toTail(eid);
            emit IV5Events.ExitSkipped(eid, SKIP_FLOOR);
            return 0;
        }
        uint256 rest = r.counted + r.uncounted;
        if (M.value(rest, sqrtFill) < C.MIN_CHUNK) {
            _returnRest(e, eid, en, SKIP_DUST);
            return 0;
        }
        (uint256 d,) = e.limiter.liveDepth();
        taken = M.min256(M.min256(maxTokens, M.tokensForDown(_exitChunk(d), sqrtFill)), rest);
        if (taken == 0) return 0;
        uint256 tokens = _debitEntry(e, en, taken);
        if (_restOf(eid) == 0) unlink(eid);
        else _toTail(eid);
        e.priors.safeTransfer(e.buyAndBack, tokens);
        emit IV5Events.ExitFilled(eid, tokens, M.value(tokens, sqrtFill));
    }

    function _debitEntry(Env memory e, S.Entry memory en, uint256 units) private returns (uint256) {
        return V5Pos.debitRec(e, en.id, en.gen, en.layer, en.day, en.holder, units);
    }

    /// @dev Pay an entry's whole rest as $PRIORS (it leaves the queue), with the reason it was not sold.
    function _returnRest(Env memory e, uint64 eid, S.Entry memory en, uint8 why) private {
        uint256 t = _payRest(e, en.id, en.gen, en.layer, en.day, en.holder);
        emit IV5Events.ExitSkipped(eid, why);
        emit IV5Events.ExitReturned(eid, t);
    }

    /// @notice V5's exit chunk, a constant rule: the smaller of $250 and 0.35% of D.
    function _exitChunk(uint256 d) private pure returns (uint256) {
        return M.min256(C.EXIT_CHUNK_MAX, d * C.EXIT_CHUNK_BPS / 10_000);
    }

    /// @notice `returnExit` (2A.2 step 4), BuyAndBack only: after a fill whose USDG payment failed, the entry's rest
    ///         is paid as $PRIORS if its release rule holds (or its generation is settled), else it moves to the tail.
    function returnExit(uint256 entryId) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        uint64 eid = uint64(entryId);
        S.Entry memory en = l.entries[eid];
        if (eid == 0 || en.id == 0) revert IV5Errors.NotQueued();
        (bool ok, bool settled) = prep(e, en.id, en.gen);
        if (settled || (ok && ready(l.leaving[en.id][en.gen][en.layer][en.day]))) {
            uint256 t = _payRest(e, en.id, en.gen, en.layer, en.day, en.holder);
            emit IV5Events.ExitReturned(entryId, t);
        } else {
            _toTail(eid);
            emit IV5Events.ExitSkipped(entryId, SKIP_RULE);
        }
    }

    /// @dev A keeper sell's working values.
    struct Sell {
        uint160 sp;
        uint160 ref; // min(spot, median): the larger sqrtPriceX96
        uint256 d; // depth
        uint256 f; // live fee
        uint256 chunk; // USDG value of the chunk at ref
        uint256 tokens;
        uint256 x;
        uint256 minOut;
    }

    /// @notice `releaseFor(entryId, maxTokens)` (2A.1 step 2), the keeper only: one chunk of the head entry sold in
    ///         the pool, the leaver paid straight from the pool. Skips, writing nothing, under V5's pause, the
    ///         breaker, the spot or depth guard, a cache over 45 min, spot under the week low, and whenever the
    ///         SwapLimiter would refuse (f_live above 400 bps, a protocol swap already in this L2 block, under $5 of
    ///         the hour's budget) or the day's sell budget (1% of D) would cut the turn under $5.
    function keeperSell(uint256 entryId, uint256 maxTokens) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        uint64 eid = uint64(entryId);
        if (eid == 0 || eid != l.qHead) revert IV5Errors.NotHead();
        Sell memory s;
        K.breakerEval(); // defaults a hook recorded count before the latch is read (GHSA-g626); a trip here stands
        if (!_sellOpen(e, s)) return;
        if (!_headCheck(e, eid)) return;
        // the head's first steps may trip the breaker: no sale under it (2.2's order, deep audit D-02)
        if (l.tripped) return;
        S.Entry memory en = l.entries[eid];
        S.Rec storage r = _rec(en.id, en.gen, en.layer, en.day, en.holder);
        uint256 rest = r.counted + r.uncounted;
        if (M.value(rest, s.ref) < C.MIN_CHUNK) {
            uint256 t = _payRest(e, en.id, en.gen, en.layer, en.day, en.holder);
            emit IV5Events.ExitSkipped(eid, SKIP_DUST);
            emit IV5Events.ExitReturned(eid, t);
            return;
        }
        if (!_sizeSell(e, s, rest, maxTokens)) return;
        // the leaver's floor, at the floor price this sale would use: minOut ≥ 0.9 × the value at P recorded at leave
        if (10 * s.minOut < 9 * _valueUp(s.tokens, r.sqrtLeave)) {
            _toTail(eid);
            emit IV5Events.ExitSkipped(eid, SKIP_FLOOR);
            return;
        }
        (bool okRead, bool frozen) = K.isFrozen(e, en.holder);
        if (!okRead) return;
        if (frozen) {
            uint256 t = _payRest(e, en.id, en.gen, en.layer, en.day, en.holder);
            emit IV5Events.ExitSkipped(eid, SKIP_FROZEN);
            emit IV5Events.ExitReturned(eid, t);
            return;
        }
        try IV5SellLeg(address(this)).sellLeg(s.tokens, s.minOut, en.holder, s.x) returns (uint256 out) {
            V5Pos.debitRec(e, en.id, en.gen, en.layer, en.day, en.holder, s.tokens);
            l.sellSpent += s.x;
            if (_restOf(eid) == 0) unlink(eid);
            else _toTail(eid);
            emit IV5Events.ExitSold(entryId, s.tokens, out);
        } catch (bytes memory err) {
            if (err.length >= 4 && bytes4(err) == TOO_LITTLE_OUT) {
                // the leaver's leg failed (its floor missed inside the swap): its rest comes back as $PRIORS now
                uint256 t = _payRest(e, en.id, en.gen, en.layer, en.day, en.holder);
                emit IV5Events.ExitSkipped(eid, SKIP_LEG);
                emit IV5Events.ExitReturned(eid, t);
            }
            // any other failure (the hook, the PoolManager, the limiter) undid the leg: skip, writing nothing
        }
    }

    function _valueUp(uint256 tokens, uint160 sqrtP) private pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(tokens, 1 << 96, sqrtP, Math.Rounding.Ceil), 1 << 96, sqrtP, Math.Rounding.Ceil);
    }

    function _sellOpen(Env memory e, Sell memory s) private view returns (bool) {
        S.Layout storage l = S.layout();
        if (K.paused() || l.tripped || !K.cacheFresh()) return false;
        s.sp = K.spot(e);
        if (K.spotGuard(s.sp) || K.depthGuard(e)) return false;
        if (s.sp > l.price.ringMax) return false; // spot under the week's lowest daily median
        (uint256 f, bool okF) = e.limiter.liveFeeBps();
        if (!okF || f > e.limiter.expectedFeeBps() || e.limiter.swappedThisBlock()) return false;
        if (e.limiter.hourRemaining() < C.MIN_CHUNK) return false;
        (uint256 d, bool okD) = e.limiter.liveDepth();
        if (!okD) return false;
        s.f = f;
        s.d = d;
        s.ref = M.max160(s.sp, l.price.median);
        return true;
    }

    /// @dev The chunk: at most V5's exit chunk, the day's sell budget left, the hour's budget left and the entry's
    ///      rest; the size-aware floor min(spot, median) × (1 − f) × (1 − 2x/D − 1%), rounded up.
    function _sizeSell(Env memory e, Sell memory s, uint256 rest, uint256 maxTokens) private returns (bool) {
        S.Layout storage l = S.layout();
        uint32 d1 = K.today() + 1;
        if (l.sellDay != d1) {
            l.sellDay = d1;
            l.sellSpent = 0;
        }
        uint256 budget = s.d * C.SELL_BUDGET_BPS / 10_000;
        uint256 dayLeft = budget > l.sellSpent ? budget - l.sellSpent : 0;
        s.chunk = M.min256(M.min256(_exitChunk(s.d), dayLeft), e.limiter.hourRemaining());
        if (s.chunk < C.MIN_CHUNK) return false;
        s.tokens = M.min256(M.min256(rest, maxTokens), M.tokensForDown(s.chunk, s.ref));
        s.x = M.value(s.tokens, s.ref);
        if (s.x < C.MIN_CHUNK) return false;
        // x ≤ the chunk ≤ 0.35% of D, so 2x/D + 1% stays under 2% and dd > cut
        uint256 dd = s.d * 10_000;
        uint256 cut = 2 * s.x * 10_000 + s.d * 100;
        s.minOut = Math.mulDiv(s.x * (10_000 - s.f), dd - cut, 10_000 * dd, Math.Rounding.Ceil);
        return true;
    }
}
