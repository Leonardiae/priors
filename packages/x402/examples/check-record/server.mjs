// A merchant that refuses a payer with a bad Priors record, in one line, on node:http alone.
//
//   npm install && node server.mjs        (PORT=8402 by default; PORT=0 picks a free one)
//
// requireRecord runs before the paywall. A request whose payment header names a payer that defaulted on a Priors loan
// gets 403 { error: "priors_payer_defaulted", message } and goes no further. Any other request goes on to `paywall`,
// which stands here for the merchant's x402 middleware: it answers 402 without a payment, and in a real merchant
// verifies and settles the payment before serving. This demo has no facilitator, so it serves any payment that passed
// the check; see the package README for requireRecord in front of @x402/express's paymentMiddleware.
import http from "node:http";
import { requireRecord } from "@priors/x402/check";

const check = requireRecord({ refuseDefaulted: true }); // the one line; minRepaid / minScore ask for a track record

function paywall(req, res) {
  const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (!req.headers["payment-signature"] && !req.headers["x-payment"]) return json(402, { error: "payment_required", message: "Pay 0.01 USDG on Robinhood Chain (x402)." });
  // a real merchant's x402 middleware verifies and settles the payment here, then serves
  json(200, { report: "served", note: "the payer passed the Priors record check; an x402 paywall verifies and settles the payment next" });
}

const server = http.createServer((req, res) => check(req, res, () => paywall(req, res)));
server.listen(Number(process.env.PORT ?? 8402), "127.0.0.1", () => console.log(`listening on http://127.0.0.1:${server.address().port}`));
