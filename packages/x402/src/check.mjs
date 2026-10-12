// Merchant side, any x402 stack: refuse a payer with a bad Priors record in one line, in front of the paywall.
//
//   import { requireRecord } from "@priors/x402/check";
//   app.use(requireRecord({ minRepaid: 1 }));          // Express / Connect, before paymentMiddleware
//   app.use(honoRecord());                             // Hono, before paymentMiddleware
//   export default { fetch: withRecord(app.fetch) };   // Cloudflare Workers, Next route handlers, Bun
//
// `recordGate` (gate.mjs) does this inside an @x402/core x402ResourceServer (onBeforeVerify). This module does it on
// the request itself, so it works whatever runs the paywall (@x402/express, @x402/hono, @x402/next, a v1 stack, your
// own): it reads the payer from the payment header (v2 `PAYMENT-SIGNATURE`, v1 `X-PAYMENT`) with the gate's `payerOf`,
// its record through the gate's own cached reader (`recordGate(...).recordOf`), and judges it with the gate's `judge`.
//   - no payment header: nothing to judge; the request goes on, and the paywall answers 402 as before;
//   - a refused payer: 403 JSON { error: reason, message } (priors_payer_defaulted, priors_record_too_short,
//     priors_score_too_low; priors_payer_unknown for a header that names no single payer);
//   - a record that cannot be read: 503 JSON with Retry-After (fails closed), or the paywall with `failOpen: true`.
//
// It runs BEFORE the x402 middleware, so the header it reads is not verified yet. That is safe: the check can only say
// no. A payer named in a forged header gets the forger refused, or passed on to the paywall, which then verifies the
// signature and refuses a payment its sender cannot sign for. A refused payment is never verified or settled: no money
// moves. Two things would let a payer be judged on one address and pay from another, and both are refused rather than
// passed (403 priors_payer_unknown): a payload naming both EIP-3009 and Permit2 arms (payerOf: GHSA-6vjc), and a v2
// and a v1 header naming different payers (a v2 paywall reads one, a v1 paywall the other). A header that does not
// decode is refused too: whichever decoder the paywall uses, it never sees a payment the check did not judge.
import { payerOf, judge, recordGate } from "./gate.mjs";

/** The headers x402 carries a payment in: v2 `PAYMENT-SIGNATURE`, v1 `X-PAYMENT`. Both are read when both are sent. */
const PAYMENT_HEADERS = ["payment-signature", "x-payment"];
const B64 = /^[A-Za-z0-9+/]*={0,2}$/; // @x402/core's own test before it decodes a payment header

/** The payment payload in a header value (base64 of JSON, as x402 clients send it), or null. */
function decodePayment(value) {
  if (!B64.test(value)) return null;
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) { return null; }
}

/**
 * A case-blind header reader for whatever the caller has: a fetch Request or Headers (`.get`), a Node or Express
 * request (`.headers`, a plain object), a Hono request (`.raw`), or a plain object of headers. Two keys of a plain
 * object that differ only in case are read joined, as an HTTP stack joins a repeated header, so neither is dropped.
 */
function headerReader(src) {
  const h = src?.headers ?? src?.raw?.headers ?? src;
  if (h && typeof h.get === "function") return (name) => h.get(name) ?? null;
  const lower = new Map();
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h)) {
      if (v === undefined || v === null) continue;
      const key = k.toLowerCase(), val = Array.isArray(v) ? v.join(", ") : String(v);
      lower.set(key, lower.has(key) ? `${lower.get(key)}, ${val}` : val);
    }
  }
  return (name) => lower.get(name) ?? null;
}

/**
 * One check: options as recordGate's (source, checkUrl, rpc, pool, cacheSeconds, cacheMax, fetchImpl) and judge's
 * (refuseDefaulted, minRepaid, minScore), plus failOpen (default false), retryAfter (seconds, default 10) and
 * onDecision. Its reads go through one recordGate's cache for the check's life.
 */
function makeCheck(opts = {}) {
  const { failOpen = false, retryAfter = 10, onDecision = null, refuseDefaulted = true, minRepaid = 0, minScore = null,
    tiers: _tiers, basePrice: _basePrice, ...read } = opts; // prices are the paywall's business, not the check's
  if (!(Number.isInteger(retryAfter) && retryAfter >= 1)) throw new TypeError("record check: retryAfter must be a whole number of seconds, at least 1");
  // the same cached reader recordGate uses (and its option checks: source, minRepaid, cacheMax)
  const gate = recordGate({ ...read, refuseDefaulted, minRepaid, minScore });
  const decide = (d) => { onDecision?.(d); return d; };

  return async function check(src) {
    const get = headerReader(src);
    const sent = PAYMENT_HEADERS.map((n) => get(n)).filter((v) => typeof v === "string" && v !== "");
    if (!sent.length) return { ok: true, payer: null, record: null }; // no payment: the paywall answers 402
    const payers = sent.map((v) => payerOf(decodePayment(v)));
    if (payers.includes(null) || new Set(payers).size > 1) {
      return decide({ ok: false, status: 403, payer: null, record: null, reason: "priors_payer_unknown", message: "The payment does not name a single payer." });
    }
    const payer = payers[0];
    let record;
    try { record = await gate.recordOf(payer, get("x-priors-agent")); } catch (e) {
      // the record could not be read: refuse rather than serve on a guess, unless the merchant chose to serve
      const message = `The payer's Priors record could not be read (${e?.message || e}); try again shortly.`;
      return decide(failOpen
        ? { ok: true, payer, record: null, reason: "priors_record_unavailable", message }
        : { ok: false, status: 503, retryAfter, payer, record: null, reason: "priors_record_unavailable", message });
    }
    const j = judge(record, { refuseDefaulted, minRepaid, minScore });
    return decide(j.ok ? { ok: true, payer, record } : { ok: false, status: 403, payer, record, reason: j.reason, message: j.message });
  };
}

const checks = new WeakMap();
const DEFAULTS = {};

/**
 * The decision for one request (a fetch Request, Headers, a Node/Express request or a plain headers object):
 * { ok, payer, record, reason?, message?, status? (403 | 503 when !ok), retryAfter? }. Calls with the same options
 * object share one cache; a new object starts a new one.
 */
export function checkRequest(request, opts = DEFAULTS) {
  let check = checks.get(opts);
  if (!check) { check = makeCheck(opts); checks.set(opts, check); }
  return check(request);
}

const bodyOf = (d) => JSON.stringify({ error: d.reason, message: d.message });
function headersOf(d) {
  const h = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (d.status === 503) h["retry-after"] = String(d.retryAfter);
  return h;
}
const responseOf = (d) => new Response(bodyOf(d), { status: d.status, headers: headersOf(d) });

/** Express / Connect / node:http middleware `(req, res, next)`: put it before the x402 paymentMiddleware. */
export function requireRecord(opts = {}) {
  const check = makeCheck(opts);
  return async function priorsRecord(req, res, next) {
    let d;
    try { d = await check(req); } catch (e) { return next(e); }
    if (d.ok) return next();
    res.statusCode = d.status;
    for (const [k, v] of Object.entries(headersOf(d))) res.setHeader(k, v);
    res.end(bodyOf(d));
  };
}

/** A fetch handler `(request, env?, ctx?) => Response` (Cloudflare Workers, Next route handlers, Bun) checked first. */
export function withRecord(handler, opts = {}) {
  if (typeof handler !== "function") throw new TypeError("withRecord: handler must be a function (request, env?, ctx?) => Response");
  const check = makeCheck(opts);
  return async function priorsRecord(request, ...rest) {
    const d = await check(request);
    return d.ok ? handler.call(this, request, ...rest) : responseOf(d);
  };
}

/** Hono middleware `(c, next)`: put it before the x402 paymentMiddleware. */
export function honoRecord(opts = {}) {
  const check = makeCheck(opts);
  return async function priorsRecord(c, next) {
    const d = await check(c.req.raw ?? c.req);
    if (!d.ok) return responseOf(d);
    await next();
  };
}
