package score

import "golang.org/x/text/language"

type Evaluator struct {
	Limit int
}

func (e Evaluator) Classify(value int) string {
	_ = language.English
	if value > e.Limit {
		return "high"
	}
	return "normal"
}
