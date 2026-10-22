# Attestation v2: a registry note backed by money the pool lends

Live since 2026-10-05. The file format is `sdk/attestation.mjs`; the verifier is `scripts/verify-attestation.mjs`.
How to read a note with `getSummary` is in [CHECK-API.md](CHECK-API.md), "Read it on chain instead".

## Why

Priors posts each agent's Score v2 to the ERC-8004 reputation registry on Robinhood Chain from one attester,
`0x613854463BB854225306b9b18bdb451A78430a73`. Until 2026-10-05 a note was a number and a pointer: `feedbackURI` was the
live `https://priors.trade/api/check?agent=N` and `feedbackHash` was 0. The fair criticism: the note carried no
evidence, the page it named kept changing after the note was posted, and nothing tied it to a payment.

Anyone can post a number. What makes a Priors note different is that the pool lent the agent real USDG and got it
back: a record of debt someone else put at risk. So each note now carries that record itself: the
line the pool extends to the agent, the loans it repaid on time with the transactions that prove them, and the pool's
own payment to the agent, in a file whose hash is on chain and whose bytes are in the note.

## What the spec says (ERC-8004, read 2026-10-05)

From [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004) (Draft), section "Reputation Registry":

> The feedback given by a *clientAddress* to an agent consists of a signed fixed-point *value* (`int128`) and its
> *valueDecimals* (`uint8`, 0-18), plus optional *tag1* and *tag2* [...], an *endpoint* URI, a file URI pointing to an
> off-chain JSON containing additional information, and its KECCAK-256 file hash to guarantee integrity. [...]
> All fields except *value* and *valueDecimals* are OPTIONAL, so the off-chain file is not required and can be omitted.

> Where provided, *feedbackHash* is the KECCAK-256 hash (`keccak256`) of the content referenced by *feedbackURI*,
> enabling verifiable integrity for non-content-addressed URIs. For IPFS (or other content-addressed URIs),
> *feedbackHash* is OPTIONAL and can be omitted (e.g., set to `bytes32(0)`).

> The fields *endpoint*, *feedbackURI*, and *feedbackHash* are emitted but are not stored.

"Off-Chain Feedback File Structure":

```jsonc
{
  // MUST FIELDS
  "agentRegistry": "eip155:1:{identityRegistry}",
  "agentId": 22,
  "clientAddress": "eip155:1:{clientAddress}",
  "createdAt": "2025-09-23T12:00:00Z",
  "value": 100,
  "valueDecimals": 0,
  // ALL OPTIONAL FIELDS
  "tag1": "foo", "tag2": "bar", "endpoint": "https://agent.example.com/GetPrice",
  "proofOfPayment": { // this can be used for x402 proof of payment
    "fromAddress": "0x00...", "toAddress": "0x00...", "chainId": "1", "txHash": "0x00..." },
  // Other fields
  " ... ": { " ... " } // MAY
}
```

And, for the agent's own registration file ("Identity Registry"): "If the owner wants to store the entire
registration file on-chain, the *agentURI* SHOULD use a base64-encoded data URI rather than a serialized JSON string:
`data:application/json;base64,eyJ0eXBlIjoi...`". The spec sets no scheme for `feedbackURI`; we follow the same form.

How we use it:

- the spec's MUST fields, and `tag1`, `tag2` as posted; `endpoint` is left out (it is posted as "");
- `proofOfPayment` with the spec's four fields, for the pool's payment to the agent: `fromAddress` the credit pool,
  `toAddress` the address the loan was paid to, `txHash` the borrow transaction of the agent's latest loan repaid on
  time (the recipient is read from that transaction's `Borrowed` log when the note is posted);
- everything of ours in one namespaced object, `priors` (the spec's "Other fields ... MAY");
- `feedbackURI` = `data:application/json;base64,` + base64(file bytes), `feedbackHash` = keccak256(file bytes): the
  content the URI references is the decoded bytes.

## The file

Real shape, built from the live snapshot of block 80,894,837 (addresses and hashes shortened here, four proofs left out):

```json
{
 "agentRegistry": "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
 "agentId": 6192,
 "clientAddress": "eip155:4663:0x613854463BB854225306b9b18bdb451A78430a73",
 "createdAt": "2026-10-05T15:34:36Z",
 "value": 11, "valueDecimals": 0, "tag1": "priors-score", "tag2": "rung-0/v2.0.1",
 "proofOfPayment": { "fromAddress": "0x2812…DE21", "toAddress": "0x…", "chainId": "4663", "txHash": "0xfe30…d8c0" },
 "priors": {
  "v": 2, "block": 80894837, "blockTime": 1791214476, "pool": "0x2812…DE21",
  "score": 11, "rung": 0, "weights": "2.0.1",
  "line": { "limit": "9.48", "available": "2.43", "drawn": "7.05" },
  "repaid": { "onTime": 227, "usdg": "1729.24", "last": [ { "loan": 20802, "tx": "0x4e59…b118" }, "… 4 more" ] },
  "late": 0, "defaults": 0,
  "backing": { "sponsor": 6191, "delegatedIn": "9.48" },
  "income": { "usdg": "0", "payers": 0, "points": 0 },
  "paid": { "loan": 20802, "usdg": "7.26" },
  "about": "https://github.com/priors-agents/priors/blob/main/docs/ATTESTATION-v2.md"
 }
}
```

- Amounts are USDG as exact decimal strings (6 decimals); times are unix seconds, except the spec's `createdAt`.
- `line`: the lens' `creditReport` at `block`, the same figures the site, `/api/snapshot` and the API's `availableOf`
  show: `limit` = capacity, `drawn` = principalOut, `available` = the pool's available, capped by the stock vault's
  borrowRoom for a stock line.
- `repaid`: loans repaid by their due date (v1 era included) and their principal; `last` cites the latest five by loan
  id and repayment transaction (a v1 loan carries `"era": "v1"` and the file names `v1Pool`). `late`: repaid after the
  due date. `defaults`: defaulted loans; `defaulted: true` when the agent is.
- `backing`: the sponsor id and the USDG it delegates; a root's own `stake`; a stock line's `collateral` (token,
  symbol, amount, value).
- `income`: Score v2's counted x402 income (`detail.incomeUsdg`: payers in the 30-day window, netted, dust left out,
  before caps and weights), the payers that count, and the income component's points.
- `paid`: the loan behind `proofOfPayment` and its principal.
- `owner` (since 2026-10-19): the agent's owner at `block` (the registry's `ownerOf`, as the
  snapshot reads it), the owner the score is for. On a note posted because the owner changed, `ownerChanged`:
  `{ "from": <the owner the previous note named>, "note": "This agent changed owner since Priors' last note. Its Priors
  score counts the record from the new owner." }`. Both are added fields (same `priors.v`), so no live note is
  re-posted for them; they appear from each agent's next note on.
- Size: 1,059 to 1,434 bytes across the first 30 notes posted (2026-10-05, 18:19 UTC; median 1,429 with five proofs,
  full hashes and addresses); `encodeFile` drops the oldest proofs, never a total, if a file would pass 2 KB.

## Where it lives: on chain, in the note

| | (a) `data:` URI in `feedbackURI` | (b) hosted file, `https://priors.trade/attest/<hash>.json` |
| --- | --- | --- |
| self-contained | yes: the bytes are in the `NewFeedback` event, forever | no: the file lives as long as the site does |
| immutable | yes | only by our promise (content-addressed name, hash on chain) |
| gas, `giveFeedback` (eth_estimateGas on 4663) | 261,417 (calldata 2,404 bytes; L1 part 81,253) | 154,947 (calldata 580; L1 part 20,357) |
| cost at 0.0205 gwei | 0.0000054 ETH | 0.0000032 ETH |
| v1 note, for reference | 149,187 gas, 0.0000031 ETH | |

Measured 2026-10-05 on Robinhood Chain (an Arbitrum Orbit chain: `NodeInterface.gasEstimateComponents` gives the L1
part; L1 base fee estimate 0.052 gwei), for the largest file. Measured live on 2026-10-05: a post of a 1,430-byte file used 207,443 gas (0.0000043 ETH at 0.0205 gwei), and the first pass's 30 notes, each with its revoke, cost 0.000151 ETH, 0.0000050 ETH a note. A revoke is 46,466 gas.

Notes a day: the attester posted 125 notes when it started (2026-10-02), then 4, 3 and 2 a day (2026-10-03 to 05); 133
of 165 agents score above 0. So steady state is a few notes a day: (a) costs about 0.00001 ETH more a day than (b). The
one-time move of the existing notes to v2 is ~133 x (revoke + note), about 0.0008 ETH, spread over ~5 hourly passes
(30 a pass).

Decision: (a). The difference is a fraction of a cent a day, and (a) is the only form that is still true if
priors.trade is gone. Even with L1 fees ten times higher, a note stays near 0.00002 ETH.

## When a note is posted

As before: one attester; revoke before post (so `getSummary(agentId, [attester], "priors-score", "")` is the current
score); value = score, `tag1` = `priors-score`, `tag2` = `rung-<n>/v<version>`; post on a default, a rung change, a new
weights version, an agent's entry for a score above 0, a move of 25 points, or any difference after 30 days.

Added with v2:

- **Line.** A note re-posts when the line (limit) opened, closed, or moved by a quarter and at least 1 USDG. The note
  says what the pool will lend; a note claiming 5 USDG for a 50 USDG line would undersell the agent, and the opposite
  would oversell it. `available` and `drawn` move with every loan and never trigger a note.
- **Schema.** An entry posted before the current file schema (`priors.v`) is re-posted once, last in line, at most 30 a
  pass. A defaulted agent's 0 is never re-posted.
- **Owner** (2026-10-19). A note re-posts at once, right after a default, when the owner the
  evidence index names differs from the one recorded with the live note: the new note carries the score as it is
  then, `owner`, and `ownerChanged` with the owner before. A note posted before owners were recorded gets its owner
  recorded by the next pass with no post (a change between that note and the recording is not told); a defaulted
  agent's 0 stays whoever holds it.

A pass posts nothing when its evidence is not at the scores' block.

## What a note proves, and how to check it

```
npm install
node scripts/verify-attestation.mjs <agentId> [--rpc <archive endpoint>] [--attester 0x…] [--json]
```

The RPC is `--rpc`, else `RPC_URL`, else Robinhood Chain's public endpoint; an endpoint URL is never printed. Exit code
0 when every check passed, 1 on a failure, 2 when the entry is a v1 note (no file). Checked from the chain alone:

- the entry is live; its `NewFeedback` event's `feedbackHash` is keccak256 of the bytes in its `feedbackURI`;
- the file's `agentRegistry`, `agentId`, `clientAddress`, `value`, `valueDecimals`, `tag1`, `tag2` are the entry's, and
  `getSummary(agentId, [attester], "priors-score", "")` is the file's score;
- `blockTime` is the timestamp of `block`, and the note was posted at or after it;
- `pool`, and `v1Pool` when the file names one, are the pools of `deployments/4663.v2.json`. The repayments and the
  payment below are read from those two pools, whatever the file names, so a citation of another contract fails
  (GHSA-m5wj-mgcg-x3fv);
- each cited repayment: the transaction succeeded before `block` and carries the pool's `Repaid` log (the v1 pool's for a v1 loan) for that loan and
  agent; `getLoan` shows the loan is the agent's, repaid, and closed by its due date;
- `proofOfPayment`: the borrow transaction carries the pool's `Borrowed` log for `paid.loan`, to `toAddress`, for
  `paid.usdg`;
- the line and backing at `block` (lens `creditReport` with that block tag): capacity, principalOut, available,
  sponsor, delegatedIn, defaulted. This needs state at that block: the public endpoint keeps about 15 minutes of it,
  so for an older note pass an archive endpoint; the script says when it could not check.

Not verified by the script: the score's arithmetic (it needs the x402 income index and every agent's loans; the inputs
are public and the engine is `sdk/score-v2.mjs`, see [SCORE-v2.md](SCORE-v2.md)), and the totals (`repaid.onTime`,
`repaid.usdg`, `late`, `defaults`, counted over the agent's whole history, v1 included; the script prints the lens'
figures beside them). So the score and the totals are the attester's word: a note with a false score or false totals
that cites nothing passes the script, while every repayment or payment a note does cite must be on the record.

## Schema versioning

`priors.v` is the schema of the `priors` object. Readers of the spec's fields can ignore it. Rules:

- adding a field is not a new version; renaming or changing the meaning of one is, and a new version re-posts every
  live note once (the schema rule above);
- `about` links this page, which describes every version.
