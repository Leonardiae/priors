// Priors Score v2: a pure, deterministic function of public records. No network, no clock, no randomness: the same
// inputs give the same score everywhere (site, API, MCP, anyone's laptop). Weights live in score-weights.v2.json and
// are versioned; docs/SCORE-v2.md explains every component and how changes are made.
//
// What it adds over the on-chain v1 score (src/libraries/ScoreLib.sol):
//   - only risk SOMEONE ELSE took counts: loans backed by the agent's own cluster (same owner, or agents and
//     wallets under common control) build no score;
//   - late repayments are penalised and earn nothing;
//   - age runs from the first loan on Priors, v1 included, and restarts when the agent changes hands;
//   - a default by any agent of the same owner zeroes the owner's other agents too;
//   - x402 income from distinct payers outside the cluster, each payer capped and weighted by its own record;
//   - a rung on the trust ladder (docs/TRUST.md) and a full breakdown, so every number explains itself.
//
// Inputs (all amounts in USDG base units, 6 decimals; all times unix seconds):
//   { agentId, now (required), defaulted, ownerDefaulted?, recordStart (first loan), ownershipChangedAt?,
//     childrenDefaulted, recourseHonored,
//     backingByOthers, loans: [{ principal, issuedAt, dueAt, closedAt, status, backedByOthers }],
//     income: [{ payer, amount, at, payerScore? }] }   // income already filtered to payers outside the cluster
import WEIGHTS from "./score-weights.v2.json" with { type: "json" };
import WEIGHTS_2_0_1 from "./score-weights.v2.0.1.json" with { type: "json" };

const DAY = 86400;
const USDG = 1e6;
const PPM = 1_000_000n;
const round1 = (x) => Math.round(x * 10) / 10;

/** The default weights (2.0.0). A newer version becomes the default only once announced (docs/SCORE-v2.md). */
export const DEFAULT_WEIGHTS = WEIGHTS;
/** Every published weights version, so a past score can be recomputed and a new one run before it is the default. */
export const WEIGHTS_BY_VERSION = Object.freeze({ [WEIGHTS.version]: WEIGHTS, [WEIGHTS_2_0_1.version]: WEIGHTS_2_0_1 });
/** The weights of `version` (the default when empty); an unknown version throws. */
export function weightsFor(version) {
  if (version == null || String(version).trim() === "") return DEFAULT_WEIGHTS;
  const w = WEIGHTS_BY_VERSION[String(version).trim()];
  if (!w) throw new Error(`score-v2: unknown weights version ${version} (known: ${Object.keys(WEIGHTS_BY_VERSION).join(", ")})`);
  return w;
}

/** How much a payer's USDG counts (0..1): unknown wallets at `unknownPayerWeight`, scored ones by their own score. */
export function payerWeight(score, W = WEIGHTS) {
  const C = W.components.income, s = Number(score);
  if (score == null || !Number.isFinite(s)) return C.unknownPayerWeight;
  return C.scoredPayerFloor + (1 - C.scoredPayerFloor) * Math.min(1, Math.max(0, s) / W.max);
}

const num = (v, name, agentId) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new TypeError(`score-v2: agent ${agentId}: ${name} must be a finite, non-negative number (got ${v})`);
  return n;
};

/** Score one agent. Returns { version, agentId, score, rung, rungName, components, penalties, detail, flags }. */
export function scoreV2(input, W = WEIGHTS) {
  const C = W.components, R = W.rungs, id = input.agentId;
  if (input.now == null) throw new TypeError(`score-v2: agent ${id}: 'now' is required (the score must not read the clock)`);
  const now = num(input.now, "now", id);
  const since = num(input.ownershipChangedAt ?? 0, "ownershipChangedAt", id);
  const flags = { defaulted: !!input.defaulted, ownerDefaulted: !!input.ownerDefaulted, ownershipChanged: since > 0 };

  // loans that count: repaid, issued after the last change of hands, backed by someone else. Every sum over loans is
  // an integer (risk time in base units x seconds x parts per million), so the result never depends on their order.
  // A loan repaid from income (incomeShare 0..1, sdk/score-v2-inputs.mjs) earns up to `incomeRepaidBonus` more risk
  // time.
  let weighted = 0n, seasonedUnits = 0n, incomePpm = 0n, seasoned = 0, late = 0, repaidByOthers = 0, firstByOthers = Infinity, lastByOthers = 0;
  const fullSize = BigInt(C.seasoned.fullSizeUsdg * USDG);
  const bonusPpm = BigInt(Math.round(num(C.riskTime.incomeRepaidBonus ?? 0, "incomeRepaidBonus", id) * 1e6));
  for (const l of input.loans || []) {
    const issuedAt = num(l.issuedAt, "loan.issuedAt", id), dueAt = num(l.dueAt, "loan.dueAt", id);
    if (l.status !== "repaid" || issuedAt < since) continue;
    const closedAt = num(l.closedAt, "loan.closedAt", id), principal = num(l.principal, "loan.principal", id);
    const share = num(l.incomeShare ?? 0, "loan.incomeShare", id);
    if (share > 1) throw new TypeError(`score-v2: agent ${id}: loan.incomeShare must be at most 1 (got ${share})`);
    if (closedAt > dueAt) { late++; continue; }
    if (!l.backedByOthers) continue;
    const held = Math.max(0, Math.floor(Math.min(closedAt, dueAt) - issuedAt));
    const sharePpm = BigInt(Math.round(share * 1e6));
    weighted += BigInt(Math.floor(principal)) * BigInt(held) * (PPM * PPM + bonusPpm * sharePpm);
    incomePpm += sharePpm;
    if (held >= C.seasoned.minHoldDays * DAY) {
      seasoned++;
      const p = BigInt(Math.floor(principal));
      seasonedUnits += p < fullSize ? p : fullSize;
    }
    repaidByOthers++;
    firstByOthers = Math.min(firstByOthers, issuedAt);
    lastByOthers = Math.max(lastByOthers, closedAt);
  }
  const SCALE = BigInt(USDG) * PPM * PPM; // weighted is USDG base units x seconds x 1e12
  const dollarDays = (Number(weighted / SCALE) + Number(weighted % SCALE) / Number(SCALE)) / DAY;
  const seasonedWeight = Number(seasonedUnits) / Number(fullSize);
  const repaidFromIncome = Number(incomePpm) / 1e6;

  // age runs from the first loan (no loans: no age), and from the change of hands if later
  const start = Math.max(input.recordStart == null ? now : num(input.recordStart, "recordStart", id), since);
  const ageDays = Math.max(0, Math.floor((now - start) / DAY));

  // income: per payer, inside the window, capped, weighted by the payer's own record; dust payers add no breadth
  const byPayer = new Map();
  const byKey = (x, y) => Number(x.at) - Number(y.at) || (String(x.payer) < String(y.payer) ? -1 : String(x.payer) > String(y.payer) ? 1 : 0) || Number(x.amount) - Number(y.amount);
  for (const p of [...(input.income || [])].sort(byKey)) { // sorted, so float sums never depend on input order
    const at = Number(p.at), amount = Number(p.amount);
    if (!Number.isFinite(at) || !Number.isFinite(amount) || amount <= 0) continue;
    if (at > now || at < now - C.income.windowDays * DAY || at < since) continue;
    const k = String(p.payer).toLowerCase();
    const cur = byPayer.get(k) || { amount: 0, score: p.payerScore };
    cur.amount += amount;
    byPayer.set(k, cur);
  }
  let incomeValue = 0, payers = 0, incomeUsdg = 0, receiptsUsdg = 0, receiptPayers = 0;
  for (const [, { amount, score }] of [...byPayer.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const usd = amount / USDG;
    // receipts: every payer outside the cluster, dust and fresh wallets included, at face value. Shown as what the
    // agent was paid; only the income below (capped, weighted, dust left out) counts toward the score.
    receiptsUsdg += usd;
    receiptPayers++;
    if (usd < C.income.minPayerUsdg) continue; // dust: a payer counts once it has paid 1 USDG in the window
    incomeValue += Math.min(usd, C.income.perPayerCapUsdg) * payerWeight(score, W);
    incomeUsdg += usd;
    payers++;
  }
  const breadth = Math.min(C.income.breadthMax, payers * C.income.breadthPointsPerPayer);

  const comp = {
    riskTime: Math.min(C.riskTime.max, dollarDays / C.riskTime.usdgDaysPerPoint),
    seasoned: Math.min(C.seasoned.max, seasonedWeight * C.seasoned.pointsEach),
    backing: Math.min(C.backing.max, num(input.backingByOthers ?? 0, "backingByOthers", id) / USDG / C.backing.usdgPerPoint),
    age: Math.min(C.age.max, ageDays * C.age.pointsPerDay),
    // paying a vouched agent's debt is the old owner's act, so it does not survive a change of hands
    recourse: since > 0 ? 0 : Math.min(C.recourse.max, num(input.recourseHonored ?? 0, "recourseHonored", id) * C.recourse.pointsEach),
    income: Math.min(C.income.max, incomeValue / C.income.usdgPerPoint + breadth),
  };
  const penalties = {
    late: late * W.penalties.lateRepayment,
    childDefaults: num(input.childrenDefaulted ?? 0, "childrenDefaulted", id) * W.penalties.childDefault,
  };

  const zeroed = flags.defaulted || flags.ownerDefaulted;
  const positive = Object.values(comp).reduce((a, b) => a + b, 0);
  const negative = penalties.late + penalties.childDefaults;
  const score = zeroed ? 0 : Math.max(0, Math.min(W.max, Math.floor(positive - negative)));
  // the record alone (income left out): what the "earned" rung is judged on, so income can't lift a thin record to it
  const recordScore = zeroed ? 0 : Math.max(0, Math.min(W.max, Math.floor(positive - comp.income - negative)));

  // rung on the trust ladder: each step needs records, and time
  const span = repaidByOthers ? (lastByOthers - firstByOthers) / DAY : 0;
  const sinceFirst = repaidByOthers ? (now - firstByOthers) / DAY : 0;
  let rung = 0;
  if (!zeroed && repaidByOthers >= R[1].minRepaid) rung = 1;
  if (rung >= 1 && repaidByOthers >= R[2].minRepaid && span >= R[2].minSpanDays && late === 0) rung = 2;
  if (rung >= 2 && recordScore >= R[3].minScore && sinceFirst >= R[3].minDays) rung = 3;
  if (rung >= 3 && comp.income >= R[4].minIncomePoints && payers >= R[4].minPayers) rung = 4;

  const components = Object.entries(comp).map(([key, points]) => ({ key, points: round1(points), max: C[key].max, why: C[key].why }));
  const detail = { dollarDays: round1(dollarDays), seasonedLoans: seasoned, repaidByOthers, repaidFromIncome: round1(repaidFromIncome), lateRepayments: late, ageDays, distinctPayers: payers, incomeUsdg: round1(incomeUsdg), receiptsUsdg: round1(receiptsUsdg), receiptPayers };
  // incomeUsdg: the x402 USDG of the payers that count (in the window, netted, dust left out), before caps and weights
  // receiptsUsdg / receiptPayers: every payer outside the cluster in the window (netted), dust and fresh wallets included
  // the next rung and how far the agent is on each of its conditions (have / need), from the same figures the rung is
  // judged on just above: what an owner can act on. Null at the top and after a default. `blocked`: a condition that can
  // no longer be met ("late": a late repayment keeps Proven closed). It adds nothing to the score or the rung
  let next = null;
  if (!zeroed && rung < R.length - 1) {
    const r = rung + 1, Rn = R[r];
    const need = (key, have, want) => ({ key, have, need: want, met: have >= want });
    const needs = r === 1 ? [need("backedRepaid", repaidByOthers, Rn.minRepaid)]
      : r === 2 ? [need("backedRepaid", repaidByOthers, Rn.minRepaid), need("spanDays", Math.floor(span), Rn.minSpanDays), { key: "late", have: late, need: 0, met: late === 0 }]
        : r === 3 ? [need("recordScore", recordScore, Rn.minScore), need("daysSinceFirst", Math.floor(sinceFirst), Rn.minDays)]
          : [need("incomePoints", Math.floor(comp.income), Rn.minIncomePoints), need("payers", payers, Rn.minPayers)];
    next = { rung: r, name: Rn.name, needs, blocked: r === 2 && late > 0 ? "late" : null };
  }
  return { version: W.version, agentId: id, score, rung, rungName: R[rung].name, components, penalties, detail, flags, next };
}

/** Deterministic JSON (sorted keys) for hashing inputs, so a published score can be checked against its inputs. */
export function canonical(v) {
  if (v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
