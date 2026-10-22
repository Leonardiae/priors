// The Priors stock vault (src/StockVault.sol) for the SDK and the tools: the accepted stock tokens
// with their live prices and lending holds, and a stock line's collateral (the tokens behind it, what they are worth to
// the vault, and what the line can still draw). ethers v6; reads only here, the writes are PriorsV2 methods
// (sdk/priors-v2.mjs: openStockLine, addCollateral, closeStockLine).
//
// A stock line's `available` is the smaller of the pool's figure (delegatedIn - principalOut, what the on-chain lens
// reports) and the vault's `borrowRoom`: the vault refuses a draw beyond its loan-to-value, and during a lending hold
// (a price jump, a multiplier change, a paused or blocked token) it refuses every new draw.
import { ethers } from "ethers";
import STOCKS from "../deployments/stock-assets.4663.json" with { type: "json" };

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"; // the canonical Multicall3, deployed on chain 4663

const POSITION_T = "tuple(address depositor, address owner, address token, uint64 openedAt, bool closing, uint8 status, uint128 line, uint256 amount)";
const CONSENT_T = "tuple(uint256 agentId,uint256 sponsorId,address owner,uint256 maxPremiumBps,uint256 nonce,uint256 deadline)";

export const STOCK_VAULT_ABI = [
  "function agentId() view returns (uint256)",
  "function params() view returns (uint256 ltvBps, uint256 maxLine, uint256 epochCap, uint64 epochLength)",
  "function assetList() view returns (address[])",
  "function assets(address token) view returns (address feed)", // the Asset struct's first field
  "function valueOf(address token, uint256 amount) view returns (bool ok, uint256 value)",
  "function lendStatus(address token) view returns (uint8)",
  "function ltvOf(uint256 id, address token) view returns (uint256)",
  "function recordBonusBps(uint256 id) view returns (uint256)",
  "function openLinesOf(address token) view returns (uint256)",
  "function borrowRoom(uint256 id) view returns (uint256)",
  "function held(address token) view returns (uint256)",
  "function epochRoom() view returns (uint256)",
  `function getPosition(uint256 id) view returns (${POSITION_T})`,
  `function open(uint256 id, address token, uint256 amount, ${CONSENT_T} c, bytes sig) returns (uint256)`,
  "function addCollateral(uint256 id, uint256 amount)",
  "function close(uint256 id)",
  "function reclaim(uint256 id)",
  "error Reentrancy()", "error NotAdopted()", "error AlreadyAdopted()", "error NotOurs(uint256 agentId)", "error VaultPaused()",
  "error ZeroAmount()", "error NotController(uint256 agentId, address caller)", "error NotEligible(uint256 agentId)",
  "error PositionOpen(uint256 agentId)", "error NoPosition(uint256 agentId)", "error AssetNotAccepted(address token)",
  "error PriceUnavailable(address token)", "error LineTooSmall(uint256 line, uint256 minLoan)",
  "error EpochCapReached(uint256 wanted, uint256 left)", "error BadTransfer(uint256 expected, uint256 received)",
  "error NotDepositorOrController(uint256 agentId, address caller)", "error AgentDefaulted(uint256 agentId)",
  "error StillBacked(uint256 agentId)", "error InvalidParams()", "error Protected(address token)",
  "error NotDepositor(uint256 agentId, address caller)", "error NoFeeRoom(uint256 needed, uint256 free)",
  "error NotIdle(uint256 agentId)", "error LendingHeld(address token, uint8 reason)", "error LoanOpen(uint256 agentId)",
  "error NotSent(uint256 agentId)", "error TokensOwed(uint256 agentId)", "error TokenCapReached(address token, uint256 wanted, uint256 left)", "error Shortfall(address token)",
];
const FEED_ABI = ["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"];
const MULTICALL_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"];

/** StockVault.lendStatus reasons (0: no hold). */
export const HOLD_REASONS = ["", "the price moved sharply", "a multiplier change", "the token is paused", "the token blocks the vault"];
/** StockVault.Status. */
export const POSITION_STATUS = ["none", "open", "closed", "seized", "written off"];
/** The accepted stock tokens (deployments/stock-assets.4663.json). */
export const STOCK_ASSETS = Object.freeze(STOCKS.assets.map((a) => Object.freeze({ ...a })));

const lc = (a) => String(a || "").toLowerCase();
const vaultIface = new ethers.Interface(STOCK_VAULT_ABI);
// the Asset struct whole (lineCap, the token's cap on open lines), and the fair default's buffer: an implementation from
// before the fair default has no seizeBufferOf, so that read fails and the default keeps the whole deposit (null)
const assetIface = new ethers.Interface(["function assets(address token) view returns (address feed, uint64 maxAge, uint8 tokenDecimals, uint8 feedDecimals, bool enabled, uint16 ltvBps, uint128 lineCap)"]);
const bufferIface = new ethers.Interface(["function seizeBufferOf(address token) view returns (uint256)"]);
const feedIface = new ethers.Interface(FEED_ABI);
const BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
const balanceIface = new ethers.Interface(BALANCE_ABI);

/**
 * What the vault would pay a position of `amount` now (the vault's `_payout`): all of it while the vault holds what it
 * owes of the token (`held`), else its share, amount x balance / held, after an issuer burn from the vault.
 */
export function payoutOf(amount, held, balance) {
  const a = BigInt(amount), h = BigInt(held), b = BigInt(balance);
  return h === 0n || b >= h ? a : (a * b) / h;
}

/** The payout of position `p` (`{ token, amount }`) read from the chain, or `p.amount` when it cannot be read. */
async function payoutRead(vault, p) {
  try {
    const at = vault.target ?? (await vault.getAddress());
    const [held, balance] = await Promise.all([vault.held(p.token), new ethers.Contract(p.token, BALANCE_ABI, vault.runner).balanceOf(at)]);
    return payoutOf(p.amount, held, balance);
  } catch (_) { return BigInt(p.amount); }
}

/** The stock vault as a contract on `runner`; a string address or a Contract. */
export const stockVaultContract = (vault, runner) => (typeof vault === "string" ? new ethers.Contract(vault, STOCK_VAULT_ABI, runner) : vault);

/** The vault's own `valueOf`: on an ethers Contract, `vault.valueOf` is Object.prototype.valueOf, not the function. */
export const vaultValueOf = (vault, token, amount) => (typeof vault.getFunction === "function" ? vault.getFunction("valueOf")(token, amount) : vault.valueOf(token, amount));

/**
 * Many view calls in one Multicall3 `aggregate3` per `batch` (one eth_call each): `calls` are
 * [{ target, iface, fn, args }]; returns [{ ok, value }] in order (`value`: the decoded result, a single output
 * unwrapped). Without Multicall3 (`multicall: null`) the calls are made one by one.
 */
export async function readMany(provider, calls, { multicall = MULTICALL3, batch = 150, blockTag } = {}) {
  const decode = (c, data) => { const r = c.iface.decodeFunctionResult(c.fn, data); return r.length === 1 ? r[0] : r; };
  if (!multicall) {
    return Promise.all(calls.map(async (c) => {
      try { return { ok: true, value: decode(c, await provider.call({ to: c.target, data: c.iface.encodeFunctionData(c.fn, c.args || []), blockTag })) }; } catch (_) { return { ok: false, value: null }; }
    }));
  }
  const mc = new ethers.Contract(multicall, MULTICALL_ABI, provider);
  const out = [];
  for (let i = 0; i < calls.length; i += batch) {
    const part = calls.slice(i, i + batch);
    const res = await mc.aggregate3.staticCall(part.map((c) => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args || []) })), blockTag ? { blockTag } : {});
    res.forEach((r, j) => {
      if (!r.success || r.returnData === "0x") { out.push({ ok: false, value: null }); return; }
      try { out.push({ ok: true, value: decode(part[j], r.returnData) }); } catch (_) { out.push({ ok: false, value: null }); }
    });
  }
  return out;
}

/** The vault's loan-to-value for `token`, in basis points, for agent `agentId`: the stock's own plus the agent's
 *  record bonus (the vault's `ltvOf(id, token)`; id 0, the default, gives the stock's own), else the vault-wide
 *  `params().ltvBps` when the vault cannot say. */
export async function ltvOf(vault, token, agentId = 0n) {
  try { return BigInt(await vault.ltvOf(BigInt(agentId), token)); } catch (_) { return BigInt((await vault.params()).ltvBps); }
}

/** The eth_call of the vault's ltvOf(agentId, token), for a reader that speaks JSON-RPC itself (the hosted MCP server,
 *  through sdk/pt-usdg.mjs rpc): { to, data }; ltvOfResult decodes its answer (bps, a bigint). No fallback here: a
 *  failed read is the caller's to handle, never the vault-wide default. */
export const ltvOfCall = (vault, agentId, token) => ({ to: vault, data: vaultIface.encodeFunctionData("ltvOf", [BigInt(agentId), token]) });
export const ltvOfResult = (data) => BigInt(vaultIface.decodeFunctionResult("ltvOf", data)[0]);

/**
 * Agent `agentId`'s stock position, or null when it has none. Amounts are bigints: `amount` in the token's own units,
 * `value`, `line` and `borrowRoom` in USDG base units (6 decimals). `value` is null while the vault will not price the
 * token for new credit (a stale price, a paused oracle or a lending hold: `hold`). After an issuer burn from the vault
 * the position carries `payout`, what the vault would pay it now (less than `amount`), and `value` prices that.
 */
export async function stockPosition(vault, agentId, { assets = STOCK_ASSETS } = {}) {
  const p = await vault.getPosition(BigInt(agentId));
  const status = Number(p.status);
  if (status === 0) return null;
  const token = ethers.getAddress(p.token);
  const asset = assets.find((a) => lc(a.token) === lc(token)) || null;
  const payout = await payoutRead(vault, { token, amount: p.amount });
  const [[ok, value], borrowRoom, hold, ltvBps] = await Promise.all([
    vaultValueOf(vault, token, payout), vault.borrowRoom(BigInt(agentId)), vault.lendStatus(token).then(Number).catch(() => 0), ltvOf(vault, token, agentId),
  ]);
  return {
    agentId: BigInt(agentId), depositor: p.depositor, owner: p.owner, token, symbol: asset ? asset.symbol : null,
    decimals: asset ? asset.decimals : null, amount: p.amount, ...(payout < BigInt(p.amount) ? { payout } : {}), value: ok ? value : null, ltvBps,
    line: BigInt(p.line), borrowRoom: BigInt(borrowRoom), hold, holdReason: HOLD_REASONS[hold] || (hold ? `hold ${hold}` : ""),
    status, statusName: POSITION_STATUS[status] || `status ${status}`, closing: p.closing, openedAt: Number(p.openedAt),
  };
}

/** The collateral block of a credit report (creditStatus, /v1/report, the MCP): what backs a stock line. */
export function collateralOf(pos) {
  if (!pos) return null;
  return { token: pos.token, symbol: pos.symbol, decimals: pos.decimals, amount: pos.amount, ...(pos.payout !== undefined ? { payout: pos.payout } : {}), value: pos.value, ltvBps: pos.ltvBps, borrowRoom: pos.borrowRoom, hold: pos.hold, holdReason: pos.holdReason, status: pos.statusName, closing: pos.closing };
}

/** What a line can draw: the pool's `available`, capped by the stock vault's `borrowRoom` for a stock line. */
export const borrowable = (available, collateral) => {
  const a = BigInt(available);
  if (!collateral || collateral.borrowRoom === undefined || collateral.borrowRoom === null) return a;
  const r = BigInt(collateral.borrowRoom);
  return r < a ? r : a;
};

/**
 * Every accepted token with its live price, whether the vault would lend against it now, why not (`hold`), and its
 * loan-to-value: [{ symbol, name, token, decimals, feed, feedDecimals, answer, price, updatedAt, usable, hold,
 * holdReason, ltvBps, openLines }]. One Multicall3 round (`multicall: null` reads one by one). `answer` is the feed's
 * raw answer (bigint), `price` the same in dollars (a number).
 */
export async function stockAssets(provider, vaultAddress, { assets = STOCK_ASSETS, multicall = MULTICALL3, blockTag } = {}) {
  const v = ethers.getAddress(vaultAddress);
  const vc = new ethers.Contract(v, STOCK_VAULT_ABI, provider);
  const defaultLtv = BigInt((await vc.params(blockTag ? { blockTag } : {})).ltvBps);
  const calls = [];
  for (const a of assets) {
    calls.push({ target: a.feed, iface: feedIface, fn: "latestRoundData" });
    calls.push({ target: v, iface: vaultIface, fn: "valueOf", args: [a.token, 10n ** BigInt(a.decimals)] });
    calls.push({ target: v, iface: vaultIface, fn: "lendStatus", args: [a.token] });
    calls.push({ target: v, iface: vaultIface, fn: "ltvOf", args: [0n, a.token] }); // the stock's own
    calls.push({ target: v, iface: vaultIface, fn: "openLinesOf", args: [a.token] });
    calls.push({ target: v, iface: assetIface, fn: "assets", args: [a.token] });
    calls.push({ target: v, iface: bufferIface, fn: "seizeBufferOf", args: [a.token] });
  }
  const r = await readMany(provider, calls, { multicall, blockTag });
  return assets.map((a, i) => {
    const [feed, val, hold, ltv, lines, asset, buffer] = r.slice(i * 7, i * 7 + 7);
    const answer = feed.ok ? BigInt(feed.value.answer) : null;
    const h = hold.ok ? Number(hold.value) : null;
    return {
      symbol: a.symbol, name: a.name, token: a.token, decimals: a.decimals, feed: a.feed, feedDecimals: a.feedDecimals,
      answer, price: answer === null ? null : Number(answer) / 10 ** a.feedDecimals, updatedAt: feed.ok ? Number(feed.value.updatedAt) : null,
      usable: !!(val.ok && val.value[0]), hold: h, holdReason: h ? HOLD_REASONS[h] || `hold ${h}` : "",
      ltvBps: ltv.ok ? BigInt(ltv.value) : defaultLtv, openLines: lines.ok ? BigInt(lines.value) : null,
      lineCap: asset.ok ? BigInt(asset.value.lineCap) : null, seizeBufferBps: buffer.ok ? BigInt(buffer.value) : null,
    };
  });
}

/**
 * Stock positions of `agentIds` in one Multicall3 round (for many agents at once; `stockPosition` is the one-agent
 * form): { [agentId]: position | null }, positions as stockPosition returns them.
 */
export async function stockPositions(provider, vaultAddress, agentIds, { assets = STOCK_ASSETS, multicall = MULTICALL3, blockTag, defaultLtv } = {}) {
  const v = ethers.getAddress(vaultAddress);
  const ids = [...new Set(agentIds.map((x) => BigInt(x)))];
  const first = await readMany(provider, ids.flatMap((id) => [
    { target: v, iface: vaultIface, fn: "getPosition", args: [id] },
    { target: v, iface: vaultIface, fn: "borrowRoom", args: [id] },
  ]), { multicall, blockTag });
  const open = [];
  ids.forEach((id, i) => { const p = first[i * 2]; if (p.ok && Number(p.value.status) !== 0) open.push({ id, p: p.value, room: first[i * 2 + 1] }); });
  const ltvDefault = defaultLtv ?? BigInt((await new ethers.Contract(v, STOCK_VAULT_ABI, provider).params(blockTag ? { blockTag } : {})).ltvBps);
  const second = await readMany(provider, open.flatMap(({ id, p }) => [
    { target: v, iface: vaultIface, fn: "valueOf", args: [p.token, p.amount] },
    { target: v, iface: vaultIface, fn: "lendStatus", args: [p.token] },
    { target: v, iface: vaultIface, fn: "ltvOf", args: [id, p.token] }, // with the agent's record bonus
    { target: v, iface: vaultIface, fn: "held", args: [p.token] },
    { target: p.token, iface: balanceIface, fn: "balanceOf", args: [v] },
  ]), { multicall, blockTag });
  // after an issuer burn from the vault a position is paid its share: price that (one more round, only then)
  const payouts = open.map(({ p }, i) => {
    const [, , , held, bal] = second.slice(i * 5, i * 5 + 5);
    return held.ok && bal.ok ? payoutOf(p.amount, held.value, bal.value) : BigInt(p.amount);
  });
  const shortIdx = open.map((_, i) => i).filter((i) => payouts[i] < BigInt(open[i].p.amount));
  const repriced = shortIdx.length ? await readMany(provider, shortIdx.map((i) => ({ target: v, iface: vaultIface, fn: "valueOf", args: [open[i].p.token, payouts[i]] })), { multicall, blockTag }) : [];
  const out = Object.fromEntries(ids.map((id) => [String(id), null]));
  open.forEach(({ id, p, room }, i) => {
    const [first, hold, ltv] = second.slice(i * 5, i * 5 + 3);
    const k = shortIdx.indexOf(i);
    const val = k < 0 ? first : repriced[k];
    const token = ethers.getAddress(p.token);
    const asset = assets.find((a) => lc(a.token) === lc(token)) || null;
    const status = Number(p.status), h = hold.ok ? Number(hold.value) : 0;
    out[String(id)] = {
      agentId: id, depositor: p.depositor, owner: p.owner, token, symbol: asset ? asset.symbol : null, decimals: asset ? asset.decimals : null,
      amount: p.amount, ...(k < 0 ? {} : { payout: payouts[i] }), value: val.ok && val.value[0] ? val.value[1] : null, ltvBps: ltv.ok ? BigInt(ltv.value) : ltvDefault,
      line: BigInt(p.line), borrowRoom: room.ok ? BigInt(room.value) : 0n, hold: h, holdReason: HOLD_REASONS[h] || (h ? `hold ${h}` : ""),
      status, statusName: POSITION_STATUS[status] || `status ${status}`, closing: p.closing, openedAt: Number(p.openedAt),
    };
  });
  return out;
}

/** A bigint-bearing object as JSON-safe numbers and strings: USDG and token amounts as decimal strings of base units. */
export function stockJson(x) {
  return JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}
