// Builds Priors Score v2 inputs from public data: the site snapshot (priors.trade/api/snapshot: agents, loans,
// events), known links between agents and wallets (`links`: Priors' clusters list, not published) and x402 income read from the
// chain (sdk/x402-income.mjs: signed USDG payments to agent wallets from any facilitator, the payment wallet each
// agent declared in the ERC-8004 registry, transfers sent back to payers, and who repaid each loan).
// Pure: no network, no clock.
//
// Clusters. A loan counts toward the score only if its backer sits in a different cluster from the borrower, and
// income counts only from payers outside the agent's cluster. An agent's cluster joins its owner, the payment wallet
// it declared (agentWallet: that wallet signed to accept it, so it is under the same control) and every agent and
// wallet linked through them, plus the links of the clusters file. Funding-source clustering (wallets paid for by
// the same source) plugs in here later. Clusters shape the computation only: no output names them.
//
// Income. A payment counts for the agents that declared the paid wallet as their payment wallet (the registry sets
// it to the owner at registration, clears it when the agent changes hands, and changing it needs the wallet's
// signature), shared evenly between them: an agent pushed onto someone's address can't take a share of their income.
// Money an agent's cluster sent to a payer (before or after) is netted out of that payer's payments to it: USDG that
// goes back where it came from is not income. A loan that counts (backed by someone else, repaid on time by the
// agent's own wallets, since its last change of hands) is marked as repaid from income (`incomeShare`, 0..1) by the
// counted income that arrived during it, each payment weighted like income, capped per payer and loan, and spent
// once.
//
// Defaults. A default zeroes the other agents of the wallet that defaulted: the loan's owner when it was taken, and
// the defaulted agent's declared payment wallet. Never whoever holds its NFT today: sending a defaulted agent to
// someone can't harm them.
//
// Fails closed: a backer the snapshot doesn't know, or one enrolled for less than `backers.minAgeDays` when the loan
// was issued, counts as the agent's own money.
//
// Own collateral (weights 2.0.1, `backers.ownCollateralRoots`): the stock vault's root (snapshot meta.stockVaultAgentId)
// counts as the borrower's own money too. The vault backs a line with the borrower's own stock tokens, which it seizes
// on a default: loans on them are no risk someone else took. Weights 2.0.2 add SeatVaultV5's roots ("seatVaultV5":
// meta.seatVaultV5AgentId, and meta.seatVaultV5RetiredAgentId when named): V5 sizes a line by the owner's own $PRIORS
// behind the agent and burns 75% of it on a default, so a bigger stake is no more risk someone else took. Fails closed:
// with "seatVaultV5" and no meta.seatVaultV5AgentId, no inputs are built.
import { scoreV2, payerWeight, DEFAULT_WEIGHTS } from "./score-v2.mjs";

const lc = (a) => String(a || "").toLowerCase();
/** Whether a loan was repaid by the agent's own wallets: `r` is the one address that repaid, or the addresses that paid
 *  through AutoRepay (sdk/x402-income.mjs readRepayers), each of which must be one of `own`. */
export const repaidByOwn = (own, r) => { const all = [].concat(r ?? []); return all.length > 0 && all.every((a) => own.has(lc(a))); };
const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a) => { const x = lc(a).trim(); return x !== "" && x !== ZERO && x !== "null" && x !== "undefined"; }; // a usable wallet key
const DAY = 86400;
const USDG = 1e6;

/** A small union-find over string keys. */
function unionFind() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra > rb ? ra : rb, ra > rb ? rb : ra); };
  return { find, union, keys: () => [...parent.keys()] };
}

/** The roots whose loans are the borrower's own money under `weights` (`backers.ownCollateralRoots`): "stockVault",
 *  the stock vault's root (meta.stockVaultAgentId, when named); "seatVaultV5" (2.0.2), V5's root (meta.seatVaultV5AgentId,
 *  required: throws without it) and the retired V5 root (meta.seatVaultV5RetiredAgentId, when named). */
export function ownCollateralRoots(snapshot, weights = DEFAULT_WEIGHTS) {
  const m = snapshot.meta || {}, keys = weights.backers.ownCollateralRoots || [], ids = [];
  if (keys.includes("stockVault") && Number(m.stockVaultAgentId) > 0) ids.push(Number(m.stockVaultAgentId));
  if (keys.includes("seatVaultV5")) {
    if (!(Number(m.seatVaultV5AgentId) > 0)) throw new Error(`score-v2 inputs: weights ${weights.version} count SeatVaultV5's root as the owner's own collateral: the snapshot must name it (meta.seatVaultV5AgentId)`);
    ids.push(Number(m.seatVaultV5AgentId));
    if (Number(m.seatVaultV5RetiredAgentId) > 0) ids.push(Number(m.seatVaultV5RetiredAgentId));
  }
  return new Set(ids);
}

/**
 * Clusters of agents and wallets. `agentWallets`: { [agentId]: address | null } (ERC-8004 getAgentWallet).
 * A cluster joins an agent's owner, its declared payment wallet and the links of the clusters file, transitively.
 * `declaredBy` maps a wallet to the agents that declared it as their payment wallet (income goes to them only);
 * `walletsOf` maps an agent to its own wallets (owner and declared wallet: who can repay "from its pocket").
 */
export function makeClusters(snapshot, links = { clusters: [] }, agentWallets = {}) {
  const byId = new Map(snapshot.agents.map((a) => [Number(a.id), a]));
  const cluster = unionFind();
  const walletsOf = new Map(); // agentId -> [wallets]
  const declaredBy = new Map(); // wallet -> [agentIds that declared it]
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(v)) m.get(k).push(v); };
  for (const a of snapshot.agents) {
    const id = Number(a.id);
    // an agent whose owner is unknown stands alone (never merged with other ownerless agents) and has no wallet
    const o = isAddr(a.owner) ? lc(a.owner) : `none:${id}`;
    if (isAddr(a.owner)) push(walletsOf, id, o);
    cluster.union(`a:${id}`, `w:${o}`);
    const aw = lc(agentWallets[id]);
    if (isAddr(aw)) {
      push(walletsOf, id, aw);
      push(declaredBy, aw, id);
      cluster.union(`w:${o}`, `w:${aw}`);
    }
  }
  (links.clusters || []).forEach((c, i) => {
    const hub = `l:${i}`;
    for (const id of c.agents || []) cluster.union(hub, `a:${Number(id)}`);
    for (const w of c.wallets || []) cluster.union(hub, `w:${lc(w)}`);
  });
  const listed = new Set((links.clusters || []).flatMap((c) => (c.agents || []).map(Number)));

  /** The cluster of an agent; `owner` is its owner when a loan was taken, if that differs from today's. */
  const clusterOfAgent = (id, owner) => {
    const a = byId.get(Number(id));
    if (!a) return `unknown:${id}`;
    if (owner && lc(owner) !== lc(a.owner) && !listed.has(Number(id))) return cluster.find(`w:${lc(owner)}`);
    return cluster.find(`a:${Number(id)}`);
  };
  const clusterOfWallet = (w) => cluster.find(`w:${lc(w)}`);
  return { byId, walletsOf, declaredBy, clusterOfAgent, clusterOfWallet };
}

/**
 * When the agent's current owner took it over: the first loan after the last one taken under another owner. v1 loans
 * carry no owner, so a sale after v1 history is read from `transferredAt` (the agent's last registry transfer) when a
 * v1 loan came before it; a transfer before every v1 loan (its mint) moves nothing (own audit 2026-10-01).
 */
function ownershipChangedAt(agent, loans, now, transferredAt) {
  const byIssue = [...loans].sort((x, y) => Number(x.issuedAt) - Number(y.issuedAt));
  const withOwner = byIssue.filter((l) => l.owner);
  let lastOther = -1;
  withOwner.forEach((l, i) => { if (lc(l.owner) !== lc(agent.owner)) lastOther = i; });
  const next = withOwner[lastOther + 1];
  const fromLoans = lastOther < 0 ? 0 : next ? Number(next.issuedAt) : now; // not borrowed since the change: the record starts now
  const sold = Number(transferredAt) || 0;
  if (!(sold > 0) || !byIssue.some((l) => l.era === "v1" && Number(l.issuedAt) < sold)) return fromLoans;
  const after = byIssue.find((l) => Number(l.issuedAt) >= sold);
  return Math.max(fromLoans, after ? Number(after.issuedAt) : now);
}

/**
 * Inputs for every agent in the snapshot.
 *   income        [{ payer, payTo, amount, at }]  signed USDG payments (amount: atomic USDG, number or string)
 *   agentWallets  { [agentId]: address | null }    declared payment wallets (ERC-8004 getAgentWallet); income is
 *                                                  matched on these only
 *   transfers     [{ from, to, amount, at }]       USDG sent from agent-side wallets to payers (netted out)
 *   repayers      { [loanId]: address | [address] } who repaid each v2 loan (Repaid.payer; for a repayment
 *                                                  through AutoRepay, the address or addresses that paid through it:
 *                                                  all of them must be the agent's own); v2 loan ids only, never
 *                                                  applied to a v1 loan with the same id
 *   payerScores   { [address]: score }             a payer's own v2 score (scoreAll fills it)
 *   backerOwnerSince { [agentId]: seconds }        the last registry transfer of each backer id (sdk/x402-income.mjs
 *                                                  updateBackerTenure): a backer's 30 days count from then when it is
 *                                                  later than its enrolment. Absent: from its enrolment.
 *   ownerSince    { [agentId]: seconds }           the last registry transfer of an agent id (same reader): a sale
 *                                                  after its v1 loans restarts its record, as v2 loans' owners show
 *                                                  a sale after v2 loans. Absent: from the loans alone.
 *   pending       { payers: [...], wallets: [...] } netting still being read (sdk/x402-income.mjs): payments from
 *                                                  those payers, or to a cluster holding one of those wallets, wait
 */
export function buildInputs(snapshot, { links, income = [], agentWallets = {}, transfers = [], repayers = {}, payerScores = {}, pending = {}, backerOwnerSince = {}, ownerSince = {}, now, weights = DEFAULT_WEIGHTS } = {}) {
  const t = Number(now ?? snapshot.meta?.timestamp);
  if (!Number.isFinite(t) || t <= 0) throw new TypeError("score-v2 inputs: pass `now` (or a snapshot with meta.timestamp)");
  const K = makeClusters(snapshot, links, agentWallets);
  const minBackerAge = weights.backers.minAgeDays * DAY;
  // the pool's treasury (and treasury v5, once the snapshot names it: a line moved there is the treasury's as before)
  // and seat vaults (V3, and the growth vault V4) count as backers from day one (public ids in the snapshot's meta)
  const protocolBackers = new Set([snapshot.meta?.treasuryAgentId, snapshot.meta?.treasuryV5AgentId, snapshot.meta?.seatVaultAgentId, snapshot.meta?.seatVaultV4AgentId, snapshot.meta?.archive?.treasuryAgentId].filter((x) => x != null).map(Number));
  // roots that lend against the borrower's own collateral: never someone else's risk
  const ownRoots = ownCollateralRoots(snapshot, weights);
  // v1 loans predate the loan's own sponsorId: their backer is in the FeeSplit event of the repayment
  const v1Backer = new Map();
  for (const e of snapshot.events || []) if (e.kind === "FeeSplit" && e.era === "v1") v1Backer.set(Number(e.loanId), Number(e.sponsor));

  // a loan the snapshot can't describe (missing or negative numbers) is left out: it counts for nothing, and it can't
  // stop every other agent from being scored
  const fine = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && v !== null && v !== "";
  const readable = (l) => fine(l.principal) && fine(l.issuedAt) && fine(l.dueAt) && (l.status !== "repaid" || fine(l.closedAt));
  const loansBy = new Map();
  for (const l of snapshot.loans || []) {
    if (!readable(l)) continue;
    if (!loansBy.has(l.agentId)) loansBy.set(l.agentId, []);
    loansBy.get(l.agentId).push(l);
  }

  const backerCounts = (backerId, issuedAt, borrowerCluster) => {
    const b = K.byId.get(Number(backerId));
    if (!b || !(Number(backerId) > 0)) return false;               // unknown backer: fail closed
    if (ownRoots.has(Number(backerId))) return false;              // the borrower's own collateral
    if (K.clusterOfAgent(backerId) === borrowerCluster) return false;
    if (protocolBackers.has(Number(backerId))) return true;
    // its age counts from when its current owner took the id, if later than its enrolment: a bought aged id is a new
    // backer (private report GHSA-6f8j). `backerOwnerSince`: id -> the last registry transfer of that id, in seconds.
    const since = Math.max(Number(b.enrolledAt) || 0, Number(backerOwnerSince?.[Number(backerId)]) || 0);
    return Number(b.enrolledAt) > 0 && Number(issuedAt) - since >= minBackerAge;
  };

  // a default zeroes the other agents of the wallet that defaulted: the defaulted loan's owner when it was taken (v2
  // loans record it) and the defaulted agent's declared payment wallet (the registry clears it when the NFT moves, so
  // it is its current owner's own, signed choice). Never whoever holds a defaulted NFT: anyone can send one to anyone.
  // A v1 default (no owner recorded) zeroes only the agent itself.
  const defaultedWallets = new Set();
  for (const l of snapshot.loans || []) if (l.status === "defaulted" && isAddr(l.owner)) defaultedWallets.add(lc(l.owner));
  for (const a of snapshot.agents) if (a.defaulted && isAddr(agentWallets[a.id])) defaultedWallets.add(lc(agentWallets[a.id]));

  // ---- income: payments to declared payment wallets, netted per (cluster, payer) against what the cluster sent back
  // income whose netting is still being read waits (fails closed): from a payer not yet read back, or to a cluster
  // holding a wallet not yet read
  const waitPayers = new Set((pending.payers || []).map(lc));
  const waitClusters = new Set((pending.wallets || []).map((w) => K.clusterOfWallet(w)));
  const pay = income
    .map((p) => ({ payer: lc(p.payer), payTo: lc(p.payTo), amount: Number(p.amount), at: Number(p.at) }))
    .filter((p) => K.declaredBy.has(p.payTo) && Number.isFinite(p.amount) && p.amount > 0 && Number.isFinite(p.at)
      && !waitPayers.has(p.payer) && !waitClusters.has(K.clusterOfWallet(p.payTo)));
  const inBy = new Map(), backBy = new Map();
  const pairKey = (c, payer) => c + "|" + payer;
  for (const p of pay) {
    const k = pairKey(K.clusterOfWallet(p.payTo), p.payer);
    inBy.set(k, (inBy.get(k) || 0) + p.amount);
  }
  for (const x of transfers) {
    const amount = Number(x.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const k = pairKey(K.clusterOfWallet(x.from), lc(x.to));
    if (inBy.has(k)) backBy.set(k, (backBy.get(k) || 0) + amount);
  }
  const netRatio = (k) => { const i = inBy.get(k) || 0; return i > 0 ? Math.max(0, i - (backBy.get(k) || 0)) / i : 0; };
  // per agent: its share of each counted payment
  const incomeOf = new Map();
  for (const p of pay) {
    const agents = K.declaredBy.get(p.payTo);
    const r = netRatio(pairKey(K.clusterOfWallet(p.payTo), p.payer));
    if (r <= 0) continue;
    for (const id of agents) {
      if (K.clusterOfWallet(p.payer) === K.clusterOfAgent(id)) continue; // paying itself: never income
      if (!incomeOf.has(id)) incomeOf.set(id, []);
      incomeOf.get(id).push({ payer: p.payer, amount: (p.amount * r) / agents.length, at: p.at });
    }
  }
  const capPerPayer = weights.components.income.perPayerCapUsdg * USDG;

  return snapshot.agents.map((a) => {
    const id = Number(a.id);
    const mine = K.clusterOfAgent(id);
    const raw = loansBy.get(a.id) || [];
    const since = ownershipChangedAt(a, raw, t, ownerSince?.[id]);
    const inc = (incomeOf.get(id) || []).sort((x, y) => x.at - y.at || (x.payer < y.payer ? -1 : x.payer > y.payer ? 1 : 0) || x.amount - y.amount);

    const loans = raw.map((l) => {
      const backer = l.era === "v1" ? v1Backer.get(Number(l.id)) : l.sponsorId;
      const borrowerCluster = K.clusterOfAgent(id, l.owner);
      return { principal: l.principal, issuedAt: l.issuedAt, dueAt: l.dueAt, closedAt: l.closedAt, status: l.status,
        backedByOthers: backer != null && backerCounts(backer, l.issuedAt, borrowerCluster), incomeShare: 0 };
    });

    // loans repaid from income: only loans that count (v2, backed by someone else, repaid on time by the agent's own
    // wallets, since its last change of hands), funded by counted income that arrived during the loan, oldest first.
    // Income is weighted by its payer's record like the income component, capped per payer and loan, spent once.
    const own = new Set(K.walletsOf.get(id) || []);
    const left = inc.map((p) => p.amount * payerWeight(p.payer in payerScores ? payerScores[p.payer] : null, weights));
    const order = raw.map((_, i) => i).filter((i) => {
      const l = raw[i];
      return l.era !== "v1" && l.status === "repaid" && loans[i].backedByOthers && Number(l.closedAt) <= Number(l.dueAt)
        && Number(l.issuedAt) >= since && repaidByOwn(own, repayers[l.id]);
    }).sort((x, y) => Number(raw[x].closedAt) - Number(raw[y].closedAt) || Number(raw[x].id) - Number(raw[y].id));
    for (const i of order) {
      const l = raw[i];
      const due = Number(l.principal) + Number(l.fee || 0);
      let need = due;
      const fromPayer = new Map();
      for (let j = 0; j < inc.length && need > 0; j++) {
        if (inc[j].at < Number(l.issuedAt) || inc[j].at > Number(l.closedAt) || left[j] <= 0) continue;
        const room = capPerPayer - (fromPayer.get(inc[j].payer) || 0);
        if (room <= 0) continue;
        const take = Math.min(left[j], need, room);
        left[j] -= take; need -= take;
        fromPayer.set(inc[j].payer, (fromPayer.get(inc[j].payer) || 0) + take);
      }
      if (due > 0 && need < due) loans[i].incomeShare = Math.min(1, (due - need) / due);
    }
    const first = raw.reduce((m, l) => Math.min(m, Number(l.issuedAt) || Infinity), Infinity);

    // backing by others now: delegation from a sponsor in another cluster, held to the same backer rule
    const backingByOthers = backerCounts(a.sponsor, t, mine) ? Number(a.delegatedIn || 0) : 0;
    const aw = agentWallets[id];

    return {
      agentId: a.id, now: t, defaulted: !!a.defaulted,
      ownerDefaulted: !a.defaulted && (defaultedWallets.has(lc(a.owner)) || (isAddr(aw) && defaultedWallets.has(lc(aw)))),
      recordStart: Number.isFinite(first) ? first : null,
      ownershipChangedAt: since,
      childrenDefaulted: a.childrenDefaulted || 0, recourseHonored: a.recourseHonored || 0,
      backingByOthers, loans,
      income: inc.map((p) => ({ payer: p.payer, amount: p.amount, at: p.at, payerScore: payerScores[p.payer] })),
    };
  });
}

/** Scores for every agent; income payers that are themselves scored agents get their weight from a first pass. */
export function scoreAll(snapshot, opts = {}) {
  const first = buildInputs(snapshot, opts).map((i) => scoreV2(i, opts.weights));
  const byId = new Map(snapshot.agents.map((a) => [Number(a.id), a]));
  const payerScores = {};
  for (const s of first) {
    const a = byId.get(Number(s.agentId));
    if (!a) continue;
    // a wallet pays with the best record among the agents it belongs to (as owner or declared payment wallet)
    for (const w of [a.owner, (opts.agentWallets || {})[a.id]]) {
      if (!isAddr(w)) continue;
      payerScores[lc(w)] = Math.max(payerScores[lc(w)] ?? 0, s.score);
    }
  }
  return buildInputs(snapshot, { ...opts, payerScores }).map((i) => scoreV2(i, opts.weights));
}
