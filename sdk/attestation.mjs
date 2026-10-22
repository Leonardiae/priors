// Attestation v2: the file behind each Priors note on the ERC-8004 reputation registry (docs/ATTESTATION-v2.md).
//
// A note used to point at a live page (feedbackURI https://priors.trade/api/check?agent=N, feedbackHash 0): it carried
// no evidence and changed after it was posted. Now each note carries its own file, on chain, in the note itself:
//
//   feedbackURI  = "data:application/json;base64," + base64(file bytes)   (self-contained, immutable)
//   feedbackHash = keccak256(file bytes)                                   (ERC-8004: the hash of the content)
//
// The file follows the spec's "Off-Chain Feedback File Structure" (agentRegistry, agentId, clientAddress, createdAt,
// value, valueDecimals, tag1, tag2, proofOfPayment) and puts Priors' own evidence in one namespaced object, `priors`:
// the block it was read at, the score and rung, the USDG line the pool extends to the agent at that block, its on-time
// repayments with the loan ids and repayment transactions that prove the latest of them, late repayments, defaults,
// the backing behind it now, and its counted x402 income. `proofOfPayment` cites the pool's payment to the agent: the
// borrow transaction of its latest loan repaid on time (USDG the pool put at risk, and got back).
//
// Pure, no network: the data Worker builds the evidence index from its snapshot (evidenceIndex), the attester builds
// and encodes the file (attestationFile, encodeFile), the verifier decodes it (decodeFeedbackURI). Amounts are USDG
// as decimal strings ("12.5"), exact to the base unit; times are unix seconds, except createdAt (ISO 8601, per spec).
import { ethers } from "ethers";

export const CHAIN_ID = 4663;
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
/** The `priors` object's schema version: a reader that does not know it reads the spec fields and ignores the rest. */
export const SCHEMA = 2;
export const PROOF_LOANS = 5; // the latest on-time repayments cited by loan id and transaction
export const MAX_FILE_BYTES = 2048; // older proofs are dropped (never totals) to stay under it
export const DATA_URI_PREFIX = "data:application/json;base64,";
/** Evidence index layout (data Worker KV, GET /api/attest-evidence). */
export const EVIDENCE_VERSION = 1;
export const ABOUT = "https://github.com/priors-agents/priors/blob/main/docs/ATTESTATION-v2.md";
/** The published attester, named by /api/check: only this address's entries are Priors'. Owns no agent. */
export const ATTESTER = "0x613854463BB854225306b9b18bdb451A78430a73";
export const TAG1 = "priors-score";
/** The words of a note posted because the agent changed owner (`priors.ownerChanged.note`). */
export const OWNER_CHANGED = "This agent changed owner since Priors' last note. Its Priors score counts the record from the new owner.";

export const REGISTRY_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function revokeFeedback(uint256 agentId, uint64 feedbackIndex)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
];
export const NEW_FEEDBACK = "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)";
export const BORROWED = "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 fee, uint64 dueAt, address to)";

const lc = (a) => String(a || "").toLowerCase();
const int = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0; };

/** USDG base units (6 decimals) as an exact decimal string: 5000000 -> "5", 2193900000 -> "2193.9", 3800 -> "0.0038". */
export function usdg(base) {
  let b;
  try { b = BigInt(typeof base === "number" ? Math.trunc(base) : String(base ?? 0)); } catch (_) { b = 0n; }
  const neg = b < 0n; if (neg) b = -b;
  const whole = b / 1_000_000n, frac = (b % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** Token base units as a decimal string, for a stock line's collateral. */
const units = (v, decimals) => { try { return ethers.formatUnits(BigInt(String(v ?? 0)), Number(decimals || 0)).replace(/\.0$/, ""); } catch (_) { return null; } };

/** What the agent can draw now: the pool's figure, capped by the stock vault's borrowRoom for a stock line (the same
 *  rule as the paid API's availableOf and sdk/stock-vault.mjs borrowable). */
export function availableOf(a) {
  const av = int(a.available);
  const c = a.collateral;
  if (!c) return av;
  if (c.error) return 0;
  return Math.min(av, int(c.borrowRoom));
}

/** The repayment and borrow transactions of every loan, by `${era}:${loanId}`. */
function txIndex(events) {
  const repaid = new Map(), borrowed = new Map();
  for (const e of events || []) {
    if (e.kind !== "Repaid" && e.kind !== "Borrowed") continue;
    const k = `${e.era || "v2"}:${Number(e.loanId)}`;
    (e.kind === "Repaid" ? repaid : borrowed).set(k, e.tx);
  }
  return { repaid, borrowed };
}

/**
 * One agent's evidence from a site snapshot (/api/snapshot, merged with the v1 archive): the line at the snapshot's
 * block (lens creditReport `capacity` and `available`, as the site and the API show them), its loans' outcomes, the
 * latest on-time repayments with their transactions, and the backing behind it now. `tx` is txIndex(snap.events).
 */
export function evidenceOf(snap, a, loansOf, tx, { proofLoans = PROOF_LOANS } = {}) {
  const loans = loansOf.get(Number(a.id)) || [];
  let onTime = 0, onTimeBase = 0n, late = 0, defaults = 0;
  const proofs = [];
  for (const l of loans) {
    if (l.status === "defaulted") { defaults++; continue; }
    if (l.status !== "repaid") continue;
    if (int(l.closedAt) > int(l.dueAt)) { late++; continue; }
    onTime++;
    onTimeBase += BigInt(int(l.principal));
    proofs.push(l);
  }
  proofs.sort((x, y) => int(y.closedAt) - int(x.closedAt) || (x.era === y.era ? 0 : x.era === "v1" ? 1 : -1) || int(y.id) - int(x.id));
  const last = [];
  for (const l of proofs) {
    if (last.length >= proofLoans) break;
    const era = l.era || "v2";
    const t = tx.repaid.get(`${era}:${int(l.id)}`);
    if (!t) continue; // a loan whose repayment the ledger did not record is counted, not cited
    last.push(era === "v1" ? { loan: int(l.id), era: "v1", tx: t } : { loan: int(l.id), tx: t });
  }
  // the pool's payment to the agent: the borrow of its latest v2 loan repaid on time
  const paid = proofs.find((l) => (l.era || "v2") === "v2" && tx.borrowed.get(`v2:${int(l.id)}`));
  const backing = { sponsor: int(a.sponsor), delegatedIn: usdg(int(a.delegatedIn)) };
  if (a.isRoot) backing.stake = usdg(int(a.stake));
  const c = a.collateral;
  if (c && !c.error && c.token) backing.collateral = { token: c.token, symbol: c.symbol ?? null, amount: units(c.amount, c.decimals), value: c.value == null ? null : usdg(c.value) };
  // the agent's owner at the snapshot's block (the registry's ownerOf, as the snapshot reads it): the attester posts a
  // new note when it changes (docs/ATTESTATION-v2.md, "Owner")
  const owner = ethers.isAddress(String(a.owner || "")) ? lc(a.owner) : null;
  return {
    line: { limit: usdg(int(a.capacity)), available: usdg(availableOf(a)), drawn: usdg(int(a.principalOut)) },
    repaid: { onTime, usdg: usdg(onTimeBase), late, last },
    defaults, defaulted: !!a.defaulted,
    backing,
    ...(owner ? { owner } : {}),
    ...(paid ? { pay: { loan: int(paid.id), tx: tx.borrowed.get(`v2:${int(paid.id)}`), principal: usdg(int(paid.principal)) } } : {}),
  };
}

/** Evidence for every agent of the snapshot (or only `ids`): { v, block, blockTime, chainId, pool, agents: { [id]: … } }. */
export function evidenceIndex(snap, { ids = null, proofLoans = PROOF_LOANS } = {}) {
  const want = ids ? new Set([...ids].map(Number)) : null;
  const loansOf = new Map();
  for (const l of snap.loans || []) {
    const id = Number(l.agentId);
    if (want && !want.has(id)) continue;
    if (!loansOf.has(id)) loansOf.set(id, []);
    loansOf.get(id).push(l);
  }
  const tx = txIndex(snap.events);
  const agents = {};
  for (const a of snap.agents || []) {
    if (want && !want.has(Number(a.id))) continue;
    agents[Number(a.id)] = evidenceOf(snap, a, loansOf, tx, { proofLoans });
  }
  const m = snap.meta || {};
  return { v: EVIDENCE_VERSION, block: Number(m.blockNumber || 0), blockTime: Number(m.timestamp || 0), chainId: Number(m.chainId || CHAIN_ID), pool: m.pool || null, v1Pool: m.v1 || m.archive?.pool || null, agents };
}

const iso = (t) => new Date(Number(t) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The note's file. `p`: the planned entry ({ agentId, value, rung, version, tag2 }, and `why` "owner" with `prevOwner`
 * for a note posted because the agent changed owner); `s`: the agent's published score
 * entry (detail, components); `ev`: its evidence; `idx`: the evidence index head (block, blockTime, pool, v1Pool);
 * `attester`; `createdAt` (unix seconds); `payment`: { to } read from the borrow transaction, or null.
 * Key order is fixed, so the same inputs give the same bytes and the same hash.
 */
export function attestationFile({ p, s, ev, idx, attester, createdAt, tag1 = "priors-score", payment = null }) {
  const pool = ethers.getAddress(idx.pool);
  const income = s?.components?.find?.((c) => c.key === "income");
  const file = {
    agentRegistry: `eip155:${CHAIN_ID}:${IDENTITY_REGISTRY}`,
    agentId: Number(p.agentId),
    clientAddress: `eip155:${CHAIN_ID}:${ethers.getAddress(attester)}`,
    createdAt: iso(createdAt),
    value: Number(p.value),
    valueDecimals: 0,
    tag1,
    tag2: p.tag2,
  };
  if (ev.pay && payment && payment.to) {
    file.proofOfPayment = { fromAddress: pool, toAddress: ethers.getAddress(payment.to), chainId: String(CHAIN_ID), txHash: ev.pay.tx };
  }
  file.priors = {
    v: SCHEMA,
    block: Number(idx.block), blockTime: Number(idx.blockTime),
    pool, ...(ev.repaid.last.some((x) => x.era === "v1") && idx.v1Pool ? { v1Pool: ethers.getAddress(idx.v1Pool) } : {}),
    // the owner the score is for, and on the note posted because it changed, the one before it (docs/ATTESTATION-v2.md)
    ...(ev.owner ? { owner: ethers.getAddress(ev.owner) } : {}),
    ...(p.why === "owner" && p.prevOwner ? { ownerChanged: { from: ethers.getAddress(p.prevOwner), note: OWNER_CHANGED } } : {}),
    score: Number(p.value), rung: Number(p.rung), weights: String(p.version),
    line: ev.line,
    repaid: { onTime: ev.repaid.onTime, usdg: ev.repaid.usdg, last: ev.repaid.last.map((x) => ({ ...x })) },
    late: ev.repaid.late, defaults: ev.defaults, ...(ev.defaulted ? { defaulted: true } : {}),
    backing: ev.backing,
    income: { usdg: usdg(Math.round(Number(s?.detail?.incomeUsdg || 0) * 1e6)), payers: Number(s?.detail?.distinctPayers || 0), points: income ? Number(income.points) : 0 },
    ...(ev.pay ? { paid: { loan: ev.pay.loan, usdg: ev.pay.principal } } : {}),
    about: ABOUT,
  };
  return file;
}

/** The bytes, URI and hash of a file; older proofs are dropped until it fits in `max` bytes. */
export function encodeFile(file, { max = MAX_FILE_BYTES } = {}) {
  let f = file;
  let bytes = ethers.toUtf8Bytes(JSON.stringify(f));
  while (bytes.length > max && f.priors?.repaid?.last?.length) {
    f = { ...f, priors: { ...f.priors, repaid: { ...f.priors.repaid, last: f.priors.repaid.last.slice(0, -1) } } };
    bytes = ethers.toUtf8Bytes(JSON.stringify(f));
  }
  return { file: f, bytes, size: bytes.length, feedbackURI: DATA_URI_PREFIX + ethers.encodeBase64(bytes), feedbackHash: ethers.keccak256(bytes) };
}

/** The content a data: feedbackURI carries (base64 or percent-encoded), as bytes; null for any other scheme. */
export function decodeFeedbackURI(uri) {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(String(uri || ""));
  if (!m) return null;
  return m[2] ? ethers.decodeBase64(m[3]) : ethers.toUtf8Bytes(decodeURIComponent(m[3]));
}
