// Resolving "which chain, which pool, which wallet" is the part every agent gets wrong first, so it lives here
// instead of in each script. Nothing is stored anywhere but the chain and your own .env.
//
//   import { resolve } from "./sdk/env.mjs";
//   const { priors, agentWallet, dep, chainId } = await resolve();
//
// Order of precedence, highest first:
//   POOL / TREASURY / USDC env vars   -> explicit addresses (on a real chain only with PRIORS_ALLOW_CUSTOM_ADDRESSES=1 exported)
//   deployments/<chainId>.json        -> whatever `npm run devnet` or a real deployment wrote
//
// The signer comes from PRIVATE_KEY. On a local dev chain (31337) a deterministic throwaway wallet is derived
// instead, so `npm run quickstart` works with no setup at all; that fallback never applies to a real chain.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { Priors } from "./priors.mjs";

export const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load `.env` into process.env, without a dependency and without clobbering anything already exported.
 *
 * Every doc in this repo tells you to `cp .env.example .env` and put RPC_URL and PRIVATE_KEY in it. Until this
 * existed nothing read that file, so following the documented real-chain setup quietly talked to localhost and
 * signed with nothing — the documented production path failing before the first transaction.
 *
 * Deliberately minimal: `KEY=value`, `#` comments, optional surrounding quotes. An already-set variable wins, so
 * `RPC_URL=... npx priors doctor` still overrides the file.
 */
/** Variables this process took from a .env file (not exported by the user), by upper-cased name: an opt-in must never
 *  come from there, and on Windows a lower-cased name in a .env reads as the upper-cased one (own audit 2026-10-01). */
const fromDotEnv = new Set();
/** `name` (upper case) was exported as "1" in the shell, not read from a .env. */
const optedIn = (name) => process.env[name] === "1" && !fromDotEnv.has(name);
export function loadDotEnv(file = join(ROOT, ".env")) {
  if (!existsSync(file)) return {};
  const loaded = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, ""); // `KEY=value # note`: the note is not part of the value (a key with it was printed whole)
    loaded[key] = value;
    if (process.env[key] === undefined) { process.env[key] = value; fromDotEnv.add(key.toUpperCase()); }
  }
  return loaded;
}
// The repo's own .env (what the docs tell you to create), plus one in the working directory for when the CLI is
// installed as a dependency and run from somewhere else. The working directory wins.
loadDotEnv(join(process.cwd(), ".env"));
loadDotEnv();
export const DEV_CHAIN = 31337;
/// anvil's own published test mnemonic. Public by design, worthless by design, and never used off chain 31337.
export const DEV_MNEMONIC = "test test test test test test test test test test test junk";
/// wallet 0 of that mnemonic: anvil pre-funds it, and `npm run devnet` deploys and lends from it.
export const devWallet = (index) => ethers.HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);

export const deploymentPath = (chainId) => join(ROOT, "deployments", `${chainId}.json`);
/** The v2 set (CreditPoolV2, treasury v4, seats v2) has its own record, written by script/DeployV2.s.sol. */
export const deploymentPathV2 = (chainId) => join(ROOT, "deployments", `${chainId}.v2.json`);
/** Robinhood Chain's official endpoint: the default for the v2 tools, which have no local devnet. */
export const MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
/** The public Robinhood Chain endpoints .env.example names (mainnet, and the testnet). */
const PUBLIC_RPC_HOSTS = new Set(["rpc.mainnet.chain.robinhood.com", "robinhood-rpc.publicnode.com", "rpc.ordofi.network", "rpc.testnet.chain.robinhood.com"]);

/**
 * On a real chain, an RPC that a .env names must be one of the public endpoints: a .env in a directory the user did not
 * write could otherwise point the tools at a node that lies about which identity and which loans are the user's, and
 * have them sign a repayment of someone else's loan (own audit 2026-10-01). An RPC exported in the shell, or given in
 * code, is the user's choice, as is any RPC once PRIORS_ALLOW_CUSTOM_RPC=1 is exported (a .env cannot set it).
 */
function checkRpcSource(name, rpcs, chainId) {
  if (!name || chainId === DEV_CHAIN || !fromDotEnv.has(name) || optedIn("PRIORS_ALLOW_CUSTOM_RPC")) return;
  const host = (u) => { try { return new URL(u).hostname; } catch (_) { return ""; } };
  if (rpcs.every((u) => PUBLIC_RPC_HOSTS.has(host(u)))) return;
  throw new Error(`${name} comes from a .env file and names an RPC endpoint other than Robinhood Chain's public ones, which could misreport which identity and loans are yours: refused. Export it in your shell instead, or export PRIORS_ALLOW_CUSTOM_RPC=1 (a .env cannot set either).`);
}
/** A private key as 64 hex digits (with or without 0x), else an error that does not repeat it. */
function checkKey(pk, name) {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`${name} is not a valid private key (64 hex digits)`);
  return pk;
}

// --- money ---------------------------------------------------------------------------------------------------
// USDG has 6 decimals on chain and the SDK speaks whole dollars, so this conversion happens in a dozen places.
// It lives here once: a second implementation that rounds differently is how $0.011666 becomes $0.012.
export const USDG_DECIMALS = 6n;
const UNIT = 10n ** USDG_DECIMALS;
/** Whole dollars (number or bigint) -> 6-decimal units. */
export const toUnits = (dollars) => (typeof dollars === "bigint" ? dollars * UNIT : BigInt(Math.round(Number(dollars) * Number(UNIT))));
/** 6-decimal units -> dollars as a number. Fine for display; do not do arithmetic on the result. */
export const fromUnits = (units) => Number(units) / Number(UNIT);
/**
 * Money, formatted for a human, identically everywhere.
 * Pinned to en-US on purpose: the default locale renders $0.0116 as $0,0116 on a French machine, and a CLI whose
 * output depends on who ran it is a CLI whose output nobody can paste into a bug report.
 */
export const formatUsd = (dollars) => `$${Number(dollars).toLocaleString("en-US", { maximumFractionDigits: Number(USDG_DECIMALS) })}`;
/** Same, from raw on-chain units. */
export const formatUnits = (units) => formatUsd(fromUnits(units));

export function readDeployment(chainId) {
  const p = deploymentPath(chainId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function readDeploymentV2(chainId) {
  const p = deploymentPathV2(chainId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export class NoDeployment extends Error {
  constructor(chainId) {
    super(
      `no deployment for chain ${chainId}.\n` +
        (chainId === DEV_CHAIN
          ? "  run `npm run devnet` first (it starts a local chain and deploys the pool)."
          : "  the CreditPool is not deployed on this chain yet. Export POOL and TREASURY with PRIORS_ALLOW_CUSTOM_ADDRESSES=1, or run\n" +
            "  `npm run devnet` for a local chain. See the Status section of the README.")
    );
    this.chainId = chainId;
  }
}

/** `RPC_URL` may be one endpoint or several, comma-separated. */
export function splitRpcs(rpc) {
  if (Array.isArray(rpc)) return rpc.filter(Boolean);
  return String(rpc || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** How long the whole call may take, across every endpoint and attempt, before an honest error beats waiting. */
const RPC_BUDGET_MS = 15000; // a CLI may wait longer than a web page, but not forever
const RPC_ATTEMPTS = 2; // passes over the endpoint list
/* A single attempt may use most of the budget, and the cap is deliberately NOT divided by the number
   of endpoints. Dividing it was a real bug: with three endpoints configured each attempt got 2.5s, and
   Robinhood Chain's own endpoint has been measured answering in 5.4s (and once at 10.4s) against a
   375ms median. So adding backups - exactly what the docs tell you to do - made a working setup fail,
   because the healthy-but-slow first endpoint was killed before it could answer. Slow-but-alive is the
   failure that actually happens on this chain; a silent endpoint costs one attempt's worth and no more,
   because the remaining budget is what bounds every later attempt. */
const RPC_ATTEMPT_MAX_MS = 6000;

/* True when the response is a node DECLINING to serve the request, rather than the chain answering.
   Only the two things are distinguishable here, so the test has to be narrow: a revert is the chain's
   answer and must be returned as-is, or the caller loses the CALL_EXCEPTION it can decode.

   This used to match a list of ordinary English words - "exceed", "range", "capacity", "unavailable".
   That is a trap, because a contract is free to revert with exactly those: OpenZeppelin's ERC-20 says
   "transfer amount exceeds balance". Such a revert was failed over to every endpoint for the same
   answer and then surfaced as a bare Error. So the test is now structural - the JSON-RPC codes nodes
   actually use to say "not now" - plus a short list of phrases specific enough that no revert reason
   would contain them. Found by review; the suite's revert case used a plain "execution reverted",
   which never collided with the word list.

   A non-200 (publicnode's 403 for an archive request) never reaches here: ethers throws on it, and a
   thrown transport error already fails over. */
function declinedByNode(res) {
  for (const r of Array.isArray(res) ? res : [res]) {
    const e = r && r.error;
    if (!e) continue;
    const msg = String(e.message || "").toLowerCase();
    if (msg.includes("revert")) continue; // the chain answered; never ours to retry elsewhere
    if (e.code === -32005 || e.code === -32029 || e.code === 429) return e.message;
    if (/rate limit|rate-limit|too many requests|please try again|archive requests require/.test(msg)) return e.message;
  }
  return "";
}

/* Tries endpoints in the order given: first entry first, moving on only when that one fails, with a
   second pass before writing the list off. Deliberately not ethers' FallbackProvider, which queries
   providers together and waits for a weighted quorum - a dead first entry there can stall every call
   or fail quorum while a healthy endpoint sits behind it. Priority order is what an operator with a
   private endpoint and a public backstop actually wants.

   The seam is `_send`, not `send`: ethers' own `getNetwork()` reaches the transport through `_send`
   directly, so overriding the higher-level `send` leaves network detection - the very first call -
   pinned to the first endpoint. Found by testing, not by reading.

   A THROWN transport error fails over, and so does a node REFUSING to serve the request - a rate limit,
   or a non-archive node declining a deep `eth_getLogs`. On Robinhood Chain that distinction is not
   academic: of the three public endpoints, two answer a deep log query with HTTP 403 "Archive requests
   require a personal token" and `-32005` "the network is busy". A revert is different: it is the chain's
   answer, identical on every node, so it is returned rather than retried everywhere for nothing. */
export function makeProvider(rpcs, providerOpts = {}) {
  const urls = splitRpcs(rpcs);
  if (urls.length === 0) throw new Error("no RPC endpoint configured");
  // Single endpoints get the retry too - that is the common case, and the one that needs it most.
  const connect = (url) => {
    const req = new ethers.FetchRequest(url);
    req.timeout = RPC_ATTEMPT_MAX_MS; // backstop; the race below is what actually bounds an attempt
    return req;
  };
  /* FetchRequest's timeout is fixed at construction, so bounding an attempt by the REMAINING budget
     has to be a race here rather than a property.
     SHORTCUT: the losing side of the race is abandoned, not cancelled - ethers gives no AbortSignal
     hook through JsonRpcProvider - so a socket can stay open for up to RPC_ATTEMPT_MAX_MS after this
     returns. Ceiling: one idle socket per abandoned attempt, 6s each, in a short-lived CLI process.
     Upgrade trigger: if this provider is ever reused by a long-running server, or ethers exposes an
     abort hook, wire the signal through instead. */
  const withDeadline = (promise, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`RPC attempt exceeded ${ms}ms`)), ms);
      promise.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
    });

  class FailoverProvider extends ethers.JsonRpcProvider {
    constructor() {
      super(connect(urls[0]), undefined, providerOpts);
      this._backups = urls.slice(1).map((u) => new ethers.JsonRpcProvider(connect(u), undefined, providerOpts));
      this.rpcUrls = urls.slice();
    }
    async _send(payload) {
      // A broadcast is never retried and never failed over. If the transport dies after the node
      // already accepted the transaction, sending it again gets "already known" back - an RPC error
      // inside a 200, which this loop would hand to the caller as a failure for a transaction that
      // in fact succeeded. A caller that believes that may re-sign at the next nonce and pay twice.
      // Surfacing the transport error immediately is the honest answer: the tx hash is deterministic,
      // so the caller can look it up.
      const one = Array.isArray(payload) ? payload : [payload];
      if (one.some((r) => r && r.method === "eth_sendRawTransaction")) return super._send(payload);

      const started = Date.now();
      let last;
      /* Endpoints are the INNER loop: one pass over all of them in priority order, then a second pass.
         Exhausting the first endpoint's retries before trying the second meant a silent first endpoint
         ate the whole budget and the healthy backup was never reached - the failover starving itself.
         Priority still holds, because every pass starts at the first entry. */
      for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt++) {
        for (let i = 0; i < urls.length; i++) {
          const left = RPC_BUDGET_MS - (Date.now() - started);
          if (left <= 0) throw last || new Error("RPC budget exhausted");
          const share = Math.min(left, RPC_ATTEMPT_MAX_MS);
          try {
            const call = i === 0 ? super._send(payload) : this._backups[i - 1]._send(payload);
            const res = await withDeadline(call, share);
            /* No `urls.length > 1` guard: with a single endpoint that returned the refusal to the
               caller on the first try, while a thrown transport error on the very same endpoint got a
               second attempt. A rate limit is the most transient failure there is, and one endpoint is
               the case this retry exists for. Falling through to the next pass retries the same URL. */
            const declined = declinedByNode(res);
            if (declined) {
              last = new Error(declined);
              continue;
            }
            return res;
          } catch (e) {
            last = e;
          }
        }
      }
      throw last;
    }
  }
  return new FailoverProvider();
}

/**
 * @param {{rpc?: string, privateKey?: string, needSigner?: boolean}} [opts]
 */
export async function resolve(opts = {}) {
  const rpc = opts.rpc || process.env.RPC_URL || "http://127.0.0.1:8545";
  const rpcs = splitRpcs(rpc);
  // cacheTimeout off: on chains that mine instantly, ethers' 250 ms result cache hands back stale nonces
  const provider = makeProvider(rpcs, { cacheTimeout: -1 });
  let chainId;
  try {
    chainId = Number((await provider.getNetwork()).chainId);
  } catch (e) {
    const where = rpcs.length > 1 ? `none of ${rpcs.length} endpoints (${rpcs.join(", ")})` : rpcs[0];
    throw new Error(`cannot reach ${where}: ${e.shortMessage || e.message}\n  is the chain running? \`npm run devnet\` starts a local one.`);
  }

  const file = readDeployment(chainId) || {};
  // POOL/TREASURY/USDC can come from a .env in whatever directory the CLI runs in: on a real chain they must match the
  // published deployment unless PRIORS_ALLOW_CUSTOM_ADDRESSES=1 is exported (C-1's rule, which covered the v2 tools
  // only; own audit 2026-10-01: a .env's POOL took a v1 `repay` user's whole USDG balance).
  if (chainId !== DEV_CHAIN && !optedIn("PRIORS_ALLOW_CUSTOM_ADDRESSES")) {
    const pinned = { POOL: file.creditPool, TREASURY: file.treasurySponsor, USDC: file.usdc };
    const differ = Object.keys(pinned).filter((k) => process.env[k] && String(process.env[k]).toLowerCase() !== String(pinned[k] || "").toLowerCase());
    if (differ.length) throw new Error(`${differ.join(", ")} differ from the published deployment for chain ${chainId}, so they could send your USDG elsewhere: refused. To use them anyway, export PRIORS_ALLOW_CUSTOM_ADDRESSES=1 in your shell (a .env cannot set it).`);
  }
  const dep = {
    chainId,
    creditPool: process.env.POOL || file.creditPool,
    treasurySponsor: process.env.TREASURY || file.treasurySponsor,
    usdc: process.env.USDC || file.usdc,
    registry: file.registry,
    usdcIsMock: process.env.USDC ? false : Boolean(file.usdcIsMock),
    treasuryAgentId: file.treasuryAgentId,
    // "paused" once the pool is superseded: history still reads, new loans revert.
    status: file.status,
    supersededBy: file.supersededBy,
  };
  if (!dep.creditPool) throw new NoDeployment(chainId);

  // `.env.example` ships `PRIVATE_KEY=0x` as a placeholder. Copied and left unfilled it is present-but-useless,
  // and handing it to ethers produces an opaque "invalid BytesLike" instead of "you have not set a key yet".
  const rawPk = opts.privateKey || process.env.PRIVATE_KEY;
  const pk = rawPk && rawPk !== "0x" && rawPk !== "0x0" ? checkKey(rawPk.trim(), "PRIVATE_KEY") : undefined;
  if (pk && !opts.rpc) checkRpcSource(process.env.RPC_URL ? "RPC_URL" : null, rpcs, chainId);
  let signer = null;
  let derived = false;
  if (pk) {
    signer = new ethers.NonceManager(new ethers.Wallet(pk, provider));
  } else if (chainId === DEV_CHAIN) {
    // a wallet outside the range devnet.mjs and the demos fund, so a quickstart never collides with them
    signer = new ethers.NonceManager(devWallet(50).connect(provider));
    derived = true;
  } else if (opts.needSigner) {
    throw new Error("PRIVATE_KEY is not set. This chain is not a dev chain, so no wallet can be derived for you.\n  cp .env.example .env and put in the key that owns (or will own) your ERC-8004 identity.");
  }

  const priors = new Priors({ provider, pool: dep.creditPool, treasury: dep.treasurySponsor, signer });
  return { provider, signer, derived, dep, chainId, rpc, priors, address: signer ? await signer.getAddress() : null };
}

/**
 * Resolve the v2 set: a PriorsV2 client on deployments/<chainId>.v2.json (or the file PRIORS_ADDRESSES names).
 * RPC_URL (comma-separated failover list) defaults to Robinhood Chain mainnet. The signer comes from PRIORS_KEY, or
 * PRIVATE_KEY like the v1 tools; with neither, the client is read-only. `journal` is passed to PriorsV2 (its records of
 * signed transactions, kept before each broadcast: see PriorsV2's constructor), and so is `waitTimeoutMs`.
 * @param {{rpc?: string, privateKey?: string, addressesFile?: string, needSigner?: boolean, journal?: object, waitTimeoutMs?: number}} [opts]
 */
export async function resolveV2(opts = {}) {
  const { PriorsV2 } = await import("./priors-v2.mjs");
  const rpc = opts.rpc || process.env.PRIORS_RPC || process.env.RPC_URL || MAINNET_RPC;
  const rpcs = splitRpcs(rpc);
  const provider = makeProvider(rpcs, { cacheTimeout: -1 });
  let chainId;
  try {
    chainId = Number((await provider.getNetwork()).chainId);
  } catch (e) {
    throw new Error(`cannot reach ${rpcs.length > 1 ? `any of ${rpcs.length} endpoints` : rpcs[0]}: ${e.shortMessage || e.message}`);
  }
  const file = opts.addressesFile || process.env.PRIORS_ADDRESSES;
  let addresses;
  if (file) addresses = JSON.parse(readFileSync(file, "utf8"));
  else addresses = readDeploymentV2(chainId);
  if (!addresses || !addresses.pool) {
    throw new Error(`no v2 deployment for chain ${chainId}: deployments/${chainId}.v2.json does not exist. Set PRIORS_ADDRESSES to a v2 addresses file, or point RPC_URL at Robinhood Chain (4663).`);
  }
  if (addresses.chainId !== undefined && Number(addresses.chainId) !== chainId) {
    throw new Error(`the v2 addresses are for chain ${addresses.chainId}, but the RPC is chain ${chainId}`);
  }
  // A PRIORS_ADDRESSES file can come from a .env in whatever directory the CLI runs in, which is not always the user's
  // own (private report GHSA-xw44): on a real chain its money-moving addresses must be the published ones, unless the
  // user exported PRIORS_ALLOW_CUSTOM_ADDRESSES=1 in the shell (never read from a .env). The dev chain is left free.
  // deployBlock too: the identity search starts there, and an earlier one finds identities it should not (GHSA-95v6).
  if (!opts.addressesFile && file && chainId !== DEV_CHAIN && !optedIn("PRIORS_ALLOW_CUSTOM_ADDRESSES")) {
    const pinned = readDeploymentV2(chainId);
    const keys = ["pool", "usdg", "registry", "priors", "lens", "treasuryV4", "seatVault", "seatVaultV4", "seatVaultV5", "stockVault", "inviteBond", "treasuryV5", "inviteBondV2", "deployBlock"];
    const differ = pinned ? keys.filter((k) => addresses[k] !== undefined && pinned[k] !== undefined && String(addresses[k]).toLowerCase() !== String(pinned[k]).toLowerCase()) : ["no published deployment for this chain"];
    if (differ.length) {
      const where = chainId === 4663 ? "Robinhood Chain" : `chain ${chainId}`;
      throw new Error(`the addresses file ${file} differs from the published ${where} deployment (${differ.join(", ")}), so it could send your USDG elsewhere: refused. To use it anyway, export PRIORS_ALLOW_CUSTOM_ADDRESSES=1 in your shell (a .env cannot set it).`);
    }
  }
  const rawPk = opts.privateKey || process.env.PRIORS_KEY || process.env.PRIVATE_KEY;
  const pk = rawPk && rawPk !== "0x" && rawPk !== "0x0" ? checkKey(rawPk.trim(), "PRIORS_KEY") : undefined;
  if (pk && !opts.rpc) checkRpcSource(process.env.PRIORS_RPC ? "PRIORS_RPC" : process.env.RPC_URL ? "RPC_URL" : null, rpcs, chainId);
  let signer = null;
  // A plain Wallet, as the v2 client is tested with: every write waits for its receipt before the next is sent.
  if (pk) signer = new ethers.Wallet(pk, provider);
  else if (opts.needSigner) throw new Error("PRIORS_KEY (or PRIVATE_KEY) is not set: this command signs transactions.");
  const priors = new PriorsV2({ provider, signer, addresses, journal: opts.journal, waitTimeoutMs: opts.waitTimeoutMs });
  return { provider, signer, chainId, rpc, addresses, priors, address: signer ? await signer.getAddress() : null };
}

/** True when the chain answers anvil/hardhat cheat methods, i.e. we may warp time and mint mock money. */
export async function isDevChain(provider) {
  try {
    await provider.send("anvil_nodeInfo", []);
    return true;
  } catch {
    return false;
  }
}
