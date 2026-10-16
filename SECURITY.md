# Security

This pool lends real money to agents with no collateral. A bug here costs lenders their deposits, so a
report is welcome even if you are not sure it is exploitable.

## Reporting

**Use GitHub's private vulnerability reporting** — the *Report a vulnerability* button under this repo's
**Security** tab. It is private, it timestamps your report, and it keeps the thread in one place.

You can also write to **contact@priors.trade**; say in the subject that it is a security report.

If neither is available to you, open a public issue that says only that you have something and asks for a
channel. **Do not put details in a public issue.** We will answer with somewhere private to send them.

## What makes a report actionable

You do not need to write a report before you hear from us. But the more of this you can say up front,
the faster it moves — and none of it requires exposing an exploit:

- **Which function**, in which contract, at which address or commit.
- **What an attacker gets**: whose money, how much, under what preconditions.
- **A test or a trace.** This repo is Foundry — a failing `forge test` against `src/` is the clearest
  thing you can send. A fork PoC is just as good.
- **Whether it applies to the live deployment** or only to an older one.

If you would rather not share specifics before agreeing terms, we understand — but please at least name
the affected function and your own severity assessment. We cannot evaluate, prioritise, or credit
"a few real issues" with no category attached.

## What we commit to

- An acknowledgement within **3 working days**.
- An assessment — confirmed, not reproducible, or out of scope, with reasoning — within **14 days**.
- Credit in the fix commit and release notes, under whatever name or handle you choose, unless you ask
  us not to.
- We will tell you plainly if we think you are wrong, and why. We would rather argue than go quiet.

## Scope

**In scope**

| | |
|---|---|
| `src/CreditPoolV2.sol`, `src/libraries/PoolV2Lib.sol` | the v2 pool: lenders, roots and backing, consent, handoff, fee lock, defaults, the reserve |
| `src/CreditLensV2.sol` | the score and credit-report views |
| `src/TreasurySponsorV4.sol` | the rule-based treasury root: invites, raises, reclaims, sweeps |
| `src/SeatVaultV3.sol` | $PRIORS seats: offers, acceptance, owner binding, freeze, burns, fees, expiry (SeatVaultV2 is retired) |
| `src/SeatVaultV4.sol` | the growth seat vault (live since 2026-09-29): V3's seats plus the slash split, protocol seats and their eligibility, and the loan-term cap |
| `src/SeatSizer.sol` | the owner of each seat vault (one for V3, one for V4): price observations, resizing within bounds, the Safe's `execute` |
| `src/InviteBond.sol` | the 5 USDG bond behind an automatic treasury invite |
| `src/StockVault.sol`, `src/StockVaultProxy.sol` | the stock vault (live since 2026-09-28): positions, prices and lending holds, lines and their loan-to-value, seizure, the owner's bounded powers; upgradeable only through the timelock, which owns its ProxyAdmin since 2026-10-07 (the Safe did before; a 48 h delay, none from 2026-10-11 19:49 UTC) |
| `src/PoolSteward.sol` | the pool's owner since 2026-10-06: decodes every owner call from the timelock (a 48 h delay, none from 2026-10-11 19:49 UTC) against its fixed policy (fee split bounds, the reserve's hard floor), the public handback, and the daily `sweep()` anyone can call |
| `src/RevenueRouter.sol` | where the steward's sweep and the seat and stock vaults' fees go, and how it splits them |
| `src/BuyAndBack.sol`, `src/PriorsLiquidity.sol` | the two engines the router funds: buying $PRIORS on its Pons pool, and its liquidity |
| `src/SwapLimiter.sol`, `src/libraries/PoolDepth.sol`, `src/libraries/EngineMath.sol` | the depth guard on every engine swap, and the math both engines use |
| `src/KeeperHelper.sol`, `src/GuardianPause.sol` | the keeper's one entry point (SeatSizerV4's price and the limiter's depth snapshot), and the guardian pause the engines share |
| `src/SeatVaultV5.sol`, `src/v5/` | SeatVaultV5 (live since 2026-10-09, owner-only backing) and its nine linked libraries: books opened with the agent owner's own $PRIORS, the burn on default, the backing layers, fees, the exit queue, the breaker and the guardian pause |
| `sdk/`, `bin/` | the SDK, the x402 float client and the CLIs, including anything that could sign or broadcast wrongly |
| `packages/x402`, `packages/mcp` | the npm payer (`@priors/x402`) and the local MCP server (`@priors/mcp`), including anything that could pay, borrow or repay wrongly |
| The live v2 deployment | addresses are in `deployments/4663.v2.json` and the README's *Robinhood Chain* table |
| `priors.trade` and `facilitator.priors.trade` | the site and the x402 facilitator (including its merchant sign-up at `x402.priors.trade/merchants`) are in scope even though their source is not in this repo |
| `mcp.priors.trade` | the hosted MCP server: read-only and holds no key, so a way to make it sign, send, or leak a secret is a finding |
| `api.priors.trade` | the paid x402 API |
| The Telegram invite bot (`@priors_agents_bot`) | public credit only, no payout, whatever the severity ([BOUNTY.md](BOUNTY.md)) |

**Out of scope**

- **The v1 contracts** (`CreditPool`, `TreasurySponsor` v2/v3, `ReserveFunder`), including the v1 pool at
  `0x0259889e6EBab1a18CeE7e62Bc5B9648FB6C44e5`, paused since the v2 cutover, and the older pools before it.
  They are kept in this repo and in the README as history. Findings against them are interesting only where
  they also apply to v2 — say so explicitly if they do.
- USDG (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`), the $PRIORS token
  (`0xeDBf91223639800BCd5756815CAf908Df3b890bE`) and the ERC-8004 identity registry at
  `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. Not ours; how our contracts handle them is in scope.
- The Robinhood stock tokens, their issuer's powers (pause, block, burn, upgrade) and Chainlink's price feeds. Not
  ours; how the stock vault copes with them is in scope.
- Third-party RPC endpoints. Their rate limits and archive policies are their business; how this SDK
  copes with them is ours, and that part is in scope.
- Anything requiring a compromised owner key, a malicious chain reorg beyond finality, or control of the
  Safe. Key handling itself is in scope; assuming the keys are already stolen is not.
- Gas optimisation, style, and "best practice" with no exploit path. Send those as ordinary issues.

## Already known, already fixed

So nobody spends time on ground that is already covered, and so a rediscovery is not mistaken for a new
finding:

**v2:** [`docs/SECURITY-v2.md`](docs/SECURITY-v2.md) lists every finding from the pre- and post-launch reviews of the v2
set, with its severity, its fix or its accepted residual, and the test that shows it. In short: the self-backing
yield loop (N-1) is fixed by the fee lock, with one residual path around it (SO-1, holding stake only while
marking a default; yield only); the utilization freeze (N-2) by a 100% cap; the farmable keeper bounty
(F-1) is mitigated by setting it to 0; the seat vault's stale offers (X-1) and idle seats (X-2) are fixed; the
self-seat loop (X-3) is gated by repaid history and closed economically by the seat's market value; the treasury's
invite-to-raise path (T10) is bounded by its epoch cap. The growth seat vault's two internal reviews (protocol-seat
farming H-1, eligibility bound to the owner the Safe vetted R2-1, and the rest) were fixed before it was deployed.
None of these reaches lender principal.

**v1** (now paused; kept for the record):

- **A defaulting root sponsor's earned credit was not retired**, letting backing be counted twice and
  leaving lenders exposed. Fixed in the live pool. The proof-of-concept is committed as a permanent
  regression guard in `test/ReviewPoC_RootEarnedDoubleSpend.t.sol`, so you can read exactly what it was
  and confirm it is closed.
- **A parameter-only mitigation for that same issue** is documented and tested in
  `test/BetaMitigationMinStake.t.sol`: raising `minStake` beyond an attacker's budget closes the only
  door into rootness without a redeploy. It is kept because it is the lever available in a hurry.
- **A dead root sponsor's stake was not charged for a defaulted child**, so the first-loss reserve paid
  instead and lender principal was destroyed. `markDefault` left the sponsor liable for nothing once it
  was already defaulted itself. Fixed: liability is now `!s.defaulted || (s.isRoot && s.stake > 0)`.
  Pinned by `test_aDeadRootsEarmarkedStakeIsSlashedForItsChild` and
  `test_withAnEmptyReserveTheDeadRootsStakeStillProtectsLenders` in `test/SponsorLiability.t.sol`.
- **The same defect had a second door, in `vouch`.** A dead sponsor's child could be taken over with a
  dust vouch, and the takeover branch zeroed `delegatedIn` while the child's loan was still drawn —
  collapsing a stake-backed claim to dust just before the default, which is strictly worse than the first
  path. Fixed with a `principalOut == 0` gate on takeover; an orphan with a live loan now waits for that
  loan to close. Pinned by `test_aTakeoverCannotVoidBackingForADrawnLoan`, and by
  `invariant_exposureWithinCapacity`, which is what caught it at depth 400 after the first fix looked
  complete.
- **A sponsor could withdraw delegation that was underwriting a live loan.** `unvouch` is now bounded by
  `delegatedIn - principalOut`. Pinned by `test_unvouchCannotReleaseDelegationBackingALiveLoan`.
- **A defaulted root's residual stake was stranded forever**, because `_capacity` returns 0 for a
  defaulted agent and `withdrawStake` measured against it. A settled defaulted agent that owes nothing
  and backs nothing can now recover it. Pinned by
  `test_aSettledDefaultedRootCanRecoverItsResidualStake` and its negative case.

All four were live on v1 as of the 2026-09-21 cutover. Because these contracts are not upgradeable, "fixed in
`src/`" and "fixed on chain" are different claims with a migration between them, and for about ten hours
they were not the same thing here — see **Credits**. `scripts/verify-migration.mjs` checks the deployed v1
runtime bytecode against the compiled artifact, so you can confirm which one you are looking at rather
than trusting this file. It does not read the v2 record: for v2, compare each address in
`deployments/4663.v2.json` against `forge build` output the same way (immutables and the `PoolV2Lib` link
zeroed, metadata stripped). The v2 set matched on 2026-09-25; `seatVaultV4` and `seatSizerV4` matched on
2026-09-29, and so did V3's `seatSizer`. For the stock vault the record holds the proxy (`StockVaultProxy`): what
matches `forge build` of `src/StockVault.sol` is the implementation behind it (its ERC-1967 implementation slot):
`0x02f0bF6259bDFef1Dad13D63b6D684c98596af5d` since the upgrade of 2026-10-13 (the fair default, SV-11), whose code matches the build (checked 2026-10-16; before it, `0x796FCcBdab6d473Ab22728D246AcAea0905b8E0B` from the upgrade of 2026-10-11 (SV-17), which matched the build the day it was deployed; `0x737b015244C2115E774FABda72325C719b997d7C` from the upgrade of 2026-10-10, deployed on 2026-10-08; `0xAe8f0A34A0bEf514D61132726bCF6a78960672a4` from the upgrade of 2026-10-10; `0xC16f7230b79Fb7dB3b1761A23e9d56365300B2A4` from the upgrade of 2026-10-04, which matched on 2026-10-07;
`0x32F1c32A8bdDCd72B18A4f97dc815F50099ad0A5` from the upgrade of 2026-10-01, matched that day;
`0x8Be04c08De0158c88F84875DAe181054c30734fA` matched on 2026-09-30 and the first one,
`0xF781b2634254d7819E9E17BfFc9D18C54C32008b`, on 2026-09-29). The six protocol contracts (`poolSteward`,
`revenueRouter`, `buyAndBack`, `priorsLiquidity`, `swapLimiter`, `keeperHelper` in the record) matched `forge build`
of `src/` on 2026-10-07, immutables masked and the metadata hash included. `seatVaultV5` and its nine linked libraries
(their addresses in the README's table) matched `forge build` of `src/` on 2026-10-09, with the library links filled in,
immutables and each library's own address masked, and the metadata hash included.

An independent rediscovery of a fixed issue is still worth telling us about, and we will say so and
credit the work. It is not a new finding.

## Credits

People who have found something real, or told us something we needed to hear.

- **llen** (`@yossweh`) — GHSA-4j38-23rc-qmv9, 2026-09-20. Reported that the dead-root accounting defect
  and its `vouch` takeover variant were still present in the **deployed** bytecode, with two
  proof-of-concepts executed against the live contract and the live USDG at a fork anchor. We had found
  and fixed both in `src/` about an hour earlier — the advisory cites our own `d2f0019` and `fb1a0e5` as
  the patched versions — so this was not a new defect. It was something more useful and easier to miss: a
  published fix is not a deployed fix, and for ten hours the live pool ran pre-fix code with real deposits
  behind it while the repository looked patched. The report is the reason the cutover was not left to
  drift. Also correctly flagged that `deposit` reverts `ZeroAmount` for an amount smaller than one share
  once the share price passes 1:1 (see below), and proposed a stronger invariant than the two we had:
  assert that a defaulted root's stake is either charged or explicitly released, never left where
  `withdrawStake` reverts forever.
- **The private reports of 2026-09-23 to 2026-09-29**: 38 GitHub advisories and one email, each answered, and
  listed by row in [docs/SECURITY-v2.md](docs/SECURITY-v2.md) ("Private reports"). First reports: `@sands786`
  (P-10, O-1), `@sebattoriq` (F4), `@andelaiceee-code` (F5), `@Fdxyz` (F6), `@brianyazzz` (F7, O-3), `@xShadowxIQ`
  (P-11), `@johndastech-glitch` (P-12, C-1), `@0ex-NightFall` (P-13), `@xbyteid` (C-2), `@mmasyoga0` (FAC-1),
  `@daffhaidar` (IB-2), `@Muhamadluis` (O-2) and `@Firlinata` (S-1); Gerald Gerald reported P-12 by email the same
  day. Later reports of the same causes: `@islaintent`, `@Godswork4`, `@dimazz12`, `@clementnaomi064-spec`,
  `@Sangmadun`, `@JasmeJun`, `@ginan15`, `@ashraf9191` and `@rabbinik`.
- **The reports of 2026-09-29 and 2026-09-30**: `@Zhhns12` (SV-13) and `@byfor8` (SV-14, and SV-13 the same
  night) on the stock vault: a deposit made after an issuer burn paid the earlier positions, and a line could be
  drawn past the loan-to-value of what was left, fixed by an upgrade before any stock was deposited. `@byfor8` (P-14,
  also `@fandiyana`) and `@sebattoriq` (P-15) on `pay_url`'s guard, fixed in 0.2.3.

**Not fixed, deliberately:** the `ZeroAmount` revert on a sub-share deposit. `convertToShares` rounds
down, in the pool's favour, which is the correct direction for an ERC-4626-style vault; the effect is that
the smallest depositable amount becomes one share's worth rather than one unit. It cannot be aimed at a
third party and it costs nothing but a retry, so it stays. Reported for completeness and recorded here so
it is not re-reported as new.

## Rewards

**There is a bounty programme now: [BOUNTY.md](BOUNTY.md).** It says what each severity is worth, which
addresses are in scope, and what is explicitly not.

This page used to say there was no programme and nothing was promised. That was the honest position while
nothing was funded; it is no longer the position. Two things carried over from it unchanged, because they
were right: the ceiling is small and stated in public rather than implied, and a report still gets a
straight answer, a fix, and public credit whether or not it pays. Do not make disclosure conditional on a
figure we have not agreed to — we will decline, and fix it anyway.

## Please test on a fork

The live v2 pool holds real deposits. Reproduce against a local Anvil fork or a testnet deployment, never
against mainnet:

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com
```

We will not pursue anyone for good-faith research that stays within this scope, tests on a fork, avoids
touching other people's funds or data, and gives us a reasonable chance to fix things before going
public. Draining the live pool to prove a point is not good-faith research.

## One thing worth knowing before you report

**Our own contracts are not upgradeable, except the stock vault.** No proxy, no initialiser, no admin hatch in
anything under `src/` but `StockVault` (since 2026-09-28), which sits behind a Transparent proxy
(`StockVaultProxy`) whose ProxyAdmin the timelock owns since 2026-10-07 (the 2-of-3 Safe did before): a bug
there can be fixed by an upgrade the Safe schedules on the timelock, which runs 48 hours later at the earliest until
2026-10-11 19:49 UTC and, from then, the moment the Safe sends it (the timelock has no delay from then, below). An
upgrade could also move what the vault holds ([docs/SECURITY-v2.md](docs/SECURITY-v2.md), "StockVault").
Everywhere else, fixing a real bug means deploying a new pool and migrating state, which has been done more than
once (on v1, then from v1 to v2) and is not cheap — so a confirmed finding may take longer to close than a
proxy-based protocol would need. The delay is the architecture, not us ignoring you.

**The identity registry we depend on is a different story, and an earlier version of this file was
misleading about it.** `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` is not ours and it is **not
immutable**: 130 bytes of code, an EIP-1967 implementation pointer, an empty admin slot — a UUPS proxy —
and `owner()` is `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`, an address with **no code at all**. A
single ordinary key can change what that registry says about who owns which agent, and this pool
believes the registry completely. Whoever holds it could withdraw every root's stake, draw every open
credit line, and claim every unclaimed sponsor fee. On v2 that is still true of roots' stake and open lines,
while lenders' deposits stay whole (`test_X5_registryUpgradeAdminTakesEveryRootStake`).

Findings *in* that registry are out of scope because we cannot fix them. Findings about **how this pool
trusts it** are very much in scope, and we would rather hear them.

The levers we do hold, and how fast they move:

- **Fast:** the pool's guardian (the 2-of-3 Safe) can `pause` new risk for at most 14 days at a time; exits
  never pause. The Safe owns treasury v4 (`setRules`, `setInviter`, `freeze`, `retire`) directly, and each seat
  vault, V3 and the growth vault V4, through the SeatSizer that owns it (`execute`: `setParams`, `setGates`,
  `pauseSeats`, `freezeSeat`, `retire`), so those need two signatures and no delay. The same
  goes for the stock vault's settings (`setAsset`, `setParams`, `pause`, `freezePosition`, `writeOff`, `retire`), but
  not its code: its ProxyAdmin (`upgradeAndCall`) is the timelock's since 2026-10-07, which has no delay either from
  2026-10-11 19:49 UTC (next point). Treasury v4 caps new lines at $100
  a week (`rules().epochCap`) and is topped up by hand by the Safe; the token's creator fees are not routed to it.
- **Through the timelock, slow until 2026-10-11 19:49 UTC, then not:** the pool's owner is the `PoolSteward`
  (since 2026-10-06), which only the `TimelockController` can call (the Safe proposes and executes, no admin).
  Until 2026-10-11 19:49 UTC the timelock's delay is 48 hours: `setParams`, `withdrawReserve` and the other owner calls
  are visible on chain for two days before they can run, and operations already scheduled keep their ready times. On
  2026-10-09 the owner decided to drop the delay: the Safe scheduled `updateDelay(0)` on the timelock (tx
  `0x2095a36a5c0897dac7e21c780216318386fed8d8bbea35aad80b29eeb369bf1b`, block 84,415,642), executable from
  2026-10-11 19:49:05 UTC. From then the Safe can schedule and execute in the same block: every operation is still
  public on chain (`CallScheduled`, `CallExecuted`), but there is no window to react before it runs. Whatever the
  delay, the steward refuses a fee split or a reserve withdrawal outside its fixed policy. That policy is not a lock:
  the Safe can leave it through a public handback (`transferOwnership` back to the timelock), 48 hours after it is
  scheduled until 2026-10-11 19:49 UTC and in one block from then (`docs/SECURITY-v2.md`, X1). No owner call reaches
  lender deposits or a backer's locked shares. The same timelock, on the same delay, gates a stock vault upgrade,
  the one-time setters of BuyAndBack and the SwapLimiter, and SeatVaultV5's settings.
- **Rule-bound, no timelock:** once a day anyone can call `PoolSteward.sweep()`. It sends the reserve above its target
  (the larger of 190 USDG and 10% of principal out; at or under the target, half of what arrived since the last
  sweep) to the `RevenueRouter`, never below the hard floor (the larger of 190 USDG and 2% of principal out) and
  nothing under 25 USDG. The destination is fixed; the Safe, as guardian, can pause the sweep. A sweep that moves
  more than that rule, or anywhere else, is a finding.

### Who holds which key

| Key | Holder | What it can do | What bounds it |
|---|---|---|---|
| Safe, 2-of-3 | three signers (`0x20c6816B2419616238772591965E6E9AbE493fD5`) | proposes, executes and cancels everything on the timelock; pauses the pool, the sweep, the router and the engines as guardian; owns treasury v4, the seat sizers and the stock vault's settings | two signatures per transaction; no timelock on the treasury, the seat sizers or the stock vault's settings, and no delay on the timelock from 2026-10-11 19:49 UTC; every transaction is public |
| Timelock, 48 h until 2026-10-11 19:49 UTC, none from then | `TimelockController` (`0x5d984C274035F81BB327d532897a902C5125F87c`); the Safe is its only proposer, executor and canceller | everything the pool's owner can do (through the steward), the steward's handback, the router's split, the swap limiter's settings, BuyAndBack's and the SwapLimiter's one-time setters, SeatVaultV5's settings (`setOpenBacking`, `setPremiumCap`, `setKeeper`, ...), a stock vault upgrade (it owns the ProxyAdmin `0x5174A18550a295cd25aF59416a56B7e4c38C8Afc`) | until 2026-10-11 19:49 UTC each call waits 48 hours after it is scheduled, in public, and the Safe can cancel it; the Safe scheduled `updateDelay(0)` on 2026-10-09 (tx `0x2095a36a5c0897dac7e21c780216318386fed8d8bbea35aad80b29eeb369bf1b`), so from then a call can be scheduled and executed in the same block: still public (`CallScheduled`, `CallExecuted`), with no time to react |
| PoolSteward | contract (`0x6D9D4135417E0AB2aafc69Fc842525Af279a5Da8`), owner of the pool | the pool's owner calls, decoded against its policy; the daily `sweep()` | not upgradeable and ownerless; its policy holds until a public handback, 48 hours after it is scheduled until 2026-10-11 19:49 UTC, in one block from then |
| Keeper | one EOA (`0xDC2A212fA0EB52eB0Eccbbb0fE5C082FCB1F67bf`), the only caller of `KeeperHelper` (`0x3Ba233d2ac1C6233C5fA954C2DaaD83fcCFE5372`) | records the $PRIORS price that sizes the growth vault's seats and the pool depth the swap limiter reads | moves no funds; within the sizer's bounds; the Safe can name a new keeper at once |
| Inviter | the invite bot's key, named by the Safe with `setInviter` | signs treasury invites: a never-enrolled identity's $5 first line | the treasury's $100 of new lines a week; the bot asks for a 5 USDG bond first, but a leaked key could seat agents without one, up to that cap; the Safe can replace it at once |
| Attester | one EOA (`0x613854463BB854225306b9b18bdb451A78430a73`) | posts and revokes Priors' score notes on the ERC-8004 reputation registry | no pool role and no funds; every repayment and payment a note cites is checked against the two pools of `deployments/4663.v2.json`, whatever addresses the note names (`node scripts/verify-attestation.mjs <agentId>`): a leaked key can post a note citing a loan that never happened, but that check fails it (GHSA-m5wj-mgcg-x3fv). The score and the totals are the attester's word: the script does not re-derive them (it prints the lens' figures beside the totals), so a leaked key can post a false score that passes it |
| Credit writer | one EOA (`0x03af41aEb1EEa4DA0572bbb6AB1B4c5331F17aC7`), owning no agent | posts Priors' loans as ERC-8004 credit statements (`docs/ERC-8004-CREDIT.md`) | no pool role, gas only; never revokes; every statement can be rebuilt from the two pools' logs with Priors' published manifest (`node scripts/verify-credit.mjs <agentId> --writer 0x03af41aEb1EEa4DA0572bbb6AB1B4c5331F17aC7 --full --sources docs/erc-8004-credit/priors-manifest.json`), which pins the pools as the writer's only sources: a leaked key can post a statement with false loans or totals, or one that declares a contract of its own, but that rebuild fails it. Without the manifest a rebuild takes the sources the statements declare, says so and counts nothing (GHSA-fgg6-4235-36m3). The class split and the lender's name are the writer's claims either way |

Expect a pause first and a migration later.
