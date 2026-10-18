// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./StockVault.t.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// The registry behind Robinhood's stock tokens (their beacon): one pause for all of them and the block list.
contract MockAccessRegistry {
    bool public paused;
    mapping(address => bool) public isBlocked;

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlocked(address a, bool b) external {
        isBlocked[a] = b;
    }
}

/// A Robinhood stock token as read on chain on 2026-09-28: `oraclePaused`, its own `paused` (transfers stop), the
/// multiplier's `effectiveAt`, `ACCESS_CONTROLLED_REGISTRY`, and the issuer's `adminBurn`.
contract RhStock is ERC20 {
    bool public oraclePaused;
    bool public paused;
    uint256 public effectiveAt;
    address public ACCESS_CONTROLLED_REGISTRY;

    constructor(string memory s, address registry) ERC20(s, s) {
        ACCESS_CONTROLLED_REGISTRY = registry;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setEffectiveAt(uint256 t) external {
        effectiveAt = t;
    }

    function adminBurn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 v) internal override {
        require(!paused || from == address(0) || to == address(0), "paused");
        super._update(from, to, v);
    }
}

/// A feed whose past rounds cannot be read (a new phase, or an aggregator without history).
contract NoHistoryFeed {
    uint8 public constant decimals = 8;

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (5, 600e8, block.timestamp, block.timestamp, 5);
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert("No data present");
    }
}

/// The fixes for the 2026-09-27 audit of StockVault (docs/reports/2026-09-27-audit-onboarding-stocks.md).
contract StockVaultAuditFixesTest is StockVaultBase {
    MockAccessRegistry registry;
    RhStock rh;
    MockFeed rhFeed;

    function setUp() public override {
        super.setUp();
        registry = new MockAccessRegistry();
        rh = new RhStock("RH", address(registry));
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

    function _expectHeld(uint256 id, uint256 pk, uint256 amount, uint8 reason) internal {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(id, pk);
        vm.prank(vm.addr(pk));
        vm.expectRevert(abi.encodeWithSelector(StockVault.LendingHeld.selector, address(rh), reason));
        vault.open(id, address(rh), amount, c, sig);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp(); // not block.timestamp: the optimizer may read it again after a warp
    }

    // ---- M1: a price jump holds new credit for the whole window, not only its first round ----

    function test_priceJump_holdsNewLines_throughTheLagWindow_untilItAgesOut() public {
        uint256 t0 = _now();
        rhFeed.set(6000e8, t0); // the ex-date of a 1:10 reverse split, the feed's multiplier not caught up
        _expectHeld(AGENT, AGENT_PK, SHARE / 24, 1);
        assertEq(vault.lendStatus(address(rh)), vault.HOLD_PRICE_MOVED());
        (bool ok,) = vault.valueOf(address(rh), SHARE);
        assertFalse(ok, "valueOf says the price cannot be used for new credit");
        vm.warp(t0 + 1 hours);
        rhFeed.set(6000e8, t0 + 1 hours); // a second round at the lagging price: no jump from the one before
        _expectHeld(AGENT, AGENT_PK, SHARE / 24, 1); // still held: the window reaches the pre-split rounds
        vm.warp(t0 + 4 days);
        rhFeed.set(600e8, t0 + 4 days); // the multiplier catches up
        _expectHeld(AGENT, AGENT_PK, SHARE / 2, 1); // held while the lagging rounds are in the window
        for (uint256 d = 5; d <= 9; d++) {
            vm.warp(t0 + d * 1 days);
            rhFeed.set(600e8, t0 + d * 1 days); // a daily round at the right price
        }
        // 5 days of steady rounds since the lag ended, but its two rounds are 9 days old, inside the 14-day window:
        // still held (the walk over the rounds 1, 2, 4 … back skipped them and lent here: GHSA-7gq2-77ph-mw6j)
        _tape(address(rhFeed));
        assertEq(vault.lendStatus(address(rh)), vault.HOLD_PRICE_MOVED(), "the lag's rounds are still in the window");
        // released once the window's first UTC day begins after the lag: the last lagging round was the feed's answer
        // until the round at t0 + 4 days, the price in force when every window's first day began until then
        // (GHSA-q29p-rp35-p8v2: compared, as the live walk compares the round in force when the window opens)
        uint256 release = ((t0 + 4 days) / 1 days + 1) * 1 days + 14 days;
        for (uint256 d = 10; t0 + d * 1 days < release; d++) {
            vm.warp(t0 + d * 1 days);
            rhFeed.set(600e8, t0 + d * 1 days);
            _tape(address(rhFeed));
            assertEq(vault.lendStatus(address(rh)), vault.HOLD_PRICE_MOVED(), "held while a lagging round is in it");
        }
        vm.warp(release);
        rhFeed.set(600e8, release);
        _tape(address(rhFeed));
        assertEq(vault.lendStatus(address(rh)), 0, "the lag has left the window");
        assertEq(_openRh(AGENT_PK, AGENT, SHARE / 2), 150 * USDC);
    }

    function test_priceJump_downward_holdsToo() public {
        rhFeed.set(420e8, _now()); // -30%
        _expectHeld(AGENT, AGENT_PK, SHARE, 1);
    }

    function test_priceMoveUnderTheBound_isNotHeld() public {
        rhFeed.set(700e8, _now()); // +16.7%
        assertEq(vault.lendStatus(address(rh)), 0);
        assertEq(_openRh(AGENT_PK, AGENT, SHARE / 2), 175 * USDC);
    }

    function test_priceJump_refusesLoansOnAnOpenLine_butRepayAndCloseStillWork() public {
        _openRh(AGENT_PK, AGENT, SHARE / 2); // $150 line
        uint256 loanId = _borrow(agentOp, AGENT, 50 * USDC);
        rhFeed.set(840e8, _now()); // +40%
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
        assertEq(vault.borrowRoom(AGENT), 0);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        vm.prank(agentOp);
        vault.close(AGENT);
        assertEq(rh.balanceOf(agentOp), 10 * SHARE, "the hold never keeps a depositor's tokens");
    }

    function test_priceHistoryThatCannotBeRead_holds() public {
        NoHistoryFeed f = new NoHistoryFeed();
        vm.prank(owner);
        vault.setAsset(address(rh), address(f), 1 days, true, 5000, type(uint128).max);
        _expectHeld(AGENT, AGENT_PK, SHARE / 2, 1);
    }

    function test_priceGuard_windowZero_comparesThePreviousRoundOnly() public {
        vm.prank(owner);
        vault.setPriceGuard(2500, 0, 1 days);
        uint256 t0 = _now();
        rhFeed.set(6000e8, t0);
        _expectHeld(AGENT, AGENT_PK, SHARE / 24, 1);
        vm.warp(t0 + 1 hours);
        rhFeed.set(6000e8, t0 + 1 hours);
        assertEq(vault.lendStatus(address(rh)), 0, "no window: only the jump's own round is held");
    }

    function test_setPriceGuard_boundedAndOwnerOnly() public {
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        vault.setPriceGuard(2500, 5 days, 1 days);
        vm.startPrank(owner);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setPriceGuard(499, 5 days, 1 days);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setPriceGuard(5001, 5 days, 1 days);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setPriceGuard(2500, 14 days + 1, 1 days);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setPriceGuard(2500, 5 days, 14 days + 1);
        vault.setPriceGuard(3000, 7 days, 2 days);
        vm.stopPrank();
        assertEq(vault.maxJumpBps(), 3000);
        assertEq(vault.jumpWindow(), 7 days);
        assertEq(vault.multiplierCooldown(), 2 days);
    }

    // ---- M1: the token's multiplier schedule ----

    function test_multiplierChange_pendingOrRecent_holds() public {
        uint256 t0 = _now();
        rh.setEffectiveAt(t0 + 2 days); // scheduled, not yet in effect
        _expectHeld(AGENT, AGENT_PK, SHARE / 2, 2);
        vm.warp(t0 + 2 days + 23 hours); // took effect 23 hours ago: inside the 1-day cooldown
        rhFeed.set(600e8, t0 + 2 days + 23 hours);
        assertEq(vault.lendStatus(address(rh)), vault.HOLD_MULTIPLIER());
        vm.warp(t0 + 3 days + 1);
        rhFeed.set(600e8, t0 + 3 days + 1);
        assertEq(vault.lendStatus(address(rh)), 0);
        _openRh(AGENT_PK, AGENT, SHARE / 2);
    }

    // ---- M2: a paused token, a paused registry, a blocked vault or seizeTo ----

    function test_pausedToken_holdsNewLinesAndLoans_butRepayStillWorks() public {
        rh.setPaused(true);
        _expectHeld(AGENT, AGENT_PK, SHARE / 2, 3);
        rh.setPaused(false);
        _openRh(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrow(agentOp, AGENT, 50 * USDC);
        rh.setPaused(true);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max); // repaying never waits on the token
        rh.setPaused(false);
        _borrow(agentOp, AGENT, 10 * USDC);
    }

    function test_pausedRegistry_holds() public {
        registry.setPaused(true);
        assertEq(vault.lendStatus(address(rh)), vault.HOLD_TOKEN_PAUSED());
        registry.setPaused(false);
        assertEq(vault.lendStatus(address(rh)), 0);
    }

    function test_blockedVaultOrSeizeTo_holds() public {
        registry.setBlocked(address(vault), true);
        _expectHeld(AGENT, AGENT_PK, SHARE / 2, 4);
        registry.setBlocked(address(vault), false);
        registry.setBlocked(treasury, true); // seizeTo: a default could not seize
        _expectHeld(AGENT, AGENT_PK, SHARE / 2, 4);
        registry.setBlocked(treasury, false);
        registry.setBlocked(agentOp2, true); // someone else: no bearing on this vault
        assertEq(vault.lendStatus(address(rh)), 0);
        _openRh(AGENT_PK, AGENT, SHARE / 2);
    }

    function test_aTokenWithoutPauseRegistryOrMultiplier_stillWorks() public {
        // MockStock has only oraclePaused: every other read is absent and holds nothing back
        assertEq(vault.lendStatus(address(spy)), 0);
        _open(AGENT_PK, AGENT, SHARE / 2);
        _borrow(agentOp, AGENT, 50 * USDC);
    }

    // ---- M3: skim sends the fees only; other USDG leaves through the owner's logged path ----

    function test_skim_sendsOnlyTheFees_otherUsdgStays() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrow(agentOp, AGENT, 100 * USDC);
        vm.warp(_now() + 7 days);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        usdc.mint(address(vault), 123 * USDC); // a cash distribution paid to the vault as the tokens' holder
        uint256 fees = pool.sponsorFees(VAULT_ID);
        assertGt(fees, 0);
        vm.prank(anyone);
        assertEq(vault.skim(), fees);
        assertEq(usdc.balanceOf(sink), fees, "the fees only");
        assertEq(usdc.balanceOf(address(vault)), 123 * USDC, "the depositors' cash stays");
    }

    function test_rescueUsdg_ownerOnly_andLogged() public {
        usdc.mint(address(vault), 123 * USDC);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        vault.rescueUsdg(anyone, 123 * USDC);
        vm.expectEmit(address(vault));
        emit StockVault.UsdgRescued(agentOp, 123 * USDC);
        vm.prank(owner);
        vault.rescueUsdg(agentOp, 123 * USDC);
        assertEq(usdc.balanceOf(agentOp), 100 * USDC + 123 * USDC);
    }

    // ---- L1: an issuer burn is shared pro rata, and a dead token's line can be written off ----

    function test_adminBurn_isSharedProRata_andTheLastCloserEnds() public {
        _openRh(AGENT_PK, AGENT, SHARE / 2);
        _openRh(AGENT2_PK, AGENT2, SHARE / 2);
        rh.adminBurn(address(vault), SHARE / 4); // a quarter of what the vault holds
        vm.prank(agentOp2);
        vault.close(AGENT2);
        assertEq(rh.balanceOf(agentOp2), 10 * SHARE - SHARE / 2 + 3 * SHARE / 8, "3/4 of its half");
        vm.prank(agentOp);
        vault.close(AGENT);
        assertEq(rh.balanceOf(agentOp), 10 * SHARE - SHARE / 2 + 3 * SHARE / 8, "the same share, last out");
        assertEq(vault.held(address(rh)), 0);
        assertEq(vault.openLines(), 0);
        assertEq(rh.balanceOf(address(vault)), 0);
    }

    function test_adminBurn_freezePositionAndSeizureEndToo() public {
        _openRh(AGENT_PK, AGENT, SHARE / 2);
        _openRh(AGENT2_PK, AGENT2, SHARE / 2);
        rh.adminBurn(address(vault), SHARE / 2); // half gone
        vm.prank(owner);
        vault.freezePosition(AGENT2);
        assertEq(rh.balanceOf(agentOp2), 10 * SHARE - SHARE / 4);
        uint256 loanId = _borrow(agentOp, AGENT, 50 * USDC);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        pool.markDefault(loanId);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Seized));
        assertEq(rh.balanceOf(treasury), SHARE / 4);
    }

    function test_writeOff_aTokenThatCannotMove_freesTheLine_tokensReclaimedLater() public {
        _openRh(AGENT_PK, AGENT, SHARE / 2); // $150 line
        rh.setPaused(true); // for good, as far as anyone knows
        vm.prank(agentOp);
        vm.expectRevert(); // the token does not move: close cannot end it
        vault.close(AGENT);
        uint256 freeBefore = pool.freeBacking(VAULT_ID);
        vm.expectEmit(address(vault));
        emit StockVault.WrittenOff(AGENT, address(rh), SHARE / 2);
        vm.prank(owner);
        vault.writeOff(AGENT);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.WrittenOff));
        assertEq(vault.openLines(), 0, "the line leaves openLines");
        assertEq(pool.getAgent(AGENT).sponsor, 0, "and the pool");
        assertGt(pool.freeBacking(VAULT_ID), freeBefore, "the stake it held is free");
        assertEq(vault.held(address(rh)), SHARE / 2, "still owed to the depositor");
        rh.setPaused(false);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StockVault.Protected.selector, address(rh)));
        vault.rescue(address(rh), owner); // out of the owner's reach
        rh.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotSent.selector, AGENT));
        vault.reclaim(AGENT);
        rh.setPaused(false);
        vm.prank(anyone);
        vault.reclaim(AGENT);
        assertEq(rh.balanceOf(agentOp), 10 * SHARE);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(vault.held(address(rh)), 0);
    }

    function test_writeOff_ownerOnly_noLoanOpen_andAMovingTokenJustCloses() public {
        _openRh(AGENT_PK, AGENT, SHARE / 2);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        vault.writeOff(AGENT);
        uint256 loanId = _borrow(agentOp, AGENT, 50 * USDC);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StockVault.LoanOpen.selector, AGENT));
        vault.writeOff(AGENT);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        vm.prank(owner);
        vault.writeOff(AGENT);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(rh.balanceOf(agentOp), 10 * SHARE, "a token that moves goes straight back");
        assertEq(vault.held(address(rh)), 0);
        assertEq(vault.openLines(), 0);
    }

    // ---- L2: expiry counts from the last repayment ----

    function test_expire_notRightAfterAnOnTimeRepayment() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 t0 = _now();
        vm.prank(agentOp);
        uint256 loanId = pool.borrow(AGENT, 50 * USDC, 30 days, agentOp, type(uint256).max);
        vm.warp(t0 + 30 days); // repaid on its due date
        usdc.mint(agentOp, 10 * USDC);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotIdle.selector, AGENT));
        vault.expire(AGENT);
        vm.warp(t0 + 60 days - 1);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotIdle.selector, AGENT));
        vault.expire(AGENT);
        vm.warp(t0 + 60 days);
        vault.expire(AGENT);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE);
    }

    // ---- L3: a line never drawn expires after idleUndrawnAfter ----

    function test_expire_aLineNeverDrawn_afterSevenDays() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 t0 = _now();
        vm.warp(t0 + 7 days - 1);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotIdle.selector, AGENT));
        vault.expire(AGENT);
        vm.warp(t0 + 7 days);
        vm.prank(anyone);
        vault.expire(AGENT);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE);
        assertEq(pool.getAgent(AGENT).sponsor, 0, "the stake it held is free");
    }

    function test_expire_aDrawnLine_keepsTheLongWindow() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 t0 = _now();
        uint256 loanId = _borrow(agentOp, AGENT, 10 * USDC);
        vm.warp(t0 + 1 days);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        vm.warp(t0 + 8 days);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotIdle.selector, AGENT));
        vault.expire(AGENT);
    }

    function test_setIdleUndrawnAfter_boundedAndOwnerOnly() public {
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        vault.setIdleUndrawnAfter(2 days);
        vm.startPrank(owner);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setIdleUndrawnAfter(1 days - 1);
        vault.setIdleUndrawnAfter(2 days);
        vm.stopPrank();
        assertEq(vault.idleUndrawnAfter(), 2 days);
    }

    // ---- L4: ownership cannot be renounced ----

    function test_renounceOwnership_reverts() public {
        vm.prank(owner);
        vm.expectRevert(StockVault.Renounce.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), owner);
    }
}
