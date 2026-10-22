# Deployment records

One JSON file per chain and pool generation: `<chainId>.json` for v1, written by `script/Deploy.s.sol`, and
`<chainId>.v2.json` for v2, written by `script/DeployV2.s.sol`. Every tool in this repo — the CLIs, the SDK's
`env.mjs`, the quickstart — reads the file matching the chain it is connected to, so a deployment becomes usable
the moment its record lands here. The v1 shape:

```json
{
  "chainId": 31337,
  "deployBlock": 1,
  "creditPool": "0x…",
  "treasurySponsor": "0x…",
  "treasuryAgentId": 1,
  "registry": "0x…",
  "usdc": "0x…",
  "usdcIsMock": true,
  "reserveFunder": "0x…",
  "owner": "0x…"
}
```

## What is here

`4663.v2.json` — **Robinhood Chain mainnet, v2, live.** Written in the shape `script/DeployV2.s.sol` produces
(`pool`, `lens`, `timelock`, `treasuryV4`, `seatVault`, `usdg`, `registry`, `priors`, `safe`, `v1`, `deployBlock`),
plus the two roots' agent ids (`treasuryV4AgentId` 6228, `seatVaultAgentId` 6234), `inviteBond` (since block
`inviteBondBlock` 72,112,874), the retired
`seatVaultV2` (root `seatVaultV2AgentId` 6229), `v1Pool` and `"status": "live"`. `seatVault` is SeatVaultV3 since
2026-09-25 (block `seatVaultBlock` 72,192,188). `seatSizer` (since block 72,572,884) owns the seat vault and keeps
its seat at about 5 lines of $PRIORS;
the Safe owns it. `stockVault` (root `stockVaultAgentId` 6424, since block `stockVaultBlock` 74,826,641) is the stock
vault: the proxy address, the one to call and the one that holds the tokens; its implementation and ProxyAdmin are in
the README's address table. `seatVaultV4` (root `seatVaultV4AgentId` 6466, since block `seatVaultV4Block`
75,614,831) is the growth seat vault, SeatVaultV4: live since 2026-09-29. `seatSizerV4` (since
block `seatSizerV4Block` 75,614,955) is its own SeatSizer, which owns it; the Safe owns the sizer. `seatVault` stays
SeatVaultV3. The six protocol contracts live since 2026-10-04 (sources in `src/`, in the bounty scope): `poolSteward`
(PoolSteward, the pool's owner since 2026-10-06, behind the timelock: a 48 h delay, none from 2026-10-11
19:49 UTC), `revenueRouter` (RevenueRouter, the fee
sinks' and the steward's sweep destination), `buyAndBack` (BuyAndBack), `priorsLiquidity` (PriorsLiquidity),
`swapLimiter` (SwapLimiter, the depth guard the engines read) and `keeperHelper` (KeeperHelper, SeatSizerV4's keeper
since 2026-10-06). `seatVaultV5` (root `seatVaultV5AgentId` 8762, `seatVaultV5Block` 85,924,243) is SeatVaultV5, live
since 2026-10-11 with owner-only backing; it replaced the deployment of 2026-10-09
(`0xdE29D3A627d77CFA13c5331C1B7B181a4C5B752E`, root 8641, block 84,306,464), which is retired and not in the record.
`npx priors-v2` and `resolveV2()` in `sdk/env.mjs` read it (the SDK's stock-line calls use `stockVault`
from it; `priors-v2 join --seat` takes a staker's offer on `seatVaultV4` first, else on `seatVault`; `borrow` and `pay`
on a line V5 sponsors take V5's step before the borrow, from `seatVaultV5` and `seatVaultV5AgentId`);
`PRIORS_ADDRESSES` points them at another file; on a real chain a file whose addresses differ from the published record
is refused unless `PRIORS_ALLOW_CUSTOM_ADDRESSES=1` is exported in the shell (a `.env` cannot set it). The same opt-in
governs the v1 tools' `POOL`, `TREASURY` and `USDC` overrides on a real chain. `autoRepay` (since block
`autoRepayBlock` 92,968,789, 2026-10-20) is AutoRepay v2, the contract Autopay approves and enrolls with
(`@priors/mcp`'s `autopay_on`, whose `PRIORS_AUTOREPAY` defaults to it); its source is not in this repository.

```json
{
  "chainId": 4663,
  "status": "live",
  "deployBlock": 71702460,
  "pool": "0x281210097f0de7A8FB6F87310AF0f089c9C8DE21",
  "lens": "0x9d7035722bd42C551f82FEB9FDDd17453AEF3D9B",
  "timelock": "0x5d984C274035F81BB327d532897a902C5125F87c",
  "treasuryV4": "0x0c5091235A25bBFD3F5a009cBe04120D0CBAD573",
  "seatVault": "0x59D155C42A9263fA7596867b992bB3e84dF680a9",
  "inviteBond": "0x8BE478c754D9124D11e78dB20F5bf4dA45403275",
  "…": "…"
}
```

`stock-assets.4663.json` — the 35 Robinhood stock tokens the stock vault accepts, each with its Chainlink feed
(address, decimals, heartbeat), from Robinhood's token list and Chainlink's feed list (both named in its `sources`).
`sdk/stock-vault.mjs` and `@priors/mcp` (a copy in `packages/mcp/deployments/`) read it for symbols and feeds.
`stock-ltv.4663.json` — each token's loan-to-value and the record bonus, as set on the vault at deployment. The
owner can change both on chain (`setAsset`, `setRecordBonus`); if this file and the vault disagree, the vault is
right.

`4663.json` — **Robinhood Chain mainnet, v1, paused.** The v1 CreditPool, TreasurySponsor v3 (ERC-8004 identity
`#486`), the ReserveFunder, and the block the pool was deployed at. It carries `"status": "paused"` and
`"supersededBy": "4663.v2.json"`: the v1 tools still resolve it so v1 history stays readable, and
`npx priors doctor` says the pool is paused and points at v2. New lines and loans on it revert.

`npx priors doctor` (v1) tells you what it resolved for the chain you are pointed at. It and `npx priors-v2 status`
(v2, which needs `PRIORS_KEY` and prints the agent's line and loans, not the addresses) say so rather than guessing
when there is no record.

`31337.json` — the local dev chain — is written by `npm run devnet` and deliberately gitignored: it is a
throwaway chain whose addresses mean nothing to anyone else.

A deployment becomes usable the moment its record is committed here; no further configuration is needed.
For v1, `POOL` and `TREASURY` in `.env` override the record, which is how you point the tools at an address that has
not been committed yet.
