<!-- Generated from the outcometick monorepo by scripts/publish-backtest-repo.mjs. Edits here are overwritten; open an issue or a PR and it is ported back. -->
# AGENTS.md

Notes for AI coding agents working with this repository.

## What this is

`outcometick` on npm: the JavaScript/TypeScript SDK, the `ot` CLI and a tick-level backtester for Polymarket and
Predict.fun crypto Up/Down markets, and for any Polymarket binary market from your own data. Read
[For AI agents](https://outcometick.github.io/polymarket-backtest/agents.html) first, or the whole documentation as one
file: [llms-full.txt](https://outcometick.github.io/polymarket-backtest/llms-full.txt).

This repository is GENERATED from the outcometick monorepo on every release; pull requests are read and ported back
by hand, so keep them small. The Python package is [polymarket-backtest](https://github.com/outcometick/polymarket-backtest),
with identical results.

## Layout

- `runner/engine/` — the replay engine (the same files the hosted backtester runs); `runner/harness/` — the Node and
  Python harnesses; `cli/` — `ot` (`init`, `check`, `run`, `fingerprint`, `submit`, `status`, `fetch`, `mcp`).
- `examples/` — runnable strategies; `runner/conformance/` — both engines, trade by trade.

## Commands

```bash
npm install
npm test                                            # unit tests
node --test runner/conformance/*.test.mjs           # JS and Python engines must agree (needs python3)
node bin/ot.mjs init my-strategy                    # from this checkout; or `npm i -g outcometick` and use `ot`
node bin/ot.mjs run my-strategy --data <unpacked archive or your own data>
npx -y -p outcometick ot mcp                        # MCP server for coding tools (never submits a paid run)
```

## Writing a strategy (the rules that decide whether a result is right)

- A class with hooks `onMarketOpen`, `onTick`, `onBook`, `onTrade`, `onTimer`, `onSettle` returning `null`, an
  `Order`, or an array; `outcometick.json` declares hooks and datasets. `ot check` runs the hosted validator locally.
- No look-ahead: never read archive files from inside a strategy; events arrive one at a time.
- Settlement is the official outcome, never a mark; fees are on by default (each market's schedule).
