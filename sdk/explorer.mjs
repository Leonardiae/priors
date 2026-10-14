// An explorer as a pointer for `txStatus` (GHSA-g5cv-cpwp-756w): when the RPC no longer serves the history needed to
// find which transaction used a nonce (the public Robinhood Chain node keeps about five minutes of state), the
// explorer's list of the sender's transactions names candidates. It is never a verdict: `txStatus` checks every hash it
// names on the RPC (this sender, this nonce, mined, its receipt in that block, the block canonical and finalized, and
// whether it is the same call) and an explorer that lies, or does not answer, settles nothing.
//
//   import { blockscoutLookup } from "./sdk/explorer.mjs";
//   await p.txStatus(hash, { nonce, raw, explorer: blockscoutLookup() });
//
// It reads Blockscout's Etherscan-compatible API (module=account&action=txlist), from the block the transaction was
// sent after, oldest first, 100 entries.
export const BLOCKSCOUT_API = "https://robinhoodchain.blockscout.com/api";

/** A lookup ({ from, nonce, sentBlock }) => hashes of `from`'s transactions at `nonce`, as the explorer lists them. */
export function blockscoutLookup(api = BLOCKSCOUT_API, { timeoutMs = 10_000 } = {}) {
  return async ({ from, nonce, sentBlock }) => {
    const u = new URL(api);
    for (const [k, v] of Object.entries({ module: "account", action: "txlist", address: from, startblock: sentBlock ?? 0, sort: "asc", page: 1, offset: 100 })) u.searchParams.set(k, String(v));
    const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`the explorer answered ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.result)) throw new Error(`the explorer gave no list (${body?.message || "no result"})`);
    return body.result.filter((t) => Number(t.nonce) === Number(nonce) && String(t.from).toLowerCase() === String(from).toLowerCase()).map((t) => t.hash);
  };
}
