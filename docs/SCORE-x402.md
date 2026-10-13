# How the score grows with x402

*Design note, 2026-09-25. Update 2026-09-26: the income input is built in Priors Score v2 (`docs/SCORE-v2.md`: x402 payments read from the
chain from any facilitator, netting, loans repaid from income), live since 2026-09-27. Funding-source clusters are
planned for v2.1. The on-chain score is still exactly `src/libraries/ScoreLib.sol`.*

## Today: a score made of repayments

The score (0 to 1000) is a pure function of the on-chain record, so anyone can recompute it:

| part | max | what earns it |
|---|---|---|
| dollar-days repaid | 400 | $10 held for a day and repaid = 1 point |
| qualified loans repaid | 200 | loans held 7+ days, 20 points each |
| backing at risk | 150 | someone else's money in front of the agent |
| age | 150 | 2 points a day since enrolment |
| recourse honored | 100 | paying a vouched child's debt |
| children defaulted | -75 each | |
| own default | 0 | always |

Every point costs capital held at risk for real time. That makes it hard to fake, and it has two limits:

1. **It only knows how an agent borrows, not whether it earns.** A clean record says "it paid back", not "it
   can pay back more".
2. **It saturates.** $4,000-days, ten week-long loans, $750 of backing and 75 days max it out. After that it
   cannot tell a good agent from a great one, so it cannot justify a bigger line.

## Next: income, counted only when it is real

x402 payments are on-chain USDG transfers (`transferWithAuthorization`). Every payment an agent *receives* for
its work is public, whoever settled it: our facilitator or any other. That is the missing input, and it is read
from the chain. Score v2 also joins wallets through Priors' own clusters list, which is not published, so a score
that depends on it cannot be recomputed from the chain alone (`docs/SCORE-v2.md`, "Clusters").

**Raw income proves nothing** (an agent can pay itself from sock puppets), so income counts only through
filters, each of which makes faking cost real money:

| filter | why |
|---|---|
| distinct payer clusters | wallets funded from the same source or sharing a gas payer count as one payer (planned, v2.1; v2 joins owners, declared payment wallets and Priors' clusters list) |
| payer weight | a payment from a payer with its own record (a Priors score, age, history) counts more than one from a fresh wallet |
| no round trips | money that came from the agent, or goes straight back to it, counts for nothing (v2 nets what the agent's side sent that payer directly; a round trip through a third wallet is v2.1) |
| spread over time | 30 days of steady payments beat one burst; a window, not a total (v2 counts a 30-day window, capped per payer; steadiness is not scored yet) |
| a floor per payment | dust does not count |

A possible shape, on top of today's parts (weights set from data, not guesses):

- **verified income**: points for 30-day income from weighted, distinct payers;
- **payer breadth**: points for how many distinct, reputable payers paid;
- **repaid from income**: loans repaid out of earnings count more than loans
  repaid from the owner's wallet, because they show the business carries the debt.

## Why it gets better with time

1. **More merchants, more signal.** Each merchant that accepts x402 USDG on Robinhood Chain is one more place
   where real income shows up on chain.
2. **The payer graph fills in.** A payment is weighted by its payer's own record. As more agents build records,
   more payments carry weight, and faking gets harder: to look trusted you need to be paid by the trusted. This
   is the PageRank idea applied to money: trust flows along real payments.
3. **Weights learn from defaults.** Every loan that is repaid or defaults tells us which signals predicted it
   (default rates by signal and cohort, published weekly). Weights move on data: a change is a new
   versioned weights file, announced at least 7 days before it becomes the default (`docs/SCORE-v2.md`), not a
   timelocked contract change.
4. **The record gets older.** Age and steady income over many months are the two things money cannot speed up.

## What a better score buys

- **Lines sized by income**, not by who vouched: line ≤ a share of verified 30-day income (the income-backed rung, `docs/SCORE-v2.md`),
  capped per cycle, so the line always grows slower than the record behind it.
- **Lines against tokenized assets**, live since 2026-09-28: the stock vault lends 25-70% of a Robinhood stock token
  deposit's value by token, plus up to 15 points for a record of repaid treasury credit, never above 70%.
- **A score others can read**: published to the ERC-8004 reputation registry, so any app on the chain can use it.

## What does not change

- A default is still 0, whatever the income.
- Income adds to the score; it never replaces money at risk for a first line.
- Every weight stays public, and every input but Priors' clusters list (not published; `docs/SCORE-v2.md`) is read
  from the chain.
