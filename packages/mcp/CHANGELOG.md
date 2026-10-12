# @priors/mcp changelog

## 0.9.0 (2026-10-12)

- **`stock_line_request`**: when the agent's line is too small for a task, it asks its owner for a line backed by a
  Robinhood stock token the owner holds. It checks the token takes new lines now (its price, holds, the token's cap, the
  vault's room this week) and that the agent can take one, sizes the deposit to the line asked for (line ÷ LTV × 1.3,
  so what the agent can draw holds through a 23% fall), states the cost in cents for a day and a week, says what a
  default would keep as the live vault does it (its fair-default buffer, or the whole deposit), and returns a Go mode
  link that opens the owner's deposit sheet already filled in. It reads; it never deposits, signs or holds the owner's
  tokens. The same answer as the hosted server's tool (both from `src/stock-line.mjs`).
- `credit_status` names `stock_line_request` as the way to a bigger line, for an agent without a stock line.
- On `@priors/x402` 0.7.0.

## 0.8.5 (2026-10-12)

- **Money counts in the UTC day it lands** (GHSA-266h-jfr9-42cx). A call reserved its room in the day it started and
  kept what it did there, so a borrow sent before 00:00 UTC that landed after was invisible to the new day's
  `PRIORS_MAX_BORROW_DAY_USD` (and to `credit_status`'s "Today"), and a day could carry twice its limit; the same for
  `PRIORS_MAX_SPEND_DAY_USD`. A call's money is now filed in the day it ends, and while a call is in flight every
  process counts it in the days after the one it started, however long its transaction takes; one cut short by a
  crash stays counted for the day it started and the two after.
- **`fund_base` counts against the session caps from its check** (GHSA-24qq-9p83-8798). It checked
  `PRIORS_MAX_BORROW_TOTAL_USD` and `PRIORS_MAX_BRIDGE_TOTAL_USD`, then read the transfer record and the Base float,
  and only then counted, so a second call made while the first waited on a late Base read could pass both caps
  beside it. It now counts right after the check, as `borrow` and `pay_url` do (GHSA-cq9v), and gives it back when it
  is refused.

## 0.8.4 (2026-10-11)

- **SeatVaultV5 lines work out of the box.** The bundled `deployments/4663.v2.json` names SeatVaultV5
  (`0xC999014C6218EC41f0aE412d49AE8f2aA4c539fD`, root `#8762`, live since 2026-10-11 and named by BuyAndBack and the
  SwapLimiter), so a borrow on a V5 line refreshes the line first (from the agent's owner, or from this key once V5
  has recorded it for 24 h); before, that needed `PRIORS_V5` and `PRIORS_V5_ROOT`, which still override it. On
  `@priors/x402` 0.6.5, whose `robinhood` constants name the same V5 and whose `creditContracts` uses it by default.

## 0.8.3 (2026-10-10)

- **`PRIORS_STATE_DIR` must be yours alone** (GHSA-52gp-533q-jx99). It keeps what stops a payment being signed twice
  and the daily limits' ledgers; another local user who could rename its entries made the server start counting from
  nothing (a second borrow past `PRIORS_MAX_BORROW_DAY_USD`). On Linux and macOS, with a wallet configured, the
  directory must belong to your user with no group or other write bit, and every directory above it must belong to
  root or you and not be writable by others unless sticky (`/tmp`): OpenSSH's rule. Otherwise every money tool refuses
  and says what to fix (`chmod 700`), and the read-only tools still answer. The default directory is created `0700`
  and passes; one you made yourself under a `0002` umask (`0775`) needs `chmod 700`.

## 0.8.2 (2026-10-10)

- **On `@priors/x402` 0.6.4**, whose merchant-side `recordGate` keeps a bounded cache (GHSA-vjcp-qx2h-gr2q). The MCP
  server does not use the gate; nothing else changes from 0.8.1.

## 0.8.1 (2026-10-10)

- **`repay` pays only loans the agent's owner now took** (GHSA-mmp8-g8jw-7gqp). A loan opened while someone else
  held the agent (the pool's `Loan.owner` is not the agent's owner now) is refused by `loan_id` and left out by
  `all: true`, which names it and who opened it; nothing is paid for it.
- **The agent lookup skips an identity that left the wallet** (GHSA-mmp8-g8jw-7gqp). Without `PRIORS_AGENT_ID`, the
  wallet's agent is an identity minted to it since the v2 deploy that never left it: one that went to someone else
  and came back, carrying what they borrowed, now needs `PRIORS_AGENT_ID` like a bought one.
- **On `@priors/x402` 0.6.3**, whose `repayLoan` refuses such a loan (`NOT_OWNERS_LOAN`) and whose `settleLoans` leaves
  it unpaid, listed in `others`.

## 0.8.0 (2026-10-09)

For agents that run on their own (in ElizaOS, OpenClaw, Hermes or their own code) and read untrusted text all day.
Every change is opt-in: with none of the new settings, a 0.7.x configuration behaves as before, and every 0.7.x
variable and state file (`outstanding-<wallet>.json`, `bridge-<wallet>.json`) keeps working.

- **`PRIORS_KEY_FILE`**: the key from a file, so a runtime's config holds a path instead of the key. The file is read
  only when nobody but the user can read it: on Linux and macOS a regular file the user owns with no group or other
  permission bits (root may read another user's owner-only file, such as a container secret, only where every
  directory above it, on the path as given and as resolved, belongs to root or to that user and nobody else can write
  it: ssh's secure_path rule, so never under /tmp, where anyone could have put their own key at the path); on Windows
  a file whose access list lets only the user, SYSTEM and Administrators read it, checked by SID through PowerShell's
  Get-Acl (PowerShell run from System32 by its full path, never looked up in the working directory). Any other file is
  refused without being read (the checks use the opened file itself), and the server starts read-only, each money tool
  saying what to fix. `~/` (and `~\` on Windows) is the home directory; a relative path is refused. The content is
  never echoed. `PRIORS_KEY` still works; both at once are refused. Replaces the `sh -c` wrapper.
- **Daily limits that survive a restart**: `PRIORS_MAX_SPEND_DAY_USD` (what `pay_url` signs) and
  `PRIORS_MAX_BORROW_DAY_USD` (what `borrow`, `pay_url` and `fund_base` borrow), per UTC day for the agent
  (`PRIORS_AGENT_ID`, which a daily limit requires: without it the start stops) and for the wallet that signs, across
  restarts and every process sharing `PRIORS_STATE_DIR`: every key and client of the agent shares one count, and a key
  run under another agent id still shares its wallet's. A call is counted at its most from before its check until it
  ends, then at what it did; a call cut short by a crash stays counted at its most. The ledger is one empty file per
  call whose name carries its amounts, created before the directory is summed, so two processes can never pass a limit
  together and there is no lock to go stale. `PRIORS_MAX_BORROW_DAY_USD=0` turns borrowing off. A daily limit with
  `PRIORS_STATE_DIR=off` stops the start. `credit_status` shows today's use.
- **`PRIORS_PAY_HOSTS`**: the only hosts `pay_url` pays, matched exactly after the WHATWG URL parser's normalisation
  (lowercase, punycode, one trailing dot, default port), checked before any request and again on every request the
  payer sends; redirects are never followed. A wildcard, URL, path or user info in the list stops the start.
- **Share facts from `repay`**: for each loan repaid, the agent, the loan, the amount, on time or late (by the
  repaying block's time, read back from the pool) and by how many days, for a late one whether it came inside the
  pool's grace period (said only when the loan's defaultableAt was read: the pool takes a repayment after it too,
  until someone marks the loan defaulted), the loans repaid in all, and the record's page, in the answer and as
  structured content with a suggested line. Reads are best effort within the call's time and never fail the repayment.
  Nothing is ever posted.
- **`@priors/mcp/share`**: `shareFacts`, `repaidPost(facts, { link })` (lowercase, no @mention, hashtag or link unless
  asked) and `REPAID_POST_TEMPLATE`, the rule a runtime's character can carry: one post per repaid loan, in its own
  words, never a reply and never about a borrow alone.
- **`priors-mcp link-wallet --agent <id>`**: the agent's key signs the ERC-8004 registry's `AgentWalletSet` (EIP-712,
  domain "ERC8004IdentityRegistry" version 1 on chain 4663, read from the registry and refused if it differs; the
  owner from `ownerOf`; a deadline 4 minutes past the latest block, at most 290 seconds), and it prints the owner's
  `setAgentWallet` call (`--json` for one line). A command only, never an MCP tool.
- The tool descriptions and the server's instructions name the daily limits and the host list when they are set.

Setup for these, with a block for ElizaOS, OpenClaw and Hermes: the README's "An agent that runs on its own". No
@priors/x402 change: it stays 0.6.2.
