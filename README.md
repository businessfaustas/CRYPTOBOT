# cryptobot

A crypto **paper-trading** bot built as six small agents. Each agent does one job, and every decision gets a reason and a line in the log.

> **Paper only.** There is no code that places real orders, and no API keys are needed or used. Prices are real in `live` mode; fills, fees and slippage are simulated.

| Agent | Job |
| --- | --- |
| **Scanner** | Flags setups and never trades. A setup is a close above the 20-bar high, with EMA9 above EMA21, on at least 1.5× average volume. |
| **Risk check** | Nothing executes before a pass. It rejects a setup on wide spreads, too much volatility, an existing position in that symbol, too many open positions, a cooldown after a loss, stale quotes, a target too small to cover fees and spread 3× over, or the daily loss limit (5%). |
| **Sizer** | Sizes from account equity, never a fixed ticket. Each trade risks 1% of equity between entry and a 2×ATR stop, and is capped at 25% of equity and at the cash on hand. |
| **Executor** | Simulates market orders, charging half the spread, market impact (based on the share of the bar's volume taken) and fees, and tracks the slippage on every fill. It cancels entries that would slip more than 30bps. It manages the stop, the target, a trailing stop and a time stop. |
| **Logger** | No trade without a reason. It writes every signal, filter, sizing decision, entry and exit to `logs/run-*.jsonl`. |
| **Equity** | Tracks the balance and the equity curve, plus win rate, profit factor, max drawdown, fees and average slippage. |

## Run it

Requires Node 22.18 or newer (runs TypeScript directly, no build step).

```bash
npm install          # dev tools only (typescript); there are no runtime dependencies

npm run sim          # synthetic market in real time, dashboard at http://localhost:8787
npm start            # live Coinbase prices, paper fills, dashboard at http://localhost:8787
npm run backtest     # 5,000 synthetic 5-minute candles, prints a report

npm run backtest -- --source coinbase --candles 3000   # backtest on real Coinbase history
npm start -- --symbols BTC-USD,ETH-USD --equity 500 --granularity 900
node src/main.ts --help                                 # all options
```

Coinbase market data is public, so live mode needs no account or key.

## Read the results honestly

- **The sim market has no edge.** It's a random walk with trending regimes, so any strategy there should come out around break-even minus costs. Use it to check the plumbing, not to judge profitability. Tuning settings until the sim looks profitable is fitting noise.
- **Fees are the main enemy.** On 1-minute candles a 2×ATR stop is often closer than a round trip of fees, so every trade starts underwater. That's why the default is 5-minute candles and why risk check rejects trades whose target doesn't cover costs 3×. `executor.feeBps` defaults to 25bps per side. Set it to your exchange's real fee.
- **Backtest on real data before believing anything**, and then paper trade live for weeks. The post this was inspired by ($44.82 to $11,643 overnight) showed 0 trades and labeled its numbers "illustrative".

## Layout

```
src/
  agents/      scanner, riskCheck, sizer, executor, logger, equity
  feeds/       coinbase (live + history), sim (synthetic), replay (backtests)
  dashboard/   tiny HTTP + server-sent-events dashboard, no dependencies
  bot.ts       the pipeline that wires the agents together
  config.ts    every threshold, with comments
  main.ts      CLI
test/          node:test suites: agents, end-to-end sim invariants, Coinbase parsing
```

## Checks

```bash
npm run typecheck && npm test
```
