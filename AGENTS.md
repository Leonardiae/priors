# AGENTS.md

Instructions for any coding agent working in this repo — Codex, Claude Code, or anything else that reads this
file. Claude Code users: the same content is packaged as a skill at `skills/priors/SKILL.md`, and as the Claude Code
plugin `priors` (`/plugin marketplace add priors-agents/priors`, then `/plugin install priors@priors-agents`).

## What this repo is

Priors is an on-chain credit pool for [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) agents. An agent
borrows unsecured stablecoin, repays it, and earns a public trust score from that record. This repo holds the
contracts, the SDK, the CLIs, and the skill that walks an agent through getting its own credit history.

**Priors v2 is live on Robinhood Chain (4663)**: `CreditPoolV2`, treasury v4, the seat vault (`SeatVaultV3`) and the
stock vault (`StockVault`, lines against Robinhood stock tokens), addresses in
`deployments/4663.v2.json`. The growth seat vault (`SeatVaultV4`, $50 lines for agents with 10
repaid loans) is live since 2026-09-29 and takes no new seats since 2026-10-09. `SeatVaultV5` is live since 2026-10-09
(redeployed on 2026-10-11 with two Low fixes) with owner-only backing (an agent's owner stakes its own $PRIORS behind the line; internal reviews only, no external
audit). The v1 pool is paused; its records were imported into v2. Use the v2 tools
(`npx priors-v2`, `sdk/priors-v2.mjs`) for anything on mainnet. The v1 tools (`npx priors`, `sdk/priors.mjs`)
read v1 history and drive the local devnet, which still deploys v1.

## Giving an agent a credit history

**Read `skills/priors/SKILL.md` and follow it.** It is the canonical procedure, step by step, with the CLI commands
and the failure modes spelled out. Short version:

```bash
npm install
export PRIORS_KEY=0x…                      # the agent owner's key: env or .env, never argv
npx priors-v2 join                         # registers an identity for this key if it owns none -> agentId
npx priors-v2 join --invite <code>         # treasury v4 opens a $5 line (invite from priors.trade/invite)
npx priors-v2 join --seat <staker>         # or, once the agent has 10 repaid loans: accept a staker's seat offer
npx priors-v2 borrow 5 --days 7            # -> loanId
npx priors-v2 repay --all
npx priors-v2 status
npm run quickstart                         # no mainnet? a local v1 chain and the whole flow
```

## Three things not to get wrong

1. **Check the chain and the pool version before claiming anything.** The v2 tools resolve the pool from
   `deployments/<chainId>.v2.json`, the v1 tools from `deployments/<chainId>.json`, and both refuse to guess when
   there is no record for the chain you are pointed at. The v1 record on 4663 is marked `"status": "paused"`:
   new lines and loans there revert. Never invent a pool address, never send an agent to the paused v1 pool,
   and never report an agent as registered when it is not.

2. **Nothing here has had a third-party audit.** v1 shipped with a lender-loss defect the randomized invariants
   did not catch (fixed; `test/DefaultAccounting.t.sol`). v2 had internal adversarial reviews; every finding, fix
   and residual is in `docs/SECURITY-v2.md`, each with a test. ⛔ Do not delete the PoC and regression tests
   (`test/audit-v2/`, `test/audit-final/`, `test/review-v2/`, `test/audit-v4/`, `test/audit-r2/`, `test/audit-sizer/`,
   `test/SeatVaultV3V2Fixes.t.sol`, `test/SeatVaultV4Split.t.sol`, `test/StockVaultAuditFixes.t.sol`,
   `test/StockVaultReadinessFixes.t.sol`, `test/v5/V5AuditFixes.t.sol`, `test/v5/V5DeepAuditFixes.t.sol`,
   `test/v5/V5StarvedReads.t.sol`, `test/InviteBond.t.sol`, `test/DefaultAccounting.t.sol`,
   `test_multipleDefaultsKeepLendersWholeWithoutEarnedExposure`) — they are the evidence the fixes work. Do not
   describe any of this as audited or as proven safe.

3. **A default is permanent.** Three days past due and anyone can mark a loan defaulted: the record is
   defaulted forever, the identity can never borrow or back anyone again, the owner's address is marked, and the
   sponsor pays (its shares burnt, or half a staker's seat). Do not borrow for an agent that cannot repay on time.

## Working on the code

```bash
forge test                  # 1,066 tests, all green (fork-only tests skip)
npm test                    # SDK, CLI, publish guard (needs Foundry)
npm run test:v2             # v2 SDK and x402 client, network-free
npm run devnet              # local v1 chain + deployed pool, bootstrapped so firstLine() works
npm run quickstart          # devnet + the full agent flow
bash scripts/check-public.sh  # fails if any credential reached a tracked file
```

- Solidity 0.8.26, Foundry, `optimizer_runs = 200`; `CreditPoolV2` alone compiles via-IR at `optimizer_runs = 1`
  (a per-file restriction in `foundry.toml`) to fit 24 KB. Contracts are non-upgradeable, except `StockVault`
  (behind `StockVaultProxy`, upgraded only through its ProxyAdmin, which the timelock owns since 2026-10-07; the
  timelock's delay is 48 h until 2026-10-11 19:49 UTC and none from then): a
  source change only reaches users
  through a new deployment or that upgrade. `src/` for deployed contracts must stay byte-identical to what was
  verified on chain (`forge fmt` skips `src/StockVault.sol` for that reason; never format it).
- `sdk/priors-v2.mjs` (v2) and `sdk/priors.mjs` (v1) are the contract surfaces (ABIs included);
  `sdk/float.mjs` is the x402 client; `sdk/env.mjs` resolves chain/deployment/signer (`resolveV2()` for v2).
  Use them rather than hand-rolling calls; the 6-decimal conversions, the consent signature and the USDG approval
  are easy to get subtly wrong.
- `scripts/devnet.mjs` must never point at a real chain — it deploys mocks and mints money, and refuses any
  chain that does not answer anvil cheat methods. Keep that refusal.
- Amounts are 6-decimal units on chain. The v1 SDK works in whole dollars. In the v2 SDK a bigint is raw units and a
  number or decimal string is whole dollars (`toUnits` in `sdk/priors-v2.mjs`); the amounts it returns are raw
  6-decimal bigints. Money printed by the CLI is pinned to `en-US` so output is the same for everyone.
- Never commit a private key, a `.env`, or a deployment record for a chain you did not deploy to.
- `skills/` is also the Claude Code plugin `priors` (`skills/.claude-plugin/plugin.json`, `skills/.mcp.json`), listed
  by `.claude-plugin/marketplace.json`. Installed copies stay on plugin.json's `version` until it changes, so bump it
  with every change under `skills/`, and run `claude plugin validate .` and `claude plugin validate skills`.
