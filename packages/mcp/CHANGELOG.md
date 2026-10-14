# @priors/mcp changelog

## 0.9.3 (2026-10-14)

- **A PT-USDG trade whose answer is lost is never said to have done nothing.** `pt_buy`, `pt_sell` and `pt_redeem` now
  sign each step before sending it, so its hash is known first, and after a failed broadcast they ask the node about
  that hash: a step the node shows mined goes on (the trade is done and said so, once), one it shows pending is waited
  for, and "insufficient funds" with no trace of the transaction is a refusal that counts nothing. Any other failure
  says the trade may have been sent, keeps a buy counted against `PRIORS_MAX_PT_TOTAL_USD`, and asks to check
  `pt_position` and `wallet_balance` before trying again. Until now a node's "insufficient funds" was always a refusal,
  though it can also answer a retried request after the first one was taken (GHSA-g5cv's class); the buy was then
  uncounted and given back as nothing sent. Waiting for a receipt is bounded (3 minutes), a lookup that never answers
  included, and a lookup that fails is asked again. The same change is in the SDK's `sdk/pt-usdg.mjs`, whose
  `ptBuy`/`ptSell`/`ptRedeem` throw `TX_UNCONFIRMED` (with the hash and the steps done before) instead of a bare error.

## 0.9.2 (2026-10-13)

- **Merchant text can no longer write a line outside the data fence, or spell its marker.** The marker's keyword was
  rewritten only when split by a space, a hyphen or a soft or zero-width character, and only listed brackets were
  replaced, so a merchant could still close the fence early with an invisible separator (U+180E, U+2063) and
  look-alike brackets (U+22D8 and U+22D9, U+2770 and U+2771, U+27EC and U+27ED, U+2991 to U+2996), and write the lines
  after it as if they were this server's. Every line inside the fence now starts with U+2502 and a space, whatever
  line break the merchant writes (LF, CR, CRLF, NEL, U+2028, U+2029, as a character or as an HTML reference such as
  `&#10;` or `&NewLine;`), so none of its lines stands outside, however it spells or words a boundary; only the
  closing marker with the call's own id ends the fence, and its label says so. Outside the fence, every third-party
  string an answer quotes (an error a library or a node wrote, a bridge's status, the echoed search word) and every
  string and property name of structured content is read the same way, with such a reference as a space; a merchant's
  link is given only whole and as it is: not when the URL parser or cleaning would change it as the merchant wrote it
  (a control character, a tab or line break, a space at either end), not when the fence would change it, as written or
  with its percent-encoding read (`%0A`), not when that encoding does not decode cleanly, and not when it is too long
  to show whole (over 200 characters); then it reads "no url", since a changed or cut link would be another URL.
  Within its lines, merchant text is read as a reader would read it: HTML character references decoded (numeric ones
  however many digits they have), compatibility forms (fullwidth, mathematical, and ones that read as two letters,
  such as U+33CA), no combining marks or invisible characters, any case, and Cyrillic, Greek, Armenian and
  small-capital look-alikes. The keyword comes out as `merchant[-]data` wherever it is split by nothing, a space, a
  dash or any other character outside ASCII, and also by ASCII punctuation where it has a marker's shape (`<<end
  merchant_data ...>>`); a line break inside the fence ends it. Brackets change only in that shape (an opening run
  right before `end` or the keyword, a closing run right after the keyword or its id) with a marker's evidence (the
  word `end`, not the end of `friend` or `backend`; an id; or two brackets), and in runs of two or more facing the
  same way, which become single angle quotation marks (U+2039, U+203A). Everything else is left as written: a single
  bracket, quotation mark or comparison sign (`price<merchant-data`, `merchant-data price < 5`, U+2264 and U+2265, CJK
  brackets), a `merchant_data` key, a `/merchant/data` path, or a URL ending in `merchant` before a line starting
  `data`. A doubled `<<` in merchant text (a C++ stream, a shell here-document) now reads as two U+2039.
  `find_services` echoes the search word the same way. The hosted server's `find_services` uses the same code
  (`src/fence.mjs`).
- **`autopay_on` approves at most 4 x the limit per loan.** The README and the tool's description said the budget is
  4 x the limit and never unlimited, but a `budget_usd` above it was approved as given (1,000,000 USDG on a 25 USDG
  limit). A larger `budget_usd` is now refused before anything is sent; it can still set a smaller budget, down to one
  loan's limit. An allowance approved above it before stays until `autopay_off` with `clear_budget: true`.
- On `@priors/x402` 0.7.1, unchanged.

## 0.9.1 (2026-10-13)

- **`stock_line_request` checks the caps against the line the deposit opens.** The deposit is the line's need × 1.3,
  so the vault opens about 1.3 times the line asked for (at most its largest line); the token's cap and the week's room
  were checked against the line asked for, so a 100 USDG request with 110 USDG of room returned a link to a deposit that
  opens 130 USDG, which the vault refuses. The request is now refused when the line the filled deposit opens is over
  either, and the answer names the largest line that fits with the same room for a 23% fall.
- **`stock_line_request` sizes a named agent at its own loan-to-value**: the vault's `ltvOf(agent, token)`, the token's
  own plus the agent's record bonus, which is what the vault opens its line at. It sized at the token's own, so an agent
  with a bonus was asked for more of the token than its line needs (about 25% more at 75% against 60%). The answer says
  the bonus; when that figure cannot be read, the request is refused rather than sized at the token's own.
- **`stock_line_request` without `agent_id` no longer turns a failed lookup into a new agent's link.** With a wallet
  configured, a wallet that owns several agent identities, or none, a lookup that failed, or a key that can't be used
  now gives a tool error that asks for `agent_id`; before, the link opened the new-agent deposit, where the owner could
  fund another identity than the agent's. `PRIORS_AGENT_ID` is used when set. Only with no wallet configured (and no
  `PRIORS_AGENT_ID`) is a request without `agent_id` for a new agent.
- `stock_line_request` refuses an agent whose owner has a default marked on their account (the pool's `ownerDefaults`,
  which `StockVault.open` refuses for every agent of that owner), instead of a link to a sheet that can open nothing.
- `stock_line_request` names the tab as Go mode shows it (Stock lines, not Backing), and says the pool's grace as it is,
  never rounded up (a 36 h grace reads 1.5 days). `pt_position` names it the same where the vault takes PT-USDG
  behind a line ("Go mode's Stock lines tab").

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
