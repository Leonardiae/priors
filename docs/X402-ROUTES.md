# x402 routes for a Priors payer

Which route a Priors agent uses to buy from an x402 seller, and what each route rests on. The payer is
`@priors/x402`'s `createPayer` (and `sdk/float.mjs` for v1). Every route keeps the same rules (`docs/FLOAT.md`):

- the price is checked against `maxPrice` before anything is read, signed or borrowed;
- the payer pays from its balance first and borrows only the shortfall, never above `maxBorrow`;
- one signature per purchase, resent while the seller answers "pending".

Facilitator facts were read live on 2026-10-15.

`sdk/float.mjs` signs legacy v1 bodies only (`network: "robinhood"`). Everything below that is x402 v2, including
the Vantis gateway (its facilitator takes v2 only) and Dexter's v2 `exact`, goes through `@priors/x402`.

## Which route to use

| The seller takes | Route | State |
|---|---|---|
| USDG on Robinhood Chain, `exact`, EIP-3009 (Priors', Vantis' or Dexter's facilitator, or a v1 `robinhood` 402) | `payer.pay(url)` | Live (`@priors/x402` 0.7.1) |
| USDC on Base, and the agent keeps a small USDC float on Base | `createPayer({ networks: ["eip155:4663", "eip155:8453"], baseProvider })`, then `payer.pay(url)`. Paid from the Base float, never borrowed (refilled by `fundBase`). | Live since 0.6.0 |
| A seller in Vantis' Keyring catalog (most of them USDC on Base), paid in USDG on Robinhood Chain, with credit | `createPayer({ gateway: {} })`, then `payer.payViaGateway({ serviceId or resource, input })`; in `@priors/mcp`, the `pay_gateway` tool (since 0.10.0, off by default: `PRIORS_GATEWAY=on`) | On npm in `@priors/x402` 0.8.0 (`latest` since 2026-10-15) and `@priors/mcp` 0.10.0. Does not complete a purchase with Keyring yet: Keyring reads the payment from `X-PAYMENT`, not the `PAYMENT-SIGNATURE` header 0.10.0 sends, and its facilitator verified none ("A paid run through Keyring", below). |
| Dexter's `exact` 402 with `assetTransferMethod: "permit2"`, Dexter's `upto`, `batch-settlement`, or Canopy's `exact-permit2-v2` | none: refused (`NO_USDG_REQUIREMENT`) before anything is read or signed | Not supported |

When a seller is reachable two ways:

- **On Robinhood Chain directly first.** The money moves once, and nobody sits between the agent and the seller.
- **Base float second.** The seller is paid by the agent itself, with no fee. The float has to be funded ahead and
  is not credit.
- **The Vantis gateway third.** Credit covers it, there is no float to fund, and it reaches sellers that only take
  USDC on Base. The cost is that Keyring holds the call. Keyring is paid in USDG, pays the seller itself, and relays
  the answer. Its terms say it collects only after the seller answered. Its fee is bounded by `maxFeeBps`.

## The Vantis gateway route (`payViaGateway`)

What it does, before anything is signed or borrowed:

1. It reads the seller's record from Keyring (`GET /api/service/<id>`, or a catalog search by the seller's host when
   the caller names the seller's URL). The record must name the resource and method the caller asked for. A record
   Keyring marks suspicious or testnet is refused, and so is one that lists no price.
2. It reads Keyring's quote (`GET /api/gateway/quote/<id>`). The quote must come from an armed gateway for an
   available seller, as one USDG price on Robinhood Chain. It must be at most `maxPrice`, and at most `maxFeeBps`
   (default 1000, that is 10 %) over the seller's own listed price.
3. It calls `POST /x402/run {serviceId, input}` and pays the 402 like any Robinhood Chain merchant's: Robinhood
   Chain only (never Base, even when the payer has Base on), and at no more than the quote. When `gateway.payTo` is
   set, the 402 must pay that address.

Off by default: without `gateway`, `payViaGateway` throws `GATEWAY_OFF` and reads nothing. Refusal codes:

- `BAD_GATEWAY`, `BAD_GATEWAY_SERVICE`;
- `GATEWAY_NO_SERVICE`, `GATEWAY_REFUSED`, `GATEWAY_UNAVAILABLE`;
- `GATEWAY_FEE_TOO_HIGH`, `GATEWAY_PRICE_ABOVE_QUOTE`, `GATEWAY_PAYTO_MISMATCH`;
- the payer's usual codes (`PRICE_ABOVE_MAX_PRICE`, `PRICE_ABOVE_MAX_BORROW`, `NO_USDG_REQUIREMENT`, ...).

### Live vs mocked

| Fact | How we know |
|---|---|
| The gateway exists, is armed, and quotes in USDG on Robinhood Chain | Live GET, 2026-10-15 |
| Record and catalog shapes (`resource`, `method`, `priceUSD`, `suspicious`) | Live GET, 2026-10-15 |
| The facilitator behind it: v2 `exact`, EIP-3009 only, ≤300 s window, EOA signatures | Live GET of `/supported` and its OpenAPI |
| The 402 of `POST /x402/run`: v2 or v1, its header names, Keyring's `payTo` | Live POST, 2026-10-21, no payment header: HTTP 402, x402 v2 in `PAYMENT-REQUIRED`, `exact` USDG on eip155:4663 by EIP-3009, `amount` the quote (1000 for a 0.001 service), `payTo` `0xa68a4ee3fe22340dde776601a5f67cdcf996f9e9`, `maxTimeoutSeconds` 90 (not 300) |
| How `input` maps onto the seller's request | For agent402.tools' chat (`svc_322b25c3cf`): `input` is the seller's JSON body (`{messages, max_tokens}`); its own unpaid 402 quotes that body. Keyring's handling of it is not confirmed: no paid run has gone through (next row) |
| A paid run through Keyring | **Fails, 2026-10-21.** `pay_gateway` from a test wallet (0.38 USDG, no borrowing, payTo pinned): the payment signed in `PAYMENT-SIGNATURE` was answered 402 again; the same payload also in `X-PAYMENT` (the header Keyring's home page shows) got a Cloudflare 502. Four more tries the same day (input as `{"body": {...}}`; `X-PAYMENT` alone, in v1 and v2 shapes, `accepted` trimmed) all got a 502, and the facilitator's public metrics counted 4 verify requests, 0 valid. Nothing settled. `pay_gateway` is published in `@priors/mcp` 0.10.0, off by default, and stays off until a live purchase completes |
| Inference paid directly on Robinhood Chain | **Works, 2026-10-21.** agent402.tools' chat completions also accept `exact` USDG on eip155:4663 themselves: `pay_url` (`@priors/mcp` 0.9.3) paid 0.001 USDG, HTTP 200, settlement `0x7e4f6fbf92c8981f0746f4546a1f392d3683f616954eae4bb1d2ee461508bb1b` |
| Pay from balance, borrow only the shortfall, refusals before any signature | Mocked Keyring and a mocked Base seller, with the recorded shapes |
| Low traffic so far | Live GET of the facilitator's metrics: 99 sponsored settlements in total, none in the last 24 h |

Before turning it on for real money, make one small live gateway call from a test wallet. That call reads
the 402, so `gateway.payTo` can be pinned to Keyring's address and the `input` shape confirmed. In `@priors/mcp`'s
`pay_gateway`, the pin is `PRIORS_GATEWAY_PAYTO`.

## Dexter as a 4663 merchant's facilitator

A merchant on Robinhood Chain can use Dexter (`https://x402.dexter.cash`, no API key documented) as its facilitator,
and Priors' payer pays it with `pay(url)`, as long as the 402 asks for EIP-3009. Both of these do:

- `@priors/x402`'s `registerUsdg`, with Dexter as the facilitator client:
  `createResourceServer({ facilitatorClient: new HTTPFacilitatorClient({ url: "https://x402.dexter.cash" }) })`.
- `@dexterai/x402`'s own server middleware.

A 402 that copies Dexter's `assetTransferMethod: "permit2"` is refused. Paying it would need a Permit2 allowance
from the agent's wallet, which the payer does not grant.

Tested against a mocked Dexter. The mock serves Dexter's recorded `/supported` and
makes the facilitator's EIP-3009 checks on `/verify` and `/settle`. It runs behind a real `@x402/express` paywall and
behind a merchant shaped like `@dexterai/x402` 6.0.5's server. Not paid live: whether Dexter's `/verify` accepts
EIP-3009 on 4663 is an inference.

### "Priors credit accepted": the record check

A merchant that wants to serve agents with a good Priors record, and refuse defaulted ones, puts
`@priors/x402/check` in front of its paywall. It works whatever the facilitator is:

```js
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createResourceServer } from "@priors/x402";
import { requireRecord } from "@priors/x402/check";

const server = createResourceServer({ facilitatorClient: new HTTPFacilitatorClient({ url: "https://x402.dexter.cash" }) });
const app = express();
app.use(requireRecord({ minRepaid: 1 }));   // first: the payer's Priors record (403 for a defaulted payer)
app.use(paymentMiddleware({ "GET /report": { accepts: { scheme: "exact", price: "$0.01", network: "eip155:4663", payTo: "0xYourAddress" } } }, server));
```

A refused payer never reaches Dexter, so nothing is verified or settled. `honoRecord` and `withRecord` do the same
for Hono and fetch handlers (`packages/x402/README.md`, "Refuse a bad payer in one line").

### `upto` and `batch-settlement`: what supporting them would take

Dexter offers both on 4663. The payer refuses both today. Two reasons:

- **A standing Permit2 allowance.** `upto` is Permit2-only (x402 spec `scheme_upto_evm.md`), so the agent's wallet
  would have to let Permit2 move its USDG. `@x402/evm` 2.27 gets that allowance in one of two ways. One is an
  EIP-2612 permit for exactly the requirement's amount, when the 402 declares `eip2612GasSponsoring`; that one is
  bounded. The other is a signed raw `approve(Permit2, MAX)` transaction, under `erc20ApprovalGasSponsoring`. A Priors
  payer must never sign that one.
- **The merchant picks the charge.** In `upto` the merchant settles any amount up to the signed maximum. The borrow
  would have to cover the maximum, and `paid` would come from the settlement answer.

Safe support would mean three things:

1. Accept only the EIP-2612 path, with a permit for exactly the maximum.
2. Treat the maximum as the price for `maxPrice` and for the borrow.
3. Read the settled amount from `PAYMENT-RESPONSE`.

None of this is built. We know of no 4663 merchant that uses `upto`; this work did not look for one.
