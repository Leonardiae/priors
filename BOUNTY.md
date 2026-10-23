# Bug bounty

[SECURITY.md](SECURITY.md) says how to report. This says what a report is worth, what is in scope, and what
we will not do to you for looking.

## Read this first: the size of the thing

The v2 pool holds **about $3,697 of assets** (lender deposits and backers' locked stake, $863 of it lent out) plus
a reserve of about $216, read from the chain on 2026-10-07 (`totalAssets()`, `totalPrincipalOut()`, `reserve()`); about
$1,030 of that stake is the stock vault's free backing, not yet behind a line (`freeBacking(6424)`). That is the whole
protocol, today. We are telling you
that up front because a bounty page that implies millions are at stake, from a contract holding a few thousand
dollars, is asking you to spend a week of your time under false pretences.

So this is a small programme, honestly sized, and the ceiling is real. If you want to look at this because
the mechanism is interesting — unsecured credit for agents, where the only collateral is a record — the code
is here and the door is open. If you want it to pay rent, it will not.

## What a finding is worth

| Severity | What it means | Award |
|---|---|---|
| **Critical** | Funds leave the pool to someone not owed them, lender principal can be reached, a backer's stake or a staker's seat can be taken, or stock deposited in the stock vault can be taken other than by a default of its own position's loan. Anyone can do it, no privileged key. | **$300** |
| **High** | Credit can be obtained without the invite, the consent, the seat or the backing that is supposed to gate it, a stock line can be drawn beyond its loan-to-value of the collateral's value now, or accounting can be corrupted so the ledger lies about who repaid what. | **$100** |
| **Medium** | A rule can be bypassed with a privileged key that should not be able to bypass it, or a griefing path that costs others money without profiting you. | **$50** |
| **Low / Informational** | Wrong behaviour with no path to loss: a misleading view, a revert that should not happen, a documented rule the code does not implement. | public credit and acknowledgement only, no payout |

Paid in USDG on Robinhood Chain, or in whatever else we can agree on. One award per root cause, not per call
site. Anything below Medium is credited in public, not paid. We would rather say that here than argue about it
afterwards. These amounts apply from 2026-10-18; a report received before then keeps the award it was told.

Severity is our judgement, argued in writing with you, not a number we pick in private. If you disagree with
where we land, say so — the reasoning is the part we will publish.

**The client packages (`@priors/x402`, `@priors/mcp`, `sdk/float.mjs`): what counts as a loss.** The client loses a
user money when it pays what the user did not authorise: a second signature for one purchase, a payment signed above
the per-call cap (`max_price_usd`) or past the session cap (`PRIORS_MAX_SPEND_USD`) in force when it was signed, a
payment to another address or on another chain than the one quoted, or a borrow the borrow caps do not count. That is
Medium, one award per root cause (P-10 and P-16 in [docs/SECURITY-v2.md](docs/SECURITY-v2.md)). It is not a loss, and
at most Low: one authorization the user signed within those caps being settled once, whether for the request it was
signed for or for a retry or another request that reused it, even when a later quote would have been lower; a
merchant charging a price it quoted under the caller's caps; a merchant not delivering what it was paid for (a merchant
can do that with any client). Caps bound what a merchant can take, they do not make a merchant honest. A ratio ("10x
overpaid") does not move a finding up a tier: what counts is whether money moved that the user had not signed for
within their caps.

**A request the caller re-spells is a new purchase.** The client keys a purchase by the request as a merchant reads
it; P-24's row in [docs/SECURITY-v2.md](docs/SECURITY-v2.md) lists which spellings it merges. A caller that sends a
purchase again in another spelling — another form of the URL (a trailing slash, an escape), a header added or dropped,
another encoding of a hand-built multipart body — has asked for a second purchase, and the client counts it in the
per-call and session caps like any other. That is P-24's known residual, not a new finding: a further spelling
reported under it is credited in P-24's row, rated Low at most, and not paid. What still counts is a second signature
for one request resent unchanged (the same method, URL, headers and bytes), or a re-spelled request that gets past
the caps.

## In scope

The v2 contracts on Robinhood Chain (chain 4663), live since block 71,702,460, and the ones added to the set since:

| Contract | Address |
|---|---|
| `CreditPoolV2` (with its linked `PoolV2Lib`) | [`0x281210097f0de7A8FB6F87310AF0f089c9C8DE21`](https://robinhoodchain.blockscout.com/address/0x281210097f0de7A8FB6F87310AF0f089c9C8DE21) |
| `CreditLensV2` | [`0x9d7035722bd42C551f82FEB9FDDd17453AEF3D9B`](https://robinhoodchain.blockscout.com/address/0x9d7035722bd42C551f82FEB9FDDd17453AEF3D9B) |
| `TreasurySponsorV4` (root `#6228`) | [`0x0c5091235A25bBFD3F5a009cBe04120D0CBAD573`](https://robinhoodchain.blockscout.com/address/0x0c5091235A25bBFD3F5a009cBe04120D0CBAD573) |
| `SeatVaultV3` (root `#6234`) | [`0x59D155C42A9263fA7596867b992bB3e84dF680a9`](https://robinhoodchain.blockscout.com/address/0x59D155C42A9263fA7596867b992bB3e84dF680a9) |
| `SeatSizer` of `SeatVaultV3` (owns it; the Safe owns the sizer) | [`0xd24B6484f4E68d72Fd2d3AF7bD036560B2ed5E61`](https://robinhoodchain.blockscout.com/address/0xd24B6484f4E68d72Fd2d3AF7bD036560B2ed5E61) |
| `SeatVaultV4`, the growth seat vault (root `#6466`; live since 2026-09-29) | [`0xb1c3a04496238D62E3c93118C297163855e22192`](https://robinhoodchain.blockscout.com/address/0xb1c3a04496238D62E3c93118C297163855e22192) |
| `SeatSizer` of the growth seat vault (owns it; the Safe owns the sizer) | [`0x97C4e594D458f8BBE961d5384Bbd8a9Cc2D18777`](https://robinhoodchain.blockscout.com/address/0x97C4e594D458f8BBE961d5384Bbd8a9Cc2D18777) |
| `TimelockController` (48 h delay, none from 2026-10-11 19:49 UTC; drives the steward, and owns the stock vault's ProxyAdmin since 2026-10-07) | [`0x5d984C274035F81BB327d532897a902C5125F87c`](https://robinhoodchain.blockscout.com/address/0x5d984C274035F81BB327d532897a902C5125F87c) |
| `PoolSteward` (`src/PoolSteward.sol`), the pool's owner since 2026-10-06, and its daily `sweep()` | [`0x6D9D4135417E0AB2aafc69Fc842525Af279a5Da8`](https://robinhoodchain.blockscout.com/address/0x6D9D4135417E0AB2aafc69Fc842525Af279a5Da8) |
| `RevenueRouter` (`src/RevenueRouter.sol`), the sweep's and the vaults' fees' destination | [`0xb2E217C5841a968C48Eee41DCbF7D2a03cCA4F43`](https://robinhoodchain.blockscout.com/address/0xb2E217C5841a968C48Eee41DCbF7D2a03cCA4F43) |
| `BuyAndBack` (`src/BuyAndBack.sol`), engine 1 | [`0xEe40675aBEC90E52211526845433C10c80fD569E`](https://robinhoodchain.blockscout.com/address/0xEe40675aBEC90E52211526845433C10c80fD569E) |
| `PriorsLiquidity` (`src/PriorsLiquidity.sol`), engine 2 | [`0xbEC159832D05749557F3f972c4823979C8dC8451`](https://robinhoodchain.blockscout.com/address/0xbEC159832D05749557F3f972c4823979C8dC8451) |
| `SwapLimiter` (`src/SwapLimiter.sol`), the engines' depth guard | [`0x4535b1d92ebBe8176463dE4b58Ca9B66A231eb0E`](https://robinhoodchain.blockscout.com/address/0x4535b1d92ebBe8176463dE4b58Ca9B66A231eb0E) |
| `KeeperHelper` (`src/KeeperHelper.sol`), SeatSizerV4's keeper since 2026-10-06 | [`0x3Ba233d2ac1C6233C5fA954C2DaaD83fcCFE5372`](https://robinhoodchain.blockscout.com/address/0x3Ba233d2ac1C6233C5fA954C2DaaD83fcCFE5372) |
| `SeatVaultV5` (`src/SeatVaultV5.sol`, root `#8762`; live since 2026-10-11, owner-only backing; the deployment of 2026-10-09, `0xdE29D3A627d77CFA13c5331C1B7B181a4C5B752E`, is retired), with its nine linked libraries in `src/v5/`: `V5Pos`, `V5Steps`, `V5Book`, `V5Records`, `V5Exit`, `V5Auto`, `V5Sync`, `V5View`, `V5Lens` | [`0xC999014C6218EC41f0aE412d49AE8f2aA4c539fD`](https://robinhoodchain.blockscout.com/address/0xC999014C6218EC41f0aE412d49AE8f2aA4c539fD) |
| its libraries, which V5 calls by DELEGATECALL (they run in V5's context and hold nothing) | `V5Pos` `0xd2d393Daf7bABE6ac090a97765407256673Bf9Bc`, `V5Steps` `0x3a4B951E0eae25DD327224395ecE0C6fD6345f94`, `V5Book` `0x90992387BbfBcF6aB179B33535d283FEE2d832F4`, `V5Records` `0x23C3660Cd36401F6adE16f51f81F629a6aE6d826`, `V5Exit` `0x0BB0CF27E9a0f5DB38a3F58fc31b1f90D784CbC7`, `V5Auto` `0x22914DF387771bCB167Bfd1777678887D1AB1375`, `V5Sync` `0x2FE6cC16DA24694D48BbDD8C83d4732ca23276F4`, `V5View` `0xE5175D7C9C30E210197D23A45A3e0bbe66cF1846`, `V5Lens` `0x294a483e54aBE64d2037df370974304C0F3B09F7` |
| `InviteBond` (the bond an automatic invite needs) | [`0x8BE478c754D9124D11e78dB20F5bf4dA45403275`](https://robinhoodchain.blockscout.com/address/0x8BE478c754D9124D11e78dB20F5bf4dA45403275) |
| `StockVault`, the stock vault (root `#6424`; live since 2026-09-28): the proxy users call | [`0xbEcd07EC689988e16b870C121756C4c2C8cb02B6`](https://robinhoodchain.blockscout.com/address/0xbEcd07EC689988e16b870C121756C4c2C8cb02B6) |
| its implementation (`src/StockVault.sol`) | [`0xd30396A79D6b5BDB86D09B8c7907aD2820a42c72`](https://robinhoodchain.blockscout.com/address/0xd30396A79D6b5BDB86D09B8c7907aD2820a42c72) (since 2026-10-18) |

The stock vault is the one upgradeable contract: what is in scope is the implementation its proxy points to when you
report (the ERC-1967 implementation slot), which the table will follow after any upgrade.

SeatVaultV5 runs Stage 1 with owner-only backing (`openBacking` false, premium cap 0): others' backing is closed, so
only an agent's owner, and BuyAndBack's protocol backing once it buys for V5, stake $PRIORS behind a line. Two of its
paths are not live yet: paying in USDG (`openWithUsdg`, `backWithUsdg`) and BuyAndBack's buying and placement for V5
both wait for the timelock batch that names V5 in BuyAndBack and the SwapLimiter, scheduled and executable from
2026-10-11 16:48:02 UTC. Until it executes, those paths revert on chain.

Also in scope: the SDK (`sdk/`), the npm packages
[`@priors/x402`](https://www.npmjs.com/package/@priors/x402) and [`@priors/mcp`](https://www.npmjs.com/package/@priors/mcp)
(`packages/`), the CLIs, the site's wallet path and the x402
facilitator at `facilitator.priors.trade`, where a bug can cost a *user* money even though the contracts are
sound — a mis-encoded call, a wrong address, a consent or an invite that redeems against the wrong agent, a
payment settled twice. The hosted MCP server at `mcp.priors.trade` and the paid API at `api.priors.trade` are in
scope on the same terms: the MCP server is read-only and holds no key, so a way to make it sign, send, or leak a
secret is a finding.

**The Telegram invite bot** (`@priors_agents_bot`) is in scope for **public credit only, no payout**, whatever the
severity. Its inviter key only signs first-line invites, and the treasury, which the Safe tops up by hand, caps the new
lines it vouches each week ($100, `rules().epochCap`), so the worst a bot bug can cost is bounded by that cap. A path around the treasury's cap itself is a
contract finding and is paid as one, and so is a way to get a treasury line without the bond `InviteBond` is
meant to hold.

## Out of scope

- **Anything needing the owner's Safe or the timelock.** The Safe is a 2-of-3 and it can change rules, through
  the timelock for the pool; that is the design, not a finding. The timelock's delay is 48 hours until 2026-10-11
  19:49 UTC and none from then: the owner decided it on 2026-10-09, and the Safe scheduled `updateDelay(0)` (tx
  `0x2095a36a5c0897dac7e21c780216318386fed8d8bbea35aad80b29eeb369bf1b`). "The owner could set a bad parameter" is not
  a bug, and neither is "the owner could act with no delay" (`docs/SECURITY-v2.md`, X1). That includes upgrading the
  stock vault: its ProxyAdmin (`0x5174A18550a295cd25aF59416a56B7e4c38C8Afc`) is owned by the timelock since
  2026-10-07 (by the Safe before), so an upgrade is scheduled in public, and an upgrade can move what the vault holds;
  depositors trust the Safe for that. Until 2026-10-11 19:49 UTC an upgrade runs 48 hours after it is scheduled at the
  earliest, so depositors have two days to see it coming; from then it can run the moment the Safe sends it, with no
  time to react. It also includes the steward's public handback of the pool to the timelock (48 hours after it is
  scheduled until 2026-10-11 19:49 UTC, in one block from then), which leaves its policy by design. The steward's
  daily `sweep()`, which anyone can call with no timelock, is in scope the other way round: a sweep that moves more
  than its rule (the reserve above its target, never below the hard floor, only to the `RevenueRouter`) is a finding.
- **The Robinhood stock tokens, their issuer's powers** (pause, block, burn, upgrade) **and Chainlink's price feeds.**
  Not ours. How the stock vault copes with them (its price and pause holds, a burn shared pro rata) is in scope.
- **USDG, the $PRIORS token and the ERC-8004 identity registry.** Not ours; how our contracts handle them is in scope.
- **The v1 contracts**, paused since the v2 cutover and kept as history: the v1 `CreditPool`
  (`0x0259889e6EBab1a18CeE7e62Bc5B9648FB6C44e5`), `TreasurySponsor` v2 and v3, `ReserveFunder` and the older pools,
  and `SeatVaultV2` (`0x6D934C07a33E7285cE691A9B258cdB53F18e6B5F`, empty and paused since V3 replaced it on 2026-09-25).
  A finding there counts only if it also applies to v2.
- **Known v2 findings and their accepted residuals**, listed in [docs/SECURITY-v2.md](docs/SECURITY-v2.md). A new
  path around one of them, or a larger bound than the one stated there, is a finding.
- **Known issues** (next section).
- Gas optimisation, style, and "you should use a different pattern".
- Denial of service that costs the attacker more than the target, or that needs to be sustained forever.
- Anything about the RPC endpoint, the block explorer, or Cloudflare — not ours.
- Social engineering, phishing, or physical access to anyone.
- Reports from an automated scanner with no explanation of the path. Run the scanner; then tell us which
  finding is real and why.

## Known issues

Every issue listed in [docs/SECURITY-v2.md](docs/SECURITY-v2.md), whether fixed, mitigated, an accepted residual
or a trust assumption, is known. A report of one is not a new finding and is not paid at any tier; if it adds
something real (a cleaner reproduction, a tighter measurement) we will credit it in public. That includes the
residuals added after launch: SO-1 and SO-2 (stake held only while marking a default) and AI-1 (the invite bot's
self-service mode, now priced by `InviteBond`), and the stock vault's SV-1 to SV-20. V-2 (seat levers and ownership
not reaching open seats) is fixed in `SeatVaultV3`; a path that still gets around those fixes on V3 is a new finding.

What still counts is a new root cause, or a path that beats the bound stated for a listed issue: reaching lender
principal through it, or losing more than its stated cap. Severity for those is judged by the table above.

## Safe harbour

If you stay inside this, we will not pursue you and will not ask anyone else to:

- Use the testnet or a fork. There is no reason to prove it on mainnet and every reason not to.
- If you genuinely cannot reproduce it off mainnet, take **the smallest amount that proves the point**, tell
  us immediately, and send it back. We will still pay the award. Keeping the funds is theft, and then this
  section does not apply to you.
- Do not touch anyone else's agent, identity, or wallet.
- Do not publish before we have shipped a fix or 90 days have passed, whichever comes first. If we go quiet
  on you, 90 days is yours to use.

## What has already been found

[docs/SECURITY-v2.md](docs/SECURITY-v2.md) lists every known v2 finding, its fix or residual, and its test;
[SECURITY.md](SECURITY.md) has the v1 history. Four worth knowing before you start, because they are the obvious
ones:

- **Every line is 100% backed.** v2 has no earned or unbacked credit: a line is vouched out of a backer's locked
  pool shares, and a default burns that backer's shares worth principal and fee. Lenders are not supposed to be
  reachable at all. A path to lender principal is what "Critical" means above.
- **How first lines are issued.** A treasury v4 invite is signed by the treasury's named inviter after a check that
  the requester owns the agent; redeeming it also needs the owner's pool consent. The invite bot signs
  automatically (self-service mode, on) once the agent's owner has posted a 5 USDG bond in `InviteBond`: the bond
  comes back once the agent has repaid 3 qualified loans (or holds no line 4 days after the deposit), and goes to
  the Safe if the agent defaults. Without a bond,
  an invite still needs an admin's approval. New treasury lines are capped at $100 a week by treasury v4's
  `epochCap`; one person taking the week's first lines within that cap, bond paid, is a listed residual (AI-1), not
  a finding. A seat needs a staker's $PRIORS and a repaid record: SeatVaultV3 (3 repaid loans) is full, and the growth
  seat vault (V4, a $50 line after 10 repaid loans) takes no new seats since 2026-10-09. A SeatVaultV5 line needs the
  agent owner's own $PRIORS staked behind it and the owner's consent to V5's root. A backer needs the owner's consent.
  Credit without one of those is "High".
- **Stock lines.** The stock vault vouches a line of the token's loan-to-value (25-70%, plus a record bonus) of the
  deposit's Chainlink value, at most $500, out of its own stake. Every new loan asks the vault again: a fresh price,
  no lending hold, the owner who opened the position, and the drawn principal within the loan-to-value of the
  collateral's value now. A default seizes to the Safe tokens worth what is owed plus a 20% buffer at the last valid
  price (all of them when the price can't be used; while the token's price tape is behind, the seizure waits and
  `settle` takes what is owed plus 20% once the tape is recorded), gives the rest back to the depositor, and burns the
  vault's stake, never lenders'. Drawing past that, seizing more than that, or moving a depositor's tokens without a default, is a
  finding.
- **Bounded, known losses.** The self-seat loop (X-3), the invite-to-raise path (T10) and self-service invites
  (AI-1) can cost a backer money within the per-epoch caps stated in SECURITY-v2.md (what one week of the seat vaults
  can lose is X-5), and holding stake only while
  marking a default (SO-1, SO-2) takes a share of lender fees within the bounds stated there. Beating those bounds is
  a finding; restating them is not.
