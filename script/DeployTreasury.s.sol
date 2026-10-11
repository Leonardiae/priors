// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CreditPool} from "../src/CreditPool.sol";
import {TreasurySponsor} from "../src/TreasurySponsor.sol";
import {IPonsFeeEscrow, IPonsFactoryCreator} from "../src/interfaces/IPonsFeeEscrow.sol";

/// @notice Deploys a new TreasurySponsor against an existing CreditPool. Used when the treasury's rules change
///         (owner-only first lines, idle-line reclaim) and the pool does not: the old treasury keeps sponsoring
///         the agents it already lined, the new one seats everyone after it.
///
///   POOL=0x...             the live CreditPool (required)
///   OWNER=0x...            treasury owner, defaults to the broadcaster (use the pool's Safe)
///   FEE_SINK=0x...         fee wallet for the treasury's 25% sponsor cut, defaults to OWNER
///   INVITER=0x...          key whose signed invites seat agents (the invite script signs with it)
///   PONS_FEE_ESCROW=0x...  and PONS_FACTORY=0x...  Pons wiring; zero on chains without Pons
///
/// Writes deployments/<chainId>.treasury.json; merge it into deployments/<chainId>.json once the identity is
/// adopted (LAUNCH.txt, "TREASURY V2").
contract DeployTreasury is Script {
    function run() external {
        CreditPool pool = CreditPool(vm.envAddress("POOL"));
        address owner = vm.envOr("OWNER", address(0));
        address ponsEscrow = vm.envOr("PONS_FEE_ESCROW", address(0));
        address ponsFactory = vm.envOr("PONS_FACTORY", address(0));

        vm.startBroadcast();
        if (owner == address(0)) owner = msg.sender;
        TreasurySponsor treasury = new TreasurySponsor(
            pool, IPonsFeeEscrow(ponsEscrow), IPonsFactoryCreator(ponsFactory), owner, vm.envOr("FEE_SINK", owner)
        );
        address inviter = vm.envOr("INVITER", address(0));
        // the deployer is the owner only while it is also the broadcaster; otherwise the Safe names the inviter
        if (inviter != address(0) && owner == msg.sender) treasury.setInviter(inviter, true);
        vm.stopBroadcast();
        if (inviter != address(0) && owner != msg.sender) console.log("owner must call setInviter:", inviter);

        console.log("TreasurySponsor v2:", address(treasury));
        console.log("pool:", address(pool));
        console.log("owner:", owner);
        console.log("next: register an ERC-8004 identity, transfer it to the treasury, adopt(id), fund, sweep()");

        string memory json = "treasury";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "deployBlock", block.number);
        vm.serializeAddress(json, "creditPool", address(pool));
        vm.serializeAddress(json, "owner", owner);
        vm.serializeUint(json, "treasuryAgentId", 0);
        string memory out = vm.serializeAddress(json, "treasurySponsor", address(treasury));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".treasury.json");
        vm.writeJson(out, path);
        console.log("wrote", path);
    }
}
