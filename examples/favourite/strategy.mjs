// Buy the favourite in the last minute when its ask is within the entry range.
//
//   ot check examples/favourite
//   ot run examples/favourite --data ./polymarket-data-samples
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
