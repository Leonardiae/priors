// Robinhood Chain (chain 4663) and USDG, as x402 v2 names them. Every value here was checked on-chain
// (docs/FLOAT.md: USDG answers EIP-3009 `authorizationState`, and its DOMAIN_SEPARATOR matches "Global Dollar" / "1").

/** @type {import("../index.d.ts").RobinhoodConstants} */
export const robinhood = Object.freeze({
  /** CAIP-2 network id used by x402 v2. */
  network: "eip155:4663",
  /** The network name x402 v1 bodies use (our facilitator and sdk/float.mjs). */
  legacyNetwork: "robinhood",
  chainId: 4663,
  /** USDG (Global Dollar) on Robinhood Chain. */
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  usdgDecimals: 6,
  /** EIP-712 domain of USDG: what an EIP-3009 TransferWithAuthorization is signed on. */
  eip712: Object.freeze({ name: "Global Dollar", version: "1" }),
  /** The Priors public facilitator. */
  facilitatorUrl: "https://facilitator.priors.trade",
  /** The public JSON-RPC endpoint (no token in it). */
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  /** Priors v2 on chain 4663 (deployments/4663.v2.json). */
  pool: "0x281210097f0de7A8FB6F87310AF0f089c9C8DE21",
  lens: "0x9d7035722bd42C551f82FEB9FDDd17453AEF3D9B",
  registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  /** The stock vault (src/StockVault.sol, live since 2026-09-28; deployments/4663.v2.json `stockVault`). */
  stockVault: "0xbEcd07EC689988e16b870C121756C4c2C8cb02B6",
  /** SeatVaultV5 (the owner's $PRIORS behind its agent's line), live since 2026-10-11 and named by BuyAndBack and the
   *  SwapLimiter (deployments/4663.v2.json `seatVaultV5`); a borrow on its line refreshes the line first. */
  seatVaultV5: "0xC999014C6218EC41f0aE412d49AE8f2aA4c539fD",
  /** SeatVaultV5's root identity (`seatVaultV5AgentId`). */
  seatVaultV5AgentId: 8762,
});

/** Both names a Robinhood Chain requirement can carry: v2 CAIP-2 and the v1 name. */
export const ROBINHOOD_NETWORKS = Object.freeze(new Set([robinhood.network, robinhood.legacyNetwork]));

/** Default most one purchase may pay, atomic USDG: 0.10 USDG (the x402 reference client's cap, as sdk/float.mjs). */
export const DEFAULT_MAX_PRICE = 100_000n;
/** Longest an authorization stays cashable, seconds, whatever maxTimeoutSeconds the merchant asks (sdk/float.mjs). */
export const MAX_VALIDITY_SECONDS = 600;
/** Default loan term when a purchase has to borrow: 7 days, clamped to the pool (sdk/float.mjs, x402 audit F3). */
export const DEFAULT_TERM_SECONDS = 7 * 86400;

/** EIP-3009 TransferWithAuthorization, the typed data x402 `exact` signs on EVM. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = Object.freeze({
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
});

/**
 * An amount of USDG as atomic units. A bigint, a safe integer number or a digit string is taken as atomic
 * units (sdk/float.mjs's convention); a string with a leading "$" ("$0.05") is dollars, at most 6 decimals.
 * @param {bigint|number|string} v
 * @param {string} [what]
 * @returns {bigint}
 */
export function toAtomicUsdg(v, what = "amount") {
  if (typeof v === "bigint") {
    if (v < 0n) throw new RangeError(`${what} must not be negative`);
    return v;
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${what}: a number is atomic USDG and must be a non-negative integer (use "$0.10" for dollars)`);
    return BigInt(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+$/.test(s)) return BigInt(s);
    const m = /^\$\s*(\d+)(?:\.(\d{1,6}))?$/.exec(s);
    if (m) return BigInt(m[1]) * 1_000_000n + BigInt((m[2] || "").padEnd(6, "0"));
  }
  throw new TypeError(`${what}: not a USDG amount: ${JSON.stringify(String(v))} (atomic units, or "$0.10")`);
}

/** Atomic USDG as a dollar string with 2 to 6 decimals ("0.05", "12.345678"). */
export function formatUsdg(units) {
  const u = BigInt(units);
  const neg = u < 0n;
  const a = neg ? -u : u;
  let frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${a / 1_000_000n}.${frac}`;
}
