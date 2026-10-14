// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditPoolV2} from "../src/CreditPoolV2.sol";
import {TreasurySponsorV4} from "../src/TreasurySponsorV4.sol";
import {TreasurySponsorV5} from "../src/TreasurySponsorV5.sol";
import {InviteBond} from "../src/InviteBond.sol";
import {InviteBondV2} from "../src/InviteBondV2.sol";
import {ForkConsent1271, IForkRegistryV5} from "./TreasurySponsorV5Fork.t.sol";

/// @title The deployed TreasurySponsorV5 and InviteBondV2 (2026-10-14), against live state on a local fork.
/// @notice A forge test, not a script: it never broadcasts, and it runs only with FORK_RPC on 127.0.0.1 or localhost:
///           anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8563 &
///           FORK_RPC=http://127.0.0.1:8563 FOUNDRY_PROFILE=v5 forge test --match-path test/TreasurySponsorV5Live.t.sol -vv
///         A real bonded agent on a live v4 line takes the path docs/AGENTS.md gives (leave v4, the v1 bond back,
///         a V2 bond, `move`), builds the record on its v5 line, and anyone raises it to $25 on the deployed v5.
contract TreasurySponsorV5LiveForkTest is Test {
    CreditPoolV2 constant POOL = CreditPoolV2(0x281210097f0de7A8FB6F87310AF0f089c9C8DE21);
    TreasurySponsorV4 constant V4 = TreasurySponsorV4(payable(0x0c5091235A25bBFD3F5a009cBe04120D0CBAD573));
    InviteBond constant BOND = InviteBond(0x8BE478c754D9124D11e78dB20F5bf4dA45403275);
    TreasurySponsorV5 constant V5 = TreasurySponsorV5(payable(0xFe8fdf43c4b0443aCF8E8CD8facD62F1B770e267));
    InviteBondV2 constant BOND2 = InviteBondV2(0x346d3360B7258a18E8a2a55fe20E0F467113a53A);
    IForkRegistryV5 constant REG = IForkRegistryV5(0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    uint256 constant V4_ROOT = 6228;
    uint256 constant U = 1e6;

    bool forked;
    address relayer = makeAddr("relayer");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        bytes memory u = bytes(rpc);
        bytes memory a = bytes("http://127.0.0.1:");
        bytes memory b = bytes("http://localhost:");
        bool local = true;
        for (uint256 i = 0; i < a.length && local; i++) {
            local = u.length >= a.length && u[i] == a[i];
        }
        if (!local) {
            local = true;
            for (uint256 i = 0; i < b.length && local; i++) {
                local = u.length >= b.length && u[i] == b[i];
            }
        }
        require(local, "FORK_RPC must be a local anvil fork");
        vm.createSelectFork(rpc);
        forked = true;
        assertEq(block.chainid, 4663);
    }

    /// The first live bonded agent whose bond its owner posted, on an open v4 line with no loan open, an EOA owner with
    /// no default. FORK_AGENT overrides the choice.
    function _pick() internal view returns (uint256 id, address owner_) {
        uint256 forcedId = vm.envOr("FORK_AGENT", uint256(0));
        uint256[] memory ids = BOND.activeIds(0, BOND.activeCount());
        for (uint256 i = 0; i < ids.length; i++) {
            id = ids[i];
            if (forcedId != 0 && id != forcedId) continue;
            owner_ = REG.ownerOf(id);
            CreditPoolV2.Agent memory ag = POOL.getAgent(id);
            if (BOND.bonds(id).depositor != owner_ || owner_.code.length != 0 || POOL.ownerDefaults(owner_) != 0) {
                continue;
            }
            if (ag.defaulted || ag.frozen || ag.activeLoans != 0 || ag.sponsor != V4_ROOT) continue;
            return (id, owner_);
        }
        revert("no live bonded agent fits; set FORK_AGENT");
    }

    function test_live_v4AgentMoves_thenIsRaisedTo25OnTheDeployedV5() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        (,, uint256 secondLine,,,, uint256 minQualified,,) = V5.rules();
        assertEq(secondLine, 25 * U, "the deployed v5 raises to 25");
        assertEq(minQualified, 3);
        (,,,,,, uint256 v4Bar,,) = V4.rules();
        assertEq(v4Bar, 1_000_000, "v4's bar unchanged");
        (uint256 id, address owner_) = _pick();
        console2.log("agent", id, "owner", owner_);

        // 1-2. leave v4; move is refused while the v1 bond is posted; the v1 bond comes back
        vm.prank(owner_);
        POOL.leave(id);
        deal(address(USDG), owner_, USDG.balanceOf(owner_) + BOND2.amount());
        vm.startPrank(owner_);
        USDG.approve(address(BOND2), BOND2.amount());
        BOND2.deposit(id); // 3. the V2 bond: no sponsor now
        vm.stopPrank();
        vm.etch(owner_, type(ForkConsent1271).runtimeCode); // the owner's consent, stood in for (fork only)
        CreditPoolV2.Consent memory c = CreditPoolV2.Consent({
            agentId: id,
            sponsorId: V5.agentId(),
            owner: owner_,
            maxPremiumBps: 0,
            nonce: POOL.nonces(id),
            deadline: block.timestamp + 1 hours
        });
        vm.expectRevert(abi.encodeWithSelector(TreasurySponsorV5.NotMovable.selector, id));
        V5.move(id, c, hex"01");
        BOND.release(id);
        assertFalse(BOND.isBonded(id));

        // 4. move: a $5 line on the deployed v5, charged to its first-line room
        uint256 room = V5.epochRoom();
        vm.prank(relayer);
        V5.move(id, c, hex"01");
        assertEq(POOL.getAgent(id).sponsor, V5.agentId());
        assertEq(POOL.getAgent(id).delegatedIn, 5 * U);
        assertEq(V5.epochRoom(), room - 5 * U);
        console2.log("moved: line on v5", POOL.getAgent(id).delegatedIn);

        // the record: three qualified loans of 5 USDG held 7 days on the v5 line
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(owner_);
            uint256 loan = POOL.borrow(id, 5 * U, 7 days, owner_, type(uint256).max);
            vm.warp(vm.getBlockTimestamp() + 7 days);
            deal(address(USDG), owner_, USDG.balanceOf(owner_) + 1 * U);
            vm.startPrank(owner_);
            USDG.approve(address(POOL), type(uint256).max);
            POOL.repay(loan, id, type(uint256).max);
            vm.stopPrank();
        }
        console2.log("record: qualified", POOL.getAgent(id).qualifiedRepaid, "score", V5.score(id));
        assertTrue(V5.eligibleForRaise(id));

        // 5. anyone raises it: $25, out of the raise budget, the first lines' room untouched, the bond still there
        room = V5.epochRoom();
        uint256 raiseRoom = V5.raiseRoom();
        vm.prank(relayer);
        V5.raise(id);
        assertEq(POOL.getAgent(id).delegatedIn, 25 * U, "raised to 25 on the deployed v5");
        assertEq(V5.raiseRoom(), raiseRoom - 20 * U);
        assertEq(V5.epochRoom(), room);
        assertTrue(BOND2.isBonded(id) && !BOND2.releasable(id), "the V2 bond stays on the raised line");
        console2.log("raised: line", POOL.getAgent(id).delegatedIn, "raiseRoom left", V5.raiseRoom());
        vm.prank(owner_);
        uint256 big = POOL.borrow(id, 25 * U, 7 days, owner_, type(uint256).max);
        assertEq(POOL.getLoan(big).sponsorId, V5.agentId(), "the raised line is usable");
    }
}
