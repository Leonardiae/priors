// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICreditPoolV2} from "../interfaces/ICreditPoolV2.sol";
import {Env, C, IV5Events, IV5Errors} from "./V5Types.sol";
import {V5Storage as S} from "./V5Storage.sol";
import {V5Math as M} from "./V5Math.sol";

/// @notice V5's own view of its constructor immutables, which its linked libraries read with one staticcall.
interface IV5Env {
    function v5Env() external view returns (Env memory);
}

/// @title V5Core
/// @notice The light helpers every SeatVaultV5 library inlines (docs/PRIORS-UNDERWRITING-SPEC.md rev 5): time and
///         epochs, 2.2's bounded outside reads, the price terms and kEff, the guards, fee credits, the breaker's
///         records, engine 2's points, pulls and the user-swap limits. The heavy shared steps live in the linked
///         libraries V5Steps (2.2's first steps) and V5Pos (positions, buckets, moves, payouts).
library V5Core {
    using SafeERC20 for IERC20;

    /// @dev PoolV2Lib's `HookStarved()`: a `markDefault` that starved V5's hook reverts the whole payout (2.5).
    bytes4 internal constant HOOK_STARVED = bytes4(keccak256("HookStarved()"));
    /// @dev transient slot: the USDG one transaction's user swaps have used of the live cap (2A.1, review A-F12)
    bytes32 internal constant TX_SWAPS = keccak256("priors.seatvault.v5.txswaps");

    /// @notice V5's immutables, read by a staticcall to V5 itself (the libraries run in its context).
    function env() internal view returns (Env memory) {
        return IV5Env(address(this)).v5Env();
    }

    function today() internal view returns (uint32) {
        return uint32(block.timestamp / 1 days);
    }

    /// @notice (t − EPOCH0) ÷ 7 days; 0 before EPOCH0.
    function epochOf(Env memory e, uint256 t) internal pure returns (uint64) {
        return t <= e.epoch0 ? 0 : uint64((t - e.epoch0) / 7 days);
    }

    function epochNow(Env memory e) internal view returns (uint64) {
        return epochOf(e, block.timestamp);
    }

    function readWord(address target, bytes memory data) internal view returns (bool ok, uint256 word) {
        uint256 g = C.READ_GAS;
        if (gasleft() < g * 64 / 63 + 5000) revert IV5Errors.ReadStarved();
        assembly {
            ok := staticcall(g, target, add(data, 0x20), mload(data), 0, 0)
            if lt(returndatasize(), 32) { ok := 0 }
            if ok {
                returndatacopy(0, 0, 32)
                word := mload(0)
            }
        }
    }

    /// @notice The registry's `ownerOf(id)`; a revert, a short reply or a dirty address word is a failed read.
    function ownerOf(Env memory e, uint256 id) internal view returns (bool ok, address owner) {
        uint256 w;
        (ok, w) = readWord(e.registry, abi.encodeWithSelector(0x6352211e, id));
        if (ok && (w >> 160) != 0) ok = false;
        owner = address(uint160(w));
    }

    /// @notice USDG's `isFrozen(who)`; a reply other than 0 or 1 is a failed read.
    function isFrozen(Env memory e, address who) internal view returns (bool ok, bool frozen) {
        uint256 w;
        (ok, w) = readWord(address(e.usdg), abi.encodeWithSelector(0xe5839836, who));
        if (ok && w > 1) ok = false;
        frozen = w == 1;
    }

    function spot(Env memory e) internal view returns (uint160) {
        return uint160(uint256(e.poolManager.extsload(e.priceSlot)));
    }

    /// @notice The SeatSizer's latest keeper observation (0 if none).
    function lastObs(Env memory e) internal view returns (uint160) {
        uint256 n = e.sizer.obsCount();
        return n == 0 ? 0 : e.sizer.observation(n - 1);
    }

    function cacheSet() internal view returns (bool) {
        return S.layout().price.median != 0;
    }

    function cacheFresh() internal view returns (bool) {
        S.Price storage p = S.layout().price;
        return p.median != 0 && block.timestamp <= uint256(p.rawObsAt) + C.FRESH;
    }

    /// @notice P with every term: live spot, the keeper's latest observation, the cached median and the week low; in
    ///         sqrtPriceX96 the largest (question 39).
    function pFull(uint160 spot_, uint160 obs) internal view returns (uint160) {
        S.Price storage p = S.layout().price;
        return M.max160(M.max160(spot_, obs), M.max160(p.median, p.ringMax));
    }

    /// @notice Refresh-down's valuation: min(cached median, week low), never live spot (2.3, A-F4).
    function pDown() internal view returns (uint160) {
        S.Price storage p = S.layout().price;
        return M.max160(p.median, p.ringMax);
    }

    /// @notice kEff (doubled): the cached k, 3 while the cache is over 45 min old; with `range_` the k of range',
    ///         live spot and the observation as more entries (questions 33, 39); at least 2 while the cached fee is
    ///         above 400 bps or unread (question 41); never under `minDrawK` (question 34).
    function kEff(uint160 spot_, uint160 obs, bool range_) internal view returns (uint8 k) {
        S.Layout storage l = S.layout();
        S.Price storage p = l.price;
        if (!cacheFresh()) {
            k = C.K_WILD;
        } else {
            k = p.k;
            if (range_) {
                uint8 kr = M.kUp(M.max160(M.max160(p.ringMax, spot_), obs), p.ringMin);
                if (kr > k) k = kr;
            }
        }
        if ((!p.feeOk || p.feeBps > C.FEE_CEILING_BPS) && k < C.K_NORMAL) k = C.K_NORMAL;
        if (l.minDrawK > k) k = l.minDrawK;
    }

    function paused() internal view returns (bool) {
        return block.timestamp < S.layout().pausedUntil;
    }

    /// @notice One reading of the depth guard through the SwapLimiter's view: on when the view says `ok` false, the
    ///         snapshot is over 2 h old, or the term is under $500. The view gets a fixed budget, refused whole
    ///         (`ReadStarved`) when the caller did not leave it, and any failure of the view reverts the call: a starved
    ///         or failed read is never read as "on", so no caller can latch the guard by choosing its gas (deep audit
    ///         H-01; the limiter's views revert only `ReadStarved`, PROTOCOL-BUILD D6).
    function depthForm(Env memory e, bool medianForm) internal view returns (bool on) {
        uint160 m = S.layout().price.rawMedian;
        fixedBudget(C.DEPTH_READ_GAS);
        (uint256 term, uint256 age, bool ok) = e.limiter.depthTerm{gas: C.DEPTH_READ_GAS}(m, medianForm);
        on = !ok || age > C.SNAP_MAX_AGE || term < C.DEPTH_MIN;
    }

    /// @notice Refuse (`ReadStarved`) a call that cannot give an outside read its whole fixed budget `g` and finish.
    function fixedBudget(uint256 g) internal view {
        if (gasleft() < g * 64 / 63 + C.READ_MARGIN) revert IV5Errors.ReadStarved();
    }

    /// @notice 2.8's one predicate: `depthGuardOn`, the median-valued form or the live form.
    function depthGuard(Env memory e) internal view returns (bool) {
        return S.layout().price.depthOn || depthForm(e, true) || depthForm(e, false);
    }

    /// @notice The spot guard: `sync()`'s latch, or live spot at or under 0.80 × the cached median.
    function spotGuard(uint160 spot_) internal view returns (bool) {
        S.Price storage p = S.layout().price;
        return p.spotLatch || (p.median != 0 && M.atOrUnder80(spot_, p.median));
    }

    /// @notice Every call that adds stake or line refuses under these (2.8's list). The breaker is evaluated before its
    ///         latch is read, so defaults a hook recorded count (GHSA-g626); a refusal here reverts that trip with the
    ///         call, and the next `sync()` or `refresh` records it.
    function requireAddGuards(Env memory e, uint160 spot_) internal {
        if (paused()) revert IV5Errors.Paused();
        breakerEval();
        if (S.layout().tripped) revert IV5Errors.BreakerOn();
        if (depthGuard(e)) revert IV5Errors.DepthGuardOn();
        if (spotGuard(spot_)) revert IV5Errors.SpotGuardOn();
    }

    /// @notice No pending owner stake merges while this reads on (2.7): the breaker, `depthGuardOn` or the
    ///         median-valued form, none of which a transaction can move. The breaker is evaluated first, so defaults a
    ///         hook recorded count before any first steps merge A (GHSA-g626).
    function mergeFrozenA(Env memory e) internal returns (bool) {
        breakerEval();
        S.Layout storage l = S.layout();
        return l.tripped || l.price.depthOn || depthForm(e, true);
    }

    /// @notice A credit moved off a position or a record: to the holder's `claimable`, or C's to `protocolFeesOwed`.
    function creditTo(Env memory e, address holder, uint256 amount) internal {
        if (amount == 0) return;
        S.Layout storage l = S.layout();
        if (holder == e.buyAndBack) {
            l.holdersOwed -= amount;
            l.protocolFeesOwed += amount;
        } else {
            l.claimable[holder] += amount;
        }
    }

    /// @notice Which backing layer a holder's backing lives in: the bound owner's own backing and BuyAndBack's C in
    ///         one, everyone else's in the other (so question 22's switch moves others' backing in O(1)).
    function backLayer(Env memory e, S.Gen storage g, address holder) internal view returns (uint8) {
        return holder == g.owner || holder == e.buyAndBack ? C.OWN : C.OTHERS;
    }

    /// @notice Move a record's credit (its counted shares, from `creditedTo` up to the bucket's retirement index or
    ///         the current index) to its holder, before any change to its counted shares (2.2).
    function creditRec(Env memory e, S.Rec storage r, S.Leaving storage b, address holder, uint256 index) internal {
        uint256 cap = b.retired ? b.retireIndex : index;
        if (cap <= r.creditedTo) return;
        creditTo(e, holder, M.credit(r.counted, r.creditedTo, cap));
        r.creditedTo = cap;
    }

    /// @notice The layer and ledger side of every payout.
    function payUnits(Env memory e, S.Gen storage g, uint8 layer, address holder, uint256 units)
        internal
        returns (uint256 tokens)
    {
        S.Layout storage l = S.layout();
        g.tokens[layer] -= units;
        if (holder == e.buyAndBack) g.cUnits -= units;
        tokens = g.status == C.SETTLED ? M.remainderOf(units, rateOf(layer)) : units;
        l.ledger -= tokens;
    }

    function rateOf(uint8 layer) internal pure returns (uint256) {
        return layer == C.OWNER ? C.OWNER_BURN_BPS : C.BACK_BURN_BPS;
    }

    function listClearUpTo(S.Gen storage g, uint256 count) internal view returns (bool) {
        uint256 n = g.listLen;
        for (uint256 i = 0; i < n; i++) {
            if (g.list[i] <= count) return false;
        }
        return true;
    }

    /// @notice A default of V5's root the pool counted that V5 has not recorded: while the agent is defaulted and
    ///         the counts differ, a default of its latest generation may be unseen (2.6).
    function defaultUnseen(Env memory e, ICreditPoolV2.Agent memory a) internal view returns (bool) {
        if (!a.defaulted) return false;
        S.Layout storage l = S.layout();
        return e.pool.getAgent(e.root).childrenDefaulted - l.childBase > l.recordedDefaults;
    }

    /// @notice The open room's charge at a generation's first loan: the line `open` approved (2.8).
    function chargeOpenRoom(Env memory e, uint256 id, uint32 genNo, S.Gen storage g) internal {
        rollRooms(e);
        S.Layout storage l = S.layout();
        l.openUsed += g.openLine;
        g.openRoomCharged = true;
        emit IV5Events.RoomCharged(id, genNo, 0, g.openLine);
    }

    /// @notice Weekly rooms are fixed windows of `epochOf` (2.8).
    function rollRooms(Env memory e) internal {
        S.Layout storage l = S.layout();
        uint64 ep = epochNow(e) + 1;
        if (l.roomEpoch != ep) {
            l.roomEpoch = ep;
            l.openUsed = 0;
            l.promoUsed = 0;
            l.stakeUsed = 0;
        }
    }

    /// @notice After reconciliation every listed loan of an unsettled generation is open; the late guard sees one
    ///         past its `dueAt`.
    function lateGuard(S.Gen storage g, ICreditPoolV2.Loan[] memory ls) internal view returns (bool) {
        uint256 n = g.listLen;
        for (uint256 i = 0; i < n; i++) {
            if (ls[i].status == ICreditPoolV2.LoanStatus.Active && block.timestamp > ls[i].dueAt) return true;
        }
        return false;
    }

    struct Steps {
        uint32 genNo;
        bool readOk; // the registry read succeeded (a failed read refuses what adds stake or line)
        bool hasBook;
        ICreditPoolV2.Loan[] ls; // the listed loans after reconciliation (the first `listLen` entries)
    }

    function fetchList(Env memory e, S.Gen storage g) internal view returns (ICreditPoolV2.Loan[] memory ls) {
        uint256 n = g.listLen;
        ls = new ICreditPoolV2.Loan[](n);
        for (uint256 i = 0; i < n; i++) {
            ls[i] = e.pool.getLoan(g.list[i]);
        }
    }

    /// @notice Enter a defaulted loan of V5's root once (`breakerSeen`): into its `closedAt` day's bucket if that is
    ///         after the last `clear()` and within the last 30 days, and only then `BreakerRecorded`. Returns whether
    ///         this call saw it (it then counts in `recordedDefaults`, 2.6).
    function breakerDefault(Env memory e, uint256 loanId, ICreditPoolV2.Loan memory ln) internal returns (bool) {
        S.Layout storage l = S.layout();
        S.LoanRec storage lr = l.loans[loanId];
        if (lr.breakerSeen || ln.sponsorId != e.root) return false;
        lr.breakerSeen = true;
        l.recordedDefaults += 1;
        uint32 day = uint32(uint256(ln.closedAt) / 1 days);
        if (ln.closedAt > l.clearedAt && uint256(day) + C.BREAKER_DAYS > today()) {
            addDay(l.defB, day, ln.principal);
            // only a default the breaker counts is announced (audit L-03)
            emit IV5Events.BreakerRecorded(loanId, ln.principal, day, true);
        }
        return true;
    }

    function breakerRepaid(ICreditPoolV2.Loan memory ln) internal {
        S.Layout storage l = S.layout();
        uint32 day = uint32(uint256(ln.closedAt) / 1 days);
        if (uint256(day) + C.BREAKER_DAYS > today()) addDay(l.repB, day, ln.principal);
    }

    function addDay(S.DayBucket[30] storage bs, uint32 day, uint256 amount) internal {
        // callers pass only a day of the last 30 (day + 30 > today), so a slot holding another day holds an older one
        S.DayBucket storage b = bs[day % 30];
        if (b.day != day) {
            b.day = day;
            b.amount = 0;
        }
        b.amount += uint224(amount);
    }

    function sumDays(S.DayBucket[30] storage bs) internal view returns (uint256 sum) {
        uint256 t = today();
        for (uint256 i = 0; i < 30; i++) {
            S.DayBucket storage b = bs[i];
            if (b.amount != 0 && uint256(b.day) + C.BREAKER_DAYS > t) sum += b.amount;
        }
    }

    /// @notice The trip (outside hooks only): defaulted principal in 30 days ≥ max($250, 5% of counted repaid).
    function breakerEval() internal {
        S.Layout storage l = S.layout();
        if (l.tripped) return;
        uint256 d = sumDays(l.defB);
        if (d == 0) return;
        uint256 thr = M.max256(C.BREAKER_FLOOR, sumDays(l.repB) * C.BREAKER_BPS / 10_000);
        if (d >= thr) {
            l.tripped = true;
            emit IV5Events.BreakerTripped(d, thr);
        }
    }

    /// @dev `pts` is never 0: a counted loan is at least $25 for at least 8 days.
    function addPoints(Env memory e, S.Gen storage g, uint256 pts) internal {
        S.Layout storage l = S.layout();
        uint64 ep = epochNow(e);
        uint256 s = ep % 5;
        S.Slot storage bs = g.points[s];
        if (bs.epoch != ep) {
            bs.epoch = ep;
            bs.points = 0;
        }
        bs.points += uint192(pts);
        S.Slot storage gs = l.globalPts[s];
        if (gs.epoch != ep) {
            gs.epoch = ep;
            gs.points = 0;
        }
        gs.points += uint192(pts);
    }

    /// @notice Erase a book's points: each slot zeroed, a global total lowered only for a slot of a live epoch
    ///         (e−4..e) that the global slot still holds (2A.2).
    function erasePoints(Env memory e, S.Gen storage g) internal {
        S.Layout storage l = S.layout();
        uint64 ep = epochNow(e);
        for (uint256 i = 0; i < 5; i++) {
            S.Slot storage bs = g.points[i];
            uint192 p = bs.points;
            if (p == 0) continue;
            uint64 be = bs.epoch;
            S.Slot storage gs = l.globalPts[be % 5];
            if (be + 4 >= ep && gs.epoch == be) gs.points = gs.points > p ? gs.points - p : 0;
            bs.points = 0;
        }
    }

    /// @notice Pull from `msg.sender` only: by direct allowance, or through Permit2. The amount must arrive exact.
    function pull(Env memory e, IERC20 token, uint256 amount) internal {
        if (amount == 0) return;
        uint256 before = token.balanceOf(address(this));
        if (token.allowance(msg.sender, address(this)) >= amount) {
            token.safeTransferFrom(msg.sender, address(this), amount);
        } else {
            e.permit2.transferFrom(msg.sender, address(this), uint160(amount), address(token));
        }
        if (token.balanceOf(address(this)) - before != amount) revert IV5Errors.BadTransfer();
    }

    function txSwaps() internal view returns (uint256 v) {
        bytes32 s = TX_SWAPS;
        assembly {
            v := tload(s)
        }
    }

    function addTxSwaps(uint256 a) internal {
        bytes32 s = TX_SWAPS;
        uint256 v = txSwaps() + a;
        assembly {
            tstore(s, v)
        }
    }

    /// @notice A user's own swap's limits: a fresh cache, a readable live cap, this swap and this transaction's user
    ///         swaps within it (2A.1, A-F12).
    function userSwapCheck(Env memory e, uint256 usdg, uint256 maxPerSwap) internal {
        if (!cacheFresh()) revert IV5Errors.UsdgPathClosed(1);
        (uint256 cap, bool ok) = e.limiter.liveCap();
        if (!ok) revert IV5Errors.UsdgPathClosed(2);
        uint256 lim = maxPerSwap < cap ? maxPerSwap : cap;
        if (usdg > lim) revert IV5Errors.SplitNeeded(usdg, lim);
        uint256 sum = txSwaps() + usdg;
        if (sum > cap) revert IV5Errors.SplitNeeded(sum, cap);
        addTxSwaps(usdg);
    }

    /// @notice `claimSponsorFees(root, V5)` with a fixed gas budget, in try/catch (its `ZeroAmount` when nothing is
    ///         owed is caught too). Returns what arrived.
    function claim(Env memory e) internal returns (uint256 got) {
        if (!S.layout().rootReady) return 0;
        if (gasleft() < C.CLAIM_GAS * 64 / 63 + 10_000) revert IV5Errors.ReadStarved();
        uint256 before = e.usdg.balanceOf(address(this));
        try e.pool.claimSponsorFees{gas: C.CLAIM_GAS}(e.root, address(this)) {} catch {}
        got = e.usdg.balanceOf(address(this)) - before;
    }
}
