// The two engines must agree, row for row.
//
// Python strategies get a Python engine because an IPC round trip per event
// cannot fit inside a 400 microsecond budget. That means two implementations of
// the same matching rules, and two implementations drift — silently, and in a
// way that makes a report depend on which language the customer happened to
// write in.
//
// This is the thing that stops it. Each scenario below is run through BOTH
// harnesses as real subprocesses over an identical job directory, and every
// trade and fill is compared field by field. A change to one engine that is not
// mirrored in the other fails here.
//
// Equivalent strategies are written twice on purpose. Generating one from the
// other would test the generator, not the engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL, parseTrade, parseFill, parseResult, parseOutputLine } from '../harness/protocol.mjs';
import { LIMITS } from '../../api/lib/backtest-contract.mjs';
import { sessionLines } from '../session-feed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_HARNESS = path.join(HERE, '..', 'harness', 'node', 'harness.mjs');
const PY_HARNESS = path.join(HERE, '..', 'harness', 'python', 'harness.py');
const PYTHON = process.env.OT_PYTHON || 'python3';

// The event builders by name, for tests outside run() (assigned below, after they are defined).
const BUILDERS_FOR_TESTS = {};
const MARKET = {
  market_id: '0xconf', asset: 'BTCUSD', interval: '1h',
  strike: 65000, outcome: 'UP', close_ts_ms: 100_000,
};

const book = (ts, up) => ({
  kind: 'book', ts_ms: ts, snapshot: true,
  levels: {
    UP: { asks: up.asks, bids: up.bids },
    DOWN: {
      asks: up.bids.map(([p, s]) => [Number((1 - p + 0.004).toFixed(4)), s]),
      bids: up.asks.map(([p, s]) => [Number((1 - p - 0.004).toFixed(4)), s]),
    },
  },
});
const tick = (ts, value) => ({ kind: 'tick', ts_ms: ts, market_id: '0xconf', value });

/**
 * The same book, published ONE SIDE PER ROW, the way Polymarket does.
 *
 * Both harnesses have to arrive at the same state from it, and neither may
 * treat the absent side as an instruction to clear that side — which is what an
 * empty ladder means to `Book.snapshot`. The ask ladders are DESCENDING here on
 * purpose: the archive sorts that way on one venue and the other way on the
 * other, so anything that reads element zero disagrees with anything that finds
 * the lowest.
 */
const sided = (ts, side, asks, bids) => ({
  kind: 'book', ts_ms: ts, snapshot: true, side,
  levels: { [side]: { asks: [...asks].reverse(), bids } },
});

/** A book that thins and moves, so fills walk and delays matter. */
function scenarioEvents() {
  const ev = [];
  let px = 0.42;
  for (let i = 0; i < 40; i += 1) {
    const ts = 1000 + i * 500;
    px = Number((px + (i % 7 === 0 ? 0.013 : -0.004)).toFixed(4));
    const asks = [
      [px, 120 + (i % 5) * 40],
      [Number((px + 0.01).toFixed(4)), 300],
      [Number((px + 0.03).toFixed(4)), 2000],
    ];
    const bids = [
      [Number((px - 0.012).toFixed(4)), 150 + (i % 3) * 60],
      [Number((px - 0.022).toFixed(4)), 400],
      [Number((px - 0.05).toFixed(4)), 2500],
    ];
    ev.push(book(ts, { asks, bids }));
    ev.push(tick(ts, 65000 + i * 37 - (i % 5) * 90));
  }
  return ev;
}

/** The same walk, published the way Polymarket actually publishes it. */
function oneSidedEvents() {
  const ev = [];
  let px = 0.42;
  for (let i = 0; i < 40; i += 1) {
    const ts = 1000 + i * 500;
    px = Number((px + (i % 7 === 0 ? 0.013 : -0.004)).toFixed(4));
    const asks = [
      [px, 120 + (i % 5) * 40],
      [Number((px + 0.01).toFixed(4)), 300],
      [Number((px + 0.03).toFixed(4)), 2000],
    ];
    const bids = [
      [Number((px - 0.012).toFixed(4)), 150 + (i % 3) * 60],
      [Number((px - 0.022).toFixed(4)), 400],
      [Number((px - 0.05).toFixed(4)), 2500],
    ];
    ev.push(sided(ts, 'UP', asks, bids));
    ev.push(sided(ts, 'DOWN',
      bids.map(([p, s]) => [Number((1 - p + 0.004).toFixed(4)), s]),
      asks.map(([p, s]) => [Number((1 - p - 0.004).toFixed(4)), s])));
    ev.push(tick(ts, 65000 + i * 37 - (i % 5) * 90));
  }
  return ev;
}

/** An unthrottled top-of-book BOUND: prices, no sizes, deletes only. */
const bboEv = (ts, side, bid, ask) => ({
  kind: 'book', ts_ms: ts, snapshot: false, bbo: true, side, bid, ask,
});
/** One delta, the way price_change arrives. */
const deltaEv = (ts, side, ladder, px, size) => ({
  kind: 'book', ts_ms: ts, snapshot: false, side, ladder, px, size,
});

/**
 * A book that goes stale, and the bounds that clean it up.
 *
 * Built so the two engines cannot agree by both doing nothing: the pruning
 * CHANGES THE FILL PRICE. Levels at 0.40 and 0.42 are left on the ladder from
 * an earlier snapshot, a bound then says nothing better than 0.45 exists, and
 * an order placed afterwards has to fill at 0.45. An engine that skips pruning
 * fills at 0.40 and the two reports diverge on every number downstream.
 *
 * Three behaviours in one fixture, each of which has its own way of going
 * wrong in only one language:
 *   1. stale levels strictly better than the bound are deleted;
 *   2. a level stamped the SAME millisecond as the bound SURVIVES, so the
 *      result does not depend on how a tie was sorted;
 *   3. `bid = 0` with `ask = 1` — how the venue writes "no quotes" — clears
 *      that token outright rather than being discarded as out of range.
 */
function bboEvents() {
  return [
    book(1000, {
      asks: [[0.40, 100], [0.42, 200], [0.45, 500]],
      bids: [[0.38, 100], [0.36, 200]],
    }),
    tick(1000, 65000),
    tick(1500, 65010),
    // Nothing better than 0.45 rests on the asks, nothing better than 0.38 on
    // the bids. 0.40 and 0.42 are stale and go; 0.36 is worse than the bound
    // and stays, which is what stops this being "delete everything".
    bboEv(2000, 'UP', 0.38, 0.45),
    tick(2000, 65020),
    // A fresh level and a bound stamped the same instant. The level must
    // survive: the archive does not say which came first.
    deltaEv(2500, 'UP', 'asks', 0.41, 300),
    bboEv(2500, 'UP', 0.38, 0.45),
    tick(2500, 65030),
    // "No quotes at all" on the other token, written the way the venue writes
    // it. A [0.001, 0.999] domain check would drop this row and leave a ladder
    // that the venue has already emptied.
    bboEv(3000, 'DOWN', 0, 1),
    tick(3000, 65040),
    tick(3500, 65050),
  ];
}

/**
 * A mirrored market that resting orders can live in.
 *
 * The book is published the way Polymarket publishes it (UP bids at q are DOWN
 * asks at 1−q), it moves, levels shrink through deltas BEFORE the prints that
 * explain them arrive, the top-of-book stream prunes, and prints come on BOTH
 * tokens — a DOWN buyer consumes resting UP bids. Every path of the queue model
 * is exercised: entry window, ledger, waterfall across prices, cancel window,
 * reduce-only clamp, markouts.
 */
function makerEvents() {
  const ev = [];
  const mirror = (ts, upBids, upAsks) => ({
    kind: 'book', ts_ms: ts, snapshot: true,
    levels: {
      UP: { bids: upBids, asks: upAsks },
      DOWN: {
        bids: upAsks.map(([q, s]) => [Number((1 - q).toFixed(4)), s]),
        asks: upBids.map(([q, s]) => [Number((1 - q).toFixed(4)), s]),
      },
    },
  });
  const trade = (ts, side, taker, px, size) => ({ kind: 'trade', ts_ms: ts, market_id: '0xconf', side, taker, px, size });
  let mid = 0.45;
  for (let i = 0; i < 60; i += 1) {
    const ts = 1000 + i * 700;
    mid = Number((mid + (i % 9 === 0 ? 0.011 : (i % 4 === 0 ? -0.006 : 0.002))).toFixed(3));
    const b1 = Number((mid - 0.01).toFixed(3));
    const a1 = Number((mid + 0.01).toFixed(3));
    if (i % 5 === 0) {
      ev.push(mirror(ts, [[b1, 80 + (i % 3) * 30], [Number((b1 - 0.01).toFixed(3)), 300]],
        [[a1, 90 + (i % 4) * 25], [Number((a1 + 0.01).toFixed(3)), 400]]));
    } else {
      // A level shrinks (the book shows the trade first) ...
      ev.push(deltaEv(ts, 'UP', 'bids', b1, 40 + (i % 6) * 10));
      ev.push(deltaEv(ts, 'DOWN', 'asks', Number((1 - b1).toFixed(3)), 40 + (i % 6) * 10));
    }
    ev.push(tick(ts + 1, 65000 + i));
    // ... and the prints follow, on both tokens and both directions.
    ev.push(trade(ts + 120, 'UP', 'SELL', b1, 35 + (i % 7) * 9));
    ev.push(trade(ts + 260, 'DOWN', 'BUY', Number((1 - b1).toFixed(3)), 20 + (i % 5) * 11));
    ev.push(trade(ts + 400, 'UP', 'BUY', a1, 30 + (i % 3) * 17));
    ev.push(trade(ts + 520, 'DOWN', 'SELL', Number((1 - a1).toFixed(3)), 15 + (i % 4) * 8));
    if (i % 11 === 3) ev.push(bboEv(ts + 600, 'UP', Number((b1 - 0.02).toFixed(3)), a1));
  }
  return ev;
}

/**
 * A generic-data market's stream (runner/generic-data.mjs): one book whose
 * DOWN token is the mirror — snapshots carry both, deltas carry `mirror` and
 * move both legs in one step — prints on both tokens, and a bound stamped the
 * same millisecond as the level it removes (generic data prunes it; input
 * order is real there). Events carry `seq` like decoded generic events.
 */
function genericEvents() {
  const ev = [];
  let seq = 0;
  const push = (e) => { ev.push({ ...e, seq, recv_ts_ms: null }); seq += 1; };
  let mid = 0.46;
  for (let i = 0; i < 50; i += 1) {
    const ts = 1000 + i * 700;
    mid = Number((mid + (i % 7 === 0 ? 0.012 : (i % 3 === 0 ? -0.007 : 0.003))).toFixed(3));
    const b1 = Number((mid - 0.01).toFixed(3));
    const a1 = Number((mid + 0.01).toFixed(3));
    if (i % 6 === 0) {
      push({
        kind: 'book', ts_ms: ts, snapshot: true,
        levels: {
          UP: { bids: [[b1, 120], [Number((b1 - 0.01).toFixed(3)), 300]], asks: [[a1, 110], [Number((a1 + 0.01).toFixed(3)), 260]] },
          DOWN: {
            bids: [[Number((1 - a1).toFixed(3)), 110], [Number((1 - a1 - 0.01).toFixed(3)), 260]],
            asks: [[Number((1 - b1).toFixed(3)), 120], [Number((1 - b1 + 0.01).toFixed(3)), 300]],
          },
        },
      });
    } else {
      push({ kind: 'book', ts_ms: ts, snapshot: false, side: 'UP', ladder: i % 2 ? 'bids' : 'asks', px: i % 2 ? b1 : a1, size: 40 + (i % 5) * 20, mirror: true });
    }
    if (i % 8 === 4) {
      // A level and the bound that removes it, the same millisecond, in that order.
      push({ kind: 'book', ts_ms: ts + 50, snapshot: false, side: 'UP', ladder: 'asks', px: Number((a1 - 0.005).toFixed(3)), size: 25, mirror: true });
      push({ kind: 'book', ts_ms: ts + 50, snapshot: false, bbo: true, side: 'UP', bid: b1, ask: a1 });
    }
    push({ kind: 'tick', ts_ms: ts + 1, market_id: '0xconf', value: 65000 + i });
    push({ kind: 'trade', ts_ms: ts + 150, market_id: '0xconf', side: 'UP', taker: 'SELL', px: b1, size: 30 + (i % 4) * 10 });
    push({ kind: 'trade', ts_ms: ts + 300, market_id: '0xconf', side: 'DOWN', taker: 'BUY', px: Number((1 - b1).toFixed(3)), size: 25 + (i % 3) * 9 });
    push({ kind: 'trade', ts_ms: ts + 450, market_id: '0xconf', side: 'UP', taker: 'BUY', px: a1, size: 20 + (i % 5) * 7 });
  }
  return ev;
}

const GENERIC = {
  kind: 'generic', venue: 'polymarket', market_id: '0xconf', slug: 'conf', question: 'Conf?',
  token_ids: ['t-yes', 't-no'], labels: ['Yes', 'No'], fee: { model: 'polymarket-taker-v1', rate: 0.07 },
  tick_size: 0.001, min_size: 5, trading_end_ts_ms: null, asset: null, interval: null, strike: null,
  open_ts_ms: 1000, close_ts_ms: 40_000, trade_until_ts_ms: 30_000, outcome: 'DOWN', resolved_ts_ms: 40_000,
  resolution_source: 'gamma',
};
const GENERIC_MARKED = { ...GENERIC, outcome: null, resolved_ts_ms: null, resolution_source: null, close_ts_ms: 30_000 };

const GENERIC_JS = `export class S {
  onMarketOpen(ctx, m) { this.n = 0; this.labels = m.labels; ctx.log("open " + m.labels.join("/") + " " + m.close_ts_ms + " " + ("outcome" in m)); }
  onTick(ctx, t) {
    this.n += 1;
    const b = ctx.book();
    const bid = b.bestBid("UP"), ask = b.best("UP");
    if (bid == null || ask == null) return null;
    const r3 = (x) => Math.floor(x * 1000 + 0.5) / 1000;
    if (this.n === 2) return { side: this.labels[0], size: 30, limit: 0.99 };
    if (this.n === 4) return { side: "no", size: 12, limit: 0.99, hold_s: 3 };
    if (this.n === 6) return { side: "Yes", size: 20, limit: r3(bid), tif: "gtc", client_id: "q1" };
    if (this.n === 9) return { side: "YES", size: 10, limit: 0.01, reduce_only: true };
    if (this.n === 14) return { side: "UP", size: 15, limit: r3(ask + 0.002), tif: "gtc", reduce_only: true };
    if (this.n === 30 || this.n === 31) return [{ side: "Celtics", size: 3, limit: 0.99 }].filter(() => this.labels[1] === "Celtics")
      .concat([{ side: this.labels[1], size: 8, limit: 0.99 }, { side: this.labels[0], size: 6, limit: 0.99 }]);
    if (this.n === 41) return { side: "Yes", size: 5, limit: r3(bid - 0.004), tif: "gtc" };
    return null;
  }
  onSettle(ctx, m, o) { ctx.log("settle " + o + " " + m.resolved_ts_ms); }
}`;
const GENERIC_PY = `import math


def r3(x):
    return math.floor(x * 1000 + 0.5) / 1000


class S:
    def on_market_open(self, ctx, market):
        self.n = 0
        self.labels = list(market.labels)
        ctx.log("open " + "/".join(market.labels) + " " + str(market.close_ts_ms) + " " + ("true" if "outcome" in market else "false"))

    def on_tick(self, ctx, tick):
        self.n += 1
        b = ctx.book()
        bid = b.best_bid("UP")
        ask = b.best("UP")
        if bid is None or ask is None:
            return None
        if self.n == 2:
            return {"side": self.labels[0], "size": 30, "limit": 0.99}
        if self.n == 4:
            return {"side": "no", "size": 12, "limit": 0.99, "hold_s": 3}
        if self.n == 6:
            return {"side": "Yes", "size": 20, "limit": r3(bid), "tif": "gtc", "client_id": "q1"}
        if self.n == 9:
            return {"side": "YES", "size": 10, "limit": 0.01, "reduce_only": True}
        if self.n == 14:
            return {"side": "UP", "size": 15, "limit": r3(ask + 0.002), "tif": "gtc", "reduce_only": True}
        if self.n == 30 or self.n == 31:
            out = [{"side": "Celtics", "size": 3, "limit": 0.99}] if self.labels[1] == "Celtics" else []
            return out + [{"side": self.labels[1], "size": 8, "limit": 0.99}, {"side": self.labels[0], "size": 6, "limit": 0.99}]
        if self.n == 41:
            return {"side": "Yes", "size": 5, "limit": r3(bid - 0.004), "tif": "gtc"}
        return None

    def on_settle(self, ctx, market, outcome):
        ctx.log("settle " + str(outcome) + " " + str(market.resolved_ts_ms))
`;

/**
 * Scenarios. Each is the same behaviour written once per language.
 *
 * They are chosen to hit the places the two engines could plausibly disagree:
 * price quantisation, walking the book, partial fills, reduce_only clamping,
 * settlement, hold expiry, and multiple orders in one event.
 */
Object.assign(BUILDERS_FOR_TESTS, { maker: makerEvents });
const SCENARIOS = [
  {
    // Polymarket publishes ONE SIDE PER ROW, and its ask ladder descending.
    // Both engines have to reach the same book from that: an absent side is
    // not an instruction to clear that side, and the best ask is the lowest
    // rather than element zero. Neither is visible in a two-sided fixture, and
    // a two-sided fixture is all this file had.
    name: 'one-sided snapshots, descending ladders',
    events: 'oneSided',
    js: `export class S {
      onMarketOpen(ctx, m) { this.n = 0; }
      onTick(ctx, t) {
        this.n += 1;
        if (this.n !== 3) return null;
        const up = ctx.book().best("UP");
        const down = ctx.book().best("DOWN");
        ctx.log("up=" + up + " down=" + down);
        if (up == null || down == null) return null;
        return { side: "UP", size: 300, limit: 0.99 };
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_tick(self, ctx, tick):
        self.n += 1
        if self.n != 3:
            return None
        up = ctx.book().best("UP")
        down = ctx.book().best("DOWN")
        ctx.log("up=" + str(up) + " down=" + str(down))
        if up is None or down is None:
            return None
        return Order(side="UP", size=300, limit=0.99)
`,
  },

  {
    // THE UNTHROTTLED TOP OF BOOK, which only deletes.
    //
    // A bound is the one input that can make the book WORSE for the strategy,
    // so an engine that ignores it is strictly more optimistic than one that
    // does not — and the two would still agree on a fixture where pruning
    // changes nothing. Here it changes the fill price, so silence is not an
    // option for either of them.
    //
    // The bound is also the only book input with no size, which is exactly the
    // shape that has been mishandled before: JS quietly no-ops on an undefined
    // size while Python raises. Both are wrong and they are wrong differently.
    name: 'an unthrottled top-of-book bound prunes stale levels identically',
    events: 'bbo',
    // on_book has to be DECLARED or the harness never dispatches it, and the
    // leak this case exists to catch would go unnoticed in both engines.
    hooks: ['on_book'],
    js: `export class S {
      onMarketOpen(ctx, m) { this.n = 0; }
      onBook(ctx, e) {
        // COUNTED, and its shape checked. A bound has no levels, so if one ever
        // reaches this hook the count rises and bad records the event that
        // should never have arrived. Both are carried into a fill below, which
        // is what this file actually compares.
        this.books = (this.books || 0) + 1;
        if (e == null || e.levels === undefined) this.bad = (this.bad || 0) + 1;
        return null;
      }
      onTick(ctx, t) {
        this.n += 1;
        const b = ctx.book();
        ctx.log("n=" + this.n + " up=" + b.best("UP") + " upbid=" + b.bestBid("UP") + " down=" + b.best("DOWN")
          + " books=" + (this.books || 0) + " bad=" + (this.bad || 0));
        // n=3: the only level left is exactly AT the bound. n=4: the level
        // stamped the same millisecond as the bound. Both have to become a
        // FILL, because fills are what this file compares — the logs above are
        // for a human reading a failure and are deliberately not compared
        // (String(null) is "null" in JS and "None" in Python).
        // The order SIZE carries the hook count, so a bound that leaks into
        // on_book changes a fill rather than only a log line. Logs are not
        // compared across engines and cannot be (String(null) is "null" in JS
        // and "None" in Python), so a divergence visible only there passes.
        if (this.n === 3 || this.n === 4) {
          return { side: "UP", size: 10 + (this.books || 0) + 100 * (this.bad || 0), limit: 0.99 };
        }
        return null;
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_book(self, ctx, event):
        self.books = getattr(self, "books", 0) + 1
        if event is None or event.get("levels") is None:
            self.bad = getattr(self, "bad", 0) + 1
        return None

    def on_tick(self, ctx, tick):
        self.n += 1
        b = ctx.book()
        books = getattr(self, "books", 0)
        bad = getattr(self, "bad", 0)
        ctx.log("n=" + str(self.n) + " up=" + str(b.best("UP")) + " upbid=" + str(b.best_bid("UP")) + " down=" + str(b.best("DOWN"))
                + " books=" + str(books) + " bad=" + str(bad))
        if self.n in (3, 4):
            return Order(side="UP", size=10 + books + 100 * bad, limit=0.99)
        return None
`,
  },

  {
    // A BAD NOTIONAL IS COUNTED, NEVER THROWN — and counted identically.
    //
    // `Infinity > 0` is true, so an unchecked positivity test let it through:
    // JS derived `size = Infinity`, walked the whole book and produced a fill
    // of NaN, poisoning the position and every number downstream, with nothing
    // reporting a problem. Python raised OverflowError instead, which fails
    // the entire run. Same input, two different disasters.
    name: 'an infinite notional is refused by both engines, not thrown',
    js: `export class S {
      onMarketOpen(ctx, m) { this.done = false; }
      onTick(ctx, t) {
        if (this.done) return null;
        this.done = true;
        return { side: "UP", notional: Infinity, limit: 0.5 };
      }
    }`,
    py: `from outcometick import Strategy


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done:
            return None
        self.done = True
        return {"side": "UP", "notional": float("inf"), "limit": 0.5}
`,
  },
  {
    // Contradictory sizing is refused by BOTH engines, identically.
    //
    // The SDK's Order constructor rejects `{size, notional}`, but a hook can
    // return a plain object that never went through it. Taking `size` there
    // would trade a contract count while the author believed they had set a
    // spending cap — silent and expensive, so both engines refuse it, and
    // refuse it the same way: no fill, no trade.
    name: 'an order with both a size and a notional is refused by both engines',
    js: `export class S {
      onMarketOpen(ctx, m) { this.done = false; }
      onTick(ctx, t) {
        if (this.done) return null;
        this.done = true;
        return { side: "UP", size: 10, notional: 80, limit: 0.64 };
      }
    }`,
    py: `from outcometick import Strategy


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done:
            return None
        self.done = True
        return {"side": "UP", "size": 10, "notional": 80, "limit": 0.64}
`,
  },
  {
    // Sizing by MONEY, not by contracts, which is how nearly every strategy
    // actually thinks. The conversion lives in the Order constructor of each
    // SDK, so the two languages have to agree on the arithmetic AND on the
    // rounding: `floor(notional / limit)`. A one-contract difference here is a
    // different fill, a different fee and a different P&L.
    // 80 / 0.64 ON PURPOSE. The first version of this case used 80 / 0.65,
    // where Python's `//` and JS's Math.floor happen to agree — so it was
    // green while the two engines disagreed by a whole contract on every
    // decimal boundary: 80 // 0.64 is 124, Math.floor(80 / 0.64) is 125.
    // A fixture that lands where two implementations agree tests nothing.
    name: 'an order sized in money fills the same in both engines',
    js: `export class S {
      onMarketOpen(ctx, m) { this.done = false; }
      onTick(ctx, t) {
        if (this.done) return null;
        this.done = true;
        return { side: "UP", notional: 80, limit: 0.64 };
      }
    }`,
    // A PLAIN DICT, matching the JS side's object literal. Returning
    // Order(...) here made the Python half go through the SDK constructor
    // while the JS half went through the engine — two different code paths
    // compared against each other, so the engine's own conversion was never
    // exercised on the Python side at all.
    py: `from outcometick import Strategy


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done:
            return None
        self.done = True
        return {"side": "UP", "notional": 80, "limit": 0.64}
`,
  },
  {
    name: 'buy once, hold to settlement',
    js: `export class S {
      onMarketOpen(ctx, m) { this.done = false; }
      onTick(ctx, t) {
        if (this.done) return null;
        this.done = true;
        return { side: "UP", size: 500, limit: 0.95 };
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done:
            return None
        self.done = True
        return Order(side="UP", size=500, limit=0.95)
`,
  },
  {
    // A 50:50 settlement: both legs pay half a dollar. The payout is a
    // constant in each engine, so this is where a divergence would show.
    name: 'a hedged position settles 50:50 on a tie',
    markets: [{ ...MARKET, outcome: 'TIE' }],
    js: `export class S {
      onMarketOpen(ctx, m) { this.n = 0; }
      onTick(ctx, t) {
        this.n += 1;
        if (this.n === 1) return { side: "UP", size: 300, limit: 0.95 };
        if (this.n === 2) return { side: "DOWN", size: 100, limit: 0.95 };
        return null;
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_tick(self, ctx, tick):
        self.n += 1
        if self.n == 1:
            return Order(side="UP", size=300, limit=0.95)
        if self.n == 2:
            return Order(side="DOWN", size=100, limit=0.95)
        return None
`,
    expect: (trades) => {
      assert.equal(trades.length, 2, 'both legs should settle');
      for (const t of trades) {
        assert.equal(t.outcome, 'TIE');
        assert.equal(t.exit_px, 0.5);
      }
    },
  },
  {
    name: 'an order larger than the book walks it and reports the shortfall',
    js: `export class S {
      onMarketOpen(ctx, m) { this.done = false; }
      onTick(ctx, t) {
        if (this.done) return null;
        this.done = true;
        return { side: "UP", size: 9000, limit: 0.60 };
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done:
            return None
        self.done = True
        return Order(side="UP", size=9000, limit=0.60)
`,
  },
  {
    // ctx.p is read with ATTRIBUTE access on both sides, exactly as the docs
    // and every example on /docs/sdk are written. Python received the bare dict
    // from the job JSON until 2026-08-23, so `ctx.p.entry_z` raised
    // "'dict' object has no attribute" on the first tick while the identical
    // JavaScript ran fine — the third silent divergence of this kind, and this
    // suite missed it only because every case above declares `params: {}`.
    name: 'params are read as attributes, the way the docs are written',
    params: { threshold: 0.55, size: 300, hold_s: 90 },
    js: `export class S {
      onMarketOpen(ctx, m) { this.done = false; }
      onTick(ctx, t) {
        if (this.done || t.value < ctx.p.threshold) return null;
        this.done = true;
        return { side: "UP", size: ctx.p.size, limit: 0.95, hold_s: ctx.p.hold_s };
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done or tick.value < ctx.p.threshold:
            return None
        self.done = True
        return Order(side="UP", size=ctx.p.size, limit=0.95, hold_s=ctx.p.hold_s)
`,
  },
  {
    // Subscript access has to keep working: Rec is a dict subclass, and a
    // strategy written the other way must not break when we fixed the first.
    name: 'params are also readable by subscript',
    params: { size: 150 },
    js: `export class S {
      onMarketOpen(ctx, m) { this.done = false; }
      onTick(ctx, t) {
        if (this.done) return null;
        this.done = true;
        return { side: "DOWN", size: ctx.p["size"], limit: 0.95 };
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done:
            return None
        self.done = True
        return Order(side="DOWN", size=ctx.p["size"], limit=0.95)
`,
  },
  {
    // ctx.ref() — the reference-feed path, which until 2026-08-23 was declared
    // in the contract, accepted by the validator, billed, and then crashed at
    // runtime because nothing implemented viewAt/view_at. Both engines now walk
    // the same interleaved rows and must agree on every fill.
    name: 'both engines see the same reference feed at the same instant',
    references: ['binance:btcusdt:spot:1s'],
    refRows: Array.from({ length: 40 }, (_, i) => ({
      kind: 'ref',
      name: 'binance:btcusdt:spot:1s',
      ts_ms: 1000 + i * 500,
      close: 65000 + i * 41 - (i % 4) * 70,
    })),
    js: `export class S {
      onMarketOpen(ctx, m) { this.done = false; }
      onTick(ctx, t) {
        if (this.done) return null;
        const f = ctx.ref("binance:btcusdt:spot:1s");
        const w = f.window(5);
        if (w.length < 5) return null;
        const mom = f.last.close / w[0].close - 1;
        if (mom <= 0) return null;
        this.done = true;
        return { side: "UP", size: 250, limit: 0.95 };
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done:
            return None
        f = ctx.ref("binance:btcusdt:spot:1s")
        w = f.window(5)
        if len(w) < 5:
            return None
        mom = f.last.close / w[0].close - 1
        if mom <= 0:
            return None
        self.done = True
        return Order(side="UP", size=250, limit=0.95)
`,
  },
  {
    // A reference row stamped after ctx.now must not be reachable — the whole
    // reason the rows are streamed rather than shipped as a block. Both engines
    // must report the same "nothing yet" at the same instants.
    name: 'a reference feed never shows a row from the future',
    references: ['sig'],
    refRows: [
      { kind: 'ref', name: 'sig', ts_ms: 1000, v: 1 },
      { kind: 'ref', name: 'sig', ts_ms: 9000, v: 2 },
      { kind: 'ref', name: 'sig', ts_ms: 19000, v: 3 },
    ],
    js: `export class S {
      onMarketOpen(ctx, m) { this.n = 0; }
      onTick(ctx, t) {
        const f = ctx.ref("sig");
        // at() far in the future must clamp to what is visible now.
        const ahead = f.at(10 ** 12);
        const here = f.last;
        const same = (ahead ? ahead.v : null) === (here ? here.v : null);
        if (!same) return { side: "UP", size: 1, limit: 0.99 };
        if (here && here.v === 3 && this.n === 0) { this.n = 1; return { side: "DOWN", size: 40, limit: 0.99 }; }
        return null;
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_tick(self, ctx, tick):
        f = ctx.ref("sig")
        ahead = f.at(10 ** 12)
        here = f.last
        same = (ahead.v if ahead else None) == (here.v if here else None)
        if not same:
            return Order(side="UP", size=1, limit=0.99)
        if here and here.v == 3 and self.n == 0:
            self.n = 1
            return Order(side="DOWN", size=40, limit=0.99)
        return None
`,
  },
  {
    name: 'in and out repeatedly, driven by the rolling z-score',
    js: `export class S {
      onMarketOpen(ctx, m) {}
      onTick(ctx, t) {
        const z = ctx.zscore(t.value, { window: 8 });
        const pos = ctx.position();
        if (pos.size === 0 && z > 0.5) return { side: "UP", size: 200, limit: 0.95 };
        if (pos.size > 0 && z < -0.5) {
          return { side: "UP", size: pos.size, reduce_only: true, limit: 0.01 };
        }
        return null;
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        pass

    def on_tick(self, ctx, tick):
        z = ctx.zscore(tick.value, window=8)
        pos = ctx.position()
        if pos.size == 0 and z > 0.5:
            return Order(side="UP", size=200, limit=0.95)
        if pos.size > 0 and z < -0.5:
            return Order(side="UP", size=pos.size, reduce_only=True, limit=0.01)
        return None
`,
  },
  {
    name: 'close and reverse in one event',
    js: `export class S {
      onMarketOpen(ctx, m) { this.n = 0; }
      onTick(ctx, t) {
        this.n += 1;
        if (this.n === 3) return { side: "UP", size: 300, limit: 0.95 };
        if (this.n === 9) {
          const pos = ctx.position();
          return [
            { side: "UP", size: pos.size, reduce_only: true, limit: 0.01 },
            { side: "DOWN", size: 300, limit: 0.95 },
          ];
        }
        return null;
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_tick(self, ctx, tick):
        self.n += 1
        if self.n == 3:
            return Order(side="UP", size=300, limit=0.95)
        if self.n == 9:
            pos = ctx.position()
            return [
                Order(side="UP", size=pos.size, reduce_only=True, limit=0.01),
                Order(side="DOWN", size=300, limit=0.95),
            ]
        return None
`,
  },
  {
    name: 'hold_s expiry flattens on the clock',
    js: `export class S {
      onMarketOpen(ctx, m) { this.done = false; }
      onTick(ctx, t) {
        if (this.done) return null;
        this.done = true;
        return { side: "UP", size: 400, limit: 0.95, hold_s: 5 };
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if self.done:
            return None
        self.done = True
        return Order(side="UP", size=400, limit=0.95, hold_s=5)
`,
  },
  {
    name: 'reduce_only with nothing open is a no-op in both engines',
    js: `export class S {
      onMarketOpen(ctx, m) { this.n = 0; }
      onTick(ctx, t) {
        this.n += 1;
        if (this.n === 2) return { side: "UP", size: 100, reduce_only: true, limit: 0.01 };
        if (this.n === 4) return { side: "UP", size: 250, limit: 0.95 };
        if (this.n === 6) return { side: "UP", size: 9999, reduce_only: true, limit: 0.01 };
        return null;
      }
    }`,
    py: `from outcometick import Strategy, Order


class S(Strategy):
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_tick(self, ctx, tick):
        self.n += 1
        if self.n == 2:
            return Order(side="UP", size=100, reduce_only=True, limit=0.01)
        if self.n == 4:
            return Order(side="UP", size=250, limit=0.95)
        if self.n == 6:
            return Order(side="UP", size=9999, reduce_only=True, limit=0.01)
        return None
`,
  },
];

/** Build a job dir for one language and run its harness over it. */
async function run(lang, scenario, jobOverrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), `ot-conf-${lang}-`));
  const src = path.join(dir, 'src');
  const out = path.join(dir, 'out');
  await mkdir(src, { recursive: true });
  await mkdir(out, { recursive: true });

  const isPy = lang === 'python';
  // The documented `import { Strategy, Order } from "outcometick"` resolves by
  // Node walking node_modules upward from the strategy, as it does in the
  // image. The inline cases never import it; the shipped templates do.
  if (!isPy) await cp(path.join(HERE, '..', 'harness', 'node', 'sdk'), path.join(dir, 'node_modules', 'outcometick'), { recursive: true });
  await writeFile(
    path.join(src, isPy ? 'strategy.py' : 'strategy.mjs'),
    isPy ? scenario.py : scenario.js,
  );
  const outputKey = '9f8e7d6c'.repeat(8);
  // [node method, python method] for every hook a scenario may declare.
  const HOOK_METHOD = {
    on_market_open: ['onMarketOpen', 'on_market_open'],
    on_tick: ['onTick', 'on_tick'],
    on_book: ['onBook', 'on_book'],
    on_trade: ['onTrade', 'on_trade'],
    on_settle: ['onSettle', 'on_settle'],
    on_timer: ['onTimer', 'on_timer'],
  };
  // A template declares exactly its manifest's hooks (the market-making one has
  // no on_tick); the inline cases all have on_market_open and on_tick.
  const wantedHooks = scenario.exactHooks ?? ['on_market_open', 'on_tick', ...(scenario.hooks ?? [])];
  const job = {
    outputKey,
    entry: { file: isPy ? 'strategy.py' : 'strategy.mjs', className: scenario.className ?? 'S' },
    // Built from a list rather than written out, so a scenario can ask for a
    // hook the default job does not declare. Without this the bbo case counted
    // on_book invocations that the harness was never told to dispatch — the
    // counter stayed at zero in both engines and every mutation passed.
    hooks: Object.fromEntries(wantedHooks.map((h) => [h, HOOK_METHOD[h][isPy ? 1 : 0]])),
    arities: Object.fromEntries(wantedHooks.map((h) => [h, 3])),
    params: {},   // per-case params override this via jobOverrides
    mode: 'market',
    seed: 42,
    feeBps: 20,
    fillDelayMs: 0,
    limits: { perEventBudgetMicros: 400, logBytesPerRun: LIMITS.logBytesPerRun, logLineChars: LIMITS.logLineChars },
    ...jobOverrides,
  };
  // Named rather than a chain of booleans: the third builder is where a
  // `a ? x : b ? y : z` starts silently picking the wrong fixture.
  const BUILDERS = {
    oneSided: oneSidedEvents, bbo: bboEvents, nearClose: nearCloseEvents, maker: makerEvents, generic: genericEvents,
  };
  const events = (BUILDERS[scenario.events] ?? scenarioEvents)();

  // A scenario may declare reference feeds; their rows are INTERLEAVED into
  // the same stream in event time, exactly as the worker sends them, so this
  // exercises the real framing rather than a convenience shortcut.
  const withRefs = (evs) => [...evs, ...(scenario.refRows ?? [])]
    .sort((a, b) => (a.ts_ms - b.ts_ms) || ((a.kind === 'ref' ? 1 : 0) - (b.kind === 'ref' ? 1 : 0)));
  // Most cases are one market; a case may declare several to exercise the
  // things that are only wrong ACROSS markets (per-run budgets, state reset).
  // A market may carry its own events (`scenario.marketEvents[id]`), which is
  // how the session cases build markets that overlap in time.
  const marketList = (scenario.markets ?? [MARKET]).map((m) => ({
    market: m,
    stream: scenario.stream ?? 'prices',
    lines: withRefs(scenario.marketEvents?.[m.market_id] ?? events).map((e) => JSON.stringify(e)),
  }));
  const headerOf = (m) => ({
    market: m.market, stream: m.stream,
    references: scenario.references ?? [],
    lags: scenario.lags ?? {},
    ...(m.market.kind === 'generic' ? { terminal: scenario.terminals?.[m.market.market_id] ?? null } : {}),
  });
  // Both harnesses take the job on stdin, in the same framing the worker uses:
  // per market, or the merged session stream (runner/session-feed.mjs).
  const stdinLines = [JSON.stringify(job)];
  if (job.mode === 'session') {
    const cursorOf = (m) => (async function* lines() { yield* m.lines; }());
    const timed = job.engine?.scheduler === 'global';
    for await (const line of sessionLines(marketList, { linesOf: async (m) => m.lines, headerOf, cursorOf, timed })) {
      stdinLines.push(line);
    }
  } else {
    for (const m of marketList) {
      stdinLines.push(JSON.stringify({ ...headerOf(m), n: m.lines.length }));
      stdinLines.push(...m.lines);
    }
  }

  const cmd = isPy ? PYTHON : process.execPath;
  const argv = isPy ? [PY_HARNESS, dir] : [NODE_HARNESS, dir];
  const lines = [];
  const { code, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    let tail = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      tail += d;
      const parts = tail.split('\n');
      tail = parts.pop();
      for (const line of parts) {
        if (!line) continue;
        const p = parseOutputLine(outputKey, line);
        if (p) lines.push(p);
      }
    });
    child.on('error', reject);
    child.on('close', (c) => resolve({ code: c, stderr: err }));
    child.stdin.on('error', () => {});
    for (const line of stdinLines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });

  const pick = (ch) => lines.filter((l) => l.channel === ch).map((l) => l.payload);
  const result = parseResult(JSON.parse(pick(CHANNEL.result)[0] ?? '{}'));
  const trades = pick(CHANNEL.trade).map((p) => parseTrade(JSON.parse(p))).filter(Boolean);
  const fills = pick(CHANNEL.fill).map((p) => parseFill(JSON.parse(p))).filter(Boolean);
  const logs = pick(CHANNEL.log).join('\n');
  const records = pick(CHANNEL.record).map((p) => JSON.parse(p));

  await rm(dir, { recursive: true, force: true });
  return { code, stderr, result, trades, fills, logs, records };
}

/**
 * Compare a numeric field.
 *
 * An exact equality would be the ideal, and both engines do use IEEE doubles
 * for the same operations in the same order — but summing in a different order
 * anywhere would show up as a last-bit difference, and a last-bit difference is
 * not what this test exists to catch. A tolerance of 1e-9 on values measured in
 * dollars catches every real divergence and no float noise.
 */
function closeEnough(a, b, field, where) {
  if (a == null && b == null) return;
  assert.ok(a != null && b != null, `${where}: ${field} is ${a} in node and ${b} in python`);
  assert.ok(Math.abs(a - b) < 1e-9, `${where}: ${field} is ${a} in node and ${b} in python`);
}

// ------------------------------------------------------------ the templates
//
// templates/<id>/{python,nodejs} are what `ot init` hands a new user and what
// the public templates repo publishes. They are two hand-written copies of one
// strategy, which is exactly the shape this file exists for: run the REAL
// files, not a paraphrase, through both engines on a market that walks into
// each template's entry condition, and require a trade.

const TEMPLATES_DIR = path.join(HERE, '..', '..', 'templates');

/** A market whose book and settlement feed march toward an UP finish. */
function nearCloseEvents() {
  const ev = [];
  for (let i = 1; i < 100; i += 1) {
    const ts = i * 1000;
    // UP gets dearer as the close nears: cheap early (binance-lead's window),
    // still under 0.95 late (favourite-near-close's).
    const up = Number((0.5 + i * 0.0044).toFixed(4));
    ev.push(book(ts, {
      asks: [[up, 400], [Number((up + 0.01).toFixed(4)), 2000]],
      bids: [[Number((up - 0.02).toFixed(4)), 400], [Number((up - 0.04).toFixed(4)), 2000]],
    }));
    // The settlement feed drifts above the strike: +0.6 USD a second.
    ev.push({ ...tick(ts, 65000 + i * 0.6), ts_ms: ts + 1 });
  }
  return ev;
}

async function templateScenario(id, overrides) {
  const read = (lang, file) => readFile(path.join(TEMPLATES_DIR, id, lang, file), 'utf8');
  const manifest = JSON.parse(await read('python', 'outcometick.json'));
  const nodeManifest = JSON.parse(await read('nodejs', 'outcometick.json'));
  assert.deepEqual(nodeManifest.params, manifest.params, `${id}: the two manifests' params differ`);
  return {
    name: `template ${id}: the shipped python and node files`,
    events: 'nearClose',
    className: manifest.entry.split(':')[1],
    hooks: manifest.hooks.filter((h) => h !== 'on_market_open' && h !== 'on_tick'),
    exactHooks: manifest.hooks,
    params: manifest.params,
    py: await read('python', 'strategy.py'),
    js: await read('nodejs', 'strategy.mjs'),
    markets: [{ ...MARKET, asset: 'BTC', open_ts_ms: 0, interval: '5m' }],
    expect: (trades) => {
      assert.equal(trades.length, 1, `${id}: expected exactly one entry`);
      assert.equal(trades[0].side, 'UP', `${id}: entered the wrong side`);
    },
    ...overrides,
  };
}

SCENARIOS.push(
  // The market-making template rests orders, so it runs on the mirrored maker
  // fixture with the resting policy its manifest implies, and must get filled.
  await templateScenario('spread-quote', {
    events: 'maker',
    job: { resting: { allowed: true, cancelLatencyMs: 100 }, fillDelayMs: 150 },
    expect: () => {},
    expectFills: (fills) => {
      assert.ok(fills.some((f) => f.liquidity === 'maker' && f.side === 'UP'), 'spread-quote: no UP maker fill');
      assert.ok(fills.some((f) => f.liquidity === 'maker' && f.side === 'DOWN'), 'spread-quote: no DOWN maker fill');
    },
  }),
  await templateScenario('favourite-near-close'),
  await templateScenario('binance-lead', {
    references: ['binance:btcusdt:spot:1s'],
    // Spot is already up ~15bps by mid-market while the book still sells UP
    // under 0.65 — the gap the template is written to take. Stamped the way
    // the worker stamps real 1s bars: at their CLOSE (open + 999ms), and only
    // from the market open on — so no row sits exactly at the open. A fixture
    // with a row AT the open hid that the first version looked for one and
    // never traded in production.
    refRows: Array.from({ length: 100 }, (_, i) => ({
      kind: 'ref', name: 'binance:btcusdt:spot:1s', ts_ms: i * 1000 + 999, close: 64000 + i * 1.2,
    })),
  }),
);

// Resting orders: the queue model is the newest and most intricate code either
// engine has, so it gets a scenario that walks every path at once — quoting
// both tokens, cancel/replace by id and by client_id, post_only, a marketable
// gtc that takes then rests, reduce-only exits — under entry AND cancel
// latency, with venue and flat fees.
const MAKER_JS = `export class S {
      onMarketOpen(ctx, m) { this.n = 0; }
      onTick(ctx, t) {
        this.n += 1;
        const b = ctx.book();
        const bid = b.bestBid("UP");
        const ask = b.best("UP");
        if (bid == null || ask == null) return null;
        const r3 = (x) => Math.floor(x * 1000 + 0.5) / 1000;
        const out = [];
        const open = ctx.orders();
        if (this.n % 6 === 1) {
          for (const o of open) ctx.cancel(o.id);
          out.push({ side: "UP", size: 40, limit: r3(bid), tif: "gtc", client_id: "bid" + this.n });
          // marketable on arrival (takes, then rests) — on a round where we do
          // not also quote the other side, or it would cross our own order
          if (this.n % 12 === 7) out.push({ side: "UP", size: 500, limit: r3(ask), tif: "gtc" });
          else out.push({ side: "DOWN", size: 30, limit: r3(1 - ask), tif: "gtc", post_only: true });
        }
        const pos = ctx.position();
        if (this.n % 6 === 4 && pos.side && pos.size > 0) {
          out.push({ side: pos.side, size: pos.size, limit: r3(Math.min(0.99, pos.avg_entry + 0.02)), tif: "gtc", reduce_only: true });
        }
        if (this.n % 6 === 5 && open.length) ctx.cancel(open[0].client_id ?? open[0].id);
        return out;
      }
    }`;
const MAKER_PY = `import math


def r3(x):
    return math.floor(x * 1000 + 0.5) / 1000


class S:
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_tick(self, ctx, tick):
        self.n += 1
        b = ctx.book()
        bid = b.best_bid("UP")
        ask = b.best("UP")
        if bid is None or ask is None:
            return None
        out = []
        open_ = ctx.orders()
        if self.n % 6 == 1:
            for o in open_:
                ctx.cancel(o.id)
            out.append({"side": "UP", "size": 40, "limit": r3(bid), "tif": "gtc", "client_id": "bid" + str(self.n)})
            if self.n % 12 == 7:
                out.append({"side": "UP", "size": 500, "limit": r3(ask), "tif": "gtc"})
            else:
                out.append({"side": "DOWN", "size": 30, "limit": r3(1 - ask), "tif": "gtc", "post_only": True})
        pos = ctx.position()
        if self.n % 6 == 4 and pos.side and pos.size > 0:
            out.append({"side": pos.side, "size": pos.size, "limit": r3(min(0.99, pos.avg_entry + 0.02)),
                        "tif": "gtc", "reduce_only": True})
        if self.n % 6 == 5 and open_:
            first = open_[0]
            ctx.cancel(first.client_id if first.client_id is not None else first.id)
        return out
`;
for (const [label, job] of [
  ['flat fee, latency', { feeBps: 20, fillDelayMs: 150, resting: { allowed: true, cancelLatencyMs: 50 } }],
  ['venue fee, zero latency', { fees: { mode: 'venue' }, fillDelayMs: 0, resting: { allowed: true, cancelLatencyMs: 0 } }],
]) {
  SCENARIOS.push({
    name: `resting orders (${label})`,
    events: 'maker',
    job,
    markets: [{ ...MARKET, close_ts_ms: 44_000, fee: { model: 'polymarket-taker-v1', rate: 0.07 } }],
    js: MAKER_JS,
    py: MAKER_PY,
    // Agreement alone would pass two engines that both never fill a resting
    // order. Both kinds of liquidity have to show up.
    expectFills: (fills) => {
      assert.ok(fills.some((f) => f.liquidity === 'maker'), 'no maker fill');
      assert.ok(fills.some((f) => f.liquidity === 'maker' && f.action === 'reduce'), 'no maker exit');
      assert.ok(fills.some((f) => f.liquidity === 'taker' && f.order_id), 'no taker part of a gtc');
      assert.ok(fills.some((f) => f.markout_1s != null), 'no markout resolved');
    },
  });
}

// Phase 2c: the probabilistic queue models on the same resting-order script,
// every function, both engines row for row (and a session and generic case).
for (const qp of [{ prob: 'power', n: 3 }, { prob: 'power2', n: 2 }, { prob: 'power3', n: 2 }, { prob: 'log', n: null }, { prob: 'log2', n: null }]) {
  SCENARIOS.push({
    name: `resting orders, queue model ${qp.prob}${qp.n ? ` n=${qp.n}` : ''}`,
    events: 'maker',
    job: { fees: { mode: 'venue' }, fillDelayMs: 150, resting: { allowed: true, cancelLatencyMs: 50 }, engine: { queue_prob: qp } },
    markets: [{ ...MARKET, close_ts_ms: 44_000, fee: { model: 'polymarket-taker-v1', rate: 0.07 } }],
    js: MAKER_JS,
    py: MAKER_PY,
    expectFills: (fills) => assert.ok(fills.some((f) => f.liquidity === 'maker'), 'no maker fill'),
  });
}

// The lifecycle's rarer exits, each forced once: post_only refused on arrival,
// a cancel that lands before the order does, a reduce-only order whose
// position an IOC already closed, and expiry at the close.
SCENARIOS.push({
  name: 'resting orders: rare lifecycle exits',
  events: 'maker',
  // Entry latency 1000 > the 700ms tick spacing, so a cancel on the next tick
  // lands before the order does; cancels take effect at once.
  job: { feeBps: 0, fillDelayMs: 1000, resting: { allowed: true, cancelLatencyMs: 0 } },
  markets: [{ ...MARKET, close_ts_ms: 30_000 }],
  expectStats: (s) => {
    for (const k of ['rejected_post_only', 'cancelled_before_entry', 'cancelled_no_position', 'expired']) {
      assert.ok(s[k] >= 1, `${k} never happened: ${JSON.stringify(s)}`);
    }
  },
  js: `export class S {
    onMarketOpen(ctx, m) { this.n = 0; }
    onTick(ctx, t) {
      this.n += 1;
      const b = ctx.book();
      const bid = b.bestBid("UP"), ask = b.best("UP");
      if (bid == null || ask == null) return null;
      const r3 = (x) => Math.floor(x * 1000 + 0.5) / 1000;
      if (this.n === 2) return { side: "UP", size: 10, limit: r3(ask), tif: "gtc", post_only: true };
      if (this.n === 3) { const o = { side: "UP", size: 10, limit: r3(bid - 0.05), tif: "gtc", client_id: "early" }; return o; }
      if (this.n === 4) { ctx.cancel("early"); return { side: "UP", size: 20, limit: 0.99 }; }
      if (this.n === 6) return { side: "UP", size: 20, limit: r3(ask), tif: "gtc", reduce_only: true };
      if (this.n === 7) return { side: "UP", size: 20, limit: 0.01, reduce_only: true };
      if (this.n === 30) return { side: "UP", size: 5, limit: r3(bid - 0.1), tif: "gtc" };
      return null;
    }
  }`,
  py: `import math


def r3(x):
    return math.floor(x * 1000 + 0.5) / 1000


class S:
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_tick(self, ctx, tick):
        self.n += 1
        b = ctx.book()
        bid = b.best_bid("UP")
        ask = b.best("UP")
        if bid is None or ask is None:
            return None
        if self.n == 2:
            return {"side": "UP", "size": 10, "limit": r3(ask), "tif": "gtc", "post_only": True}
        if self.n == 3:
            return {"side": "UP", "size": 10, "limit": r3(bid - 0.05), "tif": "gtc", "client_id": "early"}
        if self.n == 4:
            ctx.cancel("early")
            return {"side": "UP", "size": 20, "limit": 0.99}
        if self.n == 6:
            return {"side": "UP", "size": 20, "limit": r3(ask), "tif": "gtc", "reduce_only": True}
        if self.n == 7:
            return {"side": "UP", "size": 20, "limit": 0.01, "reduce_only": True}
        if self.n == 30:
            return {"side": "UP", "size": 5, "limit": r3(bid - 0.1), "tif": "gtc"}
        return None
`,
});

// Generic data: labels as sides, mirrored deltas, same-ms bounds, trading
// ending before settlement (resting orders expire, nothing executes after it),
// payout at the resolution time, and the two ways an unresolved market closes.
for (const [label, market, terminals, expect] of [
  ['resolved after trading ends', GENERIC, {}, (trades) => {
    assert.ok(trades.length > 0 && trades.every((t) => t.how !== 'marked'));
    assert.ok(trades.some((t) => t.how === 'settled' && t.closed_ms === 40_000 && t.label));
  }],
  ['unresolved, marked', GENERIC_MARKED, { '0xconf': { UP: 0.47, DOWN: 0.53, source: 'up_mid', ts_ms: 29_000, age_ms: 1000 } }, (trades) => {
    assert.ok(trades.some((t) => t.how === 'marked' && t.mark_px != null && t.closed_ms === 30_000));
  }],
  ['unresolved, no usable mark', GENERIC_MARKED, { '0xconf': { none: 'stale' } }, (trades) => {
    assert.ok(trades.some((t) => t.how === 'marked' && t.mark_px == null && t.mark_missing === 'stale'));
  }],
]) {
  SCENARIOS.push({
    name: `generic data: ${label}`,
    events: 'generic',
    job: { fees: { mode: 'venue' }, fillDelayMs: 100, resting: { allowed: true, cancelLatencyMs: 40 } },
    markets: [market],
    terminals,
    js: GENERIC_JS,
    py: GENERIC_PY,
    expect,
    expectStats: (s) => assert.ok(s.expired >= 1, `nothing expired at trade_until: ${JSON.stringify(s)}`),
  });
}
SCENARIOS.push({
  name: 'generic data: session over two markets, end and close at their own times',
  events: 'generic',
  job: { mode: 'session', fees: { mode: 'venue' }, fillDelayMs: 100, resting: { allowed: true, cancelLatencyMs: 40 } },
  markets: [
    { ...GENERIC, market_id: '0xg1', token_ids: ['a1', 'a2'], trade_until_ts_ms: 20_000, close_ts_ms: 33_000, resolved_ts_ms: 33_000 },
    { ...GENERIC_MARKED, market_id: '0xg2', token_ids: ['b1', 'b2'], open_ts_ms: 1000 },
  ],
  terminals: { '0xg2': { UP: 0.41, DOWN: 0.59, source: 'down_mid', ts_ms: 29_500, age_ms: 500 } },
  marketEvents: {
    '0xg1': genericEvents().map((e) => ({ ...e, market_id: e.market_id ? '0xg1' : undefined, seq: e.seq * 2 })).filter((e) => e.ts_ms <= 20_000),
    '0xg2': genericEvents().map((e) => ({ ...e, market_id: e.market_id ? '0xg2' : undefined, seq: e.seq * 2 + 1 })),
  },
  js: GENERIC_JS.replace('if (this.n === 2) return { side: this.labels[0]', 'if (this.n === 2) return { side: this.labels[0]'),
  py: GENERIC_PY,
  expect: (trades) => {
    assert.ok(trades.some((t) => t.market_id === '0xg1' && t.how === 'settled' && t.closed_ms === 33_000));
    assert.ok(trades.some((t) => t.market_id === '0xg2' && t.how === 'marked' && t.label));
  },
});

// Execution options (phase 2a). Each scenario turns one on through job.engine,
// exactly as the worker, `ot run` and the Python library send it.
const EXEC_JS = `export class S {
  onMarketOpen(ctx, m) { this.n = 0; }
  onTick(ctx, t) {
    this.n += 1;
    const n = this.n;
    if (n === 2) return { side: "UP", size: 15, limit: 0.99, tif: "fok" };
    if (n === 3) return { side: "UP", size: 100000, limit: 0.99, tif: "fok" };
    if (n === 4) return { side: "DOWN", size: 4, limit: 0.99 };
    if (n === 5) return { side: "DOWN", size: 5.005, limit: 0.99 };
    if (n === 6) return { side: "DOWN", size: 6, limit: 0.9905 };
    if (n === 7) return { side: "DOWN", notional: 7, limit: 0.97 };
    if (n === 9) return { side: "UP", size: 1000, reduce_only: true };
    if (n === 11) return { side: "DOWN", size: 12, limit: 0.99, tif: "fok" };
    return null;
  }
}`;
const EXEC_PY = `class S:
    def on_market_open(self, ctx, market):
        self.n = 0

    def on_tick(self, ctx, tick):
        self.n += 1
        n = self.n
        if n == 2:
            return {"side": "UP", "size": 15, "limit": 0.99, "tif": "fok"}
        if n == 3:
            return {"side": "UP", "size": 100000, "limit": 0.99, "tif": "fok"}
        if n == 4:
            return {"side": "DOWN", "size": 4, "limit": 0.99}
        if n == 5:
            return {"side": "DOWN", "size": 5.005, "limit": 0.99}
        if n == 6:
            return {"side": "DOWN", "size": 6, "limit": 0.9905}
        if n == 7:
            return {"side": "DOWN", "notional": 7, "limit": 0.97}
        if n == 9:
            return {"side": "UP", "size": 1000, "reduce_only": True}
        if n == 11:
            return {"side": "DOWN", "size": 12, "limit": 0.99, "tif": "fok"}
        return None
`;
const ASSUMED_RULES = { mode: 'assumed', tick: 0.001, min_size: 5, size_step: 0.01 };
for (const [label, engine, expectOrders] of [
  ['fok and the assumed order rules', { fok: true, order_rules: ASSUMED_RULES }, (o) => {
    for (const k of ['fok_unfilled', 'below_min_size', 'size_step', 'off_tick']) assert.ok(o.rejected[k] >= 1, `${k} never refused`);
  }],
  ['quote guard on the ask sum and on quote age', { fok: true, quote_guard: { ask_sum: [0.95, 1.0], max_age_ms: 600 } }, (o) => {
    assert.ok(o.rejected.quote_guard >= 1, 'the guard never refused');
  }],
  ['shared mirrored depth', { fok: true, mirror_depth: 'shared', mirror_markets: 'all' }, null],
]) {
  SCENARIOS.push({
    name: `execution options: ${label}`,
    events: 'maker',
    job: { feeBps: 0, fillDelayMs: 0, engine },
    markets: [{ ...MARKET, close_ts_ms: 44_000 }],
    js: EXEC_JS,
    py: EXEC_PY,
    expectOrders,
  });
}
SCENARIOS.push({
  name: 'execution options: maker rebate on resting fills',
  events: 'maker',
  job: { fees: { mode: 'venue' }, fillDelayMs: 150, resting: { allowed: true, cancelLatencyMs: 50 }, engine: { maker_rebate: 0.2 } },
  markets: [{ ...MARKET, close_ts_ms: 44_000, fee: { model: 'polymarket-taker-v1', rate: 0.07 } }],
  js: MAKER_JS,
  py: MAKER_PY,
  expectFills: (fills) => {
    const maker = fills.filter((f) => f.liquidity === 'maker');
    assert.ok(maker.length && maker.every((f) => f.rebate > 0 && f.fee < 0), 'every maker fill earned a rebate');
  },
  expectOrders: (o) => assert.ok(o.rebates > 0),
});

// Phase 2b: the global scheduler. Timers and a feed latency, in market mode
// and across overlapping markets in session mode. Every hook logs ctx.now, so
// the logs ARE the time line: both engines must write the same lines, and the
// times they print must never go backwards.
const TIMER_JS = `export class S {
  seen(ctx) { if (this.last != null && ctx.now < this.last) ctx.log("TIMEBACK " + this.last + " " + ctx.now); this.last = ctx.now; }
  onMarketOpen(ctx, m) {
    this.seen(ctx);
    this.k = (this.k ?? 0) + 1;
    ctx.log("open " + m.market_id + " " + ctx.now);
    ctx.schedule(ctx.now + 1500, "a" + this.k);
    ctx.schedule(ctx.now + 4200, "b" + this.k);
    this.drop = ctx.schedule(ctx.now + 2500);
  }
  onTick(ctx, t) {
    this.seen(ctx);
    ctx.log("tick " + ctx.now + " lag " + (ctx.now - t.ts_ms));
    if (this.drop) { ctx.log("unschedule " + ctx.unschedule(this.drop)); this.drop = null; }
    return null;
  }
  onTimer(ctx, t) {
    this.seen(ctx);
    const b = ctx.book();
    ctx.log("timer " + t.id + " " + t.tag + " " + t.at_ms + " " + ctx.now + " " + b.best("UP"));
    if (t.tag && t.tag[0] === "a") { ctx.schedule(ctx.now + 700, null); return { side: "UP", size: 5, limit: 0.99 }; }
    if (t.tag === null) return { side: "UP", size: 5, reduce_only: true };
    return null;
  }
}`;
const TIMER_PY = `class S:
    def seen(self, ctx):
        last = getattr(self, "last", None)
        if last is not None and ctx.now < last:
            ctx.log("TIMEBACK " + str(last) + " " + str(ctx.now))
        self.last = ctx.now

    def on_market_open(self, ctx, market):
        self.seen(ctx)
        self.k = getattr(self, "k", 0) + 1
        ctx.log("open " + market.market_id + " " + str(ctx.now))
        ctx.schedule(ctx.now + 1500, "a" + str(self.k))
        ctx.schedule(ctx.now + 4200, "b" + str(self.k))
        self.drop = ctx.schedule(ctx.now + 2500)

    def on_tick(self, ctx, tick):
        self.seen(ctx)
        ctx.log("tick " + str(ctx.now) + " lag " + str(ctx.now - tick.ts_ms))
        if self.drop:
            ctx.log("unschedule " + ("true" if ctx.unschedule(self.drop) else "false"))
            self.drop = None
        return None

    def on_timer(self, ctx, t):
        self.seen(ctx)
        b = ctx.book()
        best = b.best("UP")
        ctx.log("timer " + t.id + " " + str(t.tag if t.tag is not None else "null") + " " + str(t.at_ms) + " "
                + str(ctx.now) + " " + (str(best) if best is not None else "null"))
        if t.tag and t.tag[0] == "a":
            ctx.schedule(ctx.now + 700, None)
            return {"side": "UP", "size": 5, "limit": 0.99}
        if t.tag is None:
            return {"side": "UP", "size": 5, "reduce_only": True}
        return None
`;
const timeLine = (logs) => logs.split('\n').filter(Boolean)
  .map((l) => { const m = /(?:open \S+|tick|timer \S+ \S+ \d+) (\d+)/.exec(l); return m ? Number(m[1]) : null; })
  .filter((x) => x != null);
for (const [label, engine, mode] of [
  ['timers, market mode', { scheduler: 'global', timers: true, feed_latency: 0 }, 'market'],
  ['timers and a 300ms feed latency', { scheduler: 'global', timers: true, feed_latency: 300 }, 'market'],
]) {
  SCENARIOS.push({
    name: `global scheduler: ${label}`,
    events: 'maker',
    hooks: ['on_timer'],
    job: { feeBps: 0, fillDelayMs: 50, engine, mode },
    markets: [{ ...MARKET, open_ts_ms: 1000, close_ts_ms: 30_000 }],
    js: TIMER_JS,
    py: TIMER_PY,
    expectLogs: (logs) => {
      assert.match(logs, /timer t1 a1 2500 2500/);
      assert.match(logs, /unschedule true/);
      assert.doesNotMatch(logs, /timer t3 /, 'the unscheduled timer never fired');
      const ts = timeLine(logs);
      for (let i = 1; i < ts.length; i += 1) assert.ok(ts[i] >= ts[i - 1], `time went back: ${ts[i - 1]} -> ${ts[i]}`);
      if (engine.feed_latency) assert.ok(/lag 300/.test(logs) && !/lag 0/.test(logs), 'every tick heard 300ms late');
    },
  });
}

{
  const shift = (evs, d, id) => evs.map((e) => ({ ...e, ts_ms: e.ts_ms + d, ...(e.market_id ? { market_id: id } : {}) }));
  for (const latency of [0, 250]) {
    SCENARIOS.push({
      name: `global scheduler: session, two overlapping markets, feed latency ${latency}`,
      events: 'maker',
      hooks: ['on_timer'],
      job: { feeBps: 0, fillDelayMs: 50, mode: 'session', engine: { scheduler: 'global', timers: true, feed_latency: latency } },
      markets: [
        { ...MARKET, market_id: '0xA', open_ts_ms: 1000, close_ts_ms: 30_000 },
        { ...MARKET, market_id: '0xB', outcome: 'DOWN', open_ts_ms: 3333, close_ts_ms: 36_000 },
      ],
      marketEvents: {
        '0xA': makerEvents().filter((e) => e.ts_ms <= 30_000),
        '0xB': shift(makerEvents(), 2333, '0xB').filter((e) => e.ts_ms <= 36_000),
      },
      js: TIMER_JS,
      py: TIMER_PY,
      expectLogs: (logs) => {
        // One instance across both markets: the clock it sees never goes back
        // (logs are written per market at its close, so the instance checks).
        assert.ok(timeLine(logs).length > 40);
        assert.doesNotMatch(logs, /TIMEBACK/);
        assert.match(logs, /open 0xB 3333/);
        assert.match(logs, /timer t\d+ a2 4833 4833/);
      },
    });
  }
}

// The spot dataset and ctx.twap_locked(), against hand-computed values. Close
// 100 000, so the 60 s window opens at 40 000. Spot = 100 + 2 per second from
// 40 000, nothing from 45 000 to 54 000, a second value at 60 000 that must not
// enter the mean, and a value exactly at the close: spot() sees it, the window
// [close - 60 s, close) does not.
{
  const spotEvents = () => {
    const evs = [book(1000, { asks: [[0.50, 60]], bids: [[0.48, 100]] })];
    for (let t = 35_000; t <= 100_000; t += 1000) {
      if (t >= 45_000 && t <= 54_000) continue;
      evs.push({ kind: 'spot', ts_ms: t, market_id: '0xconf', value: 100 + 2 * ((t - 40_000) / 1000), server_ts_ms: t + 900, recv_ts_ms: t + 1100 });
      if (t === 60_000) evs.push({ kind: 'spot', ts_ms: t, market_id: '0xconf', value: 999, server_ts_ms: t + 950, recv_ts_ms: t + 1150 });
    }
    for (const t of [39_000, 44_500, 56_500, 100_000]) evs.push({ kind: 'tick', ts_ms: t, market_id: '0xconf', value: 65000 });
    const rank = (e) => ({ spot: -1, book: 0, tick: 2 }[e.kind]);
    return evs.sort((a, b) => (a.ts_ms - b.ts_ms) || (rank(a) - rank(b)));
  };
  const SPOT_JS = `export class S {
    onMarketOpen(ctx, m) {}
    onTick(ctx, t) {
      const f = (x) => (x == null ? "null" : x.toFixed(6));
      const s = ctx.spot();
      const l = ctx.twap_locked();
      ctx.log("lock " + ctx.now + " " + (s ? f(s.value) + "@" + s.ts_ms : "null") + " "
        + (l ? [f(l.value), l.samples, l.elapsed_ms, f(l.elapsed_fraction), f(l.coverage), l.last_ts_ms, f(l.projected)].join(" ") : "null"));
      return null;
    }
  }`;
  const SPOT_PY = `class S:
    def on_market_open(self, ctx, market):
        pass

    def on_tick(self, ctx, tick):
        f = lambda x: "null" if x is None else f"{x:.6f}"
        s = ctx.spot()
        l = ctx.twap_locked()
        ctx.log("lock " + str(ctx.now) + " " + (f(s.value) + "@" + str(s.ts_ms) if s else "null") + " "
                + (" ".join([f(l.value), str(l.samples), str(l.elapsed_ms), f(l.elapsed_fraction), f(l.coverage),
                             str(l.last_ts_ms), f(l.projected)]) if l else "null"))
        return None
`;
  for (const latency of [0, 300]) {
    SCENARIOS.push({
      name: `spot and twap_locked, feed latency ${latency}`,
      stream: 'twap60s',
      job: { feeBps: 0, fillDelayMs: 0, spot: true, ...(latency ? { engine: { scheduler: 'global', timers: false, feed_latency: latency } } : {}) },
      marketEvents: { '0xconf': spotEvents() },
      js: SPOT_JS,
      py: SPOT_PY,
      expectLogs: (logs) => {
        const at = (now) => logs.split('\n').find((l) => l.includes(`lock ${now} `));
        if (latency === 0) {
          // Before the window opens.
          assert.match(at(39_000), /lock 39000 98\.000000@39000 null$/);
          // 40..44 s: 100 102 104 106 108 -> 104; 4.5 s elapsed, 5 samples over
          // 4 whole seconds caps at 1; projected 0.075 * 104 + 0.925 * 108.
          assert.match(at(44_500), /lock 44500 108\.000000@44000 104\.000000 5 4500 0\.075000 1\.000000 44000 107\.700000$/);
          // + 130 and 132 at 55 and 56 s: 782 / 7; 7 samples over 16 s is
          // 0.4375 coverage, so no projection.
          assert.match(at(56_500), /lock 56500 132\.000000@56000 111\.714286 7 16500 0\.275000 0\.437500 56000 null$/);
          // At the close: 50 samples (60 s less the 10 missing, the duplicate
          // not counted) averaging 8350 / 50, coverage 50 / 60; the closing value
          // is the latest seen but outside the window; the projection is the mean.
          assert.match(at(100_000), /lock 100000 220\.000000@100000 167\.000000 50 60000 1\.000000 0\.833333 100000 167\.000000$/);
        } else {
          // Heard 300 ms late: the 44 s value arrives at 44 300, the tick at 44 800.
          assert.match(at(44_800), /lock 44800 108\.000000@44000 104\.000000 5 4800 0\.080000 1\.000000 44000 /);
        }
      },
    });
  }
}

// twap_locked() answers as of ITS ctx's clock. Session mode: market A's ctx is
// kept and read from market B's hook at 60 000, while A's own clock is still at
// its last ordinary event (41 000) though A's spot values keep arriving. And at
// A's tick at 70 000: 24 samples over 30 s is 0.8 coverage, but the latest
// value is 7 s old, so no projection.
{
  const A = '0xA';
  const B = '0xB';
  const aEvents = [book(1000, { asks: [[0.50, 60]], bids: [[0.48, 100]] })];
  for (let t = 40_000; t <= 63_000; t += 1000) aEvents.push({ kind: 'spot', ts_ms: t, market_id: A, value: 100 + (t - 40_000) / 1000 });
  aEvents.push({ kind: 'tick', ts_ms: 41_000, market_id: A, value: 1 }, { kind: 'tick', ts_ms: 70_000, market_id: A, value: 1 });
  const rank = (e) => ({ spot: -1, book: 0, tick: 2 }[e.kind]);
  aEvents.sort((x, y) => (x.ts_ms - y.ts_ms) || (rank(x) - rank(y)));
  const bEvents = [{ ...book(1000, { asks: [[0.50, 60]], bids: [[0.48, 100]] }) }, { kind: 'tick', ts_ms: 60_000, market_id: B, value: 1 }];
  const fmtJs = `const f = (x) => (x == null ? "null" : x.toFixed(6));
      const show = (l) => (l ? [f(l.value), l.samples, l.elapsed_ms, f(l.coverage), l.last_ts_ms, f(l.projected)].join(" ") : "null");`;
  for (const latency of [0, 300]) SCENARIOS.push({
    name: `twap_locked answers as of its own ctx: session, a kept ctx, a stale spot, feed latency ${latency}`,
    stream: 'twap60s',
    job: { feeBps: 0, fillDelayMs: 0, mode: 'session', spot: true, ...(latency ? { engine: { scheduler: 'global', timers: false, feed_latency: latency } } : {}) },
    markets: [{ ...MARKET, market_id: A, close_ts_ms: 100_000 }, { ...MARKET, market_id: B, close_ts_ms: 120_000 }],
    marketEvents: { [A]: aEvents, [B]: bEvents },
    js: `export class S {
    onMarketOpen(ctx, m) { if (m.market_id === "${A}") this.a = ctx; }
    onTick(ctx, t) {
      ${fmtJs}
      if (t.market_id === "${B}") ctx.log("A-from-B " + this.a.now + " " + show(this.a.twap_locked()) + " " + this.a.spot().ts_ms);
      else ctx.log("A " + ctx.now + " " + show(ctx.twap_locked()));
      return null;
    }
  }`,
    py: `class S:
    def on_market_open(self, ctx, market):
        if market.market_id == "${A}":
            self.a = ctx

    def on_tick(self, ctx, tick):
        f = lambda x: "null" if x is None else f"{x:.6f}"
        show = lambda l: " ".join([f(l.value), str(l.samples), str(l.elapsed_ms), f(l.coverage), str(l.last_ts_ms), f(l.projected)]) if l else "null"
        if tick.market_id == "${B}":
            ctx.log("A-from-B " + str(self.a.now) + " " + show(self.a.twap_locked()) + " " + str(self.a.spot().ts_ms))
        else:
            ctx.log("A " + str(ctx.now) + " " + show(ctx.twap_locked()))
        return None
`,
    expectLogs: (logs) => {
      if (latency === 0) {
        // A at 41 000: 100 and 101 -> 100.5; 1 s elapsed; projection 1/60 * 100.5 + 59/60 * 101.
        assert.match(logs, /A 41000 100\.500000 2 1000 1\.000000 41000 100\.991667/);
        // Read from B at 60 000 through A's kept ctx: still A's 41 000 -- not 21
        // samples against 1 s elapsed, and spot() is the 41 000 value.
        assert.match(logs, /A-from-B 41000 100\.500000 2 1000 1\.000000 41000 100\.991667 41000/);
        // A at 70 000: 40..63 s -> 24 samples, mean 111.5, coverage 24/30 = 0.8,
        // latest value 7 s old -> no projection.
        assert.match(logs, /A 70000 111\.500000 24 30000 0\.800000 63000 null/);
      } else {
        // Heard 300 ms late. A's clock is its last heard ordinary event, 41 300,
        // however many spot values arrive after it: read from B at 60 300 it is
        // still 41 300 (1.3 s elapsed, 1 whole second, 2 samples).
        assert.match(logs, /A 41300 100\.500000 2 1300 1\.000000 41000 100\.989167/);
        assert.match(logs, /A-from-B 41300 100\.500000 2 1300 1\.000000 41000 100\.989167 41000/);
      }
    },
  });
}

// A kept ctx under a long feed latency: a value stamped before its clock but
// heard after it must not change its answers. 1 500 ms: spot 40 000 heard at
// 41 500, A's tick 41 000 heard at 42 500 (A's clock from then on), spot 42 000
// heard at 43 500 -- after A's clock. Read from B at 45 500.
{
  const A = '0xA';
  const B = '0xB';
  const aEvents = [book(1000, { asks: [[0.50, 60]], bids: [[0.48, 100]] }),
    { kind: 'spot', ts_ms: 40_000, market_id: A, value: 100 },
    { kind: 'tick', ts_ms: 41_000, market_id: A, value: 1 },
    { kind: 'spot', ts_ms: 42_000, market_id: A, value: 200 }];
  const bEvents = [book(1000, { asks: [[0.50, 60]], bids: [[0.48, 100]] }), { kind: 'tick', ts_ms: 44_000, market_id: B, value: 1 }];
  SCENARIOS.push({
    name: 'twap_locked of a kept ctx ignores values heard after its clock, feed latency 1500',
    stream: 'twap60s',
    job: { feeBps: 0, fillDelayMs: 0, mode: 'session', spot: true, engine: { scheduler: 'global', timers: false, feed_latency: 1500 } },
    markets: [{ ...MARKET, market_id: A, close_ts_ms: 100_000 }, { ...MARKET, market_id: B, close_ts_ms: 120_000 }],
    marketEvents: { [A]: aEvents, [B]: bEvents },
    js: `export class S {
    onMarketOpen(ctx, m) { if (m.market_id === "${A}") this.a = ctx; }
    onTick(ctx, t) {
      const f = (x) => (x == null ? "null" : x.toFixed(6));
      const ctxs = t.market_id === "${B}" ? this.a : ctx;
      const l = ctxs.twap_locked();
      const s = ctxs.spot();
      ctx.log((t.market_id === "${B}" ? "A-from-B " : "A ") + ctxs.now + " " + f(s.value) + " " + f(l.value) + " " + l.samples + " " + f(l.coverage) + " " + f(l.projected));
      return null;
    }
  }`,
    py: `class S:
    def on_market_open(self, ctx, market):
        if market.market_id == "${A}":
            self.a = ctx

    def on_tick(self, ctx, tick):
        f = lambda x: "null" if x is None else f"{x:.6f}"
        c = self.a if tick.market_id == "${B}" else ctx
        l = c.twap_locked()
        s = c.spot()
        ctx.log(("A-from-B " if tick.market_id == "${B}" else "A ") + str(c.now) + " " + f(s.value) + " " + f(l.value) + " "
                + str(l.samples) + " " + f(l.coverage) + " " + f(l.projected))
        return None
`,
    expectLogs: (logs) => {
      // At A's own tick (42 500): only the 40 000 value had arrived; 2.5 s
      // elapsed, 1 sample over 2 whole seconds = 0.5 coverage -> no projection.
      assert.match(logs, /A 42500 100\.000000 100\.000000 1 0\.500000 null/);
      // Read from B at 45 500, after the 42 000 value arrived (43 500): A's
      // answers are what they were at 42 500.
      assert.match(logs, /A-from-B 42500 100\.000000 100\.000000 1 0\.500000 null/);
    },
  });
}

// Phase 3b: the recorder on the resting-order script (archive), with timers on
// (global scheduler), and on generic data — both engines, row for row.
for (const [label, engine, events, markets, js, py] of [
  ['resting orders', { record_ms: 1000 }, 'maker', [{ ...MARKET, close_ts_ms: 44_000, fee: { model: 'polymarket-taker-v1', rate: 0.07 } }], MAKER_JS, MAKER_PY],
  ['timers and a feed latency', { record_ms: 1500, scheduler: 'global', timers: true, feed_latency: 300 }, 'maker', [{ ...MARKET, open_ts_ms: 1000, close_ts_ms: 30_000 }], TIMER_JS, TIMER_PY],
]) {
  SCENARIOS.push({
    name: `recorder: ${label}`,
    events,
    hooks: engine.timers ? ['on_timer'] : [],
    job: { fees: { mode: 'venue' }, fillDelayMs: 150, resting: { allowed: true, cancelLatencyMs: 50 }, engine, mode: 'market' },
    markets,
    js,
    py,
    expectRecords: (rows, result) => {
      assert.ok(rows.length > 5, 'samples were written');
      assert.equal(rows.filter((r) => r.final).length, 1, 'one FINAL per instance');
      assert.ok(rows.some((r) => r.position_value > 0), 'a position was valued');
      for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].ts >= rows[i - 1].ts);
      assert.equal(result.record?.rows, rows.length);
    },
  });
}

SCENARIOS.push({
  name: 'recorder: generic data, marked and settled markets',
  events: 'generic',
  job: { fees: { mode: 'venue' }, fillDelayMs: 100, resting: { allowed: true, cancelLatencyMs: 40 }, engine: { record_ms: 2000 } },
  markets: [GENERIC_MARKED],
  terminals: { '0xconf': { UP: 0.41, DOWN: 0.59, source: 'down_mid', ts_ms: 29_500, age_ms: 500 } },
  js: GENERIC_JS,
  py: GENERIC_PY,
  expectRecords: (rows) => {
    assert.ok(rows.length > 3);
    assert.equal(rows.filter((r) => r.final).length, 1);
  },
});

test('Python spends the record budget where samples are made, as JavaScript does', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../harness/python', import.meta.url)))})
from otengine import Portfolio
from otreplay import MarketReplay
T0 = 1000000
class S:
    sent = False
    def on_book(self, ctx, ev):
        if self.sent:
            return None
        self.sent = True
        return {"side": "UP", "size": 10, "limit": 0.5}
def book(ts, bid):
    return {"kind": "book", "ts_ms": ts, "snapshot": True, "levels": {"UP": {"bids": [[bid, 100]], "asks": [[0.5, 100]]}, "DOWN": {"bids": [[0.48, 100]], "asks": [[0.58, 100]]}}}
budget = {"rows": 0, "limit": 50, "truncated": False}
r = MarketReplay(market={"market_id": "m", "open_ts_ms": T0, "close_ts_ms": T0 + 365 * 86400000, "outcome": "UP"},
                 strategy=S(), hooks={"on_book": "on_book"}, portfolio=Portfolio(fees={"mode": "bps", "bps": 0}),
                 engine={"record_ms": 1000}, record_budget=budget)
r.open()
r.step(book(T0, 0.40))
r.step(book(T0 + 200 * 86400000, 0.45))
out = r.close()
print(json.dumps([len(out["record"]), budget["rows"], budget["truncated"], any(x["final"] for x in out["record"])]))
`;
  const { stdout } = await promisify(execFile)(PYTHON, ['-c', py]);
  assert.deepEqual(JSON.parse(stdout), [50, 50, true, false]);
});

test('recording changes no trade, fill or fee in either engine', async () => {
  const base = SCENARIOS.find((x) => x.name === 'recorder: resting orders');
  for (const lang of ['node', 'python']) {
    const on = await run(lang, base, base.job);
    const off = await run(lang, base, { ...base.job, engine: undefined });
    assert.ok(on.records.length > 0 && off.records.length === 0, lang);
    assert.deepEqual(on.trades, off.trades, `${lang} trades`);
    assert.deepEqual(on.fills, off.fills, `${lang} fills`);
    assert.equal(on.result.feesPaid, off.result.feesPaid, `${lang} fees`);
  }
});

test('ctx.spot() and ctx.twap_locked() without the spot dataset are refused, not null forever', async () => {
  const base = SCENARIOS.find((x) => x.name === 'spot and twap_locked, feed latency 0');
  for (const lang of ['node', 'python']) {
    const r = await run(lang, base, { ...base.job, spot: undefined });
    // The engine's refusal keeps its code in both engines, even from inside a hook.
    assert.equal(r.result?.rejection?.code, 'E_MANIFEST', `${lang}: ${JSON.stringify(r.result?.rejection)} ${r.stderr}`);
    assert.match(r.result.rejection.detail, /ctx\.spot\(\) needs the "spot" dataset declared/);
  }
});

test('declaring spot changes nothing a strategy does not read, in either engine', async () => {
  // Resting orders with the recorder, and timers under a feed latency: the
  // paths where extra (quiet) events could move a job, a sample or a fill.
  for (const name of ['recorder: resting orders', 'recorder: timers and a feed latency']) {
    const base = SCENARIOS.find((x) => x.name === name);
    const events = BUILDERS_FOR_TESTS[base.events]();
    const close = base.markets[0].close_ts_ms;
    const spots = [];
    for (let t = 250; t <= close; t += 250) spots.push({ kind: 'spot', ts_ms: t, market_id: '0xconf', value: 100 + (t % 7), server_ts_ms: t, recv_ts_ms: t });
    const rank = (e) => (e.kind === 'spot' ? -1 : 0);
    const withSpot = [...events, ...spots].sort((a, b) => (a.ts_ms - b.ts_ms) || (rank(a) - rank(b)));
    const plain = { ...base, stream: 'twap60s', marketEvents: { '0xconf': events } };
    const spotted = { ...base, stream: 'twap60s', marketEvents: { '0xconf': withSpot } };
    for (const lang of ['node', 'python']) {
      const off = await run(lang, plain, base.job);
      const on = await run(lang, spotted, { ...base.job, spot: true });
      assert.equal(on.code, 0, `${lang}: ${on.stderr}`);
      assert.ok(off.trades.length > 0, `${name}: nothing traded, so nothing is proved`);
      assert.deepEqual(on.trades, off.trades, `${lang} ${name}: trades`);
      assert.deepEqual(on.fills, off.fills, `${lang} ${name}: fills`);
      assert.deepEqual(on.records, off.records, `${lang} ${name}: record`);
      assert.equal(on.logs, off.logs, `${lang} ${name}: logs`);
      assert.equal(on.result.eventsSeen, off.result.eventsSeen, `${lang} ${name}: events seen`);
      assert.deepEqual(on.result.spot, { markets: 1, markets_without: 0 }, `${lang} ${name}: spot counters`);
      assert.equal(off.result.spot, null, `${lang}: no counters unless declared`);
    }
  }
});

for (const scenario of SCENARIOS) {
  test(`both engines agree: ${scenario.name}`, async () => {
    // A scenario may carry its own params; without this the new cases would
    // run against {} and prove nothing.
    const over = {
      ...(scenario.params ? { params: scenario.params } : {}),
      ...(scenario.job ?? {}),
    };
    const [js, py] = await Promise.all([
      run('node', scenario, over), run('python', scenario, over),
    ]);

    assert.equal(js.code, 0, `node harness failed: ${js.stderr} ${JSON.stringify(js.result?.rejection ?? null)}`);
    assert.equal(py.code, 0, `python harness failed: ${py.stderr} ${JSON.stringify(py.result?.rejection ?? null)}`);

    assert.equal(js.trades.length, py.trades.length,
      `trade count differs: node ${js.trades.length}, python ${py.trades.length}`);
    // Recorder samples (record_ms): the same rows, value for value — and none at all when off.
    assert.deepEqual(py.records, js.records, `${scenario.name}: record rows differ`);
    if (scenario.expectRecords) scenario.expectRecords(js.records, js.result);
    assert.equal(js.fills.length, py.fills.length,
      `fill count differs: node ${js.fills.length}, python ${py.fills.length}`);

    for (let i = 0; i < js.trades.length; i += 1) {
      const a = js.trades[i];
      const b = py.trades[i];
      const where = `${scenario.name} trade[${i}]`;
      assert.equal(a.market_id, b.market_id, where);
      assert.equal(a.side, b.side, `${where}: side`);
      assert.equal(a.how, b.how, `${where}: how`);
      assert.equal(a.outcome ?? null, b.outcome ?? null, `${where}: outcome`);
      assert.equal(a.label, b.label, `${where}: label`);
      assert.equal(a.mark_source ?? null, b.mark_source ?? null, `${where}: mark_source`);
      assert.equal(a.mark_missing ?? null, b.mark_missing ?? null, `${where}: mark_missing`);
      for (const f of ['size', 'entry_px', 'exit_px', 'pnl', 'fees', 'opened_ms', 'closed_ms',
        'mark_px', 'marked_size', 'marked_pnl', 'mark_ts_ms', 'mark_age_ms']) {
        closeEnough(a[f], b[f], f, where);
      }
    }

    for (let i = 0; i < js.fills.length; i += 1) {
      const a = js.fills[i];
      const b = py.fills[i];
      const where = `${scenario.name} fill[${i}]`;
      assert.equal(a.side, b.side, `${where}: side`);
      assert.equal(a.action, b.action, `${where}: action`);
      assert.equal(a.levels_walked, b.levels_walked, `${where}: levels_walked`);
      assert.equal(a.liquidity, b.liquidity, `${where}: liquidity`);
      assert.equal(a.order_id, b.order_id, `${where}: order_id`);
      assert.equal(a.label, b.label, `${where}: label`);
      assert.equal(a.reject_reason, b.reject_reason, `${where}: reject_reason`);
      closeEnough(a.rebate, b.rebate, 'rebate', where);
      for (const f of ['ts_ms', 'requested', 'filled', 'unfilled', 'avg_px', 'worst_px', 'quoted_px', 'fee', 'realised',
        'queue_ahead_at_join', 'queue_ahead_at_fill', 'time_in_queue_ms',
        'markout_1s', 'markout_10s', 'markout_60s', 'markout_settle']) {
        closeEnough(a[f], b[f], f, where);
      }
    }

    assert.equal(js.result.maker == null, py.result.maker == null, `${scenario.name}: maker stats present in one engine only`);
    if (js.result.maker) {
      for (const [k, v] of Object.entries(js.result.maker)) closeEnough(v, py.result.maker[k], `maker.${k}`, scenario.name);
    }

    closeEnough(js.result.feesPaid, py.result.feesPaid, 'fees_paid', scenario.name);
    assert.deepEqual(js.result.orders, py.result.orders, `${scenario.name}: order counters`);
    assert.deepEqual(js.result.spot ?? null, py.result.spot ?? null, `${scenario.name}: spot counters`);
    if (scenario.expectOrders) {
      scenario.expectOrders(js.result.orders);
      scenario.expectOrders(py.result.orders);
    }
    assert.equal(js.result.marketsRun, py.result.marketsRun);
    // Agreement alone would pass two engines that are wrong the same way.
    if (scenario.expect) {
      scenario.expect(js.trades);
      scenario.expect(py.trades);
    }
    if (scenario.expectStats) {
      scenario.expectStats(js.result.maker);
      scenario.expectStats(py.result.maker);
    }
    if (scenario.expectFills) {
      scenario.expectFills(js.fills);
      scenario.expectFills(py.fills);
    }
    if (scenario.expectLogs) {
      assert.equal(js.logs, py.logs, `${scenario.name}: logs differ between engines`);
      scenario.expectLogs(js.logs);
    }
  });
}

test('session mode: resting orders in overlapping markets — rows leave only once their markouts are final', async () => {
  const A = { ...MARKET, market_id: '0xA', open_ts_ms: 0, close_ts_ms: 25_000 };
  const B = { ...MARKET, market_id: '0xB', outcome: 'DOWN', open_ts_ms: 9_000, close_ts_ms: 44_000 };
  const evs = makerEvents();
  const scenario = {
    name: 'session-maker',
    markets: [A, B],
    marketEvents: {
      '0xA': evs.filter((e) => e.ts_ms <= 25_000),
      '0xB': evs.filter((e) => e.ts_ms >= 9_000),
    },
    js: MAKER_JS,
    py: MAKER_PY,
  };
  const job = { mode: 'session', feeBps: 0, fillDelayMs: 100, resting: { allowed: true, cancelLatencyMs: 100 } };
  const [js, py] = await Promise.all([run('node', scenario, job), run('python', scenario, job)]);
  assert.equal(js.code, 0, js.stderr + JSON.stringify(js.result.rejection));
  assert.equal(py.code, 0, py.stderr + JSON.stringify(py.result.rejection));
  const makerA = js.fills.filter((f) => f.liquidity === 'maker' && f.market_id === '0xA');
  assert.ok(makerA.length > 0 && js.fills.some((f) => f.liquidity === 'maker' && f.market_id === '0xB'));
  // A closes while B is open: every row of A carries its settle markout, and
  // none of B's rows left before B's own close with that markout unset.
  for (const f of js.fills.filter((x) => x.liquidity === 'maker')) assert.notEqual(f.markout_settle, null, JSON.stringify(f));
  assert.deepEqual(py.fills, js.fills);
  assert.deepEqual(py.trades, js.trades);
  assert.deepEqual(py.result.maker, js.result.maker);
});

// Both bounds on the result channel, checked in both engines at once.
//
// These exist because the result line is an OUTPUT CHANNEL the strategy can
// drive: ctx.log was once per-market and unbounded per line, and
// ctx.assert_outcome still had no cap at all. Whatever the limit is, it has to
// be the same limit in both engines — a cap that holds only in JavaScript is a
// cap a Python strategy walks straight past.
test('both engines bound the result channel the same way', async () => {
  const scenario = {
    name: 'a strategy that logs and cross-checks as hard as it can',
    // Multi-byte on purpose: the run budget is bytes, and counting characters
    // would let this write three times what it is charged for.
    js: `export class S {
      onMarketOpen(ctx, m) {}
      onTick(ctx, t) {
        ctx.log("数据".repeat(200));
        ctx.assert_outcome(null, "U".repeat(5000));
        return null;
      }
    }`,
    py: `from outcometick import Strategy


class S(Strategy):
    def on_market_open(self, ctx, market):
        pass

    def on_tick(self, ctx, tick):
        ctx.log("数据" * 200)
        ctx.assert_outcome(None, "U" * 5000)
        return None
`,
  };
  const [js, py] = await Promise.all([run('js', scenario), run('python', scenario)]);
  assert.equal(js.code, 0, js.stderr);
  assert.equal(py.code, 0, py.stderr);

  assert.equal(js.result.crosschecks.length, py.result.crosschecks.length,
    `js kept ${js.result.crosschecks.length} cross-checks, py kept ${py.result.crosschecks.length}`);
  assert.ok(js.result.crosschecks.length > 0, 'neither engine recorded anything');
  assert.ok(js.result.crosschecks.length <= 16,
    `${js.result.crosschecks.length} cross-checks survived — the count is unbounded`);
  for (const side of [['js', js], ['py', py]]) {
    for (const c of side[1].result.crosschecks) {
      assert.ok(String(c.claimed).length <= 32,
        `${side[0]}: a ${String(c.claimed).length}-character claim got onto the result line`);
    }
  }

  // Same line cap, applied to the same string, in both languages.
  const jsLines = js.logs.split('\n').filter(Boolean);
  const pyLines = py.logs.split('\n').filter(Boolean);
  assert.ok(jsLines.length > 0 && pyLines.length > 0, 'neither engine logged');
  const longest = (ls) => Math.max(...ls.map((l) => l.length));
  assert.equal(longest(jsLines) <= 512 + 40, true, `js line ran to ${longest(jsLines)}`);
  assert.equal(longest(pyLines) <= 512 + 40, true, `py line ran to ${longest(pyLines)}`);
});

test('both engines agree once a fill delay is applied', async () => {
  // The delay path reschedules orders against a later book, and the two
  // implementations queue them separately. A different insertion order shows up
  // here and nowhere else.
  // By NAME, not by index: inserting a scenario above silently repointed
  // this at a different one, and the test then failed for a reason that
  // had nothing to do with fill delays.
  const scenario = SCENARIOS.find((x) => x.name === 'in and out repeatedly, driven by the rolling z-score');
  assert.ok(scenario, 'the z-score scenario was renamed or removed');
  const [js, py] = await Promise.all([
    run('node', scenario, { fillDelayMs: 750 }),
    run('python', scenario, { fillDelayMs: 750 }),
  ]);
  assert.equal(js.code, 0, js.stderr);
  assert.equal(py.code, 0, py.stderr);
  assert.equal(js.fills.length, py.fills.length);
  for (let i = 0; i < js.fills.length; i += 1) {
    closeEnough(js.fills[i].avg_px, py.fills[i].avg_px, 'avg_px', `delayed fill[${i}]`);
    closeEnough(js.fills[i].ts_ms, py.fills[i].ts_ms, 'ts_ms', `delayed fill[${i}]`);
  }
});

test('both engines reject a missing class the same way', async () => {
  const broken = {
    name: 'missing class',
    js: 'export class Other { onTick() { return null; } }',
    py: 'class Other:\n    def on_tick(self, ctx, tick):\n        return None\n',
  };
  const [js, py] = await Promise.all([run('node', broken), run('python', broken)]);
  assert.equal(js.code, 10);
  assert.equal(py.code, 10);
  assert.equal(js.result.rejection.code, 'E_ENTRY');
  assert.equal(py.result.rejection.code, 'E_ENTRY');
});

test('both engines reject a declared-but-missing hook the same way', async () => {
  const broken = {
    name: 'missing hook',
    js: 'export class S { onMarketOpen() {} }',
    py: 'class S:\n    def on_market_open(self, ctx, market):\n        pass\n',
  };
  const [js, py] = await Promise.all([run('node', broken), run('python', broken)]);
  assert.equal(js.result.rejection.code, 'E_HOOK_SIG');
  assert.equal(py.result.rejection.code, 'E_HOOK_SIG');
});

test('global scheduler: a ctx kept from another market cannot schedule into the run\'s past', async () => {
  // A opens at 1000 and its last event before B opens (3333) is at 3220, so
  // ctxA.now is 3220 while the run is at 3333: a timer at 3332 is after
  // ctxA.now and before the run. It must be refused, not fired back in time.
  const shift = (evs, d, id) => evs.map((e) => ({ ...e, ts_ms: e.ts_ms + d, ...(e.market_id ? { market_id: id } : {}) }));
  const scenario = (offset) => ({
    name: `kept ctx ${offset}`,
    events: 'maker',
    hooks: ['on_timer'],
    markets: [
      { ...MARKET, market_id: '0xA', open_ts_ms: 1000, close_ts_ms: 30_000 },
      { ...MARKET, market_id: '0xB', outcome: 'DOWN', open_ts_ms: 3333, close_ts_ms: 36_000 },
    ],
    marketEvents: {
      '0xA': makerEvents().filter((e) => e.ts_ms <= 30_000),
      '0xB': shift(makerEvents(), 2333, '0xB').filter((e) => e.ts_ms <= 36_000),
    },
    js: `export class S {
  onMarketOpen(ctx, m) {
    if (m.market_id === "0xA") { this.a = ctx; return; }
    ctx.log("B open " + ctx.now + " A now " + this.a.now);
    ctx.log("kept " + this.a.schedule(ctx.now + (${offset}), "kept"));
  }
  onTick() { return null; }
  onTimer(ctx, t) { ctx.log("timer " + t.tag + " " + t.at_ms + " " + ctx.now + " " + ctx.position().size); }
}`,
    py: `class S:
    def on_market_open(self, ctx, market):
        if market.market_id == "0xA":
            self.a = ctx
            return
        ctx.log("B open " + str(ctx.now) + " A now " + str(self.a.now))
        ctx.log("kept " + self.a.schedule(ctx.now + (${offset}), "kept"))

    def on_tick(self, ctx, tick):
        return None

    def on_timer(self, ctx, t):
        ctx.log("timer " + t.tag + " " + str(t.at_ms) + " " + str(ctx.now) + " " + str(ctx.position().size))
`,
  });
  const job = { feeBps: 0, fillDelayMs: 50, mode: 'session', engine: { scheduler: 'global', timers: true, feed_latency: 0 } };
  const past = scenario(-1);
  const [jp, pp] = await Promise.all([run('node', past, job), run('python', past, job)]);
  for (const r of [jp, pp]) {
    assert.equal(r.code, 10, r.stderr);
    assert.equal(r.result.rejection.code, 'E_RUNTIME');
    assert.match(r.result.rejection.detail, /after now \(3333\), got 3332/);
  }
  // Ahead of the run it is an ordinary timer of market A, fired at its time.
  const ahead = scenario(100);
  const [ja, pa] = await Promise.all([run('node', ahead, job), run('python', ahead, job)]);
  for (const r of [ja, pa]) {
    assert.equal(r.code, 0, r.stderr + JSON.stringify(r.result?.rejection ?? null));
    assert.match(r.logs, /B open 3333 A now 3220/);
    assert.match(r.logs, /timer kept 3433 3433 /);
  }
});

test('global scheduler: Python asks a cancel through a kept ctx at the run clock too', async () => {
  // The Python mirror of the replay.test.mjs case of the same name.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../harness/python', import.meta.url)))})
from otreplay import MarketReplay
T = 1000000
class S:
    sent = False
    def on_market_open(self, ctx, market):
        self.ctx = ctx
    def on_book(self, ctx, ev):
        if self.sent:
            return None
        self.sent = True
        return {"side": "UP", "size": 5, "limit": 0.4, "tif": "gtc", "client_id": "x"}
clock = {"t": float("-inf")}
s = S()
r = MarketReplay(market={"market_id": "m", "open_ts_ms": T, "close_ts_ms": T + 60000, "outcome": "UP"}, strategy=s,
                 hooks={"on_market_open": "on_market_open", "on_book": "on_book"},
                 resting={"allowed": True, "refusal": None, "cancelLatencyMs": 10},
                 engine={"scheduler": "global", "timers": False, "feed_latency": 0}, clock=clock)
r.open(T)
r.step({"kind": "book", "ts_ms": T, "snapshot": True, "levels": {"UP": {"asks": [[0.6, 10]], "bids": [[0.39, 10]]}, "DOWN": {"asks": [[0.61, 10]], "bids": [[0.4, 10]]}}})
clock["t"] = T
r.run_one()
clock["t"] = T + 5000
print(json.dumps([r.maker.stats["rested"], s.ctx.now, s.ctx.cancel("x"), r.next_due()["at"]]))
`;
  const { stdout } = await promisify(execFile)(PYTHON, ['-c', py]);
  assert.deepEqual(JSON.parse(stdout), [1, 1_000_000, true, 1_005_010]);
});

test('the queue model scenarios do take the probabilistic path', async () => {
  // Agreement alone would pass two engines that both ignored queue_prob.
  const base = SCENARIOS.find((x) => x.name === 'resting orders (venue fee, zero latency)');
  const prob = SCENARIOS.find((x) => x.name === 'resting orders, queue model power n=3');
  const plain = await run('node', base, { ...prob.job, engine: undefined });
  const moved = await run('node', prob, prob.job);
  const key = (r) => JSON.stringify(r.fills.filter((f) => f.liquidity === 'maker').map((f) => [f.ts_ms, f.filled, f.queue_ahead_at_fill]));
  assert.notEqual(key(moved), key(plain));
});

test('Python reaches the hand-computed queue-model answers of maker-prob.test.mjs', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../harness/python', import.meta.url)))})
from otengine import Book, Portfolio
from otmaker import MakerBook
T0 = 1000
def setup(prob, size=100, limit=0.40, activate=True):
    pf = Portfolio(fees={"mode": "bps", "bps": 0})
    mk = MakerBook("m", pf, queue_prob=prob)
    bk = Book("m")
    bk.snapshot(T0, {"UP": {"bids": [[0.40, size]], "asks": [[0.60, 100]]}, "DOWN": {"bids": [[0.40, 100]], "asks": [[0.60, size]]}})
    rec = mk.submit({"side": "UP", "size": 10, "limit": limit, "tif": "gtc"}, T0)
    if activate:
        mk.activate(rec, T0, bk)
    return pf, mk, bk, rec
def bid(s, ts, size):
    pf, mk, bk, rec = s
    mk.finalize(ts)
    mk.book_event({"kind": "book", "ts_ms": ts, "side": "UP", "ladder": "bids", "px": 0.40, "size": size}, bk,
                  lambda: bk.delta(ts, "UP", "bids", 0.40, size))
def prt(s, ts, size, px=0.40):
    pf, mk, bk, rec = s
    mk.finalize(ts)
    mk.trade({"kind": "trade", "ts_ms": ts, "side": "UP", "taker": "SELL", "px": px, "size": size}, bk)
P = lambda prob, n=None: {"prob": prob, "n": n}
out = {}
r = []
for prob in (P("power", 2), P("power2", 2), P("power3", 2), None):
    s = setup(prob); bid(s, 1500, 200); bid(s, 2000, 160); r.append(s[3].ahead)
out["middle"] = r
r = []
for prob in (P("power", 2), None):
    s = setup(prob); bid(s, 1500, 200); prt(s, 2000, 30); bid(s, 2100, 170); prt(s, 2200, 20); r.append(s[3].ahead)
out["print_first"] = r
s = setup(P("power", 2)); bid(s, 1500, 200); bid(s, 2000, 170); a = s[3].ahead; prt(s, 2100, 30); b = s[3].ahead; prt(s, 2200, 20)
out["book_first"] = [a, b, s[3].ahead]
s = setup(P("log"), size=50); prt(s, 2000, 30); prt(s, 2100, 30)
out["double"] = [e[2] for e in s[1].unseen["bids"]]
r = []
for t in (2800, 2801):
    s = setup(P("power", 1)); bid(s, 1500, 200); prt(s, 2000, 30); bid(s, t, 170); r.append(s[3].ahead)
out["expiry"] = r
s = setup(P("power", 1), size=200, activate=False); prt(s, 1100, 30); s[1].activate(s[3], 1200, s[2]); bid(s, 1250, 300); bid(s, 1300, 270)
out["inactive"] = s[3].ahead
s = setup(P("power", 2), size=50, limit=0.39); prt(s, 2000, 40, 0.39); prt(s, 2100, 40, 0.39)
out["reach"] = len([f for f in s[0].fills if f.get("liquidity") == "maker"])
print(json.dumps(out))
`;
  const { stdout } = await promisify(execFile)(PYTHON, ['-c', py]);
  const got = JSON.parse(stdout);
  const close = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  assert.ok(close(got.middle, [80, 70, 90, 100]), JSON.stringify(got.middle));
  assert.ok(close(got.print_first, [50, 70]), JSON.stringify(got.print_first));
  assert.ok(close(got.book_first, [85, 85, 65]), JSON.stringify(got.book_first));
  assert.deepEqual(got.double, [30, 20]);
  assert.ok(close(got.expiry, [70, 59.5]), JSON.stringify(got.expiry));
  assert.ok(Math.abs(got.inactive - 200) < 1e-9);
  assert.equal(got.reach, 1);
});

test('queueProb and ln1p: the same bits in both engines', async () => {
  const { queueProb, ln1p } = await import('../engine/maker.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const xs = [0, 1e-12, 2 ** -21, 2 ** -20, 0.01, 0.3, 1, 3, 100, 12345.678, 1e6, 999999999.5, 1e15];
  const models = [];
  for (const prob of ['power', 'power2', 'power3']) for (let n = 1; n <= 10; n += 1) models.push({ prob, n });
  models.push({ prob: 'log', n: null }, { prob: 'log2', n: null });
  const hex = (v) => (v == null ? null : (() => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v); return d.getBigUint64(0).toString(16); })());
  const js = { ln: xs.map((x) => hex(ln1p(x))), p: [] };
  for (const m of models) for (const a of xs) for (const b of xs) js.p.push(hex(queueProb(m, a, b)));
  const py = `
import sys, json, struct
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../harness/python', import.meta.url)))})
from otmaker import queue_prob, ln1p
xs = json.loads(sys.argv[1]); models = json.loads(sys.argv[2])
hx = lambda v: None if v is None else format(struct.unpack(">Q", struct.pack(">d", float(v)))[0], "x")
out = {"ln": [hx(ln1p(x)) for x in xs], "p": []}
for m in models:
    for a in xs:
        for b in xs:
            out["p"].append(hx(queue_prob(m, a, b)))
print(json.dumps(out))
`;
  const { stdout } = await promisify(execFile)(PYTHON, ['-c', py, JSON.stringify(xs), JSON.stringify(models)], { maxBuffer: 1 << 24 });
  const got = JSON.parse(stdout);
  assert.deepEqual(got.ln, js.ln);
  assert.equal(got.p.length, js.p.length);
  for (let i = 0; i < js.p.length; i += 1) assert.equal(got.p[i], js.p[i], `queueProb #${i}`);
  assert.ok(js.p.filter((v) => v != null).length > 2000, 'the grid mostly lands inside the contract');
});

test('a strategy that throws is E_RUNTIME in both, naming the hook', async () => {
  const broken = {
    name: 'throws',
    js: 'export class S { onMarketOpen() {} onTick() { throw new Error("boom"); } }',
    py: 'class S:\n    def on_market_open(self, ctx, market):\n        pass\n\n'
      + '    def on_tick(self, ctx, tick):\n        raise ValueError("boom")\n',
  };
  const [js, py] = await Promise.all([run('node', broken), run('python', broken)]);
  assert.equal(js.result.rejection.code, 'E_RUNTIME');
  assert.equal(py.result.rejection.code, 'E_RUNTIME');
  assert.match(js.result.rejection.detail, /on_tick threw/);
  assert.match(py.result.rejection.detail, /on_tick threw/);
});

test('cross-market reads are refused in both engines', async () => {
  const cross = {
    name: 'cross-market',
    js: 'export class S { onMarketOpen() {} onTick(ctx) { ctx.book("0xother"); } }',
    py: 'class S:\n    def on_market_open(self, ctx, market):\n        pass\n\n'
      + '    def on_tick(self, ctx, tick):\n        ctx.book("0xother")\n',
  };
  const [js, py] = await Promise.all([run('node', cross), run('python', cross)]);
  // The JS engine surfaces it through the hook wrapper as E_RUNTIME; Python
  // lets the RunAbort through as E_STATE. Both refuse, and both say why —
  // but the CODE differing is a real inconsistency worth pinning here so it
  // is a deliberate decision rather than an accident.
  assert.ok(['E_STATE', 'E_RUNTIME'].includes(js.result.rejection.code));
  assert.ok(['E_STATE', 'E_RUNTIME'].includes(py.result.rejection.code));
  assert.match(js.result.rejection.detail, /session/);
  assert.match(py.result.rejection.detail, /session/);
});

test('both engines refuse an unsupported time-in-force, and gtc without a resting policy', async () => {
  const shape = (tif) => ({
    name: tif,
    js: `export class S {
      onMarketOpen() {}
      onTick() { return { side: "UP", size: 100, limit: 0.95, tif: "${tif}" }; }
    }`,
    py: `class S:
    def on_market_open(self, ctx, market):
        pass

    def on_tick(self, ctx, tick):
        return {"side": "UP", "size": 100, "limit": 0.95, "tif": "${tif}"}
`,
  });
  const [js, py] = await Promise.all([run('node', shape('fok')), run('python', shape('fok'))]);
  assert.equal(js.code, 10);
  assert.equal(py.code, 10);
  assert.match(js.result.rejection.detail, /tif/);
  assert.match(py.result.rejection.detail, /tif/);
  // The job carries no resting policy here: gtc is refused with its reason.
  const [jg, pg] = await Promise.all([run('node', shape('gtc')), run('python', shape('gtc'))]);
  assert.equal(jg.code, 10);
  assert.equal(pg.code, 10);
  assert.match(jg.result.rejection.detail, /resting/);
  assert.match(pg.result.rejection.detail, /resting/);
});

test('neither engine lets a strategy steal the market before its first hook', async () => {
  // The cross-language version of the harness test: the interception point
  // differs (JSON.parse in JS, json.loads in Python) but
  // the hole was the same — the harness materialised the whole market before
  // replay, and the strategy was imported first.
  const thief = {
    name: 'thief',
    js: `
const stolen = [];
const realParse = JSON.parse;
JSON.parse = function (s) { const v = realParse(s); if (v && v.kind === "tick") stolen.push(v.value); return v; };
// (Array.prototype.push used to be patched here too; the Node harness now
// freezes Array.prototype before loading a strategy, so that patch is a load
// error — covered in harness.test.mjs.)

export class S {
  onMarketOpen() { this.first = true; }
  onTick(ctx) {
    if (this.first) { this.first = false; ctx.log("stolen=" + stolen.length); }
    return null;
  }
}`,
    py: `import json

stolen = []
_real = json.loads


def _spy(s):
    v = _real(s)
    if isinstance(v, dict) and v.get("kind") == "tick":
        stolen.append(v.get("value"))
    return v


json.loads = _spy


class S:
    def on_market_open(self, ctx, market):
        self.first = True

    def on_tick(self, ctx, tick):
        if self.first:
            self.first = False
            ctx.log("stolen=" + str(len(stolen)))
        return None
`,
  };
  const [js, py] = await Promise.all([run('node', thief), run('python', thief)]);
  assert.equal(js.code, 0, js.stderr);
  assert.equal(py.code, 0, py.stderr);
  for (const [lang, res] of [['node', js], ['python', py]]) {
    const n = Number(/stolen=(\d+)/.exec(res.logs ?? '')?.[1] ?? 0);
    assert.ok(n <= 1, `${lang}: a strategy saw ${n} ticks before its first hook fired`);
  }
});

test('an allowed dependency cannot write forged rows into the report', async () => {
  // The verified hole this channel exists to close: `/out` was a writable bind
  // mount, and a Python strategy declaring the allowlisted `pandas` could call
  // DataFrame.to_json('/out/trades.jsonl') from on_settle — AFTER being told
  // the official outcome — and write profitable trades with valid market ids
  // and in-window timestamps. It needed no analyser bypass, and reconcileRows
  // cannot tell a forged row from an engine one: it checks that the market
  // existed, not that the fill happened.
  //
  // Now there is no writable mount, and every line is MACed with a key that
  // arrives on stdin and never touches a filesystem. /proc/self/fd/3 IS
  // addressable — a pipe alone is not enough — so the MAC is what makes a
  // direct write produce lines the worker drops.
  const forger = {
    name: 'forger',
    js: `export class S {
      onMarketOpen() {}
      onTick() { return null; }
      onSettle(ctx, market, outcome) {
        const row = JSON.stringify({ market_id: "0xconf", side: outcome, size: 1000,
          entry_px: 0.01, exit_px: 1, pnl: 990, opened_ms: 1000, closed_ms: 2000,
          how: "settled", outcome });
        try { require("fs").appendFileSync("/proc/self/fd/3", "t " + row + "\\n"); } catch { /* blocked */ }
      }
    }`,
    py: `class S:
    def on_market_open(self, ctx, market):
        pass

    def on_tick(self, ctx, tick):
        return None

    def on_settle(self, ctx, market, outcome):
        import json as _j
        row = {"market_id": "0xconf", "side": outcome, "size": 1000,
               "entry_px": 0.01, "exit_px": 1.0, "pnl": 990.0,
               "opened_ms": 1000, "closed_ms": 2000, "how": "settled",
               "outcome": outcome}
        for target in ("/out/trades.jsonl", "/proc/self/fd/3"):
            try:
                with open(target, "a") as fh:
                    fh.write("t " + _j.dumps(row) + "\\n")
            except Exception:
                pass
`,
  };
  const hooks = { on_market_open: true, on_settle: true };
  void hooks;

  const py = await run('python', forger, {
    hooks: { on_market_open: 'on_market_open', on_tick: 'on_tick', on_settle: 'on_settle' },
  });
  // The strategy never returned an order, so ANY trade row would be forged.
  assert.deepEqual(py.trades, [], 'a forged trade reached the report');
  assert.equal(py.result.marketsRun, 1, 'the real run still completed');
});

test('both engines agree on the budget defaults', async () => {
  // Not decoration: this decides whether a run is rejected, so the two engines
  // disagreeing means the same strategy passes in one language and fails in the
  // other. The floor in particular was raised for a measured reason — see
  // BudgetMonitor in engine/replay.mjs — and raising it in one place only would
  // have left Python strategies dying of their own warm-up.
  const { readFile } = await import('node:fs/promises');
  const js = await readFile(path.join(HERE, '..', 'engine', 'replay.mjs'), 'utf8');
  const py = await readFile(path.join(HERE, '..', 'harness', 'python', 'otengine.py'), 'utf8');
  const jsDefaults = /limitMicros = (\d+), sampleFloor = (\d+)/.exec(js);
  const pyDefaults = /limit_micros: float = (\d+), sample_floor: int = (\d+)/.exec(py);
  assert.ok(jsDefaults, 'could not read the JS budget defaults');
  assert.ok(pyDefaults, 'could not read the Python budget defaults');
  assert.deepEqual(jsDefaults.slice(1), pyDefaults.slice(1),
    'the two engines disagree about the per-event budget');

  // The VERDICT, not just the numbers. Both engines have to judge the mean:
  // one judging a breach rate and the other a mean is the same strategy passing
  // in one language and failing in the other, and that difference is invisible
  // until a customer hits it. Read from the source because the Python half runs
  // in another process.
  assert.match(js, /windowMicros > this\.limitMicros/,
    'the JS engine no longer judges sustained cost over a window');
  assert.match(py, /self\.window_micros > self\.limit_micros/,
    'the Python engine no longer judges sustained cost over a window');
  // A LIFETIME mean is the specific wrong answer here: one monitor covers the
  // whole run, so it lets a cheap prefix pay for an expensive phase.
  assert.ok(!/breached[\s\S]{0,120}this\.avgMicros > this\.limitMicros/.test(js),
    'the JS verdict is back on the lifetime mean');
  assert.ok(!/def breached[\s\S]{0,200}total_micros \/ self\.count/.test(py),
    'the Python verdict is back on the lifetime mean');
  // And neither still takes a tolerance: a knob that no longer decides anything
  // is one a future reader will wire back up, believing it does.
  assert.ok(!/constructor\(\{[^}]*tolerance/.test(js),
    'the JS constructor still takes a tolerance — the breach rate is a diagnostic, not a verdict');
  assert.ok(!/def __init__\([^)]*tolerance/.test(py),
    'the Python constructor still takes a tolerance — the breach rate is a diagnostic, not a verdict');
});

// THE WHOLE TABLE OF UNUSABLE ORDERS, both engines, one assertion each.
//
// This exists because the same bug was fixed three times in a row and a new
// shape walked past each fix: an infinite notional, then a size and a notional
// together, then a bad `limit` on a plain size order. Patching a consumption
// point one condition at a time produces an engine that rejects what it
// happens to have been asked about.
//
// The divergence was worse than the hole: JS filled 10 contracts at an
// infinite limit while Python raised OverflowError — one silently traded, the
// other failed the entire run, on the same input.
//
// Driven through the engines directly rather than through a strategy: this is
// about the consumption point, and a hook returning these would be testing the
// SDK constructor instead.
test('both engines reject the same unusable orders, and neither throws', async () => {
  const { Portfolio } = await import('../engine/portfolio.mjs');
  const { Book } = await import('../engine/book.mjs');

  const BAD = [
    ['an infinite notional', { side: 'UP', notional: Infinity, limit: 0.5 }],
    ['a NaN notional', { side: 'UP', notional: NaN, limit: 0.5 }],
    ['a non-numeric notional', { side: 'UP', notional: 'lots', limit: 0.5 }],
    ['a zero notional', { side: 'UP', notional: 0, limit: 0.5 }],
    ['a notional with no limit', { side: 'UP', notional: 80 }],
    ['a quotient that overflows', { side: 'UP', notional: 1e308, limit: 0.01 }],
    ['a size and a notional at once', { side: 'UP', size: 10, notional: 80, limit: 0.5 }],
    ['neither a size nor a notional', { side: 'UP', limit: 0.5 }],
    ['an infinite size', { side: 'UP', size: Infinity }],
    ['an infinite limit', { side: 'UP', size: 10, limit: Infinity }],
    ['a NaN limit', { side: 'UP', size: 10, limit: NaN }],
    ['a limit above one', { side: 'UP', size: 10, limit: 2 }],
    ['a limit below zero', { side: 'UP', size: 10, limit: -1 }],
    // COERCION IS NOT VALIDATION, and the two languages coerce differently.
    // `Number('10')` and `float('10')` both give 10, but `Number([10])` gives
    // 10 where `float([10])` raises — so `{ size: [10] }` filled ten contracts
    // in JS and was rejected in Python, from one strategy, on one input.
    ['a numeric string for a size', { side: 'UP', size: '10' }],
    ['a numeric string for a limit', { side: 'UP', size: 10, limit: '0.5' }],
    ['an array for a size', { side: 'UP', size: [10] }],
    ['a boolean for a size', { side: 'UP', size: true }],
    ['a numeric string for a notional', { side: 'UP', notional: '80', limit: 0.5 }],
  ];

  for (const [what, order] of BAD) {
    const book = new Book();
    book.snapshot(1000, { UP: { asks: [[0.51, 1000]], bids: [[0.49, 1000]] } });
    const pf = new Portfolio({ feeBps: 0 });
    let threw = null;
    let res;
    try {
      res = pf.execute({ book, order, ts: 1001, marketId: 'm', how: 'exit' });
    } catch (e) { threw = e; }
    assert.equal(threw, null, `JS threw on ${what} instead of counting it`);
    assert.equal(res, null, `JS executed ${what}`);
    assert.equal(pf.rejected, 1, `JS did not count ${what} as a rejection`);
  }

  // The Python side of the identical table, driven in-process.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const py = `
import sys, json, math
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../harness/python', import.meta.url)))})
from otengine import Portfolio, Book
BAD = [
  ("an infinite notional", {"side":"UP","notional":float("inf"),"limit":0.5}),
  ("a NaN notional", {"side":"UP","notional":float("nan"),"limit":0.5}),
  ("a non-numeric notional", {"side":"UP","notional":"lots","limit":0.5}),
  ("a zero notional", {"side":"UP","notional":0,"limit":0.5}),
  ("a notional with no limit", {"side":"UP","notional":80}),
  ("a quotient that overflows", {"side":"UP","notional":1e308,"limit":0.01}),
  ("a size and a notional at once", {"side":"UP","size":10,"notional":80,"limit":0.5}),
  ("neither a size nor a notional", {"side":"UP","limit":0.5}),
  ("an infinite size", {"side":"UP","size":float("inf")}),
  ("an infinite limit", {"side":"UP","size":10,"limit":float("inf")}),
  ("a NaN limit", {"side":"UP","size":10,"limit":float("nan")}),
  ("a limit above one", {"side":"UP","size":10,"limit":2}),
  ("a limit below zero", {"side":"UP","size":10,"limit":-1}),
  ("a numeric string for a size", {"side":"UP","size":"10"}),
  ("a numeric string for a limit", {"side":"UP","size":10,"limit":"0.5"}),
  ("an array for a size", {"side":"UP","size":[10]}),
  ("a boolean for a size", {"side":"UP","size":True}),
  ("a numeric string for a notional", {"side":"UP","notional":"80","limit":0.5}),
]
out = []
for what, o in BAD:
    b = Book("m"); b.snapshot(1000, {"UP": {"asks": [[0.51,1000]], "bids": [[0.49,1000]]}})
    pf = Portfolio(fee_bps=0)
    try:
        r = pf.execute(b, o, 1001, "m")
        out.append([what, "threw" if False else ("filled" if r else "rejected"), pf.rejected])
    except Exception as e:
        out.append([what, "threw:" + type(e).__name__, pf.rejected])
print(json.dumps(out))
`;
  const { stdout } = await run(PYTHON, ['-c', py]);
  for (const [what, verdict, rejected] of JSON.parse(stdout)) {
    assert.equal(verdict, 'rejected',
      `Python ${verdict} on ${what} where JS counted it — the same input, two engines`);
    assert.equal(rejected, 1, `Python did not count ${what} as a rejection`);
  }
});

// ---------------------------------------------------------------------------
// session mode across markets that overlap in time
// ---------------------------------------------------------------------------

// Session mode shares one instance across markets. It used to be fed market
// after market, so a market open 00:00–00:15 was replayed to its end before one
// that opened at 00:05 — and the instance carried 00:15 into 00:05. The stream
// is now one time order (runner/session-feed.mjs); this pins that, and that
// both engines replay it identically, fills included.
test('session mode replays overlapping markets in one time order, identically in both engines', async () => {
  const A = { market_id: '0xA', asset: 'BTC', interval: '15m', strike: 65000, outcome: 'UP', open_ts_ms: 0, close_ts_ms: 15_000 };
  const B = { market_id: '0xB', asset: 'BTC', interval: '5m', strike: 65000, outcome: 'DOWN', open_ts_ms: 5_000, close_ts_ms: 20_000 };
  const lvl = (ts, px) => book(ts, { asks: [[px, 50], [Number((px + 0.02).toFixed(4)), 50]], bids: [[Number((px - 0.02).toFixed(4)), 80]] });
  const tickOf = (id) => (ts, value) => ({ kind: 'tick', ts_ms: ts, market_id: id, value });
  const scenario = {
    name: 'session-overlap',
    markets: [A, B],
    marketEvents: {
      '0xA': [lvl(500, 0.40), tickOf('0xA')(1_000, 65010), tickOf('0xA')(6_000, 65020), lvl(13_000, 0.70), tickOf('0xA')(14_000, 65100)],
      '0xB': [lvl(5_000, 0.55), tickOf('0xB')(5_500, 65015), tickOf('0xB')(9_000, 64990), tickOf('0xB')(19_000, 64950)],
    },
    js: `export class S {
      onMarketOpen(ctx, m) { this.max ??= -1; }
      onTick(ctx, t) {
        if (t.ts_ms < this.max) ctx.log("LOOKAHEAD " + t.market_id + " " + t.ts_ms + " after " + this.max);
        this.max = Math.max(this.max, t.ts_ms);
        ctx.log("tick " + t.market_id + " " + t.ts_ms + " pos " + Math.round(ctx.position().size));
        if (t.ts_ms === 6000 || t.ts_ms === 9000) return { side: "UP", size: 60, limit: 0.99 };
        return null;
      }
    }`,
    py: `class S:
    def on_market_open(self, ctx, market):
        if not hasattr(self, "mx"):
            self.mx = -1

    def on_tick(self, ctx, tick):
        if tick.ts_ms < self.mx:
            ctx.log("LOOKAHEAD " + tick.market_id + " " + str(tick.ts_ms) + " after " + str(self.mx))
        self.mx = max(self.mx, tick.ts_ms)
        ctx.log("tick " + tick.market_id + " " + str(tick.ts_ms) + " pos " + str(round(ctx.position().size)))
        if tick.ts_ms in (6000, 9000):
            return {"side": "UP", "size": 60, "limit": 0.99}
        return None
`,
  };
  const [js, py] = await Promise.all([
    run('js', scenario, { mode: 'session' }),
    run('python', scenario, { mode: 'session' }),
  ]);
  assert.equal(js.code, 0, js.stderr);
  assert.equal(py.code, 0, py.stderr);
  assert.doesNotMatch(js.logs, /LOOKAHEAD/, js.logs);
  assert.doesNotMatch(py.logs, /LOOKAHEAD/, py.logs);
  assert.equal(js.result.marketsRun, 2);
  assert.equal(py.result.marketsRun, 2);
  // Both markets traded, each against its own book at that moment: A at 0.40
  // (its 13s book has not happened yet at 6s), B at 0.55.
  assert.equal(js.fills.length, 2);
  assert.deepEqual(js.fills.map((f) => [f.market_id, f.ts_ms]).sort(), [['0xA', 6000], ['0xB', 9000]]);
  assert.equal(js.fills.find((f) => f.market_id === '0xA').avg_px, (0.40 * 50 + 0.42 * 10) / 60);
  assert.equal(js.fills.find((f) => f.market_id === '0xB').avg_px, (0.55 * 50 + 0.57 * 10) / 60);
  assert.deepEqual(py.fills, js.fills);
  assert.deepEqual(py.trades, js.trades);
  assert.equal(py.logs, js.logs);
});

// ---------------------------------------------------------------------------
// venue fees
// ---------------------------------------------------------------------------

// Polymarket charges the taker C × rate × p × (1 − p), rounded to 5 decimals.
// Expected values are worked by hand here, never taken from either engine:
// agreement alone would pass two engines that are wrong the same way.
const FEE_BUY = {
  name: 'fee-buy',
  js: `export class S {
    onMarketOpen(ctx, m) {}
    onTick(ctx, t) { if (!this.done) { this.done = true; return { side: "UP", size: 100, limit: 0.99 }; } return null; }
  }`,
  py: `class S:
    def on_market_open(self, ctx, market):
        self.done = False

    def on_tick(self, ctx, tick):
        if not self.done:
            self.done = True
            return {"side": "UP", "size": 100, "limit": 0.99}
        return None
`,
  marketEvents: {
    '0xfee': [
      book(1000, { asks: [[0.50, 60], [0.52, 40]], bids: [[0.48, 100]] }),
      { kind: 'tick', ts_ms: 1500, market_id: '0xfee', value: 65000 },
    ],
  },
};
const feeMarket = (fee) => ({ market_id: '0xfee', asset: 'BTC', interval: '5m', strike: 65000, outcome: 'UP', close_ts_ms: 10_000, ...(fee === undefined ? {} : { fee }) });

for (const [label, fee, fees, want] of [
  // 60 × 0.07 × 0.50 × 0.50 = 1.05; 40 × 0.07 × 0.52 × 0.48 = 0.69888.
  ['the venue schedule, per level taken', { model: 'polymarket-taker-v1', rate: 0.07 }, { mode: 'venue' }, 1.74888],
  ['a market the venue does not charge', { model: 'none' }, { mode: 'venue' }, 0],
  ['a schedule we could not read', null, { mode: 'venue' }, 0],
  ['an explicit zero override', { model: 'polymarket-taker-v1', rate: 0.07 }, { mode: 'bps', bps: 0 }, 0],
  // 60 × 0.50 + 40 × 0.52 = 50.8 notional; 100 bps = 0.508.
  ['a flat override', { model: 'polymarket-taker-v1', rate: 0.07 }, { mode: 'bps', bps: 100 }, 0.508],
]) {
  test(`venue fees: ${label}`, async () => {
    const scenario = { ...FEE_BUY, markets: [feeMarket(fee)] };
    const [js, py] = await Promise.all([
      run('js', scenario, { fees, feeBps: 999 }),
      run('python', scenario, { fees, feeBps: 999 }),
    ]);
    assert.equal(js.code, 0, js.stderr);
    assert.equal(py.code, 0, py.stderr);
    assert.ok(Math.abs(js.result.feesPaid - want) < 1e-12, `js charged ${js.result.feesPaid}, want ${want}`);
    assert.ok(Math.abs(py.result.feesPaid - want) < 1e-12, `py charged ${py.result.feesPaid}, want ${want}`);
    assert.equal(js.fills[0].fee, py.fills[0].fee);
    assert.deepEqual(py.trades, js.trades);
  });
}

// Time moves for every hook, not only for events. B schedules a delayed order
// at 1s that lands at 6s; nothing else happens until A settles at 200s. A's
// on_settle runs at 200s, so B's fill (at 6s) has happened: a strategy that
// kept B's ctx and reads it there must see the position. Before, only an
// EVENT advanced the other markets, and an opening or a settlement saw the
// shared portfolio as it was before the delayed fill.
test('session mode advances every open market before openings and settlements too', async () => {
  const A = { market_id: '0xA', asset: 'BTC', interval: '15m', strike: 65000, outcome: 'UP', open_ts_ms: 0, close_ts_ms: 200_000 };
  const B = { market_id: '0xB', asset: 'BTC', interval: '15m', strike: 65000, outcome: 'DOWN', open_ts_ms: 1_000, close_ts_ms: 300_000 };
  const C = { market_id: '0xC', asset: 'BTC', interval: '5m', strike: 65000, outcome: 'UP', open_ts_ms: 150_000, close_ts_ms: 250_000 };
  const lvl = (ts) => book(ts, { asks: [[0.50, 100]], bids: [[0.48, 100]] });
  const tk = (id, ts) => ({ kind: 'tick', ts_ms: ts, market_id: id, value: 65000 });
  const scenario = {
    name: 'session-hook-time',
    hooks: ['on_settle'],
    markets: [A, B, C],
    marketEvents: {
      '0xA': [lvl(0), tk('0xA', 500)],
      '0xB': [lvl(1_000), tk('0xB', 1_000), tk('0xB', 299_000)],
      '0xC': [lvl(150_000), tk('0xC', 240_000)],
    },
    js: `export class S {
      onMarketOpen(ctx, m) {
        if (m.market_id === "0xC" && this.b) ctx.log("C opens, B holds " + Math.round(this.b.position().size));
      }
      onTick(ctx, t) {
        if (t.market_id === "0xB" && t.ts_ms === 1000) { this.b = ctx; return { side: "UP", size: 60, limit: 0.99 }; }
        return null;
      }
      onSettle(ctx, m, o) {
        if (m.market_id === "0xA" && this.b) ctx.log("A settles, B holds " + Math.round(this.b.position().size));
      }
    }`,
    py: `class S:
    def on_market_open(self, ctx, market):
        if market.market_id == "0xC" and getattr(self, "b", None) is not None:
            ctx.log("C opens, B holds " + str(round(self.b.position().size)))

    def on_tick(self, ctx, tick):
        if tick.market_id == "0xB" and tick.ts_ms == 1000:
            self.b = ctx
            return {"side": "UP", "size": 60, "limit": 0.99}
        return None

    def on_settle(self, ctx, market, outcome):
        if market.market_id == "0xA" and getattr(self, "b", None) is not None:
            ctx.log("A settles, B holds " + str(round(self.b.position().size)))
`,
  };
  const [js, py] = await Promise.all([
    run('js', scenario, { mode: 'session', fillDelayMs: 5_000 }),
    run('python', scenario, { mode: 'session', fillDelayMs: 5_000 }),
  ]);
  assert.equal(js.code, 0, js.stderr);
  assert.equal(py.code, 0, py.stderr);
  for (const [lang, r] of [['js', js], ['py', py]]) {
    assert.match(r.logs, /C opens, B holds 60/, `${lang}: C's opening did not see B's 6s fill\n${r.logs}`);
    assert.match(r.logs, /A settles, B holds 60/, `${lang}: A's settlement did not see B's 6s fill\n${r.logs}`);
  }
  assert.equal(py.logs, js.logs);
  assert.deepEqual(py.fills, js.fills);
  assert.deepEqual(py.trades, js.trades);
});

// The fee schedule the engine charges from is its own copy. The same object
// reaches the strategy as `market.fee`; writing to it must change nothing.
test('a strategy cannot change the fee it pays by editing market.fee', async () => {
  const scenario = {
    ...FEE_BUY,
    name: 'fee-tamper',
    markets: [feeMarket({ model: 'polymarket-taker-v1', rate: 0.07 })],
    js: FEE_BUY.js.replace('onMarketOpen(ctx, m) {}', 'onMarketOpen(ctx, m) { if (m.fee) { try { m.fee.rate = 0; m.fee.model = "none"; } catch {} } }'),
    py: FEE_BUY.py.replace('        self.done = False', '        self.done = False\n        if market.fee:\n            try:\n                market.fee["rate"] = 0\n                market.fee["model"] = "none"\n            except Exception:\n                pass'),
  };
  assert.notEqual(scenario.js, FEE_BUY.js, 'the JS tamper was not inserted');
  assert.notEqual(scenario.py, FEE_BUY.py, 'the Python tamper was not inserted');
  const [js, py] = await Promise.all([
    run('js', scenario, { fees: { mode: 'venue' } }),
    run('python', scenario, { fees: { mode: 'venue' } }),
  ]);
  assert.equal(js.code, 0, js.stderr);
  assert.equal(py.code, 0, py.stderr);
  assert.ok(Math.abs(js.result.feesPaid - 1.74888) < 1e-12, `js charged ${js.result.feesPaid}`);
  assert.ok(Math.abs(py.result.feesPaid - 1.74888) < 1e-12, `py charged ${py.result.feesPaid}`);
});
