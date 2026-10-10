# How we verify it

A backtest is only worth what you can check about it. The engine exists twice — JavaScript (the CLI, the hosted
queue, Node strategies) and Python (Python strategies, locally and in the sandbox) — and the archive decoder and the
report exist twice — JavaScript (the CLI and the queue) and Python (`outcometick.backtest`). Two implementations
of the same rules drift, silently, unless something compares them. These are the things that do.

## Engine against engine

`runner/conformance/` (in [polymarket-backtest-js](https://github.com/outcometick/polymarket-backtest-js)) runs
both harnesses as real subprocesses over identical inputs and compares every trade and fill field: delayed
orders, hold expiry, partial reductions, unusable orders, one-sided snapshots, best-bid/ask pruning, budget and
log limits, session mode across overlapping markets, and the venue fee in each of its states. Expected values for
the fee cases are worked by hand, not taken from either engine — agreement alone would pass two engines that are
wrong the same way.

## Decoder and report against decoder and report

`verify/equivalence.test.mjs` (in [polymarket-backtest](https://github.com/outcometick/polymarket-backtest))
decodes the same archive with both decoders and compares every market and every event. It then runs Python
strategies through the command line (the Python harness fed by Node) and through `outcometick.backtest` (the
same harness loop fed in-process) and requires every report field — except wall-clock timing — and every trade
and fill row to match. Finally it runs the same strategy written in JavaScript and in Python and requires the
same trades, fills and logs, byte for byte.

It runs on two synthetic archives built to hold what real days rarely do: a market crossing midnight, a market with
no settlement ticks, an unresolved one, a Predict.fun tie, fees off and fees unreadable, a market on the 30-second
TWAP, five kinds of event on one millisecond, deltas landing exactly on a cadence boundary, an empty file. With
`OT_SAMPLE_DIR` pointing at the unpacked public samples it runs on those as well. It caught, on its first CI run,
that Python's `os.scandir` returns files in filesystem order where Node's `readdir` sorts them.

`verify/js-semantics.test.mjs` checks the JavaScript number rules the Python decoder reproduces — `Number(" 12 ")`,
`Number("0x10")`, `(0.125).toFixed(2)`, `Math.round(0.49999999999999994)`, number-to-string past 1e21 — against
JavaScript itself.

## Answers worked by hand

`tests/test_backtest.py` (Python repository) builds a one-market archive and checks the result against arithmetic
done on paper: the fill price across two levels, the fee per level, the payout at settlement, a known-zero fee, a
flat override, latency, the outcome hidden until settlement, and that a cached decode replays identically.

## Run them

Python repository:

```bash
pip install .
python -m unittest discover -s tests
npm install --no-save outcometick@"$(python -c 'import json; print(json.load(open("verify/version.json"))["version"])')"
node --test 'verify/*.test.mjs'                        # needs Node 24 and python3
OT_SAMPLE_DIR=/path/to/samples node --test 'verify/*.test.mjs'   # also on the real sample days
```

JavaScript repository:

```bash
npm install && npm test
node --test runner/conformance/*.test.mjs              # needs python3
```

## What is not proven here

- That the archive is complete: it is not. Gaps in what was captured are published per day by the data product,
  and a backtest lists every market-day it could not replay.
- That a fee estimated per book level equals what the venue charged per match: see
  [methodology § 5](methodology.md#5-fees).
- That a strategy which worked on these days will work on others.
