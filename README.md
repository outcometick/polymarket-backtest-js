<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# outcometick backtest · JavaScript / TypeScript

**Tick-level backtesting for Polymarket and Predict.fun crypto Up/Down markets — and, from your own data, any Polymarket binary market — in JavaScript.** Write a
strategy class, replay it locally with the `ot` command line against the archived order book, and submit the
same files to the [hosted backtester](https://outcometick.com/backtest) when you want the full range. Every
market settles at $1 / $0 on the Chainlink stream it actually settled on, and every taker fill pays the venue's
taker fee. Market makers get resting limit orders with a queue model built on how Polymarket actually records
trading, and the markouts to see whether the fills were worth having.

**English** · [简体中文](README.zh-CN.md) · [Methodology](docs/methodology.md) ·
[How we verify it](docs/verification.md) · Python: [polymarket-backtest](https://github.com/outcometick/polymarket-backtest)

> Built by [outcometick.com](https://outcometick.com) — the Polymarket and Predict.fun tick-data archive this
> replays, and the hosted backtester whose engine this is. [More below.](#on-outcometickcom)

```bash
npm i -g outcometick             # Node 24: the ot CLI, the strategy SDK and the data client
ot init my-strategy --template favourite-near-close --lang nodejs
curl -L https://github.com/outcometick/polymarket-tick-data-samples/releases/latest/download/polymarket-data-samples.tar.gz | tar xz
ot check my-strategy             # the exact validator the hosted queue runs
ot run my-strategy --data ./polymarket-data-samples
```

A strategy is a class and a manifest:

```js
// my-strategy/strategy.mjs
import { Strategy, Order } from "outcometick";

export default class Favourite extends Strategy {
  onMarketOpen(ctx, market) {
    this.close = market.close_ts_ms;
    this.done = false;
  }

  onTick(ctx, tick) {
    if (this.done || this.close - ctx.now > 60_000) return null;
    const book = ctx.book();
    const up = book.best("UP");
    const down = book.best("DOWN");
    if (up == null || down == null) return null;
    this.done = true;
    const [side, price] = up >= down ? ["UP", up] : ["DOWN", down];
    if (price < 0.55 || price > 0.95) return null;
    return new Order({ side, notional: 50, limit: 0.95 });
  }
}
```

```json
{
  "schema": 1,
  "language": "nodejs@24",
  "entry": "strategy.mjs:Favourite",
  "hooks": ["on_market_open", "on_tick"],
  "datasets": ["settlement", "book"],
  "intervals": ["5m"]
}
```

`ot run` prints the headline numbers and writes the whole result — report JSON, every trade and fill as CSV,
logs, checksums — to a zip you can open in a notebook. When it looks right:

```bash
export OT_BACKTEST_KEY=bt_...          # from outcometick.com/backtest
ot fingerprint my-strategy --assets btc,eth --from <day> --to <day>   # pre-register: publish this first
ot submit my-strategy --assets btc,eth --from <day> --to <day>
ot status run_...                      # then: ot fetch run_...
```

## What it gets right

**Settlement is the venue's, not an approximation.** A Polymarket crypto market settles on one Chainlink
stream — the instantaneous feed, a 30-second TWAP or a 60-second TWAP — and which one is stated in that
market's own config (`twapLookbackSeconds`), not implied by its date. Every market is replayed against its own
stream and pays $1 or $0 from the official outcome. Predict.fun ties pay 50:50. A market whose stream or outcome
cannot be read is dropped and listed in the report, never settled on a guess.

**Two order books per market.** UP and DOWN are separate tokens with separate bids and asks. Buying UP lifts
UP's asks; getting out sells into UP's bids. (Predict.fun publishes one book per market, so its DOWN side is the
mirror of UP's.)

**Fills walk the depth that was there.** An order is matched against the reconstructed book at that
millisecond, level by level. Size the book did not have is reported as unfilled — it is never filled at the top
of book. With `"latency": 250` in the manifest, every order matches against the book as it stood when it would
have arrived, and a limit still protects it.

**The venue's taker fee, market by market.** Polymarket charges takers `C × rate × p × (1 − p)`; each market's
schedule is in the archive, and every simulated fill pays it. The report states the fee model used and how many
markets had no readable schedule. It is an estimate in one respect, and the report says so: the venue rounds
per maker order matched, the archive keeps book levels, so the fee is computed and rounded per level taken.
`"fee_bps"` in the manifest replaces it with a flat rate.

**Resting orders, queued the way the venue trades.** `new Order({ ..., tif: "gtc" })` rests at its limit behind
the size already visible at that price. The queue model is built on three measured facts about the archive, not
on a generic exchange: the book is *mirrored* (an UP bid at q and a DOWN ask at 1 − q are one queue, published
twice), each trade prints *once, on the taker's token* (so a DOWN buyer taking resting UP bids — a mint —
advances an UP bid's queue; a single-token model misses about half of what consumes it), and a print can arrive
*after* the book update it caused. So a print fills a resting order only if its price reaches the order, out of
one volume budget that first pays for depth the book removed just before it, at that depth's own price; a new
order ignores prints for a short lag window, and a cancelled one stays exposed for it. `"latency"` and
`"cancel_latency"` are separate, maker fills pay no fee (rebates are not modelled), and the JavaScript and Python
engines agree fill for fill. `ctx.orders()` lists working orders, `ctx.cancel(id)` cancels one. The report adds
what a market maker looks at: fill rate, queue position at entry and at fill, time in queue, and markouts 1s /
10s / 60s after each fill and to settlement — adverse selection, in numbers.

**No look-ahead by construction.** Events reach the strategy one at a time; the rest of the day is not in the
process. A market's `outcome` is hidden until `onSettle`. In session mode, markets that overlap in time are
replayed interleaved in one time order, so state carried across markets never runs ahead of the clock.

**Local and hosted are the same code.** `ot run` uses the decoder, engine, harness and report the hosted queue
uses, and `ot check` is the queue's own validator — a strategy it accepts is not rejected on submit for a
validation difference. The JavaScript and Python engines are checked against each other trade by trade. See
[How we verify it](docs/verification.md).

**A report made for binary markets.** Brier score, calibration by entry price, edge per contract, peak capital
at risk, a slippage panel, and naive baselines at the same trade size — always UP, always DOWN, always the
favourite at the opening quote. If a strategy cannot beat buying the favourite, the report says so on page one.

**Honest about the data.** The book is rebuilt from snapshots and deltas captured at a set cadence; the
unthrottled best-bid/ask stream can only remove levels the market has moved past, never add one. Every
market-day that could not be replayed is listed with the reason.

## Your own data: any Polymarket binary market

The archive holds crypto Up/Down markets. For anything else — elections, sports, any market with two outcomes —
point `ot run` at a directory of your own data: `markets.json` (or `.jsonl`) at its top, Polymarket CLOB
market-channel frames in `*.jsonl` / `*.jsonl.gz` under it.

```bash
ot run ./my-strategy --data ./my-polymarket-data
```

- **Markets** are Gamma market objects as the API returns them, or `{market_id, token_ids, labels, ...}`.
- **Frames** are Polymarket's own: `book`, `price_change`, `best_bid_ask`, `last_trade_price`,
  `market_resolved` — raw, or as rows with the frame under `payload`. Every identifier a frame carries must
  agree with one market.
- **Orders can name an outcome** (`side: "Yes"`, `"Lakers"`); a label the market does not have stops the run.
- **Settlement only from evidence** (Gamma's resolution, a `market_resolved` frame, or your own
  `resolution: {outcome, resolved_ts_ms}`, all agreeing). Trading ends the millisecond before the outcome is
  public and the payout lands then. Unresolved markets are valued at the external mid when trading ends
  (`--mark-max-age-ms` refuses an old quote; no mark values a position at 0), reported apart from realised PnL.
- A book row that cannot be read drops the whole market, listed in the report with the reason. The Python
  package also reads the single-book table shape (`Dataset.from_pmdata`).

## Execution options

Off by default; set them in `outcometick.json` (hosted and `ot run` alike): `"fok": true` for fill-or-kill orders,
`"order_rules": "assumed"` (archive: tick 0.001, minimum 5 shares, sizes in 0.01) or `"venue"` (your own data),
`"maker_rebate": 0.2` (an estimate of the venue's rebate on resting fills), `"quote_guard": {"max_age_ms": 1500,
"ask_sum": [0.92, 1.08]}`, and `"mirror_depth": "shared"` for single-book markets. Locally,
`ot run --book-throttle off` replays the archive's book without the per-asset thinning. What each one does, and
what it cannot know, is in [Methodology §10](docs/methodology.md#10-execution-options).

Declaring an `onTimer` hook (with `ctx.schedule(atMs, tag)`) or a `"feed_latency"` puts every market of the run on
one time line: timers wake the strategy at chosen times, and with a feed latency the strategy hears of each event
that much later while orders still match the venue's book
([§11](docs/methodology.md#11-timers-and-feed-latency-one-time-line)). For resting orders,
`"queue_model": {"prob": "power", "n": 2}` (or `power2`, `power3`, `log`, `log2`) estimates how much of an
unexplained size drop left from in front of your order instead of assuming none did — an estimate, so compare it
with the default ([§12](docs/methodology.md#12-probabilistic-queue-models-optional)). `"record_ms": 60000` adds
the account's value on a time grid (open legs at the best bid) and its drawdown — `record.csv` in the archive
([§13](docs/methodology.md#13-the-recorder-mark-to-market-on-a-time-grid)).

## Also in the package

- **`outcometick/data`** — the data-subscription client (list, download with checksum verification) and
  `OrderBook`, which rebuilds a Polymarket book from the archived `book`, `price_change` and `best_bid_ask` rows.
- **`ot mcp`** — an MCP server so Claude Code or Cursor can search the archive, download files and check a
  strategy locally. It never submits a backtest.
- TypeScript declarations for the SDK and the data client.

## Limits

- Resting orders: queue position is an estimate from aggregated book levels (individual maker orders are not
  in the feed), book deltas are thinned to a capture cadence, and your orders have no market impact. They run
  on Polymarket only: the Predict.fun archive has no trade stream to advance a queue, so `gtc` is refused there.
  The independent auditor does not yet re-derive resting-order fills.
- From the archive: 5-minute and 15-minute crypto Up/Down markets. Any other Polymarket binary market runs
  from your own data ([above](#your-own-data-any-polymarket-binary-market)); the hosted backtester runs archive data only.
- The Binance reference feed lives on the hosted runner, so strategies that read it are submitted, not run
  locally.
- One sample day says nothing about next month. Backtest over a range before trusting any number.

## On outcometick.com

- **The data behind it.** A [tick-level archive of Polymarket and Predict.fun](https://outcometick.com) crypto
  Up/Down markets: order-book snapshots and deltas, trades, best bid/ask, market metadata, and the Chainlink
  streams the markets settle on, published daily. `ot run --data` reads a downloaded day directly. The free sample
  is also on [GitHub](https://github.com/outcometick/polymarket-tick-data-samples), Kaggle and Hugging Face.
- **The hosted backtester.** [outcometick.com/backtest](https://outcometick.com/backtest): a browser editor or
  `ot submit`, recent weeks on our machines with nothing to download — paid per market-day scanned, and a run
  that produces no report costs nothing.
- **Settlement audit.** [Market by market](https://outcometick.com/polymarket-settlement-audit), the outcome
  recomputed from the archived Chainlink stream and compared with the venue's.
- 中文站：[outcometick.com/zh](https://outcometick.com/zh)

## Community

Questions, strategy ideas, or a backtest result to compare notes on:

- Discord (English and 中文): https://discord.gg/ZDMqkptwm5
- Telegram: https://t.me/+TcK_hJOzOz5mZTk1

## This repository

The `outcometick` npm package as source, with its tests (`npm install && npm test`): the `ot` CLI (`cli/`), the
engine and harnesses (`runner/`), the shared archive decoder and contract (`runner/events.mjs`, `api/lib/`), the
data client (`client/`), and the strategy templates (`templates/`). `examples/` holds runnable strategies.

Generated from the outcometick monorepo, where the same code runs the hosted backtester; the npm release comes
from [outcometick-sdk-ts](https://github.com/outcometick/outcometick-sdk-ts). Issues and pull requests are
welcome here.

License: MIT.
