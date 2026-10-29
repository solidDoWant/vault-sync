#!/usr/bin/env python3
"""Prints the acceptance scoreboard (`make acceptance`): one line per scenario
of the checklist with the result of its tests, then the number passing.

A test belongs to a scenario by its name: `[AC-nn] ...` for the e2e and plugin
integration tests (mocha and vitest titles) and Go subtests (`t.Run`), and
`TestACnn...` for top-level Go tests (Go function names cannot hold brackets).
The results directory holds what the runs wrote:

- `*.jsonl`: one `{"title": ..., "passed": ...}` per e2e test (wdio.conf.mts);
- `go-*.json`: `go test -json` output;
- `vitest*.json`: vitest JSON reports.

A scenario is `fail` if any of its tests failed, `pass` if its tests ran and
all passed, `not run` if it has tagged tests (in the sources or skipped in the
results) of which none failed and not all passed, and `no test` otherwise.

With `--go-run-pattern`, it prints instead the `go test -run` pattern that
selects the Go acceptance tests: the `TestACnn...` tests, the plugin protocol
client test and every top-level test that holds an `[AC-nn] ...` subtest.
"""

import argparse
import json
import pathlib
import re
import sys

SCENARIO = re.compile(r"^- \*\*(AC-\d+)\*\*\s*(.*)$")
TAG = re.compile(r"\[(AC-\d+)\]")
GO_TEST = re.compile(r"^TestAC(\d+)")
GO_DECLARATION = re.compile(r"^func TestAC(\d+)\w*\(", re.MULTILINE)
GO_FUNCTION = re.compile(r"^func (Test\w+)\(", re.MULTILINE)
GO_SUBTEST = re.compile(r"""\bt\.Run\(\s*["`]\[(AC-\d+)\]""")
# Go tests the acceptance run selects besides the tagged ones: the plugin
# integration suite runs inside TestPluginProtocolClient.
GO_EXTRA_TESTS = ["TestPluginProtocolClient"]


def scenarios(checklist):
    """The checklist's scenario ids, without the ones the owner removed."""
    ids = []
    for line in checklist.read_text(encoding="utf-8").splitlines():
        match = SCENARIO.match(line)
        if match and not match.group(2).startswith("(Removed"):
            ids.append(match.group(1))
    return ids


def title_id(title):
    match = TAG.match(title.strip())
    return match.group(1) if match else None


def go_id(name):
    """The scenario of a `go test` result: a top-level `TestACnn...` test, or
    a subtest named `[AC-nn] ...` (its own result, not one of its subtests')."""
    elements = name.split("/")
    if len(elements) == 1:
        match = GO_TEST.match(name)
        return f"AC-{match.group(1)}" if match else None
    return title_id(elements[-1])


def results(directory):
    """(scenario id, outcome) pairs, outcome one of pass, fail, skip."""
    found = []
    for path in sorted(directory.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            scenario = title_id(record.get("title", ""))
            if scenario:
                found.append((scenario, "pass" if record.get("passed") else "fail"))
    for path in sorted(directory.glob("go-*.json")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.startswith("{"):
                continue
            event = json.loads(line)
            name = event.get("Test", "")
            action = event.get("Action")
            if action not in ("pass", "fail", "skip"):
                continue
            scenario = go_id(name)
            if scenario:
                found.append((scenario, action))
    for path in sorted(directory.glob("vitest*.json")):
        report = json.loads(path.read_text(encoding="utf-8"))
        for file in report.get("testResults", []):
            for assertion in file.get("assertionResults", []):
                scenario = title_id(assertion.get("title", ""))
                if scenario:
                    status = assertion.get("status")
                    found.append((scenario, {"passed": "pass", "failed": "fail"}.get(status, "skip")))
    return found


def tagged_in_sources(root):
    """Scenario ids that have a test in the sources, run or not."""
    ids = set()
    tests = root / "plugin" / "test"
    if tests.is_dir():
        for path in tests.rglob("*.ts"):
            if "node_modules" in path.parts:
                continue
            for match in re.finditer(r"""\bit\(\s*["'`]\[(AC-\d+)\]""", path.read_text(encoding="utf-8")):
                ids.add(match.group(1))
    for path in root.rglob("*_test.go"):
        if "node_modules" in path.parts:
            continue
        source = path.read_text(encoding="utf-8")
        for match in GO_DECLARATION.finditer(source):
            ids.add(f"AC-{match.group(1)}")
        for match in GO_SUBTEST.finditer(source):
            ids.add(match.group(1))
    return ids


def go_tests_with_tagged_subtests(root):
    """Names of the top-level Go tests that hold an `[AC-nn] ...` subtest."""
    names = set()
    for path in root.rglob("*_test.go"):
        if "node_modules" in path.parts:
            continue
        source = path.read_text(encoding="utf-8")
        functions = list(GO_FUNCTION.finditer(source))
        for subtest in GO_SUBTEST.finditer(source):
            enclosing = [function for function in functions if function.start() < subtest.start()]
            if enclosing:
                names.add(enclosing[-1].group(1))
    return sorted(names)


def go_run_pattern(root):
    names = GO_EXTRA_TESTS + go_tests_with_tagged_subtests(root)
    return "^(TestAC[0-9]+.*|" + "|".join(names) + ")$"


def status(outcomes, tagged):
    if "fail" in outcomes:
        return "fail"
    if outcomes and all(outcome == "pass" for outcome in outcomes):
        return "pass"
    if outcomes or tagged:
        return "not run"
    return "no test"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--checklist", type=pathlib.Path)
    parser.add_argument("--results", type=pathlib.Path)
    parser.add_argument("--sources", type=pathlib.Path, required=True)
    parser.add_argument("--go-run-pattern", action="store_true", help="print the go test -run pattern of the Go acceptance tests")
    arguments = parser.parse_args()
    if arguments.go_run_pattern:
        print(go_run_pattern(arguments.sources))
        return 0
    if arguments.checklist is None or arguments.results is None:
        parser.error("--checklist and --results are required to print the scoreboard")

    ids = scenarios(arguments.checklist)
    outcomes = {scenario: [] for scenario in ids}
    for scenario, outcome in results(arguments.results):
        if scenario in outcomes:
            outcomes[scenario].append(outcome)
    tagged = tagged_in_sources(arguments.sources)

    passing = 0
    for scenario in ids:
        line_status = status(outcomes[scenario], scenario in tagged)
        passing += line_status == "pass"
        print(f"{scenario}  {line_status}")
    print(f"passing {passing}/{len(ids)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
