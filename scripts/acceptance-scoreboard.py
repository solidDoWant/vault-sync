#!/usr/bin/env python3
"""Prints the acceptance scoreboard (`make acceptance`): one line per scenario
of the checklist with the result of its tests, then the number passing.

A test belongs to a scenario by its name: `[AC-nn] ...` for the e2e and plugin
integration tests (mocha and vitest titles), `TestACnn...` for Go tests (Go
names cannot hold brackets). The results directory holds what the runs wrote:

- `*.jsonl`: one `{"title": ..., "passed": ...}` per e2e test (wdio.conf.mts);
- `go-*.json`: `go test -json` output;
- `vitest*.json`: vitest JSON reports.

A scenario is `fail` if any of its tests failed, `pass` if its tests ran and
all passed, `not run` if it has tagged tests (in the sources or skipped in the
results) of which none failed and not all passed, and `no test` otherwise.
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
    match = GO_TEST.match(name)
    return f"AC-{match.group(1)}" if match else None


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
            # Top-level tests only: a subtest's result is in its parent's.
            if "/" in name or action not in ("pass", "fail", "skip"):
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
        for match in GO_DECLARATION.finditer(path.read_text(encoding="utf-8")):
            ids.add(f"AC-{match.group(1)}")
    return ids


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
    parser.add_argument("--checklist", type=pathlib.Path, required=True)
    parser.add_argument("--results", type=pathlib.Path, required=True)
    parser.add_argument("--sources", type=pathlib.Path, required=True)
    arguments = parser.parse_args()

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
