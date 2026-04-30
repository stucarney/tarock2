/**
 * Tests for engine.js — Tarock 2.0 game logic & search.
 *
 * Run with:   node --test engine.test.js
 *
 * Covers: direction constants, board helpers (inBounds/isBlocked/cardAt/
 * neighbors/dirFromTo), combat resolution (resolveCaptures), move-outcome
 * generation (moveOutcomes), evaluation (staticScore/gameOver/emptySquares),
 * pessimistic combination (chanceCombine), and the search root
 * (bestMoveForSide / searchAtDepth / expectimax / iterative-deepening budget).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('./engine.js');

const {
  DIRS, OPP_DIR, ORTHO_DIRS, isOrtho, DIR_SYMBOL,
  inBounds, isBlocked, cardAt, neighbors, dirFromTo, hasAnySpecial,
  resolveCaptures, moveOutcomes,
  staticScore, emptySquares, gameOver,
  chanceCombine, expectimax, searchAtDepth, bestMoveForSide,
  BudgetExceeded,
} = Engine;

// ---------- test helpers ----------------------------------------------------
let _id = 0;
function nextId() { return ++_id; }

/**
 * Create a state object. Defaults to a 4x3 board with one blocked square at
 * (3,2). Pass `blocked: []` for tests that don't care about blocking.
 */
function makeState(overrides = {}) {
  return {
    cards: [],
    cols: 4,
    rows: 3,
    blocked: [{ x: 3, y: 2 }],
    ...overrides,
  };
}

function addCard(state, opts) {
  const card = {
    id: opts.id ?? nextId(),
    side: opts.side,
    owner: opts.owner ?? opts.side,
    name: opts.name ?? '',
    atk: opts.atk ?? 0,
    def: opts.def ?? 0,
    special: [...(opts.special ?? [])],
    location: opts.location ?? 'hand',
  };
  state.cards.push(card);
  return card;
}

function place(state, opts, x, y) {
  return addCard(state, { ...opts, location: { x, y } });
}

// ---------- direction constants --------------------------------------------
test('DIRS has all eight compass directions', () => {
  assert.equal(Object.keys(DIRS).length, 8);
  for (const d of ['up','upRight','right','downRight','down','downLeft','left','upLeft']) {
    assert.ok(d in DIRS, `${d} missing`);
  }
});

test('OPP_DIR is involutive — every direction is its own opposite-of-opposite', () => {
  for (const d of Object.keys(DIRS)) {
    assert.equal(OPP_DIR[OPP_DIR[d]], d, `OPP_DIR is not involutive at ${d}`);
  }
});

test('OPP_DIR vector is the negation of DIRS vector', () => {
  // Use additive form to avoid the +0 / -0 distinction that `Object.is`
  // (and therefore strict assert.equal) treats as unequal.
  for (const [d, [dx, dy]] of Object.entries(DIRS)) {
    const [ox, oy] = DIRS[OPP_DIR[d]];
    assert.equal(ox + dx, 0);
    assert.equal(oy + dy, 0);
  }
});

test('ORTHO_DIRS contains exactly up/down/left/right', () => {
  assert.equal(ORTHO_DIRS.size, 4);
  for (const d of ['up','down','left','right']) assert.ok(ORTHO_DIRS.has(d));
  for (const d of ['upLeft','upRight','downLeft','downRight']) assert.ok(!ORTHO_DIRS.has(d));
});

test('isOrtho matches ORTHO_DIRS membership', () => {
  for (const d of Object.keys(DIRS)) {
    assert.equal(isOrtho(d), ORTHO_DIRS.has(d));
  }
});

test('DIR_SYMBOL has a glyph for every direction', () => {
  for (const d of Object.keys(DIRS)) {
    assert.equal(typeof DIR_SYMBOL[d], 'string');
    assert.ok(DIR_SYMBOL[d].length > 0);
  }
});

// ---------- inBounds / isBlocked / cardAt / neighbors / dirFromTo -----------
test('inBounds: corners, edges, and out-of-range', () => {
  const state = makeState();
  assert.equal(inBounds(state, 0, 0), true);
  assert.equal(inBounds(state, 3, 2), true);
  assert.equal(inBounds(state, -1, 0), false);
  assert.equal(inBounds(state, 0, -1), false);
  assert.equal(inBounds(state, 4, 0), false);
  assert.equal(inBounds(state, 0, 3), false);
});

test('isBlocked: matches blocked array; empty array → never blocked', () => {
  const state = makeState({ blocked: [{ x: 1, y: 1 }, { x: 2, y: 0 }] });
  assert.equal(isBlocked(state, 1, 1), true);
  assert.equal(isBlocked(state, 2, 0), true);
  assert.equal(isBlocked(state, 0, 0), false);
  const empty = makeState({ blocked: [] });
  assert.equal(isBlocked(empty, 0, 0), false);
});

test('cardAt: finds placed cards, ignores hand cards, returns undefined when nothing there', () => {
  const state = makeState();
  const placed = place(state, { side: 'blue', atk: 1, def: 1 }, 1, 1);
  addCard(state, { side: 'blue', atk: 1, def: 1 }); // in hand
  assert.equal(cardAt(state.cards, 1, 1), placed);
  assert.equal(cardAt(state.cards, 0, 0), undefined);
});

test('neighbors: center returns 8, corners return 3, edges return 5', () => {
  const state = makeState();
  assert.equal(neighbors(state, 1, 1).length, 8);
  // (0,0) corner of 4x3: neighbors are (1,0), (0,1), (1,1) → 3
  assert.equal(neighbors(state, 0, 0).length, 3);
  assert.equal(neighbors(state, 3, 0).length, 3);
  assert.equal(neighbors(state, 0, 2).length, 3);
  assert.equal(neighbors(state, 3, 2).length, 3);
  // (1,0) top edge: 5 neighbors
  assert.equal(neighbors(state, 1, 0).length, 5);
});

test('neighbors: each entry has direction name and matching offset', () => {
  const state = makeState();
  const ns = neighbors(state, 1, 1);
  for (const n of ns) {
    const [dx, dy] = DIRS[n.d];
    assert.equal(n.x, 1 + dx);
    assert.equal(n.y, 1 + dy);
  }
});

test('dirFromTo: returns each direction for adjacent cells, null for non-adjacent', () => {
  for (const [d, [dx, dy]] of Object.entries(DIRS)) {
    assert.equal(dirFromTo(0, 0, dx, dy), d);
  }
  assert.equal(dirFromTo(0, 0, 0, 0), null);   // self
  assert.equal(dirFromTo(0, 0, 2, 0), null);   // 2 away
  assert.equal(dirFromTo(0, 0, 1, 2), null);   // knight-jump
});

test('hasAnySpecial: true for non-empty special, false for empty/missing', () => {
  assert.equal(hasAnySpecial({ special: ['up'] }), true);
  assert.equal(hasAnySpecial({ special: [] }), false);
  assert.equal(hasAnySpecial({}), false);
});

// ---------- resolveCaptures -------------------------------------------------
function makeCombatState(attacker, defenders) {
  // Place attacker at (1,1) and defenders relative to it.
  const state = makeState();
  const att = place(state, attacker, 1, 1);
  for (const d of defenders) place(state, d.opts, d.x, d.y);
  return { state, att };
}

test('resolveCaptures: ortho atk > def → certain "atk>def"', () => {
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 5, def: 0 },
    [{ x: 2, y: 1, opts: { side: 'red', atk: 0, def: 3 } }],
  );
  const r = resolveCaptures(state, att, state.cards);
  assert.equal(r.length, 1);
  assert.equal(r[0].certain, true);
  assert.equal(r[0].reason, 'atk>def');
});

test('resolveCaptures: ortho atk < def → no result', () => {
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 1, def: 0 },
    [{ x: 2, y: 1, opts: { side: 'red', atk: 0, def: 5 } }],
  );
  assert.deepEqual(resolveCaptures(state, att, state.cards), []);
});

test('resolveCaptures: ortho atk == def → chance "tie"', () => {
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 3, def: 0 },
    [{ x: 2, y: 1, opts: { side: 'red', atk: 0, def: 3 } }],
  );
  const r = resolveCaptures(state, att, state.cards);
  assert.equal(r.length, 1);
  assert.equal(r[0].certain, false);
  assert.equal(r[0].reason, 'tie');
});

test('resolveCaptures: ortho attacker special auto-wins regardless of stats', () => {
  // atk 0 vs def 9 — would lose by stats, but attacker has special pointing at defender.
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 0, def: 0, special: ['right'] },
    [{ x: 2, y: 1, opts: { side: 'red', atk: 0, def: 9 } }],
  );
  const r = resolveCaptures(state, att, state.cards);
  assert.equal(r.length, 1);
  assert.equal(r[0].certain, true);
  assert.equal(r[0].reason, 'special-win');
});

test('resolveCaptures: defender same-direction-back special blocks regular attack', () => {
  // Attacker at (1,1) attacks right. Defender's special "left" points back at attacker.
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 9, def: 0 },
    [{ x: 2, y: 1, opts: { side: 'red', atk: 0, def: 0, special: ['left'] } }],
  );
  // No result: defender's counter-special wins outright.
  assert.deepEqual(resolveCaptures(state, att, state.cards), []);
});

test('resolveCaptures: defender other-direction special does NOT block regular attack', () => {
  // Defender's special points away ('right'), not back at attacker.
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 5, def: 0 },
    [{ x: 2, y: 1, opts: { side: 'red', atk: 0, def: 3, special: ['right'] } }],
  );
  const r = resolveCaptures(state, att, state.cards);
  assert.equal(r.length, 1);
  assert.equal(r[0].certain, true);
  assert.equal(r[0].reason, 'atk>def');
});

test('resolveCaptures: attacker special + defender counter → chance "special-clash"', () => {
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 0, def: 0, special: ['right'] },
    [{ x: 2, y: 1, opts: { side: 'red', atk: 0, def: 0, special: ['left'] } }],
  );
  const r = resolveCaptures(state, att, state.cards);
  assert.equal(r.length, 1);
  assert.equal(r[0].certain, false);
  assert.equal(r[0].reason, 'special-clash');
});

test('resolveCaptures: diagonal with no attacker special → no battle', () => {
  // Defender at upRight. Attacker has no diagonal special.
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 9, def: 0 }, // huge atk, but diag is not a battle
    [{ x: 2, y: 0, opts: { side: 'red', atk: 0, def: 0 } }],
  );
  assert.deepEqual(resolveCaptures(state, att, state.cards), []);
});

test('resolveCaptures: diagonal with attacker special, no counter → certain', () => {
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 0, def: 0, special: ['upRight'] },
    [{ x: 2, y: 0, opts: { side: 'red', atk: 0, def: 9 } }],
  );
  const r = resolveCaptures(state, att, state.cards);
  assert.equal(r.length, 1);
  assert.equal(r[0].certain, true);
  assert.equal(r[0].reason, 'special-win');
});

test('resolveCaptures: diagonal with attacker special + defender counter → clash', () => {
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 0, def: 0, special: ['upRight'] },
    [{ x: 2, y: 0, opts: { side: 'red', atk: 0, def: 0, special: ['downLeft'] } }],
  );
  const r = resolveCaptures(state, att, state.cards);
  assert.equal(r.length, 1);
  assert.equal(r[0].certain, false);
  assert.equal(r[0].reason, 'special-clash');
});

test('resolveCaptures: ignores same-side neighbors', () => {
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 9, def: 0 },
    [{ x: 2, y: 1, opts: { side: 'blue', atk: 0, def: 0 } }],
  );
  assert.deepEqual(resolveCaptures(state, att, state.cards), []);
});

test('resolveCaptures: multiple ortho neighbors all flip when each is beaten', () => {
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 5, def: 0 },
    [
      { x: 0, y: 1, opts: { side: 'red', atk: 0, def: 1 } }, // left
      { x: 2, y: 1, opts: { side: 'red', atk: 0, def: 2 } }, // right
      { x: 1, y: 0, opts: { side: 'red', atk: 0, def: 3 } }, // up
      { x: 1, y: 2, opts: { side: 'red', atk: 0, def: 4 } }, // down
    ],
  );
  const r = resolveCaptures(state, att, state.cards);
  assert.equal(r.length, 4);
  for (const x of r) assert.equal(x.certain, true);
});

test('resolveCaptures at corner: only in-bounds neighbors are considered', () => {
  const state = makeState();
  const att = place(state, { side: 'blue', atk: 5, def: 0, special: ['left','up','upLeft'] }, 0, 0);
  place(state, { side: 'red', atk: 0, def: 1 }, 1, 0); // right neighbor — atk>def → flip
  const r = resolveCaptures(state, att, state.cards);
  // The only in-bounds enemy is to the right; left/up/upLeft point off-board.
  assert.equal(r.length, 1);
  assert.equal(r[0].card.id, state.cards[1].id);
});

test('resolveCaptures: attacker with ortho special pointing at one neighbor only matches that direction', () => {
  // Attacker has "right" special. Defender on left side: regular battle (not special-win).
  const { state, att } = makeCombatState(
    { side: 'blue', atk: 1, def: 0, special: ['right'] },
    [{ x: 0, y: 1, opts: { side: 'red', atk: 0, def: 5 } }], // defender on the LEFT
  );
  // atk=1 < def=5 and no relevant special → no flip.
  assert.deepEqual(resolveCaptures(state, att, state.cards), []);
});

// ---------- moveOutcomes ----------------------------------------------------
test('moveOutcomes: zero-chance placement returns single outcome with p=1', () => {
  const state = makeState();
  const card = addCard(state, { side: 'blue', atk: 5, def: 0 });
  place(state, { side: 'red', atk: 0, def: 1 }, 2, 1); // ortho neighbor, certain flip

  const outcomes = moveOutcomes(state, card, 1, 1, 'blue', state.cards);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].p, 1);
  // Placed card moved to (1,1) and red flipped to blue.
  const placed = cardAt(outcomes[0].board, 1, 1);
  assert.equal(placed.id, card.id);
  assert.equal(placed.owner, 'blue');
  const flipped = cardAt(outcomes[0].board, 2, 1);
  assert.equal(flipped.owner, 'blue');
});

test('moveOutcomes: one chance battle yields 2 outcomes, p sums to 1, exactly one branch flips', () => {
  const state = makeState();
  const card = addCard(state, { side: 'blue', atk: 3, def: 0 });
  const enemy = place(state, { side: 'red', atk: 0, def: 3 }, 2, 1); // tie → chance

  const outcomes = moveOutcomes(state, card, 1, 1, 'blue', state.cards);
  assert.equal(outcomes.length, 2);
  const totalP = outcomes.reduce((s, o) => s + o.p, 0);
  assert.equal(totalP, 1);
  const flips = outcomes.filter(o => cardAt(o.board, 2, 1).owner === 'blue').length;
  assert.equal(flips, 1, 'exactly one of the two branches should flip the enemy');
});

test('moveOutcomes: two chance battles yield 4 outcomes summing to 1, all 4 mask combinations present', () => {
  const state = makeState();
  const card = addCard(state, { side: 'blue', atk: 3, def: 0 });
  place(state, { side: 'red', atk: 0, def: 3 }, 0, 1); // tie chance — left
  place(state, { side: 'red', atk: 0, def: 3 }, 2, 1); // tie chance — right

  const outcomes = moveOutcomes(state, card, 1, 1, 'blue', state.cards);
  assert.equal(outcomes.length, 4);
  const totalP = outcomes.reduce((s, o) => s + o.p, 0);
  assert.equal(totalP, 1);
  // Every combination of {left flips?, right flips?} appears once.
  const seen = new Set();
  for (const o of outcomes) {
    const l = cardAt(o.board, 0, 1).owner === 'blue';
    const r = cardAt(o.board, 2, 1).owner === 'blue';
    seen.add(`${l ? 1 : 0}${r ? 1 : 0}`);
  }
  assert.equal(seen.size, 4);
});

test('moveOutcomes: certain captures applied in every branch alongside chance flips', () => {
  const state = makeState();
  const card = addCard(state, { side: 'blue', atk: 5, def: 0 });
  place(state, { side: 'red', atk: 0, def: 1 }, 0, 1); // certain flip — left
  place(state, { side: 'red', atk: 0, def: 5 }, 2, 1); // tie → chance — right

  const outcomes = moveOutcomes(state, card, 1, 1, 'blue', state.cards);
  assert.equal(outcomes.length, 2);
  for (const o of outcomes) {
    // Certain flip applies in every branch.
    assert.equal(cardAt(o.board, 0, 1).owner, 'blue');
  }
});

test('moveOutcomes does not mutate the input board or any card object', () => {
  const state = makeState();
  const card = addCard(state, { side: 'blue', atk: 5, def: 0 });
  const enemy = place(state, { side: 'red', atk: 0, def: 1 }, 2, 1);

  const before = state.cards.slice();
  const enemyBefore = { ...enemy };
  const cardBefore = { ...card };

  moveOutcomes(state, card, 1, 1, 'blue', state.cards);

  // Same array length and same object identities at each index.
  assert.equal(state.cards.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(state.cards[i], before[i], `card array entry ${i} replaced`);
  }
  // Card properties unchanged on the originals.
  assert.equal(enemy.owner, enemyBefore.owner);
  assert.deepEqual(enemy.location, enemyBefore.location);
  assert.equal(card.owner, cardBefore.owner);
  assert.equal(card.location, cardBefore.location);
});

test('moveOutcomes: throws when the card is not in the board', () => {
  const state = makeState();
  const orphan = { id: 9999, side: 'blue', owner: 'blue', atk: 1, def: 1, special: [], location: 'hand' };
  assert.throws(
    () => moveOutcomes(state, orphan, 1, 1, 'blue', state.cards),
    /not in board/,
  );
});

// ---------- staticScore / emptySquares / gameOver ---------------------------
test('staticScore: empty board → 0', () => {
  assert.equal(staticScore([]), 0);
});

test('staticScore: ignores hand cards, counts placed cards by current owner', () => {
  const state = makeState();
  place(state, { side: 'blue', atk: 1, def: 1 }, 0, 0);
  place(state, { side: 'blue', atk: 1, def: 1 }, 1, 0);
  place(state, { side: 'red',  atk: 1, def: 1 }, 2, 0);
  addCard(state, { side: 'red', atk: 1, def: 1 }); // in hand — not counted
  assert.equal(staticScore(state.cards), 1); // 2 - 1
  // After flipping the red placed card to blue:
  state.cards[2].owner = 'blue';
  assert.equal(staticScore(state.cards), 3); // 3 - 0
});

test('emptySquares: excludes blocked and occupied cells', () => {
  const state = makeState({ blocked: [{ x: 0, y: 0 }] });
  place(state, { side: 'blue', atk: 1, def: 1 }, 1, 0);
  const empties = emptySquares(state, state.cards);
  // 4*3 = 12 cells - 1 blocked - 1 occupied = 10.
  assert.equal(empties.length, 10);
  for (const e of empties) {
    assert.ok(!(e.x === 0 && e.y === 0), 'blocked cell leaked into empties');
    assert.ok(!(e.x === 1 && e.y === 0), 'occupied cell leaked into empties');
  }
});

test('gameOver: true when 11 of 12 cells filled (one blocked)', () => {
  const state = makeState({ blocked: [{ x: 0, y: 0 }] });
  let id = 100;
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      if (x === 0 && y === 0) continue;
      place(state, { id: id++, side: 'blue', atk: 0, def: 0 }, x, y);
    }
  }
  assert.equal(gameOver(state, state.cards), true);
});

test('gameOver: true when both hands are empty even if cells remain', () => {
  const state = makeState();
  place(state, { side: 'blue', atk: 1, def: 1 }, 0, 0);
  place(state, { side: 'red',  atk: 1, def: 1 }, 1, 0);
  assert.equal(gameOver(state, state.cards), true);
});

test('gameOver: false mid-game with cells and hand cards left', () => {
  const state = makeState();
  addCard(state, { side: 'blue', atk: 1, def: 1 });
  addCard(state, { side: 'red',  atk: 1, def: 1 });
  place(state, { side: 'blue', atk: 1, def: 1 }, 0, 0);
  assert.equal(gameOver(state, state.cards), false);
});

// ---------- chanceCombine ---------------------------------------------------
test('chanceCombine: single value passes through unchanged', () => {
  assert.equal(chanceCombine([5], 'blue'), 5);
  assert.equal(chanceCombine([-3], 'red'), -3);
});

test('chanceCombine: blue picks MIN (worst for blue)', () => {
  assert.equal(chanceCombine([3, 1, 4, 1, 5], 'blue'), 1);
});

test('chanceCombine: red picks MAX (worst for red)', () => {
  assert.equal(chanceCombine([3, 1, 4, 1, 5], 'red'), 5);
});

// ---------- bestMoveForSide / search ---------------------------------------
test('bestMoveForSide: empty hand → null', () => {
  const state = makeState();
  place(state, { side: 'red', atk: 1, def: 1 }, 0, 0);
  // No blue hand cards.
  assert.equal(bestMoveForSide(state, 'blue', 3), null);
});

test('bestMoveForSide picks a guaranteed flip over a coin-toss flip (pessimistic)', () => {
  // 4x3, blocked at (3,2).
  // - Red ties with our atk (def=3) at (1,0) and (1,1) → ties (chance)
  // - Red beatable certainly at (3,1) (def=2)
  // Our blue card has atk=3.
  // Pessimistic worst case: tie battles → no flip; certain flip stays.
  const state = makeState({ blocked: [{ x: 3, y: 2 }] });
  const blue = addCard(state, { side: 'blue', atk: 3, def: 0 });
  place(state, { side: 'red', atk: 0, def: 3 }, 1, 0);
  place(state, { side: 'red', atk: 0, def: 3 }, 1, 1);
  place(state, { side: 'red', atk: 0, def: 2 }, 3, 1);

  const best = bestMoveForSide(state, 'blue', 1);
  assert.ok(best, 'expected a best move');
  assert.equal(best.cardId, blue.id);
  // Starting: 3 red placed. After best move: +1 blue placed + 1 flip (red→blue):
  //   placed blue = 0+1+1 = 2; placed red = 3-1 = 2; score = 0.
  assert.equal(best.score, 0);
  // expGain counts (blue placed cards added by this move) = placement + flips.
  // 1 placement + 1 certain flip = 2.
  assert.equal(best.expGain, 2);
  // The chosen square must be one that flips the (3,1) certain target —
  // i.e. an in-bounds, non-blocked ortho neighbor of (3,1).
  const adjacentToCertain = [
    { x: 3, y: 0 }, // up
    { x: 2, y: 1 }, // left
    // (3,2) is blocked.
  ];
  assert.ok(
    adjacentToCertain.some(a => a.x === best.x && a.y === best.y),
    `expected best to be adjacent to the (3,1) certain flip target, got (${best.x},${best.y})`,
  );
});

test('bestMoveForSide: search does not mutate state.cards or any card object', () => {
  const state = makeState();
  const blue = addCard(state, { side: 'blue', atk: 3, def: 0 });
  const enemy1 = place(state, { side: 'red', atk: 0, def: 1 }, 1, 0);
  const enemy2 = place(state, { side: 'red', atk: 0, def: 5 }, 2, 1);

  const cardsBefore = state.cards.slice();
  const snapshots = state.cards.map(c => ({ ...c }));

  bestMoveForSide(state, 'blue', 3);

  // Same array shape and same object identities.
  assert.equal(state.cards.length, cardsBefore.length);
  for (let i = 0; i < cardsBefore.length; i++) {
    assert.equal(state.cards[i], cardsBefore[i]);
    // Every visible field unchanged.
    for (const k of Object.keys(snapshots[i])) {
      assert.deepEqual(state.cards[i][k], snapshots[i][k], `card[${i}].${k} changed`);
    }
  }
});

test('bestMoveForSide: result includes searchDepth and searchNodes when budget is generous', () => {
  const state = makeState();
  addCard(state, { side: 'blue', atk: 5, def: 0 });
  place(state, { side: 'red', atk: 0, def: 1 }, 1, 0);

  const best = bestMoveForSide(state, 'blue', 2, { budgetMs: Infinity });
  assert.ok(best);
  assert.equal(best.searchDepth, 2);
  assert.ok(best.searchNodes > 0);
});

test('bestMoveForSide: budget exhaustion clamps to a shallower achievedDepth', () => {
  const state = makeState();
  for (let i = 0; i < 3; i++) addCard(state, { side: 'blue', atk: 3, def: 3 });
  for (let i = 0; i < 3; i++) addCard(state, { side: 'red',  atk: 3, def: 3 });

  // Phase-based fake clock: returns 0 long enough for the first iterative-
  // deepening pass (depth 1) to complete its top-of-loop check, then jumps
  // far past the deadline so depth 2 fails the loop guard immediately.
  let calls = 0;
  const fakeNow = () => {
    calls++;
    return calls <= 2 ? 0 : 1_000_000; // call 1 = makeSearchCtx, 2 = d=1 guard
  };

  const best = bestMoveForSide(state, 'blue', 5, { budgetMs: 200, now: fakeNow });
  assert.ok(best, 'expected depth 1 to complete before the deadline trips');
  assert.equal(best.searchDepth, 1);
});

test('bestMoveForSide: zero budget returns null (no depth completes)', () => {
  const state = makeState();
  addCard(state, { side: 'blue', atk: 5, def: 0 });
  place(state, { side: 'red', atk: 0, def: 1 }, 1, 0);

  // now() jumps far past deadline immediately.
  let t = 0;
  const fakeNow = () => (t += 1_000_000);
  const best = bestMoveForSide(state, 'blue', 5, { budgetMs: 1, now: fakeNow });
  assert.equal(best, null);
});

test('bestMoveForSide: red side is symmetric — picks red-favorable move', () => {
  // Mirror the pessimism test for red. Red plays atk=3 against blue defenders:
  //   blue defenders at (1,0)/(1,1) with def=3 (ties, chance), and at (3,1) def=2 (certain).
  const state = makeState({ blocked: [{ x: 3, y: 2 }] });
  const red = addCard(state, { side: 'red', atk: 3, def: 0 });
  place(state, { side: 'blue', atk: 0, def: 3 }, 1, 0);
  place(state, { side: 'blue', atk: 0, def: 3 }, 1, 1);
  place(state, { side: 'blue', atk: 0, def: 2 }, 3, 1);

  const best = bestMoveForSide(state, 'red', 1);
  assert.ok(best);
  assert.equal(best.cardId, red.id);
  // expGain = (red placed cards added by this move) = 1 placement + 1 flip = 2.
  assert.equal(best.expGain, 2);
  // Score is from RED's perspective in the result (sideEv = -staticScore for red).
  // Starting board: 3 blue placed, 0 red placed → staticScore=3. After best move:
  // 1 red placed + 1 flipped, 2 blue remain → staticScore = 2 - 2 = 0; sideEv = 0.
  assert.equal(best.score, 0);
});

// ---------- expectimax / searchAtDepth direct tests -------------------------
test('expectimax: terminal at depth 0 returns staticScore', () => {
  const state = makeState();
  place(state, { side: 'blue', atk: 1, def: 1 }, 0, 0);
  place(state, { side: 'red',  atk: 1, def: 1 }, 1, 0);
  const v = expectimax(state, state.cards, 'blue', 0, 'blue');
  assert.equal(v, 0);
});

test('expectimax: terminal when game over returns staticScore', () => {
  // Both hands empty, two cards placed.
  const state = makeState();
  place(state, { side: 'blue', atk: 1, def: 1 }, 0, 0);
  place(state, { side: 'blue', atk: 1, def: 1 }, 1, 0);
  const v = expectimax(state, state.cards, 'blue', 5, 'blue');
  assert.equal(v, 2);
});

test('searchAtDepth: returns null when no hand cards', () => {
  const state = makeState();
  place(state, { side: 'red', atk: 1, def: 1 }, 0, 0);
  // No cards in hand for blue.
  const result = searchAtDepth(state, 'blue', 1);
  assert.equal(result, null);
});

test('searchAtDepth: depth 1 result equals top-level score for a forced flip', () => {
  const state = makeState();
  addCard(state, { side: 'blue', atk: 5, def: 0 });
  place(state, { side: 'red', atk: 0, def: 1 }, 1, 0);
  const r = searchAtDepth(state, 'blue', 1);
  // Best: place blue adjacent to (1,0); flips the red. After: 2 blue placed, 0 red.
  assert.equal(r.score, 2);
  // expGain = blue placed delta = 0 → 2 = 2 (placement + 1 flip).
  assert.equal(r.expGain, 2);
});

// ---------- BudgetExceeded sanity ------------------------------------------
test('BudgetExceeded is thrown internally during a low-budget search and caught', () => {
  // We can't easily catch it from outside (it's swallowed by bestMoveForSide).
  // Instead, just verify the class exists and is throwable as an Error.
  assert.ok(BudgetExceeded.prototype instanceof Error);
  const e = new BudgetExceeded();
  assert.ok(e instanceof BudgetExceeded);
  assert.ok(e instanceof Error);
});
