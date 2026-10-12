// Types for "@priors/x402/check": the payer's Priors record checked on the request, in front of any x402 paywall.
import type { PriorsRecord, RecordGateOptions } from "./index.js";

export interface RecordCheckOptions extends Pick<RecordGateOptions, "source" | "checkUrl" | "rpc" | "pool" | "refuseDefaulted" | "minRepaid" | "minScore" | "cacheSeconds" | "cacheMax" | "fetchImpl"> {
  /** Serve when the record cannot be read (default false: 503 with Retry-After). */
  failOpen?: boolean;
  /** Retry-After on that 503, in seconds (default 10). */
  retryAfter?: number;
  /** Called for each request that carries a payment header, with the decision. */
  onDecision?: (d: RecordDecision) => void;
}

/** What the check decided. `ok: true` with `payer: null`: no payment header, the paywall answers. */
export interface RecordDecision {
  ok: boolean;
  /** The address the payment header names (not verified yet: the paywall verifies it), or null. */
  payer: string | null;
  record: PriorsRecord | null;
  /** priors_payer_defaulted, priors_record_too_short, priors_score_too_low, priors_payer_unknown, priors_record_unavailable. */
  reason?: string;
  message?: string;
  /** When !ok: 403 for a refused payer, 503 for a record that could not be read. */
  status?: 403 | 503;
  /** Seconds, with status 503. */
  retryAfter?: number;
}

/** Anything a request's headers can be read from: a fetch Request or Headers, a Node/Express request, a plain object. */
export type HeadersLike = Request | Headers | { headers: any } | { raw: Request } | Record<string, string | string[] | undefined>;

/** The decision for one request. Calls with the same options object share one record cache. */
export declare function checkRequest(request: HeadersLike, opts?: RecordCheckOptions): Promise<RecordDecision>;
/** Express / Connect / node:http middleware; use it before the x402 paymentMiddleware. */
export declare function requireRecord(opts?: RecordCheckOptions): (req: any, res: any, next: (err?: any) => void) => Promise<void>;
/** A fetch handler (Cloudflare Workers, Next route handlers, Bun) that checks the payer first. */
export declare function withRecord<A extends any[]>(handler: (request: Request, ...rest: A) => Response | Promise<Response>, opts?: RecordCheckOptions): (request: Request, ...rest: A) => Promise<Response>;
/** Hono middleware; use it before the x402 paymentMiddleware. */
export declare function honoRecord(opts?: RecordCheckOptions): (c: any, next: () => Promise<void>) => Promise<Response | void>;
