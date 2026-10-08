package score

import "testing"

func TestEvaluatorClassify(t *testing.T) {
	got := (Evaluator{Limit: 10}).Classify(10)
	if got != "high" {
		t.Fatalf("Classify() = %q, want high", got)
	}
}
