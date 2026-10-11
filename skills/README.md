# Priors plugin for Claude Code

This directory is the Claude Code plugin `priors`: the agent skill ([`priors/SKILL.md`](priors/SKILL.md)) and Priors'
hosted MCP server ([`.mcp.json`](.mcp.json)). The marketplace that lists it, `priors-agents`, is
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) at the repository root.

## Install

In Claude Code:

```
/plugin marketplace add priors-agents/priors
/plugin install priors@priors-agents
```

From a shell, the same two steps are `claude plugin marketplace add priors-agents/priors` and
`claude plugin install priors@priors-agents`. Start a new session, or run `/reload-plugins`, to load it.

## What you get

- **The skill**, `/priors:priors`. Claude also picks it up on its own when you ask to give your agent a credit history,
  a trust score or an ERC-8004 identity, to borrow or repay, or to look up an agent's record. Its `npx priors-v2`
  commands run from a clone of this repository, with the key in the environment or `.env`, never on the command line.
- **The hosted MCP server**, `plugin:priors:priors-read` (`https://mcp.priors.trade/mcp`, Streamable HTTP). Read-only,
  no key: it answers an agent's record and score, the pool's figures, recent loans and the facilitator's services. Its
  write tools (`request_borrow`, `request_repay`, `pt_buy`, `pt_sell`, `pt_redeem`) only build links where the agent's
  owner confirms. It holds no key and sends no transaction.

## Paying, borrowing and repaying with the agent's own wallet

The plugin's server cannot sign. To pay x402 URLs, borrow and repay from Claude Code, add the local server,
[`@priors/mcp`](../packages/mcp), next to it:

```bash
claude mcp add priors --scope user -e 'PRIORS_KEY=${PRIORS_KEY}' -- npx -y @priors/mcp@0.8.4
```

Keep the single quotes. Claude Code then saves the reference `${PRIORS_KEY}`, not a key, and reads the value from the
environment `claude` was started in each time it starts the server. Start `claude` with `PRIORS_KEY` set to the key
of a dedicated agent wallet that holds only what the agent may spend, and never paste the key into a config file or a
chat. Without it the local server runs its read-only tools only, and `claude mcp list` warns that the variable is
missing. Spending caps, the agent id and the RPC are set the same way: see
[`packages/mcp`](../packages/mcp#configure).

## Updates

An installed copy stays on the plugin's `version` until that changes. To fetch a newer one, run
`/plugin marketplace update priors-agents` in a session, or `claude plugin update priors@priors-agents` from a shell,
then `/reload-plugins` or a new session.
