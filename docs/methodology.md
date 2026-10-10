# Methodology

How a backtest turns archived files into a report, rule by rule. Every rule here is implemented once in each
language and the two are tested against each other (see [verification](verification.md)); where a rule is an
approximation, it says so.

## 1. From files to events

The archive is gzip-compressed JSONL and CSV, one file per venue × dataset × asset group × UTC day, exactly as a
subscriber downloads it.

**Markets come first.** Each day's `markets` rows are normalised to one record per market: id, asset, interval,
opening and closing time, strike, official outcome, token ids and — for Polymarket — the fee schedule. Everything
else is attached to a market by its slug (Polymarket) or numeric id (Predict.fun).

**Which settlement stream.** A Polymarket crypto market settles on the instantaneous Chainlink stream, a 30-second
TWAP or a 60-second TWAP. The market's own config states which (`cryptoMarketConfig.twapLookbackSeconds`: null or
0 → instantaneous, 30, 60). The venue moved markets between these over time, so the date is never used to decide.
A Predict.fun market settles on its own price feed, matched by `price_feed_id`.

**A market is dropped, and listed in the report's coverage, when** it has no asset; it is a Polymarket market whose
`token_ids` is not two distinct ids (every book, best-bid/ask and trade row is assigned to Up or Down through that
pair, so without it the market would replay against an empty book); its settlement stream cannot be
resolved; its outcome cannot be read (Polymarket: a complete `["1","0"]` / `["0","1"]` pair from a resolved
market; Predict.fun: an `end_price` exists); it has no events inside its window; or its window has no settlement
ticks. A dropped market is visible and costs nothing; a market settled on a guess would be invisible and wrong.

**The window.** A market's events are cut to `[open, close]`. A settlement file is a whole day, so this is what keeps
14:00 prices out of a market that closed at 10:00.

**Order within one millisecond** is fixed, never left to read order: the book first, then trades, then settlement
ticks; within the book, a full snapshot before a delta. A hook therefore sees the market as it already was at that
instant, never as it is about to be.

## 2. The order book

Two books per market: UP and DOWN, each with bids and asks.

- **Polymarket** publishes one side per snapshot row (`book`, by `asset_id`); a row replaces that token's ladder and
  leaves the other token's alone. `price_change` sets the absolute size of one level (size 0 deletes it); its `BUY`
  rows are bids and `SELL` rows are asks.
- **Predict.fun** publishes one book per market. It is UP's book; DOWN is its mirror (a bid at 0.40 for UP is an
  ask at 0.60 for DOWN).
- Prices are compared on a 1e-4 grid, so a float such as `0.1 + 0.2` cannot decide whether an order fills.
- **Capture cadence.** The book stream was archived at a set cadence per asset (one row per market per window,
  keeping the first). A run replays each asset at the coarsest cadence its date range contains, so the same book
  never changes density part-way through a report.
- **Best bid/ask as a bound.** The unthrottled `best_bid_ask` stream carries prices without sizes. It is applied as
  a deletion only: levels strictly better than the latest best price, and older than it, are removed. It never
  adds a level, because a level without a size would be invented liquidity. It does not reach a hook. Opt in by
  declaring the `bbo` dataset.

What this cannot restore: between snapshots, a level added or resized in a delta that the cadence dropped is
missing or stale until the next snapshot. That applies at the top of the book as well as below it.

## 3. Orders and fills

A hook returns an `Order` (or a list, or nothing):

| field | meaning |
| --- | --- |
| `side` | `"UP"` or `"DOWN"` — which token |
| `size` | contracts; or `notional` (dollars) with a `limit`, giving `floor(notional / limit)` contracts |
| `limit` | a ceiling when buying, a floor when selling; levels beyond it are not taken |
| `reduce_only` | sell into the bids of a token you hold, at most what you hold |
| `hold_s` | flatten this many seconds after the fill |
| `tif` | `"ioc"` only |

**Matching** walks the book from the best level outward and consumes what it takes, so two orders in one event
cannot fill against the same depth. What the book does not have is reported as unfilled. The fill row records the
price on the screen when the order was sent (`quoted_px`), the average and worst price paid, and the levels walked
— the slippage panel is built from these.

**Latency.** With `latency_ms`, an order decided at `t` is matched at `t + latency`. Anything scheduled strictly
before an event resolves against the book as it stood before that event; anything scheduled at the event's own
millisecond resolves after the event has been applied. An order still pending when the market closes did not
land.

**Resting orders** (anything other than IOC) are refused. A resting order's fill depends on its place in the queue,
which the archive does not record; a guessed queue model inflates market-making returns.

## 4. Settlement

At the market's close, every open position settles at the official outcome: $1 a contract on the winning side, $0
on the losing side, $0.50 on both sides of a Predict.fun tie. Settlement charges no fee.

## 5. Fees

The run's fee policy is one of:

- **venue** (default) — each market's own schedule. Polymarket's crypto markets charge the taker
  `C × rate × p × (1 − p)` in USDC, rounded to five decimals, and charge makers nothing; the archive carries each
  market's `feeSchedule` (on the 2026-09-08 sample: `rate 0.07, exponent 1`). Every fill a backtest makes is a taker
  fill, so every fill pays.
- **bps** — a flat rate on notional, set with `fee_bps` (including 0).

Details that the report's `fee_model` block states:

- *Per level, an estimate.* The venue applies the formula per match — one taker order against one maker order —
  and rounds each. The archive keeps book levels, and a level aggregates maker orders whose sizes are gone, so the
  fee is computed and rounded (half up) per level taken.
- *Known zero vs unknown.* A market that says fees are off is charged nothing and counted as a known zero. A market
  whose schedule we cannot read, or whose curve is not the documented one (`exponent ≠ 1`), is charged nothing and
  counted as unknown. The Predict.fun archive carries no fee schedule, so a Predict.fun run is fee-free unless you
  set `fee_bps`.
- *Maker rebates* are not modelled: a backtest never makes.

Fees are in every trade's PnL and in net PnL. Edge per contract, the Brier score, calibration and the naive
baselines are price measures and are computed before fees.

## 6. No look-ahead

- Events are handed to the strategy one at a time from a stream; the rest of the day is not in the process.
- A market's `outcome` is removed from what `on_market_open` and every event hook can see. Only `on_settle`
  receives it.
- `ctx.book()` is the book as of the current event; `ctx.history()` holds settlement ticks already seen.
- **market mode** (default): each market gets a fresh strategy instance, so nothing carries across markets.
- **session mode**: one instance and one portfolio for the whole run. Markets that overlap in time are replayed
  interleaved, in one global time order (an opening first at a given millisecond, then events in market order,
  then closings). Before each event, every other open market first settles what it had scheduled strictly earlier.
  State carried from one market to another can therefore never be ahead of the clock.

## 7. The report

| block | what it holds |
| --- | --- |
| `metrics` | net PnL, win rate, profit factor, max drawdown (on realised PnL), Sharpe (daily realised PnL, ×√365), peak capital at risk, return on it, holding ratio, edge per contract, Brier score, fees, average hold |
| `calibration` | by entry-price bucket: price paid against the rate at which that side actually won |
| `baselines` | always UP, always DOWN, always the favourite — bought at the opening quote (the first moment both sides are quoted), at the strategy's average size, held to settlement |
| `slippage` | fills at the quote, fills that walked the book, unfilled orders, slippage percentiles, PnL lost to slippage |
| `fee_model` | the fee policy, model, rounding assumption, and markets charged / known zero / unknown |
| `coverage` | market-days scanned, every dropped market-day with its reason, which settlement stream each market used, which days the best-bid/ask refinement applied to |
| `equity` | realised PnL, one point per closed trade (thinned to 2,000 points, keeping every extreme) |

Full trade and fill rows are in `Result.trades` / `Result.fills` (and in the hosted run's archive).

## 8. Limits that apply everywhere

- The per-event budget the hosted sandbox enforces (a sustained mean of 400 µs per hook call) applies locally too,
  so a strategy that would be refused there is refused here.
- One day is a sample, not evidence. Backtest across a range, and compare against the baselines.
