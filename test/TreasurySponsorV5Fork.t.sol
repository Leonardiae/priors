// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {TreasurySponsorV4} from "../src/TreasurySponsorV4.sol";
import {TreasurySponsorV5, IPreviousTreasury, ILegacyBond} from "../src/TreasurySponsorV5.sol";
import {InviteBond, ITreasuryRules} from "../src/InviteBond.sol";
import {InviteBondV2} from "../src/InviteBondV2.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {IPonsFeeEscrow, IPonsFactoryCreator} from "../src/interfaces/IPonsFeeEscrow.sol";

interface IForkRegistryV5 {
    function register(string calldata uri) external returns (uint256);
    function ownerOf(uint256 id) external view returns (address);
    function transferFrom(address from, address to, uint256 id) external;
    function safeTransferFrom(address from, address to, uint256 id) external;
}

/// @dev Stands in for a live owner's signature: installed with `vm.etch` at the owner's address on the fork only, so
///      the pool's `validSig` accepts its consent through ERC-1271 (the owner's key is not available here). Same device as
///      test/v5/V5Fork.t.sol's Accept1271.
contract ForkConsent1271 {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }
}

/// @title TreasurySponsorV5 rehearsal against LIVE Robinhood Chain state (GHSA-w9xg).
/// @notice A forge test, not a script: it can never broadcast. It runs only when FORK_RPC is set, and only against a
///         local anvil fork (the URL must be 127.0.0.1 or localhost); without FORK_RPC every test is skipped:
///           anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8563 &
///           FORK_RPC=http://127.0.0.1:8563 forge test --match-path test/TreasurySponsorV5Fork.t.sol -vv
///         Optional FORK_BLOCK pins the block, FORK_AGENT picks the bonded agent.
///
///         setUp does what the migration does (docs/SECURITY-v2.md, TreasurySponsorV5): a deployer deploys InviteBondV2 (the live
///         InviteBond's amount, wait and beneficiary, reading the rules of the treasury deployed next) and v5 with the
///         Safe as owner, reading V2; the Safe registers an identity, hands it to v5, adopts it, copies v4's live
///         rules, makes v5 its own fee sink and names an inviter (a fork key: the production inviter's key is not used
///         here); 100 USDG reach v5 and anyone sweeps, which enrolls the root and sets the hook. Then one real bonded
///         agent on a live v4 line (its InviteBond bond posted by its owner, no loan open) is sold, through the live
///         CreditPoolV2: on v4 today the buyer draws the line on the seller's bond; on v5 (the seller bonds in V2, as
///         the bot will ask) the buyer is refused on both paths until it posts its own V2 bond, which refunds the
///         seller; a seller who borrows, sells and defaults forfeits its own V2 bond, because V2 refuses the buyer's
///         deposit while the loan is open (the live InviteBond accepts it: the last test).
contract TreasurySponsorV5ForkTest is Test {
    CreditPoolV2 constant POOL = CreditPoolV2(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    TreasurySponsorV4 constant V4 = TreasurySponsorV4(payable(0x0c5091235A25bBFD3F5a009cBe04120D0CBAD573));
    InviteBond constant BOND = InviteBond(0x8BE478c754D9124D11e78dB20F5bf4dA45403275);
    IForkRegistryV5 constant REG = IForkRegistryV5(0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address constant SAFE = 0x20c6816B2419616238772591965E6E9AbE493fD5;
    address constant LIVE_INVITER = 0x9d32958f27A57DF71a940884e6eCc55a59BA934C; // runbook 6.5
    uint256 constant V4_ROOT = 6228;
    uint256 constant U = 1e6;

    // fork-only keys, worthless anywhere else
    uint256 constant INVITER_PK = uint256(keccak256("priors treasury v5 fork: inviter"));
    uint256 constant BUYER_PK = uint256(keccak256("priors treasury v5 fork: buyer"));

    bool forked;
    InviteBondV2 bond2;
    TreasurySponsorV5 v5;
    uint256 root;
    address inviter;
    address buyer;
    address relayer = makeAddr("relayer");
    address funder = makeAddr("funder");
    address deployer = makeAddr("deployer");

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _local(string memory url) internal pure returns (bool) {
        return _startsWith(url, "http://127.0.0.1:") || _startsWith(url, "http://localhost:");
    }

    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(p);
        if (a.length < b.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        require(_local(rpc), "FORK_RPC must be a local anvil fork: http://127.0.0.1:<port> or http://localhost:<port>");
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        forked = true;
        assertEq(block.chainid, 4663, "Robinhood Chain");
        assertEq(address(BOND.pool()), address(POOL), "the live bond stands on the live pool");
        assertEq(V4.owner(), SAFE, "the Safe owns v4");
        inviter = vm.addr(INVITER_PK);
        buyer = vm.addr(BUYER_PK);

        // 1. deployer: InviteBondV2 naming the address v5 is about to get, then v5 (owned by the Safe, reading V2;
        //    Pons wiring as v4's). v5's constructor checks that V2 reads its rules.
        //    The arguments are read first: a prank applies to the next call, and an argument's call would take it.
        (address beneficiary, uint256 amount, uint64 unusedAfter) =
            (BOND.beneficiary(), BOND.amount(), BOND.unusedAfter());
        (IPonsFeeEscrow escrow, IPonsFactoryCreator factory) = (V4.escrow(), V4.factory());
        address next = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        vm.startPrank(deployer);
        bond2 = new InviteBondV2(
            POOL, IERC8004Identity(address(REG)), ITreasuryRules(next), beneficiary, amount, unusedAfter
        );
        v5 = new TreasurySponsorV5(
            POOL, escrow, factory, SAFE, SAFE, bond2, IPreviousTreasury(address(V4)), ILegacyBond(address(BOND))
        );
        vm.stopPrank();
        assertEq(address(v5), next, "V2 names the address v5 got");

        // 2-7. the Safe: an identity for v5's root, adopt, v4's live rules, v5 as its own fee sink, an inviter
        vm.startPrank(SAFE);
        root = REG.register("ipfs://priors-treasury-v5");
        REG.safeTransferFrom(SAFE, address(v5), root);
        v5.adopt(root);
        v5.setRules(_v4Rules());
        v5.setFeeSink(address(v5));
        v5.setInviter(inviter, true);
        vm.stopPrank();

        // 8-9. money in, then anyone sweeps: the root enrolls and the hook is set in the same call
        deal(address(USDG), funder, 100 * U);
        vm.prank(funder);
        USDG.transfer(address(v5), 100 * U);
        vm.expectEmit(address(POOL));
        emit CreditPoolV2.HookSet(root, address(v5));
        vm.prank(relayer);
        v5.sweep();
        assertTrue(POOL.getAgent(root).isRoot);
        assertEq(POOL.hook(root), address(v5));
    }

    function _v4Rules() internal view returns (TreasurySponsorV5.Rules memory r) {
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
        ) = V4.rules();
    }

    /// The first live bonded agent whose bond its owner posted, on an open v4 line with nothing drawn, an EOA owner
    /// with no default (so its consent can be stood in for), never defaulted. FORK_AGENT overrides the choice.
    function _pick() internal view returns (uint256 id, address seller) {
        uint256 forcedId = vm.envOr("FORK_AGENT", uint256(0));
        uint256[] memory ids = BOND.activeIds(0, BOND.activeCount());
        for (uint256 i = 0; i < ids.length; i++) {
            id = ids[i];
            if (forcedId != 0 && id != forcedId) continue;
            seller = REG.ownerOf(id);
            CreditPoolV2.Agent memory a = POOL.getAgent(id);
            if (BOND.bonds(id).depositor != seller || seller.code.length != 0 || POOL.ownerDefaults(seller) != 0) {
                continue;
            }
            if (a.defaulted || a.isRoot || a.frozen || a.activeLoans != 0) continue;
            if (a.sponsor != V4_ROOT || a.delegatedIn < 5 * U) continue;
            return (id, seller);
        }
        revert("no live bonded agent fits; set FORK_AGENT");
    }

    function _show(string memory what, uint256 id, address seller) internal view {
        CreditPoolV2.Agent memory a = POOL.getAgent(id);
        console2.log(what);
        console2.log("   agent", id, "owner", REG.ownerOf(id));
        console2.log("   InviteBond (live) depositor", BOND.bonds(id).depositor);
        console2.log("   InviteBondV2 depositor", bond2.bonds(id).depositor);
        console2.log("   sponsor", a.sponsor, "line", a.delegatedIn);
        console2.log("   seller USDG", USDG.balanceOf(seller), "buyer USDG", USDG.balanceOf(buyer));
    }

    function _invite(uint256 id, uint64 expiry) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(INVITER_PK, v5.inviteDigest(id, expiry));
        return abi.encodePacked(r, s, v);
    }

    function _consent(uint256 id, address who) internal view returns (CreditPoolV2.Consent memory c) {
        c = CreditPoolV2.Consent({
            agentId: id,
            sponsorId: root,
            owner: who,
            maxPremiumBps: 0,
            nonce: POOL.nonces(id),
            deadline: block.timestamp + 1 hours
        });
    }

    function _buyerConsent(uint256 id) internal view returns (CreditPoolV2.Consent memory c, bytes memory sig) {
        c = _consent(id, buyer);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, POOL.consentDigest(c));
        sig = abi.encodePacked(r, s, v);
    }

    function _sell(uint256 id, address seller) internal {
        vm.prank(seller);
        REG.transferFrom(seller, buyer, id);
        assertEq(REG.ownerOf(id), buyer);
    }

    /// `who` posts a V2 bond on `id` (what the bot asks before a v5 invite), with USDG dealt for it. V2 takes a bond only
    /// on an agent v5 sponsors or nobody does: an agent on v4's line leaves it first (`_leaveV4`).
    function _bondV2(address who, uint256 id) internal {
        deal(address(USDG), who, USDG.balanceOf(who) + bond2.amount());
        vm.startPrank(who);
        USDG.approve(address(bond2), bond2.amount());
        bond2.deposit(id);
        vm.stopPrank();
    }

    /// The owner leaves its v4 line (the pool's `leave`; no loan is open on a picked agent).
    function _leaveV4(uint256 id, address owner_) internal {
        vm.prank(owner_);
        POOL.leave(id);
        assertEq(POOL.getAgent(id).delegatedIn, 0);
    }

    /// The seller's consent to a v5 line, through the ERC-1271 stand-in, and the line.
    function _sellerLinesOnV5(uint256 id, address seller) internal {
        vm.etch(seller, type(ForkConsent1271).runtimeCode); // the seller's consent, stood in for (fork only)
        uint64 expiry = uint64(block.timestamp + 3 days);
        bytes memory inv = _invite(id, expiry);
        vm.prank(relayer);
        v5.firstLine(id, expiry, inv, _consent(id, seller), hex"01");
        assertEq(POOL.getAgent(id).sponsor, root);
        console2.log("firstLine on v5: line", POOL.getAgent(id).delegatedIn);
    }

    function _rebondAndBorrow(uint256 id, address seller) internal {
        uint256 sellerBefore = USDG.balanceOf(seller);
        _bondV2(buyer, id);
        assertEq(USDG.balanceOf(seller), sellerBefore + bond2.amount(), "the seller got its bond back");
        assertEq(bond2.bonds(id).depositor, buyer);
        console2.log("buyer posts its own bond: seller refunded", USDG.balanceOf(seller) - sellerBefore);
        uint256 g = gasleft();
        vm.prank(buyer);
        uint256 loan = POOL.borrow(id, 5 * U, 7 days, buyer, type(uint256).max);
        g -= gasleft();
        assertEq(POOL.getLoan(loan).owner, buyer);
        assertEq(POOL.getLoan(loan).sponsorId, root);
        console2.log("buyer borrows 5 USDG on v5 now: loan", loan);
        console2.log("   gas for the v5 borrow (hook asked)", g);
    }

    // ------------------------------------------------------------------
    // The setup itself
    // ------------------------------------------------------------------

    function test_fork_0_setup_rootHookInviterRules() public onFork {
        console2.log("fork block", block.number, "timestamp", block.timestamp);
        console2.log("TreasurySponsorV5 deployed at", address(v5));
        console2.log("   runtime size (bytes)", address(v5).code.length);
        console2.log("   owner", v5.owner(), "bond (InviteBondV2)", address(v5.bond()));
        console2.log("InviteBondV2 deployed at", address(bond2), "runtime size (bytes)", address(bond2).code.length);
        console2.log("   reads the rules of", address(bond2.treasury()));
        console2.log("   amount", bond2.amount(), "unusedAfter", bond2.unusedAfter());
        console2.log("   beneficiary", bond2.beneficiary());
        assertEq(address(bond2.treasury()), address(v5));
        console2.log("   root", root, "backing", POOL.backing(root));
        console2.log("   pool.hook(root)", POOL.hook(root));
        console2.log("   pool.hook(6228), v4's root", POOL.hook(V4_ROOT));
        console2.log("   inviter named on v5 (fork key)", inviter, v5.inviters(inviter));
        console2.log("   live v4 inviter", LIVE_INVITER, V4.inviters(LIVE_INVITER));
        (uint256 reserveBps, uint256 firstLine_, uint256 secondLine,,,, uint256 minQualified,,) = v5.rules();
        console2.log("   rules copied from v4: reserveBps", reserveBps, "firstLine", firstLine_);
        console2.log("   secondLine", secondLine, "minQualified", minQualified);
        console2.log("   live InviteBond bonds", BOND.activeCount());
        assertEq(v5.feeSink(), address(v5));
        assertEq(POOL.pendingHook(root), address(0), "applied at once, not queued");
        (, string memory name, string memory version,,,,) = v5.eip712Domain();
        assertEq(name, "Priors Treasury");
        assertEq(version, "5");
        // the migration's last Safe step: v4 opens no new line once its inviter is revoked
        vm.prank(SAFE);
        V4.setInviter(LIVE_INVITER, false);
        assertFalse(V4.inviters(LIVE_INVITER));
        console2.log("Safe: v4.setInviter(live inviter, false) -> inviters", V4.inviters(LIVE_INVITER));
    }

    // ------------------------------------------------------------------
    // v4 today (the live risk), for comparison
    // ------------------------------------------------------------------

    function test_fork_1_v4Today_buyerDrawsTheSellersBondedLine() public onFork {
        (uint256 id, address seller) = _pick();
        _show("== v4 today: a real bonded agent on a live v4 line, sold", id, seller);
        uint256 sellerBefore = USDG.balanceOf(seller);
        uint256 safeBefore = USDG.balanceOf(SAFE);
        _sell(id, seller);
        uint256 g = gasleft();
        vm.prank(buyer);
        uint256 loan = POOL.borrow(id, 5 * U, 7 days, buyer, type(uint256).max);
        g -= gasleft();
        console2.log("v4: the buyer borrows 5 USDG on the seller's bond: loan", loan);
        console2.log("   gas for the v4 borrow (no hook)", g);
        vm.warp(POOL.getLoan(loan).defaultableAt + 1);
        POOL.markDefault(loan);
        BOND.slash(id);
        assertEq(USDG.balanceOf(SAFE), safeBefore + BOND.amount(), "the seller's bond went to the Safe");
        assertEq(USDG.balanceOf(seller), sellerBefore, "and never came back to the seller");
        assertEq(USDG.balanceOf(buyer), 5 * U, "the buyer kept the principal");
        console2.log("v4: default marked, slash took the SELLER's bond to the Safe:", BOND.amount());
        console2.log("   the buyer kept", USDG.balanceOf(buyer));
    }

    // ------------------------------------------------------------------
    // v5, path 1: the line was open before the sale
    // ------------------------------------------------------------------

    function test_fork_2_v5_lineOpenBeforeSale_refusedThenRebond() public onFork {
        (uint256 id, address seller) = _pick();
        _show("== v5 path 1: the same agent, bonded in V2 and lined on v5 by its owner, then sold", id, seller);
        _leaveV4(id, seller);
        _bondV2(seller, id);
        _sellerLinesOnV5(id, seller);

        // the depositor borrows and repays, as on v4
        vm.prank(seller);
        uint256 own = POOL.borrow(id, 5 * U, 7 days, seller, type(uint256).max);
        console2.log("the seller (the depositor) borrows 5 USDG on v5: loan", own);
        deal(address(USDG), seller, USDG.balanceOf(seller) + POOL.getLoan(own).fee);
        vm.startPrank(seller);
        USDG.approve(address(POOL), type(uint256).max);
        POOL.repay(own, id, type(uint256).max);
        vm.stopPrank();
        console2.log("   and repays it");

        uint256 sellerBefore = USDG.balanceOf(seller);
        _sell(id, seller);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, root));
        POOL.borrow(id, 5 * U, 7 days, buyer, type(uint256).max);
        assertEq(bond2.bonds(id).depositor, seller, "the seller's bond is untouched");
        assertEq(USDG.balanceOf(seller), sellerBefore);
        console2.log("after the sale, the buyer's borrow REVERTS BorrowBlockedByBacker(root)", root);
        _show("   state after the refusal", id, seller);
        _rebondAndBorrow(id, seller);
    }

    // ------------------------------------------------------------------
    // v5, path 2: the buyer redeems the seller's unused invite
    // ------------------------------------------------------------------

    function test_fork_3_v5_buyerRedeemsTheSellersInvite_refusedThenRebond() public onFork {
        (uint256 id, address seller) = _pick();
        _show("== v5 path 2: bonded in V2, an invite signed, the agent sold before redeeming", id, seller);
        _leaveV4(id, seller);
        _bondV2(seller, id);
        uint64 expiry = uint64(block.timestamp + 3 days);
        bytes memory inv = _invite(id, expiry);
        _sell(id, seller);
        (CreditPoolV2.Consent memory c, bytes memory sig) = _buyerConsent(id);
        vm.prank(relayer);
        v5.firstLine(id, expiry, inv, c, sig);
        assertEq(POOL.getAgent(id).sponsor, root);
        console2.log("the buyer redeems the seller's invite on v5: line", POOL.getAgent(id).delegatedIn);

        uint256 sellerBefore = USDG.balanceOf(seller);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CreditPoolV2.BorrowBlockedByBacker.selector, root));
        POOL.borrow(id, 5 * U, 7 days, buyer, type(uint256).max);
        assertEq(bond2.bonds(id).depositor, seller, "the seller's bond is untouched");
        assertEq(USDG.balanceOf(seller), sellerBefore);
        console2.log("the buyer's borrow REVERTS BorrowBlockedByBacker(root)", root);
        _show("   state after the refusal", id, seller);
        _rebondAndBorrow(id, seller);
    }

    // ------------------------------------------------------------------
    // v5 + InviteBondV2: borrow, sell, default
    // ------------------------------------------------------------------

    /// The review's attack: the seller borrows on its own V2 bond, sells, and would let the buyer bond before
    /// defaulting. V2 refuses the buyer's deposit while the loan is open; the default forfeits the seller's bond.
    function test_fork_4_v5V2_sellerBorrowsSellsDefaults_buyerCannotBond_sellersBondPays() public onFork {
        (uint256 id, address seller) = _pick();
        _show("== v5 + V2: the seller borrows, sells, then defaults", id, seller);
        _leaveV4(id, seller);
        _bondV2(seller, id);
        _sellerLinesOnV5(id, seller);
        vm.prank(seller);
        uint256 loan = POOL.borrow(id, 5 * U, 7 days, seller, type(uint256).max);
        console2.log("the seller borrows 5 USDG on its own V2 bond: loan", loan);
        _sell(id, seller);

        deal(address(USDG), buyer, bond2.amount());
        vm.startPrank(buyer);
        USDG.approve(address(bond2), bond2.amount());
        vm.expectRevert(abi.encodeWithSelector(InviteBondV2.LoanOpen.selector, id));
        bond2.deposit(id);
        vm.stopPrank();
        assertEq(bond2.bonds(id).depositor, seller, "the seller's bond stays on the seller's loan");
        console2.log("the buyer's V2 deposit REVERTS LoanOpen(agent)", id);

        uint256 safeBefore = USDG.balanceOf(SAFE);
        uint256 sellerBefore = USDG.balanceOf(seller);
        vm.warp(POOL.getLoan(loan).defaultableAt + 1);
        POOL.markDefault(loan);
        bond2.slash(id);
        assertEq(USDG.balanceOf(SAFE), safeBefore + bond2.amount(), "the seller's own bond paid");
        assertEq(USDG.balanceOf(buyer), bond2.amount(), "the buyer lost nothing");
        assertEq(USDG.balanceOf(seller), sellerBefore);
        assertEq(POOL.ownerDefaults(seller), 1);
        assertEq(POOL.ownerDefaults(buyer), 0);
        console2.log("default marked, V2 slash took the SELLER's bond to the Safe:", bond2.amount());
        console2.log("   the buyer still holds its", USDG.balanceOf(buyer));
    }

    /// For reference, the live InviteBond on the live v4 line: the same buyer deposit goes through under the seller's
    /// open loan, refunds the seller, and the seller's default then takes the buyer's bond.
    function test_fork_5_liveInviteBond_acceptsTheBuyersDepositUnderTheSellersLoan() public onFork {
        (uint256 id, address seller) = _pick();
        _show(
            "== live InviteBond, live v4 line: the seller borrows, sells, the buyer bonds, the seller defaults",
            id,
            seller
        );
        vm.prank(seller);
        uint256 loan = POOL.borrow(id, 5 * U, 7 days, seller, type(uint256).max);
        _sell(id, seller);
        uint256 sellerBefore = USDG.balanceOf(seller);
        deal(address(USDG), buyer, BOND.amount());
        vm.startPrank(buyer);
        USDG.approve(address(BOND), BOND.amount());
        BOND.deposit(id);
        vm.stopPrank();
        assertEq(USDG.balanceOf(seller), sellerBefore + BOND.amount());
        console2.log(
            "live InviteBond: the buyer's deposit is ACCEPTED under the seller's open loan; seller refunded",
            BOND.amount()
        );
        vm.warp(POOL.getLoan(loan).defaultableAt + 1);
        POOL.markDefault(loan);
        BOND.slash(id);
        assertEq(USDG.balanceOf(buyer), 0, "the buyer's bond paid for the seller's default");
        console2.log("   the seller's default then slashed the BUYER's bond; buyer left with", USDG.balanceOf(buyer));
    }

    // ------------------------------------------------------------------
    // The raise to 25 reopened on v5 (2026-10-14): audit 2026-10-10 H1 and M6
    // ------------------------------------------------------------------

    /// The rules the Safe sets on v5 (docs/SECURITY-v2.md, TreasurySponsorV5): a first line of 5, the raise to 25 after three
    /// qualified loans, fourteen days and a score of 100.
    function _v5Rules() internal pure returns (TreasurySponsorV5.Rules memory r) {
        r = TreasurySponsorV5.Rules({
            reserveBps: 0,
            firstLine: 5 * U,
            secondLine: 25 * U,
            epochCap: 100 * U,
            epochLength: 7 days,
            minSeasoning: 14 days,
            minQualified: 3,
            minScore: 100,
            idleAfter: 30 days
        });
    }

    /// Three qualified loans of 5 USDG held 7 days each, the fee dealt to the owner.
    function _qualifyOnFork(address owner_, uint256 id) internal {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(owner_);
            uint256 loan = POOL.borrow(id, 5 * U, 7 days, owner_, type(uint256).max);
            vm.warp(vm.getBlockTimestamp() + 7 days); // not block.timestamp: via-IR keeps it across warps
            deal(address(USDG), owner_, USDG.balanceOf(owner_) + 1 * U);
            vm.startPrank(owner_);
            USDG.approve(address(POOL), type(uint256).max);
            POOL.repay(loan, id, type(uint256).max);
            vm.stopPrank();
        }
    }

    /// Criteria 1 and 5: a real agent on a live v4 line moves to v5 the way docs/PARTICIPATE-v2.md says (leave v4, its
    /// v1 bond back, a V2 bond, `move`: no invite, v4 lined it), builds the record, and anyone raises it to 25. The raise is charged
    /// to the raise budget, not the first lines' room, and the V2 bond stays on the raised line.
    function test_fork_6_v4AgentMoves_thenIsRaisedTo25() public onFork {
        vm.prank(SAFE);
        v5.setRules(_v5Rules());
        (uint256 id, address owner_) = _pick();
        _show("== an existing v4 agent moves to v5 and is raised to 25", id, owner_);

        vm.prank(owner_);
        POOL.leave(id);
        assertEq(POOL.getAgent(id).delegatedIn, 0, "1. left v4: no line");
        _bondV2(owner_, id);
        vm.etch(owner_, type(ForkConsent1271).runtimeCode); // the owner's consent, stood in for (fork only)
        CreditPoolV2.Consent memory c = _consent(id, owner_);
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotMovable.selector, id));
        v5.move(id, c, hex"01"); // the live v1 bond is still posted
        uint256 before = USDG.balanceOf(owner_);
        assertTrue(BOND.releasable(id), "2. the v1 bond comes back through its no-line path");
        BOND.release(id);
        assertEq(USDG.balanceOf(owner_), before + BOND.amount());
        console2.log("1-2. left v4; move refused while the v1 bond is posted; v1 bond back:", BOND.amount());

        uint256 room = v5.epochRoom();
        vm.prank(relayer);
        v5.move(id, c, hex"01");
        assertEq(POOL.getAgent(id).sponsor, root);
        assertEq(POOL.getAgent(id).delegatedIn, 5 * U, "3-4. a V2 bond, then move: a first line of 5 on v5, no invite");
        assertEq(v5.epochRoom(), room - 5 * U);
        console2.log("3-4. V2 bond posted, v5.move(id): line", POOL.getAgent(id).delegatedIn);

        _qualifyOnFork(owner_, id);
        CreditPoolV2.Agent memory a = POOL.getAgent(id);
        console2.log("5. record on v5: qualified", a.qualifiedRepaid, "score", v5.score(id));
        assertTrue(v5.eligibleForRaise(id), "three qualified loans, seasoned, score 100");

        room = v5.epochRoom();
        uint256 raiseRoom = v5.raiseRoom();
        vm.prank(relayer);
        v5.raise(id);
        assertEq(POOL.getAgent(id).delegatedIn, 25 * U, "6. raised to 25 on v5");
        assertEq(v5.raiseRoom(), raiseRoom - 20 * U, "the top-up is charged to the raise budget");
        assertEq(v5.epochRoom(), room, "the first lines' room is untouched (M6)");
        assertFalse(bond2.releasable(id), "the V2 bond stays on the raised line (H1)");
        console2.log("6. raise(id) by anyone: line", POOL.getAgent(id).delegatedIn, "raiseRoom left", v5.raiseRoom());

        vm.prank(owner_);
        uint256 loan = POOL.borrow(id, 25 * U, 7 days, owner_, type(uint256).max);
        assertEq(POOL.getLoan(loan).sponsorId, root, "the raised line is usable");
    }

    /// Criterion 3: nothing here touches v4's rules, so InviteBond (v1) keeps its qualified path closed. No v1 bond on
    /// an open line is releasable, and three qualified loans on a live v4 line do not make one releasable.
    function test_fork_7_v1BondsStayCovered_qualifiedPathClosed() public onFork {
        vm.prank(SAFE);
        v5.setRules(_v5Rules());
        (,,,,,, uint256 minQualified,,) = V4.rules();
        assertEq(minQualified, 1_000_000, "v4's bar stays out of reach");
        uint256[] memory ids = BOND.activeIds(0, BOND.activeCount());
        uint256 lined;
        for (uint256 i = 0; i < ids.length; i++) {
            if (POOL.getAgent(ids[i]).delegatedIn == 0) continue;
            lined++;
            assertFalse(BOND.releasable(ids[i]), "a v1 bond on an open line");
        }
        console2.log("v1 bonds", ids.length, "on an open line, none releasable:", lined);

        (uint256 id, address owner_) = _pick();
        _qualifyOnFork(owner_, id);
        assertGe(POOL.getAgent(id).qualifiedRepaid - BOND.bonds(id).qualifiedAt, 3);
        assertFalse(BOND.releasable(id), "three qualified loans on the v4 line: the v1 bond stays");
        console2.log("agent", id, "three qualified loans on v4, v1 bond releasable:", BOND.releasable(id));
    }
}
