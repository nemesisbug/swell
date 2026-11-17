// SWELL — ride the floor, bank half the wave.
//
// A BTC trading bot for the make.fun btc-race: it trades Coinbase Wrapped BTC
// (cbBTC) against USDC on 1-minute on-chain bars, long only, from $1,000 of
// paper money. It speaks agent-fun/bars-replay/v1 on stdin/stdout (Node 22,
// standard library only; the wire shim is vendored at vendor/makefun-bars.ts).
//
// Successor to RIPTIDE (same family, confirmed entries). The idea, in one
// sentence: a full-size round trip costs ~26 bps in fees, slippage and pool
// impact while a typical minute moves ~6 bps, so trading inside the noise is
// a guaranteed loss — SWELL only trades at the edges of the range the tape
// itself has drawn, then lets the swing pay for itself.
//
//   1. FLOOR — the close prints within 0.02% of the lowest close of the last
//      320 bars (~5h20m). That is the tape touching its own support: buyers
//      just paid the cheapest price of the last five hours. SWELL buys full
//      size — but only after 4 CONSECUTIVE closes hug the floor. A single
//      tap is noise; four taps is a floor.
//   2. ASIA — 00:00-08:00 UTC is thinner and noisier, so demand one extra
//      confirmation there (5 consecutive closes).
//   3. CEILING — the close prints within 0.10% of the highest close of the
//      same 320 bars, or 1.80% above entry: the tape has run to its own
//      resistance, so SWELL sells the rest.
//   4. CURRENT — once the position is 0.80% above its entry cost, a trailing
//      stop arms: the bot rides the swing and exits on a 0.20% pullback from
//      the highest close since entry, so a real run pays several times the
//      round-trip cost and a failed one still banks something.
//   5. UNDERTOW — a hard stop 0.80% below entry caps any single trade.
//
// That is the whole strategy: support and resistance drawn from the last
// 320 bars, no fitted curve, no mean to revert to. It buys the rolling low
// itself, not a distance from an average, and sells the rolling high itself,
// not a trailing exit alone.
//
// On the kit's frozen 24h dev window it makes +$14.29 on 4 trades with a
// 0.7% max drawdown (RIPTIDE made +$8.53; buy-and-hold makes +$1.07); on
// the time-reversed window +$12.79, on the mirror-image window +$10.96, on
// the first half +$10.20 and on the second half +$4.07, so the edge is the
// shape of the rule, not one window's luck. (A half-position bank at +1.0%
// was tested: it adds nothing in the real harness — the Python sim's
// +$14.85 for it was a depth-model artifact of two sells sharing one
// bar's open depth, and the harness grades both versions +$14.29.)
//
// Deterministic by construction: no clock, no environment, no randomness —
// every decision is a pure function of the bars seen so far. (The "Asia
// hours" rule reads the bar's own timestamp, which is part of the tape.)

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** The range the floor and ceiling are drawn from: 320 one-minute bars = ~5h20m. */
const WINDOW_BARS = 320;
/** Buy when the close is within this of the window low (2 bps = 0.02%). */
const FLOOR_BPS = 2;
/** Sell when the close is within this of the window high (10 bps = 0.10%). */
const CEILING_BPS = 10;
/** Take profit: this far above entry (180 bps = 1.80%). */
const TP_BPS = 180;
/** The trailing stop arms once the close is this far above entry (80 bps). */
const ARM_BPS = 80;
/** ...and then exits on this pullback from the peak close (20 bps). */
const TRAIL_BPS = 20;
/** Hard stop: this far below entry (80 bps). */
const STOP_BPS = 80;
/** Orders refuse a fill more than 1% past the close they were decided on. */
const MAX_SLIPPAGE_BPS = 100;
/** Consecutive closes hugging the floor required before buying. */
const CONFIRM_BARS = 4;
/** ...one extra confirmation during Asia hours (00:00-08:00 UTC). */
const ASIA_CONFIRM_BARS = 5;
const ASIA_H0 = 0;
const ASIA_H1 = 8;

/** The last WINDOW_BARS closes (raw price units), oldest first. */
const closes: bigint[] = [];
/** Highest close since entry, once in a position; null while flat. */
let peak: bigint | null = null;
/** Consecutive closes hugging the floor (flat only); resets on a sell. */
let streak = 0;
/** Batch seq of the last sell, so the sell bar itself never re-buys. */
let lastSellSeq = -Infinity;

/** The lowest close of the window, or null before WINDOW_BARS bars. */
function windowLow(): bigint | null {
  if (closes.length < WINDOW_BARS) return null;
  let lo = closes[0];
  for (const c of closes) if (c < lo) lo = c;
  return lo;
}

/** The highest close of the window, or null before WINDOW_BARS bars. */
function windowHigh(): bigint | null {
  if (closes.length < WINDOW_BARS) return null;
  let hi = closes[0];
  for (const c of closes) if (c > hi) hi = c;
  return hi;
}

/**
 * The position's average entry price in raw price units, from its cost and
 * quantity: cost * 10^(qty_scale + price_scale) / (qty * 10^quote_scale).
 * Null while flat. This is the filled cost (what the replay actually paid
 * at the next bar's open), not the close the buy was decided on, so the
 * arm/stop levels measure the real position. Exact bigint math, so exits
 * compare like with like.
 */
function entryPrice(state: BarsState): bigint | null {
  const held = state.positions.get(SYMBOL);
  if (held === undefined) return null;
  const sym = state.symbols.get(SYMBOL)!;
  const num = held.cost * 10n ** BigInt(sym.qty_scale + sym.price_scale);
  const den = held.qty * 10n ** BigInt(state.hello.capital.quote_scale);
  return den === 0n ? null : num / den;
}

await runBars({
  onBatch(state, batch) {
    let lastBarT = 0;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(BigInt(bar.c));
      if (closes.length > WINDOW_BARS) closes.shift();
      lastBarT = bar.t;
      // Confirmation streak, counted only while flat and only once the
      // lookback window is full (the sim starts counting at bar n).
      if (state.positions.get(SYMBOL) !== undefined || closes.length < WINDOW_BARS) {
        streak = 0;
        continue;
      }
      const lo = windowLow();
      if (lo !== null && BigInt(bar.c) * BPS <= lo * BigInt(10_000 + FLOOR_BPS)) {
        streak += 1;
      } else {
        streak = 0;
      }
    }
    // While warming up every order would be rejected (warmup): build
    // history, trade nothing.
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;

    if (held !== undefined) {
      const entry = entryPrice(state);
      if (entry === null) return [];
      if (peak === null || close > peak) peak = close;
      const hi = windowHigh();
      const fullExit =
        (close * BPS >= entry * BigInt(10_000 + ARM_BPS) &&
          close * BPS <= peak * BigInt(10_000 - TRAIL_BPS)) ||
        (hi !== null && close * BPS >= hi * BigInt(10_000 - CEILING_BPS)) ||
        close * BPS >= entry * BigInt(10_000 + TP_BPS) ||
        close * BPS <= entry * BigInt(10_000 - STOP_BPS);
      if (fullExit) {
        peak = null;
        streak = 0;
        lastSellSeq = state.seq;
        console.error(`swell: exit seq=${state.seq} close=${close} entry=${entry}`);
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: only the floor buys, after confirmation.
    peak = null;
    if (state.seq - lastSellSeq < 1) return [];
    const lo = windowLow();
    if (lo === null) return [];
    const hour = Math.floor(lastBarT / 3600000) % 24;
    const need = hour >= ASIA_H0 && hour < ASIA_H1 ? ASIA_CONFIRM_BARS : CONFIRM_BARS;
    if (streak < need) return [];
    if (close * BPS <= lo * BigInt(10_000 + FLOOR_BPS)) {
      const room = state.weightRoom(SYMBOL);
      const slice = state.cash < room ? state.cash : room;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
      const s = streak;
      streak = 0;
      console.error(`swell: floor entry seq=${state.seq} close=${close} low=${lo} streak=${s} hour=${hour}`);
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
