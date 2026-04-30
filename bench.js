#!/usr/bin/env node
/**
 * Tarock 2.0 engine benchmark.
 *
 * Run from this folder:
 *   node bench.js
 *
 * Loads the engine via `require('./engine.js')` and runs the pessimistic
 * minimax search at depths 3, 4, and 5 from two positions:
 *   1. Fresh start — 6 cards in each hand, 1 blocked square, nothing placed.
 *      This is the worst case for branching factor.
 *   2. Mid-game   — 4 cards already placed, 4 in each hand. Realistic for
 *      when you'd actually press "Suggest Best Move" mid-match.
 *
 * Adjust ITERATIONS below if you want each measurement averaged.
 */

const Engine = require('./engine.js');

const ITERATIONS = 1; // bump to 3+ for averaged timings

// ---- 1. Mutable state object the engine reads from ----------------------------
const state = {
  cards: [],
  cols: 4,
  rows: 3,
  blocked: [{ x: 0, y: 2 }], // bottom-left blocked
};

// ---- 2. Helpers to set up positions ---------------------------------------
function reset() {
  state.cols = 4;
  state.rows = 3;
  state.blocked = [{ x: 0, y: 2 }];
  state.cards.length = 0;
}
let nextId = 1;
function add(side, name, atk, def, special = [], loc = 'hand') {
  state.cards.push({
    id: nextId++,
    side,
    owner: side,
    name,
    atk,
    def,
    special: [...special],
    location: loc === 'hand' ? 'hand' : { ...loc },
  });
}

function setupFresh() {
  reset();
  nextId = 1;
  add('blue', 'Owl Knight',  5, 3, ['right']);
  add('blue', 'Spear Lemur', 2, 5);
  add('blue', 'Snake Rider', 6, 2);
  add('blue', 'Mantis Mech', 4, 3);
  add('blue', 'Cyclops',     5, 1);
  add('blue', 'Wood Sprite', 0, 6);
  add('red',  'Owl Knight',  3, 3);
  add('red',  'Spear Lemur', 2, 5, ['left']);
  add('red',  'Snake Rider', 6, 2);
  add('red',  'Mantis Mech', 4, 3);
  add('red',  'Cart Bandit', 2, 3, ['right']);
  add('red',  'Wood Sprite', 0, 6);
}

function setupMidgame() {
  reset();
  nextId = 1;
  // Four cards placed in row 0 (alternating sides), four still in each hand.
  add('blue', 'Owl Knight',  5, 3, ['right'], { x: 0, y: 0 });
  add('blue', 'Snake Rider', 6, 2, [],        { x: 2, y: 0 });
  add('blue', 'Mantis Mech', 4, 3);
  add('blue', 'Cyclops',     5, 1);
  add('blue', 'Spear Lemur', 2, 5);
  add('blue', 'Wood Sprite', 0, 6);
  add('red',  'Owl Knight',  3, 3, [],        { x: 1, y: 0 });
  add('red',  'Spear Lemur', 2, 5, ['left'],  { x: 3, y: 0 });
  add('red',  'Snake Rider', 6, 2);
  add('red',  'Mantis Mech', 4, 3);
  add('red',  'Cart Bandit', 2, 3, ['right']);
  add('red',  'Wood Sprite', 0, 6);
}

// ---- 3. Run benchmarks ----------------------------------------------------
function bench(label, setup) {
  console.log(`\n${label}`);
  console.log('─'.repeat(label.length));
  for (const depth of [3, 5, 7, 9, 11]) {
    let times = [], nodes = 0, achieved = 0, score = 0, ttHits = 0, ttMisses = 0, ttSize = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      setup();
      const t0 = Date.now();
      const r = Engine.bestMoveForSide(state, 'blue', depth);
      times.push(Date.now() - t0);
      if (r) {
        nodes = r.searchNodes;
        achieved = r.searchDepth;
        score = r.score;
        ttHits = r.ttHits ?? 0;
        ttMisses = r.ttMisses ?? 0;
        ttSize = r.ttSize ?? 0;
      }
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times), max = Math.max(...times);
    const cap = achieved < depth ? `  ⚠ budget hit, completed ${achieved}/${depth}` : '';
    const range = ITERATIONS > 1 ? ` (min ${min}ms, max ${max}ms)` : '';
    const ttRate = ttHits + ttMisses > 0
      ? ` tt:${(100 * ttHits / (ttHits + ttMisses)).toFixed(0)}%(${ttSize.toLocaleString()})`
      : '';
    console.log(
      `  requested depth ${depth}: ` +
      `${avg.toFixed(0)}ms${range}  ${nodes.toLocaleString()} nodes  ` +
      `score=${score.toFixed(2)}${ttRate}${cap}`
    );
  }
}

console.log('Tarock 2.0 pessimistic-minimax benchmark');
console.log('Node version:', process.version);
console.log('Iterations per measurement:', ITERATIONS);
bench('Fresh start (6 in each hand, 0 placed)', setupFresh);
bench('Mid-game (4 placed, 4 in each hand)',     setupMidgame);
console.log('\nDone. Compare these numbers to the "ms" readout in the app.');
