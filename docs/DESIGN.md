# Design: credit-backed reputation for AI agents

> **This page describes v1**, the pool now paused. v2 (live since the v2 cutover) keeps the score and the fee
> split but drops earned (unbacked) capacity and recourse loans: every line is 100% backed by a backer's locked
> pool shares, and a default burns them. See [PARTICIPATE.md](PARTICIPATE.md) for how v2 works and
> [SECURITY-v2.md](SECURITY-v2.md) for its attacks and fixes.
>
> It is the original v1 design, as first written. v1's default accounting was changed later (the v1 list in
> [SECURITY.md](../SECURITY.md#already-known-already-fixed)), and the score is `ScoreLib` v1, not the version 0
> table below (README, [How it works](../README.md#how-it-works)).

## The problem this solves

Agents need to decide whether to trust other agents. ERC-8004 gives every agent an on-chain identity and a reputation registry, but the registry's feedback is rarely tied to a real interaction and is cheap to fake. Reviews cost nothing to produce, so they carry no information.

Repaid debt is different. To produce a repayment record an agent must borrow real money, hold it, and give it back with a fee. The only way to fake that is to actually do it, which is not faking.

Pool v1 (now paused) was a small on-chain credit pool that lent unsecured USDG (Robinhood Chain's dollar; any 6-decimal stablecoin works) to ERC-8004 agents and published every repayment and default. From that record it computed a trust score anyone can verify, query, and recompute.

## Actors

| Actor | Puts in | Gets |
|---|---|---|
| Lender | USDG into the pool | Shares. Fees accrue to the pool. |
| Operator | USDG into the first-loss reserve | The right to grant unbacked credit, bounded by the reserve. |
| Root | USDG stake, at least `minStake` | Credit capacity equal to its stake. Can vouch for agents. |
| Agent | An ERC-8004 id and a sponsor | A credit line, then a record. |

Everyone in the sponsor tree is an ERC-8004 agent, including roots. An operator that wants to sponsor its agents registers one agent for itself and enrolls it as a root.

## Capacity

For any enrolled agent `a`:

```
capacity(a)  = stake(a) + earned(a) + delegatedIn(a)     [delegatedIn counts only while the sponsor is alive]
available(a) = capacity(a) - principalOut(a) - delegatedOut(a)
```

Three sources of capacity, three different backers:

- **stake**: the root's own cash, held by the contract. Slashed on default.
- **delegatedIn**: a line the sponsor set aside from its own capacity. The sponsor is liable up to this amount.
- **earned**: capacity the agent grew by repaying. Nobody in the tree backs it. The reserve does.

A single rule keeps liability from leaking: **a non-root may delegate at most `earned(a)`**. You can vouch with what you earned, never with what was lent to you. Roots delegate from stake plus earned.

## Loans

- Size `minLoan..maxLoan` (defaults $5 to $500), term `minTerm..maxTerm` (1 to 30 days).
- Fee is flat per loan: `principal × feeBps × term / 30 days` (default 1% per 30 days).
- Every fee is split three ways on repayment: lenders (50%), the borrower's sponsor (25%, claimable with `claimSponsorFees`), and the first-loss reserve (25%). A root's own loans and recourse loans have no sponsor share; it goes to lenders. Vouching for a reliable agent is therefore an income, and every repayment grows the reserve that backs earned credit.
- Anyone can repay any loan. Repayment records go to the borrower regardless of who paid.
- After `dueAt + grace`, anyone can call `markDefault`. There is no partial default and no cure period after that.

## Growth

Each seasoned repayment (held at least `minSeasoning`, default 1 day) grows `earned` by `principal × growthBps` (default 50%), subject to three caps that all apply at once:

| Cap | Default | Purpose |
|---|---|---|
| per epoch | $25 per 7 days | bounds how fast an unknown agent can grow |
| per agent | $250 | bounds how big any one unbacked line gets |
| global | `reserve − totalEarned` | every unbacked dollar is pre-funded |

The global cap is the important one. Growth stops when the reserve is fully committed, and the operator can only withdraw reserve that is not backing anyone.

## Default waterfall

Agent `c` with sponsor `s` defaults on principal `P`:

```
c.defaulted = true; c.earned = 0 (released from totalEarned); c.delegatedIn = 0
liable = min(P, delegatedIn(c))
  s is a root      -> slash min(liable, stake(s)) into the pool
  s is not a root  -> issue s a recourse loan for `liable`, fee 0, due in recourseTerm (14d)
  s already dead   -> liable = 0
badDebt = P - liable
  paid from the reserve first; lenders lose only what the reserve cannot cover
```

A recourse loan is an ordinary loan on the sponsor's books. If the sponsor ignores it, it defaults too, and the loss moves one more step up the tree. Honoring one is recorded as `recourseHonored`, the strongest signal on the board.

A defaulter's children are orphaned: their `delegatedIn` no longer counts. Any live sponsor may take them over with `vouch`, which replaces the dead line.

## The invariant

**Bad debt caused by any agent is at most what that agent earned, and the reserve always covers the sum of everything earned. Therefore lenders never lose principal.**

> **This invariant was broken once, and the break is worth knowing about.** `markDefault()` used to release an
> agent's entire `delegatedIn` on its *first* default, so a second default from the same agent found no backing
> left to charge and lenders came up short. The counterexample
> (`test_multipleDefaultsKeepLendersWholeWithoutEarnedExposure`) was committed as a failing test and left public
> until the accounting was corrected: a default now consumes only the liable slice per loan, the remainder keeps
> backing that agent's other open loans, and earned credit is written off against bad debt at settlement.
> `test/DefaultAccounting.t.sol` covers the interacting cases.
>
> ⛔ It has still had **no independent review**. See the note under the sketch on why the randomized invariants
> are not the reassurance they look like.

Sketch. An agent's exposure is `principalOut + delegatedOut ≤ capacity = stake + earned + delegatedIn`.

- Own default: `badDebt = P − min(P, delegatedIn)`, and `P ≤ capacity − delegatedOut`. If `P ≤ delegatedIn` there is no bad debt. Otherwise `badDebt = P − delegatedIn ≤ earned − delegatedOut ≤ earned`.
- Children after the agent is dead: each child's loss falls on nobody, bounded by its line, and lines sum to `delegatedOut ≤ earned` (for non-roots, by the delegation rule; for roots, the excess over stake is at most `earned` because slashing takes everything that was staked).
- Own default plus orphaned children together: `max(0, P − delegatedIn) + delegatedOut ≤ earned` in both cases of the first bullet.
- The reserve only decreases by bad debt, which is at most the defaulter's `earned`, which is removed from `totalEarned` at the same moment. So `reserve − totalEarned` never decreases through a default, and growth is only granted while it is non-negative.

`test/Invariants.t.sol` checks this over random sequences of every user action, and a deterministic drive confirms the walk actually reaches defaults, orphaned children, and reserve payouts.

⚠ Those randomized invariants **passed right through the bug described above**, which is the useful lesson in this file: a fuzzer that never happens to default the same agent twice reports green forever. Their passing was not, and is not, a proof of lender protection. The deterministic cases in `test/DefaultAccounting.t.sol` are what actually hold the line here — and the fact that a real defect survived the fuzzer is the reason to assume the next one might too.

## Why this resists the obvious attacks

**Sybil reviews.** There are none. The only records are `Repaid` and `Defaulted` events tied to USDG transfers.

**Repay a few times, then default big.** Say an agent repays honestly to grow its line, then takes the largest loan it can and vanishes. Its sponsor eats the vouched part, the reserve eats the earned part, and the agent's id is dead forever. The attacker's gain is at most `earned`, which took at least `earned / maxEarnPerEpoch` epochs of real borrowing to build (10 weeks for the full $250) and cost the fees along the way. The sponsor, who chose to vouch, loses the line. The pool's total exposure to this attack is the reserve, which the operator sized on purpose.

**Self-sponsoring rings.** A root that stakes $100 and vouches its own sybils can extract at most $100 of delegated credit, which is its own stake, plus whatever those sybils earned, which the reserve pre-funded. There is no way to borrow against capacity nobody put up.

**Re-delegation chains.** Root → S → C where S borrows a little, defaults, and C's later default lands on nobody. Blocked: S can only delegate what it earned, so C's line was never the root's money, and the reserve covers it.

**Flash loops.** Borrowing and repaying in one block earns nothing (`minSeasoning`), and even seasoned loops hit the per-epoch cap.

**Griefing by early default calls.** `markDefault` is permissionless but only after `dueAt + grace`. Anyone can also repay on the borrower's behalf, so a sponsor can cure a child's loan before the deadline.

## What this does not do yet

- **Pass-through liability.** A dead sponsor's children currently fall on the reserve, not on the grandparent. The alternative (locking the grandparent's delegation until the children settle) is sounder but adds a lot of state; the earned-only delegation rule makes it unnecessary for safety, at the cost of slower growth deep in the tree.
- **Interest pricing.** Fees are flat. A risk-priced fee (higher for young agents, lower for old ones) would make the pool profitable sooner. Pure function of the record, so it fits.
- **Partial default and cure.** All or nothing today.
- **Score weights.** Version 0. The point is that anyone can compute their own from the events; the on-chain score is a convenience, not an authority.

## The score

The original score, version 0, since superseded by `ScoreLib` v1 (dollar-days; README,
[How it works](../README.md#how-it-works)). Range 0..1000. Zero if defaulted.

| Term | Points |
|---|---|
| loans repaid | +30 each, max 300 |
| volume repaid | +1 per $5, max 300 |
| backing at risk (line + stake) | +1 per $5, max 150 |
| recourse loans honored | +50 each, max 100 |
| age enrolled | +2 per day, max 150 |
| vouched a defaulter | −75 each |

## Parameters

| Param | Default | Note |
|---|---|---|
| minLoan / maxLoan | $5 / $500 | |
| minTerm / maxTerm | 1d / 30d | |
| grace | 3d | after dueAt, before default can be called |
| recourseTerm | 14d | sponsor's deadline to cover a child |
| feeBps | 100 | 1% per 30 days, prorated |
| growthBps | 5000 | earned += 50% of repaid principal |
| maxEarnPerEpoch / epochLength | $25 / 7d | |
| maxEarned | $250 | per agent |
| minSeasoning | 1d | |
| minStake | $10 | to enroll as root |
| sponsorFeeBps / protocolFeeBps | 2500 / 2500 | fee split; the rest goes to lenders |

All owner-settable through `setParams`. The pool can be paused (no new credit; repayments and lender withdrawals always work).
