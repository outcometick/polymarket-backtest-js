<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# outcometick backtest · JavaScript / TypeScript

**Tick-level backtesting for Polymarket and Predict.fun crypto Up/Down markets, in JavaScript.** Write a
strategy class, replay it locally with the `ot` command line against the archived order book, and submit the
same files to the [hosted backtester](https://outcometick.com/backtest) when you want the full range. Every
market settles at $1 / $0 on the Chainlink stream it actually settled on, and every fill pays the venue's taker
fee.

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
ot submit my-strategy --assets btc,eth --days 30
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

## Also in the package

- **`outcometick/data`** — the data-subscription client (list, download with checksum verification) and
  `OrderBook`, which rebuilds a Polymarket book from the archived `book`, `price_change` and `best_bid_ask` rows.
- **`ot mcp`** — an MCP server so Claude Code or Cursor can search the archive, download files and check a
  strategy locally. It never submits a backtest.
- TypeScript declarations for the SDK and the data client.

## Limits

- Orders take liquidity (IOC). Resting limit orders need a queue-position model; a guessed one inflates
  market-making returns, so they are refused rather than approximated. A conservative queue model is next.
- 5-minute and 15-minute crypto Up/Down markets, the ones the archive holds.
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

## This repository

The `outcometick` npm package as source, with its tests (`npm install && npm test`): the `ot` CLI (`cli/`), the
engine and harnesses (`runner/`), the shared archive decoder and contract (`runner/events.mjs`, `api/lib/`), the
data client (`client/`), and the strategy templates (`templates/`). `examples/` holds runnable strategies.

Generated from the outcometick monorepo, where the same code runs the hosted backtester; the npm release comes
from [outcometick-sdk-ts](https://github.com/outcometick/outcometick-sdk-ts). Issues and pull requests are
welcome here.

License: MIT.
