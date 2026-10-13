// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CreditPool} from "../src/CreditPool.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {StockVault} from "../src/StockVault.sol";
import {deployStockVault} from "./StockVaultDeploy.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";

/// A Chainlink AggregatorV3 whose answer and age the test sets. Every `set` publishes a new round, as a feed does; the
/// constructor publishes two at the same answer, a month apart, so the vault's price-move check has history to read.
contract MockFeed {
    uint8 public decimals;
    int256[] internal answers;
    uint256[] internal times;
    bool public broken;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answers.push(a);
        times.push(block.timestamp - 30 days);
        answers.push(a);
        times.push(block.timestamp);
    }

    function set(int256 a, uint256 at) external {
        answers.push(a);
        times.push(at);
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function rounds() external view returns (uint256) {
        return answers.length;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        uint256 n = answers.length;
        return (uint80(n), answers[n - 1], times[n - 1], times[n - 1], uint80(n));
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        require(id >= 1 && id <= answers.length, "No data present");
        return (id, answers[id - 1], times[id - 1], times[id - 1], id);
    }
}

/// A Robinhood stock token: an ERC-20 of 18 decimals with the advisory `oraclePaused()` flag.
contract MockStock is ERC20 {
    bool public oraclePaused;

    constructor(string memory s) ERC20(s, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }
}

contract StockVaultBase is Test {
    uint256 constant USDC = 1e6;
    uint256 constant SHARE = 1e18;

    MockUSDC usdc;
    MockIdentityRegistry reg;
    CreditPoolV2 pool;
    StockVault vault;
    MockStock spy;
    MockFeed spyFeed;

    address timelock = makeAddr("timelock");
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury"); // seizeTo
    address sink = makeAddr("sink");
    address lender = makeAddr("lender");
    address anyone = makeAddr("anyone");

    uint256 constant AGENT_PK = 0xA1;
    uint256 constant AGENT2_PK = 0xA2;
    address agentOp = vm.addr(AGENT_PK);
    address agentOp2 = vm.addr(AGENT2_PK);

    uint256 VAULT_ID;
    uint256 AGENT;
    uint256 AGENT2;

    function _poolParams() internal pure returns (CreditPoolV2.Params memory) {
        return CreditPoolV2.Params({
            minLoan: 5e6,
            maxLoan: 500e6,
            minTerm: 1 days,
            maxTerm: 30 days,
            grace: 3 days,
            minScoreTerm: 7 days,
            feeBps: 100,
            sponsorFeeBps: 2500,
            protocolFeeBps: 1500,
            minStake: 10e6,
            maxUtilizationBps: 9000,
            keeperBounty: 1e5
        });
    }

    function _params() internal pure returns (StockVault.Params memory) {
        return StockVault.Params({ltvBps: 5000, maxLine: 250 * USDC, epochCap: 1000 * USDC, epochLength: 7 days});
    }

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        usdc = new MockUSDC();
        reg = new MockIdentityRegistry();
        pool = new CreditPoolV2(
            IERC20(address(usdc)),
            IERC8004Identity(address(reg)),
            CreditPool(address(0)),
            timelock,
            timelock,
            _poolParams()
        );
        usdc.mint(address(this), 21 * USDC);
        usdc.approve(address(pool), 21 * USDC);
        pool.seed();
        pool.fundReserve(20 * USDC);

        vault = deployStockVault(pool, owner, treasury, sink, _params(), owner); // behind its proxy, as it deploys
        spy = new MockStock("SPY");
        spyFeed = new MockFeed(8, 600e8); // $600 a token, 8 decimals like Robinhood's feeds
        vm.prank(owner);
        vault.setAsset(address(spy), address(spyFeed), 1 days + 1 hours, true, 5000, type(uint128).max);

        usdc.mint(lender, 10_000 * USDC);
        vm.startPrank(lender);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(10_000 * USDC, lender, 0);
        vm.stopPrank();

        vm.startPrank(owner);
        VAULT_ID = reg.register("priors-stocks");
        reg.safeTransferFrom(owner, address(vault), VAULT_ID);
        vault.adopt(VAULT_ID);
        vm.stopPrank();
        usdc.mint(owner, 1000 * USDC);
        vm.startPrank(owner);
        usdc.approve(address(vault), type(uint256).max);
        vault.fund(1000 * USDC);
        vm.stopPrank();

        vm.prank(agentOp);
        AGENT = reg.register("ipfs://agent");
        vm.prank(agentOp2);
        AGENT2 = reg.register("ipfs://agent2");
        spy.mint(agentOp, 10 * SHARE);
        spy.mint(agentOp2, 10 * SHARE);
        vm.prank(agentOp);
        spy.approve(address(vault), type(uint256).max);
        vm.prank(agentOp2);
        spy.approve(address(vault), type(uint256).max);
        usdc.mint(agentOp, 100 * USDC);
        vm.prank(agentOp);
        usdc.approve(address(pool), type(uint256).max);
    }

    function _consent(uint256 id, uint256 pk) internal view returns (CreditPoolV2.Consent memory c, bytes memory sig) {
        c = CreditPoolV2.Consent({
            agentId: id,
            sponsorId: VAULT_ID,
            owner: vm.addr(pk),
            maxPremiumBps: 0,
            nonce: pool.nonces(id),
            deadline: block.timestamp + 1 days
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, pool.consentDigest(c));
        sig = abi.encodePacked(r, s, v);
    }

    function _open(uint256 pk, uint256 id, uint256 amount) internal returns (uint256 line) {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(id, pk);
        vm.prank(vm.addr(pk));
        line = vault.open(id, address(spy), amount, c, sig);
    }

    function _borrow(address op, uint256 id, uint256 amount) internal returns (uint256) {
        vm.prank(op);
        return pool.borrow(id, amount, 7 days, op, type(uint256).max);
    }
}

contract StockVaultTest is StockVaultBase {
    // ---- opening: collateral in, line at ltv of its value (Criteria 8a, 8b) ----

    function test_open_holdsTheCollateral_andVouchesHalfItsValue() public {
        uint256 line = _open(AGENT_PK, AGENT, SHARE / 2); // half a SPY at $600 = $300, line 50% = $150
        assertEq(line, 150 * USDC);
        assertEq(spy.balanceOf(address(vault)), SHARE / 2);
        assertEq(vault.held(address(spy)), SHARE / 2);
        StockVault.Position memory p = vault.getPosition(AGENT);
        assertEq(p.amount, SHARE / 2);
        assertEq(p.depositor, agentOp);
        assertEq(p.owner, agentOp);
        assertEq(uint256(p.line), 150 * USDC);
        CreditPoolV2.Agent memory a = pool.getAgent(AGENT);
        assertEq(a.sponsor, VAULT_ID);
        assertEq(a.delegatedIn, 150 * USDC);
    }

    function test_open_lineIsCappedAtMaxLine() public {
        assertEq(_open(AGENT_PK, AGENT, 2 * SHARE), 250 * USDC); // $1,200 of SPY, 50% = $600, capped at $250
    }

    function test_open_refusesALineUnderThePoolsMinimumLoan() public {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(StockVault.LineTooSmall.selector, 3 * USDC, 5 * USDC));
        vault.open(AGENT, address(spy), SHARE / 100, c, sig); // $6 of SPY: a $3 line
    }

    function test_open_onlyTheAgentsController() public {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        spy.mint(anyone, SHARE);
        vm.startPrank(anyone);
        spy.approve(address(vault), SHARE);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotController.selector, AGENT, anyone));
        vault.open(AGENT, address(spy), SHARE, c, sig);
        vm.stopPrank();
    }

    function test_open_refusesATokenThatIsNotAccepted() public {
        MockStock other = new MockStock("XYZ");
        other.mint(agentOp, SHARE);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.startPrank(agentOp);
        other.approve(address(vault), SHARE);
        vm.expectRevert(abi.encodeWithSelector(StockVault.AssetNotAccepted.selector, address(other)));
        vault.open(AGENT, address(other), SHARE, c, sig);
        vm.stopPrank();
    }

    function test_open_refusesAStalePrice() public {
        spyFeed.set(600e8, block.timestamp - 2 days);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(StockVault.PriceUnavailable.selector, address(spy)));
        vault.open(AGENT, address(spy), SHARE, c, sig);
    }

    function test_open_needsTheOwnersConsent() public {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT2_PK); // signed by someone else
        vm.prank(agentOp);
        vm.expectRevert();
        vault.open(AGENT, address(spy), SHARE, c, sig);
    }

    // ---- borrowing within the line (Criterion 8c) ----

    function test_borrow_upToTheLine_andOneMoreUsdgIsRefused() public {
        _open(AGENT_PK, AGENT, SHARE / 2); // $150 line
        _borrow(agentOp, AGENT, 150 * USDC);
        assertEq(pool.getAgent(AGENT).principalOut, 150 * USDC);
        vm.prank(agentOp);
        vm.expectRevert();
        pool.borrow(AGENT, 1 * USDC, 7 days, agentOp, type(uint256).max);
    }

    // ---- refusals (Criteria 9a, 9b, 9c) ----

    function test_canBorrow_refusesAStalePrice() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        vm.warp(block.timestamp + 1 days + 1 hours + 1); // the feed has not updated since
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
        spyFeed.set(600e8, block.timestamp); // a fresh round: lending resumes
        _borrow(agentOp, AGENT, 10 * USDC);
    }

    function test_canBorrow_refusesWhileTheTokensOracleIsPaused() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        spy.setOraclePaused(true);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
        spy.setOraclePaused(false);
        _borrow(agentOp, AGENT, 10 * USDC);
    }

    function test_canBorrow_refusesWhenTheCollateralNoLongerCoversTheDebtPlusTheLoan() public {
        _open(AGENT_PK, AGENT, SHARE / 2); // $300 of SPY, $150 line
        _borrow(agentOp, AGENT, 120 * USDC);
        spyFeed.set(480e8, block.timestamp); // SPY falls a fifth: $240 of collateral, limit $120, all drawn
        assertEq(vault.lendStatus(address(spy)), 0, "a fifth is under the price-move hold");
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 5 * USDC, 7 days, agentOp, type(uint256).max);
        assertEq(vault.borrowRoom(AGENT), 0);
        // more collateral restores room
        vm.prank(agentOp);
        vault.addCollateral(AGENT, SHARE / 4); // +$120
        _borrow(agentOp, AGENT, 5 * USDC);
    }

    function test_canBorrow_refusesWhenTheFeedReverts_orAnswersNothing() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        spyFeed.setBroken(true);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
        spyFeed.setBroken(false);
        spyFeed.set(0, block.timestamp);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
    }

    function test_canBorrow_stopsOnceTheAgentChangesHands_andAnyoneMayThenClose() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        vm.prank(agentOp);
        reg.transferFrom(agentOp, agentOp2, AGENT);
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 10 * USDC, 7 days, agentOp2, type(uint256).max);
        vm.prank(anyone);
        vault.close(AGENT);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE, "every token back to the depositor, not the new owner");
    }

    function test_canBorrow_refusesWhilePaused() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        vm.prank(owner);
        vault.pause(true);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, VAULT_ID));
        pool.borrow(AGENT, 10 * USDC, 7 days, agentOp, type(uint256).max);
    }

    // ---- default: seizure (Criterion 10) ----

    function test_default_seizesTheCollateral_toSeizeTo_neverToTheDepositor() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrow(agentOp, AGENT, 100 * USDC);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        pool.markDefault(loanId);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Seized));
        assertEq(spy.balanceOf(treasury), SHARE / 2);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - SHARE / 2, "the depositor gets nothing back");
        assertEq(vault.held(address(spy)), 0);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NoPosition.selector, AGENT));
        vault.close(AGENT);
    }

    /// onDefault fails: the pool's onRelease that follows (the dead agent's residual line) does not seize on a debt that
    /// misses the failed default (the fair default, 2026-10-12): the position stays open, and settle, which sums the
    /// pool's loans, seizes it (here every token: the price is stale by the time the loan defaults).
    function test_default_whenOnDefaultFailed_settleSeizes() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrow(agentOp, AGENT, 100 * USDC);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onDefault.selector), "");
        pool.markDefault(loanId);
        vm.clearMockedCalls();
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Open));
        vm.prank(anyone);
        vault.settle(AGENT, loanId);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Seized));
        assertEq(spy.balanceOf(treasury), SHARE / 2);
    }

    function test_settle_seizesByHand_whenTheHookDidNotRun() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrow(agentOp, AGENT, 100 * USDC);
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        // both hooks fail (onRelease is the pool's second chance after onDefault): the position stays open
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onDefault.selector), "");
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        pool.markDefault(loanId);
        vm.clearMockedCalls();
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Open));
        vm.prank(anyone);
        vault.settle(AGENT, loanId);
        assertEq(spy.balanceOf(treasury), SHARE / 2);
    }

    // ---- closing ----

    function test_close_withNoLoan_returnsEveryToken_andRefundsTheEpoch() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 before = vault.epochRoom();
        vm.prank(agentOp);
        vault.close(AGENT);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(vault.epochRoom(), before + 150 * USDC);
    }

    function test_close_withALoanOpen_returnsTheTokensWhenItIsRepaid() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrow(agentOp, AGENT, 50 * USDC);
        vm.prank(agentOp);
        vault.close(AGENT);
        assertTrue(vault.getPosition(AGENT).closing);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE - SHARE / 2, "held while the loan is open");
        vm.prank(agentOp);
        vm.expectRevert(); // the line is frozen
        pool.borrow(AGENT, 5 * USDC, 7 days, agentOp, type(uint256).max);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE);
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
    }

    function test_close_onlyDepositorOrController() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotDepositorOrController.selector, AGENT, anyone));
        vault.close(AGENT);
    }

    function test_freezePosition_returnsTheTokens_neverSeizes_andKeepsTheEpochSpent() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 room = vault.epochRoom();
        vm.prank(owner);
        vault.freezePosition(AGENT);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE);
        assertEq(spy.balanceOf(treasury), 0);
        assertEq(vault.epochRoom(), room, "an evicted position cannot reopen at once");
    }

    // ---- the owner cannot reach collateral ----

    function test_rescue_cannotTakeHeldCollateral() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StockVault.Protected.selector, address(spy)));
        vault.rescue(address(spy), owner);
        spy.mint(address(vault), SHARE); // a stray transfer can be rescued, the collateral stays
        vm.prank(owner);
        vault.rescue(address(spy), owner);
        assertEq(spy.balanceOf(address(vault)), SHARE / 2);
    }

    function test_setAsset_cannotSwapTheFeedUnderHeldCollateral() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        MockFeed other = new MockFeed(8, 6000e8);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StockVault.Protected.selector, address(spy)));
        vault.setAsset(address(spy), address(other), 1 days, true, 5000, type(uint128).max);
    }

    function test_setParams_neverAboveSeventyPercent() public {
        StockVault.Params memory p = _params();
        p.ltvBps = 7001;
        vm.prank(owner);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setParams(p);
    }

    function test_epochCap_boundsNewLines() public {
        StockVault.Params memory p = _params();
        p.epochCap = 200 * USDC;
        vm.prank(owner);
        vault.setParams(p);
        _open(AGENT_PK, AGENT, SHARE / 2); // $150
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT2, AGENT2_PK);
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(StockVault.EpochCapReached.selector, 150 * USDC, 50 * USDC));
        vault.open(AGENT2, address(spy), SHARE / 2, c, sig);
    }

    // ---- the stake keeps room for every line's fee (review M1) ----

    function _maxLine(uint256 maxLine) internal {
        StockVault.Params memory p = _params();
        p.maxLine = maxLine;
        p.epochCap = 5000 * USDC;
        vm.prank(owner);
        vault.setParams(p);
    }

    function test_open_keepsFeeRoom_forEveryOpenLine() public {
        _maxLine(1000 * USDC);
        uint256 free = pool.freeBacking(VAULT_ID); // the whole 1000 USDG stake
        // 10 SPY ($6,000) asks the whole stake as a line: its 30-day fee (1%) would find no backing
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NoFeeRoom.selector, 1010 * USDC, free));
        vault.open(AGENT, address(spy), 10 * SHARE, c, sig);
    }

    function test_openLines_canEachBeDrawnInFull_overTheLongestTerm() public {
        _maxLine(500 * USDC);
        uint256 amount = 165 * SHARE / 100; // 1.65 SPY = $990: a 495 USDG line
        assertEq(_open(AGENT_PK, AGENT, amount), 495 * USDC);
        // a second line of 500 (1.7 SPY, capped) would leave no room for the fees: refused; 495 fits exactly
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT2, AGENT2_PK);
        uint256 free = pool.freeBacking(VAULT_ID); // 505
        vm.prank(agentOp2);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NoFeeRoom.selector, 500 * USDC + 9_950_000, free));
        vault.open(AGENT2, address(spy), 170 * SHARE / 100, c, sig);
        assertEq(_open(AGENT2_PK, AGENT2, amount), 495 * USDC);
        assertEq(vault.openLines(), 990 * USDC);
        vm.prank(agentOp);
        pool.borrow(AGENT, 495 * USDC, 30 days, agentOp, type(uint256).max);
        vm.prank(agentOp2);
        pool.borrow(AGENT2, 495 * USDC, 30 days, agentOp2, type(uint256).max);
        assertEq(pool.getAgent(AGENT).principalOut + pool.getAgent(AGENT2).principalOut, 990 * USDC);
    }

    function test_retire_keepsTheOpenLinesFeeRoom() public {
        _maxLine(500 * USDC);
        _open(AGENT_PK, AGENT, 165 * SHARE / 100); // 495 USDG line, fee room 4.95
        uint256 free = pool.freeBacking(VAULT_ID);
        vm.startPrank(owner);
        uint256 tooMuch = pool.convertToShares(free - 4 * USDC); // would leave 4 USDG, under 4.95
        vm.expectRevert(
            abi.encodeWithSelector(
                StockVault.NoFeeRoom.selector, 4_950_000, pool.freeBacking(VAULT_ID) - pool.convertToAssets(tooMuch)
            )
        );
        vault.retire(tooMuch, owner);
        vault.retire(pool.convertToShares(free - 5 * USDC), owner);
        vm.stopPrank();
        assertGe(pool.freeBacking(VAULT_ID), 4_950_000);
    }

    // ---- idle positions expire (review M1) ----

    function test_expire_closesAnIdlePosition_forAnyone_andKeepsTheEpochSpent() public {
        vm.prank(owner);
        vault.setIdleAfter(1 days);
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 room = vault.epochRoom();
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotIdle.selector, AGENT));
        vault.expire(AGENT);
        vm.warp(block.timestamp + 1 days);
        vm.prank(anyone);
        vault.expire(AGENT);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE, "every token back to the depositor");
        assertEq(uint256(vault.getPosition(AGENT).status), uint256(StockVault.Status.Closed));
        assertEq(vault.epochRoom(), room, "no refund: it cannot reopen at once");
        assertEq(vault.openLines(), 0);
    }

    function test_expire_notWhileALoanIsOpen_andCountsFromTheLastRepayment() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 t0 = vm.getBlockTimestamp(); // not block.timestamp: the optimizer may read it again after a warp
        uint256 loanId = _borrow(agentOp, AGENT, 50 * USDC);
        vm.warp(t0 + 5 days);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotIdle.selector, AGENT));
        vault.expire(AGENT); // a loan is open
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotIdle.selector, AGENT));
        vault.expire(AGENT); // just repaid
        vm.warp(t0 + 30 days); // 30 days from the loan, 25 from its repayment: not idle yet (review L2)
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotIdle.selector, AGENT));
        vault.expire(AGENT);
        vm.warp(t0 + 5 days + 30 days);
        vault.expire(AGENT);
        assertEq(spy.balanceOf(agentOp), 10 * SHARE);
    }

    function test_expire_neverWhileALoanIsOpen_evenPastIdleAfter() public {
        vm.prank(owner);
        vault.setIdleAfter(1 days);
        _open(AGENT_PK, AGENT, SHARE / 2);
        vm.prank(agentOp);
        pool.borrow(AGENT, 50 * USDC, 30 days, agentOp, type(uint256).max);
        vm.warp(block.timestamp + 20 days); // long idle by the clock, but a loan is still running
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotIdle.selector, AGENT));
        vault.expire(AGENT);
        assertFalse(vault.getPosition(AGENT).closing, "nobody can freeze a borrower's line");
    }

    // ---- collateral only from its depositor (review L3) ----

    function test_addCollateral_depositorOnly() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        vm.prank(agentOp);
        pool.setDelegate(AGENT, anyone); // a controller, not the depositor
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotDepositor.selector, AGENT, anyone));
        vault.addCollateral(AGENT, SHARE);
        vm.prank(agentOp);
        vault.addCollateral(AGENT, SHARE);
        assertEq(vault.getPosition(AGENT).amount, SHARE + SHARE / 2);
    }

    // ---- price age: the session limit, and the week's last price over the weekend (review M2) ----

    uint256 constant MONDAY = 20_717; // days since 1970-01-01: setUp's 1_790_000_000 is Monday 2026-09-21
    uint256 constant HOURS = 1 hours;

    function _priceAt(uint256 day, uint256 hour) internal {
        spyFeed.set(600e8, day * 1 days + hour * HOURS);
    }

    function _usable(uint256 day, uint256 hour) internal returns (bool ok) {
        vm.warp(day * 1 days + hour * HOURS);
        (ok,) = vault.valueOf(address(spy), SHARE);
    }

    function test_price_midWeek_staleAfterTheSessionLimit() public {
        vm.prank(owner);
        vault.setAsset(address(spy), address(spyFeed), 4 days, true, 5000, type(uint128).max);
        _priceAt(MONDAY + 1, 11); // Tuesday 11:00
        assertTrue(_usable(MONDAY + 2, 12), "25 h old, mid-week: fresh");
        assertFalse(_usable(MONDAY + 2, 14), "27 h old, mid-week: stale (a halt, or a feed that stopped)");
    }

    function test_price_weeksLastPrice_usableUntilTuesdaySixUtc() public {
        vm.prank(owner);
        vault.setAsset(address(spy), address(spyFeed), 4 days, true, 5000, type(uint128).max);
        _priceAt(MONDAY + 4, 20); // Friday 20:00
        assertTrue(_usable(MONDAY + 6, 18), "Sunday 18:00");
        assertTrue(_usable(MONDAY + 7, 23), "Monday 23:00 (a Monday holiday)");
        vm.warp((MONDAY + 8) * 1 days + 6 hours - 1);
        (bool ok,) = vault.valueOf(address(spy), SHARE);
        assertTrue(ok, "Tuesday 05:59:59");
        assertFalse(_usable(MONDAY + 8, 6), "Tuesday 06:00: stale");
        _priceAt(MONDAY + 5, 0); // Saturday 00:30 UTC is still Friday's session in New York
        spyFeed.set(600e8, (MONDAY + 5) * 1 days + 30 minutes);
        assertTrue(_usable(MONDAY + 7, 12), "a Saturday-UTC close, Monday noon");
    }

    function test_price_aThursdayPrice_isNotAWeekendPrice_andMaxAgeStillCaps() public {
        vm.prank(owner);
        vault.setAsset(address(spy), address(spyFeed), 4 days, true, 5000, type(uint128).max);
        _priceAt(MONDAY + 3, 23); // Thursday 23:00, then nothing on Friday
        assertFalse(_usable(MONDAY + 5, 12), "Saturday noon on a Thursday price: stale");
        vm.prank(owner);
        vault.setAsset(address(spy), address(spyFeed), 2 days, true, 5000, type(uint128).max);
        _priceAt(MONDAY + 4, 20); // Friday 20:00
        assertFalse(_usable(MONDAY + 7, 0), "52 h: over this asset's 2-day maxAge");
    }

    function test_setSessionMaxAge_bounded() public {
        vm.startPrank(owner);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setSessionMaxAge(59 minutes);
        vm.expectRevert(StockVault.InvalidParams.selector);
        vault.setSessionMaxAge(7 days + 1);
        vault.setSessionMaxAge(30 hours);
        vm.stopPrank();
        assertEq(vault.sessionMaxAge(), 30 hours);
    }

    function test_skim_sendsSponsorFeesToTheSink() public {
        _open(AGENT_PK, AGENT, SHARE / 2);
        uint256 loanId = _borrow(agentOp, AGENT, 100 * USDC);
        vm.warp(block.timestamp + 7 days);
        vm.prank(agentOp);
        pool.repay(loanId, AGENT, type(uint256).max);
        vault.skim();
        assertGt(usdc.balanceOf(sink), 0);
    }
}
