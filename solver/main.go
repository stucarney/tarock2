// tarock-solve — terminal-side helper for the web app.
//
// Usage:
//
//	pbpaste | go run ./solver
//	go run ./solver --state '{...}'
//	go run ./solver --max-time 5m
//	go run ./solver --parallel 1   # single-threaded (with iterative deepening)
//
// Reads the JSON game-state produced by the web app's "Copy for CLI" button,
// always solves to depth 11 (the full game tree from any position), and
// prints the recommended move plus diagnostics.
//
// The default search is root-parallel across all CPU cores: each worker
// takes a slice of (card, square) root moves, has its own transposition
// table, and shares an atomic α-β bound so cuts from one worker tighten
// the windows of the others. If you want the older single-threaded
// iterative-deepening behavior (slower but deterministic), pass
// `--parallel 1`.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"
)

const targetDepth = 11

func main() {
	stateFlag := flag.String("state", "", "Game state JSON (overrides stdin)")
	maxTime := flag.Duration("max-time", 0, "Soft wall-clock cap; 0 means no cap (Ctrl+C to stop)")
	parallel := flag.Int("parallel", runtime.NumCPU(), "Number of worker goroutines (1 = single-threaded with iterative deepening)")
	flag.Parse()

	// Accept the JSON state in three ways, in priority order:
	//   1. positional arg (the form the web app's "Copy for CLI" emits)
	//   2. --state '...' flag
	//   3. stdin (e.g. `pbpaste | tarock-solve`)
	var src io.Reader
	switch {
	case flag.NArg() >= 1:
		src = strings.NewReader(flag.Arg(0))
	case *stateFlag != "":
		src = strings.NewReader(*stateFlag)
	default:
		fi, _ := os.Stdin.Stat()
		if fi != nil && (fi.Mode()&os.ModeCharDevice) == 0 {
			src = os.Stdin
		} else {
			fmt.Fprintln(os.Stderr, "tarock-solve: pass JSON as the first arg, or via --state, or pipe it on stdin")
			fmt.Fprintln(os.Stderr, "  (in the web app, click 📋 Copy for CLI — it puts a ready-to-paste command on your clipboard)")
			os.Exit(2)
		}
	}

	game, err := ParseGame(src)
	if err != nil {
		fmt.Fprintln(os.Stderr, "tarock-solve: parse error:", err)
		os.Exit(2)
	}

	mode := fmt.Sprintf("parallel × %d", *parallel)
	if *parallel == 1 {
		mode = "single-threaded (iter. deepening)"
	}
	fmt.Printf("Solving for %s, depth %d, %s… (Ctrl+C to abort)\n", game.Turn, targetDepth, mode)
	var res *SearchResult
	if *parallel == 1 {
		res, err = game.BestMove(targetDepth, *maxTime)
	} else {
		res, err = game.BestMoveParallel(targetDepth, *maxTime, *parallel)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "tarock-solve:", err)
		os.Exit(1)
	}

	c := res.Move.Card
	specials := ""
	if c != nil && c.Special != 0 {
		var sb strings.Builder
		sb.WriteString(" ✦")
		for d := Dir(0); d < 8; d++ {
			if c.HasSpecial(d) {
				sb.WriteString(dirNames[d])
				sb.WriteByte(' ')
			}
		}
		specials = strings.TrimRight(sb.String(), " ")
	}

	depthLabel := fmt.Sprintf("%d-ply", targetDepth)
	if res.SearchDepth < 0 {
		depthLabel = fmt.Sprintf("partial %d-ply (budget reached, partial root coverage)", targetDepth)
	} else if res.SearchDepth < targetDepth {
		depthLabel = fmt.Sprintf("%d/%d-ply (budget reached)", res.SearchDepth, targetDepth)
	}

	sign := "+"
	if res.Move.Score < 0 {
		sign = ""
	}

	fmt.Println()
	fmt.Printf("Best move: ⚔%d/🛡%d%s → row %d, col %d\n",
		c.Atk, c.Def, specials, res.Move.Y+1, res.Move.X+1)
	fmt.Printf("Worst-case lead after %s: %s%d (guaranteed flips: %d)\n",
		depthLabel, sign, res.Move.Score, res.Move.ExpGain)
	fmt.Printf("Searched %s in %s · TT size %s\n",
		humanInt(res.Nodes), formatDuration(res.Elapsed), humanInt(int64(res.TTSize)))
}

func formatDuration(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	if d < time.Minute {
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
	m := int(d / time.Minute)
	s := d - time.Duration(m)*time.Minute
	return fmt.Sprintf("%dm%ds", m, int(s.Seconds()))
}

func humanInt(n int64) string {
	s := fmt.Sprintf("%d", n)
	// Insert thousands separators.
	if len(s) <= 3 {
		return s
	}
	out := make([]byte, 0, len(s)+len(s)/3)
	prefix := len(s) % 3
	if prefix > 0 {
		out = append(out, s[:prefix]...)
	}
	for i := prefix; i < len(s); i += 3 {
		if len(out) > 0 {
			out = append(out, ',')
		}
		out = append(out, s[i:i+3]...)
	}
	return string(out)
}
