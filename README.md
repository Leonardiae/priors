# Priors

[![@priors/mcp on npm](https://img.shields.io/npm/v/@priors/mcp?label=%40priors%2Fmcp)](https://www.npmjs.com/package/@priors/mcp)
[![@priors/x402 on npm](https://img.shields.io/npm/v/@priors/x402?label=%40priors%2Fx402)](https://www.npmjs.com/package/@priors/x402)
[![hosted MCP](https://img.shields.io/badge/MCP-mcp.priors.trade-0a7)](https://mcp.priors.trade)
[![ci](https://github.com/priors-agents/priors/actions/workflows/ci.yml/badge.svg)](https://github.com/priors-agents/priors/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![MCP Badge](https://lobehub.com/badge/mcp/priors-agents-priors)](https://lobehub.com/mcp/priors-agents-priors)

**Reputation for AI agents that is earned, public and recomputable: every point is real money held at risk for real time, and anyone can rebuild the number from the events.**

Reviews are cheap to fake. Priors keeps a public record built from on-chain repayments, and [Score v2](docs/SCORE-v2.md) counts only debt someone else put at risk. It is not unfakeable: the score's own page lists what each attack costs and what still gets through.

- **What it is:** an on-chain credit pool on Robinhood Chain where [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
  AI agents borrow USDG, repay it, and build a public credit record and score anyone can check. This repo has the
  contracts, the SDK and CLI, an MCP server, x402 payment helpers and an agent skill.
- **Who it is for:** builders of agents that pay for things (x402, USDG), and anyone deciding whether to trust, pay or
  lend to an agent.
- **Connect the hosted MCP** (read-only, no key, no transaction):
  `claude mcp add --transport http priors https://mcp.priors.trade/mcp`, or add `https://mcp.priors.trade/mcp` to any
  MCP client ([other clients](#or-connect-it-over-mcp)).
- **See an agent use it:** [agent001](https://github.com/priors-agents/agent001), an open-source agent with its own
  wallet and Priors credit line.
- **Hire an agent by the minute:** [agent002](https://github.com/priors-agents/agent002), worker agents that sell their
  time by the minute, paid in USDG over x402 or in $PRIORS.

[priors.trade](https://priors.trade) · a prior is what you believe about an agent before you deal with it. This
one is backed by money.

A small on-chain credit pool lends unsecured USDG ($5 to $500) to agents registered on
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004). Every line is backed, dollar for dollar, by someone who put
money behind that agent. Every repayment and every default is a public event. From those events you get a
credit-backed trust score anyone can query before trusting an agent, and a public record of which agents pay
their debts back.

Reviews are cheap to fake. Repaid debt isn't.

> ### Status: Priors v2 is live on Robinhood Chain
>
> Pool v2 (`CreditPoolV2`) and treasury v4 are **live on Robinhood Chain mainnet** (chain 4663) since block
> 71,702,460, and the seat vault (`SeatVaultV3`) since 2026-09-25. Addresses come from [`deployments/4663.v2.json`](deployments/4663.v2.json), so
> `npx priors-v2 status` and the SDK resolve them with no configuration. The v1 pool is **paused**; every v1
> repayment record was imported into v2, so agents kept their history. A second seat vault for bigger lines, the
> growth seat vault (`SeatVaultV4`, $50 lines), is live since 2026-09-29 and takes no new seats since 2026-10-09.
> `SeatVaultV5` is live since 2026-10-09 with owner-only backing (redeployed on 2026-10-11 with the fixes of GHSA-g626 and GHSA-8pxr): an agent's owner stakes its own $PRIORS to open the
> agent's line, which V5's root backs 100% in USDG. It has had internal reviews, no external audit.
>
> **What v2 changes.** v1 lent *earned* credit that nobody backed, and every hard v1 finding lived there. v2 drops
> it: every line is 100% backed by a backer's locked pool shares, a default burns that backer's shares worth the
> principal and the fee, and lenders never take a loan loss. Lines need the agent owner's signed consent, agents
> can change sponsor between loans, and the pool's owner is the PoolSteward, which only the timelock can drive.
>
> **The timelock's delay goes from 48 hours to none.** The owner decided it on 2026-10-09: the Safe scheduled
> `updateDelay(0)`, executable from 2026-10-11 19:49 UTC. Until then every timelock operation waits 48 hours, and
> the ones already scheduled keep their ready times. From then the Safe (2-of-3) can schedule and execute in the same
> block: the pool's owner calls through the steward (whose policy bounds still apply), the steward's handback, a stock
> vault upgrade, and the engines' and SeatVaultV5's timelocked settings. Each one is still public on chain, but there
> is no time to react before it runs.
>
> **Four ways onto the ledger.** A treasury invite (a $5 line from treasury v4, which is funded by $PRIORS creator
> fees), a **seat** (someone puts about five lines' worth of $PRIORS behind your agent and the growth seat vault
> backs a $50 line, after 10 repaid loans), a **backer** who stakes USDG and vouches for you directly, or, since
> 2026-09-28, a **stock line** (you deposit
> Robinhood stock tokens and the stock vault backs a line against them). Lenders deposit USDG and earn 50% of every
> fee.
>
> **What was found before launch, and fixed.** A self-backing loop that took lender yield (fixed with a fee lock),
> a utilization-cap freeze (cap set to 100%), a farmable keeper bounty (set to 0), and three seat-vault issues
> (offers bound to the owner, idle seats expire, a history gate plus a seat priced far above the line it opens).
> [`docs/SECURITY-v2.md`](docs/SECURITY-v2.md) lists every finding with its test and what remains.
>
> **What that does not buy:** v2 has had several internal adversarial reviews and a second-model review of the
> fixes, but **no third-party audit**. No path to lender principal was found, and that is still not a proof.
> Launch sizes stay small for exactly that reason. Read it, run it, integrate against it; size your exposure like
> someone who knows an audit hasn't happened.
>
> **Take part:** [priors.trade](https://priors.trade) has a Participate page (deposits, seats, roots),
> [/agent](https://priors.trade/agent) and [/invite](https://priors.trade/invite).
> [`docs/PARTICIPATE.md`](docs/PARTICIPATE.md) is the same for code.

---

## Give your agent a credit history on mainnet

```bash
git clone --recurse-submodules https://github.com/priors-agents/priors && cd priors
npm install
export PRIORS_KEY=0x…                    # the key that owns (or will own) the agent; env or .env only
npx priors-v2 join                       # registers an ERC-8004 identity for this key, prints its id
#   ask for an invite for that id at https://priors.trade/invite, then:
npx priors-v2 join --invite <code>       # treasury v4 opens a $5 line (you sign the pool consent)
npx priors-v2 borrow 5 --days 7          # $5 lands in your wallet
#   ... the agent does its work ...
npx priors-v2 repay --all                # principal + fee
npx priors-v2 status                     # line, loans, record
```

Run the `npx` commands inside the clone: there they run this repository's own CLI. Outside it, `npx priors` is an
unrelated npm package and `priors-v2` on npm is only a placeholder that prints these instructions, so never run
them with `PRIORS_KEY` set anywhere else.

The wallet needs a little native gas, enough USDG to pay the fee (about $0.012 on $5 for 7 days) and, for a
self-service invite, the 5 USDG bond (step 2 below). A brand-new agent cannot take a seat:
`npx priors-v2 join --seat <staker>` takes a staker's seat offer only once the agent has repaid 10 loans (new seats go
to the growth seat vault; SeatVaultV3's 10 seats were all taken as of 2026-09-29). Without an invite, a first line comes
from a backer or a stock line.

### Or watch it on a throwaway local chain first

```bash
git clone --recurse-submodules https://github.com/priors-agents/priors && cd priors
npm install
npm run quickstart
```

That starts a local chain, deploys the **v1** contracts with mocks, and walks one fresh ERC-8004 identity through
the entire record — register, take the treasury's $5 line, borrow, hold, repay, score. The local devnet has not
moved to v2 yet; the flow and the score have the same shape, the backing rules differ (v1's "earned capacity"
below does not exist on v2):

```
1. identity
   ERC-8004 agentId 2, owned by 0xEe7f…eeFf

2. first line
   line $5 from sponsor #1 — nobody approved this, it is a rule

3. borrow, hold, repay
   quote $5 for 7d: fee $0.011666, qualifies
   loanId 1 — $5 is in 0xEe7f…eeFf now
   … did work …

4. the record
   score 38/1000 · repaid 1 (1 qualified) · 35 dollar-days · fees paid $0.011666
   earned capacity $2.5 of its own, line now $7.5
```

Requires [Foundry](https://getfoundry.sh) and Node 20+.

### Records survive migrations

The v1 walkthrough was run for real on Robinhood Chain with real USDG, start to finish, through the CLI in
this repo, and its records have now moved twice.

Agent **#437** is the interesting one, because its record **survived the migration to the fixed
contract**. It repaid twice on the original pool; those two loans were carried across by
`importRecords`, and it has since borrowed and repaid again on the new one:

| step | transaction |
|---|---|
| borrow $5 for 8 days, on the new pool | [`0xff8c3e1f…`](https://robinhoodchain.blockscout.com/tx/0xff8c3e1fd89501fc901efa503a01099003a00f3668de46eb3551626d53386703) |
| repay principal + fee | [`0x0cfc083c…`](https://robinhoodchain.blockscout.com/tx/0x0cfc083c83eab43395465b7e9c95f36b430f23c3208e639bb56275508cd6c13d) |

`npx priors report 437` read the result back off the v1 pool: **3 loans repaid**, $15 of volume,
$0.036665 of fees paid, no defaults. At the v2 cutover every v1 record was imported again
(`importFromV1`), and on v2 agent #437 still shows its 3 repaid loans — the point of carrying
history rather than restarting it. Agent #443 came through the same way.

A record and a credit line are separate things, and a migration carries only the record: capacity
is not imported, so after a cutover an agent shows its full history with a `$0` line and no
sponsor until it asks the treasury for one (`firstLine`, which only the identity's own controller
can call). That is why a freshly migrated agent reads as `sponsor #0` for a while. On v2 it asks treasury v4 (an
invite), a staker (a seat) or a backer for a new line.

There is no demo mode in any of that — same contracts, same ERC-8004 registry, same USDG.

## Hand it to your coding agent instead

This repo ships the procedure as an agent skill, so you don't have to read any of it:

```bash
# Claude Code
mkdir -p ~/.claude/skills && cp -r skills/priors ~/.claude/skills/priors
```

Then say: **"give my agent a credit history on Priors"**. The skill knows the steps, which chain and pool it is
on, what to do when the treasury's epoch cap is spent, and that it must not claim an agent is registered when it
isn't. Codex and other harnesses read [`AGENTS.md`](AGENTS.md) at the repo root, which carries the same
instructions.

### Claude Code plugin

The skill and the hosted MCP server in one install. In Claude Code:

```
/plugin marketplace add priors-agents/priors
/plugin install priors@priors-agents
```

The skill runs as `/priors:priors`, and the read-only server connects as `plugin:priors:priors-read`, with no key. To
pay, borrow and repay with the agent's own wallet, add the local server too: [`skills/README.md`](skills/README.md)
has the command, which keeps the key in your environment.

### Or connect it over MCP

Read-only, hosted, no key: add `https://mcp.priors.trade/mcp` (Streamable HTTP) to any MCP client.

```bash
claude mcp add --transport http priors https://mcp.priors.trade/mcp    # Claude Code
codex mcp add priors --url https://mcp.priors.trade/mcp                 # Codex (terminal, IDE, ChatGPT desktop)
```

In Claude (web, desktop, phone), [this link](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Priors&connectorUrl=https%3A%2F%2Fmcp.priors.trade%2Fmcp)
opens the *Add custom connector* form with Priors filled in. VS Code installs it from
`vscode:mcp/install?{"name":"priors","type":"http","url":"https://mcp.priors.trade/mcp"}` (URL-encoded) or
`code --add-mcp '{"name":"priors","type":"http","url":"https://mcp.priors.trade/mcp"}'`, and Cursor from
`cursor://anysphere.cursor-deeplink/mcp/install?name=priors&config=` plus the base64 of `{"url":"https://mcp.priors.trade/mcp"}`.
ChatGPT takes it in developer mode (Settings, Security and login), on its plugins page, with no authentication.

It answers an agent's record and score, the pool's figures, recent loans and the facilitator's services, and it
cannot sign or send anything. It is also an MCP App: in hosts that render MCP Apps (Claude, ChatGPT, VS Code, Cursor,
Goose) its answers come with a Priors view, and `request_borrow` / `request_repay` prepare a borrow or a repayment as
two links where the agent's owner confirms it: Go mode (go.priors.trade), with their own account, or the agent console
on priors.trade, with the wallet that owns the agent. To pay x402 URLs, borrow and repay with the agent's own wallet, run the local server in
[`packages/mcp`](packages/mcp) (the key stays in your environment). Both packages are on npm:
`npx -y @priors/mcp` runs the local server, and `npm i @priors/x402` installs the payer. From a clone,
`npm install` at the root links them instead. The local server is also on the official MCP Registry as
`io.github.priors-agents/priors`, and the hosted one as `io.github.priors-agents/priors-read`. Since 0.5.0 the wallet
can also keep idle USDG in savings (a USDG vault on Morpho: the agent's own money, with the vault's risks; see
[`packages/x402`](packages/x402)), and a borrow on a SeatVaultV5 line refreshes it first. Autopay (repaying each loan on
time from the agent's wallet) is in the packages and refuses to run until AutoRepay v2 is deployed. 0.2.11 carries
0.5.0's security fixes for those staying on the 0.2 line.

### Or pay per call

The same record is a paid x402 v2 endpoint: `https://api.priors.trade/v1/report/{id}` and `/v1/score/{id}`, 0.03 USDG
each on Robinhood Chain, settled through `https://facilitator.priors.trade`. An unpaid call answers 402 with the
requirements in its `PAYMENT-REQUIRED` header; [`packages/x402`](packages/x402) pays it (`createPayer({ signer }).pay(url)`).
Merchants can sign up for the facilitator themselves at `https://x402.priors.trade/merchants`. A merchant can also
check who is paying before serving them. `recordGate` in `@priors/x402` reads the payer's Priors record before the
facilitator sees the payment, and can refuse defaulters, ask for repaid loans or price by record. A refused payment
moves nothing ([`packages/x402`](packages/x402#merchant-check-who-is-paying-record-gate)).

## The four steps (v2)

| | | |
|---|---|---|
| **1** | **identity** | `register(uri)` on the ERC-8004 registry, once. Your NFT is your identity. Already have an id? Skip this (set `PRIORS_AGENT_ID` if it predates v2 or was transferred to you). The pool never sees your keys, only the id. |
| **2** | **a line** | **Treasury invite:** at [priors.trade/invite](https://priors.trade/invite) you post a 5 USDG bond in `InviteBond` from the wallet that owns the agent, prove you own it to the Telegram bot, and the bot signs treasury v4's invite for your id on the spot; you redeem it with your pool consent → $5 (at most $25 of new treasury lines a week). The bond comes back once the agent has repaid 3 qualified loans with none open, or after 4 days if it never gets a line; a default sends it to the Safe, so taking a first line and walking away nets nothing. **Seat:** a staker offers a seat of $PRIORS on your id and you accept it → $50 on the growth seat vault, loans of at most 7 days (your agent needs 10 repaid loans first). **Backer:** a root vouches any size with your signed consent. **Stock line:** you deposit accepted Robinhood stock tokens and the stock vault backs a line against them (see "Stock lines" below). |
| **3** | **borrow, hold, repay** | `quoteFee` → about $0.011666 for $5 over 7 days. `borrow` → USDG in your wallet. Do work. `repay` → principal + fee. Under 7 days repays fine but does not count: dollar-days are the score. |
| **4** | **grow** | Treasury v5 `raise(agentId)` → $25, after 3 qualified loans, 14 days, score ≥ 100 and a clean record (since 2026-10-14; an agent on a v4 line moves there first with `move`, and its own 5 USDG `InviteBondV2` bond, which stays as long as the line; treasury v4 raises nothing since 2026-10-12). Beyond that, lines grow by finding a bigger backer: v2 has no unbacked "earned" credit. |

```bash
npx priors-v2 join [--invite <code> | --seat <staker>]   # identity, then a line
npx priors-v2 borrow <amount> [--days N]
npx priors-v2 repay [--all]
npx priors-v2 status
npx priors-v2 move                # an agent on a treasury v4 line: to treasury v5, then the raise to $25
npx priors-v2 raise               # an agent on treasury v5's line: the raise to $25, once its record qualifies
npx priors score <agentId>        # v1 CLI, still reads the paused v1 pool's history
npx priors report <agentId>
```

Or from JavaScript, on ethers v6, inside the clone (the `priors/…` imports resolve to this repository there; it is not
published on npm under that name):

```js
import { resolveV2 } from "priors/env";          // deployments/<chainId>.v2.json, RPC_URL, PRIORS_KEY
const { priors } = await resolveV2();
await priors.redeemInvite(agentId, inviteCode);  // priors-invite:<id>:<expiry>:<signature>
const { loanId } = await priors.borrow(agentId, 5, 7 * 86400);
await priors.repay(loanId, { agentId });
await priors.status(agentId);
// x402: pay per call, borrowing only the shortfall from the line (docs/FLOAT.md)
await priors.pay("https://merchant.example/api", { agentId, maxBorrow: 5_000000n });
```

[`docs/PARTICIPATE.md`](docs/PARTICIPATE.md) covers every role (lender, staker, backer, agent);
[`docs/FLOAT.md`](docs/FLOAT.md) covers x402 payments on credit and the public facilitator at
`https://facilitator.priors.trade`; [`docs/AGENTS.md`](docs/AGENTS.md) is the guide for agent builders.

**A whole agent instead:** [agent001](https://github.com/priors-agents/agent001) holds its own wallet, joins Priors,
borrows and repays before the due date by itself, sells a service over x402, and talks from a terminal or Telegram. Its
money moves go through `@priors/mcp`. `agent001 sandbox` runs the whole loop on a local fork with play money. It also
carries a Priors skill for OpenClaw and Hermes Agent ([`skills/priors`](https://github.com/priors-agents/agent001/tree/main/skills/priors);
in Hermes, `hermes skills install priors-agents/agent001/skills/priors`): check an agent's record before paying it, and
pay, borrow and repay with the MCP tools.

## Stock lines

Since 2026-09-28 the stock vault (`StockVault`, root #6424) backs a line with the agent's own Robinhood stock tokens.
The agent's owner deposits one of the 35 accepted tokens (listed with their Chainlink feeds in
[`deployments/stock-assets.4663.json`](deployments/stock-assets.4663.json)) and the vault vouches a line of that
token's loan-to-value: 25-70% of the deposit's value by token, plus up to 15 points for a record of repaying treasury
credit, never above 70%, at most $500. Loans on it are ordinary pool loans, with the same fee, terms and default rules. Every new loan is
checked against the collateral's value now, so a falling price shrinks what can be drawn, and new credit waits during
a lending hold (a sharp price move, a multiplier change such as a split, a paused or blocked token). The price hold
compares the latest price with every round of the last 14 days through a price tape kept by the vault's `holds()`
contract: anyone may record it (`record(feed, maxRounds)`, which only reads the feed), Priors' keeper records every
feed every 10 minutes, and while more than 6 rounds of a token's window are not recorded, new credit on it waits
(shown as the price hold) until someone records. Closing gives
every token back, at once with no loan open, otherwise with the last repayment; a line unused for 30 days (7 if
never drawn) can be closed by anyone. A default seizes tokens worth what the agent owes (principal and fees) plus a 20%
buffer, at the last valid price, and gives the rest back to the depositor; with no usable price, or a deposit worth
less, it seizes all of them (the fair default, since 2026-10-13). While the token's price tape is behind, the seizure
waits instead: the position stays open with its whole deposit, and `settle` seizes what is owed plus 20% once anyone
has recorded the tape (SV-19, since 2026-10-18).

```js
import { resolveV2 } from "priors/env";
const { priors } = await resolveV2();                    // the vault's address comes from deployments/4663.v2.json
await priors.stockAssets();                              // each token's price, whether the vault lends now, its LTV
await priors.openStockLine(agentId, spyToken, "0.05");   // deposit 0.05 SPY and open the line (signs the consent)
const { loanId } = await priors.borrow(agentId, 5, 7 * 86400);
await priors.repay(loanId, { agentId });
await priors.closeStockLine(agentId);                    // every token back to the depositor
```

`status(agentId)` shows the tokens behind a stock line. `@priors/mcp` (`stock_assets`, `stock_position`) and
`@priors/x402`'s credit helpers read the vault too, since 0.2.0; 0.2.1 carries the
security fixes of the private reports. A stock line counts as the borrower's own money in Priors
Score v2 (weights 2.0.1). The tokens are Robinhood's, under its own terms (including where they may be held), and
their issuer can pause, block, burn or upgrade them. The vault is the one upgradeable Priors contract: what its owner,
the Safe, can and cannot do is in [`docs/SECURITY-v2.md`](docs/SECURITY-v2.md#stockvault).

## What ends it

Miss a due date by more than **three days** and anyone can mark the loan defaulted. The record is marked defaulted
forever, the identity can never borrow or back anyone again, and the owner's address is marked too. The sponsor
pays: a backer's (or the treasury's) locked shares are burnt for the principal and the fee; on a seat, half the
staker's $PRIORS is burnt. Your branch burns in the grove on [priors.trade](https://priors.trade), in public, and
stays burnt.

There is no appeal. That is why the score means something.

## How it works

- **Every line is 100% backed.** Capacity comes only from a backer's USDG, locked as pool shares. Locked shares
  earn lender yield like any other and back the lines their root vouches, 1:1. A default burns the backer's shares
  worth principal and fee, so the share price never falls and lenders never take a loan loss.
- **Consent and handoff.** A line needs the agent owner's EIP-712 consent, so nobody is sponsored against their
  will. With no loan open an agent can move to another sponsor, so no sponsor is stuck forever.
- **Four kinds of backer.** Treasury v4 (root #6228) is funded by $PRIORS creator fees and vouches by rule:
  $5 against an invite, $25 once seasoned, at most $100 of new lines per week, idle lines reclaimed after 30 days.
  The seat vault (SeatVaultV3, root #6234) backs a $5 line behind an agent with 3 repaid loans that a staker puts a seat
  of $PRIORS on; its 10 seats were all taken as of 2026-09-29, so new seats go to the growth seat vault (below). Stakers earn
  the sponsor share of that agent's fees and lose half the seat on a default. The stock vault (StockVault, root
  #6424) backs a line against the agent's own stock tokens and seizes them on a default. Anyone can run a root with
  $10+ of stake and vouch with consent, at a premium of up to 2% per 30 days. The growth seat vault (SeatVaultV4,
  root #6466) is live since 2026-09-29: the same seats for a $50 line, for agents with 10 repaid loans, on loans of
  at most 7 days ([`docs/PRIORS-GROWTH-SEATS.md`](docs/PRIORS-GROWTH-SEATS.md)).
- **One money loop.** Loan fees split 50 / 25 / 25 between lenders, the sponsor, and the reserve.
- **A score that is a pure function of the record.** `score(agentId)` and `creditReport(agentId)` on
  `CreditLensV2`, the same formula as v1, and every input is an event you can recompute yourself. Score v1 is
  dollar-days: principal × how long you actually held it (capped at the contracted term), summed over repaid loans
  — up to 400 points. Plus qualified loans (term ≥ 7 days, 20 points each, up to 200), backing (up to 150), age (up
  to 150). Your own default is 0, always. The cheapest path to a high score is the honest one: borrow a meaningful
  amount, hold it for weeks, repay.
- **Priors Score v2, off chain and open.** Live since 2026-09-27 at `https://priors.trade/api/score-v2`, in the paid
  API and in both MCP servers: it counts only risk someone else took, lateness, x402 income from payers that aren't
  the agent's own, and trust rungs that need time. Engine, weights and tests are in `sdk/` and `scripts/`; how it
  works and what stops gaming it: [`docs/SCORE-v2.md`](docs/SCORE-v2.md). The on-chain score above is unchanged.
- **Check an agent before you deal with it.** `https://priors.trade/api/check?agent=<id>` or `?address=<0x…>`: free,
  no key, CORS open. It returns the agent's repayment record and score, and a README badge at
  `https://priors.trade/api/badge/<id>.svg`. See [`docs/CHECK-API.md`](docs/CHECK-API.md).
- **Read the score on chain, with its evidence.** Priors posts each agent's v2 score to the ERC-8004 reputation
  registry; since 2026-10-05 each note carries its own file (the line at a block, on-time repayments with their
  transactions, the pool's payment to the agent), hashed on chain. `node scripts/verify-attestation.mjs <agentId>`
  checks one from the chain alone: [`docs/ATTESTATION-v2.md`](docs/ATTESTATION-v2.md).

[`docs/DESIGN.md`](docs/DESIGN.md) has the v1 math and attacks; [`docs/SECURITY-v2.md`](docs/SECURITY-v2.md) the
v2 findings.

## The parameters, as the contracts set them

| | |
|---|---|
| Loan size | $5 – $500 |
| Term | 1 – 30 days |
| Fee | 1% per 30 days, pro rata, plus the sponsor's premium (0 on treasury and seat lines) |
| Fee split | 50% lenders · 25% sponsor · 25% reserve |
| Lender hold period | 7 days. Withdrawing sooner leaves **0.5%** behind for the lenders who stayed |
| Grace before anyone can default you | 3 days |
| Counts as a qualified loan at | 7 days |
| `maxUtilizationBps` · `keeperBounty` | 10000 · 0 |
| Treasury v4 | first line $5 · $100 of new lines per 7-day epoch · idle after 30 days · raises nothing since 2026-10-12 |
| Treasury v5 | `move` from v4 with an `InviteBondV2` bond · raise to $25 · $100 of raises per 7-day epoch · no invites |
| Seats (`SeatVaultV3`, root #6234) | seat ≈ $25 of $PRIORS (12,000 on 2026-09-25, resized with the price by the SeatSizer) · line $5 · 50% burnt on default · agent needs 3 repaid loans · seat expires after 30 idle days · $50 of new lines per 7-day epoch |
| Growth seats (`SeatVaultV4`, root #6466; live since 2026-09-29) | seat ≈ 5 lines of $PRIORS (120,000 at deployment, resized by its own SeatSizer within [110,000, 20,000,000]) · line $50 · 50% burnt on default · agent needs 10 repaid loans · loans of at most 7 days · 20 open seats · seat expires after 30 idle days · $1,000 of new lines per 7-day epoch · protocol seats closed |
| Stock lines (`StockVault`, root #6424) | 35 stock tokens · line 25-70% of the deposit's value by token, plus up to 15 points for a record of repaid treasury credit, never above 70% · at most $500 a line · $1,000 of new lines per 7-day epoch · $2,000 of open lines per token ($1,000 on CRCL, CRWV, NBIS, SNDK, USAR; $500 on ASML, IONQ, RKLB; none on CLSK, RGTI) · on a default, what is owed plus 20% seized and the rest given back · idle after 30 days (7 if never drawn) |
| Minimum root stake | $10 |
| Pool owner | `PoolSteward` since 2026-10-06 (no owner, not upgradeable), which only the `TimelockController` can call (the Safe proposes and executes, no admin; a 48 h delay, none from 2026-10-11 19:49 UTC), within a fixed policy: sponsor ≤ 25%, reserve ≤ 40%, lenders ≥ 35%, fee ≤ 2% per 30 days; the Safe is guardian (pause ≤ 14 days, exits never pause) |

## Robinhood Chain

The target chain is [Robinhood Chain](https://docs.robinhood.com/chain/) mainnet (id 4663).

| | Address |
|---|---|
| **CreditPoolV2** (live) | `0x281210097f0de7A8FB6F87310AF0f089c9C8DE21` |
| **CreditLensV2** (score and report views) | `0x9d7035722bd42C551f82FEB9FDDd17453AEF3D9B` |
| **TreasurySponsorV4** (live, root `#6228`, invite-gated) | `0x0c5091235A25bBFD3F5a009cBe04120D0CBAD573` |
| **SeatVaultV3** (live since 2026-09-25, root `#6234`) | `0x59D155C42A9263fA7596867b992bB3e84dF680a9` |
| SeatVaultV2 (retired and paused, root `#6229`; replaced by V3 for audit V-2) | `0x6D934C07a33E7285cE691A9B258cdB53F18e6B5F` |
| PoolSteward (owns the pool since 2026-10-06; only the timelock can call it) | `0x6D9D4135417E0AB2aafc69Fc842525Af279a5Da8` |
| TimelockController (drives the PoolSteward; 48 h delay, none from 2026-10-11 19:49 UTC) | `0x5d984C274035F81BB327d532897a902C5125F87c` |
| **SeatSizer** (owns the seat vault since 2026-09-26; resizes the seat from the $PRIORS price, within bounds) | `0xd24B6484f4E68d72Fd2d3AF7bD036560B2ed5E61` |
| **SeatVaultV4**, the growth seat vault (live since 2026-09-29, root `#6466`) | `0xb1c3a04496238D62E3c93118C297163855e22192` |
| SeatSizer of the growth seat vault (owns it; the Safe owns the sizer) | `0x97C4e594D458f8BBE961d5384Bbd8a9Cc2D18777` |
| **SeatVaultV5** (live since 2026-10-11, root `#8762`; owner-only backing; it replaced the deployment of 2026-10-09, `0xdE29D3A627d77CFA13c5331C1B7B181a4C5B752E`, root `#8641`, which never had a book and whose root's USDG moved to it) | `0xC999014C6218EC41f0aE412d49AE8f2aA4c539fD` |
| SeatVaultV5's linked libraries (`src/v5/`; V5 calls them by DELEGATECALL) | `V5Pos` `0xd2d393Daf7bABE6ac090a97765407256673Bf9Bc`, `V5Steps` `0x3a4B951E0eae25DD327224395ecE0C6fD6345f94`, `V5Book` `0x90992387BbfBcF6aB179B33535d283FEE2d832F4`, `V5Records` `0x23C3660Cd36401F6adE16f51f81F629a6aE6d826`, `V5Exit` `0x0BB0CF27E9a0f5DB38a3F58fc31b1f90D784CbC7`, `V5Auto` `0x22914DF387771bCB167Bfd1777678887D1AB1375`, `V5Sync` `0x2FE6cC16DA24694D48BbDD8C83d4732ca23276F4`, `V5View` `0xE5175D7C9C30E210197D23A45A3e0bbe66cF1846`, `V5Lens` `0x294a483e54aBE64d2037df370974304C0F3B09F7` |
| **StockVault** (live since 2026-09-28, root `#6424`; lines against stock tokens; a Transparent proxy, `StockVaultProxy`) | `0xbEcd07EC689988e16b870C121756C4c2C8cb02B6` |
| StockVault implementation (behind the proxy; since 2026-10-18) | `0xd30396A79D6b5BDB86D09B8c7907aD2820a42c72` |
| StockVault ProxyAdmin (the only way to upgrade the vault; owned by the timelock since 2026-10-07, by the Safe before; with no delay from 2026-10-11 19:49 UTC) | `0x5174A18550a295cd25aF59416a56B7e4c38C8Afc` |
| Safe (2-of-3; proposes to the timelock, owns treasury v4 and both SeatSizers, so every other seat vault power, and the stock vault's settings) | `0x20c6816B2419616238772591965E6E9AbE493fD5` |
| RevenueRouter (the steward's sweep and the vaults' fees go here) | `0xb2E217C5841a968C48Eee41DCbF7D2a03cCA4F43` |
| BuyAndBack (engine 1) | `0xEe40675aBEC90E52211526845433C10c80fD569E` |
| PriorsLiquidity (engine 2) | `0xbEC159832D05749557F3f972c4823979C8dC8451` |
| SwapLimiter (the engines' depth guard) | `0x4535b1d92ebBe8176463dE4b58Ca9B66A231eb0E` |
| KeeperHelper (SeatSizerV4's keeper since 2026-10-06; the keeper key's one entry point) | `0x3Ba233d2ac1C6233C5fA954C2DaaD83fcCFE5372` |
| InviteBond (the bond an automatic invite needs; no admin) | `0x8BE478c754D9124D11e78dB20F5bf4dA45403275` |
| ERC-8004 Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| USDG (Robinhood's 6-decimal dollar, the pool asset) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| $PRIORS token (Pons V2) | `0xeDBf91223639800BCd5756815CAf908Df3b890bE` |
| x402 facilitator | `https://facilitator.priors.trade` (merchant sign-up: `https://x402.priors.trade/merchants`) |
| Hosted MCP (read-only) | `https://mcp.priors.trade/mcp` |
| Paid API (x402 v2, 0.03 USDG) | `https://api.priors.trade` |
| RPC (official; the only one that serves `eth_getLogs`) | `https://rpc.mainnet.chain.robinhood.com` |
| RPC backups, for plain calls | `https://robinhood-rpc.publicnode.com`, `https://rpc.ordofi.network` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| ~~CreditPool~~ v1 (**paused**, superseded by v2; history imported) | `0x0259889e6EBab1a18CeE7e62Bc5B9648FB6C44e5` |
| ~~TreasurySponsor~~ v3 (v1 pool, superseded by v4, sponsor `#486`) | `0x59f212317b42D308E81EaF8C078fc8189E2a77Df` |
| ~~TreasurySponsor~~ v2 (v1 pool, superseded, sponsor `#461`) | `0x9338d18b5E7faC5ce06a6AD1Af33Db68fE0b4daC` |
| ~~ReserveFunder~~ (v1) | `0x32349B1Ad07513B5Fa6dCC3dbDC0B5ed17FcB72d` |
| ~~CreditPool~~ (older v1 pools, paused, do not use) | `0x4B9fb2dE6BE54aF037683A75F3C82c81C3EEd122`, `0xd970472b2904D5923882af034cea4067AF0AaC95` |

Addresses resolve from `deployments/4663.v2.json` (v2) and `deployments/4663.json` (v1, kept for history and
marked paused), so nothing above needs copying by hand. The superseded contracts are listed only so an old link is
recognisable as dead rather than mysterious.

### Why lenders have a hold period

The lender slice of a fee lands on the share price the moment a loan is repaid, so whoever holds shares
at that instant collects it. An audit showed both ways that was abused: a bot depositing in front of a
repayment and leaving straight after took **$2.70 of a $3 lender fee**, leaving $0.30 for the lender who
had carried thirty days of default risk — and a *borrower* could wrap its own repayment in a deposit and a
withdrawal, in one transaction, and recover **54% of its own fee**.

Leaving inside 7 days now leaves 0.5% behind, which stays in the pool for the lenders who did not leave.
That is enough to make a zero-duration position lose money: the borrower's sandwich costs $549.54 against
the $505.00 it owed. It is a **constant in the contract, not a parameter**, in v1 and v2 alike — an
owner-tunable exit fee would be a lever to confiscate deposits, and the owner cannot reach lender principal
here. Hold past 7 days and it is zero. The 7 days run on one clock per wallet, weighted by shares, so money added to
a wallet whose older shares are well past their 7 days can leave sooner without the fee (up to H·(age − 7 d)/7 d for H
of shares aged `age`), and a root's stake never pays it: either way a position held only across one repayment or
default takes a share of that one event's fee, the bound `docs/SECURITY-v2.md` states (F-2, SO-2, O-6).

`RPC_URL` accepts a comma-separated list and tries it in order — the first entry first, the next only
when that one fails or refuses to serve the request:

```bash
RPC_URL=https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com,https://rpc.ordofi.network
```

Worth doing: the official endpoint rate-limits under load, and a 429 there is otherwise the end of the
read. The backups take plain calls happily but **cannot serve event history** — publicnode answers 403
`Archive requests require a personal token` and ordofi answers `-32005 the network is busy` — so anything
reading logs still needs the official endpoint reachable. The SDK knows the difference: a node refusing
to serve moves to the next entry, while a revert is returned as-is, because a revert is the chain's
answer and identical everywhere.

## Standards

The parts of Priors that another lender, a wallet or a reader would need are written up as draft ERCs, each with a
reference implementation and tests. Each carries the next ERC number that was free on 2026-10-20, ERC-8449 to
ERC-8458; none is submitted yet, and the ERC editors confirm each number, or assign another, when its pull request opens
on ethereum/ERCs. Each is discussed on Ethereum Magicians; the credit profile's thread is
[ERC-8449](https://ethereum-magicians.org/t/erc-8449-credit-history-for-erc-8004-agents/30022).

| Draft | What it covers | State |
|---|---|---|
| [ERC-8449 Credit history for ERC-8004 agents](docs/ERC-8004-CREDIT.md) | Loan outcomes as ERC-8004 feedback that any reader can rebuild from the lender's own logs, with on-chain manifests as ERC-8092 associations | draft, not yet submitted to ethereum/ERCs |
| [ERC-8450 Agent Credit Lines](https://github.com/priors-agents/ERC-8450) | One interface to quote, borrow, repay and default against any lender to agent identities | draft, not yet submitted to ethereum/ERCs |
| [ERC-8451 Agent Repay-First Payees](https://github.com/priors-agents/ERC-8451) | An agent's revenue address that pays its creditors before its owner, and token holders after them | draft, not yet submitted to ethereum/ERCs |
| [ERC-8452 Agent Default Registry](https://github.com/priors-agents/ERC-8452) | Lender-reported defaults that any contract can count against the reporters it trusts | draft, not yet submitted to ethereum/ERCs |
| [ERC-8453 Creator Fee Rights](https://github.com/priors-agents/ERC-8453) | A launched token's creator fee stream, with a recipient only the recipient can change, so it can be pledged | draft, not yet submitted to ethereum/ERCs |
| [ERC-8454 Liquidity Locks](https://github.com/priors-agents/ERC-8454) | One interface for any contract that locks pool liquidity, read by scanners, launchpads and lenders | draft, not yet submitted to ethereum/ERCs |
| [ERC-8455 Launch Declarations](https://github.com/priors-agents/ERC-8455) | What a launchpad declares at launch (creator identity, allocations, liquidity lock, financing, fee recipient), on ERC-8376's launches | draft, not yet submitted to ethereum/ERCs |
| [ERC-8456 Agent Credit Backers](https://github.com/priors-agents/ERC-8456) | Third parties that stand behind a lender's line to an agent and take its loss | draft, not yet submitted to ethereum/ERCs |
| [ERC-8457 Credit-Matched Liquidity](https://github.com/priors-agents/ERC-8457) | A lender funds the quote side of a holder's pool position in an escrow, repaid from fees first (reference not audited) | draft, not yet submitted to ethereum/ERCs |
| [ERC-8458 Agent Income Statements](https://github.com/priors-agents/ERC-8458) | Public, chained statements of what an agent's ERC-8004 wallet received, one leaf per transfer, rebuildable from the token's logs | draft, not yet submitted to ethereum/ERCs |

## Repository

```
src/CreditPoolV2.sol         v2 pool: lenders, backers (roots), consent, handoff, fee lock, 100% backing
src/libraries/PoolV2Lib.sol  v2 pool's linked library (hooks, consent digest)
src/CreditLensV2.sol         v1-shaped score and credit-report views on the v2 pool
src/TreasurySponsorV4.sol    the $PRIORS treasury as a v2 root: invite + consent opens a line, rules size it
src/SeatVaultV3.sol          $PRIORS seats: a staker's tokens behind an agent, the vault backs its line (live)
src/SeatVaultV4.sol          growth seats: V3 plus the slash split, protocol seats, a loan-term cap (live; no new seats)
src/SeatVaultV5.sol          the owner's own $PRIORS behind its agent's line, the root's USDG backing it (live, owner-only)
src/v5/                      SeatVaultV5's linked libraries (V5Book, V5Records, V5Exit, ...) and its storage, types, math
src/SeatSizer.sol            owns a seat vault: keeps the seat at ~5 lines of $PRIORS from the pool price (live)
src/SeatVaultV2.sol          the previous seat vault (retired; V3 closes audit V-2)
src/InviteBond.sol           the bond behind an automatic invite: back after seasoning, to the Safe on default
src/StockVault.sol           lines against Robinhood stock tokens: per-token LTV, lending holds, seizure on default (live)
src/StockVaultProxy.sol      the stock vault's Transparent proxy; its ProxyAdmin (the timelock's since 2026-10-07) alone upgrades it
src/PoolSteward.sol          the pool's owner since 2026-10-06: the timelock's calls against a fixed policy, the daily sweep
src/RevenueRouter.sol        where the sweep and the vaults' fees go, and their split
src/BuyAndBack.sol           engine 1: buys $PRIORS on its Pons pool
src/PriorsLiquidity.sol      engine 2: $PRIORS liquidity
src/SwapLimiter.sol          the engines' depth guard (src/libraries/PoolDepth.sol, EngineMath.sol)
src/KeeperHelper.sol         the keeper key's one entry point: SeatSizerV4's price and the limiter's depth snapshot
src/GuardianPause.sol        the guardian pause the engines share
src/CreditPool.sol           v1 pool (paused; its records were imported into v2)
src/TreasurySponsor.sol      v1 treasury (v3)
src/ReserveFunder.sol        v1 creator-fee sweep into the reserve
src/libraries/ScoreLib.sol   the trust score (shared by v1 and the v2 lens)
src/mocks/                   MockUSDC (6 decimals), MockIdentityRegistry, MockPonsFeeEscrow
test/                        1,130 tests: v2 units, invariants, audit PoCs and fixes (audit-v2/, audit-final/,
                             review-v2/, audit-v4/, audit-r2/, audit-sizer/), the stock vault's (StockVault*), the growth seat
                             vault's (SeatVaultV4*), SeatVaultV5's (v5/), and the v1 suite
script/DeployV2.s.sol        deploys the v2 set under a 48 h timelock (the live one's delay is 0 from 2026-10-11 19:49 UTC),
                             writes deployments/<chainId>.v2.json
script/Deploy.s.sol          v1 deploy (mocks on dev chains), writes deployments/<chainId>.json
sdk/priors-v2.mjs            the v2 client on ethers v6, ABIs included
sdk/stock-vault.mjs          stock-vault reads: accepted tokens, prices, holds, a line's collateral
sdk/float.mjs                x402 pay() that borrows only the shortfall; sdk/x402.mjs has the payload constants
sdk/priors.mjs               the v1 client
sdk/env.mjs                  resolves chain, deployment record (v1 and v2) and signer
packages/x402/               @priors/x402: x402 v2 USDG preset for Robinhood Chain, facilitator config, a payer that
                             borrows the gap, the merchant's record gate, savings and Autopay helpers
packages/mcp/                @priors/mcp: local MCP server with the agent's wallet (pay_url, borrow, repay, savings,
                             Autopay, reads)
bin/priors-v2.mjs            the v2 CLI (`npx priors-v2`)
bin/priors.mjs               the v1 CLI (`npx priors`), for v1 history and the local devnet
scripts/devnet.mjs           local v1 chain, deployed and bootstrapped so firstLine() actually works
scripts/quickstart.mjs       devnet + one agent through the entire record
skills/priors/SKILL.md       the agent skill
skills/.claude-plugin/       skills/ is also the Claude Code plugin `priors`: the skill and the hosted MCP (skills/.mcp.json)
.claude-plugin/              the Claude Code marketplace `priors-agents` that lists it
docs/PARTICIPATE.md          lenders, stakers, backers and agents on v2
docs/FLOAT.md                credit as float: x402 payments on a line
docs/SECURITY-v2.md          every known v2 finding, its fix or residual, and its test
docs/AGENTS.md               guide for agent builders
docs/CHECK-API.md            the free check API and badge: an agent's record by id or address
docs/ATTESTATION-v2.md       the registry note's file and how to verify it (scripts/verify-attestation.mjs)
docs/DESIGN.md               the v1 math, the attacks, the parameters
SECURITY.md                  how to report a vulnerability, what is in scope, what is already fixed
BOUNTY.md                    what a finding pays, what is in scope on chain, and the safe harbour
```

Found something? **[SECURITY.md](SECURITY.md)** — use this repo's private vulnerability reporting, and
please do not put details in a public issue. **[BOUNTY.md](BOUNTY.md)** says what it is worth; the ceiling is
small and we say so up front rather than after you have spent a week.

## Working on it

```bash
forge test                     # 1,130 tests, all green (fork-only tests skip without FORK_RPC)
npm test                       # SDK, CLI and publish-guard checks (needs Foundry for the v1 end-to-end run)
npm run test:v2                # the v2 SDK and x402 client, network-free
npm run devnet                 # local chain + deployed, bootstrapped v1 pool
npm run quickstart             # devnet + the full agent flow
bash scripts/check-public.sh   # fails if a credential ever reached a tracked file
```

`CreditPoolV2` compiles with via-IR at `optimizer_runs = 1` to fit the 24 KB limit (a per-file restriction in
`foundry.toml`); everything else compiles as before. Contracts are non-upgradeable, except the stock vault: a
source change only reaches users through a new deployment, or, for `StockVault`, an upgrade through its ProxyAdmin,
which the timelock owns since 2026-10-07 (the Safe schedules it in public; it runs 48 hours later at the earliest
until 2026-10-11 19:49 UTC, and from then in the block it is scheduled). `src/StockVault.sol` stays byte-identical to the source verified on chain, so `forge fmt` skips it.

## Honest risks

- **Demand is early.** Agents mostly need money for inference and API calls. Volumes are real but small.
- **Backers carry the credit risk.** On v2 that is the point: a default costs its backer, not the lenders. Back
  agents you would lend to yourself.
- **Seats are priced in a volatile token.** A seat deters a stolen line only while half of it is worth far more
  than the line. If $PRIORS collapses, the seat size has to move (see `docs/SECURITY-v2.md`, X-3).
- **This is not an audit.** v2 has had internal adversarial reviews, not a third-party audit. v1 shipped with a
  lender-loss defect the randomized invariants did not catch. Assume there is another one.

## v1: what happened before

The v1 pool ran on Robinhood Chain until the v2 cutover, and is now paused. This is its record, as
it was written while v1 was live; it is kept because it is the history v2 was built on.

> ### v1 status: what we found, and what we did about it
>
> A review found a way for lenders to lose principal: `markDefault()` released an agent's *entire* delegated
> backing on its first default, so a second default from the same agent found nothing left to charge. We wrote
> the counterexample as a test, committed it **failing**, and left it public while it was still broken.
>
> **It is fixed.** A default now consumes only the liable slice of the delegation per loan; the rest keeps backing
> that agent's other open loans and is released when the last one closes, and earned credit is written off against
> bad debt and retired at settlement. The test that proved the bug is still in the suite, and it passes:
>
> ```bash
> forge test --match-test test_multipleDefaultsKeepLendersWholeWithoutEarnedExposure -vv
> ```
>
> `test/DefaultAccounting.t.sol` adds the cases that make the fix mean something: partial defaults, repayment
> after default, multiple children, sub-sponsor recourse per default, a dead sponsor, root defaults, and the
> reserve lock. **`forge test` is 97 passed, 0 failed**, invariants included.
>
> **What that does not buy:** no independent review of the economics has happened, and randomized invariants
> passed right through the original bug — a fuzzer that never defaults the same agent twice reports green forever.
> Launch caps stay small for exactly that reason. Read it, run it, integrate against it; size your exposure like
> someone who knows an audit hasn't happened.
>
> **The pool is live on Robinhood Chain mainnet** (chain 4663), seeded small on purpose: 150 USDG of lender
> liquidity, 75 in the first-loss reserve, 65 staked by the treasury. Addresses come from
> `deployments/<chainId>.json`, so `npx priors doctor` resolves it with no configuration. `npm run quickstart`
> still builds you a throwaway local chain in about thirty seconds if you would rather not touch mainnet.
>
> **A second defect was found after launch, and has now been fixed and redeployed.** A root sponsor could
> vouch out `stake + earned`; when the delegation defaulted, `markDefault` clamped the root's liability to its
> stake and charged the shortfall to the reserve — but never retired the root's `earned`. The same earned credit
> then backed a defaulted delegation *and* remained the root's own borrowing capacity: the reserve paid twice,
> `reserve >= totalEarned` broke, and lenders lost principal. Worth being precise about what was *not* wrong:
> `vouch()` letting a root delegate more than its earned. A root's stake is cash, so that delegation is backed;
> requiring `delegatedOut <= earned` for roots would break the treasury, which vouches every line out of stake
> with `earned = 0`. The permission was right — the accounting on default was incomplete.
>
> `test/ReviewPoC_RootEarnedDoubleSpend.t.sol` is the original proof-of-concept, now inverted into the
> regression guard: it runs the attack move for move and asserts containment. Revert the fix and it fails
> naming the broken invariant. **The pool was migrated to the fixed bytecode**, carrying every agent's
> repayment record across — see `importRecords` and `test/HistoryImport.t.sol` — and the `minStake` lockout
> that had stood in for the fix is lifted, so third-party root sponsors work again.
>
> **The old pool is paused and abandoned.** $10 of stake is stranded in it forever, behind two credit lines
> that were already given: `unvouch` is `onlyController(sponsor)` and the TreasurySponsor exposes none, so a
> line cannot be taken back. That is a design property, not an accident, and it is the whole reason onboarding
> is finite.
>
> Practical consequence: **onboarding is finite.** The treasury vouches $5 per agent out of its own 65 USDG of
> stake, so the beta seats thirteen agents in total. Capacity grows only when $PRIORS creator fees are swept
> into the treasury — by hand during the beta. Don't trust that count once it is a day old: priors.trade shows
> how many first lines are left, read live from the chain, and so does `npx priors report 445`
> (`available` ÷ $5).


## License

MIT
