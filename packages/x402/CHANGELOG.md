# @priors/x402 changelog

## 0.8.1 (2026-10-23)

- **Borrowing and repaying both need the agent's owner or its declared ERC-8004 wallet.** CreditPoolV2 lets an owner
  name any address its pool delegate without that address's consent, so `isController` was no proof the signer acts
  for the agent's owner: a buyer of an agent the signer once held (or was the key of) could name it delegate, borrow,
  and have a stale `agentId` repay the buyer's loans from the signer's USDG and savings. A signer that is not the
  owner must now be the agent's declared wallet (set only by that wallet's own `AgentWalletSet` signature naming the
  owner, cleared by a transfer: AutoRepay v2's rule); otherwise `NOT_AGENTS_WALLET`.
  - `repayLoan` and `settleLoans` refuse before any top-up, approval or repayment.
  - `borrowGap` (`pay()`'s borrow-the-gap) and `borrowLine` refuse before the pool is read, a fee quoted, a
    SeatVaultV5 line refreshed or anything sent. **The two halves are deliberately symmetric:** a key that may not
    repay here may not borrow here either, so no caller can draw a loan this package would then refuse to settle.
  - `settleLoans` and `borrowGap` take an optional `agentWalletOf(agentId)` beside `ownerOf`, for a caller that
    already holds the registry (the MCP server passes both).
- **Breaking for a delegate-only key.** A key the owner named with `setDelegate` but never declared as the agent's
  wallet now borrows and repays nothing through this package. Its owner declares it once — the key signs
  `AgentWalletSet` (`priors-mcp link-wallet` prints the signature) and the owner sends the registry's
  `setAgentWallet` — or the owner's own key acts. Every error says exactly that.

## 0.8.0 (2026-10-15)

- **`payViaGateway`: buy from a seller in Vantis' Keyring catalog with one USDG payment on Robinhood Chain.** Off
  unless `createPayer({ gateway })` names it (`{}` is https://keyring.vantis.sh). Most of these sellers are paid in
  USDC on Base. Keyring pays the seller and relays the answer, so the agent's Priors line can cover such a seller
  with no Base float.
  - Before anything is signed or borrowed:
    - the seller's record must name the resource and method asked for (not marked suspicious or testnet, with a
      listed price);
    - Keyring's quote must be armed, in USDG on Robinhood Chain, within `maxPrice` and within `gateway.maxFeeBps`
      (default 1000) over the seller's listed price;
    - the gateway's 402 must ask no more than the quote, on Robinhood Chain only, and pay `gateway.payTo` when set.
  - Then it is paid as `pay()` pays any Robinhood Chain merchant (balance, `topUp`, a loan of only the shortfall
    within `maxBorrow`, one signature), in the same one-at-a-time queue.
  - New codes: `GATEWAY_OFF`, `BAD_GATEWAY`, `BAD_GATEWAY_SERVICE`, `GATEWAY_NO_SERVICE`, `GATEWAY_REFUSED`,
    `GATEWAY_UNAVAILABLE`, `GATEWAY_FEE_TOO_HIGH`, `GATEWAY_PRICE_ABOVE_QUOTE`, `GATEWAY_PAYTO_MISMATCH`.
  - Tested against a mock gateway only. Its 402 shape and `payTo` are not yet seen live: see `docs/X402-ROUTES.md`.
- No new names in the package's exports (`createPayer` takes a new option; the payer has a new method).

## 0.7.1 (2026-10-13)

- **Fix: a check API answer with no record in it no longer passes a payer.** With the API source, an HTTP 200 whose
  body was not a check API answer (`{}`, `{"error": …}`, `{"agents": null}`, `{"agents": {}}`, an entry without its
  `record`) read as a payer Priors does not know: an empty, non-defaulted record, which the default policy accepts. A
  degraded or changed record service would then have served a defaulted payer through `@priors/x402/check`, failing
  closed or not, and through `recordGate`. Such a body is now a record that cannot be read: `@priors/x402/check`
  answers `503` with `Retry-After` (or serves, with `failOpen: true`), and `recordGate` refuses the payment
  (`priors_record_unavailable`). Only an answer's own `agents: []` is a payer Priors does not know, as before.
  `recordFromCheck` throws on such a body instead of returning an empty record.
- Fix, chain source: when the registry read of the named agent's owner fails, the record is unreadable (refused, or
  `503` from `@priors/x402/check`). It was judged without that owner's default mark, so an agent key of a marked
  owner's agent could pass `refuseDefaulted`.

## 0.7.0 (2026-10-12)

- **`@priors/x402/check`: refuse a payer with a bad Priors record in one line, whatever runs the x402 paywall.**
  `requireRecord(opts)` (Express, Connect, `node:http`), `honoRecord(opts)` (Hono) and `withRecord(handler, opts)`
  (a `fetch` handler: Cloudflare Workers, Next route handlers, Bun) go in front of the paywall; `checkRequest(request,
  opts)` gives the decision for any other stack. The payer comes from the payment header (v2 `PAYMENT-SIGNATURE`, v1
  `X-PAYMENT`) through `payerOf`, its record through `recordGate`'s own cached reader, and the policy is `judge`'s
  (`refuseDefaulted`, default true, `minRepaid`, `minScore`). No payment header: the request goes on and the paywall
  answers 402 as before. A refused payer: `403` `{ error, message }` (`priors_payer_defaulted`,
  `priors_record_too_short`, `priors_score_too_low`; `priors_payer_unknown` for a header naming no single payer, two
  headers naming two payers, or one that does not decode). A record that cannot be read: `503` with `Retry-After`
  (`failOpen: true` serves). It runs before the paywall's verification on purpose: it can only refuse, and a forged
  payer cannot pass the verification that follows. Demo: `examples/check-record` (in the repository).
- `recordGate`, `judge`, `payerOf` and the rest of the package are unchanged.

## Earlier versions

- 0.6.5: `robinhood.seatVaultV5`; `creditContracts` knows SeatVaultV5 by default.
- 0.6.4: `recordGate`'s cache is bounded (`cacheMax`), and `X-Priors-Agent` adds no entry with the API source
  (GHSA-vjcp-qx2h-gr2q).
- 0.6.3: `repayLoan` and `settleLoans` repay only loans the agent's owner now took (GHSA-mmp8-g8jw-7gqp).
- 0.6.2: `pay()` keeps the caller's `signal` and signs nothing once it aborts (GHSA-868j).
- 0.6.1: a requirement x402 core will not sign is refused before anything is borrowed (GHSA-f35g).
- 0.6.0: `@priors/x402/bridge` and the Base network exports (`networks`, off unless asked for).
