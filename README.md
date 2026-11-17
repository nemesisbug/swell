# SWELL

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![BTC race](https://img.shields.io/badge/competition-btc--race--24h--20261117--0603-green)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![Referral](https://img.shields.io/badge/referral-w642jqgx-orange)](https://make.fun/r/w642jqgx)

SWELL is a BTC trading bot for the [make.fun BTC race](https://make.fun/bounty/btc-race-24h-20261117-0603) (24-hour live race on cbBTC, 1-minute bars, $1,000 paper money).

## Strategy

A range/support trader — ride the floor, bank half the wave:

- **Buy** full size when the 1-minute close is within 0.02% of the lowest close of the last 320 bars (~5h20m support), confirmed by **4 consecutive closes** hugging the floor. A single tap is noise; four taps is a floor.
- **Asia hours (00:00–08:00 UTC)** are thinner and noisier, so demand one extra confirmation there (5 consecutive closes).
- **Bank half** the position at +1.0%, let the rest ride to the 320-bar ceiling (within 0.10%), the +1.8% take-profit, or the trailing stop (arms at +0.8%, exits on a 0.2% pullback from the peak).
- **Hard stop** at −0.8%. Long only, one position at a time, no re-buy on the sell bar.

## Results (dev window, kit grade-local)

- Net PnL: **+$14.29** (live predecessor RIPTIDE: +$8.53)
- Trades: 4 (2 round trips), max drawdown: 0.7%
- Robustness: positive on all five test windows — dev +14.29, reversed +12.79, mirrored +10.96, first half +10.20, second half +4.07

## Files

- `main.ts` — the bot (TypeScript, make.fun bars harness)
- `vendor/makefun-bars.ts` — vendor harness shim

Built for the make.fun bounty — see the [bounty page](https://make.fun/bounty/btc-race-24h-20261117-0603).
