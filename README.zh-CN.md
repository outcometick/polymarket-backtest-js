<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# outcometick 回测 · JavaScript / TypeScript

**用 JavaScript 对 Polymarket 与 Predict.fun 加密货币涨跌市场做逐笔回测；自带数据时，任意 Polymarket 二元市场都能回测。** 写一个策略类，用 `ot` 命令行在本地按归档的真实盘口重放；
想跑完整区间时，把同一份文件提交到[托管回测](https://outcometick.com/zh/backtest)。每个市场都按它实际使用的 Chainlink 结算流
以 1 美元 / 0 美元结算，每一笔吃单成交都扣平台的吃单手续费。做市策略可以挂限价单：排队模型按 Polymarket 实际的撮合记录方式建立，
报告给出成交后的价格走势，看这些成交值不值。

[English](README.md) · **简体中文** · [方法说明](docs/methodology.md)（英文） · [我们怎么验证](docs/verification.md)（英文） ·
Python 版：[polymarket-backtest](https://github.com/outcometick/polymarket-backtest)

> 出自 [outcometick.com](https://outcometick.com/zh)：这里重放的 Polymarket 与 Predict.fun 逐笔数据归档来自那里，
> 托管回测用的也是这个引擎。[详见下文。](#outcometickcom-上还有什么)

```bash
npm i -g outcometick             # Node 24：ot 命令行、策略 SDK、数据客户端
ot init my-strategy --template favourite-near-close --lang nodejs
curl -L https://github.com/outcometick/polymarket-tick-data-samples/releases/latest/download/polymarket-data-samples.tar.gz | tar xz
ot check my-strategy             # 和托管队列完全相同的校验器
ot run my-strategy --data ./polymarket-data-samples
```

一个策略就是一个类加一份清单：

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

`ot run` 会打印主要指标，并把完整结果（报告 JSON、全部成交和 fill 的 CSV、日志、校验和）写成一个 zip，可以直接拿到 notebook 里用。
解码后的数据会缓存（`--cache off` 关闭），同一个样本日再跑约 11 秒（首次约 53 秒），结果逐字节相同。确认没问题后：

```bash
export OT_BACKTEST_KEY=bt_...          # 在 outcometick.com/zh/backtest 获取
ot fingerprint my-strategy --assets btc,eth --from <day> --to <day>   # 预注册：先公布这个值
ot submit my-strategy --assets btc,eth --from <day> --to <day>
ot status run_...                      # 完成后：ot fetch run_...
```

## 它做对了什么

**结算按平台规则，不做近似。** Polymarket 的加密市场在一条 Chainlink 流上结算：瞬时流、30 秒 TWAP 或 60 秒 TWAP，用哪条写在
市场自己的配置里（`twapLookbackSeconds`），不按日期推。每个市场都对着自己的结算流重放，按官方结果兑付 1 美元或 0 美元；
Predict.fun 平局按 50:50 兑付。读不出结算流或结果的市场会被剔除并在报告里列出，绝不靠猜来结算。

**每个市场两本盘口。** UP 和 DOWN 是两个代币，各有自己的买卖档位。买 UP 吃 UP 的卖档，平仓卖进 UP 的买档。
（Predict.fun 每个市场只发布一本盘口，所以它的 DOWN 一侧是 UP 的镜像。）

**按当时挂着的深度逐档成交。** 订单对着那一毫秒重建出的盘口逐档成交，盘口里没有的数量记为未成交，不会按最优价全部成交。
清单里写 `"latency": 250`，每笔订单就按它实际到达时的盘口成交，限价照样保护它。

**按市场收平台吃单费。** Polymarket 向吃单方收取 `C × rate × p × (1 − p)`，每个市场的费率表都在归档里，每一笔模拟成交都会扣。
报告写明用了哪种手续费模型、有多少个市场读不到费率表。有一点是估算，报告里也写明了：平台按每笔撮合的挂单分别取整，
归档里只有档位，所以这里按吃掉的每个档位计算并取整。清单里写 `"fee_bps"` 可以改成统一费率。

**挂单按平台真实的撮合方式排队。** `new Order({ ..., tif: "gtc" })` 按限价挂着，排在该价位已可见的量后面。排队模型建立在对归档的三条实测事实上，
而不是套用一个通用交易所：盘口是**镜像**的（UP 在 q 的买单和 DOWN 在 1 − q 的卖单是同一个队列，只是发布了两次）；每笔成交
**只打印一次、而且打在吃单方的代币上**（所以 DOWN 的买家吃掉挂着的 UP 买单——也就是铸造撮合——同样会推进 UP 买单的排队；只看单个代币的模型会漏掉大约一半的消耗）；
成交记录可能**晚于**它引起的盘口变化到达。所以一笔成交只有价格触达挂单时才能让它成交，而且先从同一份量里扣掉成交前不久被盘口移除的量
（按那部分量原来的价位扣）；新挂单在一个很短的滞后窗口内忽略所有成交，撤单后在这个窗口内仍会暴露。`"latency"` 和 `"cancel_latency"`
分开设置，挂单成交不收手续费（不计返佣），JavaScript 和 Python 两个引擎逐笔一致。`ctx.orders()` 列出还在挂的单，`ctx.cancel(id)` 撤单。
报告加上做市最看重的指标：成交率、入队时和成交时的前方排队量、排队时长，以及每笔成交后 1 秒 / 10 秒 / 60 秒和到结算的价格走势——逆向选择有多严重，直接看数字。

**结构上就看不到未来。** 事件一条一条地交给策略，当天剩下的数据不在进程里；市场的 `outcome` 在 `onSettle` 之前不可见。
session 模式下，时间上重叠的市场按同一条时间线交错重放，跨市场保留的状态不会跑到时钟前面去。

**本地和托管是同一套代码。** `ot run` 用的解码、引擎、harness 和报告就是托管队列用的那一套，`ot check` 就是队列自己的校验器：
它接受的策略，提交时不会因为校验差异被拒。JavaScript 和 Python 两个引擎逐笔互相核对。详见[我们怎么验证](docs/verification.md)。

**为二元市场设计的报告。** Brier 分数、按入场价分桶的校准、每份合约的边际、峰值占用资金、滑点面板，以及同样下单规模的朴素基准：
一直买 UP、一直买 DOWN、开盘时一直买热门。如果策略连「买热门」都跑不赢，报告第一页就会告诉你。

**对数据坦白。** 盘口由按固定节奏采集的快照和增量重建；不抽稀的最优买卖价流只能删掉已被越过的档位，不能凭空添加。
每个没能重放的市场日都会列出原因。

## 用你自己的数据：任意 Polymarket 二元市场

归档里只有加密货币涨跌市场。其他市场（选举、体育、任何两个结果的市场）可以让 `ot run` 指向你自己的数据目录：
顶层放 `markets.json`（或 `.jsonl`），下面放 `*.jsonl` / `*.jsonl.gz` 的 Polymarket CLOB 行情帧。

```bash
ot run ./my-strategy --data ./my-polymarket-data
```

- **市场**用 Gamma API 返回的市场对象，或 `{market_id, token_ids, labels, ...}`。
- **行情帧**就是 Polymarket 自己的：`book`、`price_change`、`best_bid_ask`、`last_trade_price`、`market_resolved`，
  原样或放在 `payload` 下。帧里带的每个标识都必须指向同一个市场。
- **下单可以写结果名**（`side: "Yes"`、`"Lakers"`）；写了市场没有的标签，回测直接停止。
- **只凭证据结算**（Gamma 的结算结果、`market_resolved` 帧，或你提供的 `resolution: {outcome, resolved_ts_ms}`，
  且全部一致）。结果公开的前一毫秒停止交易，兑付记在那个时刻。未结算的市场在交易结束时按外部中间价估值
  （`--mark-max-age-ms` 拒绝过旧的报价；没有估值的仓位按 0 计），与已实现盈亏分开报告。
- 读不出的盘口行会让整个市场不参与回放，报告里列出原因。Python 包另外能读单盘口表格形态（`Dataset.from_pmdata`）。

## 执行选项

默认全部关闭，在 `outcometick.json` 里设置（托管和 `ot run` 一样）：`"fok": true` 允许全成或全撤的订单；
`"order_rules": "assumed"`（归档：价格网格 0.001、最少 5 股、数量以 0.01 股为单位）或 `"venue"`（你自己的数据）；
`"maker_rebate": 0.2`（挂单返佣的估算）；`"quote_guard": {"max_age_ms": 1500, "ask_sum": [0.92, 1.08]}`；单盘口市场用
`"mirror_depth": "shared"`。本地可以用 `ot run --book-throttle off` 不做抽稀地回放归档盘口。每一项做什么、做不到什么，
见 [Methodology §10](docs/methodology.md#10-execution-options)。

声明 `onTimer` hook（配合 `ctx.schedule(atMs, tag)`）或 `"feed_latency"` 后，同一次运行的所有市场走同一条时间线：定时器在指定时刻唤醒策略；
设了行情延迟时，策略晚这么久才收到每个事件，而订单仍按平台盘口撮合（[§11](docs/methodology.md#11-timers-and-feed-latency-one-time-line)）。
挂单可以用 `"queue_model": {"prob": "power", "n": 2}`（或 `power2`、`power3`、`log`、`log2`）估计没有成交能解释的档位减量中有多少发生在你前面，
而不是假定一点都没有。这是估计，请与默认结果对比（[§12](docs/methodology.md#12-probabilistic-queue-models-optional)）。
`"record_ms": 60000` 按时间网格记录账户价值（未平仓按最优买价估值）及其回撤，归档里的 `record.csv`（[§13](docs/methodology.md#13-the-recorder-mark-to-market-on-a-time-grid)）。

## 包里还有

- **`outcometick/data`**：数据订阅客户端（列文件、下载并校验 sha256），以及 `OrderBook`，用归档的 `book`、`price_change`、
  `best_bid_ask` 行重建 Polymarket 盘口。
- **`ot mcp`**：MCP 服务，Claude Code、Cursor 可以查归档、下载文件、在本地检查策略；它从不提交回测。
- SDK 和数据客户端的 TypeScript 类型声明。

## 限制

- 挂单：排队位置是从聚合档位估算的（数据里没有单个挂单），盘口增量按采集频率抽稀，你的订单不产生市场冲击。挂单只支持 Polymarket：
  Predict.fun 的归档没有成交流，无法推进排队，所以那里拒绝 `gtc`。独立核对器目前还不重算挂单成交。
- 归档里只有 5 分钟和 15 分钟的加密货币涨跌市场。其他 Polymarket 二元市场用你自己的数据回测（见上文）；托管回测只跑归档数据。
- 币安参考价流在托管机器上，读它的策略只能提交，不能在本地跑。
- 一个样本日说明不了下个月。相信任何数字之前，先在一段时间范围上回测。

## outcometick.com 上还有什么

- **数据本身。** [Polymarket 与 Predict.fun 加密涨跌市场的逐笔归档](https://outcometick.com/zh)：盘口快照与增量、成交、
  最优买卖价、市场元数据，以及市场结算所用的 Chainlink 价格流，按天发布。`ot run --data` 可以直接读下载好的某一天。
  免费样本在 [GitHub](https://github.com/outcometick/polymarket-tick-data-samples)、Kaggle 和 Hugging Face 上也有。
- **托管回测。** [outcometick.com/zh/backtest](https://outcometick.com/zh/backtest)：网页编辑器或 `ot submit`，在我们的机器上用最近几周的数据跑，
  什么都不用下载；按扫描的市场日计费，没有产出报告的运行不收费。
- **结算审计。** [逐个市场](https://outcometick.com/zh/polymarket-settlement-audit)用归档的 Chainlink 流重算结算结果，并和平台的结果对比。

## 社区

有问题、想讨论策略或对一对回测结果，欢迎来：

- Discord（中英文分区）：https://discord.gg/ZDMqkptwm5
- Telegram 群：https://t.me/+TcK_hJOzOz5mZTk1

## 仓库结构

npm 包 `outcometick` 的源码和测试（`npm install && npm test`）：`ot` 命令行（`cli/`）、引擎和 harness（`runner/`）、共用的归档解码和契约
（`runner/events.mjs`、`api/lib/`）、数据客户端（`client/`）、策略模板（`templates/`）。`examples/` 是可运行的策略。

由 outcometick 主仓库生成，托管回测跑的也是这套代码；npm 发布在
[outcometick-sdk-ts](https://github.com/outcometick/outcometick-sdk-ts)。欢迎在这里提 issue 和 PR。

许可证：MIT。
