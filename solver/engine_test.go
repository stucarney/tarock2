// Tests for the Go solver engine — ported from engine.test.js to verify
// the Go port computes the same combat outcomes and search scores as the
// JS version. Not exhaustive (the JS suite is the canonical reference);
// these are the cases most sensitive to porting bugs.
package main

import (
	"strings"
	"testing"
	"time"
)

// ---------- Setup helpers ----------

func freshState() *State {
	return &State{Cols: 4, Rows: 3, Blocked: []Pos{{X: 3, Y: 2}}}
}

type cardSpec struct {
	id      int
	side    Side
	atk     int
	def     int
	special []Dir
	placed  bool
	x, y    int
}

func mkCard(spec cardSpec) Card {
	var mask uint8
	for _, d := range spec.special {
		mask |= 1 << uint8(d)
	}
	return Card{
		ID: spec.id, Side: spec.side, Owner: spec.side,
		Atk: int8(spec.atk), Def: int8(spec.def), Special: mask,
		Placed: spec.placed, X: int8(spec.x), Y: int8(spec.y),
	}
}

func mkBoard(cards ...cardSpec) Board {
	b := make(Board, 0, len(cards))
	for _, c := range cards {
		b = append(b, mkCard(c))
	}
	return b
}

// classifyOne places `attacker` at (1,1) facing the given defenders; returns
// the certain/chance verdict for the first defender that produced an outcome.
func classifyOne(t *testing.T, attacker cardSpec, defs ...cardSpec) (gotResult bool, certain bool, isChance bool) {
	t.Helper()
	state := freshState()
	attacker.id = 1
	attacker.placed = false
	board := []cardSpec{attacker}
	for i, d := range defs {
		d.id = i + 2
		d.placed = true
		board = append(board, d)
	}
	b := mkBoard(board...)
	idx := buildIndexes(b)
	pos := buildPosIndex(b)
	cardCopy := b[idx.IDIndex[1]]
	outs := moveOutcomes(state, idx, &pos, &cardCopy, 1, 1, attacker.side, b)
	switch len(outs) {
	case 1:
		// All "certain or no-battle". Distinguish by whether any defender flipped.
		for i := 1; i < len(outs[0]); i++ {
			if outs[0][i].Owner != b[i].Owner {
				return true, true, false
			}
		}
		return false, false, false // no flips at all
	default:
		return true, false, true // multi-outcome → chance
	}
}

// ---------- Combat resolution ----------

func TestCombat_OrthoAtkBeatsDef(t *testing.T) {
	got, certain, _ := classifyOne(t,
		cardSpec{side: SideBlue, atk: 5},
		cardSpec{side: SideRed, def: 3, x: 2, y: 1},
	)
	if !got || !certain {
		t.Fatalf("expected certain capture, got got=%v certain=%v", got, certain)
	}
}

func TestCombat_OrthoAtkLosesToDef(t *testing.T) {
	got, _, _ := classifyOne(t,
		cardSpec{side: SideBlue, atk: 1},
		cardSpec{side: SideRed, def: 5, x: 2, y: 1},
	)
	if got {
		t.Fatal("expected no battle (defender wins by stats)")
	}
}

func TestCombat_OrthoTieIsChance(t *testing.T) {
	got, _, chance := classifyOne(t,
		cardSpec{side: SideBlue, atk: 3},
		cardSpec{side: SideRed, def: 3, x: 2, y: 1},
	)
	if !got || !chance {
		t.Fatal("expected chance capture for tie")
	}
}

func TestCombat_AttackerSpecialAutoWins(t *testing.T) {
	got, certain, _ := classifyOne(t,
		cardSpec{side: SideBlue, atk: 0, special: []Dir{DirRight}},
		cardSpec{side: SideRed, def: 9, x: 2, y: 1},
	)
	if !got || !certain {
		t.Fatal("expected certain capture via special-win")
	}
}

func TestCombat_DefenderSameDirBackBlocksRegular(t *testing.T) {
	// Attacker at (1,1) attacks right toward (2,1). Defender's "left"
	// arrow points back at attacker.
	got, _, _ := classifyOne(t,
		cardSpec{side: SideBlue, atk: 9},
		cardSpec{side: SideRed, def: 0, special: []Dir{DirLeft}, x: 2, y: 1},
	)
	if got {
		t.Fatal("expected no battle — defender's same-direction-back special wins outright")
	}
}

func TestCombat_DefenderOtherDirSpecialDoesNotHelp(t *testing.T) {
	// Defender's "right" points away from attacker; should not block normal stats win.
	got, certain, _ := classifyOne(t,
		cardSpec{side: SideBlue, atk: 5},
		cardSpec{side: SideRed, def: 3, special: []Dir{DirRight}, x: 2, y: 1},
	)
	if !got || !certain {
		t.Fatal("expected normal certain capture; defender's away-pointing special should not protect")
	}
}

func TestCombat_AttackerSpecialPlusDefenderCounterIsClash(t *testing.T) {
	got, _, chance := classifyOne(t,
		cardSpec{side: SideBlue, special: []Dir{DirRight}},
		cardSpec{side: SideRed, special: []Dir{DirLeft}, x: 2, y: 1},
	)
	if !got || !chance {
		t.Fatal("expected chance (special-clash)")
	}
}

func TestCombat_DiagonalNoSpecialNoBattle(t *testing.T) {
	got, _, _ := classifyOne(t,
		cardSpec{side: SideBlue, atk: 9},
		cardSpec{side: SideRed, def: 0, x: 2, y: 0}, // upRight diagonal
	)
	if got {
		t.Fatal("expected no diagonal battle without attacker special")
	}
}

func TestCombat_DiagonalAttackerSpecialAutoWins(t *testing.T) {
	got, certain, _ := classifyOne(t,
		cardSpec{side: SideBlue, special: []Dir{DirUpRight}},
		cardSpec{side: SideRed, def: 9, x: 2, y: 0},
	)
	if !got || !certain {
		t.Fatal("expected certain diagonal special-win")
	}
}

func TestCombat_DiagonalSpecialClash(t *testing.T) {
	got, _, chance := classifyOne(t,
		cardSpec{side: SideBlue, special: []Dir{DirUpRight}},
		cardSpec{side: SideRed, special: []Dir{DirDownLeft}, x: 2, y: 0},
	)
	if !got || !chance {
		t.Fatal("expected chance (diagonal special-clash)")
	}
}

// ---------- Move-outcome shape ----------

func TestMoveOutcomes_TwoTiesYieldFourBranches(t *testing.T) {
	state := freshState()
	b := mkBoard(
		cardSpec{id: 1, side: SideBlue, atk: 3},
		cardSpec{id: 2, side: SideRed, def: 3, placed: true, x: 0, y: 1},
		cardSpec{id: 3, side: SideRed, def: 3, placed: true, x: 2, y: 1},
	)
	idx := buildIndexes(b)
	pos := buildPosIndex(b)
	cardCopy := b[idx.IDIndex[1]]
	outs := moveOutcomes(state, idx, &pos, &cardCopy, 1, 1, SideBlue, b)
	if len(outs) != 4 {
		t.Fatalf("expected 4 chance outcomes, got %d", len(outs))
	}
	// Every {leftFlipped, rightFlipped} combination should appear once.
	seen := map[[2]bool]bool{}
	for _, o := range outs {
		l := o[idx.IDIndex[2]].Owner == SideBlue
		r := o[idx.IDIndex[3]].Owner == SideBlue
		seen[[2]bool{l, r}] = true
	}
	if len(seen) != 4 {
		t.Fatalf("expected all 4 flip combinations, got %d distinct", len(seen))
	}
}

// ---------- Pessimistic search ----------

func TestBestMove_PrefersGuaranteedFlipOverTie(t *testing.T) {
	// Mirror engine.test.js's pessimism test:
	//  - Red ties (def=3) at (1,0) and (1,1)
	//  - Red beatable certainly at (3,1) (def=2)
	//  - Blue card has atk=3
	game := &Game{
		State: freshState(),
		Turn:  SideBlue,
		Board: mkBoard(
			cardSpec{id: 1, side: SideBlue, atk: 3},
			cardSpec{id: 2, side: SideRed, def: 3, placed: true, x: 1, y: 0},
			cardSpec{id: 3, side: SideRed, def: 3, placed: true, x: 1, y: 1},
			cardSpec{id: 4, side: SideRed, def: 2, placed: true, x: 3, y: 1},
		),
	}
	res, err := game.BestMove(1, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Pessimistic: ties don't flip, so best score = +0 (1 placed + 1 flip vs 3-1=2 reds).
	if res.Move.Score != 0 {
		t.Errorf("expected score 0 (pessimistic), got %d", res.Move.Score)
	}
	if res.Move.ExpGain != 2 {
		t.Errorf("expected expGain 2 (placement + 1 flip), got %d", res.Move.ExpGain)
	}
	// Should pick a square adjacent to the (3,1) certain target.
	good := []Pos{{X: 3, Y: 0}, {X: 2, Y: 1}}
	hit := false
	for _, p := range good {
		if res.Move.X == p.X && res.Move.Y == p.Y {
			hit = true
		}
	}
	if !hit {
		t.Errorf("expected best move adjacent to (3,1); got (%d,%d)", res.Move.X, res.Move.Y)
	}
}

func TestBestMove_DepthCompletesOnSimplePosition(t *testing.T) {
	// One blue, one red placed, atk=5 vs def=1: forced flip.
	game := &Game{
		State: freshState(),
		Turn:  SideBlue,
		Board: mkBoard(
			cardSpec{id: 1, side: SideBlue, atk: 5},
			cardSpec{id: 2, side: SideRed, def: 1, placed: true, x: 1, y: 0},
		),
	}
	res, err := game.BestMove(2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Move.Score != 2 {
		t.Errorf("expected score 2, got %d", res.Move.Score)
	}
}

// ---------- JSON parser ----------

func TestParseGame_AcceptsWebAppShape(t *testing.T) {
	js := `{
		"cards": [
			{"id":1,"side":"blue","owner":"blue","atk":5,"def":3,"special":["right"],"location":"hand"},
			{"id":2,"side":"red","owner":"red","atk":0,"def":1,"special":[],"location":{"x":1,"y":0}}
		],
		"cols": 4, "rows": 3, "blocked": [{"x":0,"y":2}], "turn": "blue"
	}`
	g, err := ParseGame(strings.NewReader(js))
	if err != nil {
		t.Fatal(err)
	}
	if g.Turn != SideBlue {
		t.Errorf("expected blue turn, got %v", g.Turn)
	}
	if len(g.Board) != 2 {
		t.Fatalf("expected 2 cards, got %d", len(g.Board))
	}
	if g.Board[0].Placed {
		t.Error("card 1 should be in hand")
	}
	if !g.Board[1].Placed || g.Board[1].X != 1 || g.Board[1].Y != 0 {
		t.Error("card 2 should be at (1,0)")
	}
	if !g.Board[0].HasSpecial(DirRight) {
		t.Error("card 1 should have right-special")
	}
}

func TestParseGame_RejectsMissingBlock(t *testing.T) {
	js := `{"cards":[],"cols":4,"rows":3,"blocked":[],"turn":"blue"}`
	if _, err := ParseGame(strings.NewReader(js)); err == nil {
		t.Fatal("expected error for missing blocked square")
	}
}

// ---------- Budget / iterative deepening ----------

func TestBestMove_BudgetReturnsShallowResult(t *testing.T) {
	game := &Game{
		State: freshState(),
		Turn:  SideBlue,
		Board: mkBoard(
			cardSpec{id: 1, side: SideBlue, atk: 5},
			cardSpec{id: 2, side: SideRed, def: 1, placed: true, x: 1, y: 0},
		),
	}
	// Tiny budget — should still complete depth 1 quickly given the trivial position.
	res, err := game.BestMove(11, 1*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if res.SearchDepth < 1 {
		t.Fatalf("expected at least depth 1, got %d", res.SearchDepth)
	}
}
