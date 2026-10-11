// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICreditPoolV2} from "../interfaces/ICreditPoolV2.sol";
import {Env, C} from "./V5Types.sol";
import {V5Storage as S} from "./V5Storage.sol";
import {V5Math as M} from "./V5Math.sol";
import {V5Core as K} from "./V5Core.sol";

/// @title V5View
/// @notice `canBorrow` and V5's computed views (docs/PRIORS-UNDERWRITING-SPEC.md rev 5, 2.3, 2A.1). A linked library;
///         every function here is a view.
library V5View {
    struct BorrowArgs {
        uint256 rootId;
        uint256 id;
        uint256 amount;
        uint64 term;
        uint256 fee;
        address caller;
        address owner;
    }

    /// @notice `canBorrow` (2.3): V5's pause off; the price cache set; the generation open, not closing, not settled,
    ///         its `ownerChanged` latch clear; the owner the bound owner and the caller the bound owner or the delegate
    ///         V5 recorded at least 24 h ago, still the agent's controller at the pool; term ≤ 10 days; fewer than 5 listed entries; no listed loan open past
    ///         `dueAt` and no unreconciled late repayment; listed open loans equal to `activeLoans`; for a first loan
    ///         the week's open room covers the line `open` approved; the depth guard's lasting state off (question
    ///         30); with Stage 3's check on, the agent's premium at V5's target; the loan's fee within free backing; and
    ///         principalOut + amount ≤ line, valued at P with live spot and the latest observation, at kEff.
    function canBorrow(BorrowArgs memory a) external view returns (bool) {
        Env memory e = K.env();
        S.Layout storage l = S.layout();
        if (a.rootId != e.root) return false;
        uint32 genNo = l.latest[a.id];
        S.Gen storage g = l.gens[a.id][genNo];
        if (genNo == 0 || g.status != C.OPEN || g.ownerChanged || K.paused()) return false;
        if (a.owner != g.owner || a.term > C.MAX_LOAN_TERM || !K.cacheSet() || l.price.depthOn) return false;
        if (a.caller != g.owner) {
            S.Delegate storage d = l.delegates[a.id];
            if (a.caller != d.who || block.timestamp < uint256(d.at) + C.DELEGATE_WAIT) return false;
            // and still the agent's controller at the pool, as the pool's own borrow requires (GHSA-8pxr)
            if (!e.pool.isController(a.id, a.caller)) return false;
        }
        uint256 n = g.listLen;
        if (n >= C.LIST_CAP) return false;
        if (!g.openRoomCharged && openRoomLeft(e) < g.openLine) return false;
        ICreditPoolV2.Agent memory ag = e.pool.getAgent(a.id);
        uint256 open_;
        for (uint256 i = 0; i < n; i++) {
            ICreditPoolV2.Loan memory ln = e.pool.getLoan(g.list[i]);
            if (ln.status == ICreditPoolV2.LoanStatus.Active) {
                if (block.timestamp > ln.dueAt) return false;
                open_++;
            } else if (ln.status != ICreditPoolV2.LoanStatus.Repaid || ln.closedAt > ln.dueAt) {
                return false;
            }
        }
        if (open_ != ag.activeLoans) return false;
        if (l.premiumCheck && block.timestamp >= l.premiumCheckFrom && ag.premiumBps != l.targetPremium[a.id]) {
            return false;
        }
        if (a.fee > e.pool.freeBacking(e.root)) return false;
        uint160 sp = K.spot(e);
        uint160 ob = K.lastObs(e);
        uint256 line_ = M.line(g.counted[C.OWNER], K.pFull(sp, ob), C.ceiling(g.tier), K.kEff(sp, ob, true));
        return ag.principalOut + a.amount <= line_;
    }

    function openRoomLeft(Env memory e) internal view returns (uint256) {
        S.Layout storage l = S.layout();
        uint256 used = l.roomEpoch == K.epochNow(e) + 1 ? l.openUsed : 0;
        return l.openRoom > used ? l.openRoom - used : 0;
    }
}
