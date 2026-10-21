package sim_test

// This file has no build tag: the check of the harness's vitest report is
// unit tested by `make test`, while the driver that uses it
// (simulation_test.go) needs the `sim` tag.

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// knownSuites are the suites VAULT_SYNC_SIM_SUITES may select; a full run
// (the variable unset or empty) runs all of them. They mirror the default
// of plugin/vitest.sim.config.ts.
var knownSuites = []string{"seeds", "retention", "members", "regressions", "scenarios", "determinism"}

// vitestReport is the part of vitest's JSON report the driver checks.
type vitestReport struct {
	NumTotalTests  int          `json:"numTotalTests"`
	NumPassedTests int          `json:"numPassedTests"`
	TestResults    []vitestFile `json:"testResults"`
}

// vitestFile is one test file of a vitestReport.
type vitestFile struct {
	Name             string            `json:"name"`
	AssertionResults []vitestAssertion `json:"assertionResults"`
}

// vitestAssertion is one test of a vitestReport.
type vitestAssertion struct {
	AncestorTitles []string `json:"ancestorTitles"`
	FullName       string   `json:"fullName"`
	Status         string   `json:"status"`
}

// checkSuiteRun checks a report of a run that passed, for the value of
// VAULT_SYNC_SIM_SUITES. A full run (selected empty) must run and pass every
// test, none skipped, so no suite or committed regression case is ever
// skipped silently. A run of a subset of the suites skips the others on
// purpose (#393): it must name only known suites and pass at least one test,
// and a test may be skipped only together with every other test of its
// top-level describe block, as an unselected suite is. A skip inside a
// selected suite still fails the run.
func checkSuiteRun(report vitestReport, selected string) error {
	if report.NumTotalTests == 0 {
		return errors.New("the simulation suite ran no tests")
	}

	selected = strings.TrimSpace(selected)
	if selected == "" {
		if report.NumPassedTests != report.NumTotalTests {
			return fmt.Errorf("every simulation test must run and pass, none skipped: %d of %d passed; not passed: %s",
				report.NumPassedTests, report.NumTotalTests, strings.Join(notPassed(report), "; "))
		}

		return nil
	}

	for suite := range strings.SplitSeq(selected, ",") {
		if !slices.Contains(knownSuites, suite) {
			return fmt.Errorf("VAULT_SYNC_SIM_SUITES=%q names unknown suite %q (the suites are %s)", selected, suite, strings.Join(knownSuites, ", "))
		}
	}

	if report.NumPassedTests == 0 {
		return fmt.Errorf("the simulation suites %q ran no tests", selected)
	}

	// A block is the file plus the top-level describe; a block with a passed
	// test was selected, so none of its tests may be skipped.
	type block struct{ file, describe string }

	selectedBlocks := map[block]bool{}

	for _, file := range report.TestResults {
		for _, assertion := range file.AssertionResults {
			if assertion.Status == "passed" {
				selectedBlocks[block{file.Name, topLevel(assertion)}] = true
			}
		}
	}

	var problems []string

	for _, file := range report.TestResults {
		for _, assertion := range file.AssertionResults {
			switch {
			case assertion.Status == "passed":
			case assertion.Status != "skipped":
				problems = append(problems, fmt.Sprintf("%s (%s)", assertion.FullName, assertion.Status))
			case selectedBlocks[block{file.Name, topLevel(assertion)}]:
				problems = append(problems, assertion.FullName+" (skipped in a selected suite)")
			}
		}
	}

	if len(problems) > 0 {
		return fmt.Errorf("every test of the selected simulation suites %q must run and pass: %s", selected, strings.Join(problems, "; "))
	}

	return nil
}

func topLevel(assertion vitestAssertion) string {
	if len(assertion.AncestorTitles) == 0 {
		return ""
	}

	return assertion.AncestorTitles[0]
}

func notPassed(report vitestReport) []string {
	var names []string

	for _, file := range report.TestResults {
		for _, assertion := range file.AssertionResults {
			if assertion.Status != "passed" {
				names = append(names, fmt.Sprintf("%s (%s)", assertion.FullName, assertion.Status))
			}
		}
	}

	return names
}

func TestCheckSuiteRun(t *testing.T) {
	// assertion builds a test of the top-level describe block describe.
	assertion := func(describe, name, status string) vitestAssertion {
		return vitestAssertion{AncestorTitles: []string{describe}, FullName: describe + " " + name, Status: status}
	}

	// report builds the report of one file's tests, counted as vitest
	// counts them.
	report := func(assertions ...vitestAssertion) vitestReport {
		var built vitestReport

		built.TestResults = append(built.TestResults, vitestFile{Name: "/repo/sim/simulation.sim.test.ts", AssertionResults: assertions})

		built.NumTotalTests = len(assertions)
		for _, each := range assertions {
			if each.Status == "passed" {
				built.NumPassedTests++
			}
		}

		return built
	}

	// errorContaining requires an error whose message contains part.
	errorContaining := func(part string) require.ErrorAssertionFunc {
		return func(t require.TestingT, err error, arguments ...any) {
			require.ErrorContains(t, err, part, arguments...)
		}
	}

	// A run of only the scripted scenarios: the seeded and regression
	// blocks are skipped as a whole.
	scenariosOnly := report(
		assertion("seeded schedules", "seed 1", "skipped"),
		assertion("seeded schedules", "seed 2", "skipped"),
		assertion("committed regression cases", "seed-7", "skipped"),
		assertion("scripted scenarios", "a", "passed"),
		assertion("scripted scenarios", "b", "passed"),
	)

	tests := []struct {
		name       string
		report     vitestReport
		selected   string
		requireErr require.ErrorAssertionFunc
	}{
		{
			name:   "a full run that passes every test",
			report: report(assertion("seeded schedules", "seed 1", "passed"), assertion("scripted scenarios", "a", "passed")),
		},
		{
			name:       "a full run that skips a suite",
			report:     scenariosOnly,
			requireErr: errorContaining("none skipped"),
		},
		{
			name:       "a full run that skips one committed regression case",
			report:     report(assertion("committed regression cases", "seed-7", "passed"), assertion("committed regression cases", "seed-8", "skipped")),
			requireErr: errorContaining("committed regression cases seed-8 (skipped)"),
		},
		{
			name:       "a full run with a todo test",
			report:     report(assertion("scripted scenarios", "a", "passed"), assertion("scripted scenarios", "b", "todo")),
			requireErr: errorContaining("none skipped"),
		},
		{
			name:       "a full run of no tests",
			report:     report(),
			requireErr: errorContaining("ran no tests"),
		},
		{
			name:     "a subset run that passes every selected test",
			report:   scenariosOnly,
			selected: "scenarios",
		},
		{
			name:     "a subset run of several suites",
			report:   scenariosOnly,
			selected: "scenarios,determinism",
		},
		{
			name:     "a run that selects every suite explicitly",
			report:   report(assertion("seeded schedules", "seed 1", "passed")),
			selected: "seeds,retention,members,regressions,scenarios,determinism",
		},
		{
			name:       "a subset run that skips a test of a selected suite",
			report:     report(assertion("scripted scenarios", "a", "passed"), assertion("scripted scenarios", "b", "skipped"), assertion("seeded schedules", "seed 1", "skipped")),
			selected:   "scenarios",
			requireErr: errorContaining("scripted scenarios b (skipped in a selected suite)"),
		},
		{
			name:       "a subset run with a todo test",
			report:     report(assertion("scripted scenarios", "a", "passed"), assertion("seeded schedules", "later", "todo")),
			selected:   "scenarios",
			requireErr: errorContaining("seeded schedules later (todo)"),
		},
		{
			name:       "a subset run that passes nothing",
			report:     report(assertion("seeded schedules", "seed 1", "skipped")),
			selected:   "scenarios",
			requireErr: errorContaining("ran no tests"),
		},
		{
			name:       "a subset run that names an unknown suite",
			report:     scenariosOnly,
			selected:   "scenarios,scenario",
			requireErr: errorContaining(`unknown suite "scenario"`),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			requireErr := test.requireErr
			if requireErr == nil {
				requireErr = require.NoError
			}

			requireErr(t, checkSuiteRun(test.report, test.selected))
		})
	}
}
