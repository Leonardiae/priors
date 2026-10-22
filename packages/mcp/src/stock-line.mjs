// A stock line sized from the line it needs (docs/research/2026-10-12-scale-rwa/PLAN.md W1-W2): how much of a token to
// deposit for a line of L USDG, what that line costs in cents, and the default rule in words. Pure: no chain, no
// network; every figure in the units the contracts use (USDG 6 decimals, the token's own, the feed's own).
// One file for every place that says it:
//   - the hosted MCP's stock_line_request (mcp-worker/tools.mjs);
//   - the local MCP's (packages/mcp/src/stock-line.mjs, a copy that scripts/test-packages.mjs checks is identical);
//   - Go mode's deposit sheet (web-src/priors-app.mjs: PriorsApp.stockLine).
// The vault (src/StockVault.sol open, _valueOf) values `amount` tokens at floor(amount × price ÷ 10^(token + feed − 6))
// and opens a line of floor(value × ltv ÷ 10,000), at most maxLine; the quote it runs at Deposit is the last word.

/** The deposit is the line's need × 1.3: the borrow room stays whole through a 23% fall (1 − 1 ÷ 1.3). */
export const HEADROOM_BPS = 13_000n;
/** The two costs a sheet shows: a day and a week. */
export const COST_DAYS = [1, 7];

const big = (x) => (typeof x === "bigint" ? x : BigInt(x));
const ceilDiv = (a, b) => (a + b - 1n) / b;

/** The smallest amount of the token the vault values at `usdg` (6 decimals) or more at `price`. */
export function tokensFor(usdg, price, tokenDecimals, feedDecimals) {
  usdg = big(usdg); price = big(price);
  if (price <= 0n) throw new RangeError("tokensFor: a price above zero");
  const scale = Number(tokenDecimals) + Number(feedDecimals);
  return scale >= 6 ? ceilDiv(usdg * 10n ** BigInt(scale - 6), price) : ceilDiv(usdg, price * 10n ** BigInt(6 - scale));
}

/** What the vault values `amount` of the token at (USDG, 6 decimals): its own rounding, down. */
export function valueOf(amount, price, tokenDecimals, feedDecimals) {
  const scale = Number(tokenDecimals) + Number(feedDecimals);
  return scale >= 6 ? (big(amount) * big(price)) / 10n ** BigInt(scale - 6) : big(amount) * big(price) * 10n ** BigInt(6 - scale);
}

/**
 * The deposit for a line of `line` USDG on a token at `price` and `ltvBps` (the token's own, or the agent's with its
 * record bonus): { line (capped at maxLine), needed (the least that opens it), deposit (needed's value × 1.3),
 * capped, keep (the balance left after the deposit, when `balance` is given), short (the balance is under `needed`),
 * tooSmall (under minLoan) }. `deposit` is never above the balance when one is given and covers `needed`; under
 * `needed` the deposit is the whole balance and `short` says the line will be smaller.
 */
export function sizeStockLine({ line, price, tokenDecimals, feedDecimals, ltvBps, maxLine = null, minLoan = null, balance = null }) {
  let want = big(line);
  const ltv = big(ltvBps);
  if (want <= 0n) throw new RangeError("sizeStockLine: a line above zero");
  if (ltv <= 0n || ltv > 10_000n) throw new RangeError("sizeStockLine: an LTV between 1 and 10,000 bps");
  const capped = maxLine != null && want > big(maxLine);
  if (capped) want = big(maxLine);
  const neededValue = ceilDiv(want * 10_000n, ltv);
  const needed = tokensFor(neededValue, price, tokenDecimals, feedDecimals);
  let deposit = tokensFor(ceilDiv(neededValue * HEADROOM_BPS, 10_000n), price, tokenDecimals, feedDecimals);
  let keep = null, short = false;
  if (balance != null) {
    const bal = big(balance);
    short = bal < needed;
    if (deposit > bal) deposit = bal;
    keep = bal - deposit;
  }
  const opens = (valueOf(deposit, price, tokenDecimals, feedDecimals) * ltv) / 10_000n;
  const lineOpened = maxLine != null && opens > big(maxLine) ? big(maxLine) : opens;
  return { line: want, needed, deposit, capped, keep, short, lineOpened, tooSmall: minLoan != null && lineOpened < big(minLoan) };
}

/** The pool's fee on `line` USDG held `days` days: line × feeBps × days ÷ (30 × 10,000), rounded up (USDG units). */
export function lineFee(line, feeBps, days) {
  return ceilDiv(big(line) * big(feeBps) * BigInt(days), 30n * 10_000n);
}

/** USDG units in dollars and cents: the nearest cent, half up; "$0.01" for anything above zero that rounds to 0. */
export function cents(units) {
  units = big(units);
  let c = (units + 5_000n) / 10_000n;
  if (c === 0n && units > 0n) c = 1n;
  return `$${(c / 100n).toLocaleString("en-US")}.${String(c % 100n).padStart(2, "0")}`;
}

/** The line's cost for each of COST_DAYS: [{ days, fee (USDG units), text ("$0.03") }]. */
export const lineCosts = (line, feeBps, days = COST_DAYS) => days.map((d) => { const fee = lineFee(line, feeBps, d); return { days: d, fee, text: cents(fee) }; });

/** The vault's default rule, from its buffer (bps) for the token: null when the vault has no buffer (an implementation
 *  from before the fair default, whose default keeps the whole deposit). */
export function defaultRule(bufferBps, graceDays = 3) {
  if (bufferBps == null) return { kind: "all", bufferBps: null, text: `If a loan is still unpaid ${graceDays} days after it was due, the vault keeps the whole deposit. A falling price never sells it.` };
  const pct = Number(big(bufferBps)) / 100;
  return { kind: "fair", bufferBps: big(bufferBps), text: `If a loan is still unpaid ${graceDays} days after it was due, the vault keeps tokens worth what is owed plus ${pct}% and gives the rest back (it keeps them all if the stock's price can't be used that day). A falling price never sells it.` };
}

// ---- stock_line_request: an agent asks its owner for a stock line (both MCP servers) ----

/** Token units rounded up at `max` decimal places (of a `decimals`-decimal token): the figure a sheet fills. */
export function upAt(units, decimals, max = 6) {
  const d = Number(decimals), cut = d > max ? 10n ** BigInt(d - max) : 1n;
  return ((big(units) + cut - 1n) / cut) * cut;
}
/** Token units as a decimal string, rounded up at `max` places: what the link fills is never short of the figure said. */
export function tokenText(units, decimals, max = 6) {
  const d = Number(decimals), up = upAt(units, d, max), base = 10n ** BigInt(d);
  const frac = (up % base).toString().padStart(d, "0").slice(0, Math.min(d, max)).replace(/0+$/, "");
  return `${up / base}${frac ? "." + frac : ""}`;
}
const usd = (units) => { const u = big(units), w = u / 1_000_000n, f = (u % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, ""); return `${w}${f ? "." + f.slice(0, 6) : ""}`; };
const oneLine = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** Go mode's link for the request: the stock tab's deposit sheet on that token, for that agent, sized to that line
 *  (web/account-stocks.js reads ai=stock once). It carries nothing to sign: the owner's own Deposit click does it all. */
export function stockLink(appUrl, { agentId = null, symbol, line }) {
  const u = new URL(appUrl);
  u.searchParams.set("ai", "stock");
  if (agentId != null) u.searchParams.set("ai_agent", String(agentId));
  u.searchParams.set("ai_token", symbol);
  u.searchParams.set("ai_usd", usd(line));
  u.hash = "ac-stocks";
  return u.href;
}

/** PT-USDG, Pendle's principal token for USDG, by the ticker an agent would pass ("PT-USDG", "PTUSDG", "pt_usdg"). The
 *  vault takes it on its own terms, not as one of the stock tokens: its owner deposits it in Go mode. */
export const isPtSymbol = (symbol) => /^PT[-_ ]?USDG$/i.test(oneLine(symbol, 12));

/** Go mode's link to PT-USDG: `#ac-pt` opens the place that holds everything PT-USDG (buy, sell, redeem, and deposit
 *  it behind an agent's line), whichever tab carries it in the build the site serves. */
export function ptLink(appUrl) {
  const u = new URL(appUrl);
  u.hash = "ac-pt";
  return u.href;
}

/** stock_line_request asked for PT-USDG: not refused as an unknown token, but pointed at Go mode, where the agent's
 *  owner deposits it (true whether or not the vault holds new PT-USDG lines at that moment: Go mode reads it live). */
export function ptLineText(appUrl, agentId = null) {
  return `PT-USDG lines are not requested with this tool. The agent's owner deposits PT-USDG behind ${agentId != null ? `agent #${agentId}'s` : "the agent's"} line in Go mode, where they also buy, sell and redeem it, and Go mode says whether the stock vault takes a new PT-USDG line right now: ${ptLink(appUrl)}`;
}

/**
 * The answer to stock_line_request, the same in both MCP servers: { refusal } when the line can't open now (and why,
 * in words), else { data, text }. Inputs, read by each server its own way:
 *   asset { symbol, name, token, answer, decimals, feedDecimals, ltvBps, usable, hold, holdReason, lineCap, openLines,
 *           seizeBufferBps } (null: not a token the vault takes; ltvBps the token's own, ltvOf(0, token)); vault {
 *   maxLine, epochRoom, root }; pool { feeBps, minLoan, graceDays }; agent { id, defaulted, ownerDefaulted (a default
 *   marked on its owner's account: the pool's ownerDefaults, which StockVault.open refuses for every agent of that
 *   owner), isRoot, sponsor, activeLoans, stockLine, ltvBps } or null (a new agent), where ltvBps is the vault's
 *   ltvOf(id, token), the token's own plus the agent's record bonus: what the vault opens its line at (null when it
 *   could not be read: refused, since the token's own would ask the owner for more than the line needs); lineUsd (a
 *   number of dollars), reason (the agent's own words, kept in this answer only), appUrl, count (the tokens the vault
 *   takes, for the refusal), asOf.
 * The caps (the token's, with its open lines; the week's room) hold the line the deposit opens, not the line asked for:
 * the deposit the link fills (× 1.3, rounded up at 6 places) opens about 1.3 times the ask, at most maxLine. When that
 * is over a cap the request is refused, naming the largest ask whose deposit still fits: the link never fills a
 * deposit the vault would refuse, and never one with less room for a fall than it says.
 */
export function stockLineRequest({ asset, vault, pool, agent = null, lineUsd, reason = "", appUrl, count = null, asOf = null, symbol = "" }) {
  const n = Number(lineUsd);
  if (!(n > 0) || n > 1_000_000) return { refusal: "line_usd must be above 0 and at most 1,000,000." };
  const units = BigInt(Math.round(n * 1e6));
  if (Math.abs(Number(units) / 1e6 - n) > 1e-9) return { refusal: "line_usd has more than 6 decimals (USDG has 6)." };
  if (!asset && isPtSymbol(symbol)) return { refusal: ptLineText(appUrl, agent ? agent.id : null) };
  if (!asset) return { refusal: `${oneLine(symbol, 12) || "That token"} is not among the ${count ?? "listed"} tokens the Priors stock vault takes.` };
  const sym = asset.symbol;
  if (agent) {
    if (agent.defaulted) return { refusal: `Agent #${agent.id} has defaulted: no new line can open for it.` };
    if (agent.ownerDefaulted) return { refusal: `A default on the account that owns agent #${agent.id} stops new lines and loans for all its agents: no new line can open for it.` };
    if (agent.isRoot) return { refusal: `Agent #${agent.id} is a backer (root): backers lend their stake, they do not borrow.` };
    if (agent.stockLine) return { refusal: `Agent #${agent.id} already has a stock line. Its owner can add stock to it in Go mode (Add stock, on its stock line) to raise what it can draw.` };
    if (agent.sponsor && String(agent.sponsor) !== String(vault.root) && Number(agent.activeLoans) > 0) return { refusal: `Agent #${agent.id} has ${agent.activeLoans} loan(s) open on its line from backer #${agent.sponsor}. A stock line takes over the agent's backing (one backer per agent), so those loans are repaid first.` };
  }
  if (!asset.usable || Number(asset.hold || 0) !== 0) return { refusal: `The vault opens no new line on ${sym} right now${asset.holdReason ? `: ${asset.holdReason}` : " (its price is not usable now)"}. stock_assets lists the tokens that take new lines.` };
  if (asset.lineCap != null && big(asset.lineCap) === 0n) return { refusal: `The vault takes no new line on ${sym} (its cap is 0). stock_assets lists the tokens that take new lines.` };
  if (agent && agent.ltvBps == null) return { refusal: `Agent #${agent.id}'s loan-to-value on ${sym} (the token's own plus its record bonus) could not be read from the chain just now, so the deposit cannot be sized: try again in a minute.` };
  const ltvBps = big(agent ? agent.ltvBps : asset.ltvBps), ownBps = big(asset.ltvBps);
  if (ltvBps <= 0n) return { refusal: `The vault takes no new line on ${sym} (its loan-to-value is 0). stock_assets lists the tokens that take new lines.` };
  const sizing = { price: asset.answer, tokenDecimals: asset.decimals, feedDecimals: asset.feedDecimals, ltvBps, maxLine: vault.maxLine ?? null, minLoan: pool.minLoan ?? null };
  const sized = sizeStockLine({ line: units, ...sizing });
  if (pool.minLoan != null && sized.line < big(pool.minLoan)) return { refusal: `A line is at least ${usd(pool.minLoan)} USDG (the pool's smallest loan).` };
  // the line the vault opens for the deposit the link fills (rounded up at 6 places, as said): what every cap holds
  const opens = (line) => {
    const v = (valueOf(upAt(sizeStockLine({ line, ...sizing }).deposit, asset.decimals), asset.answer, asset.decimals, asset.feedDecimals) * ltvBps) / 10_000n;
    return vault.maxLine != null && v > big(vault.maxLine) ? big(vault.maxLine) : v;
  };
  const opened = opens(sized.line);
  const tokenLeft = asset.lineCap != null && asset.openLines != null ? (big(asset.lineCap) > big(asset.openLines) ? big(asset.lineCap) - big(asset.openLines) : 0n) : null;
  const weekLeft = vault.epochRoom != null ? big(vault.epochRoom) : null;
  if ((tokenLeft != null && opened > tokenLeft) || (weekLeft != null && opened > weekLeft)) {
    const room = tokenLeft == null ? weekLeft : weekLeft == null || tokenLeft < weekLeft ? tokenLeft : weekLeft;
    // the largest ask whose deposit opens within the room (opens() never falls as the ask grows), to the cent below
    let lo = 0n, hi = sized.line;
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (opens(mid) <= room) lo = mid; else hi = mid - 1n; }
    const fit = lo - (lo % 10_000n);
    const fits = fit > 0n && (pool.minLoan == null || fit >= big(pool.minLoan));
    const deposit = `the deposit for a ${usd(sized.line)} USDG line, with room for a 23% fall, opens ${usd(opened)} USDG`;
    if (tokenLeft != null && opened > tokenLeft) return { refusal: `${sym} lines share a cap of ${usd(asset.lineCap)} USDG and ${usd(tokenLeft)} USDG of it is left, and ${deposit}: ${fits ? `ask for at most ${usd(fit)} USDG, or another token` : "ask for another token"}.` };
    return { refusal: `The vault opens at most ${usd(weekLeft)} USDG of new lines more this week, and ${deposit}: ${fits ? `ask for at most ${usd(fit)} USDG, or later` : "ask later"}.` };
  }
  const costs = lineCosts(sized.line, pool.feeBps);
  // the grace in days as the pool has it, never rounded up (a 36 h grace is 1.5 days, not 2): down to a tenth
  const rule = defaultRule(asset.seizeBufferBps ?? null, Math.floor(Number(pool.graceDays ?? 3) * 10) / 10);
  const approvalUrl = stockLink(appUrl, { agentId: agent ? agent.id : null, symbol: sym, line: sized.line });
  const price = Number(big(asset.answer)) / 10 ** Number(asset.feedDecimals);
  const why = oneLine(reason, 200);
  const moves = agent && agent.sponsor && String(agent.sponsor) !== String(vault.root);
  const data = {
    kind: "stock_line_request", agentId: agent ? agent.id : null, symbol: sym, token: asset.token, lineUsd: usd(sized.line), capped: sized.capped,
    price: price.toFixed(2), ltvBps: Number(ltvBps), neededTokens: tokenText(sized.needed, asset.decimals), depositTokens: tokenText(sized.deposit, asset.decimals),
    lineOpenedUsd: usd(opened), costs: costs.map((c) => ({ days: c.days, usd: c.text.slice(1) })), feeBps: Number(pool.feeBps),
    defaultRule: { kind: rule.kind, bufferBps: rule.bufferBps == null ? null : Number(rule.bufferBps) }, approvalUrl, reason: why || null, asOf,
  };
  const who = agent ? `Agent #${agent.id}` : "A new agent";
  const text = [
    `${who} asks its owner for a ${data.lineUsd} USDG line backed by ${sym}${sized.capped ? ` (lines are capped at ${usd(vault.maxLine)} USDG)` : ""}${why ? `. The agent's reason: "${why}"` : ""}.`,
    `At $${data.price} and ${data.ltvBps / 100}% of its value${ltvBps > ownBps ? ` (${sym}'s own ${Number(ownBps) / 100}%, plus ${Number(ltvBps - ownBps) / 100}% for agent #${agent.id}'s record)` : ""}, the line needs at least ${data.neededTokens} ${sym}. The link fills ${data.depositTokens} ${sym} (1.3 times that), so what the agent can draw holds through a 23% fall; the owner keeps the rest of their ${sym}.`,
    `Cost: borrowing the whole ${data.lineUsd} USDG costs about ${costs.map((c) => `${c.text} for ${c.days === 1 ? "a day" : c.days === 7 ? "a week" : `${c.days} days`}`).join(" or ")} (${data.feeBps / 100}% per 30 days), plus any backer premium.`,
    `${rule.text} A default also stops new lines for every agent of that owner.${moves ? ` The agent's current line from backer #${agent.sponsor} moves to the stock vault when this one opens.` : ""}`,
    `Nothing moves until the owner deposits, signed in to Go mode, where the vault's own quote is shown first: ${approvalUrl}`,
  ].join("\n");
  return { data, text };
}
