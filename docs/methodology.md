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
  adds a level, because a level without a size would be invented liquidity. It does not reach a hook. It is on
  whenever `book` is declared: the `bbo` dataset comes with it.

What this cannot restore: between snapshots, a level added or resized in a delta that the cadence dropped is
missing or stale until the next snapshot. That applies at the top of the book as well as below it.

How much that is, measured against the venue's full stream over 24 hours of live Polymarket crypto markets
(2026-10-11 to 2026-10-12, replayed in backtest order): the best price rebuilt from the archive's book differed
from the venue's at 50.6% of sampled moments, and at 36.5% with `best_bid_ask` applied. Most of what remains is a
better level added in a dropped delta, which a price-only stream cannot add back. The report's `book_age` block
(section 7) shows how much of a run's taker size came from levels last set more than a second before the fill.

## 3. Orders and fills

A hook returns an `Order` (or a list, or nothing):

| field | meaning |
| --- | --- |
| `side` | `"UP"` or `"DOWN"` — which token |
| `size` | contracts; or `notional` (dollars) with a `limit`, giving `floor(notional / limit)` contracts (0 contracts raises: skip an order whose budget is below the limit price) |
| `limit` | a ceiling when buying, a floor when selling; levels beyond it are not taken |
| `reduce_only` | sell into the bids of a token you hold, at most what you hold |
| `hold_s` | flatten this many seconds after the fill |
| `tif` | `"ioc"` (the default), or `"gtc"` for a resting order (Polymarket; below) |

**Matching** walks the book from the best level outward and consumes what it takes, so two orders in one event
cannot fill against the same depth. What the book does not have is reported as unfilled. The fill row records the
price on the screen when the order was sent (`quoted_px`), the average and worst price paid, and the levels walked
— the slippage panel is built from these.

**Latency.** With `latency_ms`, an order decided at `t` is matched at `t + latency`. Anything scheduled strictly
before an event resolves against the book as it stood before that event; anything scheduled at the event's own
millisecond resolves after the event has been applied. An order still pending when the market closes did not
land.

**Resting orders** (`tif: "gtc"`, Polymarket only) are filled by a queue model, `polymarket-queue-v1`. A resting
order's fill depends on its place in the queue, which no public feed records, and an optimistic guess inflates
market-making returns by multiples — so the model is built from what the archive does record, and every ambiguity
is resolved against the strategy.

*What the archive says, measured.* On the public sample day (BTC 5-minute, 2026-09-08), joined against the
venue's own per-match trade records:

- The book is **mirrored**. Every `price_change` carries a pair: a bid for UP at q and an ask for DOWN at 1 − q,
  same size. They are one queue, published twice. Every own order is therefore placed in one canonical queue,
  UP's view: buying DOWN at q sits with the UP asks at 1 − q, selling DOWN at q with the UP bids at 1 − q.
- A trade **prints once, on the taker's token**: 480,491 prints, 480,491 distinct transaction hashes, and in a
  market joined trade by trade, 1,138 of 1,138 prints carried the taker's token, the taker's direction and the
  taker's total size. The price is a maker price — of a multi-level sweep, sometimes the best and sometimes the
  worst. Makers sit on either token: in that market 555 of the 1,138 prints were pure mints (a DOWN buyer filled
  by resting UP bids). A resting UP bid is consumed by UP sell prints at its price **and** DOWN buy prints at
  1 − its price.
- Trades and the top of book are stored in full; book deltas are thinned per market (dropped, not merged — each
  kept delta still states the true size of its level at that instant); snapshots are thinned per token.
- A print can **trail the book update it caused**. For about a quarter of taker-buy prints the full-rate top of
  book already showed the level gone before the print's own timestamp (99.9th percentile of that lead: 702 ms for
  taker buys, 639 ms for taker sells, on observed transitions).

*The rules.*

1. **Join.** An order that reaches the venue (after `latency`) takes liquidity first if it is marketable on its
   own token, exactly like an IOC (or is refused, with `post_only`); the remainder rests behind the size visible
   at its price on the canonical ladder. Own orders at the same price queue in arrival order; two own orders that
   would cross each other are refused.
2. **Reach.** A print fills only orders at prices at least as good as its own price. The print's price may be the
   best of a sweep, so nothing beyond it is assumed reached.
3. **One volume budget per print.** Walking the reached prices best first, the print's size pays, in order: depth
   the book removed within the lag window before the print, at that depth's own price (the depletion ledger — the
   print that explains a book update must not be able to reach past the volume that update removed); the external
   queue in front of each own order; the order itself; the rest of the level. Own fills plus everything else never
   exceed the size that printed.
4. **Book updates shorten, never fill.** After any book event an order's queue estimate is capped at the visible
   size of its level — whatever was in front of it and still rests is visible. A missed add in a thinned delta
   stream can make a level look shorter than it was; that is the one direction this rule can err, and it is
   disclosed. A book that crosses a resting order does not fill it (an absolute size is not arriving aggressive
   volume); such crossings are counted in the report.
5. **Lag window, both ways** (`print_lag_ms`, 800 ms: the measured 99.9th percentile above, rounded up). A new
   order ignores every print stamped within the window after it rests — that print may describe a match from
   before it existed. A cancelled order stays exposed for the window after the cancel lands (`cancel_latency`) — a
   print in it may describe a match from before the cancel. The second rule is a stress assumption and is labelled
   one.
6. **Close.** Every order still working at the close expires before settlement, including ones that had not
   reached the venue yet. Nothing fills after the close.

Fills are at the order's own limit. The model is the same code in both engines and the conformance suite compares
them fill for fill, including queue and markout fields. The report's `maker` block carries the counters (rested,
filled, cancelled, expired, refused, volume held back by the lag window, book crossings), fill rate by size and by
order, median queue ahead at entry and at fill, median time in queue, and markouts: the mid of the fill token 1 s,
10 s and 60 s after each fill (from the latest book at or before that instant, null if that book is more than 5 s
old or the horizon passes the close), and to settlement, all per share and signed for the holder. The independent
auditor does not yet re-derive resting-order fills and refuses such reports with its own exit code rather than
passing them.

## 4. Settlement

At the market's close, every open position settles at the official outcome: $1 a contract on the winning side, $0
on the losing side, $0.50 on both sides of a Predict.fun tie. Settlement charges no fee.

## 5. Fees

The run's fee policy is one of:

- **venue** (default) — each market's own schedule. Polymarket's crypto markets charge the taker
  `C × rate × p × (1 − p)` in USDC, rounded to five decimals, and charge makers nothing; the archive carries each
  market's `feeSchedule` (on the 2026-09-08 sample: `rate 0.07, exponent 1`). Taker fills pay it; resting-order
  (maker) fills pay nothing, and the venue's maker rebate — paid from a pool, not per fill — is not modelled.
- **bps** — a flat rate on notional for every fill, taker or maker, set with `fee_bps` (including 0).

Details that the report's `fee_model` block states:

- *Per level, an estimate.* The venue applies the formula per match — one taker order against one maker order —
  and rounds each. The archive keeps book levels, and a level aggregates maker orders whose sizes are gone, so the
  fee is computed and rounded (half up) per level taken.
- *Known zero vs unknown.* A market that says fees are off is charged nothing and counted as a known zero. A market
  whose schedule we cannot read, or whose curve is not the documented one (`exponent ≠ 1`), is charged nothing and
  counted as unknown. The Predict.fun archive carries no fee schedule, so a Predict.fun run is fee-free unless you
  set `fee_bps`.
- *Maker rebates* are not part of the venue policy: the venue pays them from a pool, not per fill. Setting
  `maker_rebate` (section 10) credits an estimate.

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
| `metrics` | net PnL, win rate, profit factor, max drawdown (on realised PnL), Sharpe and Sortino (daily realised PnL, ×√365; Sortino against the downside, target 0), net PnL over max drawdown, trading days / winning days / best and worst day, peak capital at risk, return on it, holding ratio, edge per contract (share-weighted) and edge per trade (each settled trade counts once — the two can have opposite signs), Brier score, fees, average hold |
| `by_settlement` | the same results per settlement rule (the stream each market settles on: instantaneous, 30 s or 60 s TWAP), with every market counted, entered or not — markets on different rules are reported side by side, never only blended |
| `activity` | contracts and dollars that changed hands, taker and maker, from the fill log |
| `fingerprint` | the pre-registration fingerprint (below) |
| `calibration` | by entry-price bucket: price paid against the rate at which that side actually won |
| `baselines` | always UP, always DOWN, always the favourite — bought at the opening quote (the first moment both sides are quoted), at the strategy's average size, held to settlement |
| `slippage` | fills at the quote, fills that walked the book, unfilled orders, slippage percentiles, PnL lost to slippage |
| `fee_model` | the fee policy, model, rounding assumption, and markets charged / known zero / unknown |
| `coverage` | market-days scanned, every dropped market-day with its reason, which settlement stream each market used, which days the best-bid/ask refinement applied to |
| `book_age` | taker size by the age of the book level it took: fill time minus when that level was last set by a snapshot or delta (archive markets only) |
| `equity` | realised PnL, one point per closed trade (thinned to 2,000 points, keeping every extreme) |

Full trade and fill rows are in `Result.trades` / `Result.fills` (and in the hosted run's archive). `Result.markets`
(`markets.csv` in an archive) has one row per market replayed **including every market the strategy never
entered** — market id, asset, length, settlement rule, open and close, strike, outcome, opening quotes, whether it
was entered, trades, contracts, PnL, fees, first entry and both edges — which is what a market-level confidence
interval or a permutation test on outcomes needs.

**Pre-registration.** `report.fingerprint.sha256` is one hash over every file of the strategy directory byte for
byte (code, a config file it reads, its series and `outcometick.json` itself — `code_sha256`; reformatting the
manifest is a different fingerprint, because the strategy could read the difference), the manifest's defaults
spelled out, the params, the execution options, the bytes of every declared series, the scope (venue, assets, and every day run, in order — dropping one day from the middle
is a different fingerprint), your own data's bytes (generic data: the markets file and every frame file,
`data_sha256`), the local replay settings (`book_throttle`, `mark_max_age_ms`), the fee policy actually applied,
the implementation (engine image tag and decoder version — an upgrade that changes results changes the
fingerprint) and the seed. Compute it before
running — `ot fingerprint <dir> --assets … --from … --to …` (or `--data <your-dataset>`), or
`outcometick.backtest.fingerprint(path, assets=…, days=[…])` — and publish it; the report of the run you then make
carries the same value, from the hosted queue, `ot run` or the Python runner alike. A strategy passed as an
in-process Python class has no code files, so its fingerprint covers everything except the code (`code_sha256` is
null). The archive files a run actually read are reported next to it as `inputs_sha256` (sorted
`path:sha256` lines, hashed): it cannot be part of the pre-registered value, because which files a day needs is
known only once its markets are read, but it shows exactly which bytes produced the report — the hosted catalog's
checksums and a local archive's files give the same value for the same files.

`run()` and `run_template()` execute the strategy inside your Python process: the files are hashed and loaded
from one snapshot, bytecode caches and earlier strategy modules are set aside, and a directory that changes
during the run is refused — but process-wide state (a library the strategy monkeypatches, globals left by
earlier code) is shared and not covered by the fingerprint. For a fully isolated, reproducible run use `ot run`
(a fresh process per run) or the hosted backtester (a container).

## 8. Limits that apply everywhere

- The per-event budget the hosted sandbox enforces (a sustained mean of 400 µs per hook call) applies locally too,
  so a strategy that would be refused there is refused here.
- One day is a sample, not evidence. Backtest across a range, and compare against the baselines.

## 9. Your own data (any Polymarket binary market)

The same engine, fills, fees and report, on data you bring: a markets file (Gamma market objects, or
`{market_id, token_ids, labels, ...}`) and Polymarket CLOB market-channel frames. What differs from the archive,
and why:

- **Order within a millisecond is the input's.** Events sort by time, then by input position (file, line,
  position in a `price_changes` batch). The archive sorts a millisecond by kind because its files are read in an
  arbitrary order; a recorded stream is not. For the same reason a best-bid/ask bound removes a level set in the
  same millisecond before it.
- **Strict parsing.** A book, delta or bound row that cannot be read — a price outside [0, 1], a side other than
  BUY/SELL, two levels at one price, a token the market does not own, identifiers naming two markets — drops the
  whole market, listed with the reason and the input position. A bad trade row is dropped and counted.
- **A window that opens mid-stream** starts from the book as it stood: every earlier book row is folded into one
  snapshot at the window's start.
- **Resolution only from evidence**: Gamma's `umaResolutionStatus: resolved` with `outcomePrices` exactly
  1/0, 0/1 or 0.5/0.5 (Polymarket's 50:50), a `market_resolved` frame, or a `resolution` you supply. Sources
  must agree, or the market is dropped; a resolution without a time is dropped too, because it cannot say when
  trading had to stop. The time used is the frame's when there is one (observed), else yours, else Gamma's.
- **Lifecycle.** Trading ends at the first of: your declared trading end, the millisecond before the outcome
  became public, the last event. Events after it are dropped before the replay; orders still in flight expire;
  resting orders expire. A resolved market pays at its resolution time (in session mode, cash arrives then).
- **Valuation.** An unresolved market's open positions are valued when trading ends at a mark computed from the
  market data only — the UP token's mid, else 1 − the DOWN token's mid, else the last public print — each
  candidate checked against `mark_max_age_ms` before the next is tried. A hedged pair is worth exactly $1.
  Cash does not move: the report's `valuation` block separates `realised_pnl` from `marked_pnl`, lists every
  position valued at 0 for want of a mark, and states the oldest mark used. These rows are not scored for
  Brier, edge or calibration (only held-to-settlement rows are), and the baselines use resolved markets only,
  with the strategy's own result on those markets (`strategy_on_resolved`) beside them.
- **The single-book table shape** (Python, `Dataset.from_pmdata`) carries one book; the other outcome is its
  mirror, and each update moves both in one step. Trades come from the trades table only, so each public print
  is counted once.
- **Known simplification**: on any mirrored book (this one, and Predict.fun's), an immediate order on each of the
  two outcomes consumes its own copy of the depth, so the same source liquidity can be taken twice. Resting
  orders already share one queue and one print budget.

## 10. Execution options

All off by default — a run that sets none of them replays exactly as before. Same keys in the manifest, in
`run(...)` / `run_template(...)`, hosted and local; both engines implement each one and the conformance suite
compares them trade by trade.

- **`fok: true`** enables `tif: "fok"`: the whole size must be available within the limit when the order reaches
  the book (measured before anything is taken), or nothing fills. A refused order is a fill row with
  `reject_reason: "fok_unfilled"`. Declared up front so every output knows its columns before the first row.
- **`order_rules`** holds orders to the venue's rules: the size is at least the minimum and on the 0.01-share grid,
  the limit is on the tick grid, and a notional converts to hundredths of a share (an SDK `Order` built with
  a notional converts to whole shares when it is built — still on the grid; a plain order object's notional is
  converted by the runner). An exit is clamped to the
  position and floored to the grid before it is checked, so a dust position below the minimum is held to
  settlement, as it would be on the venue. `"venue"` reads each market's own tick and minimum (your own data);
  `"assumed"` is for the archive, whose markets do not carry them: tick 0.001 and minimum 5 shares, the values
  measured on the archive. The report says it is an assumption — a market quoting in 0.01 would refuse a 0.001
  limit accepted here, one quoting finer would accept limits refused here. Refusals are counted by reason (`below_min_size`, `size_step`,
  `off_tick`).
- **`maker_rebate`** (a fraction, e.g. 0.2) credits each resting fill with that share of the taker fee the same
  fill would have cost, as a negative fee. An estimate: the venue pays maker rebates from a daily pool, pro rata,
  and the report says so.
- **`quote_guard`** — `{max_age_ms, ask_sum: [lo, hi]}` — lets an opening taker order execute only when both
  outcomes have a best ask and their sum is in range, and all four best quotes were set within `max_age_ms`
  (a missing quote fails). A resting order that fails it is refused whole, so it cannot rest and fill later.
  Exits are not blocked unless the guard sets `include_exits: true` — a guard that blocks an exit holds the
  position to settlement. Ages are exchange-time ages of the level (`ctx.book().quote_ts(side)`).
- **`mirror_depth: "shared"`** is for single-book markets (Predict.fun, and data read with `from_pmdata`): an
  outcome's ask at p and the other's bid at 1 − p are one liquidity, so taking one removes the other.
- **Local only:** `book_throttle=False` (`ot run --book-throttle off`) replays the archive's book stream without
  the per-asset thinning the hosted runs apply. Passing it either way writes `coverage.book_throttle`, the window
  actually used per asset or `"off"`. The archive's stream was already rate-limited when it was captured, so
  "off" is the densest the archive has, not every update the venue sent.

The report's `orders` block lists the options used, what they refused and the rebate total.

## 11. Timers and feed latency (one time line)

Declaring the `on_timer` hook or a `feed_latency` puts the run on a single time line across every market in
it. Each market's pending work — orders and cancels reaching the venue, timers, lagged events reaching the
strategy — is a job at a time; before anything at time T is processed, every job strictly earlier runs, in
every market, earliest first (at one millisecond: exchange jobs, then arrivals, then timers; then the market's
position in the run; then the order they were made). Jobs due exactly at T run after everything the data says
happened at T. So a strategy shared across overlapping markets never sees its clock go back, and a timer at
150 never sees a reference row stamped 151.

- **Timers.** `ctx.schedule(at_ms, tag)` wakes `on_timer(ctx, timer)` at that time, with `ctx.now = at_ms`; it may
  return orders like any hook. `at_ms` must be after now and not after the market's declared close; a market
  opens at its own open time, so `on_market_open` can schedule from there. Limits per market: 64 pending,
  10,000 set, 100,000 fired. Timers still pending when trading ends are dropped and counted
  (`report.timers`).
- **A ctx kept from another market** (session mode) acts at the run's time, not that market's last event:
  a timer it sets must be after the run's current time, and a cancel it sends happens from then on.
- **Feed latency.** With `feed_latency: L`, every event reaches the strategy L ms after it happened: hooks fire
  then, and `ctx.book()`, `ctx.history()` and the position's mark show the market as the strategy has heard
  of it. Orders, resting-order queues and the quote guard always use the venue's own book at the moment they
  act. Fills are known to `ctx.position()` when they happen — there is no separate order-response latency.
- Without either, runs take the per-market path they always took, byte for byte.

## 12. Probabilistic queue models (optional)

Rule 4 of section 3 assumes the worst about a level that shrinks with no trade to explain it: everything that
left was behind your order. `queue_model` replaces that with an estimate of how much left from in front, in the
shape hftbacktest popularised: with `a` in front of the order and `b` behind it, the share from behind is

| `prob` | share from behind |
|---|---|
| `power` (`n` 1–10) | `b^n / (b^n + a^n)` |
| `power2` (`n` 1–10) | `(b / (a + b))^n` |
| `power3` (`n` 1–10) | `1 − (a / (a + b))^n` |
| `log` | `ln(1+b) / (ln(1+b) + ln(1+a))` |
| `log2` | `ln(1+b) / ln(1+a+b)` |

and an unexplained drop `c` moves the order to `a − (1 − p)·c + min(0, b − p·c)`, never past the visible size.

What counts as *unexplained* is decided on the archive alone, where your orders do not exist. A print removes
volume from the levels it reaches (consuming first any book drop it explains, the depletion ledger); what it
removed and the book has not shown yet waits, per price, for the next drop there, which absorbs it once. Only the
remainder of a drop is ledgered and handed to the model. A bbo bound only caps the queue (a pruned crossed level
says nothing about where in it volume left). Each order keeps its own history on top: the waterfall of section 3
advances it, the entry window still applies, so an order's queue can lag what the archive level knows — that only
ever errs against it.

Limits, stated plainly: both waiting lists live `print_lag_ms` (800 ms), a heuristic window — a book drop arriving
after the print's entry expired is read as a cancellation; a print masked by a same-size refill within one book
update waits until it expires. The model's shares are an assumption the archive cannot check. The default stays
the conservative queue; run both and compare. The report names the model (`maker.queue_model`
`polymarket-queue-v1+prob-v1`, `maker.queue_prob`). The functions use only `+ − × ÷` in a fixed order (no library
`pow` or `log`), so both engines produce the same bits, and the conformance suite checks them bit for bit.

## 13. The recorder (mark-to-market on a time grid)

`record_ms: N` (market mode, 1000–3,600,000) writes each market's value every N milliseconds of UTC time: the cash
the market has cost or paid so far, plus every open leg at its token's best bid (depth ignored; a leg with no bid
counts 0 — what selling now would fetch, never a mid or a cost). One rule makes each point exact: before any change
at time t — an order or cancel reaching the venue, an event, a timer, a terminal mark, the settlement — every grid
point before t is written, so a point is the state after everything at or before it and nothing later; after the
settlement, one final sample. Recording reads the ledger and the book only and changes no fill (tested off/on in
both engines).

The report's `record` block sums every market on the grid (a market counts 0 before its first point and its final
value after it): points, final value, the maximum drawdown of that account value (peak starting at 0) and when,
the worst point, the largest and the mean open-position value. It sees what the realised-PnL drawdown in `metrics`
cannot — a loss an open position carried before it closed. `record.csv` has the account series and
`record_markets.csv` every market's samples (`Result.record` / `record_markets` in Python). A run that would
write more than 1,000,000 rows or 256 MiB of samples stops recording and reports `truncated` with no series — never
a partial curve; the hosted backtester refuses such a scope at submit and names the smallest `record_ms` that fits.

## 14. Spot and the locked part of the settlement TWAP (optional)

Polymarket's 5- and 15-minute crypto markets settle on Chainlink's 60-second TWAP at the close
(`raw.cryptoMarketConfig.twapLookbackSeconds`). In the last minute part of that average is already fixed, and a
strategy may want to know how much and at what level.

**The `spot` dataset.** Declaring it feeds each market the 1 Hz Chainlink report stream of its asset (the archive's
`prices` tree) inside the market's window, whatever stream the market settles on. It is quiet: it wakes no hook, is
not a tick, never enters `ctx.history()` or the rolling helpers, and is not counted as an event seen. Within a
millisecond a spot value is applied before the book, trades and ticks, so a hook on that millisecond reads it (a
tie-break, not a recorded order). Under a feed latency it reaches the strategy late like every other event.
Polymarket only; outside its capture window a run is refused. The report's `spot` block counts the markets that got
any spot value and those that got none.

Both read only values stamped at or before `ctx.now`, like `ctx.ref()`: a ctx kept from another market in session
mode answers for its own clock, not a mix of later values and an earlier time.

**`ctx.spot()`** returns the latest spot value that has reached the strategy, `{value, ts_ms}`, or null.

**`ctx.twap_locked()`** reads the window `[close - lookback, close)` (lookback from the market's settlement stream:
60 s for `twap60s`, 30 s for `twap30s`; null for a market that does not settle on a TWAP, before the window opens, or
before any spot value in it has arrived):

- `value`: the mean of the window's spot samples seen so far, one per feed timestamp (the first to arrive), no
  interpolation over gaps;
- `samples`; `elapsed_ms` since the window opened (capped at the lookback); `elapsed_fraction` = elapsed_ms / lookback
  — time elapsed, not certainty;
- `coverage` = samples / elapsed whole seconds, capped at 1 — the archive misses some seconds;
- `last_ts_ms`: feed time of the latest spot value seen;
- `projected` = elapsed_fraction × value + (1 − elapsed_fraction) × latest spot: the final average *if the price
  stayed where it is*. Not a forecast. null when coverage is below 0.8 or the latest spot value is more than 5 s old.

**It is an approximation.** Chainlink averages finer observations than this per-second stream. On one BTC day we
measured (6,675 complete windows), recomputing the official twap60s from the archived spot stream over
`[t - 60 s, t)` matched exactly never; the error was $0.51 at the median, $3.45 at the 99th percentile and $6.35 at
worst. Settlement in the backtest never uses this: markets settle on their official outcome (§4). Event times are the
feed's own (`feed_ts_ms`), as for every tick; set `feed_latency` to model when you would have heard of a value.

