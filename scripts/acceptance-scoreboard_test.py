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
PHASE_3_CHECKLIST = ROOT / "docs" / "acceptance" / "phase-3.md"
PHASE_4_CHECKLIST = ROOT / "docs" / "acceptance" / "phase-4.md"

# The checklist's scenarios, written out here rather than read the way the
# script reads them: AC-02 to AC-26, AC-01 having been removed by the owner.
SCENARIOS = [f"AC-{number:02d}" for number in range(2, 27)]
# The Phase 3 checklist's scenarios, a table of P3-01 to P3-13.
PHASE_3_SCENARIOS = [f"P3-{number:02d}" for number in range(1, 14)]
# The Phase 4 checklist's scenarios, a table of P4-01 to P4-23.
PHASE_4_SCENARIOS = [f"P4-{number:02d}" for number in range(1, 24)]


class Scoreboard(unittest.TestCase):
    def setUp(self):
        self.work = pathlib.Path(tempfile.mkdtemp())
        self.results = self.work / "results"
        self.results.mkdir()
        self.sources = self.work / "sources"
        (self.sources / "plugin" / "test" / "e2e" / "specs").mkdir(parents=True)
        (self.sources / "internal" / "store").mkdir(parents=True)

    def run_scoreboard(self, checklist=CHECKLIST):
        completed = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--checklist", str(checklist), "--results", str(self.results), "--sources", str(self.sources)],
            capture_output=True,
            text=True,
            check=True,
        )
        return completed.stdout

    def statuses(self, output):
        lines = {}
        for line in output.splitlines():
            match = re.match(r"^((?:AC|P3|P4)-\d\d)\s+(.+?)\s*$", line)
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

    def test_reads_the_phase_3_table_and_its_tagged_tests(self):
        self.write_e2e(("[P3-01] an invited user syncs both ways", True), ("[P3-02] history names user and device", False), ("[AC-04] a note created on A appears on B", True))
        (self.sources / "internal" / "store" / "role_integration_test.go").write_text(
            'package store\n\nfunc TestRoles(t *testing.T) {\n\tt.Run("[P3-13] a viewer is refused", func(t *testing.T) {})\n}\n',
            encoding="utf-8",
        )
        (self.sources / "plugin" / "test" / "e2e" / "specs" / "shared.e2e.ts").write_text('it("[P3-04] a revoked code is refused", async () => {});\n', encoding="utf-8")
        events = [{"Action": "pass", "Test": "TestRoles/[P3-05]_a_role_change_takes_effect"}]
        (self.results / "go-test.json").write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        output = self.run_scoreboard(PHASE_3_CHECKLIST)
        statuses = self.statuses(output)

        self.assertEqual(sorted(statuses), PHASE_3_SCENARIOS)
        self.assertEqual(statuses["P3-01"], "pass")
        self.assertEqual(statuses["P3-02"], "fail")
        self.assertEqual(statuses["P3-04"], "not run")
        self.assertEqual(statuses["P3-05"], "pass")
        self.assertEqual(statuses["P3-13"], "not run")
        self.assertEqual(statuses["P3-06"], "no test")
        self.assertNotIn("AC-04", output)
        self.assertEqual(output.strip().splitlines()[-1], "passing 2/13")

    def test_reads_the_phase_4_table_and_its_tagged_tests(self):
        (self.sources / "plugin" / "src" / "core").mkdir(parents=True)
        (self.sources / "plugin" / "src" / "core" / "vectors.test.ts").write_text('it("[P4-17] wraps to the hybrid recipient", async () => {});\n', encoding="utf-8")
        (self.sources / "plugin" / "src" / "core" / "unlock.test.ts").write_text('it("[P4-03] refuses a wrong passphrase", async () => {});\n', encoding="utf-8")
        (self.sources / "plugin" / "src" / "core" / "helper.ts").write_text('it("[P4-05] not a test file", async () => {});\n', encoding="utf-8")
        report = {"testResults": [{"assertionResults": [{"title": "[P4-17] wraps to the hybrid recipient", "status": "passed"}]}]}
        (self.results / "vitest-unit.json").write_text(json.dumps(report), encoding="utf-8")
        events = [{"Action": "pass", "Test": "TestEscrowRotation/[P4-12]_re-wraps_every_slot"}, {"Action": "fail", "Test": "TestExport/[P4-11]_decrypts"}]
        (self.results / "go-integration.json").write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        output = self.run_scoreboard(PHASE_4_CHECKLIST)
        statuses = self.statuses(output)

        self.assertEqual(sorted(statuses), PHASE_4_SCENARIOS)
        self.assertEqual(statuses["P4-17"], "pass")
        self.assertEqual(statuses["P4-12"], "pass")
        self.assertEqual(statuses["P4-11"], "fail")
        self.assertEqual(statuses["P4-03"], "not run")
        self.assertEqual(statuses["P4-05"], "no test")
        self.assertEqual(output.strip().splitlines()[-1], "passing 2/23")

    def test_the_go_run_pattern_selects_the_tests_holding_phase_3_subtests(self):
        (self.sources / "internal" / "store" / "role_integration_test.go").write_text(
            'package store\n\nfunc TestRoles(t *testing.T) {\n\tt.Run("[P3-13] a viewer is refused", func(t *testing.T) {})\n}\n',
            encoding="utf-8",
        )
        completed = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--go-run-pattern", "--sources", str(self.sources)],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertTrue(re.compile(completed.stdout.strip()).fullmatch("TestRoles"))


if __name__ == "__main__":
    unittest.main()
