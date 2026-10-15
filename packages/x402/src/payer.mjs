// Agent side: pay x402 USDG requirements on Robinhood Chain, borrowing the gap from a Priors v2 line when short; and,
// only when the caller enables it (`networks`), USDC requirements on Base, paid from the agent's Base float.
//
// Built on the official client stack: `x402Client` and `x402HTTPClient` (re-exported by @x402/fetch from
// @x402/core) parse the 402, apply spend controls, build the v2 payload and encode the PAYMENT-SIGNATURE header,
// and `ExactEvmScheme` (@x402/evm) signs the EIP-3009 authorization. The request loop itself is written out here
// instead of calling `wrapFetchWithPayment`, because that wrapper cannot keep this module's promises:
//   1. Borrowing must happen after the price is known and checked, and before anything is signed. The wrapper
//      only offers a hook inside `createPaymentPayload`; a refusal there comes back as a generic
//      "Failed to create payment payload" Error, which loses the refusal code callers branch on.
//   2. One signature per purchase. When a payment-response hook reports `recovered`, the wrapper signs a FRESH
//      payload and sends it again, while the first authorization may still settle: that is how a call is paid
//      twice. Here the one signed header is resent unchanged while the merchant answers "pending", and handed back
//      (`paymentHeaders`) if it is still pending, for `resend()` later.
//   3. It has no pending loop at all, and it returns only the Response, so the signed header cannot be resent.
//   4. Legacy x402 v1 bodies with network "robinhood" (our facilitator, api/server.mjs, sdk/float.mjs) are not a
//      network @x402/evm's v1 scheme knows; they go to the v1 signer ported from sdk/float.mjs instead.
// `createUsdgClient()` still gives a plain x402Client for @x402/fetch's wrapper or @x402/mcp's client, with the
// same USDG allowance, price cap and 600 s authorization cap, for callers that never borrow.
//
// Base (eip155:8453, networks.mjs): a payer signs a Base USDC requirement only when `networks` names Base, and pays it
// from the USDC the wallet already holds there (its Base float, read through `baseProvider`). Nothing on the Robinhood
// Chain side runs for it: no savings top-up, no Autopay reserve, no loan (the line lives on Robinhood Chain, and
// bridge.mjs moves money between the two). A float short of the price is refused (BASE_FLOAT_SHORT) before anything is
// signed, and so is one whose free part is: `baseReserve()` names what the float keeps back (the MCP's return to
// Robinhood Chain whose authorization can still pull it). A seller that offers both is paid in USDG on Robinhood Chain.
// Legacy v1 bodies stay Robinhood Chain only.
//
// The Vantis gateway (gateway.mjs; off unless `gateway` is given): `payViaGateway` buys from a seller in Keyring's
// catalog (most of them paid in USDC on Base) with one USDG payment on Robinhood Chain. The gateway's quote is checked
// first (maxPrice, and its fee over the seller's own listed price); its 402 is then paid by the same path as any
// Robinhood Chain merchant's, with every rule above, and must ask no more than the quote.
import { ethers } from "ethers";
import { x402Client, x402HTTPClient, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { robinhood, ROBINHOOD_NETWORKS, DEFAULT_MAX_PRICE, MAX_VALIDITY_SECONDS, TRANSFER_WITH_AUTHORIZATION_TYPES, toAtomicUsdg, formatUsdg } from "./robinhood.mjs";
import { PayError, borrowGap, settleLoans, poolContract, ERC20_ABI } from "./credit.mjs";
import { DEFAULT_PAY_NETWORKS, ROBINHOOD_USDG, networkOf, payNetworks } from "./networks.mjs";
import { gatewayConfig, findGatewayService, checkGatewayQuote, gatewayRun } from "./gateway.mjs";

const sameAddr = (a, b) => typeof a === "string" && typeof b === "string" && ethers.isAddress(a) && ethers.isAddress(b) && ethers.getAddress(a) === ethers.getAddress(b);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A payer's per-request timeout unless `timeoutMs` says otherwise (0 = none): its payments run one at a time, so a
 *  merchant that never answers must not hold the wallet's other purchases forever. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Merchant bodies are read at most this far: a merchant that streams gigabytes cannot exhaust the payer's memory. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * A response body as text, at most `max` bytes (UTF-8); the rest is cancelled, not read. `cut` says it was.
 * @returns {Promise<{ text: string, cut: boolean }>}
 */
export async function readCapped(response, max = MAX_BODY_BYTES) {
  if (!response?.body) return { text: "", cut: false };
  const reader = response.body.getReader();
  const chunks = [];
  let n = 0, cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.byteLength > max) { chunks.push(value.subarray(0, max - n)); n = max; cut = true; await reader.cancel().catch(() => {}); break; }
    chunks.push(value); n += value.byteLength;
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return { text: new TextDecoder().decode(buf), cut };
}

const isAbort = (e) => e?.name === "AbortError" || e?.name === "TimeoutError";

/** The capped window: the merchant's maxTimeoutSeconds, at most `cap` (never above 600 s), 60 s if it names none. */
function validityWindow(asked, cap = MAX_VALIDITY_SECONDS) {
  const c = Math.min(Number(cap) > 0 ? Number(cap) : MAX_VALIDITY_SECONDS, MAX_VALIDITY_SECONDS);
  const a = Number(asked);
  return Number.isSafeInteger(a) && a > 0 ? Math.min(a, c) : Math.min(60, c);
}

/**
 * An ethers v6 Signer as the `ClientEvmSigner` @x402/evm expects ({address, signTypedData({domain, types,
 * primaryType, message})}). A viem LocalAccount already has that shape and is returned as is.
 * @param {any} signer
 * @param {string} [address]  the signer's address, if already known (ethers signers resolve it asynchronously)
 */
export function toX402Signer(signer, address) {
  if (signer && typeof signer.address === "string" && typeof signer.signTypedData === "function" && typeof signer.getAddress !== "function") return signer;
  const addr = address || signer?.address;
  if (!addr || !ethers.isAddress(addr)) throw new PayError("NO_SIGNER", "toX402Signer: the signer's address is needed (pass it, or use an ethers Wallet)");
  return {
    address: ethers.getAddress(addr),
    async signTypedData({ domain, types, message }) {
      const t = { ...types };
      delete t.EIP712Domain;
      return signer.signTypedData(domain, t, message);
    },
  };
}

/**
 * `ExactEvmScheme` (client) for USDG on eip155:4663 (and USDC on Base, where the caller registers it) that never signs
 * an authorization valid for more than `maxValiditySeconds` (≤ 600), whatever `maxTimeoutSeconds` the 402 names. The
 * signed window is capped; the payload's `accepted` stays the merchant's requirement verbatim (the resource server
 * matches it field for field). A requirement without `extra.name/version` is signed on the domain of its network's
 * token (networks.mjs: "USD Coin"/"2" on Base), and on USDG's own domain on any network not listed there.
 */
export class CappedExactEvmScheme {
  /** @param {any} signer ClientEvmSigner (or an ethers Wallet) @param {{ maxValiditySeconds?: number }} [o] */
  constructor(signer, { maxValiditySeconds = MAX_VALIDITY_SECONDS } = {}) {
    this.scheme = "exact";
    this.inner = new ExactEvmScheme(signer && typeof signer.getAddress === "function" ? toX402Signer(signer) : signer);
    this.maxValiditySeconds = maxValiditySeconds;
  }
  async createPaymentPayload(x402Version, requirements, context) {
    if (requirements?.extra?.assetTransferMethod && requirements.extra.assetTransferMethod !== "eip3009") throw new PayError("UNSUPPORTED_TRANSFER_METHOD", "only EIP-3009 authorizations are signed for USDG");
    const extra = { ...(requirements.extra || {}) };
    const domain = networkOf(requirements?.network)?.eip712 ?? robinhood.eip712;
    if (!extra.name) extra.name = domain.name;
    if (!extra.version) extra.version = domain.version;
    const signed = { ...requirements, maxTimeoutSeconds: validityWindow(requirements.maxTimeoutSeconds, this.maxValiditySeconds), extra };
    return this.inner.createPaymentPayload(x402Version, signed, context);
  }
}

/**
 * An `x402Client` that pays USDG on eip155:4663 only (and USDC on Base when `networks` names it): capped signing
 * window, and a spend control that allows only each enabled network's own token (networks.mjs; `asset` overrides USDG
 * for a fork or test token) and refuses any requirement above `maxPrice` (atomic units of the 6-decimal dollar token,
 * or "$0.10"; default 0.10). Use it with @x402/fetch's `wrapFetchWithPayment` or @x402/mcp's
 * `wrapMCPClientWithPayment` when no borrowing is wanted.
 * @param {{ signer: any, maxPrice?: bigint|number|string, maxValiditySeconds?: number, asset?: string, networks?: string[] }} o
 */
export function createUsdgClient({ signer, maxPrice = DEFAULT_MAX_PRICE, maxValiditySeconds = MAX_VALIDITY_SECONDS, asset = robinhood.usdg, x402Signer, networks = DEFAULT_PAY_NETWORKS } = {}) {
  const cap = toAtomicUsdg(maxPrice, "maxPrice");
  const scheme = new CappedExactEvmScheme(x402Signer || signer, { maxValiditySeconds });
  const client = new x402Client();
  const allowedAssets = [];
  // Base is registered only when enabled: by default the client knows no network but Robinhood Chain.
  for (const id of payNetworks(networks)) {
    client.register(id, scheme);
    allowedAssets.push({ network: id, asset: id === robinhood.network ? asset : networkOf(id).asset, maxAmountPerPayment: cap.toString() });
  }
  return client.setSpendControls({ allowedAssets });
}

/** A payTo is a 0x address: ethers also accepts an ICAP "XE..." form, whose 30 characters the merchant chooses and
 *  pay_url would print outside its fence (own audit 2026-10-01). */
const isPayTo = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && ethers.isAddress(a);
/** The `extra.paymentFlow` values @x402/core's client signs (x402Client.selectPaymentRequirements drops any other, and
 *  none at all is "authorization"). createPayer also asks core itself before anything is borrowed (GHSA-f35g). */
const CORE_PAYMENT_FLOWS = new Set(["authorization", "upfront", "escrow"]);

/**
 * First v2 `exact` requirement this payer can sign: EIP-3009, on an enabled network of the allowlist (networks.mjs;
 * `networks` defaults to Robinhood Chain only), for that network's own token by full address (`asset` on Robinhood
 * Chain, default USDG; Base USDC's pinned address on Base: a lookalike is never matched), with no EIP-712 domain but
 * that token's own (a requirement naming none is signed on it), and no `paymentFlow` x402 core does not sign (a later
 * requirement is taken instead, as core takes it). A seller that takes both is paid on Robinhood Chain.
 */
export function pickV2Requirement(accepts, asset = robinhood.usdg, { networks = DEFAULT_PAY_NETWORKS } = {}) {
  const list = Array.isArray(accepts) ? accepts : [];
  const enabled = payNetworks(networks);
  const order = enabled.includes(robinhood.network) ? [robinhood.network, ...enabled.filter((id) => id !== robinhood.network)] : enabled;
  for (const id of order) {
    const n = networkOf(id), token = id === robinhood.network ? asset : n.asset;
    const r = list.find((x) => x && x.scheme === "exact" && x.network === id && sameAddr(x.asset, token)
      && /^\d+$/.test(String(x.amount)) && isPayTo(x.payTo)
      && (!x.extra?.assetTransferMethod || x.extra.assetTransferMethod === "eip3009")
      && (x.extra?.paymentFlow == null || CORE_PAYMENT_FLOWS.has(x.extra.paymentFlow))
      && (!x.extra?.name || x.extra.name === n.eip712.name) && (!x.extra?.version || x.extra.version === n.eip712.version));
    if (r) return r;
  }
  return null;
}

/** First v1 `exact` USDG requirement on Robinhood Chain (sdk/float.mjs `pickRequirement`). */
export function pickV1Requirement(accepts, asset = robinhood.usdg) {
  return (Array.isArray(accepts) ? accepts : []).find((r) => r && r.scheme === "exact" && ROBINHOOD_NETWORKS.has(r.network) && sameAddr(r.asset, asset)
    && /^\d+$/.test(String(r.maxAmountRequired)) && isPayTo(r.payTo)) || null;
}

/**
 * Sign a v1 X-PAYMENT for `req` (port of sdk/float.mjs `signPayment`): EIP-3009 on USDG's domain, valid from 10
 * minutes ago (clock skew) until the merchant's window capped at 600 s, base64 JSON as the Priors facilitator reads it.
 */
export async function signPaymentV1(signer, req, { now = Math.floor(Date.now() / 1000), chainId = robinhood.chainId, maxValiditySeconds = MAX_VALIDITY_SECONDS } = {}) {
  const from = await signer.getAddress();
  const authorization = {
    from,
    to: ethers.getAddress(req.payTo),
    value: String(req.maxAmountRequired),
    validAfter: String(now - 600),
    validBefore: String(now + validityWindow(req.maxTimeoutSeconds, maxValiditySeconds)),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const domain = { ...robinhood.eip712, chainId, verifyingContract: ethers.getAddress(req.asset) };
  const signature = await signer.signTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, authorization);
  const json = JSON.stringify({ x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization } });
  return Buffer.from(json, "utf8").toString("base64");
}

/** Does this response say "your payment was broadcast, not confirmed yet: send the same one again"? */
async function isPending(response) {
  if (response.status !== 402) return false;
  for (const name of ["PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"]) {
    const h = response.headers.get(name);
    if (!h) continue;
    try { if (decodePaymentResponseHeader(h)?.errorReason === "settlement_pending") return true; } catch (_) { /* not a settle response */ }
  }
  try { const b = JSON.parse((await readCapped(response.clone(), 64 * 1024)).text); return b?.pending === true || b?.errorReason === "settlement_pending"; } catch (_) { return false; }
}

function settlementOf(response) {
  for (const name of ["PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"]) {
    const h = response.headers.get(name);
    if (h) { try { return decodePaymentResponseHeader(h); } catch (_) { /* ignore */ } }
  }
  return undefined;
}

// A redirect is never followed by default: a signed payment header must not travel to a host the caller did not
// name, and a 3xx is handed back as the answer (its Location is the caller's to judge). `init.redirect ?? "manual"`,
// not a spread default: `{ redirect: undefined }` must not turn following back on (GHSA-rg6j).
const asRequest = (input, init) => new Request(input, { ...(init || {}), redirect: init?.redirect ?? "manual" });

/**
 * fetchImpl with a per-request timeout (`timeoutMs`, 0 = none) and an overall `signal`, both optional, kept with the
 * request's own signal (the caller's `init.signal`): rebuilding the request with only these two dropped it (GHSA-868j).
 * @returns {(req: Request) => Promise<Response>}
 */
function timedFetch(fetchImpl, { timeoutMs = 0, signal } = {}) {
  if (!timeoutMs && !signal) return fetchImpl;
  return (req) => {
    const signals = [req.signal, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null, signal || null].filter(Boolean);
    return fetchImpl(new Request(req, { signal: AbortSignal.any(signals) }));
  };
}

/**
 * Send an already-signed payment (`paymentHeaders`, e.g. {"PAYMENT-SIGNATURE": "…"}) and keep resending the SAME
 * one while the merchant answers 402 pending (x402 v2 `settlement_pending`, or a legacy `{pending:true}` body).
 * Never signs anything. Once the payment may be out, no error is thrown: a timeout or an abort is reported as
 * pending (`timedOut: true`, a synthetic 504), and any other transport error (a reset, a dropped connection) as
 * pending too (`transportError: true`, a synthetic 502, the error in `error`), with the headers to resend: the
 * merchant may have read the payment and may still settle it, so it must never be signed again.
 * @returns {Promise<{ response: Response, pending: boolean, timedOut?: boolean, transportError?: boolean, error?: unknown, paymentHeaders?: Record<string,string> }>}
 */
export async function resend(input, paymentHeaders, { init, fetchImpl = globalThis.fetch, retries = 6, sleep = defaultSleep, maxSleepMs = 30_000, timeoutMs = 0, signal } = {}) {
  const base = asRequest(input, init);
  const fx = timedFetch(fetchImpl, { timeoutMs, signal });
  const send = () => {
    const r = base.clone();
    for (const [k, v] of Object.entries(paymentHeaders)) r.headers.set(k, v);
    r.headers.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");
    return fx(r);
  };
  const timedOut = () => ({ response: new Response(null, { status: 504, statusText: "payer timeout" }), pending: true, timedOut: true, paymentHeaders });
  let response;
  try {
    response = await send();
    for (let i = 0; i < retries && (await isPending(response)); i++) {
      if (signal?.aborted || base.signal.aborted) return timedOut();
      const after = Number(response.headers.get("retry-after"));
      await sleep(Math.min(maxSleepMs, 1000 * Math.min(30, Math.max(1, Number.isFinite(after) && after > 0 ? after : 5))));
      response = await send();
    }
  } catch (e) {
    if (isAbort(e)) return timedOut();
    return { response: new Response(null, { status: 502, statusText: "payer transport error" }), pending: true, transportError: true, error: e, paymentHeaders };
  }
  const pending = await isPending(response);
  return { response, pending, ...(pending ? { paymentHeaders } : {}) };
}

/** A JSON number by its value, every digit kept: one a double holds exactly (at most 15 significant digits, in range) as
 *  JSON.stringify writes it; any other, such as a 20-digit id or 1e400, as its significant digits and power of ten
 *  (GHSA-7m69: a double would read it the same as its neighbours, and keying such a body by its bytes made the same
 *  body, re-spelled, a second purchase). */
function canonicalNumber(n) {
  const [, sign, int, frac = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(n);
  const all = int + frac, trimmed = all.replace(/0+$/, ""), digits = trimmed.replace(/^0+/, "");
  if (digits === "") return "0";
  const x = Math.abs(Number(n));
  if (digits.length <= 15 && x >= 1e-300 && x < Infinity) return JSON.stringify(Number(n));
  return `${sign}${digits}e${BigInt(exp) - BigInt(frac.length) + BigInt(all.length - trimmed.length)}`;
}
/** A valid JSON text with sorted keys, no whitespace and one spelling per string and number, read from the text itself
 *  (not JSON.parse's doubles): two bodies that are the same JSON value are the same purchase. An explicit stack and a
 *  character scan, no recursion and no backtracking regex, so no valid body is too deep or too long for it (own audit
 *  2026-10-01: a body nested 10,000 deep, or a 16M-character string, fell back to its bytes and was signed twice). */
function canonicalJson(text) {
  const n = text.length;
  let i = 0;
  const ws = () => { while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++; };
  const str = () => { const s = i++; while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1; i++; return JSON.parse(text.slice(s, i)); };
  const stack = []; // open containers: { obj: Map (the last of a repeated key, as JSON.parse reads it), key } or { arr }
  for (;;) {
    ws();
    let v;
    const c = text[i];
    if (c === "{") {
      i++; ws();
      if (text[i] === "}") { i++; v = "{}"; } else { const key = str(); ws(); i++; stack.push({ obj: new Map(), key }); continue; }
    } else if (c === "[") {
      i++; ws();
      if (text[i] === "]") { i++; v = "[]"; } else { stack.push({ arr: [] }); continue; }
    } else if (c === '"') v = JSON.stringify(str());
    else if (c === "-" || (c >= "0" && c <= "9")) { const s = i; while (i < n && "+-.eE0123456789".includes(text[i])) i++; v = canonicalNumber(text.slice(s, i)); }
    else { v = text.startsWith("true", i) ? "true" : text.startsWith("false", i) ? "false" : "null"; i += v.length; }
    // the value goes into its container; every container the next character closes becomes a value in turn
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) return v;
      if (top.arr) top.arr.push(v); else top.obj.set(top.key, v);
      ws();
      if (text[i++] === ",") { if (top.obj) { ws(); top.key = str(); ws(); i++; } break; }
      stack.pop();
      v = top.arr ? `[${top.arr.join(",")}]` : `{${[...top.obj.keys()].sort().map((k) => `${JSON.stringify(k)}:${top.obj.get(k)}`).join(",")}}`;
    }
  }
}
/** A URL as the merchant reads it: what WHATWG URL leaves apart but servers read alike is written one way (own audit
 *  2026-10-01): the fragment and a trailing dot of the host dropped, path escapes of unreserved characters decoded and
 *  the others in upper case (RFC 3986 6.2.2), the query as form fields sorted by name ("+" and %20 alike, repeated names
 *  kept in order) and an empty "?" dropped. Two URLs it merges at worst share one authorization, settled once. */
function purchaseUrl(url) {
  const u = new URL(url);
  u.hash = "";
  if (u.hostname.endsWith(".")) u.hostname = u.hostname.slice(0, -1);
  u.pathname = u.pathname.replace(/%[0-9a-fA-F]{2}/g, (m) => { const ch = String.fromCharCode(parseInt(m.slice(1), 16)); return /[A-Za-z0-9._~-]/.test(ch) ? ch : m.toUpperCase(); });
  if (u.search) u.searchParams.sort(); else u.search = "";
  return u.href;
}
/**
 * A purchase's identity: the method, the URL as the merchant reads it (purchaseUrl: a fragment never reaches it), and
 * the body (GHSA-xqp9), as a SHA-256: a JSON body by its value (key order and whitespace do not make a second purchase),
 * a urlencoded or multipart form by its fields, any other body by its bytes. No body: method and URL only.
 * @param {Request} req
 * @returns {Promise<string>}
 */
export async function purchaseKey(req) {
  const head = `${req.method} ${purchaseUrl(req.url)}`;
  const bytes = req.body ? new Uint8Array(await req.clone().arrayBuffer()) : new Uint8Array(0);
  if (bytes.length === 0) return head;
  const type = req.headers.get("content-type") || "";
  const essence = type.split(";")[0].trim().toLowerCase();
  let canon = null;
  // A form is told by its media type, before the JSON arm: a boundary or a parameter that holds "json" does not make a
  // form JSON (GHSA-79g3: such a form failed JSON.parse and was keyed by its bytes, boundary included).
  if (essence === "multipart/form-data") {
    const boundary = mediaTypeParams(type)?.get("boundary");
    const fields = boundary ? multipartFields(bytes, boundary) : null;
    if (fields !== null) canon = "form:" + fields;
  } else if (essence === "application/x-www-form-urlencoded") {
    try { const p = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); p.sort(); canon = "urlencoded:" + p.toString(); } catch (_) { /* not UTF-8: by its bytes */ }
  } else if (/json/i.test(type)) {
    let text = null;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); JSON.parse(text); } catch (_) { text = null; /* not JSON: by its bytes */ }
    // valid JSON is keyed by its value, never by its bytes: should that ever throw, nothing is signed
    if (text !== null) canon = "json:" + canonicalJson(text);
  }
  const digest = ethers.sha256(canon !== null ? ethers.toUtf8Bytes(canon) : ethers.concat([ethers.toUtf8Bytes("raw:"), bytes]));
  return `${head} body:${digest.slice(2)}`;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** The parameters after a header's first value (`; a=b; c="d"`), as form parsers read them: a Map by lower-case name,
 *  a quoted value unquoted, whitespace around ";" and "=" ignored (Go's and Python's parsers accept it; busboy and
 *  undici refuse such a request, so merging it costs nothing). null if a parameter does not parse, or a name repeats
 *  with another value (which one a parser takes is the parser's). */
function headerParams(s) {
  const params = new Map();
  const re = /[ \t]*;[ \t]*(?:([^\s=;"]+)[ \t]*=[ \t]*("(?:[^"\\]|\\[\s\S])*"|[^";]*?))?[ \t]*(?=;|$)/y;
  for (let i = 0; i < s.length; ) {
    re.lastIndex = i;
    const p = re.exec(s);
    if (!p || re.lastIndex === i) return null;
    i = re.lastIndex;
    if (p[1] === undefined) continue; // an empty ";"
    const k = p[1].toLowerCase(), v = p[2].startsWith('"') ? p[2].slice(1, -1).replace(/\\([\s\S])/g, "$1") : p[2];
    if (params.has(k) && params.get(k) !== v) return null;
    params.set(k, v);
  }
  return params;
}
/** A media type's parameters (headerParams), or null if it is not `type/subtype` followed by parameters. */
function mediaTypeParams(s) {
  const mt = /^[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]*/.exec(s);
  return mt ? headerParams(s.slice(mt[0].length)) : null;
}
/** A part's media type as form parsers read it (GHSA-3h5x): the type in lower case (text/plain when the part names
 *  none) and its charset unless it is UTF-8, the default every parser applies (busboy decodes a field by it); a
 *  file's other parameters too (undici's File.type keeps them), sorted by name. Parameter order, quoting, case and
 *  whitespace do not count. A media type that does not parse is kept as 0.2.7 wrote it. */
function partMediaType(raw, isFile) {
  if (raw === undefined) return "text/plain";
  const params = mediaTypeParams(raw);
  if (!params) return raw.toLowerCase().replace(/[ \t]*([;=])[ \t]*/g, "$1");
  const kept = [];
  for (const [k, v] of params) {
    if (k === "charset") { const c = v.toLowerCase() === "utf8" ? "utf-8" : v.toLowerCase(); if (c !== "utf-8") kept.push([k, c]); }
    else if (isFile) kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return raw.split(";")[0].trim().toLowerCase() + kept.map(([k, v]) => `;${k}=${TOKEN.test(v) ? v : JSON.stringify(v)}`).join("");
}
/** Transfer encodings that leave the bytes as they are; any other (quoted-printable, base64) Go and Python decode. */
const IDENTITY_CTE = new Set(["7bit", "8bit", "binary"]);
/** An RFC 8187 ext-value (`charset'language'value`, the value percent-encoded) decoded as parsers decode it: UTF-8 or
 *  ISO-8859-1, the charset's case, the language and the hex digits' case not counting. null if it is not one. */
function extValue(v) {
  const m = /^([!#$&+.^_`|~0-9A-Za-z-]+)'[^']*'((?:%[0-9A-Fa-f]{2}|[!#$&+.^_`|~0-9A-Za-z-])*)$/.exec(v);
  if (!m) return null;
  const charset = m[1].toLowerCase();
  if (charset !== "utf-8" && charset !== "iso-8859-1") return null;
  const bytes = [];
  for (let i = 0; i < m[2].length; i++) {
    if (m[2][i] === "%") { bytes.push(parseInt(m[2].slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(m[2].charCodeAt(i));
  }
  if (charset === "iso-8859-1") return Buffer.from(bytes).toString("latin1");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); } catch (_) { return null; }
}
/**
 * A multipart/form-data body by its fields, as a form parser reads it (RFC 7578, GHSA-85hm): each part by its name,
 * its file name if it has one, its media type (partMediaType), what else a parser can read differently (a transfer
 * encoding that is not the identity, an RFC 8187 parameter such as filename*, as written) and its value's bytes, the
 * parts sorted by name (stably: repeated fields keep their order, as URLSearchParams.sort does). The boundary, the
 * preamble and the epilogue, header names' case, whether a name is quoted, parameter order and spelling, and part
 * headers no form parser reads (GHSA-cpvc) do not count. Anything that is not a well-formed form returns null, and the
 * body is then keyed by its bytes.
 */
function multipartFields(bytes, boundary) {
  const s = Buffer.from(bytes).toString("latin1");
  const d = "--" + boundary;
  const at = s.startsWith(d) ? 0 : s.indexOf("\r\n" + d);
  if (at < 0) return null;
  const segments = s.slice(at === 0 ? d.length : at + 2 + d.length).split("\r\n" + d);
  if (segments.length < 2 || !segments.pop().startsWith("--")) return null; // no part, or no closing delimiter
  const parts = [];
  for (const seg of segments) {
    const m = /^[ \t]*\r\n([\s\S]*?)\r\n\r\n([\s\S]*)$/.exec(seg);
    if (!m) return null;
    const headers = new Map();
    for (const line of m[1].split("\r\n")) {
      const h = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/.exec(line); // a folded or broken line is not a form
      if (!h) return null;
      const k = h[1].toLowerCase();
      if (k !== "content-disposition" && k !== "content-type" && k !== "content-transfer-encoding") continue; // no parser reads it
      if (headers.has(k)) return null; // two of a header a parser reads: which one it takes is the parser's
      headers.set(k, h[2]);
    }
    const cd = /^form-data(?=[ \t;]|$)/i.exec(headers.get("content-disposition") || "");
    const params = cd ? headerParams(headers.get("content-disposition").slice(cd[0].length)) : null;
    if (!params || !params.has("name")) return null;
    // filename* is the file name parsers read in place of filename (busboy, Go, undici's FormData), decoded: its
    // charset's case and its percent-encoding do not count. One that does not decode, and any other RFC 8187 parameter,
    // is kept as written, never a reason to key the form by its bytes (GHSA-79g3). Other disposition parameters no
    // parser reads.
    let filename = params.has("filename") ? params.get("filename") : null;
    const extra = [];
    for (const [k, v] of params) {
      if (!k.endsWith("*")) continue;
      const decoded = k === "filename*" ? extValue(v) : null;
      if (decoded !== null) filename = decoded; else extra.push(`${k}=${v}`);
    }
    const cte = (headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
    if (!IDENTITY_CTE.has(cte)) extra.push(`content-transfer-encoding:${cte}`);
    parts.push([params.get("name"), filename, partMediaType(headers.get("content-type"), filename !== null), extra.sort(), Buffer.from(m[2], "latin1").toString("hex")]);
  }
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(parts);
}
/** Seconds an unsettled authorization is kept past its validBefore, for clock skew between the payer and the chain. */
export const SKEW_SECONDS = 60;

/**
 * A payer for x402 USDG on Robinhood Chain (and, with `networks` naming Base and a `baseProvider`, USDC on Base from
 * the wallet's Base float).
 * @param {import("../index.d.ts").CreatePayerOptions} opts
 * @returns {import("../index.d.ts").Payer}
 */
export function createPayer(opts = {}) {
  const { signer, agentId, pool, termSeconds, maxFee, asset, fetchImpl = globalThis.fetch, pendingRetries = 6, sleep = defaultSleep, maxSleepMs = 30_000, timeoutMs = DEFAULT_TIMEOUT_MS, signal, maxValiditySeconds = MAX_VALIDITY_SECONDS, topUp, onSigned, reserve, v5, v5Root, baseProvider, baseReserve } = opts;
  if (!signer || typeof signer.getAddress !== "function" || typeof signer.signTypedData !== "function") {
    throw new PayError("NO_SIGNER", "createPayer: `signer` must be an ethers v6 Signer (a Wallet connected to a Robinhood Chain provider)");
  }
  if (typeof fetchImpl !== "function") throw new PayError("NO_FETCH", "createPayer: no fetch implementation");
  // The networks it signs for (networks.mjs): Robinhood Chain only unless the caller names another. Every network but
  // Robinhood Chain is paid from what the wallet holds there, read through that network's provider: Base's is needed.
  let networks;
  try { networks = payNetworks(opts.networks); } catch (e) { throw new PayError("BAD_NETWORK", `createPayer: ${e.message}`); }
  if (networks.includes("eip155:8453") && (!baseProvider || typeof baseProvider.call !== "function")) {
    throw new PayError("NO_PROVIDER", "createPayer: paying on Base needs `baseProvider` (a Base JSON-RPC provider: the USDC balance there is read before anything is signed)");
  }
  const maxPrice = toAtomicUsdg(opts.maxPrice ?? DEFAULT_MAX_PRICE, "maxPrice");
  const maxBorrow = toAtomicUsdg(opts.maxBorrow ?? 0n, "maxBorrow");
  // The Vantis gateway route: null (off) unless the caller names one.
  const gateway = gatewayConfig(opts.gateway);
  const http = new x402HTTPClient(new x402Client());

  const fx = timedFetch(fetchImpl, { timeoutMs, signal });
  const resendOpts = { fetchImpl, retries: pendingRetries, sleep, maxSleepMs, timeoutMs, signal };
  // Signed authorizations not known to be settled, per purchase: until validBefore (plus clock skew) the merchant can
  // still cash one, so a later pay() for the same purchase resends it instead of signing a second.
  const unsettled = new Map();
  // One payment at a time for this wallet: two concurrent pay() calls on a short balance would each read it short and
  // each borrow the gap (private report GHSA-482p, F3). The second waits and sees the first's loan. Gateway payments
  // join the same queue.
  let queue = Promise.resolve();
  function enqueue(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }
  const pay = (input, init) => enqueue(() => payOne(input, init));

  /** One JSON read from the gateway (its catalog and quotes): 200 only, redirects not followed, the body capped; with
   *  `missingOk`, a 404 is null (no such record). Its words are never quoted in an error: callers show these messages
   *  to a model. */
  async function getJson(url, { missingOk = false } = {}) {
    let r;
    try { r = await fx(new Request(url, { redirect: "manual", headers: { accept: "application/json" } })); } catch (e) {
      if (isAbort(e)) throw e;
      throw new PayError("GATEWAY_UNAVAILABLE", "payViaGateway: the gateway could not be reached; nothing was paid");
    }
    if (r.status === 404 && missingOk) { await r.body?.cancel().catch(() => {}); return null; }
    if (r.status !== 200) throw new PayError("GATEWAY_UNAVAILABLE", `payViaGateway: the gateway answered HTTP ${r.status} to a read; nothing was paid`);
    const { text, cut } = await readCapped(r);
    if (cut) throw new PayError("GATEWAY_UNAVAILABLE", "payViaGateway: the gateway's answer is too large; nothing was paid");
    try { return JSON.parse(text); } catch (_) { throw new PayError("GATEWAY_UNAVAILABLE", "payViaGateway: the gateway's answer is not JSON; nothing was paid"); }
  }

  /**
   * Buy from a seller in the gateway's catalog with one USDG payment on Robinhood Chain (gateway.mjs). Reads the
   * seller's record and the gateway's quote, refuses before anything is signed or borrowed what they do not allow, then
   * pays the gateway's 402 as pay() pays any Robinhood Chain merchant, at no more than the quote.
   */
  async function payViaGateway(o = {}) {
    if (!gateway) throw new PayError("GATEWAY_OFF", "payViaGateway: no gateway is configured (createPayer({ gateway: {} }) turns on the Vantis gateway); nothing was read or paid");
    const service = await findGatewayService(gateway, o, getJson);
    const quoted = checkGatewayQuote(await getJson(`${gateway.url}/api/gateway/quote/${service.serviceId}`), service, { maxPrice, maxFeeBps: gateway.maxFeeBps });
    const call = gatewayRun(gateway, service.serviceId, o.input);
    const info = { serviceId: service.serviceId, resource: service.resource, method: service.method, network: service.network, listed: service.listed, quoted };
    try {
      return { ...(await enqueue(() => payOne(call.url, call.init, { quoted, payTo: gateway.payTo }))), gateway: info };
    } catch (e) {
      if (e && typeof e === "object") e.gateway = info;
      throw e;
    }
  }

  async function payOne(input, init, route = null) {
    // A gateway call (`route`) is paid on Robinhood Chain only, whatever networks the payer signs for elsewhere.
    const callNetworks = route ? DEFAULT_PAY_NETWORKS : networks;
    const base = asRequest(input, init);
    const key = await purchaseKey(base);
    const nowS = Math.floor(Date.now() / 1000);
    for (const [k, v] of unsettled) if (v.validBefore + SKEW_SECONDS <= nowS) unsettled.delete(k);
    const out = unsettled.get(key);
    if (out) {
      const r = await resend(base, out.paymentHeaders, resendOpts);
      if (r.response.ok) unsettled.delete(key);
      const settlement = r.response.ok ? settlementOf(r.response) : undefined;
      return { ...r, paid: r.response.ok ? out.price : 0n, borrowed: 0n, loanId: null, dueAt: null, requirement: out.requirement, x402Version: out.x402Version, network: out.network, asset: out.asset, signed: { paymentHeaders: out.paymentHeaders, validBefore: out.validBefore }, resent: true, ...(settlement ? { settlement } : {}) };
    }
    const first = await fx(base.clone()); // a timeout here throws: nothing is signed yet
    if (first.status !== 402) return { response: first, paid: 0n, borrowed: 0n, loanId: null, dueAt: null };
    // The caller's cancellation (`init.signal`) and the payer's `signal`: once either has fired, nothing more is read,
    // topped up, borrowed or signed (GHSA-868j: a merchant that held its 402 past the caller's abort was paid). Once the
    // payment may be out, an abort is pending with its headers, never thrown (resend).
    const stopIfAborted = () => { base.signal.throwIfAborted(); signal?.throwIfAborted?.(); };
    stopIfAborted();

    const poolC = pool ? poolContract(pool, signer) : null;
    const usdgAddr = asset || (poolC ? await poolC.usdg() : robinhood.usdg);
    let body;
    try { const t = (await readCapped(first)).text; body = t ? JSON.parse(t) : undefined; } catch (_) { body = undefined; }
    let paymentRequired;
    try { paymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n), body); } catch (_) {
      if (body && body.x402Version === 2 && Array.isArray(body.accepts)) paymentRequired = body;
      else throw new PayError("BAD_402", "pay: the 402 response carries no x402 payment requirements");
    }
    const version = paymentRequired?.x402Version;
    const req = version === 2 ? pickV2Requirement(paymentRequired.accepts, usdgAddr, { networks: callNetworks }) : version === 1 && callNetworks.includes(robinhood.network) ? pickV1Requirement(paymentRequired.accepts, usdgAddr) : null;
    // Never quote the merchant's value: callers show this message to a model, outside any data fence.
    if (version !== 1 && version !== 2) throw new PayError("BAD_402", `pay: unsupported x402Version (${Number.isSafeInteger(version) ? version : `a ${typeof version}`})`);
    if (!req) throw new PayError("NO_USDG_REQUIREMENT", `pay: the resource does not accept exact USDG on Robinhood Chain${callNetworks.includes("eip155:8453") ? " or USDC on Base" : ""}`);
    // The network it is paid on, and its token (v1 is Robinhood Chain only): the payer's own values, never the merchant's text.
    const n = version === 2 ? networkOf(req.network) : ROBINHOOD_USDG;
    const onRobinhood = n.network === robinhood.network;
    const token = onRobinhood ? ethers.getAddress(usdgAddr) : n.asset;

    const price = BigInt(version === 2 ? req.amount : req.maxAmountRequired);
    // The merchant names the price. Without a cap a funded agent signs whatever a 402 asks (its whole balance).
    if (price > maxPrice) throw new PayError("PRICE_ABOVE_MAX_PRICE", `pay: price ${price} is above maxPrice ${maxPrice}; not paying`, { price, maxPrice });
    // A gateway call: the 402 may ask no more than the quote the caller's checks passed, and pay only the address the
    // caller pinned (gateway.payTo), before anything is read, topped up, borrowed or signed.
    if (route) {
      if (price > route.quoted) throw new PayError("GATEWAY_PRICE_ABOVE_QUOTE", `pay: the gateway's 402 asks ${price}, more than its quote ${route.quoted}; nothing was read, borrowed or signed`, { price, quoted: route.quoted });
      if (route.payTo && !sameAddr(req.payTo, route.payTo)) throw new PayError("GATEWAY_PAYTO_MISMATCH", "pay: the gateway's 402 names a payTo other than gateway.payTo; nothing was read, borrowed or signed");
    }

    const me = await signer.getAddress();
    // The client that will sign judges the requirement before anything is read, topped up, borrowed or signed: x402
    // core refuses at signing time what its own selection does not take, and that must never come after a loan
    // (GHSA-f35g: a paymentFlow core does not know threw once the borrow had mined). Core's words are not passed on:
    // some of its errors quote the merchant's requirements, and callers show this message to a model.
    const client = version === 2 ? createUsdgClient({ signer, maxPrice, maxValiditySeconds, asset: usdgAddr, x402Signer: toX402Signer(signer, me), networks: callNetworks }) : null;
    if (client) {
      try { client.selectPaymentRequirements(2, [req]); } catch (_) {
        throw new PayError("NO_USDG_REQUIREMENT", "pay: x402 core would not sign the requirement this payer picked; nothing was read, borrowed or signed");
      }
    }
    let savings;
    let loan = { borrowed: 0n, loanId: null, dueAt: null };
    if (!onRobinhood) {
      // Base: paid from the wallet's Base float only. Robinhood Chain's savings, Autopay reserve and line are not
      // touched; a float short of the price is refused here, before anything is signed (phase 1: the caller tops it up
      // with bridge.mjs fundBase, in a call of its own). What the float keeps back (`baseReserve()`, e.g. a return to
      // Robinhood Chain whose authorization can still pull it) is not free: it is read BEFORE the balance, so a transfer
      // that lands in between shows in the balance (and the payment is refused), never in neither (it would be signed
      // against USDC already gone). A reserve that cannot be read throws here: nothing is signed.
      const held = typeof baseReserve === "function" ? BigInt((await baseReserve()) || 0n) : 0n;
      const float = await new ethers.Contract(n.asset, ERC20_ABI, baseProvider).balanceOf(me);
      if (float < price + held) {
        const free = float > held ? float - held : 0n;
        throw new PayError("BASE_FLOAT_SHORT", `pay: the wallet holds ${formatUsdg(float)} ${n.symbol} on ${n.name}${held > 0n ? `, ${formatUsdg(held)} of it kept back (${formatUsdg(free)} free)` : ""}, less than the price ${formatUsdg(price)} ${n.symbol}; nothing was signed`, { price, balance: float, reserve: held, network: n.network, asset: n.asset });
      }
    } else {
      if (!signer.provider) throw new PayError("NO_PROVIDER", "pay: the signer must be connected to a Robinhood Chain provider (to read its USDG balance)");
      const usdgC = new ethers.Contract(usdgAddr, ERC20_ABI, signer);
      let balance = await usdgC.balanceOf(me);
      // What the wallet keeps back (`reserve()`: e.g. what Autopay loans will pull in the next 24 h): a payment that would
      // cut into it is refused before anything is signed or borrowed, after the caller's own top-up had its chance.
      let kept = 0n;
      if (typeof reserve === "function") kept = BigInt((await reserve()) || 0n);
      const keptShort = () => kept > 0n && balance >= price && balance - price < kept;

      // Short: the caller's own money first (`topUp(need)`, e.g. savings), once the price is known and before any loan.
      // A failed top-up never stops the payment: it is reported in `savings` and the payment goes on as before.
      if ((balance < price || keptShort()) && typeof topUp === "function") {
        stopIfAborted();
        try { savings = await topUp(price + kept); } catch (e) { savings = { withdrawn: 0n, error: e }; }
        // A withdrawal that was sent and may still land: never borrow for money that is on its way.
        if (savings?.error?.pending || savings?.error?.code === "UNCONFIRMED") throw Object.assign(new PayError("SAVINGS_PENDING", "pay: a savings withdrawal was sent and has not confirmed yet; nothing was borrowed or signed. Try again once it has landed."), { savings });
        try { balance = await usdgC.balanceOf(me); } catch (e) { if (e && typeof e === "object") e.savings = savings; throw e; }
      }

      if (keptShort() || (kept > 0n && balance < price)) throw Object.assign(new PayError("RESERVE", `pay: this payment would cut into the ${formatUsdg(kept)} USDG kept for Autopay loans due in the next 24 h; nothing was signed or borrowed`, { price, reserve: kept }), savings ? { savings } : {});
      if (balance < price) {
        try { stopIfAborted(); loan = await borrowGap({ signer, pool: poolC, agentId, price, balance, maxBorrow, termSeconds, maxFee, me, v5, v5Root }); } catch (e) {
          if (savings && e && typeof e === "object") e.savings = savings; // what the top-up did is not lost with the error
          throw e;
        }
      }
    }

    // Exactly one signature for this purchase, from here on only resent. An error from here carries the loan (and,
    // once signed, the headers), so neither is lost with it.
    let paymentHeaders, validBefore;
    try {
      stopIfAborted(); // inside the try: a loan taken before the abort is carried
      if (version === 2) {
        const payload = await client.createPaymentPayload({ ...paymentRequired, accepts: [req] });
        paymentHeaders = http.encodePaymentSignatureHeader(payload);
        validBefore = Number(payload?.payload?.authorization?.validBefore);
      } else {
        const header = await signPaymentV1(signer, req, { maxValiditySeconds });
        paymentHeaders = { "X-PAYMENT": header };
        validBefore = Number(JSON.parse(Buffer.from(header, "base64").toString("utf8")).payload.authorization.validBefore);
      }
      unsettled.set(key, { paymentHeaders, validBefore, price, requirement: req, x402Version: version, network: n.network, asset: token });
      // Before the payment leaves: a caller that keeps its own record (the MCP server's state file) writes it now, so a
      // process that dies while the request is in flight cannot lose the only copy. If it cannot, the payment is not
      // sent: an unrecorded payment is one a restart would sign again (own audit 2026-10-01). This signature never leaves.
      if (typeof onSigned === "function") {
        try { await onSigned({ purchase: key, paymentHeaders, validBefore, price, requirement: req, x402Version: version, network: n.network, asset: token, borrowed: loan.borrowed, loanId: loan.loanId }); } catch (err) {
          unsettled.delete(key);
          paymentHeaders = undefined;
          throw new PayError("NOT_RECORDED", `the payment was signed but could not be recorded (${err?.message || err}), so it was not sent`, { cause: err });
        }
      }
      const r = await resend(base, paymentHeaders, resendOpts);
      if (r.response.ok) unsettled.delete(key);
      const settlement = r.response.ok ? settlementOf(r.response) : undefined;
      // `signed` is always returned once a payment is out: until validBefore the merchant can still cash it, so a
      // caller that retries must resend these headers, never sign a new payment for the same purchase.
      return { ...r, paid: r.response.ok ? price : 0n, borrowed: loan.borrowed, loanId: loan.loanId, dueAt: loan.dueAt, requirement: req, x402Version: version, network: n.network, asset: token, signed: { paymentHeaders, validBefore }, ...(settlement ? { settlement } : {}), ...(savings ? { savings } : {}) };
    } catch (e) {
      if (e && typeof e === "object") Object.assign(e, { borrowed: loan.borrowed, loanId: loan.loanId, dueAt: loan.dueAt, ...(savings ? { savings } : {}), ...(paymentHeaders ? { signed: { paymentHeaders, validBefore }, requirement: req, network: n.network, asset: token } : {}) });
      throw e;
    }
  }

  return {
    pay,
    payViaGateway,
    resend: (input, paymentHeaders, init) => resend(input, paymentHeaders, { ...resendOpts, init }),
    settleLoans: (o = {}) => {
      if (!pool || agentId === undefined || agentId === null) throw new PayError("NO_POOL", "settleLoans: createPayer was given no pool/agentId");
      return settleLoans({ signer, pool, agentId, topUp, onlyInWindow: Boolean(o.onlyInWindow) });
    },
  };
}
