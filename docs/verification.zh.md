# 我们如何验证

回测的价值取决于你能核查什么。引擎有两份实现——JavaScript（CLI、托管队列、Node 策略）和 Python（本地和沙箱中的 Python 策略）——归档解码器和报告也有两份实现——JavaScript（CLI 和队列）和 Python（`outcometick.backtest`）。同一套规则的两个实现会悄悄偏离，除非有东西对照它们。下面这些检查承担这一任务。

## 引擎之间的对照

`runner/conformance/`（位于 [polymarket-backtest-js](https://github.com/outcometick/polymarket-backtest-js)）以真实子进程在相同输入上运行两个 harness（运行策略的那一层），并比较每个交易和成交字段：延迟订单、持仓时限到期、部分减仓、不可用订单、单侧快照、最优买卖价剪枝、预算和日志上限、跨重叠市场的 session 模式，以及平台手续费的每种状态。手续费案例的预期值由手算得出，不取自任一引擎——仅仅一致，会让两个以同样方式出错的引擎通过。

## 解码器与报告之间的对照

`verify/equivalence.test.mjs`（位于 [polymarket-backtest](https://github.com/outcometick/polymarket-backtest)）用两个解码器解码同一份归档，比较每个市场和每个事件。然后分别通过命令行（由 Node 提供输入的 Python harness）和 `outcometick.backtest`（在进程内提供输入的同一个 harness 循环）运行 Python 策略，要求除实际耗时以外的每个报告字段，以及每条交易和成交行都一致。最后运行分别用 JavaScript 和 Python 写的同一策略，要求交易、成交和日志逐字节相同。

它在两份合成归档上运行，专门包含真实日期中很少出现的情况：跨午夜的市场、没有结算 tick 的市场、未结算市场、Predict.fun 平局、手续费关闭和手续费不可读、按 30 秒 TWAP 结算的市场、同一毫秒五种事件、恰好落在抽稀间隔边界上的增量、空文件。把 `OT_SAMPLE_DIR` 指向解压后的公开样本，它也会在这些样本上运行。第一次 CI 运行时，它发现 Python 的 `os.scandir` 按文件系统顺序返回文件，而 Node 的 `readdir` 会排序。

`verify/js-semantics.test.mjs` 用 JavaScript 本身核对 Python 解码器复现的 JavaScript 数值规则——`Number(" 12 ")`、`Number("0x10")`、`(0.125).toFixed(2)`、`Math.round(0.49999999999999994)`、超过 1e21 时的数值转字符串。


## 用你自己的数据

`verify/generic-equivalence.test.mjs` 对你自带的数据（任意 Polymarket 二元市场）做同样的检查：合成数据集包含每种帧形态、每种结算结果来源、以三种方式估值的未结算市场、每条严格规则各拒绝一个市场、在流中途开始的窗口、跨市场的同毫秒序列、gzip 文件、CRLF 行尾和垃圾行。两个解码器必须生成相同的市场、拒绝结果、行数和事件；随后，相同策略——按结果标签下单、挂单报价、session 模式——分别通过命令行用 JavaScript 和 Python 运行，并通过 Python 库运行，每条交易、成交、报告字段和日志行都必须一致。一致性测试把通用市场加入引擎之间的对照：镜像增量、与被它删掉的档位同一毫秒到达的最优价边界、结算前结束交易、有估值和无估值的仓位。在真实公开样本上，把一个归档日重新写成通用数据（帧按归档自身顺序排列），重放会得到相同成交，以及除结算毫秒之外相同的交易。
## 手算答案

`tests/test_backtest.py`（Python 仓库）构造只有一个市场的归档，用纸上计算的算术核对结果：跨两档的成交价、逐档手续费、结算兑付、已知为零的手续费、统一费率覆盖、延迟、结算前隐藏结果，以及缓存解码后重放结果完全相同。

## 运行这些检查

Python 仓库：

```bash
pip install .
python -m unittest discover -s tests
npm install --no-save outcometick@"$(python -c 'import json; print(json.load(open("verify/version.json"))["version"])')"
node --test 'verify/*.test.mjs'                        # needs Node 24 and python3
OT_SAMPLE_DIR=/path/to/samples node --test 'verify/*.test.mjs'   # also on the real sample days
```

JavaScript 仓库：

```bash
npm install && npm test
node --test runner/conformance/*.test.mjs              # needs python3
```

## 这里尚未证明的内容

- 归档完整：它并不完整。数据产品按日公布采集缺口，回测会列出无法重放的每个市场日。
- 按盘口档位估算的手续费等于平台按每笔撮合收取的手续费：见[方法论 § 5](methodology.zh.md#5-手续费)。
- 在这些日期上有效的策略，在其他日期上也会有效。
