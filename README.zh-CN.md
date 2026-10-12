<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# outcometick 回测 · JavaScript / TypeScript

用 JavaScript / TypeScript 编写的 Polymarket 逐笔回测引擎。选举、体育、加密货币等任意二元市场，只要有两个结果，
用自己采集的盘口数据（`ot run --data <你的数据>`）即可回测；也可以先用一天免费的真实归档试跑。写一个策略类，用 `ot` 命令行在本地重放；
要回测归档中加密市场的完整区间时，把同一份文件提交到[托管回测](https://outcometick.com/zh/backtest)。按当时的盘口深度逐档成交，
每个市场只在有结果凭据时以 1 美元 / 0 美元结算，每一笔吃单成交都扣平台的吃单手续费。做市策略可以挂限价单：排队模型按 Polymarket 实际的撮合记录方式建立，
报告给出成交后的价格走势，便于评估这些成交。

[English](README.md) · **简体中文** · [文档站](https://outcometick.github.io/polymarket-backtest/zh/) · [给 AI agent 的说明](https://outcometick.github.io/polymarket-backtest/agents/)（英文） · [方法说明](docs/methodology.zh.md) · [我们怎么验证](docs/verification.zh.md) ·
Python 版：[polymarket-backtest](https://github.com/outcometick/polymarket-backtest)

> 开源（MIT），由 [outcometick.com](https://outcometick.com/zh) 维护。它另外提供现成的 Polymarket 与 Predict.fun 加密涨跌市场逐笔归档，
> 并提供使用同一引擎的托管回测；使用本项目无需购买这两项服务。[详见下文。](#outcometickcom-上还有什么)

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

`ot run` 会打印主要指标，并把完整结果（报告 JSON、全部成交和 fill 的 CSV、日志、校验和）打包成 zip，可直接在 notebook 中使用。
一天的数据默认使用全部 CPU 核解码（可用内存不足一半时减少进程数，`--workers` 可指定），解码结果会缓存（`--cache off` 关闭）：样本日首次约 21 秒、再跑约 10 秒，
单线程且不缓存约 53 秒，结果逐字节相同。确认结果后，可提交托管回测：

```bash
export OT_BACKTEST_KEY=bt_...          # 在 outcometick.com/zh/backtest 获取
ot fingerprint my-strategy --assets btc,eth --from <day> --to <day>   # 预注册：先公布这个值
ot submit my-strategy --assets btc,eth --from <day> --to <day>
ot status run_...                      # 完成后：ot fetch run_...
```

## 回测规则与实现

结算按平台规则，不做近似。市场只在有结果凭据时兑付 1 美元或 0 美元：用自己的数据时，凭据是 Gamma 的结算状态、
`market_resolved` 帧或你提供的结果，各来源的结果必须一致；用归档里的加密市场时，按该市场实际使用的 Chainlink 结算流读取官方结果。结算流可能是瞬时流、
30 秒 TWAP 或 60 秒 TWAP，具体由市场配置决定（`twapLookbackSeconds`），不按日期推断。Predict.fun 平局按 50:50 兑付。
无法读取结果的市场不参与回测，报告会列出这些市场，不推测结算结果。

每个市场两本盘口。UP 和 DOWN 是两个代币，各有自己的买卖档位。买 UP 吃 UP 的卖档，平仓卖进 UP 的买档。
（Predict.fun 每个市场只发布一本盘口，所以它的 DOWN 一侧是 UP 的镜像。）

按当时的盘口深度逐档成交。订单按对应毫秒重建的盘口逐档成交，盘口里没有的数量记为未成交，不会按最优价全部成交。
清单里写 `"latency": 250`，每笔订单就按它实际到达时的盘口成交，成交仍受限价约束。

按市场费率计算吃单手续费。Polymarket 向吃单方收取 `C × rate × p × (1 − p)`，每个市场的费率表都在归档里，每笔模拟成交都扣手续费。
报告写明用了哪种手续费模型、有多少个市场读不到费率表。手续费取整方式是估算，报告也会注明：平台按每笔撮合的挂单分别取整，
归档里只有档位，所以这里按吃掉的每个档位计算并取整。清单里写 `"fee_bps"` 可以改成统一费率。

挂单按平台真实的撮合方式排队。`new Order({ ..., tif: "gtc" })` 按限价挂着，排在该价位已可见的量后面。排队模型依据归档中观察到的三项事实建立，不套用通用交易所模型：
盘口互为镜像（UP 在 q 的买单和 DOWN 在 1 − q 的卖单是同一个队列，只是发布了两次）；每笔成交只记录一次，且记在吃单方的代币上。因此，DOWN 买家吃掉挂着的 UP 买单（即铸造撮合）时，也会推进 UP 买单的队列；
只看单个代币的模型会漏掉大约一半的消耗。
成交记录可能晚于它引起的盘口变化到达。
因此，只有成交价格触达挂单时，才会触发挂单成交；计算时先扣除成交前不久盘口已移除的数量
（按这些数量原来的价位扣除）；新挂单在一个很短的滞后窗口内忽略所有成交；撤单后，在这个窗口内仍有成交风险。`"latency"` 和 `"cancel_latency"`
分开设置，挂单成交不收手续费（不计返佣），JavaScript 和 Python 两个引擎逐笔一致。`ctx.orders()` 列出还在挂的单，`ctx.cancel(id)` 撤单。
报告还提供做市指标：成交率、入队时和成交时的前方排队量、排队时长，以及每笔成交后 1 秒 / 10 秒 / 60 秒和到结算的价格走势，用于评估逆向选择的程度。

避免前视。事件逐条传给策略，当天剩下的数据不在进程里；市场的 `outcome` 在 `onSettle` 之前不可见。
session 模式下，时间上重叠的市场按同一条时间线交错重放，跨市场保留的状态不会提前访问尚未发生的事件。

本地和托管是同一套代码。`ot run` 使用的解码、引擎、harness 和报告与托管队列相同，`ot check` 就是队列自己的校验器：
通过本地校验的策略，提交时不会因校验差异遭到拒绝。JavaScript 和 Python 两个引擎逐笔互相核对。详见[我们怎么验证](docs/verification.zh.md)。

为二元市场设计的报告。Brier 分数、按入场价分桶的校准、每份合约的边际、峰值占用资金、滑点面板，以及同样下单规模的朴素基准：
一直买 UP、一直买 DOWN、开盘时一直买热门。报告第一页会列出策略是否跑赢「买热门」基准。

数据限制。盘口由按固定采集频率获取的快照和增量重建；不抽稀的最优买卖价流只能删除已被越过的档位，不能补充缺失档位。
报告会列出每个无法重放的市场日及原因。

## 用你自己的数据：任意 Polymarket 二元市场

归档里只有加密货币涨跌市场。其他市场（选举、体育、任何两个结果的市场）可以让 `ot run` 指向自己的数据目录：
顶层放 `markets.json`（或 `.jsonl`），下面放 `*.jsonl` / `*.jsonl.gz` 的 Polymarket CLOB 行情帧。

```bash
ot run ./my-strategy --data ./my-polymarket-data
```

- 市场用 Gamma API 返回的市场对象，或 `{market_id, token_ids, labels, ...}`。
- 行情帧使用 Polymarket 原生格式：`book`、`price_change`、`best_bid_ask`、`last_trade_price`、`market_resolved`，
  可以保持原样，也可以放在 `payload` 下。帧里带的每个标识都必须指向同一个市场。
- 下单可以写结果名（`side: "Yes"`、`"Lakers"`）；使用市场中不存在的标签，回测立即停止。
- 只凭证据结算（Gamma 的结算结果、`market_resolved` 帧，或你提供的 `resolution: {outcome, resolved_ts_ms}`，
  且全部一致）。结果公开的前一毫秒停止交易，兑付记在那个时刻。未结算的市场在交易结束时按外部中间价估值
  （`--mark-max-age-ms` 拒绝过旧的报价；没有估值的仓位按 0 计），与已实现盈亏分开报告。
- 无法读取的盘口行会让整个市场不参与回放，报告里列出原因。Python 包另外能读单盘口表格形态（`Dataset.from_pmdata`）。

## 执行选项

默认全部关闭，在 `outcometick.json` 里设置（托管和 `ot run` 一样）：`"fok": true` 允许全成或全撤的订单；
`"order_rules": "assumed"`（归档：价格网格 0.001、最少 5 股、数量以 0.01 股为单位）或 `"venue"`（自己的数据）；
`"maker_rebate": 0.2`（挂单返佣的估算）；`"quote_guard": {"max_age_ms": 1500, "ask_sum": [0.92, 1.08]}`；单盘口市场用
`"mirror_depth": "shared"`。本地可以用 `ot run --book-throttle off` 不抽稀回放归档盘口。各选项的行为与限制，
见 [方法说明 §10](docs/methodology.zh.md#10-执行选项)。

声明 `onTimer` hook（配合 `ctx.schedule(atMs, tag)`）或 `"feed_latency"` 后，同一次运行的所有市场共用一条时间线：定时器在指定时刻唤醒策略；
设了行情延迟时，策略按设置的延迟收到每个事件，而订单仍按平台盘口撮合（[§11](docs/methodology.zh.md#11-定时器与行情延迟同一条时间线)）。
挂单可以用 `"queue_model": {"prob": "power", "n": 2}`（或 `power2`、`power3`、`log`、`log2`）估计无法用成交解释的档位减量中，有多少发生在你的排队位置之前，默认模型则假定这部分减量不发生在你前面。这是估计，请与默认结果对比（[§12](docs/methodology.zh.md#12-概率排队模型可选)）。
`"record_ms": 60000` 按时间网格记录账户价值（未平仓按最优买价估值）及其回撤，结果保存在归档里的 `record.csv`（[§13](docs/methodology.zh.md#13-记录器按时间网格盯市估值)）。
声明 `spot` 数据集后可用 `ctx.spot()` 和 `ctx.twap_locked()`，查看结算 TWAP 已累计的时长及当前水平。这是根据 Chainlink 逐秒流计算的近似值，误差实测见
[§14](docs/methodology.zh.md#14-即时价格与结算-twap-已锁定的部分可选)。

## 包里还有

- `outcometick/data`：数据订阅客户端（列文件、下载并校验 sha256），以及 `OrderBook`，用归档的 `book`、`price_change`、
  `best_bid_ask` 行重建 Polymarket 盘口。
- `ot mcp`：MCP 服务，Claude Code、Cursor 可以查归档、下载文件、在本地检查策略；它从不提交回测。
- SDK 和数据客户端的 TypeScript 类型声明。

## 限制

- 挂单：排队位置是从聚合档位估算的（数据里没有单个挂单），盘口增量按采集频率抽稀，你的订单不产生市场冲击。挂单只支持 Polymarket：
  Predict.fun 的归档没有成交流，无法推进排队，因此不接受 Predict.fun 的 `gtc`。独立核对器目前还不重算挂单成交。
- 归档里只有 5 分钟和 15 分钟的加密货币涨跌市场。其他 Polymarket 二元市场用自己的数据回测（见上文）；托管回测只跑归档数据。
- 币安参考价流在托管机器上，读它的策略只能提交，不能在本地跑。
- 单个样本日的结果不能代表下个月。评估回测指标前，先在一段时间范围内验证。

## outcometick.com 上还有什么

- 数据归档：[Polymarket 与 Predict.fun 加密涨跌市场的逐笔归档](https://outcometick.com/zh)：盘口快照与增量、成交、
  最优买卖价、市场元数据，以及市场结算所用的 Chainlink 价格流，按天发布。`ot run --data` 可以直接读下载好的某一天。
  免费样本在 [GitHub](https://github.com/outcometick/polymarket-tick-data-samples)、Kaggle 和 Hugging Face 上也有。
- 托管回测：[outcometick.com/zh/backtest](https://outcometick.com/zh/backtest)：网页编辑器或 `ot submit`，在我们的机器上用最近几周的数据跑，
  无需下载数据；按扫描的市场日计费，没有产出报告的运行不收费。
- 结算审计：[逐个市场](https://outcometick.com/zh/polymarket-settlement-audit)用归档的 Chainlink 流重算结算结果，并与平台结果对比。

## 社区

提问、讨论策略或核对回测结果，可以加入：

- Discord（中英文分区）：https://discord.gg/ZDMqkptwm5
- Telegram 群：https://t.me/+TcK_hJOzOz5mZTk1

## 仓库结构

npm 包 `outcometick` 的源码和测试（`npm install && npm test`）：`ot` 命令行（`cli/`）、引擎和 harness（`runner/`）、共用的归档解码和契约
（`runner/events.mjs`、`api/lib/`）、数据客户端（`client/`）、策略模板（`templates/`）。`examples/` 是可运行的策略。

由 outcometick 主仓库生成，托管回测跑的也是这套代码；npm 发布在
[outcometick-sdk-ts](https://github.com/outcometick/outcometick-sdk-ts)。欢迎在这里提 issue 和 PR。

许可证：MIT。
