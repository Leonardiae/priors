# Priors Score v2

*2026-09-26, audited the same day (findings F1-F21 fixed below). Live since 2026-09-27: see "Where to read it".
In this repo: the scoring engine (`sdk/score-v2.mjs`), its inputs (`sdk/score-v2-inputs.mjs`), the weights
(`sdk/score-weights.v2.json`; 2.0.1 in `sdk/score-weights.v2.0.1.json`, 2.0.2 in `sdk/score-weights.v2.0.2.json`),
x402 income read from the chain (`sdk/x402-income.mjs`) and the tests (`scripts/test-score-v2.mjs`,
`scripts/test-x402-income.mjs`, `scripts/test-stocks.mjs`, `scripts/test-score-v2-priors-stake.mjs`). Priors' clusters
list is not published (see "Clusters").*

## Why a v2

The on-chain score (`src/libraries/ScoreLib.sol`, "v1") has the right idea: every point costs money held at risk
for real time. An audit (2026-09-26) found what it can't see:

- **whose risk it was.** v1 counts a loan backed by the agent's own owner the same as one backed by a stranger;
- **lateness.** A loan repaid in the grace period counts like one repaid on time;
- **history.** Age resets at each migration, and a sold agent keeps its record;
- **income.** The next input (`docs/SCORE-x402.md`) has nowhere to go.

## Two layers

| layer | what | changes how | used by |
|---|---|---|---|
| **v1, on chain** | `ScoreLib`: simple, conservative | a new pool version, behind the timelock (48 h; no delay from 2026-10-11 19:49 UTC) | contracts: treasury rules (a raise needs a score of 100); seat gates count repaid loans, not the score |
| **v2, open and deterministic** | `scoreV2()`: a pure function of public data, with published weights | a new weights file and version, announced on the dev log (priors.trade/updates) 7 days ahead (below) | people and apps: site, API, MCP; later attested on chain |

v2 moves fast and in the open; v1 stays the hard floor the contracts rely on. When a v2 component has proven itself
on data, it moves into the next on-chain version.

## The score (v2.0.0, 2.0.1 and 2.0.2, the same numbers; max 1000)

| component | max | counts |
|---|---|---|
| **risk time** | 300 | USDG **someone else** put at risk × days actually held (capped at the term), on loans repaid on time. 1 point per 10 USDG-days. A loan the agent repaid from x402 income counts up to 25% more, in proportion to the share of it that counted income paid (income weighted like the income component, at most 20 USDG per payer per loan, each payment spent once). |
| **seasoned loans** | 200 | loans held 7+ days and repaid on time, backed by someone else. 20 each for a loan of 50 USDG or more; a smaller one counts in proportion (a 5 USDG loan: 2). |
| **backing** | 150 | money another party has at risk behind the agent now. 1 point per 5 USDG. |
| **age** | 100 | days since the agent's first loan on Priors, v1 included (an agent that never borrowed has none); restarts when the agent changes hands. |
| **recourse** | 100 | debts of vouched agents it paid itself. 50 each; dropped when the agent changes hands. |
| **income** | 150 | x402 payments (signed USDG, from any facilitator) to the agent's declared payment wallet from payers that aren't its own, last 30 days, net of anything the agent's side sent that payer. A payer counts once it has paid 1 USDG in the window; each payer is capped at 20 USDG and weighted by its own score (unknown wallets at half weight); plus 5 points per payer, up to 50. A payment to a wallet several agents declared is shared between them. |
| penalties | | −10 per late repayment (and it earns nothing); −75 per vouched agent that defaulted |
| **default** | | the score is 0, and so is every other agent of the wallet that defaulted: the loan's owner when it was taken, and the defaulted agent's declared payment wallet. Sending a defaulted agent to someone never harms them. (A v1 default, with no owner recorded, zeroes only the agent itself.) |

**Backers.** A loan is "backed by someone else" when its backer is another owner's agent that had been on Priors for
**30+ days** when the loan was issued, counted from its enrolment or, if later, from when its current owner took the
id (registry transfers). The protocol's treasury (and treasury v5, once the snapshot names its root) and seat vaults
(V3 and the growth seat vault V4, public ids in the snapshot) count from day one. A backer the record doesn't know
counts as the agent's own, and so, under 2.0.1 and 2.0.2, does the stock vault's root: the agent's own tokens stand
behind that loan. Under 2.0.2, so do SeatVaultV5's roots (#8762, and the retired #8641; the snapshot's
`meta.seatVaultV5AgentId`, without which 2.0.2 builds no inputs, and `meta.seatVaultV5RetiredAgentId`): V5 sizes the
line by the owner's own $PRIORS behind the agent and burns 75% of it on a default, so a stake never changes a score.
v1 loans take their backer from the repayment's `FeeSplit` event, not from today's sponsor. The same rule applies to
backing held now.

**Rungs** (the record side of the trust ladder): 0 unproven · 1 started (one repayment backed by
someone else) · 2 proven (3+, over 14+ days, none late) · 3 earned (proven, a record score of 300+ with income left
out, and 30+ days since the first backed loan) · 4 income-backed (earned, income 50+ from 3+ payers of 1 USDG or more).
Income can add points, but it can't lift a thin record to "earned". Every threshold is in the weights file.

Every result explains itself: the score, the rung, each component with its points and reason, penalties, and the
raw details (USDG-days, loans, payers, and `incomeUsdg`: the x402 USDG of the payers that count, before caps and
weights). `receiptsUsdg` and `receiptPayers` show what the agent was paid by payers outside its cluster in the window,
net of what its side sent back but before caps and weights, dust and fresh wallets included: a customer's payment is
shown even when it doesn't count toward the score, once that payer's netting is read (a new payer, or a payment to a new
agent's cluster, waits until then: "New payers and new agents wait" below).

Each result also has `next` (since 2026-10-16): the next rung and how far the agent is on each of its conditions,
`{ rung, name, needs: [{ key, have, need, met }], blocked }`, from the same figures the rung is judged on:
`backedRepaid` (repayments backed by someone else), `spanDays` (days from the first such repayment to the last) and
`late` (need 0) for proven; `recordScore` (income left out) and `daysSinceFirst` for earned; `incomePoints` and
`payers` for income-backed. `blocked` is `"late"` when a late repayment keeps proven closed for good. `next` is null at
rung 4 and after a default. It changes nothing in the score or the rung.

## Clusters

A loan counts only if its backer is under **different control** from the borrower, and income only from payers that
aren't. An agent's cluster joins its owner, the payment wallet it declared in the ERC-8004 registry
(`getAgentWallet`: the wallet signs to accept it, so it is provably the same party), every agent and wallet linked
through those, and the links of Priors' clusters list: agents and wallets known to be under common control. That list
is **not published**, so a score that depends on it cannot be recomputed exactly from this repo alone (the engine takes
it as `links`; without it, only the on-chain links above apply). An agent backed by its owner's own root builds
nothing. Clusters shape the computation only; no output names them.

Next (v2.1): wallets funded from the same source, or paying each other's gas, join one cluster (`makeClusters` in
`score-v2-inputs.mjs` is the seam).

## How x402 income is read

An x402 `exact` payment in USDG is an EIP-3009 `transferWithAuthorization`: the payer signs, a facilitator submits,
and USDG emits `AuthorizationUsed(payer, nonce)` followed by `Transfer(payer, payTo, amount)`. `sdk/x402-income.mjs`
reads those two events from the chain, so every facilitator counts, not only Priors'. Signed USDG payments are common
on Robinhood Chain (apps move large amounts this way), so the scan lists the authorizations first and then asks only
for the transfers from those payers to agent wallets; the transfer must be the log right after its authorization.

An x402 payment can also be settled through Permit2 (the `upto` scheme, and `exact` on a token without EIP-3009):
Permit2 moves the USDG, then the x402 proxy that called it emits `Settled()` or `SettledWithPermit()`
(`x402ExactPermit2Proxy` `0x402085…0001`, `x402UptoPermit2Proxy` `0x4020A4…0002`, the same address on every chain).
The scan lists those events too (four queries per window, one address and one topic each) and, only around them, the
transfers to agent wallets; the transfer must be the log right before the event. Both routes count the same way:
same wallets, same netting, same filters. An index read before this re-reads Permit2 alone over what it had read,
once, without holding scores back; the published `index.permit2Backfill` is `null` once it is done.

- **Whose income.** A payment counts for the agents that declared the paid wallet as their payment wallet in the
  ERC-8004 registry. The registry sets it to the owner at registration, clears it when the agent changes hands, and
  changes it only with the wallet's signature, so agents sent to someone's address can't take a share of its income.
  A wallet that can't be read holds the scores back until it is read: a declared wallet links clusters, so scores are
  never published without one.
- **Netted.** USDG that any wallet of the agent's cluster sent to a payer (before or after, whole chain) is taken off
  that payer's payments: money that goes back where it came from is not income.
- **No dust.** A payer counts once it has paid 1 USDG in the window. Below that it adds nothing and costs no scan.
- **New payers and new agents wait, nobody else does.** A new payer's netting is read from the start of the chain;
  until then its payments wait (they show nowhere, receipts included). A new agent's owner and declared wallet are read
  the same way, and until then payments to every agent of its cluster wait. The reads waiting to start are made
  together, one pass for the new payers and one for the new wallets, each taking only its own transfers and stopping
  its wait once its own part of the chain is read. A pass in progress goes first, all of them before a new wallet's
  past payments, 100,000 blocks a request (10,000 on a node that answers no more), and each step goes on from where the
  last one stopped. Everyone else's scores keep publishing.
- **Repaid from income.** A loan that counts (backed by someone else, repaid on time by the agent's own wallets, since
  its last change of hands) and was repaid while counted income arrived is marked repaid from income, in proportion.
  Income is weighted like the income component, capped at 20 USDG per payer per loan, and each payment is spent once.
- **Kept for a year.** Payments are kept 365 days (less only if the index must shrink to fit its store); a loan's
  bonus comes from income inside that window. Income is read from pool v2's launch block on, which is when x402
  started on Robinhood Chain. Each published result names how its index was read (`index`: blocks, retention).
- **Not seen yet.** Gas funding in native ETH (no log), x402 batch settlement (payment channels,
  `x402BatchSettlement`), payments to a wallet the agent hasn't declared, and a payer funded through an intermediary
  wallet (v2.1, funding-source clusters).

## How people will try to game it, and what stops them

| attack | stopped by |
|---|---|
| flip hundreds of small loans | risk time counts USDG × days: 300 half-hour loans of 8 USDG earn under 10 points (flips of hundreds of USDG do add up, but that money is really at risk, and flips never make seasoned loans) |
| many tiny week-long loans | a seasoned loan counts by size: ten 1 USDG loans are worth 4 points, not 200 |
| back yourself | loans backed by your own owner count for nothing |
| back yourself from a fresh second wallet, or buy an aged backer id | a backer counts only after 30 days on Priors, counted from when its current owner took the id (registry transfers); v2.1 adds funding-source clusters |
| pay yourself to fake income | payers in your cluster (owner, declared wallet, linked agents) are excluded; each payer is capped; unknown payers count half |
| fund a second wallet, then have it pay you | what your side sent that wallet directly is netted out of its payments; funding it through an intermediary is not caught yet (v2.1) |
| round-trip the same money | what goes straight back to the payer doesn't count; a round trip through a third wallet is v2.1 |
| send a defaulted agent to an honest owner | harmless: a default spreads only to the wallet that defaulted |
| push agents onto someone's address to dilute their income | only agents that declared the wallet share it, and a pushed agent's declaration is cleared by the registry |
| spam new tiny payers to stall the index | payers under 1 USDG are ignored, and new payers never hold other scores back |
| buy a loan's bonus with one big payment | at most 20 USDG per payer per loan, unknown payers at half weight |
| sock-puppet payers funded elsewhere | per-payer cap; unknown payers at half weight; breadth only from payers of 1 USDG+; the income rung also needs a 30-day earned record; v2.1 funding-source clusters |
| claim someone else's payments | only the agent's owner and a wallet that signed to be its payment wallet count |
| climb fast | rungs need time: proven needs 14+ days of backed repayments, earned 30+ days since the first |
| buy an aged agent | a change of hands restarts age, record and recourse |
| gift your root to a borrower's owner | makes them one party, so the borrower's backed record stops counting; it costs the gifted stake and is undone by moving the root away |
| repay late but eventually | late loans earn nothing and cost 10 points |
| behave, then take a big line and vanish | one default = 0 for every agent of the wallet that defaulted (per wallet, not per person: an owner who keeps one agent per wallet loses only that one); rungs need time. Lines do not follow rungs yet: the treasury's raise and the seats read the v1 score and their own rules, and a line grows only when a backer vouches more |

## What the live record shows (2026-09-26)

Over the live record (income read from the chain): 133 agents, v2 max 5 (age only), **no agent above
rung 0**. Quick round-trip loans build nothing, by design; the record builds from loans backed by someone else, held
for real time. On income: one signed USDG payment has reached an agent's wallets since pool v2, and it is netted out
(the agent's side had sent that payer USDG). No agent earns x402 income yet; the first real client payments will be
the first income points.

Scores are computed by Priors from public data: the on-chain record and x402 payments on Robinhood Chain.

## Where to read it

Live since 2026-09-27:

- `GET https://priors.trade/api/score-v2` (every agent; `?agent=<id>` for one): recomputed at most every 10 minutes;
  a result older than an hour is not served. Free.
- The paid API (`api.priors.trade`, x402): `/v1/score/:id` adds `v2` with the breakdown.
- The hosted MCP (`mcp.priors.trade`) and the npm `@priors/mcp` (0.1.7 and later): `score_of` adds the v2 line.

When a v2 result is not available, each of them answers without it (`v2: null`) rather than failing.

## Changing it (future intervention)

- **Versioned.** The weights file carries a version. A change is a new weights file with its own version, a line in
  the changelog below, and an announcement on the dev log (priors.trade/updates) at least **7 days before** it becomes
  the default. Old versions stay in the repo, so any past score can be recomputed.
- **Pinned outputs.** Every published score names its version; apps can pin a version. The engine computes with
  the version it is given (`weightsFor` in `sdk/score-v2.mjs`: 2.0.0, 2.0.1 or 2.0.2; 2.0.0 when none is given).
  Priors' published scores use 2.0.1, and 2.0.2 from 2026-11-01 00:00 UTC: a score's version follows from its own
  timestamp.
- **No hidden levers.** No per-agent overrides. Protecting the pool from a bad actor uses the existing on-chain tools
  (freeze, pause), which are public events.
- **The clusters list changes only by commit** (in Priors' own repository; it is not published).

## Rollout

| phase | what | status |
|---|---|---|
| 1 | engine, weights, clusters, tests | **done** |
| 2 | show it: API (`/v1/score` adds `v2` with the breakdown), MCP `score_of` (hosted and npm), agent page (breakdown and rung; every agent shown the same way) | **live** 2026-09-27 (API, MCP); the agent page (breakdown and rung) is live too |
| 4 | income from any facilitator (USDG `AuthorizationUsed` events), declared payment wallets, netting, loans repaid from income | **built** (with phase 2) |
| 4a | x402 settled through Permit2 (the x402 proxies' `Settled()`) | **built** 2026-10-02 |
| 4b | v2.1: funding-source clusters (gas and first USDG), payer graph weights | after launch |
| 5 | on chain: attest v2 scores to the ERC-8004 reputation registry with version and input hash; treasury rules read the rung from a signed attestation; stable components move into the next `ScoreLib` | after a month of data |

## Changelog

- **2.0.2** (published 2026-10-23 on the dev log, priors.trade/updates; Priors' scores use it from 2026-11-01 00:00
  UTC): 2.0.1 plus SeatVaultV5's roots as the owner's own collateral (`sdk/score-weights.v2.0.2.json`,
  `backers.ownCollateralRoots` "seatVaultV5": `meta.seatVaultV5AgentId`, and `meta.seatVaultV5RetiredAgentId` when
  named). V5 sizes a line by the owner's own $PRIORS behind the agent and burns 75% of it on a default, so its loans are
  no risk someone else took, and a stake never changes a score. No weight changes. Under 2.0.1, V5's root (#8762,
  enrolled 2026-10-11) passes the 30-day backer rule on 2026-11-10 15:06 UTC; from then a bigger stake would raise the
  score (a $25 line's three loans score 111, a $50 line's 199; 24 for both under 2.0.2:
  `scripts/test-score-v2-priors-stake.mjs`). Inputs under 2.0.2 need the snapshot to name V5's root: without
  `meta.seatVaultV5AgentId` none are built (`ownCollateralRoots` in `sdk/score-v2-inputs.mjs` throws), so no score is
  published rather than one a stake moved. No score moves on the day: until V5's roots are 30 days old (the retired
  #8641 on 2026-11-08, #8762 on 2026-11-10), 2.0.1 and 2.0.2 give every agent the same score, so on 2026-11-01 only
  the published `version` changes. 2.0.0 stays the engine's default.
- **inputs, 2026-10-14** (all versions): treasury v5's root (`meta.treasuryV5AgentId`, where an agent moves for its
  $25 raise) backs from day one, as the treasury does: a moved line's loans stay someone else's risk.
- **inputs, 2026-10-04** (all versions): a loan repaid through AutoRepay (Autopay) is read from AutoRepay's own
  `AutoRepaid` log, which names who paid: the agent's wallet, its owner, or both, each of which must be the agent's own
  for the loan to count as repaid from income (`readRepayers` in `sdk/x402-income.mjs`, `repaidByOwn` in
  `sdk/score-v2-inputs.mjs`). Without it the payer was AutoRepay itself, never the agent's own.
- **inputs, 2026-10-02** (all versions): x402 payments settled through Permit2 count as income, read from the x402
  proxies' `Settled()`/`SettledWithPermit()` and the USDG transfer right before; until now only EIP-3009 payments
  were read. No published score changes: a full index read with it from pool v2's deploy block to block 78,018,367
  found no Permit2 payment to an agent's declared wallet (992 USDG settles went through Permit2 on Robinhood Chain
  since v1's deploy, none to an agent's wallet).
- **inputs, 2026-10-01** (all versions): a change of hands after an agent's v1 loans restarts its record too, read
  from the identity registry's transfers (`ownerSince` in `buildInputs`), since v1 loans carry no owner; a transfer
  before every v1 loan (the mint) changes nothing, and an agent with no v1 loan is read from its v2 loans as before.
  Found by our own audit of the public repo; no agent is known to have changed hands after its v1 history.
- **inputs, 2026-09-29** (all versions): a backer's 30 days count from when its current owner took the id, read
  from the identity registry's transfers, not from its enrolment: a bought aged id is a new backer (private report
  GHSA-6f8j). No published score changed: no backer id had changed hands after enrolling.
- **2.0.1** (2026-09-28): a loan backed by the stock vault's root (`meta.stockVaultAgentId`) counts as the borrower's
  own money, since its own tokens stand behind it, not as someone else's risk (`sdk/score-weights.v2.0.1.json`,
  `backers.ownCollateralRoots`; found by the stocks readiness review of 2026-09-28). No weight changes. A
  self-collateralised agent at day 30 scores 29 under it, 519 under 2.0.0. 2.0.0 stays the engine's default (the
  version `weightsFor` returns when none is named) until 2.0.1 is announced on the dev log (priors.trade/updates), 7
  days ahead. While the stock vault is live, Priors publishes v2 scores under 2.0.1 only: 2.0.0 scores (or any score
  while the vault's agent is unknown) are withheld rather than published inflated.
- **2.0.0** (2026-09-26): first version, never published before the audit fixes were folded in: seasoned loans
  weighted by size; backers need 30 days on Priors (or are the protocol's treasury or seat vault) and unknown ones
  fail closed; v1 backers from `FeeSplit`; rungs 2 and 3 need 14 and 30 days; dust payers add no breadth; income
  shared across an owner's agents; a default zeroes the owner's other agents; a change of hands is read from the
  loans' owner and drops recourse; age from the first loan; inputs validated, `now` required, risk time summed as an
  integer. Then x402 income from the chain, whoever settled it; clusters joined through declared payment wallets;
  money sent back to a payer netted out; loans repaid from income earn up to 25% more risk time; unreadable loans
  and ownerless agents fail closed. Then the income audit: a default spreads only to the wallet that defaulted
  (never to whoever is sent the NFT); income matched on declared wallets only; the earned rung judged on the record
  without income; the loan bonus weighted, capped per payer and spent only on loans that count; payers under 1 USDG
  ignored; new payers and wallets backfilled on their own; a failed wallet read keeps the wallet known before; hard
  time limits; stale scores not served.
