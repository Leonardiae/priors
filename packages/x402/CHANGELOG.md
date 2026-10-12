# @priors/x402 changelog

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
