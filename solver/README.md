# tarock-solve

Terminal companion to the Tarock 2.0 web app. Reads a JSON snapshot of the
current game (produced by the **📋 Copy for CLI** button in the browser),
runs the same pessimistic-minimax search the web engine uses, and prints
the recommended move.

The Go engine here is a faithful port of [`engine.js`](../engine.js) with
two performance plays the JS version can't do:

- **Native speed**: 5–10× faster per node than V8.
- **Larger transposition table**: capped at 50M entries (~1.5GB) instead of
  the JS engine's 2M, so deep searches don't burn cycles on TT thrashing.

Always solves to **depth 11** (the full game tree from any position). For
mid-game positions that's near-instant; for fresh-start positions it'll
churn — pass `--max-time 5m` if you want a soft cap.

## Build

```bash
cd solver
go build -o tarock-solve .
```

(Or just `go run .` from this directory — same effect, slower start.)

## Run

In the web app, click **📋 Copy for CLI**. Then in your terminal:

```bash
pbpaste | ./tarock-solve              # macOS
xclip -selection clipboard -o | ./tarock-solve   # Linux X11
wl-paste | ./tarock-solve              # Linux Wayland
```

Or pass the JSON directly:

```bash
./tarock-solve --state '{"cards":[…],"cols":4,"rows":3,"blocked":[…],"turn":"blue"}'
```

Output looks like:

```
Solving for blue, depth 11… (Ctrl+C to abort)

Best move: ⚔5/🛡3 ✦right → row 1, col 2
Worst-case lead after 11-ply: +2 (guaranteed flips: 2)
Searched 4,213,567 nodes in 12.3s · TT size 1,847,221
```

## Flags

| Flag | Default | What it does |
|---|---|---|
| `--state '...'` | _(stdin)_ | Read the JSON game state from this string instead of stdin. |
| `--max-time <duration>` | unbounded | Soft wall-clock cap. If depth 11 can't fit, the deepest depth that did is returned with `searchDepth < 11`. |

## Tests

```bash
go test ./...
```

Mirrors the most porting-sensitive cases from
[`engine.test.js`](../engine.test.js): the 8-row combat truth table, move-
outcome branch counting, the pessimistic-vs-tie test, and the JSON parser.

## Files

- `engine.go` — direction constants, board helpers, `moveOutcomes`,
  α-β + Zobrist-keyed TT, iterative deepening.
- `main.go` — CLI: stdin / `--state` parsing, output formatting.
- `engine_test.go` — Go test suite.
- `go.mod` — no external deps.
