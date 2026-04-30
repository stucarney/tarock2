/* =========================================================
   Tarock 2.0 — game logic & search engine
   ---------------------------------------------------------
   Pure module. No DOM access. Works in browser and Node.
   In the browser it publishes itself as `globalThis.Engine`;
   in Node it exports the same object via CommonJS.

   See CLAUDE.md ("Game rules" + "Search engine") for the
   meaning of every rule and search choice in here.
   ========================================================= */
(function (global) {
  'use strict';

  // ---------- Direction constants ----------
  const DIRS = {
    up:        [ 0, -1], upRight:   [ 1, -1], right:     [ 1,  0], downRight: [ 1,  1],
    down:      [ 0,  1], downLeft:  [-1,  1], left:      [-1,  0], upLeft:    [-1, -1],
  };
  const OPP_DIR = {
    up: 'down', down: 'up', left: 'right', right: 'left',
    upLeft: 'downRight', downRight: 'upLeft',
    upRight: 'downLeft', downLeft: 'upRight',
  };
  const ORTHO_DIRS = new Set(['up', 'down', 'left', 'right']);
  const isOrtho = d => ORTHO_DIRS.has(d);
  const DIR_SYMBOL = {
    up: '↑', upRight: '↗', right: '→', downRight: '↘',
    down: '↓', downLeft: '↙', left: '←', upLeft: '↖',
  };

  // ---------- Pure board helpers ----------
  // `state` here only needs {cols, rows, blocked}. The full app uses the same
  // shape (with cards/turn/history added) so callers can pass state directly.

  function inBounds(state, x, y) {
    return x >= 0 && y >= 0 && x < state.cols && y < state.rows;
  }

  function isBlocked(state, x, y) {
    const b = state.blocked || [];
    for (let i = 0; i < b.length; i++) {
      if (b[i].x === x && b[i].y === y) return true;
    }
    return false;
  }

  function cardAt(board, x, y) {
    return board.find(c =>
      c.location && typeof c.location === 'object' &&
      c.location.x === x && c.location.y === y);
  }

  function neighbors(state, x, y) {
    const out = [];
    for (const [d, [dx, dy]] of Object.entries(DIRS)) {
      const nx = x + dx, ny = y + dy;
      if (inBounds(state, nx, ny)) out.push({ d, x: nx, y: ny });
    }
    return out;
  }

  function dirFromTo(fx, fy, tx, ty) {
    const dx = tx - fx, dy = ty - fy;
    for (const [name, [ddx, ddy]] of Object.entries(DIRS)) {
      if (ddx === dx && ddy === dy) return name;
    }
    return null;
  }

  function hasAnySpecial(card) {
    return Array.isArray(card.special) && card.special.length > 0;
  }

  // Pack (x,y) into a small int for Map keys. Cols/rows are tiny in this game.
  const posKey = (x, y) => (x << 4) | y;

  // Build a card-id → board-index map. The search keeps the same array shape
  // across every clone (Array.slice preserves indices, mutations are
  // clone-and-replace at the same index), so this map is stable for the
  // entire search and lets us skip O(N) findIndex scans on the hot path.
  function buildIdIndex(board) {
    const m = new Map();
    for (let i = 0; i < board.length; i++) m.set(board[i].id, i);
    return m;
  }

  /**
   * Compact, canonical key describing the on-board state plus side-to-play.
   * Two boards with the same placements/owners and the same side-to-play
   * produce identical keys — exactly what the transposition table needs.
   *
   * Hand state is determined by placed state (cards never appear or vanish
   * during a search), so it's not part of the key.
   */
  function boardKey(board, sideToPlay, cols, rows) {
    const total = cols * rows;
    const cells = new Array(total);
    for (let i = 0; i < total; i++) cells[i] = '_';
    for (const c of board) {
      if (c.location && typeof c.location === 'object') {
        const idx = c.location.y * cols + c.location.x;
        cells[idx] = (c.owner === 'blue' ? 'b' : 'r') + c.id;
      }
    }
    return cells.join('|') + '/' + sideToPlay[0];
  }

  // ---------- Combat resolution (live placement) ----------
  /**
   * Resolve the combat that happens when `placedCard` is placed at its current
   * location on `board`. Returns an array of `{card, certain, reason}` outcomes
   * (one entry per neighbor that produced a battle result).
   *
   *   certain=true  → the defender is captured no matter what
   *   certain=false → the outcome depends on a coin toss
   *
   * Reasons: 'special-win', 'special-clash', 'atk>def', 'tie'.
   *
   * The placed card's own location MUST already be set on `placedCard`.
   * The function does not mutate any board entries — it just reports outcomes.
   * See CLAUDE.md ("Combat decision table") for the full truth table.
   */
  function resolveCaptures(state, placedCard, board) {
    const results = [];
    for (const n of neighbors(state, placedCard.location.x, placedCard.location.y)) {
      const target = cardAt(board, n.x, n.y);
      if (!target) continue;
      if (target.owner === placedCard.owner) continue;

      const dir = n.d;
      const aSpec    = (placedCard.special || []).includes(dir);
      const dCounter = (target.special     || []).includes(OPP_DIR[dir]);

      if (isOrtho(dir)) {
        if      (aSpec && dCounter)     results.push({ card: target, certain: false, reason: 'special-clash' });
        else if (aSpec)                 results.push({ card: target, certain: true,  reason: 'special-win'   });
        else if (dCounter)              continue; // defender's same-direction-back special wins outright
        else if (placedCard.atk >  target.def)  results.push({ card: target, certain: true,  reason: 'atk>def' });
        else if (placedCard.atk === target.def) results.push({ card: target, certain: false, reason: 'tie'    });
        // else: target.def > attacker.atk → defender wins by stats, no flip.
      } else {
        // Diagonal: only a battle if the attacker has that diagonal special.
        if (!aSpec) continue;
        if (dCounter) results.push({ card: target, certain: false, reason: 'special-clash' });
        else          results.push({ card: target, certain: true,  reason: 'special-win'   });
      }
    }
    return results;
  }

  // ---------- Move-outcome generation (used by search) ----------
  /**
   * Place `card` at (x,y) for `side` on a clone of `board`. Returns every
   * possible outcome board (one per coin-toss combination):
   *
   *   [{p, board}, ...]   p values sum to 1.0
   *
   * Each chance battle (tie or special clash) doubles the branch count, so a
   * placement with N chance captures yields 2^N branches at p = 1/2^N.
   *
   * Crucially, this function never mutates the input board or any card object
   * inside it — outcome boards are shallow Array clones, and any owner change
   * is done via `{...card, owner: newSide}` so the original card object is
   * untouched. The caller can rely on `board` being identical after the call.
   */
  /** Build a (posKey → card) index over all currently-placed cards. */
  function buildPosIndex(board) {
    const m = new Map();
    for (const c of board) {
      if (c.location && typeof c.location === 'object') {
        m.set(posKey(c.location.x, c.location.y), c);
      }
    }
    return m;
  }

  function _moveOutcomes(idIndex, posIndex, state, card, x, y, side, board) {
    const base = board.slice();
    const cardIdx = idIndex.get(card.id);
    if (cardIdx === undefined) {
      throw new Error(`moveOutcomes: card id ${card.id} is not in board`);
    }
    const placed = { ...base[cardIdx], owner: side, location: { x, y } };
    base[cardIdx] = placed;

    const certainIdx = [];
    const chanceIdx  = [];
    for (const n of neighbors(state, x, y)) {
      const t = posIndex.get(posKey(n.x, n.y));
      if (!t || t.id === placed.id || t.owner === side) continue;
      const aSpec    = (placed.special || []).includes(n.d);
      const dCounter = (t.special      || []).includes(OPP_DIR[n.d]);
      const i = idIndex.get(t.id);

      if (isOrtho(n.d)) {
        if      (aSpec && dCounter)     chanceIdx.push(i);
        else if (aSpec)                 certainIdx.push(i);
        else if (dCounter)              continue;
        else if (placed.atk >  t.def)   certainIdx.push(i);
        else if (placed.atk === t.def)  chanceIdx.push(i);
      } else {
        if (!aSpec) continue;
        if (dCounter) chanceIdx.push(i);
        else          certainIdx.push(i);
      }
    }

    // Apply certain captures (clone-and-replace at known indices).
    for (const i of certainIdx) {
      base[i] = { ...base[i], owner: side };
    }

    if (chanceIdx.length === 0) return [{ p: 1, board: base }];

    // Enumerate the 2^N chance outcomes.
    const N = chanceIdx.length;
    const out = [];
    const w = 1 / (1 << N);
    for (let mask = 0; mask < (1 << N); mask++) {
      const b = base.slice();
      for (let i = 0; i < N; i++) {
        if (mask & (1 << i)) {
          const j = chanceIdx[i];
          b[j] = { ...b[j], owner: side };
        }
      }
      out.push({ p: w, board: b });
    }
    return out;
  }

  // Public: builds id+pos indexes on the fly for one-shot callers (tests,
  // the live placement path). The hot search path passes pre-built indexes.
  function moveOutcomes(state, card, x, y, side, board) {
    return _moveOutcomes(buildIdIndex(board), buildPosIndex(board),
                         state, card, x, y, side, board);
  }

  // ---------- Evaluation ----------
  function staticScore(board) {
    let blue = 0, red = 0;
    for (const c of board) {
      if (!c.location || typeof c.location !== 'object') continue;
      if      (c.owner === 'blue') blue++;
      else if (c.owner === 'red')  red++;
    }
    return blue - red;
  }

  function emptySquares(state, board) {
    const out = [];
    for (let y = 0; y < state.rows; y++) {
      for (let x = 0; x < state.cols; x++) {
        if (isBlocked(state, x, y)) continue;
        if (board.some(c =>
          c.location && typeof c.location === 'object' &&
          c.location.x === x && c.location.y === y)) continue;
        out.push({ x, y });
      }
    }
    return out;
  }

  function gameOver(state, board) {
    const placedCount = board.filter(c =>
      c.location && typeof c.location === 'object').length;
    const playable = state.cols * state.rows - (state.blocked ? state.blocked.length : 0);
    if (placedCount >= playable) return true;
    const blueHand = board.filter(c => c.location === 'hand' && c.side === 'blue').length;
    const redHand  = board.filter(c => c.location === 'hand' && c.side === 'red').length;
    return blueHand === 0 && redHand === 0;
  }

  // ---------- Pessimistic minimax search ----------
  /**
   * Combine multiple chance-outcome values pessimistically: pick the branch
   * that is worst for the user (the side at the root). Never bets on a coin
   * toss going the user's way.
   *
   *   user is blue → MIN (blue wants the score high, so worst = lowest)
   *   user is red  → MAX (red wants the score low,  so worst = highest)
   */
  function chanceCombine(values, userSide) {
    if (values.length === 1) return values[0];
    if (userSide === 'blue') {
      let m = Infinity;
      for (const v of values) if (v < m) m = v;
      return m;
    } else {
      let m = -Infinity;
      for (const v of values) if (v > m) m = v;
      return m;
    }
  }

  class BudgetExceeded extends Error {
    constructor() { super('search budget exceeded'); }
  }

  function defaultNow() {
    return typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
  }

  function makeSearchCtx(state, opts) {
    const budgetMs = opts.budgetMs ?? 4000;
    const now = opts.now || defaultNow;
    return {
      state,
      now,
      deadline: budgetMs === Infinity ? Infinity : now() + budgetMs,
      nodeCount: 0,
      // Card-id → board-index map. Stable across the entire search because
      // slice() preserves indices and mutations are clone-and-replace at the
      // same slot. Built once here so the hot path can skip findIndex scans.
      idIndex: buildIdIndex(state.cards),
      // Transposition table — shared across iterative-deepening iterations
      // within one bestMoveForSide call. Each entry caches `(boardKey,
      // sideToPlay) → {depth, value}`. A cached entry is reusable when its
      // `depth` is at least the remaining depth at the query site, since
      // deeper search ≥ shallower search under iterative deepening.
      tt: opts.tt || new Map(),
      ttHits: 0,
      ttMisses: 0,
    };
  }

  /** Bare move list in natural board × empties order — used when remaining
   *  depth is too shallow for ordering overhead to pay off. */
  function naturalMoves(board, empties, sideToPlay) {
    const moves = [];
    for (const card of board) {
      if (card.location !== 'hand' || card.side !== sideToPlay) continue;
      for (let i = 0; i < empties.length; i++) {
        moves.push({ card, x: empties[i].x, y: empties[i].y, cnt: 0 });
      }
    }
    return moves;
  }

  /**
   * Build a move list sorted by descending estimated capture count for the
   * given side-to-play. The capture estimate is a fast preview that mirrors
   * moveOutcomes' classification (counting both certain and chance flips)
   * but does no allocation of outcome boards. Best moves first means α-β
   * cuts fire as early as possible, which is the dominant cost saver.
   */
  function orderedMoves(ctx, board, empties, sideToPlay, posIndex) {
    const state = ctx.state;
    const pos = posIndex || buildPosIndex(board);
    const moves = [];
    for (const card of board) {
      if (card.location !== 'hand' || card.side !== sideToPlay) continue;
      const cardSpec = card.special;
      const cardAtk = card.atk;
      for (let i = 0; i < empties.length; i++) {
        const x = empties[i].x, y = empties[i].y;
        let cnt = 0;
        for (const n of neighbors(state, x, y)) {
          const t = pos.get(posKey(n.x, n.y));
          if (!t || t.owner === sideToPlay) continue;
          const aSpec    = cardSpec && cardSpec.includes(n.d);
          const dCounter = t.special && t.special.includes(OPP_DIR[n.d]);
          if (isOrtho(n.d)) {
            if      (aSpec && dCounter)    cnt++;
            else if (aSpec)                cnt++;
            else if (dCounter)             continue;
            else if (cardAtk >  t.def)     cnt++;
            else if (cardAtk === t.def)    cnt++;
          } else {
            if (!aSpec) continue;
            cnt++;
          }
        }
        moves.push({ card, x, y, cnt });
      }
    }
    moves.sort((a, b) => b.cnt - a.cnt);
    return moves;
  }

  // TT entry flags. EXACT means the cached value is the true minimax score;
  // LOWER means actual ≥ stored (β-cutoff at a max layer); UPPER means
  // actual ≤ stored (α-cutoff at a min layer).
  const FLAG_EXACT = 0;
  const FLAG_LOWER = 1;
  const FLAG_UPPER = 2;

  /**
   * Pessimistic minimax with alpha-beta pruning.
   *
   * Tree shape (under userSide=blue, the user-is-blue case):
   *   max(blue) → chance(min) → min(red) → chance(min) → max(blue) → …
   * Under userSide=red, chance becomes a max layer instead of min.
   * Either way, every layer is a deterministic min or max — so plain
   * alpha-beta pruning applies, including across chance branches:
   *
   *   • chance min (userSide=blue): cut when partial-min ≤ alpha
   *   • chance max (userSide=red):  cut when partial-max ≥ beta
   *
   * The TT stores (boardKey, sideToPlay) → {depth, value, flag}, with a flag
   * so that bounds from earlier α-β cuts can be re-used by later queries.
   */
  function expectimaxImpl(ctx, board, sideToPlay, depth, userSide, alpha, beta) {
    ctx.nodeCount++;
    if ((ctx.nodeCount & 0xFFF) === 0 && ctx.now() > ctx.deadline) {
      throw new BudgetExceeded();
    }
    if (depth === 0 || gameOver(ctx.state, board)) return staticScore(board);

    // At depth 1 the children just return staticScore — building a TT key
    // for a one-ply lookup costs more than re-doing the leaves directly.
    const useTT = depth >= 2;
    const cols = ctx.state.cols, rows = ctx.state.rows;
    let key = '';
    if (useTT) {
      key = boardKey(board, sideToPlay, cols, rows);
      const hit = ctx.tt.get(key);
      if (hit && hit.depth >= depth) {
        if (hit.flag === FLAG_EXACT) { ctx.ttHits++; return hit.value; }
        if (hit.flag === FLAG_LOWER && hit.value >= beta)  { ctx.ttHits++; return hit.value; }
        if (hit.flag === FLAG_UPPER && hit.value <= alpha) { ctx.ttHits++; return hit.value; }
      }
      ctx.ttMisses++;
    }

    // Inline hand-side counting — avoids two .filter() allocations per node.
    let myHand = 0;
    let otherSide = null;
    for (const c of board) {
      if (c.location !== 'hand') continue;
      if (c.side === sideToPlay) myHand++;
      else if (otherSide === null) otherSide = c.side;
    }
    if (myHand === 0) {
      if (!otherSide) return staticScore(board);
      return expectimaxImpl(ctx, board, otherSide, depth, userSide, alpha, beta);
    }
    const empties = emptySquares(ctx.state, board);
    if (empties.length === 0) return staticScore(board);

    const next = sideToPlay === 'blue' ? 'red' : 'blue';
    const isMax = sideToPlay === 'blue';
    const origAlpha = alpha, origBeta = beta;
    let best = isMax ? -Infinity : Infinity;

    // Position index built once per node, reused by every candidate move's
    // moveOutcomes call (the on-board state doesn't change while we're
    // enumerating moves at this node).
    const posIndex = buildPosIndex(board);

    // Move ordering: explore moves with the most captures first so α-β cuts
    // fire as early as possible. Worth it when there are many candidate
    // moves AND enough remaining depth for the cuts to compound. Skipping
    // ordering when the move list is small avoids the sort overhead in
    // late-game / mid-game positions where unsorted order is fine anyway.
    const expectedMoves = myHand * empties.length;
    const moves = (depth >= 3 && expectedMoves >= 30)
      ? orderedMoves(ctx, board, empties, sideToPlay, posIndex)
      : naturalMoves(board, empties, sideToPlay);

    moveLoop:
    for (let mi = 0; mi < moves.length; mi++) {
      const m = moves[mi];
      const outcomes = _moveOutcomes(ctx.idIndex, posIndex, ctx.state, m.card, m.x, m.y, sideToPlay, board);
      // Chance-combine inline. Pruning across chance branches is sound
      // because chance is a deterministic min/max layer, not an average.
      let mv;
      if (outcomes.length === 1) {
        mv = expectimaxImpl(ctx, outcomes[0].board, next, depth - 1, userSide, alpha, beta);
      } else if (userSide === 'blue') {
        mv = Infinity;
        for (const o of outcomes) {
          const cv = expectimaxImpl(ctx, o.board, next, depth - 1, userSide, alpha, beta);
          if (cv < mv) mv = cv;
          if (mv <= alpha) break; // chance-min cutoff
        }
      } else {
        mv = -Infinity;
        for (const o of outcomes) {
          const cv = expectimaxImpl(ctx, o.board, next, depth - 1, userSide, alpha, beta);
          if (cv > mv) mv = cv;
          if (mv >= beta) break;  // chance-max cutoff
        }
      }

      if (isMax) {
        if (mv > best) best = mv;
        if (best > alpha) alpha = best;
      } else {
        if (mv < best) best = mv;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break moveLoop; // β-cut at the side-to-play layer
    }

    if (useTT) {
      let flag = FLAG_EXACT;
      if (best <= origAlpha) flag = FLAG_UPPER;
      else if (best >= origBeta) flag = FLAG_LOWER;
      ttSet(ctx, key, depth, best, flag);
    }
    return best;
  }

  // V8 Maps tap out around 16M entries; the deep-game state space is much
  // bigger than that, so we cap and evict-FIFO to keep memory bounded.
  // Insertion order is preserved by Map, so the first key returned by .keys()
  // is always the oldest still in the cache.
  const TT_MAX = 2_000_000;
  const TT_EVICT_BATCH = TT_MAX >> 2; // drop oldest 25% in one pass

  function ttSet(ctx, key, depth, value, flag) {
    if (ctx.tt.size >= TT_MAX) {
      let n = 0;
      for (const k of ctx.tt.keys()) {
        ctx.tt.delete(k);
        if (++n >= TT_EVICT_BATCH) break;
      }
    }
    ctx.tt.set(key, { depth, value, flag });
  }

  function searchAtDepthImpl(ctx, side, depth) {
    const board = ctx.state.cards;
    const empties = emptySquares(ctx.state, board);
    let baseMy = 0;
    for (const c of board) {
      if (c.owner === side && c.location && typeof c.location === 'object') baseMy++;
    }
    const next = side === 'blue' ? 'red' : 'blue';
    const isMax = side === 'blue';

    // Track best move as we narrow alpha (max) or beta (min).
    let alpha = -Infinity, beta = Infinity;
    let best = null;
    const posIndex = buildPosIndex(board);
    const moves = orderedMoves(ctx, board, empties, side, posIndex);
    for (let mi = 0; mi < moves.length; mi++) {
      const m = moves[mi];
      const card = m.card, x = m.x, y = m.y;
      const outcomes = _moveOutcomes(ctx.idIndex, posIndex, ctx.state, card, x, y, side, board);

      // Compute worst-case immediate (placement + flips) up front — this
      // is just board-state arithmetic, no search, so α-β chance cuts can't
      // mask it.
      let immediate = Infinity;
      for (const o of outcomes) {
        let mine = 0;
        for (const c of o.board) {
          if (c.owner === side && c.location && typeof c.location === 'object') mine++;
        }
        const delta = mine - baseMy;
        if (delta < immediate) immediate = delta;
      }

      // Chance-combine the children with α-β.
      let mv;
      if (outcomes.length === 1) {
        mv = expectimaxImpl(ctx, outcomes[0].board, next, depth - 1, side, alpha, beta);
      } else if (side === 'blue') {
        mv = Infinity;
        for (const o of outcomes) {
          const cv = expectimaxImpl(ctx, o.board, next, depth - 1, side, alpha, beta);
          if (cv < mv) mv = cv;
          if (mv <= alpha) break;
        }
      } else {
        mv = -Infinity;
        for (const o of outcomes) {
          const cv = expectimaxImpl(ctx, o.board, next, depth - 1, side, alpha, beta);
          if (cv > mv) mv = cv;
          if (mv >= beta) break;
        }
      }

      // `+ 0` normalizes `-0` (negating a zero score for red) back to `+0`.
      const sideEv = (isMax ? mv : -mv) + 0;
      if (!best
          || sideEv > best.score
          || (sideEv === best.score && immediate > best.expGain)) {
        best = { cardId: card.id, x, y, score: sideEv, expGain: immediate, expLoss: 0 };
      }
      // Tighten the appropriate bound for the next iteration.
      if (isMax) { if (mv > alpha) alpha = mv; }
      else       { if (mv < beta)  beta  = mv; }
    }
    return best;
  }

  // Budget = soft cap on total thinking time across iterative-deepening
  // iterations. We pick generously (35s) so deep selections like depth 8
  // can actually finish on the worst case (fresh-start, 0 placed). All
  // shallower searches finish well under this — nothing is artificially
  // slowed by raising the cap.
  const SEARCH_BUDGET_MS = 35_000;

  /**
   * Iterative-deepening pessimistic minimax with a wall-clock budget.
   * Always returns the deepest fully-completed result; if depth N can't
   * finish within the budget, depth N-1's answer is returned.
   *
   * Result shape:
   *   { cardId, x, y, score, expGain, expLoss, searchDepth, searchNodes }
   * or null if no legal move exists.
   *
   * `opts.budgetMs` overrides the default 4s budget. `opts.now` lets tests
   * inject a deterministic clock.
   */
  function bestMoveForSide(state, side, maxDepth, opts = {}) {
    const ctx = makeSearchCtx(state, {
      budgetMs: opts.budgetMs ?? SEARCH_BUDGET_MS,
      now: opts.now,
    });
    let best = null;
    let achievedDepth = 0;
    let totalNodes = 0;
    for (let d = 1; d <= maxDepth; d++) {
      if (ctx.now() > ctx.deadline) break;
      ctx.nodeCount = 0;
      try {
        const result = searchAtDepthImpl(ctx, side, d);
        if (result) { best = result; achievedDepth = d; }
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) throw e;
        break; // out of time — keep best from the previous depth
      }
      totalNodes += ctx.nodeCount;
    }
    if (best) {
      best.searchDepth = achievedDepth;
      best.searchNodes = totalNodes;
      best.ttHits = ctx.ttHits;
      best.ttMisses = ctx.ttMisses;
      best.ttSize = ctx.tt.size;
    }
    return best;
  }

  // Test-friendly single-depth wrappers (skip iterative deepening / budget).
  function expectimax(state, board, sideToPlay, depth, userSide, opts = {}) {
    const ctx = makeSearchCtx(state, { budgetMs: opts.budgetMs ?? Infinity, now: opts.now });
    return expectimaxImpl(ctx, board, sideToPlay, depth, userSide, -Infinity, Infinity);
  }

  function searchAtDepth(state, side, depth, opts = {}) {
    const ctx = makeSearchCtx(state, { budgetMs: opts.budgetMs ?? Infinity, now: opts.now });
    return searchAtDepthImpl(ctx, side, depth);
  }

  const Engine = {
    DIRS, OPP_DIR, ORTHO_DIRS, isOrtho, DIR_SYMBOL,
    inBounds, isBlocked, cardAt, neighbors, dirFromTo, hasAnySpecial, posKey,
    resolveCaptures, moveOutcomes,
    staticScore, emptySquares, gameOver,
    chanceCombine, expectimax, searchAtDepth, bestMoveForSide,
    BudgetExceeded, SEARCH_BUDGET_MS,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = Engine;
  } else {
    global.Engine = Engine;
  }
})(typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof window !== 'undefined' ? window : this));
