// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./StockVaultAuditFixes.t.sol";

/// The vault's changes from the stocks readiness review (docs/reports/2026-09-28-stocks-readiness.md): V1 (a written-off
/// position cannot be overwritten), V2 (a 14-day price-jump window, and a hold while the token's multiplier is ahead of
/// its feed), P4 (each token's own LTV and cap on open lines).
contract StockVaultReadinessFixesTest is StockVaultBase {
    MockAccessRegistry accessRegistry;
    RhStock rh;
    MockFeed rhFeed;

    function setUp() public override {
        super.setUp();
        accessRegistry = new MockAccessRegistry();
        rh = new RhStock("RH", address(accessRegistry));
        rhFeed = new MockFeed(8, 600e8);
        vm.prank(owner);
        vault.setAsset(address(rh), address(rhFeed), 1 days + 1 hours, true, 5000, type(uint128).max);
        rh.mint(agentOp, 10 * SHARE);
        rh.mint(agentOp2, 10 * SHARE);
        vm.prank(agentOp);
        rh.approve(address(vault), type(uint256).max);
        vm.prank(agentOp2);
        rh.approve(address(vault), type(uint256).max);
    }

    function _openRh(uint256 pk, uint256 id, uint256 amount) internal returns (uint256 line) {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(id, pk);
        vm.prank(vm.addr(pk));
        line = vault.open(id, address(rh), amount, c, sig);
    }

    function _openAs(uint256 pk, uint256 id, address token, uint256 amount, bytes memory err) internal {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(id, pk);
        vm.prank(vm.addr(pk));
        if (err.length != 0) vm.expectRevert(err);
        vault.open(id, token, amount, c, sig);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// A position on RH, written off while RH is paused (its tokens cannot move): the vault still owes them.
    function _writtenOff() internal {
        _openRh(AGENT_PK, AGENT, SHARE / 2);
        rh.setPaused(true);
        vm.prank(owner);
        vault.writeOff(AGENT);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.WrittenOff));
    }

    // ---- V1: a written-off position is never overwritten ----

    function test_open_refusedOnAWrittenOffPosition() public {
        _writtenOff();
        _openAs(AGENT_PK, AGENT, address(spy), SHARE / 2, abi.encodeWithSelector(StockVault.TokensOwed.selector, AGENT));
        StockVault.Position memory p = vault.getPosition(AGENT);
        assertEq(p.token, address(rh), "the record the tokens are owed on is intact");
        assertEq(p.amount, SHARE / 2);
    }

    function test_reclaim_afterTheRefusedOpen_thenANewLineOpens() public {
        _writtenOff();
        _openAs(AGENT_PK, AGENT, address(spy), SHARE / 2, abi.encodeWithSelector(StockVault.TokensOwed.selector, AGENT));
        rh.setPaused(false);
        vault.reclaim(AGENT); // anyone
        assertEq(rh.balanceOf(agentOp), 10 * SHARE, "every RH token back to its depositor");
        assertEq(vault.held(address(rh)), 0);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(_open(AGENT_PK, AGENT, SHARE / 2), 150 * USDC, "once reclaimed, the agent can open again");
    }

    function test_open_refusedForTheAgentsNewOwner_whileTokensAreOwed() public {
        _writtenOff();
        vm.prank(agentOp);
        reg.transferFrom(agentOp, agentOp2, AGENT);
        _openAs(
            AGENT2_PK, AGENT, address(spy), SHARE / 2, abi.encodeWithSelector(StockVault.TokensOwed.selector, AGENT)
        );
        rh.setPaused(false);
        vault.reclaim(AGENT);
        assertEq(rh.balanceOf(agentOp), 10 * SHARE, "the old depositor gets the tokens, not the agent's new owner");
        assertEq(rh.balanceOf(agentOp2), 10 * SHARE);
    }

    // ---- V2: a 14-day window, and the multiplier ahead of the feed ----

    function test_jumpWindow_defaultsTo14Days() public view {
        assertEq(vault.jumpWindow(), 14 days);
    }

    /// SGOV's feed lagged its multiplier 7 days (3 to 10 August). A 1:10 reverse split with that lag, on a feed that
    /// publishes every hour (the live feeds publish up to ~46 rounds a day): the inflated price is held through the
    /// whole lag, where a 5-day window lets it through before the lag ends.
    function test_priceJump_heldThroughASevenDayLag() public {
        uint256 t0 = _now();
        rhFeed.set(6000e8, t0);
        for (uint256 h = 1; h <= 7 * 24; h++) {
            rhFeed.set(6000e8, t0 + h * 1 hours); // the lagging price, every hour
            if (h % 24 == 0) {
                vm.warp(t0 + h * 1 hours);
                _tape(address(rhFeed));
                assertEq(vault.lendStatus(address(rh)), vault.HOLD_PRICE_MOVED(), "held on every day of the lag");
            }
        }
        vm.prank(owner);
        vault.setPriceGuard(2500, 5 days, 1 days);
        assertEq(vault.lendStatus(address(rh)), 0, "a 5-day window would have released the inflated price by day 7");
    }

    function test_multiplierTakenEffectAfterTheFeedsLatestAnswer_holds() public {
        vm.prank(owner);
        vault.setPriceGuard(2500, 14 days, 1 hours);
        uint256 t0 = _now();
        rhFeed.set(600e8, t0);
        rh.setEffectiveAt(t0 + 10 minutes); // the multiplier changes after the feed's latest answer
        vm.warp(t0 + 2 hours); // past the cooldown: only the stale feed holds it now
        assertEq(vault.lendStatus(address(rh)), vault.HOLD_MULTIPLIER());
        (bool ok,) = vault.valueOf(address(rh), SHARE);
        assertFalse(ok);
        _openAs(
            AGENT_PK,
            AGENT,
            address(rh),
            SHARE / 2,
            abi.encodeWithSelector(StockVault.LendingHeld.selector, address(rh), vault.HOLD_MULTIPLIER())
        );
        rhFeed.set(600e8, t0 + 2 hours); // the feed publishes after the multiplier: caught up
        assertEq(vault.lendStatus(address(rh)), 0);
        assertEq(_openRh(AGENT_PK, AGENT, SHARE / 2), 150 * USDC);
    }

    // ---- P4: each token's own LTV and cap on open lines ----

    function test_perTokenLtv_setsTheLineAndTheBorrowLimit() public {
        vm.prank(owner);
        vault.setAsset(address(rh), address(rhFeed), 1 days + 1 hours, true, 3500, type(uint128).max);
        assertEq(vault.ltvOf(0, address(rh)), 3500);
        assertEq(vault.ltvOf(0, address(spy)), 5000);
        assertEq(_openRh(AGENT_PK, AGENT, SHARE / 2), 105 * USDC, "35% of $300");
        assertEq(vault.borrowRoom(AGENT), 105 * USDC);
        // lowering the token's LTV shrinks what an open line can still draw, as a price drop would
        vm.prank(owner);
        vault.setAsset(address(rh), address(rhFeed), 1 days + 1 hours, true, 2000, type(uint128).max);
        assertEq(vault.borrowRoom(AGENT), 60 * USDC, "20% of $300");
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 61 * USDC, 7 days, agentOp, type(uint256).max);
        _borrow(agentOp, AGENT, 60 * USDC);
    }

    function test_perTokenLtv_boundedAndOwnerOnly() public {
        vm.startPrank(owner);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setAsset(address(rh), address(rhFeed), 1 days, true, 999, 1);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setAsset(address(rh), address(rhFeed), 1 days, true, 7001, 1);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setAsset(address(rh), address(rhFeed), 1 days, false, 0, 0); // even a disabled token keeps an LTV
        vm.stopPrank();
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        vault.setAsset(address(rh), address(rhFeed), 1 days, true, 5000, 1);
    }

    function test_lineCap_refusesALinePastTheTokensCap() public {
        vm.prank(owner);
        vault.setAsset(address(rh), address(rhFeed), 1 days + 1 hours, true, 5000, uint128(200 * USDC));
        assertEq(_openRh(AGENT_PK, AGENT, SHARE / 2), 150 * USDC);
        assertEq(vault.openLinesOf(address(rh)), 150 * USDC);
        _openAs(
            AGENT2_PK,
            AGENT2,
            address(rh),
            SHARE / 2,
            abi.encodeWithSelector(StockVault.TokenCapReached.selector, address(rh), 150 * USDC, 50 * USDC)
        );
        // another token is not held back by RH's cap
        assertEq(_open(AGENT2_PK, AGENT2, SHARE / 2), 150 * USDC);
        // the first line closes: its room on RH comes back
        vm.prank(agentOp);
        vault.close(AGENT);
        assertEq(vault.openLinesOf(address(rh)), 0);
    }

    function test_lineCap_zero_meansNoNewLine() public {
        vm.prank(owner);
        vault.setAsset(address(rh), address(rhFeed), 1 days + 1 hours, true, 5000, 0);
        _openAs(
            AGENT_PK,
            AGENT,
            address(rh),
            SHARE / 2,
            abi.encodeWithSelector(StockVault.TokenCapReached.selector, address(rh), 150 * USDC, 0)
        );
    }

    function test_openLinesOf_followsWriteOffAndSeizure() public {
        _openRh(AGENT_PK, AGENT, SHARE / 2);
        rh.setPaused(true);
        vm.prank(owner);
        vault.writeOff(AGENT);
        assertEq(vault.openLinesOf(address(rh)), 0, "a written-off line leaves the token's count");
        rh.setPaused(false);
        _openRh(AGENT2_PK, AGENT2, SHARE / 2);
        assertEq(vault.openLinesOf(address(rh)), 150 * USDC);
        uint256 loanId = _borrow(agentOp2, AGENT2, 100 * USDC);
        CreditPoolV2.Loan memory l = pool.getLoan(loanId);
        vm.warp(l.defaultableAt + 1);
        pool.markDefault(loanId);
        assertEq(uint256(vault.getPosition(AGENT2).status), uint256(StockVault.Status.Seized));
        assertEq(vault.openLinesOf(address(rh)), 0, "a seized line leaves it too");
    }
}
