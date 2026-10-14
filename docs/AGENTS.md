# Priors for agent builders

Three calls give an agent a public credit history, built from repayments on chain. **Priors v2 is live on Robinhood Chain (4663).** The
v2 client is a thin ethers v6 wrapper in `sdk/priors-v2.mjs` (ABIs included, if you would rather call the
contracts), `sdk/env.mjs` resolves chain, addresses and signer, and the `priors-v2` CLI is one subcommand per step.

Everything below is the same procedure the skill (`skills/priors/SKILL.md`) hands to a coding agent. This page is
for you reading it yourself. Every role (lender, staker, backer) is in [PARTICIPATE.md](PARTICIPATE.md).

## 0. A wallet

```bash
npm install
cp .env.example .env      # PRIORS_KEY=0x… : the key that owns (or will own) the ERC-8004 identity
npx priors-v2 status
```

The wallet needs a little native gas, enough USDG to cover loan fees and, for a self-service treasury invite, a
5 USDG bond (below). Addresses come from
`deployments/4663.v2.json`; `RPC_URL` defaults to Robinhood Chain's official endpoint. **The pool never sees your
keys, only the agent id** and the signatures you choose to give. The `priors/…` imports below resolve inside the
clone; the repository is not published on npm under that name.

```js
import { resolveV2 } from "priors/env";
const { priors: s } = await resolveV2();     // PriorsV2 on the live v2 set, signer from PRIORS_KEY
```

No identity yet? `await s.register(uri)` mints one and returns its id.

## 1. Get a line

Every v2 line needs the agent owner's **pool consent**: an EIP-712 signature (domain `Priors Credit`, version `2`)
naming the sponsor and the most premium it may charge. Nobody can sponsor your agent without it. The SDK signs it
for you in each of these:

```js
await s.redeemInvite(agentId, inviteCode);   // treasury v4: $5. inviteCode = priors-invite:<id>:<expiry>:<signature>
await s.acceptSeat(agentId, stakerAddress);  // a staker's $PRIORS seat: $50 (the agent needs 10 repaid loans)
const { consent, sig } = await s.signConsent({ agentId, sponsorId, maxPremiumBps }); // hand to a backer
await s.openStockLine(agentId, token, "0.05"); // the stock vault: a line against your own stock tokens
```

- **Treasury invite.** Ask at [priors.trade/invite](https://priors.trade/invite). The self-service invite needs a
  5 USDG bond in `InviteBond` from the wallet that owns the agent, and proof of ownership to the Telegram bot; the
  bond comes back once the agent closes its treasury line with no loan open (the pool's `leave`, then the bond's
  `release`; since 2026-10-12, when the Safe set treasury v4's `minQualified` to 1,000,000), or after 4 days if the
  agent never gets a line, and goes to the Safe on a default. Otherwise an admin approves the invite. A code names one agent id,
  expires, and seats that agent once. Treasury v4 opens at most $100 of new lines per 7-day epoch; if the cap is
  spent, wait for the next one, find a backer, or open a stock line.
- **Seat.** A staker escrows a seat of $PRIORS (about five lines' worth) behind your id and the growth seat vault
  vouches a $50 line, on loans of at most 7 days. The staker earns the sponsor share of your fees and loses half the
  seat if you default, so it is someone's judgement too. The agent needs 10 repaid loans, so a brand-new agent starts
  with an invite, a backer or a stock line; the first seat vault's $5 seats (3 repaid loans) were all taken, 10 of
  10, as of 2026-09-29.
- **Backer.** Any root with USDG stake can vouch any size, at a premium of at most 2% per 30 days that your consent
  caps.
- **Stock line.** Deposit one of the 35 accepted Robinhood stock tokens (`s.stockAssets()` lists them with their
  price and loan-to-value) and the stock vault vouches 25-70% of its value by token, at most $500. New loans follow the
  collateral's value now; a default seizes what is owed plus a 20% buffer and gives the rest back; `s.closeStockLine(agentId)` gives the tokens back. It
  counts as your own money in Priors Score v2. See the README's "Stock lines".

Why the gates exist: a fresh identity costs cents, so money handed to one unconditionally is a faucet. An invite,
a seat or a backer is what makes a line cost someone's judgement.

## 2. Borrow, hold, repay

```js
const { fee } = await s.quoteFee(agentId, 5, 7 * 86400);            // about $0.011666: 1% per 30 days, pro rata
const { loanId, dueAt } = await s.borrow(agentId, 5, 7 * 86400);     // $5 for 7 days, USDG lands in your wallet
// ... do work ...
await s.repay(loanId, { agentId });                                  // principal + fee; refused if not agentId's loan
```

Loans shorter than 7 days are real loans, but they do not count as qualified loans for the score. The score
rewards dollar-days: how much you borrowed, times how long you held it, summed over everything you repaid.
Churning one-day loans gets you nowhere. Holding real money for real time does.

Paying per call with x402 instead of borrowing by hand: `s.pay(url, { agentId, maxBorrow })` pays from the
balance and borrows only the shortfall. See [FLOAT.md](FLOAT.md).

A line sponsored by SeatVaultV5 is raised only by `refresh(agentId)` on V5, from the owner's key or from a delegate key
24 hours after V5 recorded it, while that key is still the agent's delegate at the pool. Once `deployments/4663.v2.json` names V5 (`seatVaultV5`, `seatVaultV5AgentId`), `borrow`
and `pay` do this first; a key V5 has not recorded is recorded then, and borrows only within the line's current room
until its 24 hours have run. See [PARTICIPATE.md](PARTICIPATE.md), "A line sponsored by SeatVaultV5".

**A key for the agent.** `setDelegate(agentId, key)` on the pool lets another key borrow, repay and leave for the
agent (the agent page's Owner actions set it; the Priors account names the agent's key for you). It is bound to the
owner who named it: it does nothing while another wallet holds the agent, and it acts again if the agent comes back
to that owner. Before you sell or transfer an agent, clear it (`setDelegate(agentId, 0x0000000000000000000000000000000000000000)`),
and name a new key when you take an agent back.

## 3. Grow

The treasury's one raise to $25 (`raise(agentId)`, open to anyone, after three qualified loans, fourteen days on the
ledger, a score of 100 and a clean record) is on treasury v5 (`treasuryV5` in `deployments/4663.v2.json`) since
2026-10-14; treasury v4 raises nothing (its bar of qualified loans has been 1,000,000 since 2026-10-12). An agent with
a v4 line moves to v5 first: leave the v4 line (`leave`), take the v4 bond back (`release` on `InviteBond`), post a
5 USDG bond in `InviteBondV2` (`inviteBondV2`), and sign the pool consent for v5's root, which `move(agentId)` uses to
open a $5 line there without an invite. The bond stays for as long as the agent holds a line. Raises are bounded at
$100 a week. Beyond that, v2 has no unbacked "earned" credit: a bigger line means a bigger backer, with your consent.

```bash
npx priors-v2 move      # a v4 line: leave, the v4 bond back, the InviteBondV2 bond, move, then the raise
npx priors-v2 raise     # a v5 line: the raise, once the record qualifies
```

From JavaScript: `await s.moveToTreasuryV5(agentId)` and `await s.raise(agentId)`. The move checks everything before
it sends anything (no loan open, the record meeting v5's raise rules, the v4 bond at least 4 days old, room for a
first line on v5 this 7-day epoch) and sends only the steps not done yet, so after a failure you run it again. A raise
it cannot send now (v5's raise budget for the epoch used up) is left to the keeper, which raises qualifying v5 lines
every 30 minutes.

## Reading the record

```js
await s.status(agentId);     // sponsor, line, open loans, record
await s.loans(agentId);      // every loan, with status
```

`score(uint256)` and `creditReport(uint256)` are on `CreditLensV2` (the `lens` address in
`deployments/4663.v2.json`), same formula as v1. v1 history, imported into v2, is also still readable on the paused
v1 pool with `npx priors report <agentId>`.

## What ends it

Miss a due date by more than three days and anyone can mark the loan defaulted. The record is defaulted forever,
the identity can never borrow or back anyone again, the owner's address is marked, and the sponsor pays: its
shares are burnt for the principal and the fee, or half the staker's seat is burnt. A new identity costs little, but
it starts from zero, with no line and no record. There is no appeal, which is the point.

## Before you integrate for real

No third-party audit has reviewed v1 or v2. Read the Status section of the [README](../README.md) and
[SECURITY-v2.md](SECURITY-v2.md) first: they list what was found, what was fixed, and what remains.
