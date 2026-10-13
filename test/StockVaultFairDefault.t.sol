// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {StockVault} from "../src/StockVault.sol";
import {StockVaultBase, MockFeed} from "./StockVault.t.sol";

/// The registry behind Robinhood's stock tokens: one pause for all of them and the block list (read on chain 2026-09-28).
contract FairRegistry {
    bool public paused;
    mapping(address => bool) public isBlocked;

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlocked(address a, bool b) external {
        isBlocked[a] = b;
    }
}

/// A Robinhood stock token as the vault reads one: its own pause, the multiplier's `effectiveAt`, the registry whose
/// block list its transfers obey (a blocked sender or receiver reverts), and the issuer's `adminBurn`.
contract FairStock is ERC20 {
    bool public paused;
    uint256 public effectiveAt;
    address public ACCESS_CONTROLLED_REGISTRY;

    constructor(address registry) ERC20("FAIR", "FAIR") {
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

    // a transfer to `heavyTo` costs `heavyGas` more (0: it never ends, and burns all the gas it is given)
    address public heavyTo;
    uint256 public heavyGas;

    function setHeavy(address to, uint256 g) external {
        (heavyTo, heavyGas) = (to, g);
    }

    function _update(address from, address to, uint256 v) internal override {
        require(!paused || from == address(0) || to == address(0), "paused");
        FairRegistry r = FairRegistry(ACCESS_CONTROLLED_REGISTRY);
        require(!r.isBlocked(from) && !r.isBlocked(to), "blocked");
        if (to == heavyTo && to != address(0)) {
            uint256 start = gasleft();
            while (heavyGas == 0 || start - gasleft() < heavyGas) {}
        }
        super._update(from, to, v);
    }
}

/// The fair default (RWA plan W3, docs/builds/2026-10-12-rwa-stock-lines-growth.md Task 3): once a defaulted agent has
/// no loan left, its position is seized for exactly what the vault's root lost plus a buffer, at a price the vault
/// would lend against now, and the rest goes back to the depositor. Every expected amount below is computed from the
/// rule by hand (the derivation is in each test's comment), and checked again against `_poolDebt`, a sum read straight
/// from the pool's loan records, never from the vault:
///   owed   = principal + fee, as the pool stored them, of every loan the vault backed on the position since it opened
///            that defaulted (a repaid one owes nothing)
///   seized = ceil(owed × (10_000 + buffer) / 10_000 / price), in token units, at most what the position is paid
/// Pool: fee 1% per 30 days (quoteFee rounds down), grace 3 days. SPY at $600 (8-decimal feed), 18-decimal token.
contract StockVaultFairDefaultTest is StockVaultBase {
    uint256 constant SPY_600 = 600e8;

    function _fresh(uint256 price) internal {
        spyFeed.set(int256(price), vm.getBlockTimestamp()); // a round now: the price is one the vault lends against
    }

    function _defaultFresh(uint256 loanId, uint256 price) internal {
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        _fresh(price);
        pool.markDefault(loanId);
    }

    function _borrowFor(uint256 amount, uint64 term) internal returns (uint256) {
        vm.prank(agentOp);
        return pool.borrow(AGENT, amount, term, agentOp, type(uint256).max);
    }

    function _status(uint256 id) internal view returns (StockVault.Status) {
        return vault.getPosition(id).status;
    }

    /// The oracle: agent `id`'s debt read straight from the pool, independently of the vault: principal + fee of every
    /// loan the vault backed since the position opened that defaulted, its loans walked first to last.
    function _poolDebt(uint256 id) internal view returns (uint256 sum) {
        uint256[] memory ids = pool.loansOf(id);
        uint64 opened = vault.getPosition(id).openedAt;
        for (uint256 i; i < ids.length; ++i) {
            CreditPoolV2.Loan memory l = pool.getLoan(ids[i]);
            if (l.sponsorId == VAULT_ID && l.issuedAt >= opened && l.status == CreditPoolV2.LoanStatus.Defaulted) {
                sum += l.principal + l.fee;
            }
        }
    }

    /// ceil(owed × 1.2 / price), in base units of an 18-decimal token priced by an 8-decimal feed
    function _ceil12(uint256 owed, uint256 price) internal pure returns (uint256) {
        return (owed * 12_000 * 1e20 + 10_000 * price - 1) / (10_000 * price);
    }

    // ---- the onDefault path ----

    /// 0.5 SPY ($300, a $150 line), 100 USDG borrowed for 7 days: fee = 100e6 × 100 × 7d / (10_000 × 30d) = 233,333.
    /// owed 100,233,333; seized = 100,233,333 × 12,000 × 1e20 / (10,000 × 600e8) = 200,466,666e9 (exact: no rounding).
    function test_default_seizesOwedPlusTheBuffer_andReturnsTheRest() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrowFor(100 * USDC, 7 days);
        uint256 seized = 200_466_666_000_000_000;
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        _fresh(SPY_600);
        vm.expectEmit(address(vault));
        emit StockVault.Seized(AGENT, treasury, address(spy), seized);
        vm.expectEmit(address(vault));
        emit StockVault.Returned(AGENT, agentOp, address(spy), SHARE / 2 - seized, 100_233_333, SPY_600, 2000, true);
        pool.markDefault(loanId);
        assertEq(spy.balanceOf(treasury), seized, "seizeTo: owed x 1.2 at the price");
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - seized, "the depositor: every other token, in the same call");
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Seized));
        assertEq(vault.held(address(spy)), 0);
        assertEq(spy.balanceOf(address(vault)), 0);
        assertEq(vault.openLines(), 0);
        // what seizeTo got is worth no more than (principal + fee) x 1.2 at the price used
        assertLe(seized * 600 / 1e12, (100 * USDC + 233_333) * 12_000 / 10_000);
    }

    /// The same default at $613.17: 100,233,333 × 12,000 × 1e20 / (10,000 × 61,317,000,000) leaves a remainder, so the
    /// seized amount is rounded up (the funder's favour): floor 196,160,933,509,467,195, seized one more.
    function test_default_roundsTheSeizureUp() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrowFor(100 * USDC, 7 days);
        _defaultFresh(loanId, 61_317_000_000);
        assertEq(spy.balanceOf(treasury), 196_160_933_509_467_196);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - 196_160_933_509_467_196);
    }

    /// Two loans: 50 for 7 days (fee 116,666) and 50 for 14 days (fee 50e6 × 100 × 14d / (10,000 × 30d) = 233,333).
    /// The first defaults: nothing is seized yet (the other still runs; the whole deposit stays locked, close refused).
    /// The second defaults: owed is both, exactly, 50,116,666 + 50,233,333 = 100,349,999; seized 100,349,999 × 2e9 =
    /// 200,699,998e9, the rest back.
    function test_default_withAnotherLoanOpen_seizesNothingYet_thenBothLoansExactly() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 first = _borrowFor(50 * USDC, 7 days);
        uint256 second = _borrowFor(50 * USDC, 14 days);
        _defaultFresh(first, SPY_600);
        assertEq(spy.balanceOf(treasury), 0, "nothing seized while another loan runs");
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Open));
        assertEq(spy.balanceOf(address(vault)), SHARE / 2, "the whole deposit stays");
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(StockVault.AgentDefaulted.selector, AGENT));
        vault.close(AGENT);
        _defaultFresh(second, SPY_600);
        assertEq(_poolDebt(AGENT), 100_349_999, "the pool's own records");
        assertEq(spy.balanceOf(treasury), 200_699_998_000_000_000);
        assertEq(spy.balanceOf(treasury), _ceil12(_poolDebt(AGENT), SPY_600));
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - 200_699_998_000_000_000);
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Seized));
    }

    /// The same two loans; the first defaults, the second is repaid: that repayment ends the sponsorship (the pool's
    /// onRelease), and the position is seized for the defaulted loan alone, 50,116,666: 100,233,332e9.
    function test_default_thenTheOtherLoanRepaid_seizesTheDefaultedOneExactly() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 first = _borrowFor(50 * USDC, 7 days);
        uint256 second = _borrowFor(50 * USDC, 14 days);
        _defaultFresh(first, SPY_600);
        assertEq(spy.balanceOf(treasury), 0);
        vm.prank(agentOp);
        pool.repay(second, AGENT, type(uint256).max);
        assertEq(_poolDebt(AGENT), 50_116_666);
        assertEq(spy.balanceOf(treasury), 100_233_332_000_000_000);
        assertEq(spy.balanceOf(treasury), _ceil12(_poolDebt(AGENT), SPY_600));
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - 100_233_332_000_000_000);
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Seized));
    }

    /// A close requested with a loan open freezes the line: the pool hands the undrawn 245 back. A default after it owes
    /// only the drawn 5 (1 day: fee 5e6 × 100 × 1d / (10,000 × 30d) = 1,666), not the line: owed 5,001,666, seized
    /// 5,001,666 × 2e9 = 10,003,332e9 of the 2 SPY.
    function test_default_afterACloseRequest_owesTheDrawnLoanOnly() public {
        _open(AGENT_PK, AGENT, 2 * SHARE); // $1,200: a 250 line (maxLine)
        uint256 loanId = _borrowFor(5 * USDC, 1 days);
        vm.prank(agentOp);
        vault.close(AGENT);
        _defaultFresh(loanId, SPY_600);
        assertEq(spy.balanceOf(treasury), 10_003_332_000_000_000);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - 10_003_332_000_000_000);
    }

    /// The same with a second loan repaid after the close: the pool gives back its 10 as it is repaid (onRelease), and
    /// the default still owes the defaulted 5 only: the same 10,003,332e9.
    function test_default_afterACloseAndARepayment_owesTheDrawnLoanOnly() public {
        _open(AGENT_PK, AGENT, 2 * SHARE);
        uint256 loanId = _borrowFor(5 * USDC, 1 days);
        uint256 other = _borrowFor(10 * USDC, 1 days);
        vm.prank(agentOp);
        vault.close(AGENT);
        vm.prank(agentOp);
        pool.repay(other, AGENT, type(uint256).max);
        _defaultFresh(loanId, SPY_600);
        assertEq(spy.balanceOf(treasury), 10_003_332_000_000_000);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - 10_003_332_000_000_000);
    }

    // ---- everything is seized when the price cannot be lent against, or does not cover the debt ----

    function test_default_stalePrice_seizesAll() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrowFor(100 * USDC, 7 days);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1); // the last round is 10 days old: over maxAge
        vm.recordLogs();
        pool.markDefault(loanId);
        assertEq(spy.balanceOf(treasury), SHARE / 2);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - SHARE / 2);
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Seized));
        assertFalse(_logged(StockVault.Returned.selector), "nothing went back, so no Returned");
    }

    function _logged(bytes32 topic) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic) return true;
        }
        return false;
    }

    /// A round at +30% within the window: a price-move hold (maxJumpBps 25%). Nothing goes back.
    function test_default_aPriceMoveHold_seizesAll() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrowFor(100 * USDC, 7 days);
        _defaultFresh(loanId, 780e8);
        assertEq(vault.lendStatus(address(spy)), vault.HOLD_PRICE_MOVED());
        assertEq(spy.balanceOf(treasury), SHARE / 2);
    }

    /// 70% loan-to-value: a 210 line on $300, drawn for 30 days (fee 2,100,000): owed 212.1, with the buffer 254.52.
    /// The price falls 25% (the move hold's own bound, not past it): $225 of collateral, less than that: all seized.
    function test_default_aDepositWorthLessThanOwedPlusBuffer_isAllSeized() public {
        vm.prank(owner);
        vault.setAsset(address(spy), address(spyFeed), 1 days + 1 hours, true, 7000, type(uint128).max);
        assertEq(_open(AGENT_PK, AGENT, SHARE / 2), 210 * USDC);
        uint256 loanId = _borrowFor(210 * USDC, 30 days);
        _defaultFresh(loanId, 450e8);
        assertEq(vault.lendStatus(address(spy)), 0, "no hold: it is the value that falls short");
        assertEq(spy.balanceOf(treasury), SHARE / 2);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - SHARE / 2);
    }

    // ---- the fallback paths: onRelease after a failed onDefault, and settle() ----

    /// onDefault fails: the pool's onRelease (the dead agent's residual line) finds a line that does not add up with
    /// the debt the hooks summed (the failed one is missing), so it seizes nothing; settle then sums the pool's loans:
    /// 100,233,333, seized 200,466,666e9, exactly as onDefault would have.
    function test_default_whenOnDefaultFailed_isLeftToSettle_whichSumsThePoolsLoans() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrowFor(100 * USDC, 7 days);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        _fresh(SPY_600);
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onDefault.selector), "");
        pool.markDefault(loanId);
        vm.clearMockedCalls();
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Open), "not seized on an incomplete sum");
        assertEq(spy.balanceOf(treasury), 0);
        vm.prank(anyone);
        vault.settle(AGENT, 0);
        assertEq(spy.balanceOf(treasury), 200_466_666_000_000_000);
        assertEq(spy.balanceOf(treasury), _ceil12(_poolDebt(AGENT), SPY_600));
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - 200_466_666_000_000_000);
    }

    /// Both hooks fail: settle sums the pool's loans exactly (whatever loan it is given): 200,466,666e9.
    function test_settle_afterBothHooksFailed_seizesTheExactDebt() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrowFor(100 * USDC, 7 days);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        _fresh(SPY_600);
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onDefault.selector), "");
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        pool.markDefault(loanId);
        vm.clearMockedCalls();
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Open));
        vm.prank(anyone);
        vault.settle(AGENT, loanId);
        assertEq(spy.balanceOf(treasury), 200_466_666_000_000_000);
        assertEq(spy.balanceOf(treasury), _ceil12(_poolDebt(AGENT), SPY_600));
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - 200_466_666_000_000_000);
    }

    /// While a loan the vault backs is still open, settle refuses (LoanOpen): the debt is not final. When it defaults
    /// too, onDefault seizes both exactly: 200,699,998e9.
    function test_settle_refusesWhileALoanOfTheVaultIsStillOpen() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 first = _borrowFor(50 * USDC, 7 days);
        uint256 second = _borrowFor(50 * USDC, 14 days);
        _defaultFresh(first, SPY_600);
        assertEq(pool.getAgent(AGENT).sponsor, VAULT_ID, "the other loan keeps the line");
        vm.expectRevert(abi.encodeWithSelector(StockVault.LoanOpen.selector, AGENT));
        vault.settle(AGENT, first);
        _defaultFresh(second, SPY_600);
        assertEq(spy.balanceOf(treasury), 200_699_998_000_000_000);
        assertEq(spy.balanceOf(treasury), _ceil12(_poolDebt(AGENT), SPY_600));
    }

    // ---- the recovery walk: bounded pages, resumable, final only at the end (review round 2, finding 1) ----

    /// Every hook fails, so settle must sum the pool's loans itself. Each call reads one bounded page of them (the
    /// pool's loan ids from the position's opening to the agent's last borrow, at most SETTLE_PAGE: 200), so an agent
    /// with a long history is settled over several calls; none of them ends the position early on a partial sum, and
    /// the last one seizes exactly what the pool's records say. 250 one-day loans of 5 repaid, then 100 for 7 days
    /// defaults: 251 loans, two pages; owed 100,233,333 (the repaid ones owe nothing): 200,466,666e9 seized.
    function test_settle_readsOneBoundedPagePerCall_andSeizesOnlyAtTheEnd() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        usdc.mint(agentOp, 10 * USDC);
        for (uint256 i; i < 250; ++i) {
            uint256 l = _borrowFor(5 * USDC, 1 days);
            vm.prank(agentOp);
            pool.repay(l, AGENT, type(uint256).max);
        }
        uint256 loanId = _borrowFor(100 * USDC, 7 days);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        _fresh(SPY_600);
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onDefault.selector), "");
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        pool.markDefault(loanId);
        vm.clearMockedCalls();
        uint256 g = gasleft();
        vault.settle(AGENT, loanId);
        uint256 firstPage = g - gasleft();
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Open), "a partial sum never ends the position");
        assertEq(spy.balanceOf(treasury), 0);
        vault.settle(AGENT, 0);
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Seized));
        assertEq(_poolDebt(AGENT), 100_233_333);
        assertEq(spy.balanceOf(treasury), 200_466_666_000_000_000);
        assertEq(spy.balanceOf(treasury), _ceil12(_poolDebt(AGENT), SPY_600));
        emit log_named_uint("settle, a page of 200 loans (with the range's two searches)", firstPage);
        assertLt(firstPage, 15_000_000, "a page is bounded");
    }

    /// reconcile takes the page size: in pages of 7, with another agent's loans between this one's (the walk reads the
    /// pool's loan ids and keeps this agent's and this vault's), the same exact debt, over as many calls as it takes,
    /// none of them final before the last. And it starts at the position's opening: the 30 loans another agent took
    /// before it are not read.
    function test_reconcile_inSmallPages_isExact_andStartsAtThePositionsOpening() public {
        _open(AGENT2_PK, AGENT2, SHARE / 2);
        usdc.mint(agentOp2, 10 * USDC);
        vm.prank(agentOp2);
        usdc.approve(address(pool), type(uint256).max);
        for (uint256 i; i < 30; ++i) {
            vm.prank(agentOp2);
            uint256 l = pool.borrow(AGENT2, 5 * USDC, 1 days, agentOp2, type(uint256).max);
            vm.prank(agentOp2);
            pool.repay(l, AGENT2, type(uint256).max);
        }
        vm.warp(vm.getBlockTimestamp() + 1);
        _open(AGENT_PK, AGENT, SHARE / 2);
        usdc.mint(agentOp, 10 * USDC);
        for (uint256 i; i < 10; ++i) {
            uint256 l = _borrowFor(5 * USDC, 1 days);
            vm.prank(agentOp);
            pool.repay(l, AGENT, type(uint256).max);
            vm.prank(agentOp2);
            l = pool.borrow(AGENT2, 5 * USDC, 1 days, agentOp2, type(uint256).max);
            vm.prank(agentOp2);
            pool.repay(l, AGENT2, type(uint256).max);
        }
        uint256 first = _borrowFor(50 * USDC, 7 days);
        uint256 second = _borrowFor(50 * USDC, 7 days);
        vm.warp(pool.getLoan(second).defaultableAt + 1);
        _fresh(SPY_600);
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onDefault.selector), "");
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        pool.markDefault(first);
        pool.markDefault(second);
        vm.clearMockedCalls();
        // the pool's loans from the opening to the last borrow: 20 (10 each) + 2 = 22; pages of 7: 4 calls
        uint256 calls;
        while (_status(AGENT) == StockVault.Status.Open) {
            vault.reconcile(AGENT, 7);
            ++calls;
            if (_status(AGENT) == StockVault.Status.Open) {
                assertEq(spy.balanceOf(treasury), 0, "nothing before the end");
            }
        }
        assertEq(calls, 4, "22 loans in pages of 7, none of the 30 before the opening");
        // 50 for 7 days twice: 116,666 each; owed 100,233,332; seized 100,233,332 x 2e9
        assertEq(_poolDebt(AGENT), 100_233_332);
        assertEq(spy.balanceOf(treasury), 200_466_664_000_000_000);
        assertEq(spy.balanceOf(treasury), _ceil12(_poolDebt(AGENT), SPY_600));
    }

    /// A release the vault never recorded (the pool's onRelease for a frozen line's repayment failed): the line no
    /// longer adds up with the debt, so neither hook seizes; settle sums the pool's loans: the defaulted 5 alone
    /// (5,001,666), 10,003,332e9 seized of the 2 SPY.
    function test_default_whenTheLineDoesNotAddUp_isLeftToSettle() public {
        _open(AGENT_PK, AGENT, 2 * SHARE);
        uint256 loanId = _borrowFor(5 * USDC, 1 days);
        uint256 other = _borrowFor(10 * USDC, 1 days);
        vm.prank(agentOp);
        vault.close(AGENT);
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        vm.prank(agentOp);
        pool.repay(other, AGENT, type(uint256).max); // the 10 it gives back is not recorded
        vm.clearMockedCalls();
        _defaultFresh(loanId, SPY_600);
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Open), "not seized on a line that does not add up");
        assertEq(spy.balanceOf(treasury), 0);
        vault.settle(AGENT, 0);
        assertEq(spy.balanceOf(treasury), 10_003_332_000_000_000);
        assertEq(spy.balanceOf(treasury), _ceil12(_poolDebt(AGENT), SPY_600));
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - 10_003_332_000_000_000);
    }

    // ---- a token the issuer acts on: a burn, a depositor it blocks, a pause, a multiplier ----

    FairRegistry fairReg;
    FairStock fair;
    MockFeed fairFeed;

    function _fairSetUp(int256 price) internal {
        fairReg = new FairRegistry();
        fair = new FairStock(address(fairReg));
        fairFeed = new MockFeed(8, price);
        vm.prank(owner);
        vault.setAsset(address(fair), address(fairFeed), 1 days + 1 hours, true, 5000, type(uint128).max);
        fair.mint(agentOp, 200 * SHARE);
        fair.mint(agentOp2, 200 * SHARE);
        vm.prank(agentOp);
        fair.approve(address(vault), type(uint256).max);
        vm.prank(agentOp2);
        fair.approve(address(vault), type(uint256).max);
    }

    function _openFair(uint256 pk, uint256 id, uint256 amount) internal returns (uint256) {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(id, pk);
        vm.prank(vm.addr(pk));
        return vault.open(id, address(fair), amount, c, sig);
    }

    function _defaultFair(uint256 loanId, int256 price) internal {
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        fairFeed.set(price, vm.getBlockTimestamp());
        pool.markDefault(loanId);
    }

    /// $1 a token; A and B deposit 100 each; the issuer burns 60 from the vault: each position is paid 70. A borrows 25
    /// for 7 days (fee 58,333): owed 25,058,333, seized 25,058,333 × 12,000 × 1e20 / (10,000 × 1e8) = 30,069,999,600e9
    /// of A's 70, the rest of A's 70 back to A, and B still closes with its whole 70.
    function test_default_afterAnIssuerBurn_splitsThePositionsShare() public {
        _fairSetUp(1e8);
        _openFair(AGENT_PK, AGENT, 100 * SHARE);
        _openFair(AGENT2_PK, AGENT2, 100 * SHARE);
        fair.adminBurn(address(vault), 60 * SHARE);
        vm.prank(agentOp);
        uint256 loanId = pool.borrow(AGENT, 25 * USDC, 7 days, agentOp, type(uint256).max);
        _defaultFair(loanId, 1e8);
        uint256 seized = 30_069_999_600_000_000_000;
        assertEq(fair.balanceOf(treasury), seized);
        assertEq(fair.balanceOf(agentOp), 100 * SHARE + 70 * SHARE - seized, "A: its share less what is owed");
        assertEq(vault.held(address(fair)), 100 * SHARE, "B's 100 still owed, at its share");
        vm.prank(agentOp2);
        vault.close(AGENT2);
        assertEq(fair.balanceOf(agentOp2), 100 * SHARE + 70 * SHARE, "B: its whole 70");
        assertEq(fair.balanceOf(address(vault)), 0);
    }

    /// The issuer blocks the depositor: the rest cannot be sent. The hook does not revert: seizeTo gets its part, the
    /// rest stays owed to the depositor (counted in `held`, out of rescue's reach) as a written-off position's tokens are,
    /// and anyone's reclaim sends it once the token moves. With $1 tokens, 100 deposited, 25 borrowed for 7 days: seized
    /// 30,069,999,600e9, owed back 69,930,000,400e9.
    function test_default_restThatCannotBeSent_staysOwed_andIsReclaimedLater() public {
        _fairSetUp(1e8);
        _openFair(AGENT_PK, AGENT, 100 * SHARE);
        vm.prank(agentOp);
        uint256 loanId = pool.borrow(AGENT, 25 * USDC, 7 days, agentOp, type(uint256).max);
        fairReg.setBlocked(agentOp, true);
        uint256 seized = 30_069_999_600_000_000_000;
        uint256 rest = 100 * SHARE - seized;
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        fairFeed.set(1e8, vm.getBlockTimestamp());
        vm.expectEmit(address(vault));
        emit StockVault.Returned(AGENT, agentOp, address(fair), rest, 25_058_333, 1e8, 2000, false);
        pool.markDefault(loanId);
        assertEq(pool.getAgent(AGENT).defaulted, true);
        assertEq(fair.balanceOf(treasury), seized, "seizeTo's part moved");
        assertEq(fair.balanceOf(agentOp), 100 * SHARE, "nothing reached the blocked depositor");
        StockVault.Position memory p = vault.getPosition(AGENT);
        assertEq(uint256(p.status), uint256(StockVault.Status.WrittenOff), "owed back, as a written-off line's tokens");
        assertEq(p.amount, rest);
        assertEq(vault.held(address(fair)), rest, "still counted as owed");
        assertEq(vault.openLines(), 0, "the line is gone all the same");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StockVault.Protected.selector, address(fair)));
        vault.rescue(address(fair), owner);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotSent.selector, AGENT));
        vault.reclaim(AGENT);
        // the record those tokens are owed on cannot be replaced by a new position (and the agent defaulted anyway)
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(StockVault.TokensOwed.selector, AGENT));
        vault.open(AGENT, address(fair), SHARE, c, sig);
        fairReg.setBlocked(agentOp, false);
        vm.prank(anyone);
        vault.reclaim(AGENT);
        assertEq(fair.balanceOf(agentOp), 100 * SHARE + rest);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Seized), "seized, rest sent");
        assertEq(vault.held(address(fair)), 0);
        assertEq(fair.balanceOf(address(vault)), 0);
    }

    function _noHookFailed() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CreditPoolV2.HookFailed.selector, "no hook failed");
        }
    }

    /// The depositor's transfer burns all the gas it is given: RETURN_GAS_RESERVE leaves onDefault enough to record the
    /// rest as owed, and the pool's onRelease (the same markDefault: the loan was the last) fails to send it too, and
    /// still returns. Neither hook fails; the rest is reclaimed once the token moves. Seized 30,069,999,600e9 of 100.
    /// forge-config: default.isolate = true
    function test_default_aRestTransferThatBurnsAllItsGas_neverFailsTheHooks() public {
        _fairSetUp(1e8);
        _openFair(AGENT_PK, AGENT, 100 * SHARE);
        vm.prank(agentOp);
        uint256 loanId = pool.borrow(AGENT, 25 * USDC, 7 days, agentOp, type(uint256).max);
        fair.setHeavy(agentOp, 0);
        vm.recordLogs();
        _defaultFair(loanId, 1e8);
        _noHookFailed();
        uint256 seized = 30_069_999_600_000_000_000;
        assertEq(fair.balanceOf(treasury), seized);
        StockVault.Position memory p = vault.getPosition(AGENT);
        assertEq(uint256(p.status), uint256(StockVault.Status.WrittenOff), "owed");
        assertTrue(p.closing, "marked as a default's rest");
        assertEq(p.amount, 100 * SHARE - seized);
        fair.setHeavy(address(0), 0);
        vault.reclaim(AGENT);
        assertEq(fair.balanceOf(agentOp), 200 * SHARE - seized);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Seized));
    }

    /// A rest transfer that needs more gas than the seizing hook has left (250,000): the hook does not fail, the rest
    /// stays owed (Returned, sent false), and anyone's reclaim sends it in a transaction of its own; the position reads
    /// Seized again.
    /// forge-config: default.isolate = true
    function test_default_aRestTooHeavyForTheHook_staysOwed_andAnyoneReclaimsIt() public {
        _fairSetUp(1e8);
        _openFair(AGENT_PK, AGENT, 100 * SHARE);
        vm.prank(agentOp);
        uint256 loanId = pool.borrow(AGENT, 25 * USDC, 7 days, agentOp, type(uint256).max);
        fair.setHeavy(agentOp, 250_000);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        fairFeed.set(1e8, vm.getBlockTimestamp());
        uint256 seized = 30_069_999_600_000_000_000;
        vm.expectEmit(address(vault));
        emit StockVault.Returned(AGENT, agentOp, address(fair), 100 * SHARE - seized, 25_058_333, 1e8, 2000, false);
        vm.recordLogs();
        pool.markDefault(loanId);
        _noHookFailed();
        assertEq(fair.balanceOf(treasury), seized);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.WrittenOff), "the rest owed");
        vm.prank(anyone);
        vault.reclaim(AGENT);
        assertEq(fair.balanceOf(agentOp), 200 * SHARE - seized);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Seized));
        assertEq(vault.held(address(fair)), 0);
    }

    /// Two loans, the first defaults, the second is repaid: the pool's onRelease seizes 10 + its fee (23,333) exactly,
    /// 10,023,333 × 1.2e12 = 12,027,999,600e9; the rest's transfer needs more gas than that hook has left (250,000), so
    /// the rest stays owed, and anyone's reclaim sends it; the position reads Seized again.
    /// forge-config: default.isolate = true
    function test_default_aRestOwedAtTheEndOfTheSponsorship_isReclaimedByAnyone() public {
        _fairSetUp(1e8);
        _openFair(AGENT_PK, AGENT, 100 * SHARE);
        vm.startPrank(agentOp);
        uint256 first = pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
        uint256 second = pool.borrow(AGENT, 10 * USDC, 14 days, agentOp, type(uint256).max);
        vm.stopPrank();
        fair.setHeavy(agentOp, 250_000);
        _defaultFair(first, 1e8);
        assertEq(fair.balanceOf(treasury), 0, "nothing yet: the second loan runs");
        usdc.mint(agentOp, 20 * USDC);
        vm.prank(agentOp);
        pool.repay(second, AGENT, type(uint256).max); // the dead agent's last loan closes: the pool's onRelease
        uint256 seized = 12_027_999_600_000_000_000;
        assertEq(fair.balanceOf(treasury), seized);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.WrittenOff), "the rest owed");
        vm.prank(anyone);
        vault.reclaim(AGENT);
        assertEq(fair.balanceOf(agentOp), 200 * SHARE - seized);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Seized));
    }

    /// writeOff's own written-off positions are not a default's: their reclaim still closes them.
    function test_writeOff_stillClosesOnReclaim_evenIfClosingWasRequested() public {
        _fairSetUp(1e8);
        _openFair(AGENT_PK, AGENT, 100 * SHARE);
        vm.prank(agentOp);
        uint256 loanId = pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
        vm.prank(agentOp);
        vault.close(AGENT); // closing, with the loan open
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max); // the last onRelease fails: the position stays open, closing
        vm.clearMockedCalls();
        fair.setPaused(true);
        vm.prank(owner);
        vault.writeOff(AGENT);
        assertFalse(vault.getPosition(AGENT).closing, "writeOff clears it");
        fair.setPaused(false);
        vault.reclaim(AGENT);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(fair.balanceOf(agentOp), 200 * SHARE);
    }

    /// A paused token cannot be seized at all: onDefault fails as before (the pool goes on, HookFailed) and onRelease
    /// does not seize on a sum that misses it; once the token moves, settle seizes the exact debt (25,058,333):
    /// 25,058,333 × 1.2e12 = 30,069,999,600e9.
    function test_default_aPausedToken_failsTheHook_thenSettleSeizesExactly() public {
        _fairSetUp(1e8);
        _openFair(AGENT_PK, AGENT, 100 * SHARE);
        vm.prank(agentOp);
        uint256 loanId = pool.borrow(AGENT, 25 * USDC, 7 days, agentOp, type(uint256).max);
        fair.setPaused(true);
        _defaultFair(loanId, 1e8);
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Open), "the hook could not move the token");
        fair.setPaused(false);
        vault.settle(AGENT, loanId);
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Seized));
        assertEq(fair.balanceOf(treasury), 30_069_999_600_000_000_000);
        assertEq(fair.balanceOf(agentOp), 200 * SHARE - 30_069_999_600_000_000_000);
    }

    /// A multiplier change within the cooldown holds lending: a default during it seizes everything.
    function test_default_aMultiplierHold_seizesAll() public {
        _fairSetUp(1e8);
        _openFair(AGENT_PK, AGENT, 100 * SHARE);
        vm.prank(agentOp);
        uint256 loanId = pool.borrow(AGENT, 25 * USDC, 7 days, agentOp, type(uint256).max);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        fair.setEffectiveAt(vm.getBlockTimestamp() - 1 hours);
        fairFeed.set(1e8, vm.getBlockTimestamp());
        assertEq(vault.lendStatus(address(fair)), vault.HOLD_MULTIPLIER());
        pool.markDefault(loanId);
        assertEq(fair.balanceOf(treasury), 100 * SHARE);
        assertEq(fair.balanceOf(agentOp), 100 * SHARE);
    }

    // ---- the buffer ----

    function test_seizeBuffer_is20Percent_withNothingStored() public view {
        assertEq(vault.seizeBufferBps(), 2000);
        assertEq(vault.seizeBufferOf(address(spy)), 2000);
        assertEq(vault.seizeBufferOf(address(0)), 2000);
    }

    function test_setSeizeBuffer_boundedAndOwnerOnly() public {
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        vault.setSeizeBuffer(address(0), 3000);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        vault.setSeizeBuffer(address(spy), 3000);
        vm.startPrank(owner);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setSeizeBuffer(address(0), 999);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setSeizeBuffer(address(0), 10_001);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setSeizeBuffer(address(0), 0); // the vault's own is never unset
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setSeizeBuffer(address(spy), 999);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setSeizeBuffer(address(spy), 10_001);
        vm.expectEmit(address(vault));
        emit StockVault.SeizeBufferSet(address(0), 1000);
        vault.setSeizeBuffer(address(0), 1000);
        vm.expectEmit(address(vault));
        emit StockVault.SeizeBufferSet(address(spy), 10_000);
        vault.setSeizeBuffer(address(spy), 10_000);
        assertEq(vault.seizeBufferBps(), 1000);
        assertEq(vault.seizeBufferOf(address(spy)), 10_000);
        assertEq(vault.seizeBufferOf(address(usdc)), 1000, "a token with no buffer of its own: the vault's");
        vault.setSeizeBuffer(address(spy), 0);
        vm.stopPrank();
        assertEq(vault.seizeBufferOf(address(spy)), 1000, "0 hands the token back to the vault's buffer");
    }

    /// SPY's own 50% over the vault's 30%: 100,233,333 × 15,000 × 1e20 / (10,000 × 600e8) = 250,583,332,500,000,000.
    function test_default_usesTheTokensOwnBuffer() public {
        vm.startPrank(owner);
        vault.setSeizeBuffer(address(0), 3000);
        vault.setSeizeBuffer(address(spy), 5000);
        vm.stopPrank();
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrowFor(100 * USDC, 7 days);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        _fresh(SPY_600);
        uint256 seized = 250_583_332_500_000_000;
        vm.expectEmit(address(vault));
        emit StockVault.Returned(AGENT, agentOp, address(spy), SHARE / 2 - seized, 100_233_333, SPY_600, 5000, true);
        pool.markDefault(loanId);
        assertEq(spy.balanceOf(treasury), seized);
    }

    /// The vault's 30% when the token has none: 100,233,333 × 13,000 × 1e20 / (10,000 × 600e8), rounded up:
    /// 217,172,221,500,000,000.
    function test_default_usesTheVaultsBuffer_whenTheTokenHasNone() public {
        vm.prank(owner);
        vault.setSeizeBuffer(address(0), 3000);
        _open(AGENT_PK, AGENT, SHARE / 2);
        _defaultFresh(_borrowFor(100 * USDC, 7 days), SPY_600);
        assertEq(spy.balanceOf(treasury), 217_172_221_500_000_000);
    }

    /// The undrawn line one position gave back is not carried to the next one: position 1 freezes 10 of undrawn line
    /// (a 250 line, 240 drawn, closed, repaid), position 2 owes its own 100 + 233,333 exactly: 200,466,666e9 seized.
    function test_nextPosition_owesItsOwnLine_notTheLastOnesRelease() public {
        _open(AGENT_PK, AGENT, 2 * SHARE);
        uint256 first = _borrowFor(240 * USDC, 1 days);
        vm.prank(agentOp);
        vault.close(AGENT);
        vm.prank(agentOp);
        pool.repay(first, AGENT, type(uint256).max);
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Closed));
        _open(AGENT_PK, AGENT, 2 * SHARE);
        _defaultFresh(_borrowFor(100 * USDC, 7 days), SPY_600);
        assertEq(spy.balanceOf(treasury), 200_466_666_000_000_000);
    }

    // ---- the hook's gas ----

    uint256 internal loan_;

    function _markLoan() internal {
        pool.markDefault(loan_);
    }

    function _repayLoan() internal {
        vm.prank(agentOp);
        pool.repay(loan_, AGENT, type(uint256).max);
    }

    /// What the vault's hooks cost inside the pool's call `action`: the call stubbed (both hooks mocked) from a snapshot,
    /// then the real call from the same state, which it leaves. Each call is its own transaction (isolate), every
    /// account cold, as on mainnet.
    function _hookCost(function() internal action) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        vm.mockCall(address(vault), abi.encodeWithSelector(StockVault.onDefault.selector), "");
        vm.mockCall(address(vault), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        uint256 g = gasleft();
        action();
        uint256 stubbed = g - gasleft();
        vm.clearMockedCalls();
        vm.revertToState(snap);
        g = gasleft();
        action();
        return (g - gasleft()) - stubbed;
    }

    /// Every hook path of a default, two loans open (mock token and feed; the live tokens' figures are the fork
    /// test's): the first default only sums its debt (onDefault); the second's (the last loan) is summed and then seized
    /// by the pool's onRelease in the same call; or the second is repaid, and onRelease seizes. Each well inside the
    /// pool's HOOK_GAS (the last default's figure is both hooks: each has its own budget).
    /// forge-config: default.isolate = true
    function test_hooks_gas_staysInsideThePoolsHookBudget() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 first = _borrowFor(50 * USDC, 7 days);
        uint256 second = _borrowFor(50 * USDC, 14 days);
        uint256 budget = pool.HOOK_GAS();
        vm.warp(pool.getLoan(first).defaultableAt + 1);
        _fresh(SPY_600);
        loan_ = first;
        uint256 summing = _hookCost(_markLoan);
        assertEq(uint256(_status(AGENT)), uint256(StockVault.Status.Open));
        uint256 snap = vm.snapshotState();
        loan_ = second;
        uint256 byRelease = _hookCost(_repayLoan);
        assertEq(spy.balanceOf(treasury), 100_233_332_000_000_000, "onRelease seized the defaulted loan");
        vm.revertToState(snap); // the test's own storage too: loan_ is the first loan again
        vm.warp(pool.getLoan(second).defaultableAt + 1);
        _fresh(SPY_600);
        loan_ = second;
        uint256 byLast = _hookCost(_markLoan);
        assertEq(spy.balanceOf(treasury), 200_699_998_000_000_000, "the last default seized both");
        emit log_named_uint("onDefault, a loan with another still open (sums the debt)", summing);
        emit log_named_uint("the last loan defaults: onDefault sums, onRelease seizes", byLast);
        emit log_named_uint("the last loan repaid: onRelease seizes", byRelease);
        assertLt(summing, budget / 4);
        assertLt(byLast, budget * 3 / 4);
        assertLt(byRelease, budget * 3 / 4);
    }

    /// In the pool's own call, the hook does not fail: no HookFailed, and the rest goes back in the same transaction.
    function test_onDefault_inThePoolsCall_neverFails() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrowFor(100 * USDC, 7 days);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        _fresh(SPY_600);
        vm.recordLogs();
        pool.markDefault(loanId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool returned;
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CreditPoolV2.HookFailed.selector, "no hook failed");
            if (logs[i].topics[0] == StockVault.Returned.selector) returned = true;
        }
        assertTrue(returned);
    }
}
