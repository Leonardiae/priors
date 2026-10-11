// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Env, C, IV5Events, IV5Errors} from "./V5Types.sol";
import {V5Storage as S} from "./V5Storage.sol";
import {V5Math as M} from "./V5Math.sol";
import {V5Core as K} from "./V5Core.sol";
import {V5Pos} from "./V5Pos.sol";
import {V5Steps} from "./V5Steps.sol";
import {V5Book} from "./V5Book.sol";

/// @title V5Auto
/// @notice Fees out (`collect`, `flush`, 2.7) and auto-add (docs/PRIORS-UNDERWRITING-SPEC.md rev 5, 2A.1): `compound`, keeper only. A `back()` made for each
///         opted-in holder with its own fees, without `back`'s 1,000 $PRIORS minimum; whenever a back would be refused
///         the fees wait in USDG. One swap for the batch, through the SwapLimiter, under the pay band. A linked library.
library V5Auto {
    using SafeERC20 for IERC20;

    struct Item {
        uint256 id;
        address holder;
    }

    struct Batch {
        uint160 sp;
        uint160 sqrtP;
        uint256 sum;
        uint256 got;
        uint256 total;
        uint256 assigned;
    }

    /// @notice One compound batch (at most 50 items). Per item, 2.2's order, then a skip (USDG untouched) when the
    ///         position has auto-add off or under 0.50 USDG of credit, the book is not open, changed hands or has a
    ///         defaulted agent, the late guard or any guard is on, or there is no room. One swap of 5 USDG at least and
    ///         at most the live cap; tokens split by USDG share, rounded down, the dust carried to the next batch;
    ///         each item credited as pending stake up to its room after the swap, the overflow returned as $PRIORS.
    function compound(Item[] memory items, uint256 minOut) external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        if (items.length > C.COMPOUND_MAX_ITEMS) revert IV5Errors.TooManyItems();
        if (!K.cacheSet()) revert IV5Errors.NoPrice();
        if (!K.cacheFresh()) revert IV5Errors.StalePrice();
        K.claim(e);
        Batch memory b;
        b.sp = K.spot(e);
        b.sqrtP = K.pFull(b.sp, K.lastObs(e));
        // defaults a hook recorded count before the latch is read (GHSA-g626): a trip by this evaluation stands and the
        // batch takes nothing, as a trip inside it does (below). Within the batch an item's own reconciliation
        // evaluates whatever it newly records, and no hook runs between items.
        if (!l.tripped) {
            K.breakerEval();
            if (l.tripped) return;
        }
        bool guards = K.paused() || l.tripped || K.depthGuard(e) || K.spotGuard(b.sp);
        uint256[] memory usd = new uint256[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            if (guards) break;
            usd[i] = _take(e, items[i]);
            b.sum += usd[i];
            // of the guards only the breaker can change between items, through an item's reconciliation (deep audit
            // D-01): pause, spot and both depth forms are read before any swap and no first step moves them. A trip
            // inside the batch stands, no item deposits under it (2A.1, the guard table) and every credit taken
            // waits in USDG for `collect`.
            if (l.tripped) {
                _untake(items, usd);
                return;
            }
        }
        if (b.sum < C.COMPOUND_MIN) revert IV5Errors.CompoundTooSmall();
        _swap(e, b, minOut);
        b.total = b.got + l.carry;
        for (uint256 i = 0; i < items.length; i++) {
            if (usd[i] == 0) continue;
            uint256 t = b.total * usd[i] / b.sum;
            b.assigned += t;
            _credit(e, items[i], t, usd[i], b.sqrtP);
        }
        l.carry = b.total - b.assigned;
    }

    /// @dev Decide an item and take its USDG credit (debited from the holder and from `holdersOwed`), or skip it.
    function _take(Env memory e, Item memory it) private returns (uint256 usd) {
        S.Layout storage l = S.layout();
        if (it.holder == e.buyAndBack) return 0; // C never auto-adds: its fees go to BuyAndBack
        uint32 genNo = l.latest[it.id];
        if (genNo == 0) return 0;
        K.Steps memory st = V5Steps.firstSteps(e, it.id, false);
        // 2A.1: the item checks the guards after its own first steps, whose reconciliation may trip the breaker (and
        // then freeze A's merge in the same poke): it never deposits under it (deep audit D-01)
        if (l.tripped) return 0;
        S.Gen storage g = l.gens[it.id][genNo];
        if (g.status != C.OPEN || !st.readOk || g.ownerChanged) return 0;
        if (K.lateGuard(g, st.ls) || e.pool.getAgent(it.id).defaulted) return 0;
        uint8 layer = K.backLayer(e, g, it.holder);
        bool isOwner = it.holder == g.owner;
        if (g.layerEnd[layer] != 0) return 0;
        // auto-add is read per position before anything is resolved: a position with it off is not touched, so its
        // fees are never credited here (audit M-01), the owner's two positions each on their own flag (a leave of
        // the owner's own backing turns that position's off, 2.5; deep audit D-04); only the credit the item's own
        // opted-in positions produce now is spent, credits already in `claimable` wait for `collect` (2A.1: "the
        // batch spends only the credits of its own items")
        uint256 before = l.claimable[it.holder];
        bool on = false;
        if (l.pos[it.id][genNo][layer][it.holder].autoAdd) {
            V5Pos.resolve(e, it.id, genNo, layer, it.holder);
            on = true;
        }
        if (isOwner && l.pos[it.id][genNo][C.OWNER][it.holder].autoAdd) {
            V5Pos.resolve(e, it.id, genNo, C.OWNER, it.holder);
            on = true;
        }
        if (!on) return 0;
        usd = l.claimable[it.holder] - before;
        if (usd < C.COMPOUND_ITEM_MIN) return 0;
        if (!isOwner && V5Book.backingUsed(g) >= g.counted[C.OWNER]) return 0;
        l.claimable[it.holder] = before;
        l.holdersOwed -= usd;
    }

    /// @dev Give every taken credit back to its holder's `claimable` (and `holdersOwed`): the batch deposits nothing.
    function _untake(Item[] memory items, uint256[] memory usd) private {
        S.Layout storage l = S.layout();
        for (uint256 i = 0; i < items.length; i++) {
            if (usd[i] == 0) continue;
            l.claimable[items[i].holder] += usd[i];
            l.holdersOwed += usd[i];
        }
    }

    /// @dev One swap for the batch: within the live cap, through the SwapLimiter, at a `minOut` no lower than the pay
    ///      band's: USDG paid ÷ tokens out ≤ min(spot before, median) ÷ (1 − f) × (1 + 2x/D + 1%).
    function _swap(Env memory e, Batch memory b, uint256 minOut) private {
        uint256 band = _band(e, b);
        if (band > minOut) minOut = band;
        e.limiter.consume(b.sum);
        uint256 uBefore = e.usdg.balanceOf(address(this));
        uint256 pBefore = e.priors.balanceOf(address(this));
        e.usdg.forceApprove(address(e.swapper), b.sum);
        e.swapper.swapExactIn(e.key, true, uint128(b.sum), minOut, C.MIN_SQRT_PLUS_ONE, address(this), block.timestamp);
        e.usdg.forceApprove(address(e.swapper), 0);
        b.got = e.priors.balanceOf(address(this)) - pBefore;
        if (uBefore - e.usdg.balanceOf(address(this)) != b.sum || b.got < minOut) revert IV5Errors.PayBand();
    }

    /// @dev The pay band's floor on tokens out: base × (1 − f) ÷ (1 + 2x/D + 1%), base the tokens worth the batch at
    ///      min(spot, median), rounded up.
    function _band(Env memory e, Batch memory b) private view returns (uint256) {
        (uint256 cap, bool okC) = e.limiter.liveCap();
        if (!okC) revert IV5Errors.UsdgPathClosed(2);
        if (b.sum > cap) revert IV5Errors.SplitNeeded(b.sum, cap);
        (uint256 d, bool okD) = e.limiter.liveDepth();
        (uint256 f, bool okF) = e.limiter.liveFeeBps();
        if (!okD || !okF || d == 0 || f >= 10_000) revert IV5Errors.UsdgPathClosed(2);
        uint256 base = M.tokensForDown(b.sum, M.max160(b.sp, S.layout().price.median));
        return Math.mulDiv(
            base * (10_000 - f), d * 10_000, 10_000 * (d * 10_000 + 2 * b.sum * 10_000 + d * 100), Math.Rounding.Ceil
        );
    }

    /// @dev Credit one item's tokens as pending stake within its room now (each item sees the room the earlier items
    ///      of the batch used), one `Backed` per layer credited (usdgIn 0: the USDG is in `Compounded`, audit L-03);
    ///      the overflow goes back to the holder as $PRIORS (`ExtraReturned`).
    function _credit(Env memory e, Item memory it, uint256 t, uint256 usd, uint160 sqrtP) private {
        uint256 credited = _creditIn(e, it, t, sqrtP);
        emit IV5Events.Compounded(it.id, it.holder, usd, credited);
        if (t > credited) {
            e.priors.safeTransfer(it.holder, t - credited);
            emit IV5Events.ExtraReturned(it.id, it.holder, t - credited);
        }
    }

    function _creditIn(Env memory e, Item memory it, uint256 t, uint160 sqrtP) private returns (uint256 credited) {
        S.Layout storage l = S.layout();
        uint32 genNo = l.latest[it.id];
        S.Gen storage g = l.gens[it.id][genNo];
        uint256 a = g.counted[C.OWNER];
        uint256 used = V5Book.backingUsed(g);
        uint256 room = a > used ? a - used : 0;
        if (it.holder == g.owner) return _creditOwner(e, it, genNo, t, room, sqrtP);
        credited = M.min256(t, room);
        if (credited != 0) {
            V5Pos.deposit(e, it.id, genNo, C.OTHERS, it.holder, credited);
            emit IV5Events.Backed(it.id, genNo, it.holder, C.OTHERS, credited, 0);
        }
    }

    /// @dev The owner's fees go into A while value(A + A's pending) < 3 × the ceiling at P, else into its own backing
    ///      within B + C ≤ A (question 31).
    function _creditOwner(Env memory e, Item memory it, uint32 genNo, uint256 t, uint256 room, uint160 sqrtP)
        private
        returns (uint256)
    {
        uint256 toA = toOwnerA(S.layout().gens[it.id][genNo], t, sqrtP);
        uint256 toOwn = M.min256(t - toA, room);
        if (toA != 0) {
            V5Pos.deposit(e, it.id, genNo, C.OWNER, it.holder, toA);
            emit IV5Events.Backed(it.id, genNo, it.holder, C.OWNER, toA, 0);
        }
        if (toOwn != 0) {
            V5Pos.deposit(e, it.id, genNo, C.OWN, it.holder, toOwn);
            emit IV5Events.Backed(it.id, genNo, it.holder, C.OWN, toOwn, 0);
        }
        return toA + toOwn;
    }

    /// @dev What of `t` goes into A: while value(A + A's pending) at P is under 3 × the current ceiling.
    function toOwnerA(S.Gen storage g, uint256 t, uint160 sqrtP) internal view returns (uint256) {
        uint256 capA = M.tokensFor(3 * C.ceiling(g.tier), sqrtP);
        uint256 aNow = g.counted[C.OWNER] + g.pendingTok[C.OWNER];
        return aNow >= capA ? 0 : M.min256(t, capA - aNow);
    }

    // ------------------------------------------------------------------
    // fees out (2.7)
    // ------------------------------------------------------------------

    /// @notice `collect` (2.7): claims the pool's fees for V5's root first (fixed gas, try/catch), brings each listed
    ///         book's positions of the caller up to date, then pays the caller's whole credit in USDG. Reverts whole,
    ///         every credit kept, when V5's USDG cannot cover it.
    function collect(uint256[] memory ids, uint32[] memory gens) external returns (uint256 amount) {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        if (ids.length != gens.length) revert IV5Errors.BadSetting();
        K.claim(e);
        for (uint256 i = 0; i < ids.length; i++) {
            if (l.gens[ids[i]][gens[i]].status == C.NONE) continue;
            V5Steps.stepsFor(e, ids[i], gens[i], false);
            for (uint8 layer = 0; layer < 3; layer++) {
                V5Pos.resolve(e, ids[i], gens[i], layer, msg.sender);
            }
        }
        amount = l.claimable[msg.sender];
        if (amount == 0) return 0;
        l.claimable[msg.sender] = 0;
        l.holdersOwed -= amount;
        if (e.usdg.balanceOf(address(this)) < amount) revert IV5Errors.ClaimShort();
        e.usdg.safeTransfer(msg.sender, amount);
        emit IV5Events.Collected(msg.sender, amount);
    }

    /// @notice `flush()` (2.7): (1) the claim of the pool's fees for V5's root; then, only while V5's USDG covers
    ///         `holdersOwed` + `bufferOwed` + `protocolFeesOwed`, (2) the buffer added to V5's root (only while the pool
    ///         is not paused and it converts to at least one share) and (3) C's fees sent to BuyAndBack. Each step in
    ///         try/catch.
    function flush() external {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        uint256 claimed = K.claim(e);
        uint256 added;
        uint256 sent;
        uint256 bal = e.usdg.balanceOf(address(this));
        if (bal >= l.holdersOwed + l.bufferOwed + l.protocolFeesOwed) {
            uint256 buf = l.bufferOwed;
            if (buf != 0 && l.rootReady && block.timestamp >= e.pool.pausedUntil() && e.pool.convertToShares(buf) != 0)
            {
                try e.pool.addStake(e.root, buf) {
                    l.bufferOwed = 0;
                    added = buf;
                } catch {}
            }
            uint256 pf = l.protocolFeesOwed;
            if (pf != 0) {
                (bool ok, bytes memory ret) =
                    address(e.usdg).call(abi.encodeWithSelector(IERC20.transfer.selector, e.buyAndBack, pf));
                if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) {
                    l.protocolFeesOwed = 0;
                    sent = pf;
                }
            }
        }
        emit IV5Events.Flushed(claimed, added, sent);
    }
}
