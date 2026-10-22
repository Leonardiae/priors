# Credit as float: x402 payments on a Priors line

Not leverage. Float.

An agent pays for data, APIs and compute per call now, and gets paid by its own client later. Without credit it
needs a human to top up its wallet first. A small Priors v2 line covers the gap: the $5 that pays for the call that
earns the next ten.

`sdk/float.mjs` is an [x402](https://github.com/x402-foundation/x402) client for USDG on Robinhood Chain that pays
from the agent's balance and, only when that is short, borrows the difference from the agent's Priors v2 line. It
pays x402 v1 `402`s; a `402` that offers only x402 v2 is refused (`BAD_402` or `NO_USDG_REQUIREMENT`) before
anything is signed or borrowed. For x402 v2 (for example the paid API at `api.priors.trade`), `createPayer` in
[`@priors/x402`](../packages/x402) pays the same way and borrows the gap under the same rules.
Which sellers and facilitators the payer reaches (Robinhood Chain, a Base float, the Vantis gateway, Dexter), live or
mocked: [X402-ROUTES.md](X402-ROUTES.md).

## Using it

```js
import { resolveV2 } from "priors/env";
const { priors } = await resolveV2();                  // PRIORS_KEY = the agent's owner (or pool delegate)

const r = await priors.pay("https://merchant.example/api/thing", {
  agentId,                  // the agent whose line may be drawn
  maxBorrow: 5_000000n,     // most this call may borrow, atomic USDG (0 = never borrow)
  maxPrice: 100_000n,       // most this call may pay (default 0.1 USDG)
});
// r.response is the merchant's answer; r.paid, r.borrowed, r.loanId, r.dueAt say what happened

await priors.settleLoans(agentId);                     // later, once the agent has been paid: repay, earliest due first
```

The functional form is `pay(url, { signer, pool, agentId, ... })`, `resend(url, paymentHeader)` and
`settleLoans({ signer, pool, agentId })` from `priors/float`; `priors.resend(url, paymentHeader)` is the same `resend`.
`settleLoans` repays only loans the agent's owner now took: a loan opened while someone else held the agent stays in
`open` and is listed in `others` with who opened it (GHSA-mmp8).

## What `pay()` does

1. Fetches the URL. Anything but a `402 Payment Required` is returned untouched.
2. Picks the first x402 v1 `exact` requirement for USDG on network `robinhood` (or `eip155:4663`).
3. **Refuses a price above `maxPrice`** (default 0.1 USDG) before signing or borrowing anything. The merchant
   writes the 402; without a cap a funded agent would sign whatever it asks.
4. If the balance covers the price, pays from it. If not, borrows `max(shortfall, pool minLoan)` from the agent's
   line, never above `maxBorrow` (a price above `maxBorrow` is refused before any transaction). The default term is
   7 days, clamped into the pool's range; `r.dueAt` is the deadline to have `settleLoans()` run by. On a line
   sponsored by SeatVaultV5 (the `v5` and `v5Root` options, which `priors.pay` takes from the deployment record's
   `seatVaultV5` and `seatVaultV5AgentId` once V5 is live), V5's step comes just before the borrow: the owner's
   `refresh(agentId)`, or a new key's `noteDelegate` and a borrow within the line's room ([PARTICIPATE.md](PARTICIPATE.md),
   "A line sponsored by SeatVaultV5").
5. Signs an EIP-3009 `TransferWithAuthorization` on USDG's `Global Dollar` v1 domain, valid for at most 600 s
   whatever the merchant asks, and retries with it in `X-PAYMENT`.
6. If the merchant answers 402 pending (`{pending: true}`, or x402's `settlement_pending` in the `PAYMENT-RESPONSE`
   header or the body; the settlement was broadcast but not yet confirmed), it resends the **same** header, honouring
   `Retry-After`, up to 6 times. Still pending: it returns `{pending: true, paymentHeader}` for
   `resend(url, paymentHeader)` later. A dropped connection or a timeout
   (`timeoutMs`, 60 s by default) once the payment is out is pending too (`transportError` or `timedOut`), never an
   error.
7. Once signed, every result carries `paymentHeader` and `validBefore`, whatever the merchant answered (a 500 too),
   and an error thrown after the loan or the signature carries them with `borrowed`, `loanId` and `dueAt`.

⛔ **Never call `pay()` again for a purchase that returned a `paymentHeader` without `paid`.** Until `validBefore`
the merchant can still cash it, so a second `pay()` would sign a second payment. Use `priors.resend(url, paymentHeader)` (or
`resend` from `priors/float`) with that header. `pay()` keeps no memory of earlier calls: this rule is the caller's to keep.

No redirect is followed unless `init.redirect` says so (a signed payment never travels to a host you did not name),
merchant bodies are read up to 256 KB, and calls from one wallet run one at a time, so two purchases never both
borrow the same gap.

The borrowed USDG lands in the agent's own wallet, because EIP-3009 needs the payer to hold the funds. A router
that draws straight to the merchant would be stricter, and is not built.

## The facilitator

Priors runs an x402 facilitator for USDG on Robinhood Chain: **`https://facilitator.priors.trade`**. It settles
x402 v1 and v2 payments. It is not the only one on the chain (Canopy, r0x and Verge run facilitators too). The
merchant picks its facilitator; `pay()` only signs the payment the merchant's 402 asks for. The facilitator's code is
not in this repository: what follows describes the live service.

- `GET /health` is open.
- `POST /verify` checks a payment without moving anything. Like `/settle`, it needs a merchant API key.
- `POST /settle` submits the transfer and pays the gas. It needs a merchant API key (`Authorization: Bearer
  <key>`), and it settles only for the merchant's registered `payTo`, above a minimum value (0.01 USDG), never
  payer-to-self. Merchants sign up for a key at
  [x402.priors.trade/merchants](https://x402.priors.trade/merchants).
- A settlement whose receipt did not arrive in time is answered as `pending`, not failed. The merchant must treat
  it as not yet paid, must not ask the client for a new payment, and retries `/settle` with the same signed payment
  (`X-PAYMENT` in v1); the facilitator never submits one authorization twice.

Payload format and reason codes follow the x402 reference facilitator (`exact`, EVM, v1 and v2). The v1 constants
`sdk/float.mjs` uses are in `sdk/x402.mjs`; `@priors/x402` builds v2 payloads with the official `@x402/*` packages.
Only 65-byte EOA signatures are accepted for now; smart-contract payers (EIP-1271) are not.

**Checking the payer.** Whatever facilitator it uses, a merchant can read the payer's Priors record before the payment
is verified: `recordGate` in `@priors/x402` 0.2.8 (an `onBeforeVerify` hook on the x402 resource server). It can refuse
an agent that defaulted, ask for repaid loans or a minimum score, and price by record. A payment it refuses never
reaches the facilitator, so nothing moves. The record comes from the free check API by the payer's address
([CHECK-API.md](CHECK-API.md)), or from pool v2 over an RPC for the agent the payer names in `X-Priors-Agent`.

## The rules do not bend for float

A float loan is an ordinary v2 loan. Miss its due date by more than three days and anyone can mark it defaulted,
with the same permanent consequences as any other. Set `maxBorrow` to what the agent can repay within the term.

Tests: `npm run test:v2` covers the client guards network-free (price caps, authorization lifetime, the pending
resend, no loan when `maxBorrow` is 0) and SeatVaultV5's step before a borrow.
