# Tarock 2.0 Helper

A single-page web app to assist the user (Stu) while playing **Arcadian Tarock**,
the card-game minigame in **Oceanhorn 3**. The user enters their cards and the
opponent's cards, drags cards onto a 4×3 board, and the engine recommends the
best next move under worst-case-coin-flip assumptions.

The app is split into:

- `index.html` — UI, rendering, tap-to-place + drag-and-drop, modals, event
  wiring. Loads `engine.js` and runs the search in a Web Worker
  (`worker.js`) so iOS Safari stays responsive on long searches.
- `engine.js` — pure game logic + search. No DOM access; works in browser
  and Node. Browser publishes it as `globalThis.Engine`; Node exports the
  same object via CommonJS.
- `worker.js` — thin wrapper that loads `engine.js` and runs
  `bestMoveForSide` off the main thread.
- `engine.test.js` — `node:test` suite covering combat, move generation,
  evaluation, and search.
- `bench.js` — Node benchmark of `Engine.bestMoveForSide`.
- `solver/` — companion **Go CLI** that reads the JSON game state copied
  from the **📋 Copy for CLI** button in the web app and solves to depth
  11 natively. Same algorithm as the JS engine; faster per node and uses
  a much larger transposition table (no V8 Map.size limit). See
  [solver/README.md](solver/README.md).

There is no build step for the web app. Tailwind is loaded from a CDN.
The Go solver is built independently with `go build`.

---

## How to run

- **Play it**: open `index.html` in a browser. (`engine.js` and
  `worker.js` must be next to it — the page loads them via `<script
  src="…">`.)
- **Run the JS tests**: `node --test engine.test.js` (Node 20+).
- **Benchmark the JS engine**: `node bench.js` (works on Node 18+).
- **Run the Go solver locally**: from the web app, click **📋 Copy for
  CLI**, then in a terminal:
  ```bash
  cd solver
  go build -o tarock-solve .
  pbpaste | ./tarock-solve              # depth 11 by default
  pbpaste | ./tarock-solve --max-time 5m # cap at 5 minutes
  ```
- **Run the Go tests**: `cd solver && go test ./...`

---

## Game rules (as of this writing)

From the in-game rules screen Stu shared:

- Players take turns placing cards on the board one by one.
- Once **eleven cards are played**, the player with the most cards on the
  board wins. (Grid is 4×3 = 12 squares, with **exactly one square blocked**
  every game — the blocked square moves between games. The app refuses to
  start play until the user marks one square blocked.)
- When a card is placed, it automatically attacks in the four orthogonal
  directions.
- If the attacker's Attack value is greater than a defender's Defense, the
  defender flips to the attacker's side.
- Ties (Atk == Def) are resolved with a coin toss.
- Some cards have **Special Directions** (one or more arrows). A Special
  Direction wins against all regular Atk/Def values.
- A Special Direction can only be defeated with another Special Direction
  pointing back at it (opposite arrow). When that happens, it's a coin toss.

### Combat decision table (what the code does)

For each neighbor of the placed card, with `dir` = direction from attacker to
defender, `aSpec` = attacker has special `dir`, `dCounter` = defender has
special `OPP_DIR[dir]` (i.e., pointing back at attacker):

| Direction kind | aSpec | dCounter | Result |
|---|---|---|---|
| Orthogonal | true | true | **Coin-toss clash** |
| Orthogonal | true | false | Attacker auto-wins (flip) |
| Orthogonal | false | true | **Defender auto-wins, no flip** |
| Orthogonal | false | false | Compare atk vs def: `>` flip, `==` coin toss, `<` no flip |
| Diagonal | false | * | No battle at all |
| Diagonal | true | true | Coin-toss clash |
| Diagonal | true | false | Attacker auto-wins (flip) |

Important nuances we got wrong in early versions and corrected:

1. **Defender's same-direction-back special wins on its own** (not just
   "produces a clash if attacker also has special"). A defender with `right`
   pointing back at an attacker on its right will deflect a regular Atk-vs-Def
   attack with no flip.
2. **Diagonal battles only happen when the attacker has a diagonal special.**
   Without it, a card placed diagonally adjacent to an enemy does nothing in
   that direction, regardless of stats or the defender's arrows.

### Eight directions and their opposites

```
DIRS = {up, upRight, right, downRight, down, downLeft, left, upLeft}
OPP_DIR maps each to its 180°-opposite (e.g. upRight ↔ downLeft).
ORTHO_DIRS = {up, down, left, right}
```

---

## UX layout

- **Left column**: Opponent (Red) hand.
- **Middle**: 4×3 board (the only real game size — selector removed).
- **Right column**: User (Blue) hand. **Stu is always blue, on the right.**
- **Top bar**: Suggest button, depth selector, Block Square toggle, Undo, Reset.
- **Status bar**: Turn indicator + first-mover buttons (You first /
  Opponent first), score (blue cards on board − red cards on board), and
  the latest suggestion text.
- **Quick Add form** below the board for entering cards (side, atk, def,
  3×3 compass for special directions). Cards are anonymous — no name
  field; identity is just stats + arrows.
- **Help** in a collapsible `<details>` block at the bottom.

### Card UI

- Hand cards are 110×150px, draggable.
- Each placed card sits in a 3:4 board cell.
- A small ✏ button on each hand card opens an edit modal where you can change
  the card's side, name, atk, def, special directions, or delete it.
- Special-direction arrows render at the appropriate edge/corner of the card
  using `DIR_SYMBOL[d]` (↑ ↗ → ↘ ↓ ↙ ← ↖).
- The blocked square renders as a striped grey tile with a 🪨 emoji.

### Card placement (touch + desktop)

Two equivalent paths converge in `placeCard(id, x, y)`:

- **Tap-to-place** (works everywhere, primary path on iPhone): tap a hand
  card → it gets a green ring (`state.selectedCardId`). Tap an empty,
  non-blocked cell → `placeCard` runs. Tapping the same card again
  deselects.
- **Drag-and-drop** (desktop only): HTML5 drag/drop, card's id as the
  text payload. iOS Safari doesn't fire `dragstart` from touch — that's
  why tap-to-place exists.

`placeCard(id, x, y)` is the single chokepoint. It enforces:
  - card not already placed
  - target cell empty and not blocked
  - exactly one block square is set
  - turn matches card.side
  - clears `selectedCardId` and `recommendation` on success

### Touch alternatives for desktop-only inputs

- **Long-press a placed card** (≥550ms, no significant move) =
  right-click on desktop → `flipPlacedOwner`. The `attachLongPress`
  helper installs touchstart/move/end/cancel listeners and arms a
  `_suppressClick` flag for ~400ms after firing so the synthetic click
  iOS emits doesn't also trigger the cell-click "remove" path.
- **Edit / delete a hand card** — tap the ✏ button. The right-click
  delete path on desktop is still wired but isn't reachable from touch.

### Coin-toss UI

When a tied battle (Atk==Def) or a special-clash happens during live
placement, a modal pops up asking the user what the actual game's coin flip
showed. The app never randomizes outcomes — it records exactly what the user
enters. This is the `askCoinOutcome` function.

---

## Search engine

### Algorithm: pessimistic minimax with iterative deepening

- **Score**: from BLUE's perspective. `(blue cards on board) − (red cards on board)`.
- **Maximizer**: blue. **Minimizer**: red.
- **Chance nodes** (every coin-toss branch): combined **pessimistically** for
  the user — at every flip in the search tree we assume the outcome is the
  worst possible from the user's perspective. So the user's tied attacks
  produce no capture; the opponent's tied attacks always succeed. This is
  what `chanceCombine(values, userSide)` does (MIN if user is blue, MAX if
  user is red).
- **Iterative deepening**: searches at depth 1, 2, 3, ... up to the requested
  max. Returns the deepest fully-completed result. If the budget runs out
  partway through depth N, the depth N-1 answer is returned and the status
  bar shows e.g. `4/5-ply (budget reached)`.
- **Wall-clock budget**: `SEARCH_BUDGET_MS = 4000` (4s soft cap). Checked
  every 4096 nodes via `(nodeCount & 0xFFF) === 0 && performance.now() > deadline`,
  raising `BudgetExceeded` to unwind the recursion.
- **Default depth**: 5. Mid-/late-game depth 5 finishes in milliseconds; from
  a fresh-start position it usually clamps to depth 3 or 4 within budget.

### Why pessimistic instead of expectimax

Stu explicitly asked: "I can't pick the best move, assuming a win." Earlier
versions averaged each coin-toss 50/50 (true expectimax). That sometimes
ranked moves that depended on winning a flip above safer alternatives.
Switching to "always assume the flip is lost" makes the recommended move
robust regardless of how the actual coins land.

### Move-outcome generation (`moveOutcomes`)

Given a placement (card, x, y, side, board), returns an array of
`{p, board}` outcome boards covering every combination of certain captures +
chance captures. Internals:

1. Shallow-clone the board array and clone-and-replace the placed card.
2. Build a position-keyed `Map` (x,y → card) so neighbor lookups are O(1).
3. Walk all 8 neighbors, classify each battle into `certainIds` or
   `chanceIds` using the rules table above.
4. Apply certain captures by clone-and-replacing the affected card entries.
5. If there are N chance captures, enumerate 2^N branches and return them.

The pessimistic search ignores the `p` weights and just calls
`chanceCombine` over the resulting values, but the data structure still
faithfully represents both branches so `applyLiveCaptures` (the real-time
combat path) can iterate certain captures and still prompt the user about
the chance ones.

### Per-node optimizations

Layered on top of the naive minimax for ~100× speedup overall:

1. **Alpha-beta pruning** through both the side-to-play and chance layers.
   Pessimistic chance combination is just a deterministic min (when
   `userSide === 'blue'`) or max (`'red'`) layer, so plain α-β applies — the
   chance subtree cuts when partial-min ≤ alpha (blue) / partial-max ≥ beta
   (red). Biggest single lever, ~10–100× by itself.
2. **Transposition table** keyed by a canonical `(boardKey, sideToPlay)`
   string. Stored as `{depth, value, flag}` with EXACT/LOWER/UPPER bounds so
   α-β cuts produce reusable entries. Shared across iterative-deepening
   iterations within one `bestMoveForSide` call. Skipped at depth 1 because
   the key-building cost outweighs the savings near leaves.
3. **`idIndex` map** (card-id → board-array index) built once per search.
   The board is always sliced (never reordered), so indices are stable
   across every clone — `findIndex` linear scans become Map lookups.
4. **`posIndex` map** ((x,y) posKey → card) built once per node, shared
   across every candidate move's `moveOutcomes` call and the move-ordering
   preview.
5. **Move ordering** by descending estimated capture count. Only enabled
   when remaining depth ≥ 3 AND the node has ≥ 30 candidate moves
   (`myHand × empties`) — at small move counts the per-node sort overhead
   exceeds the α-β cuts saved, which empirically hurts mid-game perf.

Invariants the search relies on:

- `cloneBoard()` is a shallow `Array.slice()` — card objects are shared
  across snapshots. The search **never mutates a card in place**; it
  always does `b[i] = {...b[i], owner: side}` to make a new card object.
  Any in-place mutation would corrupt `state.cards` (the live game state)
  AND invalidate the `idIndex` map (indices stay stable only because every
  clone preserves them).
- `posKey(x, y) = (x << 4) | y` — small int keys for the position Map.

Things we did NOT do but could:
- **Bitboard / typed-array board representation** — would let `staticScore`
  and the empties scan use popcount-style ops instead of array iteration.
  Probably 2-3× more on top of current state.
- **Make-unmake search** — mutate-and-undo instead of slice-and-clone, to
  cut per-move allocations entirely. Conflicts with the
  "never-mutate-cards" invariant — would need a separate mutable
  owner/location array indexed by id.
- **Aspiration windows** in iterative deepening — start each iteration with
  a narrow `[α, β]` around the previous depth's score to maximize α-β cuts.

### Performance numbers

Stu's Mac (Node 20, single core, after the optimizations above):

| Position | Depth | Nodes | Time |
|---|---|---|---|
| Fresh, 0 placed | 3 | 10K | 18ms |
| Fresh, 0 placed | 5 | 224K | 168ms |
| Fresh, 0 placed | 7 | 3.9M | 3.5s (full depth-7 result) |
| Fresh, 0 placed | 9–11 | clamps to 7 at 4s budget | 4s |
| Mid-game, 4 placed | 5 | 7K | 11ms |
| Mid-game, 4 placed | 7 | 73K | 118ms |
| Mid-game, 4 placed | 11 | 165K | 327ms (full game solved) |

Mid-game depth 11 = the full remaining game tree, so the engine returns a
perfect-play answer for any mid-game position in well under a second. The
4s budget with iterative deepening still applies, so the worst case the
user ever sees is ~4s.

---

## State model

```js
state = {
  cards: [
    {
      id: number,
      side: 'blue' | 'red',     // original / static
      owner: 'blue' | 'red',    // current owner (changes on capture)
      name: string,
      atk: number,
      def: number,
      special: string[],         // subset of DIRS keys
      location: 'hand' | { x, y }
    },
    ...
  ],
  turn: 'blue' | 'red' | null,   // null = pick first mover
  cols: 4,
  rows: 3,
  blocked: [{x, y}, ...],        // exactly one entry during play
  blockingMode: boolean,         // user-clicks-cell-to-toggle-block UI
  history: snapshot[],           // for Undo
  recommendation: {              // last suggester result; null if cleared
    cardId, x, y, score, expGain,
    requestedDepth, searchDepth, searchNodes, searchMs
  } | null,
}
```

History is stored as deep-cloned snapshots via `pushHistory()`/`restore()`.

---

## Code layout in `index.html`

Roughly top-to-bottom:

1. **CSS** — board cells, card faces, arrow positioning, modals, animations.
2. **HTML** — header (Suggest/depth/Block/Undo/Reset), status bar (turn +
   score + recommendation), three-column flex (red hand / board / blue hand),
   Quick Add form, help `<details>`.
3. **JS** — single `<script>`:
   - Direction constants (`DIRS`, `OPP_DIR`, `ORTHO_DIRS`, `DIR_SYMBOL`).
   - State helpers (`snapshot`, `pushHistory`, `restore`, `cardAt`, `isBlocked`,
     `inBounds`, `neighbors`, `hasAnySpecial`).
   - `resolveCaptures` — combat resolver for live placement.
   - `cloneBoard`, `moveOutcomes`, `gameOver`, `staticScore`, `chanceCombine`,
     `expectimax`, `searchAtDepth`, `bestMoveForSide` — search engine.
   - `render`, `renderBoard`, `renderHand`, `renderCardEl`, `renderStatus`.
   - Action handlers: `placeCard` (async — awaits coin-toss popups),
     `applyLiveCaptures`, `askCoinOutcome`, `removePlaced`, `flashCell`, `toast`.
   - `addCard`, `clampStat`.
   - Quick Add form wiring (with the 3×3 compass toggle state).
   - `openEditModal`.
   - Suggester wiring (`suggestBestMove` defers heavy work via setTimeout
     so the "Thinking…" button state can paint).
   - Reset / Undo / preset / coin handlers.
   - Final `render()` call to bootstrap.

---

## Conventions to keep

- **Never mutate cards in place** during search. Always clone-and-replace.
- **`state.cards` is the source of truth.** Snapshots in `history` are deep
  clones; search-internal boards are shallow array clones over shared card
  objects.
- **Don't use HTML5 drag/drop event coords** — use the cell's data attributes.
- **Coin tosses are user-entered, not randomized.** The only place
  `Math.random()` should ever appear is if we deliberately add a sandbox
  / shuffle feature later.
- **Help text** lives at the bottom of the page in a single `<details>` block.
  Update it when rules change.

---

## Things to revisit

1. **Special-direction visuals.** With all 8 arrows set, the corner arrows
   may overlap visually with the stat row. Untested at extremes.
2. **Performance ceiling.** Fresh-start search now reaches depth 7 within
   the 4s budget; depth 9–11 from a fresh start still clamps. Mid-game
   depth 11 (full game) solves in ~330ms. Next levers if we need more:
   bitboard representation, make-unmake search, aspiration-window iterative
   deepening — see "Per-node optimizations" above.
3. **Move-history visualization.** Would be nice to scroll back through the
   game and see captures step-by-step. Would also help debugging.
4. **Endgame detection.** Currently triggered at "playable cells filled."
   If a side runs out of cards before that happens, we just pass to the
   other side. Probably fine but verify with a real game.
5. **Mobile layout.** Three-column desktop layout. On narrow screens it
   stacks via `lg:` breakpoint, but no mobile-specific drag/drop polish.
6. **Sharing/export.** No way to save a game to a URL or import one. Could
   be useful for sharing tricky positions for analysis.

---

## Decisions made along the way (so we don't relitigate them)

- **Stu is blue, on the right.** Originally we had user as red on the left.
- **No in-app coin flip for "who goes first."** The game decides; the user
  taps "You first" / "Opponent first" to record it.
- **Coin-toss outcomes are user-entered**, never randomized client-side.
- **Pessimistic search** is the engine, not expectimax — see "Why
  pessimistic" above.
- **One blocked square is required** before play can start. The Reset
  button auto-arms blocking mode so the user can immediately click the
  stone tile.
- **Score counts only placed cards**, not cards still in hand.
- **Default depth is 5** with a 4s wall-clock budget and iterative deepening.

---

## Quick mental model for future Claude

> The user is playing a Triple-Triad-style 4×3 card game in Oceanhorn 3
> called Arcadian Tarock. They have a cheat-sheet web app (this) that
> mirrors the live game state and tells them the safest move. Coin flips
> are real — the user enters the actual outcome — and the engine assumes
> every flip goes against the user when planning. Special Directions are
> 8-way arrows that auto-win the battle on their side, modulo opposing
> arrows.
