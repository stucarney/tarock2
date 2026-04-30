// Package main — Tarock 2.0 Go solver engine.
//
// This is a faithful port of engine.js: same pessimistic-minimax search with
// alpha-beta pruning and a transposition table. Differences from the JS
// version are pure performance plays:
//
//   - Zobrist hashing (uint64) instead of string keys.
//   - Card metadata is shared across snapshots; the search clones the slice
//     of card structs but never mutates a card in place — same invariant
//     as the JS engine, just with value-typed structs.
//   - TT is a Go map[uint64]ttEntry, capped via FIFO eviction once it
//     reaches `ttMaxEntries`.
//
// All public correctness is verified against engine_test.go which mirrors
// engine.test.js's combat & search cases.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"time"
)

// ---------- Direction constants ----------

// Dir is one of the 8 compass directions. Numeric values match the
// indexing into dirOffsets / oppDir / dirNames.
type Dir int8

const (
	DirUp Dir = iota
	DirUpRight
	DirRight
	DirDownRight
	DirDown
	DirDownLeft
	DirLeft
	DirUpLeft
)

var dirOffsets = [8][2]int8{
	{0, -1}, {1, -1}, {1, 0}, {1, 1},
	{0, 1}, {-1, 1}, {-1, 0}, {-1, -1},
}

var oppDir = [8]Dir{
	DirDown, DirDownLeft, DirLeft, DirUpLeft,
	DirUp, DirUpRight, DirRight, DirDownRight,
}

var dirNames = [8]string{
	"up", "upRight", "right", "downRight",
	"down", "downLeft", "left", "upLeft",
}

func dirFromName(s string) (Dir, error) {
	for i, n := range dirNames {
		if n == s {
			return Dir(i), nil
		}
	}
	return 0, fmt.Errorf("unknown direction %q", s)
}

func isOrthoDir(d Dir) bool {
	return d == DirUp || d == DirRight || d == DirDown || d == DirLeft
}

// ---------- Side ----------

type Side int8

const (
	SideBlue Side = 0
	SideRed  Side = 1
)

func (s Side) Other() Side  { return s ^ 1 }
func (s Side) String() string {
	if s == SideBlue {
		return "blue"
	}
	return "red"
}

func sideFromString(s string) (Side, error) {
	switch s {
	case "blue":
		return SideBlue, nil
	case "red":
		return SideRed, nil
	}
	return 0, fmt.Errorf("unknown side %q", s)
}

// ---------- Card / Board ----------

// Card is value-typed. atk/def/special/side are immutable for a game; only
// owner/placed/x/y change during search, and those changes happen via
// clone-and-replace so other snapshots aren't disturbed.
type Card struct {
	ID      int
	Side    Side
	Owner   Side
	Atk     int8
	Def     int8
	Special uint8 // bitmask over Dir
	Placed  bool
	X, Y    int8
}

func (c Card) HasSpecial(d Dir) bool { return c.Special&(1<<uint8(d)) != 0 }

// Board is a slice of cards with a fixed shape across snapshots: same length,
// same IDs at the same indices in every clone.
type Board []Card

func (b Board) Clone() Board {
	c := make(Board, len(b))
	copy(c, b)
	return c
}

// Pos is a board coordinate.
type Pos struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// posKey packs a coordinate into a single int (cols/rows < 16). Used to
// index the small fixed-size posIndex array during move generation.
func posKey(x, y int) int { return (x << 4) | y }

// ---------- State ----------

// State carries the immutable per-game settings. cards live separately on
// Game so the search can hand around boards independently.
type State struct {
	Cols    int
	Rows    int
	Blocked []Pos
}

func (s *State) InBounds(x, y int) bool {
	return x >= 0 && y >= 0 && x < s.Cols && y < s.Rows
}

func (s *State) IsBlocked(x, y int) bool {
	for _, b := range s.Blocked {
		if b.X == x && b.Y == y {
			return true
		}
	}
	return false
}

// Game = a fully-loaded position ready to search.
type Game struct {
	State *State
	Board Board
	Turn  Side
}

// ---------- JSON parsing ----------

// jsonCard mirrors the shape produced by the web app's "Copy for CLI"
// button. location is "hand" (string) or {"x":n,"y":n} (object), so we
// receive it as RawMessage and try both decodings.
type jsonCard struct {
	ID       int             `json:"id"`
	Side     string          `json:"side"`
	Owner    string          `json:"owner"`
	Atk      int             `json:"atk"`
	Def      int             `json:"def"`
	Special  []string        `json:"special"`
	Location json.RawMessage `json:"location"`
}

type jsonState struct {
	Cards   []jsonCard `json:"cards"`
	Cols    int        `json:"cols"`
	Rows    int        `json:"rows"`
	Blocked []Pos      `json:"blocked"`
	Turn    string     `json:"turn"`
}

// ParseGame reads a game-state JSON document from r and validates it. The
// returned Game is ready to feed to BestMove.
func ParseGame(r io.Reader) (*Game, error) {
	var js jsonState
	if err := json.NewDecoder(r).Decode(&js); err != nil {
		return nil, fmt.Errorf("decode JSON: %w", err)
	}
	if js.Cols <= 0 || js.Rows <= 0 {
		return nil, errors.New("missing cols/rows")
	}
	if js.Turn == "" {
		return nil, errors.New("missing turn — pick who goes first in the web app first")
	}
	if len(js.Blocked) != 1 {
		return nil, errors.New("block exactly one square in the web app first")
	}
	g := &Game{State: &State{Cols: js.Cols, Rows: js.Rows, Blocked: js.Blocked}}
	turn, err := sideFromString(js.Turn)
	if err != nil {
		return nil, err
	}
	g.Turn = turn

	for _, jc := range js.Cards {
		side, err := sideFromString(jc.Side)
		if err != nil {
			return nil, err
		}
		owner, err := sideFromString(jc.Owner)
		if err != nil {
			return nil, err
		}
		var mask uint8
		for _, sp := range jc.Special {
			d, err := dirFromName(sp)
			if err != nil {
				return nil, err
			}
			mask |= 1 << uint8(d)
		}
		c := Card{
			ID: jc.ID, Side: side, Owner: owner,
			Atk: int8(jc.Atk), Def: int8(jc.Def), Special: mask,
		}
		// location: string "hand" OR object {x,y}
		var asStr string
		if err := json.Unmarshal(jc.Location, &asStr); err == nil {
			if asStr != "hand" {
				return nil, fmt.Errorf("invalid location string %q for card %d", asStr, jc.ID)
			}
		} else {
			var p Pos
			if err := json.Unmarshal(jc.Location, &p); err != nil {
				return nil, fmt.Errorf("invalid location for card %d: %v", jc.ID, err)
			}
			c.Placed = true
			c.X = int8(p.X)
			c.Y = int8(p.Y)
		}
		g.Board = append(g.Board, c)
	}
	return g, nil
}

// ---------- Indexes ----------

// Indexes are precomputed for the search root. They're shared across every
// expectimax recursion within one search, since every clone-and-replace
// preserves card-index positions in the slice.
type Indexes struct {
	IDIndex map[int]int // card.ID -> board slice index
}

func buildIndexes(b Board) *Indexes {
	idx := &Indexes{IDIndex: make(map[int]int, len(b))}
	for i, c := range b {
		idx.IDIndex[c.ID] = i
	}
	return idx
}

// posIndex maps posKey(x,y) -> card index in the board (or -1).
type posIndex [256]int

func buildPosIndex(b Board) posIndex {
	var p posIndex
	for i := range p {
		p[i] = -1
	}
	for i, c := range b {
		if c.Placed {
			p[posKey(int(c.X), int(c.Y))] = i
		}
	}
	return p
}

// ---------- Eval / move-list helpers ----------

func emptySquares(s *State, b Board) []Pos {
	var occupied [256]bool
	for _, c := range b {
		if c.Placed {
			occupied[posKey(int(c.X), int(c.Y))] = true
		}
	}
	out := make([]Pos, 0, s.Cols*s.Rows)
	for y := 0; y < s.Rows; y++ {
		for x := 0; x < s.Cols; x++ {
			if s.IsBlocked(x, y) {
				continue
			}
			if occupied[posKey(x, y)] {
				continue
			}
			out = append(out, Pos{x, y})
		}
	}
	return out
}

func staticScore(b Board) int {
	blue, red := 0, 0
	for _, c := range b {
		if !c.Placed {
			continue
		}
		if c.Owner == SideBlue {
			blue++
		} else {
			red++
		}
	}
	return blue - red
}

func gameOver(s *State, b Board) bool {
	placed := 0
	blueHand := 0
	redHand := 0
	for _, c := range b {
		if c.Placed {
			placed++
		} else if c.Side == SideBlue {
			blueHand++
		} else {
			redHand++
		}
	}
	playable := s.Cols*s.Rows - len(s.Blocked)
	if placed >= playable {
		return true
	}
	return blueHand == 0 && redHand == 0
}

// ---------- Move generation ----------

// moveOutcomes returns every outcome board produced by placing card at (x,y)
// for `side`. Each chance battle (tie or special-clash) doubles the branch
// count. Outcomes never share underlying memory with the input board.
//
// `idx` (id->index) is shared across the whole search; `pos` is the
// pre-built posIndex for `b` from the caller.
func moveOutcomes(s *State, idx *Indexes, pos *posIndex, card *Card, x, y int, side Side, b Board) []Board {
	base := b.Clone()
	cardIdx := idx.IDIndex[card.ID]
	base[cardIdx].Owner = side
	base[cardIdx].Placed = true
	base[cardIdx].X = int8(x)
	base[cardIdx].Y = int8(y)
	placed := base[cardIdx]

	var certainIdxs, chanceIdxs [8]int
	var nCertain, nChance int

	for d := Dir(0); d < 8; d++ {
		nx := x + int(dirOffsets[d][0])
		ny := y + int(dirOffsets[d][1])
		if !s.InBounds(nx, ny) {
			continue
		}
		ti := pos[posKey(nx, ny)]
		if ti < 0 || ti == cardIdx {
			continue
		}
		t := &base[ti]
		if t.Owner == side {
			continue
		}
		aSpec := placed.HasSpecial(d)
		dCounter := t.HasSpecial(oppDir[d])
		if isOrthoDir(d) {
			switch {
			case aSpec && dCounter:
				chanceIdxs[nChance] = ti
				nChance++
			case aSpec:
				certainIdxs[nCertain] = ti
				nCertain++
			case dCounter:
				// defender's same-direction-back special wins outright
			case placed.Atk > t.Def:
				certainIdxs[nCertain] = ti
				nCertain++
			case placed.Atk == t.Def:
				chanceIdxs[nChance] = ti
				nChance++
			}
		} else {
			if !aSpec {
				continue
			}
			if dCounter {
				chanceIdxs[nChance] = ti
				nChance++
			} else {
				certainIdxs[nCertain] = ti
				nCertain++
			}
		}
	}
	for i := 0; i < nCertain; i++ {
		base[certainIdxs[i]].Owner = side
	}
	if nChance == 0 {
		return []Board{base}
	}

	out := make([]Board, 0, 1<<nChance)
	for mask := 0; mask < (1 << nChance); mask++ {
		bb := base.Clone()
		for i := 0; i < nChance; i++ {
			if mask&(1<<i) != 0 {
				bb[chanceIdxs[i]].Owner = side
			}
		}
		out = append(out, bb)
	}
	return out
}

// ---------- Zobrist hashing for the TT ----------

// ZobristTable maps (cardID, owner, posKey) → 64-bit random, plus a single
// number for "side-to-play is red". Hashing a board is XORing in one entry
// per placed card.
type ZobristTable struct {
	cardOwnerPos [][2][256]uint64 // cardID -> [owner][posKey]uint64
	redToPlay    uint64
}

func newZobristTable(maxCardID int) *ZobristTable {
	rng := rand.New(rand.NewSource(0xC0FFEE))
	t := &ZobristTable{cardOwnerPos: make([][2][256]uint64, maxCardID+1)}
	for id := 0; id <= maxCardID; id++ {
		for o := 0; o < 2; o++ {
			for pk := 0; pk < 256; pk++ {
				t.cardOwnerPos[id][o][pk] = rng.Uint64()
			}
		}
	}
	t.redToPlay = rng.Uint64()
	return t
}

func (z *ZobristTable) Hash(b Board, sideToPlay Side) uint64 {
	var h uint64
	for _, c := range b {
		if c.Placed {
			h ^= z.cardOwnerPos[c.ID][c.Owner][posKey(int(c.X), int(c.Y))]
		}
	}
	if sideToPlay == SideRed {
		h ^= z.redToPlay
	}
	return h
}

// ---------- TT ----------

const (
	flagExact int8 = 0
	flagLower int8 = 1
	flagUpper int8 = 2
)

type ttEntry struct {
	Depth int8
	Value int8
	Flag  int8
}

// ---------- Search context ----------

type budgetExceededErr struct{}

func (budgetExceededErr) Error() string { return "search budget exceeded" }

var errBudget = budgetExceededErr{}

const (
	scoreMin = -32 // generous min for our 12-cell game
	scoreMax = 32
)

// ttMaxEntries caps the transposition table at ~50M entries before FIFO
// eviction kicks in. At ~32 bytes per Map entry on 64-bit Go that's about
// 1.5GB worst-case — fine for a Mac, kicks in only on pathological searches.
const (
	ttMaxEntries = 50_000_000
	ttEvictBatch = ttMaxEntries / 4
)

type searchCtx struct {
	State     *State
	Indexes   *Indexes
	Zobrist   *ZobristTable
	TT        map[uint64]ttEntry
	UserSide  Side
	NodeCount int64
	Deadline  time.Time
	HasBudget bool
	// FIFO queue of TT keys for eviction. Ordered by insertion, so the
	// first len(ttEvictBatch) keys are the oldest.
	ttOrder []uint64
}

func (ctx *searchCtx) ttPut(key uint64, e ttEntry) {
	if len(ctx.TT) >= ttMaxEntries {
		// Evict oldest 25%.
		for i := 0; i < ttEvictBatch && i < len(ctx.ttOrder); i++ {
			delete(ctx.TT, ctx.ttOrder[i])
		}
		ctx.ttOrder = ctx.ttOrder[ttEvictBatch:]
	}
	if _, exists := ctx.TT[key]; !exists {
		ctx.ttOrder = append(ctx.ttOrder, key)
	}
	ctx.TT[key] = e
}

// expectimaxAB is the workhorse — pessimistic minimax with α-β pruning.
// `userSide` is fixed at the root; chance combination is min when userSide
// is blue, max when red. Both layers (chance and side-to-play) participate
// in α-β.
func (ctx *searchCtx) expectimaxAB(b Board, sideToPlay Side, depth int, alpha, beta int) int {
	ctx.NodeCount++
	if ctx.HasBudget && (ctx.NodeCount&0xFFF) == 0 && time.Now().After(ctx.Deadline) {
		panic(errBudget)
	}
	if depth == 0 || gameOver(ctx.State, b) {
		return staticScore(b)
	}

	useTT := depth >= 2
	var key uint64
	if useTT {
		key = ctx.Zobrist.Hash(b, sideToPlay)
		if hit, ok := ctx.TT[key]; ok && int(hit.Depth) >= depth {
			switch hit.Flag {
			case flagExact:
				return int(hit.Value)
			case flagLower:
				if int(hit.Value) >= beta {
					return int(hit.Value)
				}
			case flagUpper:
				if int(hit.Value) <= alpha {
					return int(hit.Value)
				}
			}
		}
	}

	// Inline hand-side counting — we want both myHand and otherSide.
	myHand := 0
	otherSide := Side(-1)
	for _, c := range b {
		if c.Placed {
			continue
		}
		if c.Side == sideToPlay {
			myHand++
		} else if otherSide == -1 {
			otherSide = c.Side
		}
	}
	if myHand == 0 {
		if otherSide == -1 {
			return staticScore(b)
		}
		return ctx.expectimaxAB(b, otherSide, depth, alpha, beta)
	}
	empties := emptySquares(ctx.State, b)
	if len(empties) == 0 {
		return staticScore(b)
	}

	pos := buildPosIndex(b)
	next := sideToPlay.Other()
	isMax := sideToPlay == SideBlue
	origAlpha, origBeta := alpha, beta

	var best int
	if isMax {
		best = scoreMin - 1
	} else {
		best = scoreMax + 1
	}

cardLoop:
	for ci := range b {
		if b[ci].Placed || b[ci].Side != sideToPlay {
			continue
		}
		for _, e := range empties {
			outs := moveOutcomes(ctx.State, ctx.Indexes, &pos, &b[ci], e.X, e.Y, sideToPlay, b)

			var mv int
			switch {
			case len(outs) == 1:
				mv = ctx.expectimaxAB(outs[0], next, depth-1, alpha, beta)
			case ctx.UserSide == SideBlue:
				// chance is min — cut when partial-min ≤ alpha
				mv = scoreMax + 1
				for _, o := range outs {
					cv := ctx.expectimaxAB(o, next, depth-1, alpha, beta)
					if cv < mv {
						mv = cv
					}
					if mv <= alpha {
						break
					}
				}
			default:
				// chance is max — cut when partial-max ≥ beta
				mv = scoreMin - 1
				for _, o := range outs {
					cv := ctx.expectimaxAB(o, next, depth-1, alpha, beta)
					if cv > mv {
						mv = cv
					}
					if mv >= beta {
						break
					}
				}
			}

			if isMax {
				if mv > best {
					best = mv
				}
				if best > alpha {
					alpha = best
				}
			} else {
				if mv < best {
					best = mv
				}
				if best < beta {
					beta = best
				}
			}
			if alpha >= beta {
				break cardLoop
			}
		}
	}

	if useTT {
		flag := flagExact
		if best <= origAlpha {
			flag = flagUpper
		} else if best >= origBeta {
			flag = flagLower
		}
		ctx.ttPut(key, ttEntry{Depth: int8(depth), Value: int8(best), Flag: flag})
	}
	return best
}

// ---------- Root search ----------

// Move is the result of BestMove — what the user should play.
type Move struct {
	CardID  int
	X, Y    int
	Score   int   // from the user's perspective
	ExpGain int   // worst-case (placement + flips) for this move
	Card    *Card // for printing convenience
}

// SearchResult bundles the move with telemetry.
type SearchResult struct {
	Move        Move
	SearchDepth int   // deepest depth that fully completed
	Nodes       int64 // total across all iterative-deepening passes
	Elapsed     time.Duration
	TTSize      int
}

// BestMove runs iterative-deepening search up to maxDepth, returning the
// deepest fully-completed result. If a budget is configured and a depth
// can't finish, the previous depth's result is returned.
func (g *Game) BestMove(maxDepth int, budget time.Duration) (*SearchResult, error) {
	if g.Turn == 0 && g.Turn != SideBlue { // sanity
		return nil, errors.New("turn unset")
	}
	maxID := 0
	for _, c := range g.Board {
		if c.ID > maxID {
			maxID = c.ID
		}
	}
	z := newZobristTable(maxID)
	idx := buildIndexes(g.Board)

	t0 := time.Now()
	ctx := &searchCtx{
		State:    g.State,
		Indexes:  idx,
		Zobrist:  z,
		TT:       make(map[uint64]ttEntry, 1<<14),
		UserSide: g.Turn,
	}
	if budget > 0 {
		ctx.Deadline = t0.Add(budget)
		ctx.HasBudget = true
	}

	var best *Move
	achieved := 0
	for d := 1; d <= maxDepth; d++ {
		if ctx.HasBudget && time.Now().After(ctx.Deadline) {
			break
		}
		var deepRecover any
		var result *Move
		func() {
			defer func() {
				if r := recover(); r != nil {
					deepRecover = r
				}
			}()
			result = g.searchRoot(ctx, d)
		}()
		if deepRecover != nil {
			if _, ok := deepRecover.(budgetExceededErr); ok {
				break
			}
			panic(deepRecover) // propagate other panics
		}
		if result != nil {
			best = result
			achieved = d
		}
	}
	if best == nil {
		return nil, errors.New("no legal moves found")
	}
	// Attach the original card pointer for convenient printing.
	for i := range g.Board {
		if g.Board[i].ID == best.CardID {
			c := g.Board[i]
			best.Card = &c
			break
		}
	}
	return &SearchResult{
		Move:        *best,
		SearchDepth: achieved,
		Nodes:       ctx.NodeCount,
		Elapsed:     time.Since(t0),
		TTSize:      len(ctx.TT),
	}, nil
}

// searchRoot picks the best (card, square) for the side-to-play at this depth.
func (g *Game) searchRoot(ctx *searchCtx, depth int) *Move {
	side := g.Turn
	next := side.Other()
	isMax := side == SideBlue
	pos := buildPosIndex(g.Board)
	empties := emptySquares(g.State, g.Board)

	baseMy := 0
	for _, c := range g.Board {
		if c.Placed && c.Owner == side {
			baseMy++
		}
	}

	alpha := scoreMin - 1
	beta := scoreMax + 1
	var bestMove *Move
	for ci := range g.Board {
		if g.Board[ci].Placed || g.Board[ci].Side != side {
			continue
		}
		for _, e := range empties {
			outs := moveOutcomes(g.State, ctx.Indexes, &pos, &g.Board[ci], e.X, e.Y, side, g.Board)

			// Worst-case immediate (placement + flips) for tiebreaking.
			immediate := 1 << 30
			for _, o := range outs {
				mine := 0
				for _, c := range o {
					if c.Placed && c.Owner == side {
						mine++
					}
				}
				delta := mine - baseMy
				if delta < immediate {
					immediate = delta
				}
			}

			var mv int
			switch {
			case len(outs) == 1:
				mv = ctx.expectimaxAB(outs[0], next, depth-1, alpha, beta)
			case side == SideBlue:
				mv = scoreMax + 1
				for _, o := range outs {
					cv := ctx.expectimaxAB(o, next, depth-1, alpha, beta)
					if cv < mv {
						mv = cv
					}
					if mv <= alpha {
						break
					}
				}
			default:
				mv = scoreMin - 1
				for _, o := range outs {
					cv := ctx.expectimaxAB(o, next, depth-1, alpha, beta)
					if cv > mv {
						mv = cv
					}
					if mv >= beta {
						break
					}
				}
			}

			sideEv := mv
			if !isMax {
				sideEv = -sideEv
			}
			if bestMove == nil ||
				sideEv > bestMove.Score ||
				(sideEv == bestMove.Score && immediate > bestMove.ExpGain) {
				m := Move{
					CardID:  g.Board[ci].ID,
					X:       e.X,
					Y:       e.Y,
					Score:   sideEv,
					ExpGain: immediate,
				}
				bestMove = &m
			}
			if isMax {
				if mv > alpha {
					alpha = mv
				}
			} else {
				if mv < beta {
					beta = mv
				}
			}
		}
	}
	return bestMove
}
