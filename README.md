[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/veneraxyz/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry-v1/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/veneraxyz/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry-v1/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Pump.fun Sharpe Sprint — Trend EMA Equal-Weight Paper Bot

Entry for [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532): a paper-trading bot for a 6-hour pump.fun replay, ranked by hourly Sharpe ratio.

## Strategy

- **Per-mint trend filter:** each mint gets a fast EMA (8 trades) and a slow EMA (30 trades) over its bonding-curve price. We buy only while fast EMA beats slow EMA by at least 5% and the price is up at least 20% over the last 30 observations, after at least 30 trades — only violent runs qualify.
- **Equal-weight sizing:** every entry is 0.05 SOL, at most 5 open positions, so no single coin dominates the book.
- **Disciplined exits:** sell the whole position on a confirmed trend flip (fast EMA 2% below slow EMA), a 15% stop-loss, or a 50% take-profit; a 10-batch cooldown stops immediate re-buys.
- **Impact skip:** a trade is skipped when the mint's size cap cannot fit the full 0.05 SOL stake.
- **Drawdown guard:** if equity falls 5% below its running peak, all positions are flattened and new entries pause for 100 batches; after 2 such trips the pause becomes 1000 batches.
- **Deterministic:** no clock, no randomness, no network — the same replay input gives byte-identical orders.

## Run it

The grader runs it as `node /bot/main.ts` (Node 22, type stripping, stdlib only). Locally, from the repo root:

```sh
node main.ts
```

It speaks the `agent-fun/replay/v2` protocol on stdin/stdout. On completion it writes a short `summary.json` to `$MAKEFUN_OUTPUT_DIR` (or `/output`).

## Layout

- `main.ts` — the strategy (entrypoint).
- `vendor/makefun-bot.ts` — the harness shim, vendored as-is from the kit.
- `LICENSE` — MIT.
