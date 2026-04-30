# tarock-solve

Terminal companion to the Tarock 2.0 web app. Reads a JSON snapshot of the
current game (produced by the **📋 Copy for CLI** button in the browser),
runs the same pessimistic-minimax search the web engine uses, and prints
the recommended move.

The Go engine here is a faithful port of [`engine.js`](../engine.js) with
three performance plays the JS version can't do:

- **Native speed**: 5–10× faster per node than V8.
- **Larger transposition table**: capped at 50M entries (~1.5GB) instead of
  the JS engine's 2M, so deep searches don't burn cycles on TT thrashing.
- **Root-parallel search by default**: the root move list is sorted by
  expected captures, the first (best-ordered) move is searched
  sequentially to seed an α-β bound (Young-Brothers-Wait Concept), and the
  remaining moves are distributed across `runtime.NumCPU()` worker
  goroutines. All workers share one sharded transposition table (256
  shards, fine-grained locks) and an atomic α-β bound so cuts from one
  worker narrow the windows of the others. Pass `--parallel 1` for the
  older single-threaded iterative-deepening path.

### Benchmarks (Apple Silicon, fresh-start depth 11)

| Configuration | Wall-clock | Nodes searched |
|---|---|---|
| `--parallel 1` (iter. deepening) | ~92s | 422M |
| `--parallel 8` (perf-cores only) | ~36s | 543M |
| `--parallel 16` (all cores) | ~38s | 600M+ |

On Apple Silicon the efficiency cores hurt overall throughput due to
memory-bandwidth contention, so `--parallel 8` is often the sweet spot
even though `runtime.NumCPU()` reports 16. Try a few values for your
machine — the right number is "however many *performance* cores you
have."

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

In the web app, click **📋 Copy for CLI** — that puts a complete shell
command on your clipboard. In a terminal sitting in `solver/`, paste:

```bash
./tarock-solve '{"cards":[…],"cols":4,"rows":3,"blocked":[…],"turn":"blue"}'
```

(The web button generates the whole line — the `./tarock-solve '...'` plus
the embedded JSON — so it's a true paste-and-run.)

Other input forms, if you'd rather not use the button:

```bash
pbpaste | ./tarock-solve                            # macOS clipboard
./tarock-solve --state '{...}'                      # explicit flag
xclip -selection clipboard -o | ./tarock-solve      # Linux X11
wl-paste | ./tarock-solve                           # Linux Wayland
```

Output looks like:

```
Solving for blue, depth 11, parallel × 8… (Ctrl+C to abort)

Best move: ⚔5/🛡3 ✦right → row 1, col 2
Worst-case lead after 11-ply: +2 (guaranteed flips: 2)
Searched 4,213,567 nodes in 12.3s · TT size 1,847,221
```

## Flags

| Flag | Default | What it does |
|---|---|---|
| _(positional arg)_ | — | First non-flag arg is treated as the JSON state, matching what the web app's button copies. |
| `--state '...'` | _(stdin)_ | Same as the positional arg, but explicit. |
| `--parallel N` | `runtime.NumCPU()` | Worker count. `1` = single-threaded with iterative deepening (slower but deterministic). |
| `--max-time <duration>` | unbounded | Soft wall-clock cap. With parallel, the result is "best-of-completed-root-moves" if budget exceeded. With `--parallel 1`, you get the deepest fully-completed depth via iterative deepening. |

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
