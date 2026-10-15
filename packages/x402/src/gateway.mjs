// The Vantis gateway (Keyring, https://keyring.vantis.sh/gateway): buy from a seller in Keyring's x402 catalog, most of
// them paid in USDC on Base, with one USDG payment on Robinhood Chain. Off unless the caller names a gateway
// (createPayer({ gateway })); a payer without one never reads or pays anything here.
//
// What Keyring publishes (read live 2026-10-15, raw answers in docs/reports/2026-10-15-x402-routes/):
//   GET  /api/service/<id>           the seller's record: resource (its URL), method, network, priceUSD, suspicious
//   GET  /api/services?q=&per=       catalog search; items carry id, host, networkLabel, priceUSD
//   GET  /api/gateway/quote/<id>     { quote: { serviceId, available, atomic, asset: "USDG", network: "Robinhood
//                                    Chain", feeIncludedUSD }, armed }: one USDG price, the seller checked live first
//   POST /x402/run {serviceId, input} an x402 402 for USDG on Robinhood Chain, settled by facilitator.vantis.sh (x402 v2,
//                                    exact, EIP-3009 only); once paid, Keyring runs the call, pays the seller on its own
//                                    network from Keyring's wallet, relays the answer, and collects the USDG only after a
//                                    successful answer ("A failed call charges you nothing").
//
// To the payer the gateway is one more Robinhood Chain merchant, paid by the payer's usual path (from the balance, the
// caller's top-up, then a loan of only the shortfall within maxBorrow; one signature; the same one resent while pending).
// Two things differ, and these checks hold them before anything is signed or borrowed:
//   1. The seller is named by Keyring's catalog, not by the URL the payment goes to. The record is read first and must
//      name the resource (and method) the caller asked for; a record Keyring marks suspicious is refused.
//   2. Keyring sets the price. Its quote must fit the payer's maxPrice and stay within `maxFeeBps` over the seller's own
//      listed price; the 402 that follows must ask no more than the quote, on Robinhood Chain only, and (once the owner
//      pins it) pay Keyring's own address.
// Not seen live (nothing was POSTed to Keyring for this work, so no 402 of its was read): whether its 402 is v2
// (PAYMENT-REQUIRED, paid in PAYMENT-SIGNATURE; the facilitator behind it takes v2 only) or v1 (its pages say "retry
// with the X-PAYMENT header"); the payTo it is paid at; and how `input` maps onto the seller's request (the record's
// example is {body: {...}}, the gateway page's {query: "x402"}). The payer handles both 402 versions; the caller passes
// `input` as Keyring wants it.
import { ethers } from "ethers";
import { PayError } from "./credit.mjs";

/** Vantis' hosts: the Keyring gateway (catalog, quotes, /x402/run) and the facilitator that settles its USDG. */
export const VANTIS = Object.freeze({ gateway: "https://keyring.vantis.sh", facilitator: "https://facilitator.vantis.sh" });
/** Default most the gateway's quote may exceed the seller's own listed price by, in basis points (10 %). */
export const DEFAULT_GATEWAY_FEE_BPS = 1000;
/** Keyring's service ids, as its own gateway page checks them before quoting. */
const SERVICE_ID = /^svc_[0-9a-f]{10}$/;
/** At most this many catalog records are read to find a seller by its URL. */
const MAX_CANDIDATES = 20;

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && ethers.isAddress(a);

/**
 * The caller's `gateway` option, checked: null (off) when absent; else { url, maxFeeBps, payTo }. `url` defaults to
 * Vantis' gateway and must be https (plain http only on loopback, for tests); `payTo`, when set, is the only address a
 * gateway 402 may name (Keyring's, once the owner has read it from a first live call).
 * @param {undefined|null|false|{ url?: string, maxFeeBps?: number, payTo?: string }} g
 */
export function gatewayConfig(g) {
  if (g === undefined || g === null || g === false) return null;
  if (typeof g !== "object" || Array.isArray(g)) throw new PayError("BAD_GATEWAY", "gateway: pass an object { url?, maxFeeBps?, payTo? }");
  let u;
  try { u = new URL(g.url ?? VANTIS.gateway); } catch (_) { throw new PayError("BAD_GATEWAY", "gateway: url is not a URL"); }
  const loopback = u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !loopback) throw new PayError("BAD_GATEWAY", "gateway: url must be https (plain http only on loopback)");
  if (u.username || u.password || u.search || u.hash) throw new PayError("BAD_GATEWAY", "gateway: url must carry no credentials, query or fragment");
  const maxFeeBps = g.maxFeeBps ?? DEFAULT_GATEWAY_FEE_BPS;
  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) throw new PayError("BAD_GATEWAY", "gateway: maxFeeBps must be a whole number from 0 to 10000");
  if (g.payTo != null && !isAddr(g.payTo)) throw new PayError("BAD_GATEWAY", "gateway: payTo must be a 0x address");
  return Object.freeze({ url: u.origin + u.pathname.replace(/\/+$/, ""), maxFeeBps, payTo: g.payTo == null ? null : ethers.getAddress(g.payTo) });
}

/** A seller URL as the caller and Keyring may each write it: no fragment, no trailing dot on the host, query in name
 *  order. Null if it is not an http(s) URL. */
function resourceKey(s) {
  let u;
  try { u = new URL(String(s)); } catch (_) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = "";
  if (u.hostname.endsWith(".")) u.hostname = u.hostname.slice(0, -1);
  u.searchParams.sort();
  return u.href;
}

/** The seller's own listed price in atomic dollars (6 decimals), from the record's priceUSD; 0n if it names none. */
function listedAtomic(record) {
  const p = Number(record?.priceUSD);
  const a = Number.isFinite(p) && p > 0 ? Math.round(p * 1e6) : 0;
  return Number.isSafeInteger(a) && a > 0 ? BigInt(a) : 0n;
}

/**
 * The seller a gateway call is for, from Keyring's catalog: by `serviceId`, or by the seller's `resource` URL (searched
 * by its host; exactly one record must name that URL, and that method when given). The record must name what the caller
 * asked for, not be marked suspicious or testnet, and list a price. `getJson(url, { missingOk })` reads one gateway
 * URL (null for a 404 when `missingOk`).
 * Refusals (PayError): BAD_GATEWAY_SERVICE (no usable serviceId or resource), GATEWAY_NO_SERVICE, GATEWAY_REFUSED.
 * @returns {Promise<{ serviceId: string, resource: string, method: string|null, network: string|null, listed: bigint }>}
 */
export async function findGatewayService(cfg, { serviceId, resource, method } = {}, getJson) {
  const want = resource === undefined ? null : resourceKey(resource);
  if (resource !== undefined && !want) throw new PayError("BAD_GATEWAY_SERVICE", "payViaGateway: resource must be the seller's http(s) URL");
  const wantMethod = method === undefined ? null : String(method).toUpperCase();
  const matches = (rec) => rec && (!want || resourceKey(rec.resource) === want) && (!wantMethod || String(rec.method || "GET").toUpperCase() === wantMethod);
  let record;
  if (serviceId !== undefined) {
    if (!SERVICE_ID.test(String(serviceId))) throw new PayError("BAD_GATEWAY_SERVICE", "payViaGateway: serviceId must look like svc_0123456789 (Keyring's catalog id)");
    record = await getJson(`${cfg.url}/api/service/${serviceId}`, { missingOk: true });
    if (record?.id !== serviceId) throw new PayError("GATEWAY_NO_SERVICE", "payViaGateway: the gateway returned no record for that serviceId; nothing was paid");
    if (!matches(record)) throw new PayError("GATEWAY_REFUSED", "payViaGateway: the gateway's record for that serviceId names another resource or method; nothing was paid");
  } else if (want) {
    const host = new URL(want).hostname;
    const list = await getJson(`${cfg.url}/api/services?q=${encodeURIComponent(host)}&per=${MAX_CANDIDATES}`);
    const ids = (Array.isArray(list?.items) ? list.items : []).filter((it) => SERVICE_ID.test(String(it?.id)) && String(it.host).toLowerCase() === host).map((it) => it.id).slice(0, MAX_CANDIDATES);
    const found = [];
    for (const id of ids) { const rec = await getJson(`${cfg.url}/api/service/${id}`, { missingOk: true }); if (rec?.id === id && matches(rec)) found.push(rec); }
    if (found.length !== 1) {
      throw new PayError("GATEWAY_NO_SERVICE", found.length === 0
        ? "payViaGateway: no seller in the gateway's catalog names that resource; nothing was paid (pass serviceId if you know it)"
        : "payViaGateway: several sellers in the gateway's catalog name that resource; pass serviceId (and method); nothing was paid");
    }
    record = found[0];
  } else {
    throw new PayError("BAD_GATEWAY_SERVICE", "payViaGateway: name the seller by serviceId or resource");
  }
  // Keyring's own flags: a listing it marks suspicious, or a testnet one, is not bought through it.
  if (record.suspicious === true) throw new PayError("GATEWAY_REFUSED", "payViaGateway: the gateway's catalog marks this seller suspicious; nothing was paid");
  if (record.testnet === true) throw new PayError("GATEWAY_REFUSED", "payViaGateway: this seller is on a testnet; nothing was paid");
  const listed = listedAtomic(record);
  // Without the seller's own price the gateway's fee cannot be bounded: refused rather than paid on the quote alone.
  if (listed === 0n) throw new PayError("GATEWAY_REFUSED", "payViaGateway: the gateway's record lists no price for this seller, so its fee cannot be checked; nothing was paid");
  return { serviceId: record.id, resource: String(record.resource), method: record.method ? String(record.method).toUpperCase() : null, network: typeof record.network === "string" ? record.network : null, listed };
}

/**
 * The gateway's quote for `service` (the body of GET /api/gateway/quote/<id>), checked: the gateway armed, the seller
 * available, one USDG price on Robinhood Chain, at most `maxPrice`, and at most `maxFeeBps` over the seller's listed
 * price. Returns the quoted price, atomic USDG; the 402 that follows may ask no more.
 * Refusals (PayError): GATEWAY_UNAVAILABLE, GATEWAY_REFUSED, PRICE_ABOVE_MAX_PRICE, GATEWAY_FEE_TOO_HIGH.
 * @returns {bigint}
 */
export function checkGatewayQuote(body, service, { maxPrice, maxFeeBps }) {
  if (body?.armed !== true) throw new PayError("GATEWAY_UNAVAILABLE", "payViaGateway: the gateway says it is not enabled; nothing was paid");
  const q = body.quote;
  if (!q || q.serviceId !== service.serviceId) throw new PayError("GATEWAY_REFUSED", "payViaGateway: the gateway's quote is for another seller; nothing was paid");
  if (q.available !== true) throw new PayError("GATEWAY_UNAVAILABLE", "payViaGateway: the gateway cannot reach this seller now; nothing was paid");
  if (q.asset !== "USDG" || q.network !== "Robinhood Chain") throw new PayError("GATEWAY_REFUSED", "payViaGateway: the gateway's quote is not a USDG price on Robinhood Chain; nothing was paid");
  if (!/^\d{1,30}$/.test(String(q.atomic)) || BigInt(q.atomic) === 0n) throw new PayError("GATEWAY_REFUSED", "payViaGateway: the gateway's quote carries no price; nothing was paid");
  const quoted = BigInt(q.atomic);
  if (quoted > maxPrice) throw new PayError("PRICE_ABOVE_MAX_PRICE", `pay: price ${quoted} is above maxPrice ${maxPrice}; not paying`, { price: quoted, maxPrice });
  if (quoted * 10_000n > service.listed * BigInt(10_000 + maxFeeBps)) {
    throw new PayError("GATEWAY_FEE_TOO_HIGH", `payViaGateway: the gateway quotes ${quoted}, more than ${maxFeeBps} bps over the seller's listed ${service.listed}; nothing was paid`, { quoted, listed: service.listed, maxFeeBps });
  }
  return quoted;
}

/** The gateway call itself: POST <gateway>/x402/run with {serviceId, input} as JSON. */
export function gatewayRun(cfg, serviceId, input) {
  let body;
  try { body = JSON.stringify({ serviceId, input: input ?? {} }); } catch (_) { throw new PayError("BAD_GATEWAY_SERVICE", "payViaGateway: input must be plain JSON"); }
  return { url: `${cfg.url}/x402/run`, init: { method: "POST", headers: { "content-type": "application/json" }, body } };
}
