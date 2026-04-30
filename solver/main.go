// tarock-solve — terminal-side helper for the web app.
//
// Usage:
//
//	pbpaste | go run ./solver
//	go run ./solver --state '{...}'
//	go run ./solver --max-time 5m
//
// Reads the JSON game-state produced by the web app's "Copy for CLI" button,
// always solves to depth 11 (the full game tree from any position), and
// prints the recommended move plus diagnostics. No iterative-deepening
// fallback by default — if you want a softer cap, pass --max-time so the
// budget kicks in and the deepest fully-completed depth is returned.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

const targetDepth = 11

func main() {
	stateFlag := flag.String("state", "", "Game state JSON (overrides stdin)")
	maxTime := flag.Duration("max-time", 0, "Soft wall-clock cap; 0 means no cap (Ctrl+C to stop)")
	flag.Parse()

	var src io.Reader
	if *stateFlag != "" {
		src = strings.NewReader(*stateFlag)
	} else {
		// Detect a non-TTY stdin and read it; otherwise prompt the user.
		fi, _ := os.Stdin.Stat()
		if fi != nil && (fi.Mode()&os.ModeCharDevice) == 0 {
			src = os.Stdin
		} else {
			fmt.Fprintln(os.Stderr, "tarock-solve: paste game state JSON on stdin, or pass --state '...'")
			fmt.Fprintln(os.Stderr, "  (in the web app, click 📋 Copy for CLI, then run: pbpaste | tarock-solve)")
			os.Exit(2)
		}
	}

	game, err := ParseGame(src)
	if err != nil {
		fmt.Fprintln(os.Stderr, "tarock-solve: parse error:", err)
		os.Exit(2)
	}

	fmt.Printf("Solving for %s, depth %d… (Ctrl+C to abort)\n", game.Turn, targetDepth)
	res, err := game.BestMove(targetDepth, *maxTime)
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

	depthLabel := fmt.Sprintf("%d-ply", res.SearchDepth)
	if res.SearchDepth < targetDepth {
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
