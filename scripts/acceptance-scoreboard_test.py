#!/usr/bin/env python3
"""Tests scripts/acceptance-scoreboard.py, the scoreboard `make acceptance`
prints, against the real checklist and fixture results and sources."""

import json
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "acceptance-scoreboard.py"
CHECKLIST = ROOT / "docs" / "acceptance" / "phase-2.md"

# The checklist's scenarios, written out here rather than read the way the
# script reads them: AC-02 to AC-26, AC-01 having been removed by the owner.
SCENARIOS = [f"AC-{number:02d}" for number in range(2, 27)]


class Scoreboard(unittest.TestCase):
    def setUp(self):
        self.work = pathlib.Path(tempfile.mkdtemp())
        self.results = self.work / "results"
        self.results.mkdir()
        self.sources = self.work / "sources"
        (self.sources / "plugin" / "test" / "e2e" / "specs").mkdir(parents=True)
        (self.sources / "internal" / "store").mkdir(parents=True)

    def run_scoreboard(self):
        completed = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--checklist", str(CHECKLIST), "--results", str(self.results), "--sources", str(self.sources)],
            capture_output=True,
            text=True,
            check=True,
        )
        return completed.stdout

    def statuses(self, output):
        lines = {}
        for line in output.splitlines():
            match = re.match(r"^(AC-\d\d)\s+(.+?)\s*$", line)
            if match:
                lines[match.group(1)] = match.group(2)
        return lines

    def write_e2e(self, *results):
        with open(self.results / "e2e.jsonl", "w", encoding="utf-8") as file:
            for title, passed in results:
                file.write(json.dumps({"title": title, "passed": passed}) + "\n")

    def test_prints_one_line_per_scenario_and_the_total(self):
        self.write_e2e(("[AC-04] a note created on A appears on B", True), ("[AC-05] an edit on A appears on B", True))
        output = self.run_scoreboard()

        self.assertEqual(sorted(self.statuses(output)), SCENARIOS)
        self.assertEqual(len([line for line in output.splitlines() if re.match(r"^AC-\d\d\s", line)]), 25)
        self.assertNotIn("AC-01", output)
        self.assertEqual(output.strip().splitlines()[-1], "passing 2/25")

    def test_shows_no_test_for_a_scenario_without_a_test(self):
        output = self.run_scoreboard()

        self.assertEqual(set(self.statuses(output).values()), {"no test"})
        self.assertEqual(output.strip().splitlines()[-1], "passing 0/25")

    def test_a_failing_test_fails_its_scenario(self):
        self.write_e2e(("[AC-07] a rename keeps the history", True), ("[AC-07] a move keeps the history", False))
        output = self.run_scoreboard()

        self.assertEqual(self.statuses(output)["AC-07"], "fail")
        self.assertEqual(output.strip().splitlines()[-1], "passing 0/25")

    def test_a_tagged_test_without_a_result_is_not_run(self):
        (self.sources / "plugin" / "test" / "e2e" / "specs" / "device.android.e2e.ts").write_text(
            'it("[AC-21] pushes an edit made before the app went to the background", async function () {});\n', encoding="utf-8"
        )
        (self.sources / "internal" / "store" / "restore_integration_test.go").write_text(
            "package store\n\nfunc TestAC22OfflineRestore(t *testing.T) {}\n", encoding="utf-8"
        )
        statuses = self.statuses(self.run_scoreboard())

        self.assertEqual(statuses["AC-21"], "not run")
        self.assertEqual(statuses["AC-22"], "not run")
        self.assertEqual(statuses["AC-23"], "no test")

    def test_reads_the_android_device_checks_next_to_the_desktop_results(self):
        (self.sources / "plugin" / "test" / "e2e" / "specs" / "device.android.e2e.ts").write_text(
            'it("[AC-21] pushes an edit made before the app went to the background", async function () {});\n', encoding="utf-8"
        )
        self.write_e2e(("[AC-04] a note created on A appears on B", True))
        with open(self.results / "android-e2e.jsonl", "w", encoding="utf-8") as file:
            file.write(json.dumps({"title": "[AC-21] pushes an edit made before the app went to the background", "passed": True}) + "\n")
            file.write(json.dumps({"title": "[AC-21] receives an edit made while the app was closed", "passed": True}) + "\n")
        output = self.run_scoreboard()
        statuses = self.statuses(output)

        self.assertEqual(statuses["AC-21"], "pass")
        self.assertEqual(statuses["AC-04"], "pass")
        self.assertEqual(output.strip().splitlines()[-1], "passing 2/25")

    def test_reads_go_and_vitest_results(self):
        events = [
            {"Action": "run", "Test": "TestAC22OfflineRestore"},
            {"Action": "pass", "Test": "TestAC22OfflineRestore/with_a_device"},
            {"Action": "pass", "Test": "TestAC22OfflineRestore"},
            {"Action": "skip", "Test": "TestAC23MarkdownImport"},
            {"Action": "fail", "Test": "TestAC24History"},
            {"Action": "pass", "Package": "github.com/solidDoWant/vault-sync/internal/store"},
        ]
        (self.results / "go-test.json").write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        report = {
            "testResults": [
                {
                    "assertionResults": [
                        {"title": "[AC-25] three devices converge", "status": "passed"},
                        {"title": "an untagged test", "status": "failed"},
                    ]
                }
            ]
        }
        (self.results / "vitest.json").write_text(json.dumps(report), encoding="utf-8")
        output = self.run_scoreboard()
        statuses = self.statuses(output)

        self.assertEqual(statuses["AC-22"], "pass")
        self.assertEqual(statuses["AC-23"], "not run")
        self.assertEqual(statuses["AC-24"], "fail")
        self.assertEqual(statuses["AC-25"], "pass")
        self.assertEqual(output.strip().splitlines()[-1], "passing 2/25")


    def test_counts_a_tagged_go_subtest_for_its_scenario(self):
        events = [
            {"Action": "run", "Test": "TestImportSubcommand"},
            {"Action": "pass", "Test": "TestImportSubcommand/[AC-23]_a_device_syncs_exactly_the_imported_notes"},
            {"Action": "pass", "Test": "TestImportSubcommand/[AC-23]_a_device_syncs_exactly_the_imported_notes/a_nested_step"},
            {"Action": "fail", "Test": "TestImportSubcommand/[AC-24]_the_history_survives"},
            {"Action": "fail", "Test": "TestImportSubcommand/an_untagged_subtest"},
            {"Action": "fail", "Test": "TestImportSubcommand"},
        ]
        (self.results / "go-test.json").write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        output = self.run_scoreboard()
        statuses = self.statuses(output)

        self.assertEqual(statuses["AC-23"], "pass")
        self.assertEqual(statuses["AC-24"], "fail")
        self.assertEqual(output.strip().splitlines()[-1], "passing 1/25")

    def test_a_tagged_go_subtest_without_a_result_is_not_run(self):
        (self.sources / "internal" / "store" / "import_integration_test.go").write_text(
            'package store\n\nfunc TestImportSubcommand(t *testing.T) {\n\tt.Run("[AC-23] a device syncs the notes", func(t *testing.T) {})\n}\n',
            encoding="utf-8",
        )
        statuses = self.statuses(self.run_scoreboard())

        self.assertEqual(statuses["AC-23"], "not run")
        self.assertEqual(statuses["AC-24"], "no test")

    def test_the_go_run_pattern_selects_the_tests_holding_tagged_subtests(self):
        (self.sources / "internal" / "store" / "import_integration_test.go").write_text(
            "package store\n\n"
            "func TestUntagged(t *testing.T) {\n\tt.Run(\"plain\", func(t *testing.T) {})\n}\n\n"
            "func TestImportSubcommand(t *testing.T) {\n\tsetUp(t)\n\n\tt.Run(\"[AC-23] a device syncs the notes\", func(t *testing.T) {})\n}\n",
            encoding="utf-8",
        )
        completed = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--go-run-pattern", "--sources", str(self.sources)],
            capture_output=True,
            text=True,
            check=True,
        )
        pattern = re.compile(completed.stdout.strip())

        for name in ("TestAC22OfflineRestore", "TestPluginProtocolClient", "TestImportSubcommand"):
            self.assertTrue(pattern.fullmatch(name), name)
        for name in ("TestUntagged", "TestImportSubcommandOther", "TestPluginProtocolClientExtra"):
            self.assertFalse(pattern.fullmatch(name), name)


if __name__ == "__main__":
    unittest.main()
