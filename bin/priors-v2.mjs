#!/usr/bin/env node
// priors-v2: onboard an agent on Priors v2 (CreditPoolV2, treasury v4, seats v2) and run its line, from a shell.
// The v1 CLI (`priors`, bin/priors.mjs) stays for reading v1 history; the v1 pool is paused.
//
//   priors-v2 join                        register an ERC-8004 identity for this key if it owns none; print its id
//   priors-v2 join --invite <code>        ... then redeem a treasury v4 invite for a first line
//   priors-v2 join --seat <staker>        ... then accept that staker's seat offer on the agent
//   priors-v2 borrow <amount> [--days N]  borrow USDG (default 7 days) to the key's address
//   priors-v2 repay [--all]               repay the oldest open loan, or every open loan
//   priors-v2 status                      identity, sponsor, line, loans, balances, the agent's declared wallet
//   priors-v2 raise                       raise the agent's treasury line to its second line (25 USDG): treasury v5's;
//                                         treasury v4's only while its rules do not hold raises (they hold them today)
//   priors-v2 move                        move the agent from treasury v4's line to treasury v5's, then raise it there
//                                         (treasuryV5 in the v2 addresses): each step it has not done yet (leave,
//                                         InviteBond v1 back, InviteBondV2 bond, move, raise)
//   priors-v2 tx [--resend | --forget]    whether each recorded transaction is final, and whether it ran
//
// The status (`status`, and the one printed after each write) reads the agent's declared payment wallet from the
// ERC-8004 registry (getAgentWallet on the addresses file's registry, a read only): x402 income counts toward Score v2
// only when paid to it (docs/SCORE-v2.md). The live registry declares register()'s caller, so `join` declares this
// key, and a transfer clears it. Its wallet line says whether it is this key, another address, or none; with none, it
// names the fix: `priors-mcp link-wallet --agent <id>` (@priors/mcp 0.11.0) signs the registry's AgentWalletSet with
// this key, and this key, the owner, sends the setAgentWallet call it prints. A read that fails adds nothing: the wallet
// line is then as before, and the exit code is unchanged.
//
// Environment (the key is never read from argv and never printed; .env is loaded like the v1 tools):
//   PRIORS_KEY        the agent owner's private key (PRIVATE_KEY is accepted too)
//   PRIORS_RPC        JSON-RPC endpoint(s), comma-separated failover (else RPC_URL, else Robinhood Chain's official RPC);
//                     from a .env, only the public endpoints .env.example lists, unless PRIORS_ALLOW_CUSTOM_RPC=1 is exported
//   PRIORS_ADDRESSES  path to a v2 addresses JSON (default: deployments/<chainId>.v2.json in this package). With
//                     seatVaultV4, `join --seat` accepts the offer on whichever seat vault it waits, and `status`
//                     reads the seat on the vault that sponsors the agent: the SDK handles both
//   PRIORS_AGENT_ID   which identity to use, when the key owns more than one, or it predates the v2 deploy or was transferred to the key
//   PRIORS_EXPLORER_API  the explorer API `tx` asks, as a pointer only, when the node no longer serves the history it
//                     needs (default https://robinhoodchain.blockscout.com/api, Blockscout's Etherscan-compatible API)
//   PRIORS_WAIT_SECONDS  how long a sent write may take, from its broadcast to its receipt and result (default 180);
//                     past it, exit 4 with its record kept (`tx` settles it later)
//
// Exit codes: 0 done (also when only the status shown after a write that went through could not be read; for `tx`:
// every recorded transaction final, or forgotten); 1 failed: the step that failed did nothing (refused before sending,
// reverted, or cancelled); a revert or cancel that mined stays recorded until `priors-v2 tx` shows it final; 2 usage or
// configuration error (also an untrusted record); 3 waiting: a seat offer that does not exist yet, a recorded
// transaction not final yet (`tx`), `borrow` / `join` / `raise` / `move` refused while one is unresolved, or another
// command of this key running; 4 a transaction was sent and its answer was lost (also a 429, a redirect, a reply that
// is not exactly one JSON-RPC answer to it, no conclusive answer within PRIORS_WAIT_SECONDS (3 minutes), or any other
// failed request: it is never sent twice), or it mined and its result could not be read, or the node answered anything
// but a refusal ("nonce too low", "replacement transaction underpriced", "already known"...) and does not show it
// (each can mean the transaction itself was taken): it may have landed, or may still be pending, so `priors-v2 status`
// alone settles nothing. A refusal ("insufficient funds") is exit 1 only once the node shows no trace of the
// transaction.
// Every write is recorded before it is sent: its hash, nonce, send block and signed bytes, one file per transaction
// (sdk/tx-record.mjs: ~/.local/state/priors/unconfirmed/, only the user can read them), synced to disk, so a command
// killed at any point leaves it behind: first as signed but not sent (before the lock check), then as sending (right
// before its one broadcast, a single request to one endpoint, never retried or redirected). `tx` never resends one that
// was not sent, and drops it once the command that signed it has stopped. A sending record is claimed by rename by
// whoever settles or resends it first (`tx --resend` holds it as `.resending-<pid>-<token>`, still sending to everyone
// else, also after a crash); the other sends nothing and deletes nothing. The record goes once the receipt is read (or
// the node refuses it); otherwise `borrow`, `join`, `raise` and `move` refuse until it is settled (`repay` still runs:
// it cannot pay a loan twice, and a refused repay could miss a due date). `join`, `borrow`, `repay`, `raise`, `move`
// and `tx` hold this key's lock (one at a time per key; a lock left by a killed command is recovered), and each write,
// once recorded, checks right before its broadcast that it still holds it (if not: nothing sent, its record removed,
// exit 3). `priors-v2 tx` (or
// https://robinhoodchain.blockscout.com/tx/<hash>) settles each: mined (it ran: its own receipt, or that of a copy of
// the same call at the same nonce, a speed-up), reverted, or replaced (a different call used its nonce); each is final
// only once its block is finalized and canonical (until then: "waiting for finality"), and a record is removed once
// final. A hash this node does not know, or a mined one whose receipt is not readable yet, is not final: `priors-v2 tx
// --resend` sends the same signed bytes again (same hash and nonce, it cannot make a second one), or a wallet can
// cancel the nonce (a 0-value transfer to itself at that nonce, at a higher fee); then wait for that nonce to be mined.
// When the node no longer serves the history to find which transaction used the nonce, the explorer is asked (each hash
// it names is checked on the RPC); failing that, `priors-v2 tx --forget` drops a record whose nonce is used in
// finalized history, after printing the agent's open loans and the explorer links (whether it ran is then unknown:
// check them); it refuses while the nonce is free. Run the command again only once it is final and did not run. A
// second `repay` of the same loan cannot pay twice (the pool refuses a loan no longer open, so it reverts); a second
// `join` while a register is pending registers a second identity.
import { ethers } from "ethers";
import { fmtUsdg, sendRawOnce, toUnits } from "../sdk/priors-v2.mjs";
import { resolveV2 } from "../sdk/env.mjs";
import { claimSending, intentAbandoned, keyJournal, listUnconfirmed, loadObservation, lockKey, recordDir, releaseResend, removeIntent, saveObservation, saveUnconfirmed, settleRecord, sweepTombs } from "../sdk/tx-record.mjs";
import { BLOCKSCOUT_API, blockscoutLookup } from "../sdk/explorer.mjs";

const USAGE = `usage:
  priors-v2 join [--invite <code> | --seat <staker>] [--uri <agentURI>]
  priors-v2 borrow <amount> [--days N]
  priors-v2 repay [--all]
  priors-v2 status
  priors-v2 raise
  priors-v2 move
  priors-v2 tx [--resend | --forget]
env: PRIORS_KEY [, PRIORS_RPC, PRIORS_ADDRESSES, PRIORS_AGENT_ID, PRIORS_EXPLORER_API, PRIORS_WAIT_SECONDS]
     addresses default to deployments/<chainId>.v2.json; the RPC to Robinhood Chain mainnet`;

class UsageError extends Error {}
class Pending extends Error {}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") flags.all = true;
    else if (a === "--resend") flags.resend = true;
    else if (a === "--forget") flags.forget = true;
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      if (!["invite", "seat", "days", "uri"].includes(k)) throw new UsageError(`unknown option ${a}`);
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { cmd: pos[0], pos: pos.slice(1), flags };
}

// A private key on the command line lands in shell history and `ps`: refuse it outright, glued to other text too
// (PRIORS_KEY=0x…, key:0x…, a URL; GHSA-w247): 64 hex digits not part of a longer run, as @priors/mcp's looksLikeKey.
const looksLikeKey = (s) => /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}($|[^0-9a-fA-F])/.test(String(s));

async function config() {
  const key = process.env.PRIORS_KEY || process.env.PRIVATE_KEY;
  if (!key || key === "0x") throw new UsageError("PRIORS_KEY is not set (the agent owner's private key, from the environment only)");
  // every write is recorded before it is sent, then sent only while this command still holds the key's lock, and its
  // record removed only on a conclusive answer (sendChecked, keyJournal); filed under the key's address, known below
  const keyed = () => keyJournal(keyAddress, () => lock?.held() === true, ran);
  const journal = { before: (t) => keyed().before(t), settled: (hash, how) => keyed().settled(hash, how) };
  let r;
  try {
    r = await resolveV2({ privateKey: key, needSigner: true, journal, waitTimeoutMs: waitTimeoutMs() });
  } catch (e) {
    if (/not a valid|invalid private key|invalid BytesLike/i.test(String(e.message))) throw new UsageError("PRIORS_KEY is not a valid private key");
    throw new UsageError(e.message);
  }
  for (const k of ["pool", "treasuryV4", "seatVault"]) if (!r.addresses[k]) throw new UsageError(`the v2 addresses have no "${k}"`);
  keyAddress = r.signer.address;
  return { sdk: r.priors, wallet: r.signer, addresses: r.addresses };
}

let lock = null; // this key's lock, once holdKey took it

/** PRIORS_WAIT_SECONDS as milliseconds (default 180 s): the bound on a write from its broadcast to its answer. */
function waitTimeoutMs() {
  const v = process.env.PRIORS_WAIT_SECONDS;
  if (v == null || v === "") return 180_000;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError("PRIORS_WAIT_SECONDS must be a positive number of seconds");
  return Math.round(n * 1000);
}

/** This key's lock, held until the process exits (a killed process leaves it behind; the next command recovers it). */
function holdKey(address) {
  try {
    lock = lockKey(address);
  } catch (e) {
    if (e.code === "LOCK_HELD") throw new Pending(e.message);
    if (e.code === "RECORD_UNTRUSTED") throw new UsageError(`the record of unconfirmed transactions is not trusted, so it was not used: ${e.message}`);
    throw e;
  }
  process.on("exit", () => lock.release());
}

/** "growth seat vault (V4)" for the growth vault's address, else "seat vault". */
const vaultKind = (addresses, at) => (at && addresses.seatVaultV4 && at.toLowerCase() === addresses.seatVaultV4.toLowerCase() ? "growth seat vault (V4)" : "seat vault");

const usd = (u) => `${fmtUsdg(u)} USDG`;
const when = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

/**
 * The identity this key acts for: PRIORS_AGENT_ID, else the one the invite names if the key owns it, else the one
 * identity it holds that was minted to it since the v2 deploy and never left it. null if it holds none. Only a mint
 * counts: anyone can transfer an identity with an open loan to this key, and `repay` would then pay that loan (own
 * audit 2026-10-01); one that left and came back carries what its interim holder borrowed (GHSA-mmp8).
 */
async function findAgent(sdk, me, addresses, hint) {
  const reg = await sdk._registry();
  const owns = async (id) => (await reg.ownerOf(id).catch(() => ethers.ZeroAddress)).toLowerCase() === me.toLowerCase();
  const env = process.env.PRIORS_AGENT_ID;
  if (env) {
    if (!/^\d+$/.test(env)) throw new UsageError("PRIORS_AGENT_ID must be a decimal id");
    if (!(await owns(env))) throw new Error(`PRIORS_AGENT_ID #${env} is not owned by ${me}`);
    return Number(env);
  }
  if (hint != null && (await owns(hint))) return Number(hint);
  if ((await reg.balanceOf(me)) === 0n) return null;
  // the registry is not enumerable: find mints to this key in the logs since the v2 deploy, then keep what it still owns
  const T = ethers.id("Transfer(address,address,uint256)");
  const latest = await sdk.provider.getBlockNumber();
  const from = Number(addresses.deployBlock || Math.max(0, latest - 50_000));
  const ids = new Set();
  for (let b = from; b <= latest; b += 50_000) {
    const logs = await sdk.provider.getLogs({ address: await reg.getAddress(), topics: [T, ethers.zeroPadValue(ethers.ZeroAddress, 32), ethers.zeroPadValue(me, 32)], fromBlock: b, toBlock: Math.min(latest, b + 49_999) });
    for (const l of logs) ids.add(BigInt(l.topics[3]));
  }
  // then drop any that left this key since, even if it came back
  if (ids.size) {
    const asked = [...ids].map((id) => ethers.toBeHex(id, 32));
    for (let b = from; b <= latest; b += 50_000) {
      const logs = await sdk.provider.getLogs({ address: await reg.getAddress(), topics: [T, ethers.zeroPadValue(me, 32), null, asked], fromBlock: b, toBlock: Math.min(latest, b + 49_999) });
      for (const l of logs) ids.delete(BigInt(l.topics[3]));
    }
  }
  const mine = [];
  for (const id of ids) if (await owns(id)) mine.push(Number(id));
  if (mine.length === 1) return mine[0];
  if (mine.length > 1) throw new UsageError(`this key owns identities ${mine.map((i) => "#" + i).join(", ")}: set PRIORS_AGENT_ID to pick one`);
  throw new UsageError("this key owns an identity that was not minted to it since the v2 deploy and held ever since (minted earlier, transferred to it, or back after leaving it): set PRIORS_AGENT_ID to the id you mean to use, only one you know is yours");
}

async function needAgent(sdk, me, addresses) {
  const id = await findAgent(sdk, me, addresses);
  if (id == null) throw new UsageError(`${me} owns no agent identity yet: run \`priors-v2 join\` first`);
  return id;
}

/**
 * The payment wallet agent `id` declared in the ERC-8004 registry (getAgentWallet, a read on the registry the addresses
 * file names, the one ownerOf is read on): its address, ZeroAddress when none is declared, or null when it could not be
 * read (a registry without it, or a failed request).
 */
async function declaredWallet(sdk, id) {
  try {
    const reg = new ethers.Contract(await (await sdk._registry()).getAddress(), ["function getAgentWallet(uint256 agentId) view returns (address)"], sdk.provider);
    return ethers.getAddress(await reg.getAgentWallet(id));
  } catch (_) {
    return null;
  }
}

/**
 * The status's wallet line: this key's USDG (the CLI acts only for an agent this key owns, so the owner's USDG is this
 * key's) and, once the registry answered, whether this key is the agent's declared wallet. Not read: as before.
 */
function walletLines(s, declared) {
  const bal = usd(s.ownerUsdg);
  if (declared == null) return [`  wallet    ${bal}`];
  const at = `${bal} at ${keyAddress}`;
  if (declared === keyAddress) return [`  wallet    ${at} (declared: x402 income paid to it counts toward Score v2)`];
  if (declared !== ethers.ZeroAddress) return [`  wallet    ${at} (not the declared wallet, which is ${declared}: x402 income counts toward Score v2 only when paid to that address)`];
  return [
    `  wallet    ${at} (no wallet declared, a transfer clears it: x402 income does not count toward Score v2 until one is)`,
    `            to declare this key: \`npx -y @priors/mcp@0.11.0 link-wallet --agent ${s.agentId}\` (priors-mcp link-wallet) signs with PRIORS_KEY; send the setAgentWallet call it prints from this key, the owner, within 4 minutes`,
  ];
}

async function printStatus(sdk, addresses, id) {
  const s = await sdk.status(id);
  const declared = await declaredWallet(sdk, id); // asked only once the status itself was read
  const kind = s.sponsorKind === "seat vault" ? vaultKind(addresses, s.seatVault) : s.sponsorKind;
  const lines = [
    `agent #${s.agentId}  owner ${s.owner}`,
    `  sponsor   ${s.sponsor ? `#${s.sponsor} (${kind})${s.premiumBps ? `, premium ${s.premiumBps} bps` : ""}` : "none: no line yet"}${s.frozen ? " [frozen]" : ""}${s.defaulted ? " [DEFAULTED]" : ""}`,
    `  line      ${usd(s.line)}  (drawn ${usd(s.principalOut)}, available ${usd(s.available)})`,
    `  record    ${s.loansRepaid} repaid (${s.qualifiedRepaid} qualified), volume ${usd(s.volumeRepaid)}, fees ${usd(s.feesPaid)}`,
  ];
  if (s.seat) lines.push(`  seat      ${s.seat.status}${s.seat.closing ? " (closing)" : ""}, staker ${s.seat.staker}`);
  if (s.openLoans.length === 0) lines.push("  loans     none open");
  for (const l of s.openLoans) lines.push(`  loan #${l.loanId}  ${usd(l.principal)} + fee ${usd(l.fee)} = ${usd(l.due)} due ${when(l.dueAt)}`);
  lines.push(...walletLines(s, declared));
  console.log(lines.join("\n"));
  return s;
}

/** The status after a write that went through: a read that fails then is not a failed command (exit 0), so nothing
 *  invites the write again (GHSA-g5cv-cpwp-756w). */
async function statusAfter(sdk, addresses, id) {
  try {
    await printStatus(sdk, addresses, id);
  } catch (e) {
    console.error(`priors-v2: done; the status after it could not be read (${scrub(e.shortMessage || e.message || e)}): run \`priors-v2 status\``);
  }
}

async function join(flags) {
  if (flags.invite && flags.seat) throw new UsageError("give --invite or --seat, not both");
  const { sdk, wallet, addresses } = await config();
  holdKey(wallet.address);
  refuseWhileUnresolved(wallet.address, "join");
  const me = wallet.address;
  let hint = null;
  if (flags.invite) {
    const m = /^priors-invite:(\d{1,10}):/.exec(String(flags.invite).trim());
    if (!m) throw new UsageError("not an invite code (expected priors-invite:<agentId>:<expiry>:<signature>)");
    hint = Number(m[1]);
  }
  if (flags.seat && !ethers.isAddress(flags.seat)) throw new UsageError("--seat takes the staker's address");

  let id = await findAgent(sdk, me, addresses, hint);
  if (id == null) {
    id = await sdk.register(flags.uri || `priors:agent:${me.toLowerCase()}`);
    console.log(`registered agent #${id} for ${me}`);
  } else {
    console.log(`using agent #${id} owned by ${me}`);
  }

  const a = await sdk.pool.getAgent(id);
  if (flags.invite) {
    if (hint !== id) throw new Error(`this invite is for agent #${hint}, but this key's agent is #${id}: ask for an invite for #${id}`);
    const r = await sdk.redeemInvite(id, flags.invite);
    console.log(`first line opened by treasury v4 (root #${r.sponsorId}), tx ${r.hash}`);
  } else if (flags.seat) {
    if (!(await sdk.seatOffer(id, flags.seat))) {
      await statusAfter(sdk, addresses, id);
      throw new Pending(`no seat offer from ${flags.seat} on agent #${id} yet: ask them to offer on #${id}, then run this again`);
    }
    const r = await sdk.acceptSeat(id, flags.seat);
    console.log(`seat accepted: the ${vaultKind(addresses, r.seatVault)} (root #${r.sponsorId}) backs agent #${id}, tx ${r.hash}`);
  } else if (a.sponsor === 0n) {
    console.log(`no line yet. next: \`priors-v2 join --invite <code>\` with an invite for #${id} (ask at https://priors.trade/invite), or \`priors-v2 join --seat <staker>\` once a staker offers on #${id}`);
  }
  await statusAfter(sdk, addresses, id);
}

async function borrow(pos, flags) {
  if (pos.length !== 1) throw new UsageError("borrow takes one amount, e.g. `priors-v2 borrow 5`");
  const amount = toUnits(pos[0]);
  const days = flags.days == null ? 7 : Number(flags.days);
  if (!Number.isFinite(days) || days <= 0) throw new UsageError("--days must be a positive number");
  const { sdk, wallet, addresses } = await config();
  holdKey(wallet.address);
  refuseWhileUnresolved(wallet.address, "borrow");
  const id = await needAgent(sdk, wallet.address, addresses);
  const term = BigInt(Math.round(days * 86400));
  const q = await sdk.quoteFee(id, amount, term);
  const r = await sdk.borrow(id, amount, term);
  console.log(`borrowed ${usd(r.principal)} as loan #${r.loanId} for agent #${id}: fee ${usd(r.fee)} (quoted ${usd(q.fee)}), due ${when(r.dueAt)}, tx ${r.hash}`);
  await statusAfter(sdk, addresses, id);
}

async function repay(flags) {
  const { sdk, wallet, addresses } = await config();
  holdKey(wallet.address);
  // A repay is not refused while a transaction is unresolved: it cannot pay a loan twice (the pool refuses a loan no
  // longer open), and refusing it could let a loan pass its due date into a default.
  const unresolved = unresolvedOf(wallet.address);
  if (unresolved.length) console.error(`priors-v2: note: ${unresolved.length} unresolved transaction(s) of this key (\`priors-v2 tx\` settles them); repaying anyway: a repay cannot pay a loan twice`);
  const id = await needAgent(sdk, wallet.address, addresses);
  const all = (await sdk.openLoans(id)).sort((x, y) => x.dueAt - y.dueAt || x.loanId - y.loanId);
  if (all.length === 0) { console.log(`agent #${id} has no open loan`); return; }
  // Only loans the agent's owner now took: one opened while someone else held the agent is theirs (the pool marks them
  // if it defaults), and an identity that changed hands can arrive carrying it (GHSA-mmp8).
  const holder = (await (await sdk._registry()).ownerOf(id)).toLowerCase();
  const open = [];
  for (const l of all) {
    const by = (await sdk.pool.getLoan(l.loanId)).owner;
    if (by.toLowerCase() === holder) open.push(l);
    else console.log(`not repaid: loan #${l.loanId} (${usd(l.due)} due ${when(l.dueAt)}) was opened by ${by} while it held agent #${id}, not by its owner now`);
  }
  if (open.length === 0) { console.log(`agent #${id} has no open loan its owner now took: nothing repaid`); return; }
  for (const l of flags.all ? open : open.slice(0, 1)) {
    const r = await sdk.repay(l.loanId, { agentId: id }); // the pool refuses a loan that is not this agent's
    console.log(`repaid loan #${l.loanId}: ${usd(r.paid)}, tx ${r.hash}`);
  }
  await statusAfter(sdk, addresses, id);
}

/** `priors-v2 raise`: the agent's treasury raise (sdk raise: treasury v5's line, or v4's while its rules allow
 *  raises). */
async function raiseCmd() {
  const { sdk, wallet, addresses } = await config();
  holdKey(wallet.address);
  refuseWhileUnresolved(wallet.address, "raise");
  const id = await needAgent(sdk, wallet.address, addresses);
  const r = await sdk.raise(id);
  console.log(`raised agent #${id} on ${r.treasury}${r.line != null ? `: its line is now ${usd(r.line)}` : ""}, tx ${r.hash}`);
  await statusAfter(sdk, addresses, id);
}

/** `priors-v2 move`: treasury v4's line to treasury v5's, then the raise (sdk moveToTreasuryV5), each step once. */
async function moveCmd() {
  const { sdk, wallet, addresses } = await config();
  if (!addresses.treasuryV5) throw new UsageError('the v2 addresses have no "treasuryV5": treasury v5 is not recorded in them, so there is nowhere to move to yet');
  holdKey(wallet.address);
  refuseWhileUnresolved(wallet.address, "move");
  const id = await needAgent(sdk, wallet.address, addresses);
  const r = await sdk.moveToTreasuryV5(id);
  for (const s of r.steps) console.log(`  ${s.step}: ${s.hash ? `tx ${s.hash}` : `skipped (${s.skipped})`}`);
  console.log(`agent #${id} is on treasury v5's line${r.line != null ? `, now ${usd(r.line)}` : ""}`);
  await statusAfter(sdk, addresses, id);
}

async function status() {
  const { sdk, wallet, addresses } = await config();
  const id = await findAgent(sdk, wallet.address, addresses);
  if (id == null) { console.log(`${wallet.address} owns no agent identity yet: run \`priors-v2 join\``); return; }
  await printStatus(sdk, addresses, id);
}

const EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";
let keyAddress = null; // this key's address, once config() has read it (the record of an exit 4 is filed under it)

/** This key's unresolved records; an untrusted record directory or file is a configuration error (exit 2). */
function unresolvedOf(address) {
  try {
    return listUnconfirmed(address);
  } catch (e) {
    if (e.code === "RECORD_UNTRUSTED") throw new UsageError(`the record of unconfirmed transactions is not trusted, so it was not read: ${e.message}`);
    throw e;
  }
}

/** borrow, join, raise and move refuse while a transaction of this key is unresolved: running them again could repeat
 *  it. */
function refuseWhileUnresolved(address, cmd) {
  const open = unresolvedOf(address);
  if (!open.length) return;
  const list = open.map((r) => `tx ${r.hash} (${r.command || "a transaction"}, nonce ${r.nonce}, recorded ${r.at}${r.phase === "intent" ? ", signed but not sent" : ""})`).join("; ");
  throw new Pending(`${cmd} refused: ${open.length === 1 ? "an earlier transaction" : `${open.length} earlier transactions`} of this key ${open.length === 1 ? "is" : "are"} not settled yet: ${list}. Run \`priors-v2 tx\` until ${open.length === 1 ? "it is" : "they are"} final`);
}

/**
 * Every transaction recorded for this key: whether it is final and whether it ran (exit 0 when all are final, 3 while
 * one is not). A record is removed once its transaction is final. It takes no argument: no hash is ever typed, and a
 * 64-hex argument is always refused as a possible key. `--resend` sends a record's signed bytes again when this node
 * does not know them: the same hash and nonce, so it cannot make a second transaction. `--forget` drops a record that
 * cannot be settled here, only once its nonce is used in finalized history (see forget).
 */
async function txCmd(pos, flags) {
  if (pos.length) throw new UsageError("tx takes no argument: it reads the transactions recorded for this key");
  if (flags.resend && flags.forget) throw new UsageError("give --resend or --forget, not both");
  const { sdk, wallet, addresses } = await config();
  holdKey(wallet.address);
  sweepTombs(); // a record a crashed command claimed to delete, and did not
  const recs = unresolvedOf(wallet.address);
  if (!recs.length) { console.log(`no unconfirmed transaction recorded for ${wallet.address} (${recordDir()})`); return; }
  const explorer = blockscoutLookup(process.env.PRIORS_EXPLORER_API || BLOCKSCOUT_API);
  let open = 0;
  for (const rec of recs) {
    const h = rec.hash, cmd = rec.command || "it";
    if (rec.phase === "intent") {
      // signed, never broadcast: never resent. Its writer gone (or no longer holding the lock), nobody can send it
      if (intentAbandoned(wallet.address, rec)) {
        removeIntent(wallet.address, h);
        console.log(`tx ${h} (${cmd}, recorded ${rec.at}): signed but never sent (the command that signed it stopped before sending it): dropped, nothing to settle`);
        continue;
      }
      console.log(`tx ${h} (${cmd}, recorded ${rec.at}): signed and about to be sent by a running command (pid ${rec.writer}): not final; do not run ${cmd} again`);
      open++;
      continue;
    }
    const before = observed(wallet.address, h);
    const q = { nonce: rec.nonce, from: wallet.address, sentBlock: rec.sentBlock, raw: rec.raw, explorer };
    let s = await sdk.txStatus(h, { ...q, seen: before });
    if (flags.resend && s.state === "not-found") {
      // the same check as every write's, right before this broadcast: another command may hold the lock now
      if (!lock?.held()) throw new Pending(`another command of ${wallet.address} is running: it holds this key's lock now, so tx ${h} was not sent again. Run \`priors-v2 tx --resend\` once it is done`);
      // claim the record by rename for this one broadcast: if another command claimed it first, send nothing
      const claimed = claimSending(wallet.address, h, "resend");
      if (!claimed) {
        console.log(`tx ${h}: not sent again: another command is resending or settling it; run \`priors-v2 tx\` again`);
        open++;
        continue;
      }
      try {
        await sendRawOnce(sdk.provider, rec.raw); // one request, never retried, no redirect followed
        console.log(`tx ${h}: sent the same signed transaction again (nonce ${rec.nonce})`);
      } catch (e) {
        console.log(`tx ${h}: sent again; ${e?.answered ? "the node answered" : "no answer"}: ${scrub(e.shortMessage || e.message || e)}`);
      } finally {
        releaseResend(wallet.address, h, claimed);
      }
      s = await sdk.txStatus(h, { ...q, seen: s.seen });
    }
    const again = `running ${cmd} again is safe`;
    const wait = s.finality === "waiting" ? `not final yet: waiting for finality (block ${s.block} is above the chain's finalized block; check again in a few minutes)`
      : s.finality === "reorged" ? `not final: block ${s.block} is no longer the canonical block at that height (a reorg); check again`
        : "not final: the finalized block or this block could not be read; check again";
    const copy = s.by ? `its nonce was used by ${s.by}, the same call at another fee (a speed-up), ` : "";
    const line = {
      mined: s.final ? `${copy}mined in block ${s.block} with status 1: it ran (final). Do not run ${cmd} again` : `${copy}mined in block ${s.block} with status 1: it ran, ${wait}. Do not run ${cmd} again`,
      reverted: s.final ? `${copy}mined in block ${s.block} with status 0: it reverted and did nothing (final); ${again}` : `${copy}mined in block ${s.block} with status 0: it reverted, ${wait}. Do not run ${cmd} again until it is final`,
      replaced: s.final ? `no receipt for it, and nonce ${s.nonce} of ${s.from} was used by ${s.by} in block ${s.block}, a different transaction: this one can never run, so it did not run (final); ${again}` : `nonce ${s.nonce} of ${s.from} was used by ${s.by} in block ${s.block}, a different transaction, ${wait}. Do not run ${cmd} again until it is final`,
      included: `included in block ${s.block}, but its receipt is not readable yet: not final, it may have run. Check again shortly; do not run ${cmd} again`,
      unsettled: `nonce ${s.nonce} of ${s.from} was used, but this node cannot show by which transaction (no receipt for this one, the block or history needed is not available here, and the explorer named none it could confirm): not final. Check again, or with an RPC that keeps history, or look up nonce ${s.nonce} on https://robinhoodchain.blockscout.com/address/${s.from}; once that nonce is in finalized history, \`priors-v2 tx --forget\` drops the record. Do not run ${cmd} again until it is settled`,
      pending: `pending at nonce ${s.nonce}: not final. Check again shortly; do not run ${cmd} again`,
      "not-found": `not found: this node does not know it, so it is not final (another node may hold it, or it may still arrive). \`priors-v2 tx --resend\` sends the very same signed transaction again (same hash and nonce: it cannot make a second one); or cancel nonce ${rec.nonce} from a wallet (a 0-value transfer to yourself at that nonce, at a higher fee) and wait for that nonce to be mined. Do not run ${cmd} again until it is final`,
    }[s.state];
    console.log(`tx ${h} (${rec.command || "a transaction"}, recorded ${rec.at}): ${line}`);
    if (s.final) {
      if (settleRecord(wallet.address, h)) continue;
      console.log(`tx ${h}: final, but another command holds its record now (a resend): run \`priors-v2 tx\` again`);
      open++;
      continue;
    }
    if (JSON.stringify(s.seen || {}) !== JSON.stringify(before || {})) saveObservation(wallet.address, h, s.seen);
    if (flags.forget) {
      // a verdict waiting for finality settles by itself: only a record this node cannot settle is ever forgotten
      if (["mined", "reverted", "replaced"].includes(s.state)) console.log(`tx ${h}: not forgotten: it is settled once its block is finalized; run \`priors-v2 tx\` again then`);
      else if ((await forget(sdk, wallet, addresses, rec, s.seen || {})) && settleRecord(wallet.address, h)) continue;
    }
    open++;
  }
  if (open) throw new Pending(`${open} transaction(s) of this key not final yet`);
}

/** What an earlier `tx` observed about a record's nonce; an untrusted observation is a configuration error (exit 2). */
function observed(address, hash) {
  try {
    return loadObservation(address, hash);
  } catch (e) {
    if (e.code === "RECORD_UNTRUSTED") throw new UsageError(`an observation of an unconfirmed transaction is not trusted, so it was not read: ${e.message}`);
    throw e;
  }
}

/**
 * `tx --forget`: drop a record that cannot be settled here, only once its nonce is used in finalized history: counted
 * as used at the finalized block, or seen used at a block (`seen.consumedAt`) that is now finalized and still the
 * canonical block at its height (the public node drops state long before a block is finalized). Then whatever used the
 * nonce can never change, but which transaction it was, and so whether this one ran, is not known: the agent's open
 * loans and the explorer links are printed first. Refused while the nonce is free (send it again, or cancel it) or not
 * finalized yet. Returns true when the record was forgotten.
 */
async function forget(sdk, wallet, addresses, rec, seen) {
  const p = sdk.provider, who = wallet.address, n = rec.nonce, h = rec.hash, cmd = rec.command || "it";
  const no = (why) => { console.log(`tx ${h}: not forgotten: ${why}`); return false; };
  const fin = await p.getBlock("finalized");
  if (!fin) return no("the finalized block could not be read; run `priors-v2 tx --forget` again");
  let usedAtFin = null;
  try { usedAtFin = (await p.getTransactionCount(who, fin.number)) > n; } catch (_) { /* this node no longer serves that state */ }
  if (usedAtFin === false) {
    if ((await p.getTransactionCount(who, "latest")) <= n) {
      return no(`nonce ${n} of ${who} is still free, so this transaction may still run. Run \`priors-v2 tx --resend\` (the very same signed transaction: it cannot make a second one), or cancel nonce ${n} from a wallet (a 0-value transfer to yourself at that nonce, at a higher fee), then \`priors-v2 tx\` until it is final`);
    }
    return no(`nonce ${n} is used, but not in finalized history yet (finalized: block ${fin.number}); run \`priors-v2 tx --forget\` again in a few minutes`);
  }
  if (usedAtFin === null) {
    const at = seen.consumedAt;
    if (!at) return no(`this node cannot show nonce ${n} used at the finalized block ${fin.number}, and no earlier \`priors-v2 tx\` saw it used; run \`priors-v2 tx\`, then \`priors-v2 tx --forget\` once that block is finalized`);
    const canon = await p.getBlock(at.block);
    if (!canon || String(canon.hash).toLowerCase() !== String(at.blockHash).toLowerCase()) {
      const { consumedAt: _gone, ...rest } = seen;
      saveObservation(who, h, rest);
      return no(`block ${at.block}, where nonce ${n} was seen used, is no longer the canonical block at that height; run \`priors-v2 tx\` again`);
    }
    if (at.block > fin.number) return no(`nonce ${n} was seen used at block ${at.block}, which is not finalized yet (finalized: block ${fin.number}); run \`priors-v2 tx --forget\` again once it is`);
  }
  let loans;
  try {
    const id = await findAgent(sdk, who, addresses);
    if (id == null) loans = `${who} owns no agent identity`;
    else {
      const open = await sdk.openLoans(id);
      loans = open.length ? open.map((l) => `loan #${l.loanId} of agent #${id}: ${usd(l.principal)} + fee ${usd(l.fee)} = ${usd(l.due)} due ${when(l.dueAt)}`).join("\n  ") : `agent #${id} has no open loan`;
    }
  } catch (e) {
    return no(`the agent's loans could not be read (${scrub(e.shortMessage || e.message || e)}); run \`priors-v2 tx --forget\` again`);
  }
  console.log([
    `tx ${h}: forgot it. Nonce ${n} of ${who} is used in finalized history, by a transaction this node cannot show, so whether this ${cmd} ran is not known.`,
    `  open loans now: ${loans}`,
    `  ${EXPLORER_TX}${h}`,
    `  https://robinhoodchain.blockscout.com/address/${who} (the transaction at nonce ${n})`,
    `  warning: check both before running ${cmd} again; if it opened a loan, repay it before its due date`,
  ].join("\n"));
  return true;
}

let ran = null; // the command running, for exit 4's advice
async function main() {
  const argv = process.argv.slice(2);
  if (argv.some(looksLikeKey)) throw new UsageError("a private key was passed on the command line: refused. Put it in PRIORS_KEY instead (and rotate it; it is now in your shell history)");
  const { cmd, pos, flags } = parseArgs(argv);
  ran = cmd;
  if (flags.help || !cmd) { console.log(USAGE); return; }
  // each command's own arguments and options, checked before anything runs: a word or an option a command does not
  // take is refused, never dropped (`priors-v2 repay 42` would otherwise repay the loan due first, not #42)
  const TAKES = { join: { pos: 0, opts: ["invite", "seat", "uri"] }, borrow: { pos: 1, opts: ["days"] }, repay: { pos: 0, opts: ["all"] }, status: { pos: 0, opts: [] }, raise: { pos: 0, opts: [] }, move: { pos: 0, opts: [] }, tx: { pos: 0, opts: ["resend", "forget"] } };
  const takes = TAKES[cmd];
  if (takes) {
    const extra = Object.keys(flags).find((k) => !takes.opts.includes(k));
    if (extra) throw new UsageError(`--${extra} is not an option of ${cmd}`);
    if (cmd === "repay" && pos.length) throw new UsageError("repay takes no loan id: it repays the agent's open loan due first, or every open loan with --all; `priors-v2 status` lists them");
    if (takes.pos === 0 && pos.length) throw new UsageError(`${cmd} takes no argument (got "${pos[0]}")`);
  }
  if (cmd === "join") return join(flags);
  if (cmd === "borrow") return borrow(pos, flags);
  if (cmd === "repay") return repay(flags);
  if (cmd === "status") return status();
  if (cmd === "raise") return raiseCmd();
  if (cmd === "move") return moveCmd();
  if (cmd === "tx") return txCmd(pos, flags);
  throw new UsageError(`unknown command "${cmd}"`);
}

// Errors are printed as their message only: an ethers error object carries the request, which carries the RPC URL.
const scrub = (s) => {
  let out = String(s).replace(/(https?|wss?):\/\/\S+/g, "<rpc>");
  const k = (process.env.PRIORS_KEY || process.env.PRIVATE_KEY || "").trim().replace(/^0x/i, "");
  if (k.length >= 32) out = out.split(new RegExp(k, "gi")).join("<key>");
  for (const v of [process.env.PRIORS_RPC, process.env.RPC_URL]) if (v) for (const u of v.split(",")) if (u.trim()) out = out.split(u.trim()).join("<rpc>");
  return out;
};
main().then(
  () => process.exit(0),
  (e) => {
    if (e instanceof UsageError) { console.error(`priors-v2: ${scrub(e.message)}\n\n${USAGE}`); process.exit(2); }
    if (e instanceof Pending) { console.error(`priors-v2: ${scrub(e.message)}`); process.exit(3); }
    // nothing was sent: another command of this key holds its lock now, or is sending this very transaction
    if (e?.code === "LOCK_LOST" || e?.code === "ALREADY_RECORDED") { console.error(`priors-v2: ${scrub(e.message)}`); process.exit(3); }
    // A lost answer is not a failure to retry: the transaction may have landed (GHSA-g5cv-cpwp-756w), and a pending
    // one does not show in `status` yet. Its hash, nonce and signed bytes are recorded for `priors-v2 tx` to settle it.
    if (e?.code === "BORROW_UNCONFIRMED" || e?.code === "TX_UNCONFIRMED") {
      let check;
      if (e.hash && e.raw && keyAddress) {
        try {
          saveUnconfirmed(keyAddress, { hash: e.hash, nonce: e.nonce, raw: e.raw, sentBlock: e.sentBlock ?? null, command: ran });
          check = `check it with \`priors-v2 tx\` until it is final (or ${EXPLORER_TX}${e.hash}: "Success" or "Failed")`;
        } catch (w) {
          check = `it could not be recorded (${scrub(w.message)}): check ${EXPLORER_TX}${e.hash} until it shows "Success" or "Failed"`;
        }
      } else {
        check = e.hash ? `check ${EXPLORER_TX}${e.hash} until it shows "Success" or "Failed"` : "check this key's latest transaction on https://robinhoodchain.blockscout.com until it shows \"Success\" or \"Failed\"";
      }
      const next = e.mined
        ? `it mined: do not run ${ran} again${ran === "borrow" ? "; `priors-v2 status` lists the loan: repay it before its due date" : ""}`
        : e.code === "BORROW_UNCONFIRMED" || ran === "borrow"
          ? `do not run borrow again yet: ${check}. Borrow again only if it is final and did not run. If it opened a loan, \`priors-v2 status\` lists it: repay it with \`priors-v2 repay\` before its due date`
          : ran === "repay" ? `${check}. A second repay of the same loan cannot pay twice: the pool refuses a loan that is no longer open, so it reverts`
            : ran === "join" ? `${check} before running join again: a second join while a register is pending registers a second identity (an invite redeems once on chain)`
              : `${check} before running the command again`;
      console.error(`priors-v2: ${scrub(e.message)}\npriors-v2: ${next}`);
      process.exit(4);
    }
    let kept = "";
    try {
      const n = keyAddress && ["join", "borrow", "repay", "raise", "move"].includes(ran) ? listUnconfirmed(keyAddress).length : 0;
      if (n) kept = `\npriors-v2: ${n} transaction(s) of this key stay recorded until \`priors-v2 tx\` shows them final (a mined revert or a cancel is final once its block is finalized); \`borrow\`, \`join\`, \`raise\` and \`move\` refuse until then`;
    } catch (_) { /* the note is optional */ }
    console.error(`priors-v2: ${scrub(e.shortMessage || e.message || e)}${kept}`);
    process.exit(1);
  }
);
