// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {StockVault, IPriceFeed} from "../src/StockVault.sol";

interface ITimelockF {
    function schedule(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) external;
    function execute(address target, uint256 value, bytes calldata payload, bytes32 predecessor, bytes32 salt)
        external
        payable;
    function getMinDelay() external view returns (uint256);
    function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt)
        external
        pure
        returns (bytes32);
    function isOperationDone(bytes32 id) external view returns (bool);
}

interface IProxyAdminF {
    function owner() external view returns (address);
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
}

interface IRegistryF {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

interface IStockRegistryF {
    function isBlocked(address account) external view returns (bool);
}

/// Criterion 4 of docs/builds/2026-10-12-rwa-stock-lines-growth.md, on a fork of the live chain at its latest block: the
/// live vault (0xbEcd…02B6, implementation 0x796F…8E0B) is upgraded to this source's StockVault exactly as mainnet will
/// be (the Safe schedules ProxyAdmin.upgradeAndCall on the timelock at its delay, then executes it), and then:
///   - every getter of the vault, the open PT-USDG position of agent #7633, and every live token's lending status and
///     price read the same as before the upgrade;
///   - a new stock line that defaults hands seizeTo tokens worth no more than (principal + fee) × 1.2 at the live
///     price (the feed's real latest round: the loan is made defaultable in place, the clock does not move), and the
///     rest to its depositor; with no valid price (the clock past the feed's limit), or a deposit worth less than
///     that, all is seized;
///   - a rest the token refuses to send (the issuer blocks the depositor) does not revert the hook, stays owed, and is
///     reclaimed once the token moves;
///   - onDefault's gas on live tokens (SPY, and CRCL's busy feed), every account cold, stays inside the pool's HOOK_GAS,
///     and a default on the agent's only loan has the rest back in the default's own transaction.
/// The default tests run isolated (each call its own transaction, as on mainnet): the gas a hook has depends on it.
/// Nothing is sent to mainnet.
///   FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/StockVaultFairDefaultFork.t.sol -vv
/// Without FORK_RPC every test is skipped.
contract StockVaultFairDefaultForkTest is Test {
    StockVault constant VAULT = StockVault(0xbEcd07EC689988e16b870C121756C4c2C8cb02B6);
    CreditPoolV2 constant POOL = CreditPoolV2(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    address constant SAFE = 0x20c6816B2419616238772591965E6E9AbE493fD5;
    ITimelockF constant TIMELOCK = ITimelockF(0x5d984C274035F81BB327d532897a902C5125F87c);
    IProxyAdminF constant ADMIN = IProxyAdminF(0x5174A18550a295cd25aF59416a56B7e4c38C8Afc);
    address constant LIVE_IMPL = 0x796FCcBdab6d473Ab22728D246AcAea0905b8E0B;
    bytes32 constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 constant SALT = keccak256("priors.stockvault.upgrade.fair-default");
    uint256 constant PT_AGENT = 7633;
    address constant PT_USDG = 0x6982e39521A070a3C40782548bfBED6Dc8F566ef;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant CRCL = 0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5; // the busiest feed (the jump walk's worst)

    uint256 constant OWNER_PK = 0xFA1D;
    address agentOwner = vm.addr(OWNER_PK);
    bool forked;
    address newImpl;
    bytes before;
    IERC20 usdg;
    address seizeTo;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        usdg = POOL.usdg();
        assertEq(_impl(), LIVE_IMPL, "the fork starts on the live implementation");
        before = _state();
        newImpl = address(new StockVault(POOL));
        _upgradeThroughTheSafeAndTheTimelock(newImpl);
        seizeTo = VAULT.seizeTo();
    }

    function _skipUnlessForked() internal {
        if (!forked) vm.skip(true);
    }

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(VAULT), IMPLEMENTATION_SLOT))));
    }

    /// As mainnet: the Safe (proposer and executor) schedules ProxyAdmin.upgradeAndCall(vault, impl, "") on the timelock
    /// that owns the ProxyAdmin, at the timelock's own delay (0 since 2026-10-11), then executes it once ready.
    function _upgradeThroughTheSafeAndTheTimelock(address impl) internal {
        assertEq(ADMIN.owner(), address(TIMELOCK), "the timelock owns the ProxyAdmin");
        bytes memory data = abi.encodeCall(IProxyAdminF.upgradeAndCall, (address(VAULT), impl, ""));
        uint256 delay = TIMELOCK.getMinDelay();
        vm.prank(SAFE);
        TIMELOCK.schedule(address(ADMIN), 0, data, bytes32(0), SALT, delay);
        if (delay != 0) vm.warp(block.timestamp + delay);
        vm.prank(SAFE);
        TIMELOCK.execute(address(ADMIN), 0, data, bytes32(0), SALT);
        assertTrue(TIMELOCK.isOperationDone(TIMELOCK.hashOperation(address(ADMIN), 0, data, bytes32(0), SALT)));
        assertEq(_impl(), impl, "the proxy runs the new implementation");
    }

    /// Everything the vault answers that an upgrade must not move.
    function _state() internal view returns (bytes memory) {
        (uint256 ltv, uint256 maxLine, uint256 epochCap, uint64 epochLength) = VAULT.params();
        bytes memory head = abi.encode(
            VAULT.owner(),
            VAULT.pendingOwner(),
            VAULT.agentId(),
            VAULT.seizeTo(),
            VAULT.feeSink(),
            VAULT.paused(),
            abi.encode(ltv, maxLine, epochCap, epochLength),
            VAULT.epochStart(),
            VAULT.linedThisEpoch(),
            VAULT.openLines(),
            VAULT.epochRoom(),
            address(VAULT.pool()),
            address(VAULT.usdg()),
            address(VAULT.registry())
        );
        bytes memory guard = abi.encode(
            VAULT.sessionMaxAge(),
            VAULT.idleAfter(),
            VAULT.idleUndrawnAfter(),
            VAULT.maxJumpBps(),
            VAULT.jumpWindow(),
            VAULT.multiplierCooldown(),
            VAULT.trustedRoots(),
            VAULT.bonusFeeStep(),
            VAULT.bonusBpsPerStep(),
            VAULT.maxBonusBps()
        );
        address[] memory list = VAULT.assetList();
        bytes memory assets = abi.encode(list);
        for (uint256 i; i < list.length; ++i) {
            (address feed, uint64 maxAge, uint8 td, uint8 fd, bool enabled, uint16 tltv, uint128 cap) =
                VAULT.assets(list[i]);
            (bool ok, uint256 value) = VAULT.valueOf(list[i], 1e18);
            assets = bytes.concat(
                assets,
                abi.encode(feed, maxAge, td, fd, enabled, tltv, cap),
                abi.encode(VAULT.held(list[i]), VAULT.openLinesOf(list[i]), VAULT.lendStatus(list[i]), ok, value),
                abi.encode(IERC20(list[i]).balanceOf(address(VAULT)))
            );
        }
        uint256 root = VAULT.agentId();
        bytes memory position = abi.encode(
            VAULT.getPosition(PT_AGENT),
            VAULT.borrowRoom(PT_AGENT),
            VAULT.ltvOf(PT_AGENT, PT_USDG),
            VAULT.recordBonusBps(PT_AGENT),
            POOL.getAgent(PT_AGENT),
            POOL.freeBacking(root),
            POOL.hook(root),
            ADMIN.owner(),
            vm.load(address(VAULT), 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103) // the admin slot
        );
        return bytes.concat(head, guard, assets, position);
    }

    // ---- the upgrade keeps everything ----

    function test_fork_upgrade_keepsEveryGetter_thePtPosition_andEveryTokensStatus() public {
        _skipUnlessForked();
        assertEq(_state(), before, "nothing the vault answers moved");
        StockVault.Position memory p = VAULT.getPosition(PT_AGENT);
        emit log_named_address("PT position depositor", p.depositor);
        emit log_named_address("PT position owner", p.owner);
        emit log_named_uint("PT position amount", p.amount);
        emit log_named_uint("PT position line", p.line);
        emit log_named_uint("PT position status", uint256(p.status));
        assertEq(p.token, PT_USDG);
        assertEq(uint256(p.status), uint256(StockVault.Status.Open));
        assertEq(VAULT.seizeBufferBps(), 2000, "20% with nothing stored: no reinitializer");
        assertEq(VAULT.seizeBufferOf(SPY), 2000);
        emit log_named_address("new implementation (fork)", newImpl);
    }

    /// The live PT position still runs on the new code: its loan is repaid, the depositor closes, every token goes back.
    function test_fork_thePtPosition_repaysAndClosesOnTheNewCode() public {
        _skipUnlessForked();
        StockVault.Position memory p = VAULT.getPosition(PT_AGENT);
        uint256[] memory loans = POOL.loansOf(PT_AGENT);
        uint256 loanId = loans[loans.length - 1];
        CreditPoolV2.Loan memory l = POOL.getLoan(loanId);
        assertEq(uint256(l.status), uint256(CreditPoolV2.LoanStatus.Active));
        deal(address(usdg), p.owner, l.principal + l.fee);
        vm.startPrank(p.owner);
        usdg.approve(address(POOL), l.principal + l.fee);
        POOL.repay(loanId, PT_AGENT, type(uint256).max);
        vm.stopPrank();
        uint256 had = IERC20(PT_USDG).balanceOf(p.depositor);
        vm.prank(p.depositor);
        VAULT.close(PT_AGENT);
        assertEq(IERC20(PT_USDG).balanceOf(p.depositor) - had, p.amount, "every PT back");
        assertEq(uint256(VAULT.getPosition(PT_AGENT).status), uint256(StockVault.Status.Closed));
    }

    // ---- a new stock line on the upgraded vault ----

    uint256 agent;

    function _consent(uint256 id) internal view returns (CreditPoolV2.Consent memory c, bytes memory sig) {
        c = CreditPoolV2.Consent({
            agentId: id,
            sponsorId: VAULT.agentId(),
            owner: agentOwner,
            maxPremiumBps: 0,
            nonce: POOL.nonces(id),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, POOL.consentDigest(c));
        sig = abi.encodePacked(r, s, v);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function _feed(address token) internal view returns (address feed) {
        (feed,,,,,,) = VAULT.assets(token);
    }

    /// A fresh owner deposits about `usd` of `token` (dealt on the fork), with its signed consent, and borrows `borrow`
    /// for one day (the pool's shortest term). Returns the deposit and the loan.
    function _openAndBorrow(address token, uint256 usd, uint256 borrow)
        internal
        returns (uint256 amount, uint256 loanId)
    {
        IRegistryF reg = IRegistryF(address(POOL.registry()));
        vm.prank(agentOwner); // the registry's address is read first: a prank covers the next call only
        agent = reg.register("https://priors.trade/agents/fair-default-fork.json");
        (, int256 answer,,,) = IPriceFeed(_feed(token)).latestRoundData();
        amount = usd * 1e20 / uint256(answer); // 18-decimal token, 8-decimal feed
        deal(token, agentOwner, amount);
        vm.prank(agentOwner);
        IERC20(token).approve(address(VAULT), amount);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(agent);
        vm.prank(agentOwner);
        uint256 line = VAULT.open(agent, token, amount, c, sig);
        if (borrow == 0) borrow = line;
        vm.prank(agentOwner);
        loanId = POOL.borrow(agent, borrow, 1 days, agentOwner, type(uint256).max);
    }

    // CreditPoolV2's `_loans` array (storage slot 38): a Loan is 10 slots; dueAt, defaultableAt, minScoreTerm and
    // closedAt share its slot 8 (defaultableAt in bits 64-127), read from `forge inspect CreditPoolV2 storageLayout`
    bytes32 constant LOANS_DATA = 0x744a2cf8fd7008e3d53b67916e73460df9fa5214e3ef23dd4259ca09493a3594;

    /// The loan is past its grace now, without moving the clock: its `defaultableAt` is set to the block before. The
    /// default then runs at the fork's own time, on the feed's real latest round and its real history (a warp past
    /// due + grace would age every live feed past its limit). Its fee, term and everything else stay as borrowed.
    function _makeDefaultable(uint256 loanId) internal returns (uint256 price, address feed) {
        vm.warp(block.timestamp + 1);
        bytes32 slot = bytes32(uint256(LOANS_DATA) + loanId * 10 + 8);
        uint256 v = uint256(vm.load(address(POOL), slot));
        v = (v & ~(uint256(type(uint64).max) << 64)) | ((block.timestamp - 1) << 64);
        vm.store(address(POOL), slot, bytes32(v));
        assertEq(POOL.getLoan(loanId).defaultableAt, block.timestamp - 1, "defaultable now");
        feed = _feed(VAULT.getPosition(POOL.getLoan(loanId).agentId).token);
        (, int256 answer,,,) = IPriceFeed(feed).latestRoundData();
        price = uint256(answer);
    }

    /// ceil(owed × 1.2 / price) for an 18-decimal token and an 8-decimal feed, computed here from the rule
    function _expectedSeized(uint256 owed, uint256 price) internal pure returns (uint256) {
        uint256 num = owed * 12_000 * 1e20;
        uint256 den = 10_000 * price;
        return (num + den - 1) / den;
    }

    /// The oracle: agent `id`'s debt read straight from the live pool's loan records, independently of the vault:
    /// principal + fee of every loan the vault backed since the position opened that defaulted, walked first to last.
    function _poolDebt(uint256 id) internal view returns (uint256 sum) {
        uint256[] memory ids = POOL.loansOf(id);
        uint64 opened = VAULT.getPosition(id).openedAt;
        uint256 root = VAULT.agentId();
        for (uint256 i; i < ids.length; ++i) {
            CreditPoolV2.Loan memory l = POOL.getLoan(ids[i]);
            if (l.sponsorId == root && l.issuedAt >= opened && l.status == CreditPoolV2.LoanStatus.Defaulted) {
                sum += l.principal + l.fee;
            }
        }
    }

    /// A second loan on the agent's line, for `term`
    function _borrowMore(uint256 amount, uint64 term) internal returns (uint256 loanId) {
        vm.prank(agentOwner);
        loanId = POOL.borrow(agent, amount, term, agentOwner, type(uint256).max);
    }

    function _repay(uint256 loanId) internal {
        CreditPoolV2.Loan memory l = POOL.getLoan(loanId);
        deal(address(usdg), agentOwner, usdg.balanceOf(agentOwner) + l.principal + l.fee);
        vm.startPrank(agentOwner);
        usdg.approve(address(POOL), l.principal + l.fee);
        POOL.repay(loanId, agent, type(uint256).max);
        vm.stopPrank();
    }

    /// forge-config: default.isolate = true
    function test_fork_aDefaultedStockLine_seizesOwedPlusTheBuffer_andReturnsTheRest() public {
        _skipUnlessForked();
        (uint256 amount, uint256 loanId) = _openAndBorrow(SPY, 40e6, 10e6); // ~$40 of SPY, 10 USDG for a day
        CreditPoolV2.Loan memory l = POOL.getLoan(loanId);
        (uint256 price,) = _makeDefaultable(loanId);
        (bool fresh,) = VAULT.valueOf(SPY, amount);
        assertTrue(fresh && VAULT.lendStatus(SPY) == 0, "SPY's live price is one the vault lends against now");
        uint256 owed = l.principal + l.fee;
        uint256 expected = _expectedSeized(owed, price);
        uint256 toBefore = IERC20(SPY).balanceOf(seizeTo);
        vm.recordLogs();
        POOL.markDefault(loanId);
        _noHookFailed();
        uint256 seized = IERC20(SPY).balanceOf(seizeTo) - toBefore;
        uint256 back = IERC20(SPY).balanceOf(agentOwner);
        emit log_named_decimal_uint("SPY price used: the live latest round (USD)", price, 8);
        emit log_named_decimal_uint("deposit (SPY)", amount, 18);
        emit log_named_decimal_uint("owed: principal + fee (USDG)", owed, 6);
        emit log_named_decimal_uint("seized to seizeTo (SPY)", seized, 18);
        emit log_named_decimal_uint("its value at the price used (USDG)", seized * price / 1e20, 6);
        emit log_named_decimal_uint("(principal + fee) x 1.2 (USDG)", owed * 12_000 / 10_000, 6);
        emit log_named_decimal_uint("back to the depositor (SPY)", back, 18);
        assertEq(seized, expected, "ceil(owed x 1.2 / price)");
        assertEq(owed, _poolDebt(agent), "the pool's own records");
        assertLe(seized * price / 1e20, owed * 12_000 / 10_000, "worth no more than (principal + fee) x 1.2");
        assertEq(back, amount - seized, "the rest back to the depositor, in the same transaction");
        assertEq(uint256(VAULT.getPosition(agent).status), uint256(StockVault.Status.Seized));
        assertEq(VAULT.held(SPY), 0);
    }

    /// Two loans on live SPY: 10 USDG for a day, then 10 for a week. The first defaults: nothing is seized (the other
    /// runs; the deposit stays). The second defaults too: both, exactly as the pool stored them, plus 20%, at SPY's
    /// live price; the rest back.
    /// forge-config: default.isolate = true
    function test_fork_twoLoans_theFirstDefaults_thenTheSecond_seizesBothExactly() public {
        _skipUnlessForked();
        (uint256 amount, uint256 first) = _openAndBorrow(SPY, 60e6, 10e6);
        uint256 second = _borrowMore(10e6, 7 days);
        _makeDefaultable(first);
        uint256 toBefore = IERC20(SPY).balanceOf(seizeTo);
        POOL.markDefault(first);
        assertEq(IERC20(SPY).balanceOf(seizeTo), toBefore, "nothing seized while the second loan runs");
        assertEq(IERC20(SPY).balanceOf(address(VAULT)), amount, "the whole deposit stays");
        (uint256 price,) = _makeDefaultable(second);
        vm.recordLogs();
        POOL.markDefault(second);
        _noHookFailed();
        CreditPoolV2.Loan memory l1 = POOL.getLoan(first);
        CreditPoolV2.Loan memory l2 = POOL.getLoan(second);
        uint256 owed = l1.principal + l1.fee + l2.principal + l2.fee;
        assertEq(owed, _poolDebt(agent), "the pool's own records");
        uint256 seized = IERC20(SPY).balanceOf(seizeTo) - toBefore;
        emit log_named_decimal_uint("two loans defaulted, owed (USDG)", owed, 6);
        emit log_named_decimal_uint("  seized (SPY)", seized, 18);
        assertEq(seized, _expectedSeized(owed, price), "both loans x 1.2 at the price");
        assertEq(IERC20(SPY).balanceOf(agentOwner), amount - seized, "the rest back");
        assertEq(uint256(VAULT.getPosition(agent).status), uint256(StockVault.Status.Seized));
    }

    /// The same two loans; the first defaults, the second is repaid: that repayment ends the sponsorship (the pool's
    /// onRelease), and the position is seized for the first loan alone, exactly.
    /// forge-config: default.isolate = true
    function test_fork_twoLoans_theFirstDefaults_theSecondIsRepaid_seizesTheFirstExactly() public {
        _skipUnlessForked();
        (uint256 amount, uint256 first) = _openAndBorrow(SPY, 60e6, 10e6);
        uint256 second = _borrowMore(10e6, 7 days);
        (uint256 price,) = _makeDefaultable(first);
        uint256 toBefore = IERC20(SPY).balanceOf(seizeTo);
        POOL.markDefault(first);
        assertEq(IERC20(SPY).balanceOf(seizeTo), toBefore, "nothing seized while the second loan runs");
        vm.recordLogs();
        _repay(second);
        _noHookFailed();
        CreditPoolV2.Loan memory l1 = POOL.getLoan(first);
        uint256 owed = l1.principal + l1.fee;
        assertEq(owed, _poolDebt(agent), "the pool's own records: the repaid loan owes nothing");
        uint256 seized = IERC20(SPY).balanceOf(seizeTo) - toBefore;
        emit log_named_decimal_uint("first defaulted, second repaid, owed (USDG)", owed, 6);
        emit log_named_decimal_uint("  seized (SPY)", seized, 18);
        assertEq(seized, _expectedSeized(owed, price), "the first loan x 1.2 at the price");
        assertEq(IERC20(SPY).balanceOf(agentOwner), amount - seized, "the rest back");
        assertEq(uint256(VAULT.getPosition(agent).status), uint256(StockVault.Status.Seized));
    }

    /// Both hooks fail on live SPY: settle sums the pool's own loans, from the position's opening to the agent's last
    /// borrow (each bound found by binary search over the live pool's loans), and seizes exactly; its gas is logged.
    /// forge-config: default.isolate = true
    function test_fork_bothHooksFail_settleSeizesTheExactDebt() public {
        _skipUnlessForked();
        (uint256 amount, uint256 loanId) = _openAndBorrow(SPY, 40e6, 10e6);
        (uint256 price,) = _makeDefaultable(loanId);
        vm.mockCallRevert(address(VAULT), abi.encodeWithSelector(StockVault.onDefault.selector), "");
        vm.mockCallRevert(address(VAULT), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        POOL.markDefault(loanId);
        vm.clearMockedCalls();
        assertEq(uint256(VAULT.getPosition(agent).status), uint256(StockVault.Status.Open));
        uint256 toBefore = IERC20(SPY).balanceOf(seizeTo);
        uint256 g = gasleft();
        VAULT.settle(agent, loanId);
        emit log_named_uint("settle on the live pool (its two searches over every loan, one page)", g - gasleft());
        emit log_named_uint("  the pool's loans now", POOL.loanCount());
        uint256 seized = IERC20(SPY).balanceOf(seizeTo) - toBefore;
        assertEq(_poolDebt(agent), POOL.getLoan(loanId).principal + POOL.getLoan(loanId).fee);
        assertEq(seized, _expectedSeized(_poolDebt(agent), price), "the exact debt x 1.2 at the price");
        assertEq(IERC20(SPY).balanceOf(agentOwner), amount - seized);
    }

    /// forge-config: default.isolate = true
    function test_fork_noValidPrice_seizesAll() public {
        _skipUnlessForked();
        (uint256 amount, uint256 loanId) = _openAndBorrow(SPY, 40e6, 10e6);
        (,,, uint256 updatedAt,) = IPriceFeed(_feed(SPY)).latestRoundData();
        (, uint64 maxAge,,,,,) = VAULT.assets(SPY);
        uint256 at = POOL.getLoan(loanId).defaultableAt + 1;
        if (at <= updatedAt + maxAge) at = updatedAt + maxAge + 1;
        vm.warp(at); // the feed's last round is older than the asset's maxAge: no valid price
        (bool ok,) = VAULT.valueOf(SPY, amount);
        assertFalse(ok, "stale");
        uint256 toBefore = IERC20(SPY).balanceOf(seizeTo);
        POOL.markDefault(loanId);
        assertEq(IERC20(SPY).balanceOf(seizeTo) - toBefore, amount, "all of it seized");
        assertEq(IERC20(SPY).balanceOf(agentOwner), 0);
    }

    /// The Safe sets SPY's own buffer to 100%; the whole line drawn: owed × 2 is more than the deposit is worth.
    /// forge-config: default.isolate = true
    function test_fork_aDepositWorthLessThanOwedPlusBuffer_seizesAll() public {
        _skipUnlessForked();
        vm.prank(VAULT.owner());
        VAULT.setSeizeBuffer(SPY, 10_000);
        (uint256 amount, uint256 loanId) = _openAndBorrow(SPY, 40e6, 0); // the whole line
        _makeDefaultable(loanId);
        assertEq(VAULT.lendStatus(SPY), 0);
        uint256 toBefore = IERC20(SPY).balanceOf(seizeTo);
        POOL.markDefault(loanId);
        assertEq(IERC20(SPY).balanceOf(seizeTo) - toBefore, amount, "all of it seized");
        assertEq(IERC20(SPY).balanceOf(agentOwner), 0);
    }

    /// The issuer blocks the depositor (the token's registry says so: the token's own transfer refuses it). The hook
    /// does not revert: seizeTo gets its part, the rest stays owed (written off, in held), and anyone's reclaim sends
    /// it once the block is lifted.
    /// forge-config: default.isolate = true
    function test_fork_aRestTheTokenRefuses_staysOwed_andIsReclaimedOnceItMoves() public {
        _skipUnlessForked();
        (uint256 amount, uint256 loanId) = _openAndBorrow(SPY, 40e6, 10e6);
        CreditPoolV2.Loan memory l = POOL.getLoan(loanId);
        (uint256 price,) = _makeDefaultable(loanId);
        address reg = _registry(SPY);
        vm.mockCall(reg, abi.encodeCall(IStockRegistryF.isBlocked, (agentOwner)), abi.encode(true));
        vm.prank(address(VAULT));
        vm.expectRevert(); // the real token refuses a transfer to a blocked account
        IERC20(SPY).transfer(agentOwner, 1);
        uint256 seized = _expectedSeized(l.principal + l.fee, price);
        uint256 toBefore = IERC20(SPY).balanceOf(seizeTo);
        vm.recordLogs();
        POOL.markDefault(loanId);
        _noHookFailed();
        assertEq(IERC20(SPY).balanceOf(seizeTo) - toBefore, seized, "seizeTo's part moved");
        assertEq(IERC20(SPY).balanceOf(agentOwner), 0, "nothing reached the blocked depositor");
        StockVault.Position memory p = VAULT.getPosition(agent);
        assertEq(uint256(p.status), uint256(StockVault.Status.WrittenOff), "owed back");
        assertEq(p.amount, amount - seized);
        assertEq(VAULT.held(SPY), amount - seized, "still counted as owed, out of rescue's reach");
        vm.expectRevert(abi.encodeWithSelector(StockVault.NotSent.selector, agent));
        VAULT.reclaim(agent);
        vm.clearMockedCalls(); // the block is lifted
        VAULT.reclaim(agent);
        assertEq(IERC20(SPY).balanceOf(agentOwner), amount - seized, "reclaimed by anyone");
        assertEq(uint256(VAULT.getPosition(agent).status), uint256(StockVault.Status.Seized), "seized, rest sent");
        assertEq(VAULT.held(SPY), 0);
    }

    function _registry(address token) internal view returns (address) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSignature("ACCESS_CONTROLLED_REGISTRY()"));
        assertTrue(ok && r.length >= 32, "a Robinhood stock token has a registry");
        return abi.decode(r, (address));
    }

    function _noHookFailed() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CreditPoolV2.HookFailed.selector, "the hook did not fail");
        }
    }

    // ---- the hook's gas on live tokens and feeds ----

    uint256 internal loan_;

    function _markLoan() internal {
        POOL.markDefault(loan_);
    }

    function _repayLoan() internal {
        _repay(loan_);
    }

    function _stubHooks() internal {
        vm.mockCall(address(VAULT), abi.encodeWithSelector(StockVault.onDefault.selector), "");
        vm.mockCall(address(VAULT), abi.encodeWithSelector(StockVault.onRelease.selector), "");
    }

    /// What each of the vault's hooks costs inside the pool's call `action` on `token` (each call its own transaction,
    /// every account cold, as on mainnet), each run from the same snapshot: both hooks stubbed (the pool's own cost);
    /// onRelease stubbed (so onDefault's); the depositor blocked (onRelease without the rest's transfer, which fails at
    /// once: what it must do, the debt check, the price, the holds, the seizure, recording the rest as owed); then the
    /// real call, whose state it keeps. Returns onDefault's gas, onRelease's, and onRelease's without the transfer.
    function _hookCost(function() internal action, address token)
        internal
        returns (uint256 dflt, uint256 release, uint256 releaseMandatory)
    {
        uint256 snap = vm.snapshotState();
        _stubHooks();
        uint256 g = gasleft();
        action();
        uint256 none = g - gasleft();
        vm.clearMockedCalls(); // mocks outlive revertToState
        vm.revertToState(snap);
        vm.mockCall(address(VAULT), abi.encodeWithSelector(StockVault.onRelease.selector), "");
        g = gasleft();
        action();
        uint256 withDefault = g - gasleft();
        vm.clearMockedCalls();
        vm.revertToState(snap);
        vm.mockCall(_registry(token), abi.encodeCall(IStockRegistryF.isBlocked, (agentOwner)), abi.encode(true));
        g = gasleft();
        action();
        releaseMandatory = (g - gasleft()) - withDefault;
        vm.clearMockedCalls();
        vm.revertToState(snap);
        vm.recordLogs();
        g = gasleft();
        action();
        dflt = withDefault - none;
        release = (g - gasleft()) - withDefault;
        _noHookFailed();
    }

    struct Gas {
        uint256 summing; // onDefault, a loan with another still open: sums the debt
        uint256 onlyDefault; // the only loan defaults: onDefault sums it ...
        uint256 onlyRelease; // ... and onRelease, in the same call, seizes
        uint256 onlyMandatory; // that onRelease without the rest's transfer
        uint256 lastRelease; // the second and last loan defaults: onRelease seizes both
        uint256 lastMandatory;
        uint256 repaidRelease; // the second loan repaid: onRelease seizes the first
        uint256 repaidMandatory;
    }

    /// Every hook path of a default on `token`, each from the same live state, with whether the rest was back at the end
    /// of the call that seized
    function _paths(address token) internal returns (Gas memory x, bool[3] memory sent) {
        uint256 base = vm.snapshotState();
        (, uint256 first) = _openAndBorrow(token, 60e6, 5e6);
        _makeDefaultable(first);
        loan_ = first;
        (x.onlyDefault, x.onlyRelease, x.onlyMandatory) = _hookCost(_markLoan, token);
        sent[0] = IERC20(token).balanceOf(agentOwner) != 0;
        assertEq(uint256(VAULT.getPosition(agent).status), uint256(StockVault.Status.Seized));

        vm.revertToState(base);
        (, first) = _openAndBorrow(token, 60e6, 5e6);
        uint256 second = _borrowMore(5e6, 7 days);
        _makeDefaultable(first);
        loan_ = first;
        (x.summing,,) = _hookCost(_markLoan, token);
        assertEq(uint256(VAULT.getPosition(agent).status), uint256(StockVault.Status.Open), "summed, not seized");
        uint256 two = vm.snapshotState();
        _makeDefaultable(second);
        loan_ = second;
        (, x.lastRelease, x.lastMandatory) = _hookCost(_markLoan, token);
        sent[1] = IERC20(token).balanceOf(agentOwner) != 0;
        assertGe(
            uint256(VAULT.getPosition(agent).status), uint256(StockVault.Status.Seized), "seized, rest sent or owed"
        );
        vm.revertToState(two);
        loan_ = second;
        (, x.repaidRelease, x.repaidMandatory) = _hookCost(_repayLoan, token);
        sent[2] = IERC20(token).balanceOf(agentOwner) != 0;
        assertGe(
            uint256(VAULT.getPosition(agent).status), uint256(StockVault.Status.Seized), "seized, rest sent or owed"
        );
        vm.revertToState(base);
    }

    function _report(string memory name, Gas memory x, bool[3] memory sent) internal {
        emit log_named_uint(string.concat(name, ": onDefault, a loan with another still open (sums)"), x.summing);
        emit log_named_uint(string.concat(name, ": onDefault, the only loan (sums)"), x.onlyDefault);
        emit log_named_uint(string.concat(name, ": onRelease after it, same call (seizes)"), x.onlyRelease);
        emit log_named_uint(string.concat(name, ":   without the rest's transfer"), x.onlyMandatory);
        emit log_named_string(string.concat(name, ":   the rest at the end of markDefault"), sent[0] ? "sent" : "owed");
        emit log_named_uint(
            string.concat(name, ": onRelease, the second and last loan defaulted (seizes)"), x.lastRelease
        );
        emit log_named_uint(string.concat(name, ":   without the rest's transfer"), x.lastMandatory);
        emit log_named_string(string.concat(name, ":   the rest at the end of markDefault"), sent[1] ? "sent" : "owed");
        emit log_named_uint(string.concat(name, ": onRelease, the second loan repaid (seizes)"), x.repaidRelease);
        emit log_named_uint(string.concat(name, ":   without the rest's transfer"), x.repaidMandatory);
        emit log_named_string(string.concat(name, ":   the rest at the end of repay"), sent[2] ? "sent" : "owed");
    }

    function _assertBudget(Gas memory x, uint256 budget) internal pure {
        assertLt(x.summing, budget / 4, "summing a default is cheap");
        assertLt(x.onlyDefault, budget / 4, "summing the only loan is cheap");
        uint256[3] memory used = [x.onlyRelease, x.lastRelease, x.repaidRelease];
        uint256[3] memory must = [x.onlyMandatory, x.lastMandatory, x.repaidMandatory];
        for (uint256 i; i < 3; ++i) {
            assertLt(used[i], budget, "every seizing onRelease ends inside the pool's HOOK_GAS");
            assertLt(must[i], budget * 9 / 10, "what it must do leaves a tenth of the budget");
        }
    }

    /// Every hook path of a default on two live tokens (SPY, and CRCL, the busiest feed: the jump walk's worst), every
    /// account cold, each hook against its own HOOK_GAS (300,000): onDefault only sums (cheap); the seizing onRelease
    /// (after the only loan's default, the last loan's, or the last loan's repayment) ends inside the budget, and what
    /// it must do without the rest's transfer leaves a tenth of it. A rest the transfer has no gas left for stays owed
    /// (reclaim).
    /// forge-config: default.isolate = true
    function test_fork_hooksGas_onLiveTokens_staysInsideTheHookBudget() public {
        _skipUnlessForked();
        uint256 budget = POOL.HOOK_GAS();
        uint256 t0 = vm.getBlockTimestamp();
        (Gas memory spy, bool[3] memory s) = _paths(SPY);
        vm.warp(t0); // the fork's own time: the next line opens at the live price
        (Gas memory crcl, bool[3] memory c) = _paths(CRCL);
        _report("SPY", spy, s);
        _report("CRCL", crcl, c);
        emit log_named_uint("the pool's HOOK_GAS", budget);
        _assertBudget(spy, budget);
        _assertBudget(crcl, budget);
    }
}
