# Taking part in Priors v2: lenders, stakers, backers, agents

Pool v2 (`CreditPoolV2`), treasury v4 (`TreasurySponsorV4`) and the seat vault (`SeatVaultV3` since 2026-09-25, replacing `SeatVaultV2`) are **live on Robinhood
Chain mainnet** (chain 4663) since block 71,702,460. The v1 pool is paused; its record stays readable. The growth seat
vault, `SeatVaultV4` (`0xb1c3a04496238D62E3c93118C297163855e22192`, $50 lines), is live since
2026-09-29. Addresses are in [`deployments/4663.v2.json`](../deployments/4663.v2.json), and the SDK and the
`priors-v2` CLI read them from there, so nothing below needs an address typed by hand.

The same actions are on the site: [priors.trade](https://priors.trade) has a Participate page (deposit, seats,
roots), [/agent](https://priors.trade/agent) and [/invite](https://priors.trade/invite).

| Who | How they take part | Entry point |
|---|---|---|
| Lender | Deposit USDG into the pool, earn the lenders' share of every fee, withdraw | Participate page · `PriorsV2.deposit/withdraw` |
| Staker | Put a seat of $PRIORS behind an agent; the seat vault backs it; earn the sponsor share of its fees | Participate page · `PriorsV2.offer/closeSeat/claimSeatFees` |
| Backer | Run a root: stake USDG, vouch for agents (with their owner's signed consent), earn sponsor fees | Participate page · `PriorsV2.enrollRoot/vouchWithConsent/claimSponsorFees` |
| Agent | Register, get a line (a treasury invite, a seat, or a stock line against its own stock tokens), borrow and repay, pay x402 APIs on credit | `priors-v2` CLI · `PriorsV2` · [FLOAT.md](FLOAT.md) |

## What changed from v1

**Every line is 100% backed, always.** v1 had *earned* capacity: unbacked credit a first-loss reserve paid for on
a default. Every hard v1 finding lived there, so v2 drops it, and recourse loans with it. Capacity comes only from
a backer's locked pool shares. A default burns the backer's shares worth the loan's principal plus its fee; the
share price never falls, and lenders never take a loan loss. The trade is that lines grow only by finding bigger
backers, never by reputation alone.

Other v2 changes:

- **Consent.** A line needs the agent owner's EIP-712 signature (domain `Priors Credit`, version `2`). Nobody can
  vouch for your agent against your will, which closes v1's squat.
- **Handoff.** An agent can move to another sponsor whenever no loan is open, so no sponsor is stuck forever.
- **Timelock.** Since 2026-10-06 the pool's owner is the `PoolSteward`, which only the `TimelockController` can
  call (the Safe proposes and executes, no admin), and only within a fixed policy on the fee split and the reserve. The
  timelock's delay is 48 hours until 2026-10-11 19:49 UTC and none from then (the owner's decision of 2026-10-09): from
  then an owner call is still public on chain, but it can run in the block the Safe schedules it. The
  Safe is the guardian: it can pause new risk for at most 14 days at a time, and exits never pause.
- **History carried.** Every v1 record was imported (`importFromV1`), so repayments, volume and enrolment date
  survive; lines do not, as with every migration.

## Launch parameters (read from the chain)

| | |
|---|---|
| Loan size · term | $5 – $500 · 1 – 30 days |
| Fee | 1% per 30 days, pro rata, plus the sponsor's premium (0 for treasury and seat lines; at most 2% per 30 days) |
| Fee split | 50% lenders · 25% sponsor · 25% reserve |
| Grace before anyone can mark a default | 3 days |
| Qualified loan (counts for the score) | term ≥ 7 days |
| `keeperBounty` | **0** (see [SECURITY-v2.md](SECURITY-v2.md), F-1) |
| `maxUtilizationBps` | **10000** (N-2) |
| Lender hold | 7 days; withdrawing sooner leaves 0.5% for the lenders who stayed |
| Minimum root stake | $10 |
| Treasury v4 (root #6228) | first line $5 · raise to $25 after 3 qualified loans, 14 days, score ≥ 100 (on hold since 2026-10-12: `minQualified` 1,000,000) · $100 of new lines per 7-day epoch · idle lines reclaimed after 30 days |
| Seats V3 (root #6234) | seat ≈ $25 of $PRIORS, resized with the price by the SeatSizer `0xd24B…5E61` within [10,000, 2,000,000] (12,000 on 2026-09-25; 10,000, the floor, on 2026-09-29) · line $5 · 50% of the seat burnt on a default · at most 10 open seats (all 10 open on 2026-09-29) · $50 of new lines per 7-day epoch |
| Seat gates | the agent has repaid at least 3 loans; a seat idle 30 days can be expired by anyone |
| Growth seats V4 (root #6466, live since 2026-09-29) | seat ≈ 5 lines of $PRIORS (120,000 at deployment, resized by its own SeatSizer `0x97C4…8777` within [110,000, 20,000,000]) · line $50 · 50% of the seat burnt on a default · agent has repaid at least 10 loans · loans of at most 7 days · 20 open seats · $1,000 of new lines per 7-day epoch · protocol seats closed |
| Stock lines (`StockVault`, root #6424, since 2026-09-28) | 35 Robinhood stock tokens · line 25-50% of the deposit's Chainlink value by token (`deployments/stock-ltv.4663.json`), plus up to 15 points for a record of repaid treasury credit, never above 70% · at most $250 a line · $1,000 of open lines per token ($500 on CRCL, CRWV, NBIS, RGTI, SNDK, USAR) · $1,000 of new lines per 7-day epoch · the whole deposit seized on a default · a line idle 30 days (7 if never drawn) can be expired by anyone, tokens back |
| Invite bond (`InviteBond`) | 5 USDG locked by the agent's owner before the invite bot signs an automatic invite · back once the agent has repaid 3 qualified loans with none open, or after 4 days if it holds no line · forfeited to the Safe on a default |

The Participate page reads these live; if this table and the chain disagree, the chain is right.

## Agents: the `priors-v2` CLI

```bash
git clone https://github.com/priors-agents/priors && cd priors
npm install
export PRIORS_KEY=0x…        # the agent owner's key: environment or .env only, never argv, never printed
npx priors-v2 join                       # registers an ERC-8004 identity for this key if it owns none, prints its id
npx priors-v2 join --invite <code>       # redeems a treasury v4 invite: first line opened
npx priors-v2 join --seat <staker>       # or accepts that staker's seat offer instead (on the growth seat vault V4, else V3)
npx priors-v2 borrow 5 --days 7
npx priors-v2 repay --all
npx priors-v2 status
```

Run the `npx` commands inside the clone: there they run this repository's own CLI. Outside it, `npx priors` is an
unrelated npm package and `priors-v2` on npm is only a placeholder, so never run them with `PRIORS_KEY` set anywhere
else.

- **An invite names one agent id**, so a new key runs `join` first, gets its id, asks for an invite at
  [priors.trade/invite](https://priors.trade/invite), then redeems it. Redeeming signs the pool consent for the
  treasury's root in the same call.
- **Addresses** come from `deployments/<chainId>.v2.json`; `PRIORS_ADDRESSES` points at another file. On a real
  chain, a file that differs from the published deployment is refused unless `PRIORS_ALLOW_CUSTOM_ADDRESSES=1` is
  exported in the shell (a `.env` cannot set it).
  **RPC**: `PRIORS_RPC`, else `RPC_URL` (a comma-separated failover list, as for v1), else Robinhood Chain's
  official endpoint. On a real chain, an RPC that a `.env` names must be one of the public endpoints `.env.example`
  lists, unless it is exported in the shell or `PRIORS_ALLOW_CUSTOM_RPC=1` is (a `.env` cannot set it).
- **Identity lookup**: the key's identity minted to it since the v2 deploy, and never sent away since, is found
  automatically; an older one (for example a v1 agent), one transferred to the key, or one that left it and came back,
  needs `PRIORS_AGENT_ID`. `repay` pays only loans the agent's owner now took (GHSA-mmp8).
- **Two seat vaults**: with `seatVaultV4` in the record, `join --seat` takes the staker's offer on the growth seat
  vault (V4) if there is one, else on V3, and `status` reads the seat on whichever vault sponsors the agent.
- **Exit codes**: 0 done, 1 failed, 2 usage or configuration, 3 waiting on someone else (no seat offer yet).

⛔ **Repay before the due date.** Three days past due, anyone can mark the loan defaulted: the record is
permanently marked, the owner address is marked (`ownerDefaults`), and the sponsor pays for it: its stake, half the
staker's seat, or, on a stock line, the whole deposit. Borrow only what the agent can repay on time.

## SDK (`sdk/priors-v2.mjs`)

```js
import { resolveV2 } from "priors/env";            // chain, deployments/<chainId>.v2.json, PRIORS_KEY
const { priors: p } = await resolveV2();
// or by hand:
import PriorsV2 from "priors/v2";
const p2 = new PriorsV2({ signer, addresses });    // addresses = deployments/4663.v2.json
```

These imports resolve inside the clone (after `npm install` at its root); `priors` on npm is an unrelated package.

Amounts are USDG as a number or decimal string (`5`, `"12.5"`), or atomic 6-decimal units as a `bigint`.

- **Lender:** `deposit(amount)`, `withdraw(shares | "all")`, `position(addr)`.
- **Staker:** `offer(agentId)`, `withdrawOffer(agentId)`, `closeSeat(agentId)`, `claimSeatFees(to)`,
  `pendingSeatFees(addr)`, `seatable(id)`, `openSeats()`, `seatableAgents(ids)`, `seatOffer(agentId, staker)`. With
  `seatVaultV4` in the addresses (the deployments JSON has it), `offer`, `seatable` and `seatableAgents` use the
  growth seat vault; `withdrawOffer`, `acceptSeat`, `closeSeat`, the fees, `openSeats` and `status` find the offer or
  seat on whichever vault holds it (`acceptSeat`, `status` and each `openSeats` entry name it in `seatVault`).
- **Backer:** `enrollRoot(rootId, stake)`, `addStake(rootId, amount)`,
  `vouchWithConsent(sponsorId, agentId, line, premiumBps, consent, sig)`, `claimSponsorFees(sponsorId, to)`,
  `root(rootId)`.
- **Agent:** `register(uri)`, `signConsent({agentId, sponsorId, maxPremiumBps, deadline})`,
  `redeemInvite(agentId, code)`, `acceptSeat(agentId, staker)`, `quoteFee(agentId, amount, termSeconds)`,
  `borrow(agentId, amount, termSeconds, {to, maxFee})`, `repay(loanId)`, `openLoans(agentId)`, `status(agentId)`.
- **Stock line** (`addresses.stockVault`): `stockAssets()`, `stockPosition(agentId)`,
  `openStockLine(agentId, token, amount)`, `addCollateral(agentId, amount)`, `closeStockLine(agentId)`; token amounts
  are whole tokens as a number or decimal string, or raw units as a `bigint`.
- **Float:** `pay(url, {agentId, maxBorrow, maxPrice?, termSeconds?, maxFee?})` and `settleLoans(agentId)`,
  see [FLOAT.md](FLOAT.md).

Every write is simulated first, so a revert is explained with the contract's own custom error before any gas is
spent. Approvals are for the exact amount. `borrow` passes the pool's own quote as `maxFee`, and `repay` binds the
loan's agent and amount, so a changed premium or a wrong loan id reverts instead of costing more.

**A line sponsored by SeatVaultV5.** V5 vouches nothing when it opens a line: it raises the pool's vouch only on
`refresh(agentId)` from the agent's owner, or from the pool delegate V5 recorded (`noteDelegate(agentId)`, which
anyone may send) at least 24 hours earlier. With `seatVaultV5` and `seatVaultV5AgentId` (V5 and its root) in the
addresses, which the deployment record names once V5 is live, `borrow`, `pay` and `npx priors-v2 borrow` on a line
whose sponsor is V5's root take that step first (`v5BeforeBorrow` in `sdk/float.mjs`). The owner's key, or a key V5
recorded 24 hours ago, refreshes the line, and the borrow follows. A key V5 has not recorded yet is recorded now with
`noteDelegate` (it must control the agent on the pool, else `NOT_CONTROLLER`) and does not refresh, because a refresh
V5 may not raise on can lower the vouch. Until its 24 hours have run, such a key borrows only within the line's
current room; beyond it, `V5_DELEGATE_WAIT` says when it can (`readyAt`), and the owner can borrow before then. A
refresh that would revert stops with `V5_REFRESH_WOULD_REVERT` before anything is sent. Without both fields, nothing
changes.

**Reading records.** `CreditLensV2` exposes v1-shaped views on the v2 pool: `score(id)`, `creditReport(id)` and
`available(id)`. The v1 CLI (`npx priors score|report|loans`) still reads the v1 pool's history.

## Stakers: how a seat works

New seats go to the growth seat vault (V4): the agent needs 10 repaid loans, the line is $50 and loans last at most
7 days. V3 (3 repaid loans, $5 lines) is full (10 of 10 seats open as of 2026-09-29); its open seats run until they
close. Both vaults work the same way:

1. `offer(agentId)` escrows exactly one seat of $PRIORS under the vault's current terms. The offer is bound to
   the agent's owner at that moment (X-1 fix): if the identity is sold, the new owner cannot take it.
2. The agent's owner `accept`s it with a signed pool consent. The vault vouches the seat line out of its own USDG
   stake (the vault funder carries the credit risk; lenders never do).
3. While seated, the staker earns the sponsor share (25%) of every fee the agent pays, read exactly from the pool's
   per-agent ledger. `claimSeatFees` pays it out.
4. `closeSeat` (staker or agent) freezes the line; the seat closes, every token back, once no loan is open. A seat
   idle for 30 days (no loan open, no borrow or repay since it opened) can be `expire`d by anyone, tokens back to
   the staker (X-2 fix).
5. On a default, 50% of the seat is burnt and the rest returned.

An agent must have repaid at least 10 loans before it can be seated on V4 (3 on V3, the X-3 gate). That gate filters
trivial abuse; the seat's market value is what makes a stolen line a losing trade. See [SECURITY-v2.md](SECURITY-v2.md).

## Backers: running a root

`enrollRoot(rootId, stake)` turns an identity you own into a root with at least $10 of USDG locked as pool shares.
Locked shares earn lender yield like any other and back your lines 1:1. `vouchWithConsent` opens a line with the
agent owner's signed consent, optionally at a premium (at most 2% per 30 days) that you keep on top of the 25%
sponsor share. A default burns your shares worth the principal and the fee. `unlock` takes free backing out;
`retireRoot` ends a root that backs nothing.

## Deploying your own copy

`script/DeployV2.s.sol` deploys the original v2 set in order: a 48 h `TimelockController` (Safe as proposer and
executor, no admin; the live one's delay is 0 from 2026-10-11 19:49 UTC) as the pool's owner, `CreditPoolV2` with the v1 pool's params plus `maxUtilizationBps` 10000 and
`keeperBounty` 0 (`PoolV2Lib` is linked by forge), `CreditLensV2`, treasury v4 and `SeatVaultV2` (the seat vault
retired since 2026-09-25). It refuses an EOA as `SAFE` and writes `deployments/<chainId>.v2.json`. `SeatVaultV3`,
`SeatVaultV4`, the SeatSizers and the stock vault were deployed by separate maintainer scripts that are not in this
repository.

```bash
V1=0x… USDG=0x… REGISTRY=0x… PRIORS=0x… SAFE=0x… PONS_ESCROW=0x… PONS_FACTORY=0x… FEE_SINK=0x… \
  forge script script/DeployV2.s.sol --rpc-url <rpc> --broadcast --private-key <deployer>
```

`CreditPoolV2` compiles with via-IR at `optimizer_runs = 1` (a per-file restriction in `foundry.toml`) to fit the
24 KB code limit.
