// Priors Score v2 2.0.2: an owner's $PRIORS stake never changes a score. SeatVaultV5 backs an agent's line with its
// owner's own $PRIORS: the line is min(the step's ceiling, the stake's value ÷ k), and 75% of the stake burns on a
// default. Its root (#8762, deployments/4663.v2.json seatVaultV5AgentId) is an ordinary backer to weights 2.0.1: once it
// is 30 days old (2026-11-10 15:06 UTC, enrolled 1791731215) a V5 line counts as someone else's risk, so a bigger stake
// opens a bigger line, backs bigger loans and raises the score. 2.0.2 counts V5's roots as the owner's own collateral,
// as 2.0.1 counts the stock vault's.
//   - 2.0.2: ledgers that differ only in the owner's stake (so in the line and the loans it backs) give the same inputs
//     (but for the size of loans that count for nothing) and the same score;
//   - 2.0.1: before the root's 30 days they agree (a young backer fails closed); after, V5's root is someone else's risk;
//   - 2.0.2 changes no number of 2.0.1, is not the SDK's default, needs the snapshot to name V5's root (else it throws:
//     no score rather than one a stake moved), counts the retired V5 root too, and keeps the stock vault's rule;
//   - Priors' scores use 2.0.2 from 2026-11-01 00:00 UTC (announced on the dev log, priors.trade/updates, on 2026-10-23):
//     until V5's roots are 30 days old, 2.0.1 and 2.0.2 give every agent the same score, so no score moves that day.
// SDK only, no network: the ledgers are written here; V5's ids come from the deployment record.
//   node scripts/test-score-v2-priors-stake.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreV2, weightsFor, WEIGHTS_BY_VERSION, DEFAULT_WEIGHTS } from "../sdk/score-v2.mjs";
import { buildInputs, scoreAll } from "../sdk/score-v2-inputs.mjs";

const DEP = JSON.parse(readFileSync(new URL("../deployments/4663.v2.json", import.meta.url), "utf8"));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log("  ok  ", name); };
const DAY = 86400, T18 = 10n ** 18n;

// V5's roots and the dates they turn 30 days old, as the chain has them. The retired root (#8641, the deployment of
// 2026-10-09, never had a book) is not in the deployment record: deployments/README.md names it.
const V5_ROOT = Number(DEP.seatVaultV5AgentId), V5_ENROLLED = 1791731215;
const V5_RETIRED = 8641, V5_RETIRED_OWNER = "0xdE29D3A627d77CFA13c5331C1B7B181a4C5B752E", V5_RETIRED_ENROLLED = 1791564294;
const AGED = V5_ENROLLED + 30 * DAY; // 2026-11-10 15:06:55 UTC
const RETIRED_AGED = V5_RETIRED_ENROLLED + 30 * DAY; // 2026-11-08 16:44:54 UTC
const SWITCH = Date.parse("2026-11-01T00:00:00Z") / 1000, TODAY = Date.parse("2026-10-23T12:00:00Z") / 1000;
const TREASURY = Number(DEP.treasuryV4AgentId), STOCK = Number(DEP.stockVaultAgentId);
const AGENT = 700, HONEST = 200, OWNER = "0x" + "a7".repeat(20), HONEST_OWNER = "0x" + "c1".repeat(20);

// V5's line, written apart from the SDK (src/v5/V5Math.sol line): value floors twice; the line is floored to $5 of
// min(ceiling, value ÷ k), k doubled. At the value and k V5's needed() read on 2026-10-21 (sqrtP below, k 4: 2): about
// 7,093 $PRIORS open the least line ($25) and 14,186 the first step's ceiling ($50).
const Q96 = 1n << 96n, SQRT_P = 943615694870601880417166777337261097n, KX2 = 4n;
const value = (t) => (((t * Q96) / SQRT_P) * Q96) / SQRT_P;
const lineOf = (stake, ceiling = 50_000_000n) => { const v = (value(stake) * 2n) / KX2; const l = v < ceiling ? v : ceiling; return Number(l - (l % 5_000_000n)); };

/** The public ledger of an agent whose owner put `stake` $PRIORS behind it on V5: its line (V5's root vouches it) and
 *  three loans of that line, 8-day terms held 7 days and repaid on time, issued from `from` (only those repaid by `now`
 *  are listed); and an honest agent the treasury backs, the same in every ledger. `meta` is the snapshot's. */
function ledger(stake, { from = AGED + DAY, now = AGED + 25 * DAY, meta = {} } = {}) {
  const line = lineOf(stake);
  const three = (agentId, sponsorId, owner, principal, firstId) => [0, 1, 2].map((i) => {
    const issuedAt = from + i * 8 * DAY;
    return { id: firstId + i, agentId, sponsorId, era: "v2", owner, principal, fee: Math.ceil(principal / 100), issuedAt, dueAt: issuedAt + 8 * DAY, closedAt: issuedAt + 7 * DAY, status: "repaid" };
  }).filter((l) => l.closedAt <= now);
  return {
    meta: { timestamp: now, treasuryAgentId: TREASURY, ...meta }, events: [],
    agents: [
      { id: TREASURY, owner: "0x" + "71".repeat(20), sponsor: 0, isRoot: true, delegatedIn: 0, enrolledAt: 1_790_000_000 },
      { id: V5_ROOT, owner: DEP.seatVaultV5, sponsor: 0, isRoot: true, delegatedIn: 0, enrolledAt: V5_ENROLLED },
      { id: V5_RETIRED, owner: V5_RETIRED_OWNER, sponsor: 0, isRoot: true, delegatedIn: 0, enrolledAt: V5_RETIRED_ENROLLED },
      { id: AGENT, owner: OWNER, sponsor: V5_ROOT, isRoot: false, delegatedIn: line, enrolledAt: 1791234053 },
      { id: HONEST, owner: HONEST_OWNER, sponsor: TREASURY, isRoot: false, delegatedIn: 5_000_000, enrolledAt: 1791234053 },
    ],
    loans: [...three(AGENT, V5_ROOT, OWNER, line, 900), ...three(HONEST, TREASURY, HONEST_OWNER, 5_000_000, 800)],
  };
}
const SMALL = 7_100n * T18, BIG = 14_200n * T18; // $25 and $50 lines
const STAKES = [3_000n * T18, SMALL, 10_000n * T18, BIG, 1_000_000n * T18]; // $10, $25, $35, $50, $50 (the ceiling)
const NAMED = { seatVaultV5AgentId: V5_ROOT, seatVaultV5RetiredAgentId: V5_RETIRED };
const opts = (w, now) => ({ links: { clusters: [] }, weights: weightsFor(w), now });
const inputsOf = (snap, w, id = AGENT) => buildInputs(snap, opts(w, snap.meta.timestamp)).find((x) => x.agentId === id);
const scoreOf = (snap, w, id = AGENT) => scoreAll(snap, opts(w, snap.meta.timestamp)).find((x) => x.agentId === id);
const othersPart = (i) => ({ backedByOthers: i.loans.map((l) => l.backedByOthers), backingByOthers: i.backingByOthers });
const sizeless = (i) => ({ ...i, loans: i.loans.map(({ principal, ...l }) => l) });
const versionless = ({ version, ...r }) => r;
const pts = (r, k) => r.components.find((c) => c.key === k).points;

console.log("Priors Score v2 2.0.2: the owner's $PRIORS stake behind a V5 line never changes a score");

check("the ledgers: 3,000 / 7,100 / 10,000 / 14,200 / 1,000,000 $PRIORS open $10 / $25 / $35 / $50 / $50 lines (V5's rule at 2026-10-21's values); each backs three loans of its line", () => {
  assert.deepEqual(STAKES.map((s) => lineOf(s)), [10_000_000, 25_000_000, 35_000_000, 50_000_000, 50_000_000]);
  assert.deepEqual(ledger(SMALL).loans.filter((l) => l.agentId === AGENT).map((l) => l.principal), [25_000_000, 25_000_000, 25_000_000]);
  assert.deepEqual(ledger(BIG).loans.filter((l) => l.agentId === AGENT).map((l) => l.principal), [50_000_000, 50_000_000, 50_000_000]);
  assert.equal(new Date(AGED * 1000).toISOString(), "2026-11-10T15:06:55.000Z", "V5's root turns 30 days old");
  assert.equal(new Date(RETIRED_AGED * 1000).toISOString(), "2026-11-08T16:44:54.000Z", "the retired root turns 30 days old");
  assert.equal(V5_ROOT, 8762);
});

check("2.0.1 after the root's 30 days: V5's root is someone else's risk, so the bigger stake reads as more risk and a higher score", () => {
  const a = inputsOf(ledger(SMALL), "2.0.1"), b = inputsOf(ledger(BIG), "2.0.1");
  assert.deepEqual(a.loans.map((l) => l.backedByOthers), [true, true, true], "V5's root counts as another party");
  assert.deepEqual(b.loans.map((l) => l.backedByOthers), [true, true, true]);
  assert.equal(a.backingByOthers, 25_000_000); assert.equal(b.backingByOthers, 50_000_000);
  const sa = scoreOf(ledger(SMALL), "2.0.1"), sb = scoreOf(ledger(BIG), "2.0.1");
  assert.ok(sb.score > sa.score, `${sa.score} -> ${sb.score}`);
  for (const k of ["riskTime", "seasoned", "backing"]) assert.ok(pts(sb, k) > pts(sa, k), k);
  assert.equal(sa.rung, 2, "three backed repayments over 14+ days: proven, on the owner's own $PRIORS");
  assert.equal(sb.rung, 2);
  assert.deepEqual([sa.score, sb.score], [111, 199], "the figures docs/SCORE-v2.md gives");
  console.log(`        2.0.1: a $25 line scores ${sa.score}, a $50 line ${sb.score}: the stake moved the score`);
});

check("2.0.1 before the root's 30 days: the same two ledgers agree (a young backer fails closed)", () => {
  const early = { from: AGED - 25 * DAY, now: AGED - DAY };
  const a = inputsOf(ledger(SMALL, early), "2.0.1"), b = inputsOf(ledger(BIG, early), "2.0.1");
  assert.deepEqual(othersPart(a), othersPart(b));
  assert.deepEqual(a.loans.map((l) => l.backedByOthers), [false, false, false]);
  assert.equal(scoreOf(ledger(SMALL, early), "2.0.1").score, scoreOf(ledger(BIG, early), "2.0.1").score);
});

check("2.0.2, after the root's 30 days: any stake gives identical inputs (nothing backed by others; only the size of loans that count for nothing differs) and the same score", () => {
  const ref = ledger(STAKES[0], { meta: NAMED }), refIn = inputsOf(ref, "2.0.2"), refScore = scoreOf(ref, "2.0.2");
  assert.deepEqual(othersPart(refIn), { backedByOthers: [false, false, false], backingByOthers: 0 }, "the owner's own collateral");
  for (const stake of STAKES.slice(1)) {
    const s = ledger(stake, { meta: NAMED }), i = inputsOf(s, "2.0.2"), r = scoreOf(s, "2.0.2");
    assert.deepEqual(sizeless(i), sizeless(refIn), `inputs at ${stake / T18} $PRIORS`);
    assert.equal(r.score, refScore.score);
    assert.equal(r.rung, refScore.rung);
    assert.deepEqual(r.components, refScore.components);
    assert.deepEqual(r.detail, refScore.detail);
    assert.deepEqual(r.next, refScore.next);
    assert.equal(r.version, "2.0.2");
  }
  assert.equal(scoreOf(ledger(SMALL, { meta: NAMED }), "2.0.2").score, 24, "the figure docs/SCORE-v2.md gives");
  console.log(`        2.0.2: a $10 to a $50 line all score ${refScore.score} (age only), rung ${refScore.rung}`);
});

check("2.0.2 leaves every other agent as 2.0.1 scores it: the honest $5 agent the treasury backs is unchanged", () => {
  const s = ledger(BIG, { meta: NAMED });
  assert.deepEqual(versionless(scoreOf(s, "2.0.2", HONEST)), versionless(scoreOf(s, "2.0.1", HONEST)));
  assert.equal(scoreOf(s, "2.0.2", HONEST).detail.repaidByOthers, 3);
});

check("2.0.2 counts the retired V5 root (#8641) as the owner's own too, when the snapshot names it", () => {
  const s = ledger(BIG, { meta: NAMED });
  s.agents.find((a) => a.id === AGENT).sponsor = V5_RETIRED;
  for (const l of s.loans) if (l.agentId === AGENT) l.sponsorId = V5_RETIRED;
  assert.deepEqual(othersPart(inputsOf(s, "2.0.2")), { backedByOthers: [false, false, false], backingByOthers: 0 });
  assert.deepEqual(inputsOf(s, "2.0.1").loans.map((l) => l.backedByOthers), [true, true, true], "2.0.1: the retired root is 30 days old from 2026-11-08");
});

check("2.0.2 fails closed: without meta.seatVaultV5AgentId it builds no inputs (no score rather than one a stake moved)", () => {
  assert.throws(() => inputsOf(ledger(BIG), "2.0.2"), /seatVaultV5AgentId/);
  assert.throws(() => scoreOf(ledger(BIG), "2.0.2"), /seatVaultV5AgentId/);
  assert.throws(() => inputsOf(ledger(BIG, { meta: { seatVaultV5RetiredAgentId: V5_RETIRED } }), "2.0.2"), /seatVaultV5AgentId/, "the retired root alone is not enough");
  assert.doesNotThrow(() => inputsOf(ledger(BIG), "2.0.1"), "2.0.1 needs nothing new");
});

check("2.0.2 keeps the stock vault's rule (its loans are the borrower's own)", () => {
  const s = ledger(BIG, { meta: { ...NAMED, stockVaultAgentId: STOCK } });
  s.agents.push({ id: STOCK, owner: "0x" + "57".repeat(20), sponsor: 0, isRoot: true, delegatedIn: 0, enrolledAt: 1_790_000_000 });
  s.agents.find((a) => a.id === HONEST).sponsor = STOCK;
  for (const l of s.loans) if (l.agentId === HONEST) l.sponsorId = STOCK;
  assert.deepEqual(othersPart(inputsOf(s, "2.0.2", HONEST)), { backedByOthers: [false, false, false], backingByOthers: 0 });
});

check("2.0.2 is 2.0.1 plus V5's roots: no number changed; published 2026-10-23, 7+ days before 2026-11-01; not the SDK's default", () => {
  const W201 = weightsFor("2.0.1"), W202 = weightsFor("2.0.2");
  assert.deepEqual(W202.backers.ownCollateralRoots, ["stockVault", "seatVaultV5"]);
  const strip = (w) => { const c = JSON.parse(JSON.stringify(w)); delete c.backers.ownCollateralRoots; delete c.backers.ownCollateralWhy; delete c.version; delete c.published; delete c.notes; return c; };
  assert.deepEqual(strip(W202), strip(W201), "no weight, rung or penalty number changes");
  assert.equal(W202.published, "2026-10-23", "announced on the dev log on 2026-10-23");
  assert.ok(SWITCH - Date.parse(W202.published) / 1000 >= 7 * DAY, "announced 7 days ahead");
  assert.doesNotMatch(W202.notes, /note on X|not published/, "the notes say how it was announced");
  assert.equal(DEFAULT_WEIGHTS.version, "2.0.0", "DEFAULT_WEIGHTS stays 2.0.0");
  assert.deepEqual(Object.keys(WEIGHTS_BY_VERSION).sort(), ["2.0.0", "2.0.1", "2.0.2"]);
  assert.equal(scoreV2({ agentId: 1, now: 1, loans: [] }, W202).version, "2.0.2");
});

check("no score moves on 2026-11-01: from today through the switch until V5's roots are 30 days old, 2.0.1 and 2.0.2 give every agent the same score, rung and breakdown", () => {
  assert.ok(SWITCH < RETIRED_AGED && SWITCH < AGED, "the switch comes before either root passes 2.0.1's 30-day rule");
  for (const t of [TODAY, SWITCH - 1, SWITCH, RETIRED_AGED - 1, AGED - 1]) {
    const s = ledger(BIG, { from: V5_ENROLLED + DAY, now: t, meta: NAMED });
    assert.ok(s.loans.some((l) => l.sponsorId === V5_ROOT), "a repaid V5 loan is in the inputs");
    const a = scoreAll(s, opts("2.0.1", t)), b = scoreAll(s, opts("2.0.2", t));
    assert.deepEqual(b.map((x) => x.agentId), a.map((x) => x.agentId));
    a.forEach((x, i) => assert.deepEqual(versionless(b[i]), versionless(x), `agent ${x.agentId} at ${new Date(t * 1000).toISOString()}`));
    assert.ok(a.find((x) => x.agentId === AGENT).score > 0, "the V5 line's agent has a record (its age) to compare");
  }
});

check("the reason for the date: from 2026-11-10 15:06 UTC 2.0.1 counts the V5 line as someone else's backing and 2.0.2 does not; every other agent still scores the same", () => {
  const t = AGED + DAY, s = ledger(BIG, { from: V5_ENROLLED + DAY, now: t, meta: NAMED });
  const a = scoreAll(s, opts("2.0.1", t)), b = scoreAll(s, opts("2.0.2", t));
  const v1 = a.find((x) => x.agentId === AGENT), v2 = b.find((x) => x.agentId === AGENT);
  assert.ok(v1.score > v2.score, `2.0.1 ${v1.score}, 2.0.2 ${v2.score}`);
  assert.ok(pts(v1, "backing") > 0 && pts(v2, "backing") === 0);
  a.forEach((x, i) => { if (x.agentId !== AGENT) assert.deepEqual(versionless(b[i]), versionless(x), `agent ${x.agentId}`); });
});

console.log(`\n${passed} passed`);
