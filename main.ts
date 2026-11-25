// Pump.fun Sharpe Sprint — trend-filtered equal-weight paper bot.
//
// Strategy: per-mint momentum. Each mint gets a fast EMA (8 trades) and a slow
// EMA (30 trades) over its bonding-curve price (virtual SOL reserves divided by
// virtual token reserves). We buy only while the fast EMA sits above the slow
// EMA by at least 5% and the price is up at least 20% over the last 30
// observations, after at least 30 trades — only violent runs qualify, so the
// bot trades rarely and pays little in curve fees. Size is equal weight
// (0.05 SOL, small on purpose: it bounds what any losing trade can cost), and
// we exit the whole position on a confirmed trend flip (fast 2% below slow),
// a 15% stop-loss, or a 50% take-profit, letting real runners run.
// whose size cap cannot fit a meaningful order is skipped, so pool impact
// stays low. At most 5 positions are open at once. A drawdown guard watches
// equity against its running peak: a 5% drop flattens every position and
// pauses new entries for 100 batches (1000 after the second trip), then
// trading resumes from the new peak.
// Everything is deterministic: no clock, no randomness, no network, no
// environment reads on the trading path — the same replay input always yields
// the same orders. When the replay ends, a short summary is written to the
// output directory (MAKEFUN_OUTPUT_DIR, or /output) for the record; a failure
// to write it never affects trading.
//
// A batch of trades is decided once per slot: exits first, then entries, so
// a freed position slot can be reused by the same batch's orders.

import { mkdirSync, writeFileSync } from 'node:fs';
import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per entry, equal weight: small size bounds the bleed per trade.
const MIN_CAP_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL: skip when the cap cannot fit a real order.
const MAX_SLIPPAGE_BPS = 2000;
const FAST_SPAN = 8;
const SLOW_SPAN = 30;
const TREND_MARGIN = 1.05; // fast EMA must beat slow EMA by 5% to enter: only violent runs qualify.
const MIN_TRADES_TO_ENTER = 30;
const STOP_LOSS = 0.85; // exit when price falls 15% below entry cost.
const TAKE_PROFIT = 1.5; // exit when price rises 50% above entry cost: let real runners run.
const FLIP_MARGIN = 0.98; // a trend flip only counts when fast EMA falls 2% below slow EMA, not on a touch.
const MOMENTUM_LOOKBACK = 30; // entry also needs price up 20% vs 30 observations ago.
const MOMENTUM_MIN = 1.2;
const SELL_COOLDOWN_BATCHES = 10; // do not re-buy a mint right after selling it.
const DRAWDOWN_GUARD_BPS = 500; // flatten + pause when equity falls 5% below its peak.
const GUARD_PAUSE_BATCHES = 100; // batches with no new entries after a guard flatten.
const GUARD_MAX_TRIPS = 2; // after this many guard trips, pause 1000 batches: stop the bleed instead of re-entering the same losing market.

const FAST_ALPHA = 2 / (FAST_SPAN + 1);
const SLOW_ALPHA = 2 / (SLOW_SPAN + 1);

interface Trend {
  fast: number;
  slow: number;
  trades: number;
  price: number;
  history: number[]; // recent prices, oldest first, capped at MOMENTUM_LOOKBACK + 1.
}

const trends = new Map<string, Trend>();
const candidates = new Set<string>();
const entryCostPerToken = new Map<string, number>();
const lastSellSeq = new Map<string, number>();
const tradedMints = new Set<string>();
let peakEquityLamports = 0n;
let guardUntilSeq = -1;
let batchesSeen = 0;
let buysFilled = 0;
let sellsFilled = 0;
let guardTrips = 0;

function equityLamports(state: { cash: bigint; positions: Map<string, { token_amount: bigint }>; curves: Map<string, { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }> }): bigint {
  let equity = state.cash;
  for (const [mint, holding] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined) continue;
    const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (!(price > 0)) continue;
    equity += BigInt(Math.floor(Number(holding.token_amount) * price));
  }
  return equity;
}

function curvePrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

function observe(mint: string, price: number): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  const t = trends.get(mint);
  if (t === undefined) {
    trends.set(mint, { fast: price, slow: price, trades: 1, price, history: [price] });
    return;
  }
  t.fast = price * FAST_ALPHA + t.fast * (1 - FAST_ALPHA);
  t.slow = price * SLOW_ALPHA + t.slow * (1 - SLOW_ALPHA);
  t.trades += 1;
  t.price = price;
  t.history.push(price);
  if (t.history.length > MOMENTUM_LOOKBACK + 1) t.history.shift();
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];

    // Fold this batch's fills into our entry-cost book first: a filled buy
    // records what each token cost us (quote spent, fees included).
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        const tokens = BigInt(f.token_amount);
        const quote = BigInt(f.quote_lamports);
        if (tokens > 0n) entryCostPerToken.set(f.mint, Number(quote) / Number(tokens));
        buysFilled += 1;
        tradedMints.add(f.mint);
      }
      if (f.side === 'sell' && f.status === 'filled') {
        entryCostPerToken.delete(f.mint);
        lastSellSeq.set(f.mint, batch.seq);
        sellsFilled += 1;
        tradedMints.add(f.mint);
      }
    }
    batchesSeen += 1;

    // Update every trend from this batch's events, in chain order.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        candidates.add(e.mint);
        observe(e.mint, curvePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)));
      } else if (e.event === 'TradeEvent') {
        observe(e.mint, curvePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)));
      } else if (e.event === 'CompleteEvent') {
        candidates.delete(e.mint);
        trends.delete(e.mint);
        entryCostPerToken.delete(e.mint);
      }
    }

    // Mints with a sell already in flight must not get a second sell.
    const selling = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') selling.add(p.order.mint);
    }

    // Drawdown guard: equity is cash plus positions marked at current curve
    // prices. A 5% fall from the running peak flattens everything and pauses
    // new entries for 20 batches; the peak resets to the flattened equity so
    // trading resumes cleanly instead of staying locked out.
    const equity = equityLamports(state);
    if (peakEquityLamports === 0n) peakEquityLamports = equity;
    let guardFlatten = false;
    if (batch.seq >= guardUntilSeq && equity < (peakEquityLamports * BigInt(10_000 - DRAWDOWN_GUARD_BPS)) / 10_000n) {
      guardFlatten = true;
      guardTrips += 1;
      guardUntilSeq = batch.seq + (guardTrips >= GUARD_MAX_TRIPS ? 1000 : GUARD_PAUSE_BATCHES);
      peakEquityLamports = equity;
    } else if (equity > peakEquityLamports) {
      peakEquityLamports = equity;
    }

    // Exits first: trend flip, stop-loss, take-profit, or the drawdown guard
    // sells the whole slot.
    for (const [mint, holding] of state.positions) {
      if (selling.has(mint) || holding.token_amount <= 0n) continue;
      const t = trends.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!(price > 0)) continue;
      const entry = entryCostPerToken.get(mint);
      const flipped = t !== undefined && t.fast < t.slow * FLIP_MARGIN;
      const stopped = entry !== undefined && price <= entry * STOP_LOSS;
      const profited = entry !== undefined && price >= entry * TAKE_PROFIT;
      if (guardFlatten || flipped || stopped || profited) {
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        selling.add(mint);
      }
    }

    // Entries: one equal-weight buy per trending mint, while a slot is free.
    // No new entries while the drawdown guard's pause is running.
    if (batch.seq < guardUntilSeq) return orders;
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    // Sells decided in this batch free their slots only once filled, so
    // only genuinely free slots count here — never breach the position cap.
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      if (!candidates.has(mint)) continue;
      if (state.positions.has(mint) || selling.has(mint)) continue;
      let buyPending = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'buy') { buyPending = true; break; }
      }
      if (buyPending) continue;
      const lastSell = lastSellSeq.get(mint);
      if (lastSell !== undefined && batch.seq - lastSell < SELL_COOLDOWN_BATCHES) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(mint);
        continue;
      }
      const t = trends.get(mint);
      if (t === undefined || t.trades < MIN_TRADES_TO_ENTER) continue;
      if (!(t.fast > t.slow * TREND_MARGIN)) continue;
      // Momentum confirmation: the price must also be up over the lookback,
      // so flat or choppy mints with a noisy EMA gap do not qualify.
      const old = t.history[0];
      if (t.history.length < MOMENTUM_LOOKBACK + 1 || old === undefined || !(t.price >= old * MOMENTUM_MIN)) continue;
      // Skip the trade when pool impact is too high: the size cap must fit
      // the full equal-weight stake, otherwise the buy is not worth it.
      const cap = state.maxBuyLamports(mint);
      if (cap < STAKE_LAMPORTS || cap < MIN_CAP_LAMPORTS) continue;
      if (free < STAKE_LAMPORTS + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: STAKE_LAMPORTS, max_slippage_bps: MAX_SLIPPAGE_BPS });
      free -= STAKE_LAMPORTS + tx;
      slots -= 1;
    }
    return orders;
  },
  onDone(state) {
    // Read-back summary for the record only: it never feeds back into
    // trading, so the two graded executions stay byte-identical. Resolve
    // the output dir from the environment with an absolute fallback, and
    // never let a write failure fail the run.
    try {
      const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
      mkdirSync(outDir, { recursive: true });
      const summary = {
        bot: 'trend-ema-equal-weight',
        batches: batchesSeen,
        buys_filled: buysFilled,
        sells_filled: sellsFilled,
        distinct_mints_traded: tradedMints.size,
        guard_trips: guardTrips,
        final_cash_lamports: state.cash.toString(),
        final_equity_lamports: equityLamports(state).toString(),
        open_positions: state.positions.size,
      };
      writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.error(`summary write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
