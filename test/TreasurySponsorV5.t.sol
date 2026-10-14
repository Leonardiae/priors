// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CreditPool} from "../src/CreditPool.sol";
import {CreditPoolV2, IBackerHook} from "../src/CreditPoolV2.sol";
import {CreditLensV2} from "../src/CreditLensV2.sol";
import {TreasurySponsorV5, IPreviousTreasury, ILegacyBond} from "../src/TreasurySponsorV5.sol";
import {ITreasuryRules} from "../src/InviteBond.sol";
import {InviteBondV2} from "../src/InviteBondV2.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";
import {MockPonsFeeEscrow} from "../src/mocks/MockPonsFeeEscrow.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {IPonsFeeEscrow, IPonsFactoryCreator} from "../src/interfaces/IPonsFeeEscrow.sol";

/// Stands in for TreasurySponsorV4 as v5's `previous`: which agents it lined and flagged seeded, and its root.
contract MockPreviousTreasury is IPreviousTreasury {
    mapping(uint256 => bool) public firstLined;
    mapping(uint256 => bool) public seeded;
    uint256 public agentId;

    function setLined(uint256 id, bool lined) external {
        firstLined[id] = lined;
    }

    function setSeeded(uint256 id, bool s) external {
        seeded[id] = s;
    }

    function setRoot(uint256 id) external {
        agentId = id;
    }
}

/// Stands in for InviteBond (v1) as v5's `legacyBond`: whether an agent still has a bond there.
contract MockLegacyBond is ILegacyBond {
    mapping(uint256 => bool) public isBonded;

    function setBonded(uint256 id, bool b) external {
        isBonded[id] = b;
    }
}

/// TreasuryV4Base (test/TreasurySponsorV4.t.sol) for TreasurySponsorV5: the same fixture, numbers and helpers, plus the
/// InviteBondV2 v5 reads (5 USDG, unusedAfter 4 days, beneficiary `safe`, as InviteBond on mainnet). Every treasury gets
/// its own bond, deployed first and pointed at the address the treasury is about to get, so it reads that treasury's
/// `rules()` (`minQualified`), which the treasury's constructor checks. `agentOp` and `agentOp2` have approved the
/// bond, which changes nothing for a test that never deposits.
contract TreasuryV5Base is Test {
    uint256 constant USDC = 1e6;
    uint64 constant FAR = type(uint64).max;
    uint256 constant BOND = 5e6;
    uint64 constant UNUSED = 4 days;

    MockUSDC usdc;
    MockIdentityRegistry reg;
    MockPonsFeeEscrow escrow;
    CreditPoolV2 pool;
    CreditLensV2 lens;
    TreasurySponsorV5 treasury;
    InviteBondV2 bond;
    MockPreviousTreasury prev; // v5's `previous` (v4) in every fixture treasury
    MockLegacyBond legacy; // v5's `legacyBond` (InviteBond v1) in every fixture treasury

    address timelock = makeAddr("timelock");
    address owner = makeAddr("owner");
    address sink = makeAddr("buyback");
    address lender = makeAddr("lender");
    address anyone = makeAddr("anyone");
    address relayer = makeAddr("relayer");
    address launchToken = makeAddr("launchToken");
    address safe = makeAddr("safe");

    uint256 constant INVITER_PK = 0xA11CE;
    uint256 constant AGENT_PK = 0xA1;
    uint256 constant AGENT2_PK = 0xA2;
    uint256 constant ROOT_PK = 0xB0B;
    address inviter = vm.addr(INVITER_PK);
    address agentOp = vm.addr(AGENT_PK);
    address agentOp2 = vm.addr(AGENT2_PK);
    address rootOp = vm.addr(ROOT_PK);

    uint256 TREASURY_ID;
    uint256 AGENT;
    uint256 AGENT2;
    bytes32 DS;
    bytes32 TH;

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

    function _deployPool(CreditPool v1) internal {
        pool = new CreditPoolV2(
            IERC20(address(usdc)), IERC8004Identity(address(reg)), v1, timelock, timelock, _poolParams()
        );
        lens = new CreditLensV2(pool);
        usdc.mint(address(this), 1 * USDC);
        usdc.approve(address(pool), 1 * USDC);
        pool.seed();
    }

    /// A treasury and the InviteBondV2 that reads its rules: the bond first, naming the treasury's address-to-be.
    function _deployTreasury(IPonsFeeEscrow e, IPonsFactoryCreator f) internal returns (TreasurySponsorV5 t) {
        if (address(prev) == address(0)) prev = new MockPreviousTreasury();
        if (address(legacy) == address(0)) legacy = new MockLegacyBond();
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        InviteBondV2 b =
            new InviteBondV2(pool, IERC8004Identity(address(reg)), ITreasuryRules(next), safe, BOND, UNUSED);
        t = new TreasurySponsorV5(pool, e, f, owner, sink, b, prev, legacy);
        assertEq(address(t), next, "the bond reads this treasury's rules");
    }

    function _newTreasury() internal returns (TreasurySponsorV5) {
        return _deployTreasury(IPonsFeeEscrow(address(escrow)), IPonsFactoryCreator(address(escrow)));
    }

    function setUp() public virtual {
        usdc = new MockUSDC();
        reg = new MockIdentityRegistry();
        escrow = new MockPonsFeeEscrow();
        _deployPool(CreditPool(address(0)));
        _setUpTreasury();
    }

    function _setUpTreasury() internal {
        treasury = _newTreasury();
        bond = treasury.bond();
        escrow.setFeeRecipient(launchToken, address(treasury));

        address[5] memory who = [lender, agentOp, agentOp2, rootOp, anyone];
        for (uint256 i = 0; i < who.length; i++) {
            usdc.mint(who[i], 10_000 * USDC);
            vm.startPrank(who[i]);
            usdc.approve(address(pool), type(uint256).max);
            usdc.approve(address(bond), type(uint256).max);
            vm.stopPrank();
        }
        vm.prank(lender);
        pool.deposit(10_000 * USDC, lender, 0);

        vm.startPrank(owner);
        TREASURY_ID = reg.register("priors-treasury-v5");
        reg.safeTransferFrom(owner, address(treasury), TREASURY_ID);
        treasury.adopt(TREASURY_ID);
        treasury.setInviter(inviter, true);
        vm.stopPrank();
        DS = treasury.DOMAIN_SEPARATOR();
        TH = treasury.INVITE_TYPEHASH();

        vm.prank(agentOp);
        AGENT = reg.register("ipfs://agent");
        vm.prank(agentOp2);
        AGENT2 = reg.register("ipfs://agent2");
    }

    // ------------------------------------------------------------------
    // Signatures
    // ------------------------------------------------------------------

    function _invite(uint256 id, uint64 expiry) internal view returns (bytes memory) {
        return _inviteBy(INVITER_PK, id, expiry);
    }

    function _inviteBy(uint256 pk, uint256 id, uint64 expiry) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DS, keccak256(abi.encode(TH, id, expiry))));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, digest);
        return abi.encodePacked(r, s_, v);
    }

    function _consentFor(uint256 id, uint256 sponsorId, uint256 pk)
        internal
        view
        returns (CreditPoolV2.Consent memory c, bytes memory sig)
    {
        c = CreditPoolV2.Consent({
            agentId: id,
            sponsorId: sponsorId,
            owner: vm.addr(pk),
            maxPremiumBps: 0,
            nonce: pool.nonces(id),
            deadline: vm.getBlockTimestamp() + 1 days
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, pool.consentDigest(c));
        sig = abi.encodePacked(r, s, v);
    }

    function _consent(uint256 id, uint256 pk) internal view returns (CreditPoolV2.Consent memory, bytes memory) {
        return _consentFor(id, TREASURY_ID, pk);
    }

    /// The whole flow: the inviter signed, the agent's owner signed, a relayer submits.
    function _firstLine(uint256 id, uint256 pk) internal {
        _firstLineWith(id, pk, FAR);
    }

    function _firstLineWith(uint256 id, uint256 pk, uint64 expiry) internal {
        bytes memory inv = _invite(id, expiry);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(id, pk);
        vm.prank(relayer);
        treasury.firstLine(id, expiry, inv, c, sig);
    }

    // ------------------------------------------------------------------
    // Money and loans
    // ------------------------------------------------------------------

    function _creatorFees(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(escrow), amount);
        escrow.creditToken(address(treasury), address(usdc), amount);
    }

    function _funded() internal {
        _creatorFees(400 * USDC);
        treasury.sweep();
    }

    function _borrow(address who, uint256 id, uint256 amount, uint64 term) internal returns (uint256) {
        vm.prank(who);
        return pool.borrow(id, amount, term, who, type(uint256).max);
    }

    function _repay(address who, uint256 loanId) internal {
        uint256 id = pool.getLoan(loanId).agentId;
        vm.prank(who);
        pool.repay(loanId, id, type(uint256).max);
    }

    function _default(uint256 loanId) internal {
        vm.warp(pool.getLoan(loanId).defaultableAt + 1);
        pool.markDefault(loanId);
    }

    function _line(uint256 id) internal view returns (uint256) {
        return pool.getAgent(id).delegatedIn;
    }

    function _idle() internal view returns (uint64 idleAfter) {
        (,,,,,,,, idleAfter) = treasury.rules();
    }

    function _qualify(address op, uint256 id) internal {
        for (uint256 i = 0; i < 3; i++) {
            uint256 loan = _borrow(op, id, 5 * USDC, 7 days);
            vm.warp(vm.getBlockTimestamp() + 7 days);
            _repay(op, loan);
        }
    }

    function _rules() internal view returns (TreasurySponsorV5.Rules memory r) {
        (
            r.reserveBps,
            r.firstLine,
            r.secondLine,
            r.epochCap,
            r.epochLength,
            r.minSeasoning,
            r.minQualified,
            r.minScore,
            r.idleAfter
        ) = treasury.rules();
    }

    // ------------------------------------------------------------------
    // Bonds
    // ------------------------------------------------------------------

    function _deposit(address who, uint256 id) internal {
        vm.prank(who);
        bond.deposit(id);
    }

    function _sell(uint256 id, address from, address to) internal {
        vm.prank(from);
        reg.transferFrom(from, to, id);
    }

    function _blocked() internal view returns (bytes memory) {
        return abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, TREASURY_ID);
    }
}

/// GHSA-w9xg on v5: a borrow on a treasury line is refused while the agent's invite bond was posted by a wallet that is
/// not the agent's owner, until the owner posts its own. Expected values are the fixture's numbers (5 USDG line and
/// bond, idleAfter 30 days, unusedAfter 4 days), worked by hand.
contract TreasurySponsorV5Test is TreasuryV5Base {
    uint256 constant ALT_PK = 0xA3; // the same person's second wallet, in the collusion tests
    address alt = vm.addr(ALT_PK);
    bytes32 constant HOOK_FAILED = keccak256("HookFailed(uint256,bytes4)");

    function setUp() public override {
        super.setUp();
        usdc.mint(alt, 10_000 * USDC);
        vm.startPrank(alt);
        usdc.approve(address(pool), type(uint256).max);
        usdc.approve(address(bond), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Raises have their own budget (audit 2026-10-10 M6)
    // ------------------------------------------------------------------

    /// Two raises to 25 in one week, with first lines capped at 20 a week: the raises spend the raise budget, never
    /// the first lines' room, so a newcomer's first line still opens right after them. On a shared cap the second
    /// raise reverted EpochCapReached, and with the cap at 40 both raises would have left nothing for first lines.
    function test_raises_neverSpendTheFirstLinesRoom() public {
        _funded();
        TreasurySponsorV5.Rules memory r = _rules();
        r.secondLine = 25 * USDC;
        r.epochCap = 20 * USDC;
        vm.prank(owner);
        treasury.setRules(r);
        // two agents with a $5 line each, qualified for a raise (3 loans of 7 days, 21 days on the line)
        _firstLine(AGENT, AGENT_PK);
        _firstLine(AGENT2, AGENT2_PK);
        for (uint256 i = 0; i < 3; i++) {
            uint256 a = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
            uint256 b = _borrow(agentOp2, AGENT2, 5 * USDC, 7 days);
            vm.warp(vm.getBlockTimestamp() + 7 days);
            _repay(agentOp, a);
            _repay(agentOp2, b);
        }
        assertTrue(treasury.eligibleForRaise(AGENT) && treasury.eligibleForRaise(AGENT2), "both qualify");
        uint256 room = treasury.epochRoom();
        treasury.raise(AGENT);
        treasury.raise(AGENT2);
        assertEq(_line(AGENT), 25 * USDC);
        assertEq(_line(AGENT2), 25 * USDC);
        assertEq(treasury.epochRoom(), room, "the raises spent none of the first lines' room");
        // a newcomer's first line opens right after them
        vm.prank(agentOp);
        uint256 third = reg.register("ipfs://agent3");
        _firstLine(third, AGENT_PK);
        assertEq(_line(third), 5 * USDC);
        assertEq(treasury.epochRoom(), room - 5 * USDC);
    }

    /// The raise budget bounds what raised lines can add in a week: past it a raise reverts RaiseCapReached until the
    /// next epoch, and a budget of 0 stops raises. The owner sets it; nobody else can.
    function test_raiseCap_boundsRaisesPerEpoch() public {
        _funded();
        TreasurySponsorV5.Rules memory r = _rules();
        r.secondLine = 25 * USDC;
        vm.startPrank(owner);
        treasury.setRules(r);
        treasury.setRaiseCap(20 * USDC); // one raise of 20 a week
        vm.stopPrank();
        vm.prank(anyone);
        vm.expectRevert();
        treasury.setRaiseCap(1000 * USDC);
        _firstLine(AGENT, AGENT_PK);
        _firstLine(AGENT2, AGENT2_PK);
        for (uint256 i = 0; i < 3; i++) {
            uint256 a = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
            uint256 b = _borrow(agentOp2, AGENT2, 5 * USDC, 7 days);
            vm.warp(vm.getBlockTimestamp() + 7 days);
            _repay(agentOp, a);
            _repay(agentOp2, b);
        }
        treasury.raise(AGENT);
        assertEq(treasury.raiseRoom(), 0);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.RaiseCapReached.selector, 20 * USDC, 0));
        treasury.raise(AGENT2);
        // the next epoch: room again
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(treasury.raiseRoom(), 20 * USDC);
        // a budget of 0 stops raises
        vm.prank(owner);
        treasury.setRaiseCap(0);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.RaiseCapReached.selector, 20 * USDC, 0));
        treasury.raise(AGENT2);
        vm.prank(owner);
        treasury.setRaiseCap(20 * USDC);
        treasury.raise(AGENT2);
        assertEq(_line(AGENT2), 25 * USDC);
    }

    // ------------------------------------------------------------------
    // move: an agent the previous treasury lined gets its first line here, bonded (2026-10-14)
    // ------------------------------------------------------------------

    function _otherRoot() internal returns (uint256 root) {
        vm.prank(rootOp);
        root = reg.register("other-root");
        vm.prank(rootOp);
        pool.enrollRoot(root, 100 * USDC);
    }

    function _lineFrom(uint256 root, uint256 id, uint256 pk, uint256 amount) internal {
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consentFor(id, root, pk);
        vm.prank(rootOp);
        pool.vouchWithConsent(root, id, amount, 0, c, sig);
    }

    /// An agent on the previous treasury's line leaves it, bonds here (not before: a bond is never posted under
    /// another sponsor's line) and moves with its owner's consent, no invite: the new line is charged to the first
    /// lines' room, the bond stays on it, it moves once only, and its record then raises it here.
    function test_move_previousAgentGetsABondedLineHere_thenIsRaised() public {
        _funded();
        uint256 v4root = _otherRoot();
        _lineFrom(v4root, AGENT, AGENT_PK, 5 * USDC);
        prev.setRoot(v4root);
        prev.setLined(AGENT, true);
        vm.prank(agentOp);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotTreasuryLine.selector, AGENT));
        bond.deposit(AGENT);
        vm.prank(agentOp);
        pool.leave(AGENT);
        assertEq(pool.getAgent(v4root).delegatedOut, 0, "the previous line went back to its root");
        _deposit(agentOp, AGENT);
        uint256 room = treasury.epochRoom();
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectEmit(address(treasury));
        emit TreasurySponsorV5.Moved(AGENT, agentOp);
        vm.prank(anyone);
        treasury.move(AGENT, c, sig);
        assertEq(pool.getAgent(AGENT).sponsor, TREASURY_ID);
        assertEq(_line(AGENT), 5 * USDC);
        assertEq(treasury.epochRoom(), room - 5 * USDC, "charged like any first line");
        assertTrue(treasury.firstLined(AGENT));
        assertFalse(bond.releasable(AGENT), "bonded from its first block");

        (c, sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotMovable.selector, AGENT));
        treasury.move(AGENT, c, sig);

        TreasurySponsorV5.Rules memory r = _rules();
        r.secondLine = 25 * USDC;
        vm.prank(owner);
        treasury.setRules(r);
        _qualify(agentOp, AGENT);
        treasury.raise(AGENT);
        assertEq(_line(AGENT), 25 * USDC, "raised here by its record");
    }

    /// Who cannot move: an agent the previous treasury never lined, one sponsored by another root, one whose bond is
    /// not its owner's (none, or the seller's after a sale; the buyer's own bond lets it move), an owner a default
    /// marked.
    function test_move_refusals() public {
        _funded();
        _deposit(agentOp, AGENT);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotMovable.selector, AGENT));
        treasury.move(AGENT, c, sig); // never lined by the previous treasury
        prev.setLined(AGENT, true);

        _lineFrom(_otherRoot(), AGENT, AGENT_PK, 5 * USDC);
        (c, sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotMovable.selector, AGENT));
        treasury.move(AGENT, c, sig); // another root's line
        vm.prank(agentOp);
        pool.leave(AGENT);

        _sell(AGENT, agentOp, agentOp2);
        (c, sig) = _consent(AGENT, AGENT2_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotMovable.selector, AGENT));
        treasury.move(AGENT, c, sig); // the seller's bond
        _deposit(agentOp2, AGENT);
        treasury.move(AGENT, c, sig);
        assertEq(_line(AGENT), 5 * USDC, "with its own bond, the buyer moves it");

        prev.setLined(AGENT2, true);
        (c, sig) = _consent(AGENT2, AGENT2_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotMovable.selector, AGENT2));
        treasury.move(AGENT2, c, sig); // no bond
    }

    function test_move_refusesAMarkedOwner() public {
        _funded();
        vm.prank(agentOp);
        uint256 other = reg.register("ipfs://other");
        _firstLine(other, AGENT_PK);
        _default(_borrow(agentOp, other, 5 * USDC, 1 days));
        prev.setLined(AGENT, true);
        _deposit(agentOp, AGENT);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.OwnerDefaulted.selector, agentOp));
        treasury.move(AGENT, c, sig);
    }

    /// A record the previous treasury flagged as protocol-seeded moves, but is never raised by rule here either
    /// (review 2026-10-14: `move` dropped the flag, and an inherited record could be raised at once).
    function test_move_keepsThePreviousSeededFlag() public {
        _funded();
        TreasurySponsorV5.Rules memory r = _rules();
        r.secondLine = 25 * USDC;
        vm.prank(owner);
        treasury.setRules(r);
        prev.setLined(AGENT, true);
        prev.setSeeded(AGENT, true);
        _deposit(agentOp, AGENT);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectEmit(address(treasury));
        emit TreasurySponsorV5.SeededSet(AGENT, true);
        treasury.move(AGENT, c, sig);
        assertTrue(treasury.seeded(AGENT), "the flag came along");
        _qualify(agentOp, AGENT);
        assertFalse(treasury.eligibleForRaise(AGENT), "a seeded record is not raised by rule");
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotEligible.selector, AGENT));
        treasury.raise(AGENT);
    }

    /// The previous treasury flags a record seeded after it moved: it is not raised here either (review 2026-10-14).
    function test_move_aLaterSeededFlagOnThePreviousTreasuryStillHolds() public {
        _funded();
        TreasurySponsorV5.Rules memory r = _rules();
        r.secondLine = 25 * USDC;
        vm.prank(owner);
        treasury.setRules(r);
        prev.setLined(AGENT, true);
        _deposit(agentOp, AGENT);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        treasury.move(AGENT, c, sig);
        _qualify(agentOp, AGENT);
        assertTrue(treasury.eligibleForRaise(AGENT));
        prev.setSeeded(AGENT, true);
        assertFalse(treasury.eligibleForRaise(AGENT), "flagged on the previous treasury after the move");
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotEligible.selector, AGENT));
        treasury.raise(AGENT);
    }

    /// Not while the agent still has a bond in the previous treasury's InviteBond (v1): it would stay locked under this
    /// line and a default here would slash it too, after a sale the seller's (review 2026-10-14). Once it is gone, the
    /// agent moves.
    function test_move_waitsForTheLegacyBondToBeGone() public {
        _funded();
        prev.setLined(AGENT, true);
        legacy.setBonded(AGENT, true);
        _deposit(agentOp, AGENT);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotMovable.selector, AGENT));
        treasury.move(AGENT, c, sig);
        legacy.setBonded(AGENT, false);
        treasury.move(AGENT, c, sig);
        assertEq(_line(AGENT), 5 * USDC);
    }

    // ------------------------------------------------------------------
    // The hook is in place before any line exists, and stays
    // ------------------------------------------------------------------

    /// Adopted but not yet a root: no hook, and no line can be opened. The sweep that enrolls the root sets the hook
    /// in the same call, at once (no 48 h queue). Nobody, the treasury's owner and the pool's timelock included, can
    /// move it afterwards.
    function test_hook_setByTheEnrollingSweep_beforeAnyLine() public {
        assertEq(pool.hook(TREASURY_ID), address(0), "adopted, not a root: no hook yet");
        bytes memory inv = _invite(AGENT, FAR);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT_PK);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotRoot.selector, TREASURY_ID));
        treasury.firstLine(AGENT, FAR, inv, c, sig); // no line before the root, so none before the hook

        _creatorFees(400 * USDC);
        vm.expectEmit(address(pool));
        emit CreditPoolV2.HookSet(TREASURY_ID, address(treasury));
        treasury.sweep();
        assertTrue(pool.getAgent(TREASURY_ID).isRoot);
        assertEq(pool.hook(TREASURY_ID), address(treasury), "the treasury is its root's hook");
        assertEq(pool.pendingHook(TREASURY_ID), address(0), "applied, not queued");
        assertEq(pool.hookEta(TREASURY_ID), 0);

        address[3] memory who = [owner, timelock, anyone];
        for (uint256 i = 0; i < who.length; i++) {
            vm.prank(who[i]);
            vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotOwnerOf.selector, TREASURY_ID, who[i]));
            pool.setHook(TREASURY_ID, address(0));
            vm.prank(who[i]);
            vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.NotOwnerOf.selector, TREASURY_ID, who[i]));
            pool.retireRoot(TREASURY_ID);
        }
        // later sweeps add stake and leave the hook alone
        _creatorFees(40 * USDC);
        treasury.sweep();
        assertEq(pool.hook(TREASURY_ID), address(treasury));
    }

    /// No bond, a bond on another pool, or a bond reading another treasury's rules is refused at deploy.
    function test_constructor_refusesABondOnAnotherPoolOrRules() public {
        vm.expectRevert(TreasurySponsorV5.InvalidAddress.selector);
        new TreasurySponsorV5(
            pool,
            IPonsFeeEscrow(address(escrow)),
            IPonsFactoryCreator(address(escrow)),
            owner,
            sink,
            InviteBondV2(address(0)),
            prev,
            legacy
        );
        CreditPoolV2 other = new CreditPoolV2(
            IERC20(address(usdc)),
            IERC8004Identity(address(reg)),
            CreditPool(address(0)),
            timelock,
            timelock,
            _poolParams()
        );
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        InviteBondV2 elsewhere =
            new InviteBondV2(other, IERC8004Identity(address(reg)), ITreasuryRules(next), safe, BOND, UNUSED);
        vm.expectRevert(TreasurySponsorV5.InvalidAddress.selector);
        new TreasurySponsorV5(
            pool,
            IPonsFeeEscrow(address(escrow)),
            IPonsFactoryCreator(address(escrow)),
            owner,
            sink,
            elsewhere,
            prev,
            legacy
        );
        // the right pool, but its release bar would be another treasury's (here: the fixture's)
        vm.expectRevert(TreasurySponsorV5.InvalidAddress.selector);
        new TreasurySponsorV5(
            pool, IPonsFeeEscrow(address(escrow)), IPonsFactoryCreator(address(escrow)), owner, sink, bond, prev, legacy
        );
        assertEq(address(treasury.bond()), address(bond));
        assertEq(address(bond.treasury()), address(treasury));
    }

    /// The answer itself: yes with no bond, yes for the depositor, no for anyone else.
    function test_canBorrow_readsTheBondAgainstTheOwnerAtBorrowTime() public {
        assertTrue(treasury.canBorrow(TREASURY_ID, AGENT, 5 * USDC, 7 days, 0, agentOp, agentOp, agentOp), "no bond");
        _deposit(agentOp, AGENT);
        assertTrue(treasury.canBorrow(TREASURY_ID, AGENT, 5 * USDC, 7 days, 0, agentOp, agentOp, agentOp), "depositor");
        assertFalse(
            treasury.canBorrow(TREASURY_ID, AGENT, 5 * USDC, 7 days, 0, agentOp, agentOp2, agentOp), "another owner"
        );
        // only `owner` counts: the caller (a delegate, a relayer) and the receiver do not
        assertTrue(treasury.canBorrow(TREASURY_ID, AGENT, 5 * USDC, 7 days, 0, anyone, agentOp, anyone));
        assertFalse(treasury.canBorrow(TREASURY_ID, AGENT, 5 * USDC, 7 days, 0, agentOp, anyone, agentOp));
    }

    // ------------------------------------------------------------------
    // GHSA-w9xg, path 1: the line was open before the sale
    // ------------------------------------------------------------------

    function test_w9xg_lineOpenBeforeSale_buyerCannotBorrow_sellerBondComesBack() public {
        _funded();
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 sellerBefore = usdc.balanceOf(agentOp);
        uint256 buyerBefore = usdc.balanceOf(agentOp2);

        _sell(AGENT, agentOp, agentOp2);
        vm.prank(agentOp2);
        vm.expectRevert(_blocked());
        pool.borrow(AGENT, 5 * USDC, 7 days, agentOp2, type(uint256).max);
        // a delegate of the buyer is refused the same way: the owner is what counts
        vm.prank(agentOp2);
        pool.setDelegate(AGENT, anyone);
        vm.prank(anyone);
        vm.expectRevert(_blocked());
        pool.borrow(AGENT, 5 * USDC, 7 days, anyone, type(uint256).max);

        // the seller's bond is untouched, and the line is intact
        InviteBondV2.Bond memory b = bond.bonds(AGENT);
        assertEq(b.depositor, agentOp);
        assertEq(b.amount, BOND);
        assertEq(usdc.balanceOf(address(bond)), BOND);
        assertEq(_line(AGENT), 5 * USDC);
        assertEq(pool.getAgent(AGENT).activeLoans, 0);
        assertFalse(bond.slashable(AGENT));

        // the bond comes back to the seller by the bond's own path: the unused line is reclaimed, then released
        vm.warp(vm.getBlockTimestamp() + _idle());
        treasury.reclaim(AGENT);
        assertTrue(bond.releasable(AGENT));
        vm.prank(anyone);
        bond.release(AGENT);
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND, "the seller got its bond back");
        assertEq(usdc.balanceOf(agentOp2), buyerBefore, "the buyer got nothing");
        assertEq(pool.getAgent(TREASURY_ID).delegatedOut, 0, "the treasury lost nothing");
        assertEq(pool.getAgent(TREASURY_ID).childrenDefaulted, 0);
    }

    // ------------------------------------------------------------------
    // GHSA-w9xg, path 2: the buyer redeems the seller's unused invite (the reporter's PoC, TrackTStaleBond)
    // ------------------------------------------------------------------

    function test_w9xg_buyerRedeemsSellersInvite_cannotBorrow_sellerBondComesBack() public {
        _funded();
        _deposit(agentOp, AGENT);
        bytes memory inv = _invite(AGENT, FAR); // signed for the seller, who bonded
        uint256 sellerBefore = usdc.balanceOf(agentOp);
        _sell(AGENT, agentOp, agentOp2);

        (CreditPoolV2.Consent memory c, bytes memory sig) = _consent(AGENT, AGENT2_PK);
        vm.prank(relayer);
        treasury.firstLine(AGENT, FAR, inv, c, sig); // invites name the agent only: the line opens
        assertEq(_line(AGENT), 5 * USDC);

        vm.prank(agentOp2);
        vm.expectRevert(_blocked());
        pool.borrow(AGENT, 5 * USDC, 7 days, agentOp2, type(uint256).max);
        assertEq(bond.bonds(AGENT).depositor, agentOp, "the seller's bond is untouched");
        assertEq(usdc.balanceOf(address(bond)), BOND);

        // nothing to slash, nothing lost; the line idles out and the bond goes home
        vm.warp(vm.getBlockTimestamp() + _idle());
        treasury.reclaim(AGENT);
        bond.release(AGENT);
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND);
        assertEq(usdc.balanceOf(safe), 0);
    }

    // ------------------------------------------------------------------
    // The depositor, and a new owner with its own bond
    // ------------------------------------------------------------------

    /// The owner who posted the bond borrows as on v4, itself or through its delegate.
    function test_depositorBorrows_itselfOrThroughItsDelegate() public {
        _funded();
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        assertEq(pool.getLoan(loan).owner, agentOp);
        _repay(agentOp, loan);
        vm.prank(agentOp);
        pool.setDelegate(AGENT, anyone);
        loan = _borrow(anyone, AGENT, 5 * USDC, 7 days);
        assertEq(pool.getLoan(loan).owner, agentOp, "a delegate borrows for the depositor");
    }

    /// The buyer posts its own bond: the seller's comes back in the same transaction, the buyer borrows, and a default
    /// now forfeits the buyer's bond, not the seller's.
    function test_newOwnerPostsItsOwnBond_borrows_sellerRefunded() public {
        _funded();
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        _sell(AGENT, agentOp, agentOp2);
        vm.prank(agentOp2);
        vm.expectRevert(_blocked());
        pool.borrow(AGENT, 5 * USDC, 7 days, agentOp2, type(uint256).max);

        uint256 sellerBefore = usdc.balanceOf(agentOp);
        uint256 buyerBefore = usdc.balanceOf(agentOp2);
        _deposit(agentOp2, AGENT);
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND, "the seller got the old bond back");
        assertEq(usdc.balanceOf(agentOp2), buyerBefore - BOND);
        assertEq(bond.bonds(AGENT).depositor, agentOp2);

        uint256 loan = _borrow(agentOp2, AGENT, 5 * USDC, 7 days);
        assertEq(pool.getLoan(loan).owner, agentOp2);
        _default(loan);
        bond.slash(AGENT);
        assertEq(usdc.balanceOf(safe), BOND, "the buyer's bond covers the buyer's default");
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND, "the seller is out of it");
        assertEq(pool.ownerDefaults(agentOp), 0);
        assertEq(pool.ownerDefaults(agentOp2), 1);
    }

    // ------------------------------------------------------------------
    // Self-transfer collusion: the reason the bond is not refunded on transfer
    // ------------------------------------------------------------------

    /// Bond, move the agent to one's own second wallet, borrow, default. The second wallet cannot borrow without a
    /// bond of its own; with one, its default forfeits it. The pair never ends with more USDG than it started with.
    function test_selfTransferCollusion_secondWalletNeedsItsOwnBond_netsNothing() public {
        _funded();
        uint256 start = usdc.balanceOf(agentOp) + usdc.balanceOf(alt);
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        _sell(AGENT, agentOp, alt);

        vm.prank(alt);
        vm.expectRevert(_blocked());
        pool.borrow(AGENT, 5 * USDC, 30 days, alt, type(uint256).max);

        _deposit(alt, AGENT); // the first wallet's bond comes back, the second's goes in
        uint256 loan = _borrow(alt, AGENT, 5 * USDC, 30 days);
        _default(loan);
        bond.slash(AGENT);

        int256 net = int256(usdc.balanceOf(agentOp) + usdc.balanceOf(alt)) - int256(start);
        assertLe(net, 0, "the pair gains nothing");
        assertEq(net, 0, "exactly: 5 borrowed, 5 forfeited, the fee never paid");
        assertEq(usdc.balanceOf(safe), BOND, "the Safe holds the bond against the loss");
        assertEq(usdc.balanceOf(address(bond)), 0);
    }

    /// Same pair, other order: the first wallet borrows (it is the depositor, so it may) and moves the agent. The
    /// second wallet cannot bond while that loan is open (InviteBondV2), so it cannot take the first wallet's bond
    /// off the loan; the default forfeits the first wallet's own bond. (On InviteBond the second wallet's deposit
    /// went through, refunded the first, and the second wallet's bond paid: the same net for the pair, but the same
    /// move hurt an honest buyer, see test/InviteBondV2.t.sol.)
    function test_selfTransferCollusion_borrowFirstThenMove_netsNothing() public {
        _funded();
        uint256 start = usdc.balanceOf(agentOp) + usdc.balanceOf(alt);
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 30 days);
        _sell(AGENT, agentOp, alt);
        vm.prank(alt);
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.LoanOpen.selector, AGENT));
        bond.deposit(AGENT);
        _default(loan);
        bond.slash(AGENT);
        int256 net = int256(usdc.balanceOf(agentOp) + usdc.balanceOf(alt)) - int256(start);
        assertLe(net, 0, "the pair gains nothing");
        assertEq(net, 0, "5 borrowed, the first wallet's 5 forfeited");
        assertEq(usdc.balanceOf(safe), BOND);
    }

    // ------------------------------------------------------------------
    // No bond: as on v4
    // ------------------------------------------------------------------

    /// An admin-approved invite carries no bond: the owner borrows as on v4, and so does a buyer (nothing to protect).
    function test_unbondedLine_borrowsAsOnV4() public {
        _funded();
        _firstLine(AGENT, AGENT_PK);
        assertFalse(bond.isBonded(AGENT));
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _repay(agentOp, loan);
        _sell(AGENT, agentOp, agentOp2);
        loan = _borrow(agentOp2, AGENT, 5 * USDC, 7 days);
        assertEq(pool.getLoan(loan).owner, agentOp2);
    }

    /// A seasoned record does not release the bond while the line is open (audit 2026-10-10 H1), so a sale after
    /// seasoning still shuts the line until the buyer bonds; the bond comes back once the line is closed.
    function test_seasonedRecord_keepsTheBond_buyerStillBlocked() public {
        _funded();
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        _qualify(agentOp, AGENT);
        assertFalse(bond.releasable(AGENT), "three qualified loans, line open: the bond stays");
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.NotReleasable.selector, AGENT));
        bond.release(AGENT);
        _sell(AGENT, agentOp, agentOp2);
        vm.prank(agentOp2);
        vm.expectRevert(_blocked());
        pool.borrow(AGENT, 5 * USDC, 7 days, agentOp2, type(uint256).max);

        uint256 sellerBefore = usdc.balanceOf(agentOp);
        vm.prank(agentOp2);
        pool.leave(AGENT);
        bond.release(AGENT);
        assertEq(usdc.balanceOf(agentOp), sellerBefore + BOND, "line closed: the bond goes back to its depositor");
    }

    // ------------------------------------------------------------------
    // Every hook call behaves
    // ------------------------------------------------------------------

    /// The pool calls the treasury on borrow, default, and every release reason that touches a treasury line (unvouch
    /// by reclaim, leave, handoff, freeze, default residual). None fails: no HookFailed is ever emitted.
    function test_hookNotifications_neverFail() public {
        _funded();
        vm.prank(rootOp);
        uint256 root = reg.register("other-root");
        vm.prank(rootOp);
        pool.enrollRoot(root, 100 * USDC);
        vm.prank(agentOp);
        uint256 third = reg.register("third");
        vm.recordLogs();

        // borrow (onBorrow), repay
        _firstLine(AGENT, AGENT_PK);
        vm.expectCall(address(treasury), abi.encodeWithSelector(IBackerHook.onBorrow.selector, TREASURY_ID, AGENT, 1));
        uint256 loan = _borrow(agentOp, AGENT, 5 * USDC, 7 days);
        _repay(agentOp, loan);
        // leave (onRelease, Leave)
        vm.expectCall(
            address(treasury),
            abi.encodeWithSelector(
                IBackerHook.onRelease.selector, TREASURY_ID, AGENT, 5 * USDC, uint8(CreditPoolV2.Release.Leave)
            )
        );
        vm.prank(agentOp);
        pool.leave(AGENT);
        // reclaim (onRelease, Unvouch)
        _firstLine(AGENT2, AGENT2_PK);
        vm.warp(vm.getBlockTimestamp() + _idle());
        vm.expectCall(
            address(treasury),
            abi.encodeWithSelector(
                IBackerHook.onRelease.selector, TREASURY_ID, AGENT2, 5 * USDC, uint8(CreditPoolV2.Release.Unvouch)
            )
        );
        treasury.reclaim(AGENT2);
        // handoff to another root (onRelease, Handoff)
        _firstLineWith(AGENT2, AGENT2_PK, FAR - 1);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _consentFor(AGENT2, root, AGENT2_PK);
        vm.expectCall(
            address(treasury),
            abi.encodeWithSelector(
                IBackerHook.onRelease.selector, TREASURY_ID, AGENT2, 5 * USDC, uint8(CreditPoolV2.Release.Handoff)
            )
        );
        vm.prank(rootOp);
        pool.vouchWithConsent(root, AGENT2, 10 * USDC, 0, c, sig);
        // freeze with nothing drawn (onRelease, Freeze)
        _firstLineWith(AGENT, AGENT_PK, FAR - 2);
        vm.expectCall(
            address(treasury),
            abi.encodeWithSelector(
                IBackerHook.onRelease.selector, TREASURY_ID, AGENT, 5 * USDC, uint8(CreditPoolV2.Release.Freeze)
            )
        );
        vm.prank(owner);
        treasury.freeze(AGENT, true);
        // default (onDefault), then the residual line (onRelease, DefaultResidual): a raised line, half drawn
        _deposit(agentOp, third);
        _firstLine(third, AGENT_PK);
        _qualify(agentOp, third);
        treasury.raise(third);
        loan = _borrow(agentOp, third, 20 * USDC, 7 days);
        vm.expectCall(
            address(treasury),
            abi.encodeWithSelector(IBackerHook.onDefault.selector, TREASURY_ID, third, loan, 20 * USDC, true)
        );
        vm.expectCall(
            address(treasury),
            abi.encodeWithSelector(
                IBackerHook.onRelease.selector,
                TREASURY_ID,
                third,
                30 * USDC,
                uint8(CreditPoolV2.Release.DefaultResidual)
            )
        );
        _default(loan);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(pool) && logs[i].topics[0] == HOOK_FAILED) {
                fail("the pool reported a failed hook call");
            }
        }
    }

    /// The pool only ever reaches the treasury's root functions through the treasury; the hook adds no lever for a
    /// stranger (the notifications are no-ops anyone may call, and `canBorrow` is a view).
    function test_hookFunctions_giveAStrangerNothing() public {
        _funded();
        _deposit(agentOp, AGENT);
        _firstLine(AGENT, AGENT_PK);
        uint256 shares = pool.rootShares(TREASURY_ID);
        vm.startPrank(anyone);
        treasury.onBorrow(TREASURY_ID, AGENT, 1);
        treasury.onDefault(TREASURY_ID, AGENT, 1, 5 * USDC, true);
        treasury.onRelease(TREASURY_ID, AGENT, 5 * USDC, 0);
        vm.stopPrank();
        assertEq(pool.rootShares(TREASURY_ID), shares);
        assertEq(_line(AGENT), 5 * USDC);
        assertEq(bond.bonds(AGENT).depositor, agentOp);
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, anyone));
        treasury.freeze(AGENT, true);
    }
}
