#!/usr/bin/env python3
"""Tests scripts/ci/test-guard.py, the CI check that fails a pull request
which deletes or skips a checklist scenario test or removes a crypto or path
vector, against throwaway git repositories holding a base and a head commit."""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "scripts" / "ci" / "test-guard.py"

E2E_SPEC = "plugin/test/e2e/specs/basic-sync.e2e.ts"
VITEST_SPEC = "plugin/src/obsidian/encryption.test.ts"
GO_TEST = "internal/server/role_access_integration_test.go"
CRYPTO_VECTORS = "testdata/crypto/vectors.json"
PATH_VECTORS = "testdata/paths/vectors.json"

E2E_SOURCE = """describe("basic sync", function () {
  before(async function () {
    if (e2eEnvironment.android) this.skip();
  });

  it("[AC-04] a note created on A appears on B", async function () {
    await createNote("a.md");
  });

  it("[AC-05] an edit on A appears on B", async function () {
    if (host === "win32") this.skip();
    await editNote("a.md");
  });

  it("an untagged test", async function () {});
});
"""

VITEST_SOURCE = """describe("encryption", () => {
  it(`[P4-03] refuses a wrong passphrase ${String(MAX)} times`, async () => {
    expect(await unlock("wrong")).toBe(false);
  });

  it.each(seeds)("[AC-25] three devices converge (seed %i)", async (seed) => {
    await converge(seed);
  });
});
"""

GO_SOURCE = """package server

func TestRoleAccess(t *testing.T) {
	t.Parallel()
	t.Run("[P3-13] a non-member can neither read nor write", func(t *testing.T) {
		requireDenied(t, nonMember)
	})
	t.Run("[P3-13] a viewer reads, and their commits are refused", func(t *testing.T) {
		requireDenied(t, viewer)
	})
}

func TestAC22OfflineRestore(t *testing.T) {
	restore(t)
}
"""

CRYPTO = {
    "description": "vectors",
    "standards": {"x25519": [{"name": "rfc7748", "shared_secret": "aa"}]},
    "aead": [{"name": "empty", "sealed": "01"}, {"name": "short", "sealed": "02"}],
    "rejected": [{"name": "truncated", "sealed": "03"}],
    "identity_keys": {
        "membership_log": {
            "entries": [{"seq": 1, "hash": "04"}, {"seq": 2, "hash": "05"}],
            "escrow_rotations": [{"new_bundle": "06"}, {"new_bundle": "07"}],
        },
    },
}

PATHS = {"description": "paths", "vectors": [{"name": "ascii", "path": "a.md"}, {"name": "nfc", "path": "é.md"}]}


class TestGuard(unittest.TestCase):
    def setUp(self):
        self.repository = pathlib.Path(tempfile.mkdtemp())
        self.git("init", "-q", "-b", "master")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "test")
        self.write(E2E_SPEC, E2E_SOURCE)
        self.write(VITEST_SPEC, VITEST_SOURCE)
        self.write(GO_TEST, GO_SOURCE)
        self.write(CRYPTO_VECTORS, json.dumps(CRYPTO, indent=2))
        self.write(PATH_VECTORS, json.dumps(PATHS, indent=2))
        self.commit("base")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *arguments):
        return subprocess.run(["git", *arguments], cwd=self.repository, capture_output=True, text=True, check=True).stdout

    def write(self, path, content):
        target = self.repository / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def replace(self, path, old, new):
        content = (self.repository / path).read_text(encoding="utf-8")
        self.assertIn(old, content)
        self.write(path, content.replace(old, new, 1))

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)

    def guard(self, body="", labels=""):
        self.commit("head")
        environment = dict(os.environ, TEST_GUARD_PR_BODY=body, TEST_GUARD_PR_LABELS=labels)
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--base", self.base],
            cwd=self.repository,
            env=environment,
            capture_output=True,
            text=True,
        )

    def assert_passes(self, completed):
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def assert_fails_naming(self, completed, *names):
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        for name in names:
            self.assertIn(name, completed.stdout + completed.stderr)

    # Ordinary pull requests.

    def test_an_unchanged_tree_passes(self):
        self.assert_passes(self.guard())

    def test_an_edited_test_body_and_a_new_test_pass(self):
        self.replace(E2E_SPEC, 'await createNote("a.md");', 'await createNote("b.md");')
        self.replace(E2E_SPEC, '  it("an untagged test"', '  it("[AC-06] a delete on A is applied on B", async function () {});\n\n  it("an untagged test"')
        self.assert_passes(self.guard())

    def test_moving_a_test_to_another_file_passes(self):
        self.replace(E2E_SPEC, """  it("[AC-04] a note created on A appears on B", async function () {
    await createNote("a.md");
  });
""", "")
        self.write("plugin/test/e2e/specs/notes.e2e.ts", 'describe("notes", function () {\n  it("[AC-04] a note created on A appears on B", async function () {});\n});\n')
        self.assert_passes(self.guard())

    def test_deleting_an_untagged_test_passes(self):
        self.replace(E2E_SPEC, '  it("an untagged test", async function () {});\n', "")
        self.assert_passes(self.guard())

    def test_a_changed_vector_value_passes(self):
        changed = json.loads(json.dumps(CRYPTO))
        changed["aead"][0]["sealed"] = "ff"
        self.write(CRYPTO_VECTORS, json.dumps(changed, indent=2))
        self.assert_passes(self.guard())

    def test_an_added_vector_passes(self):
        changed = json.loads(json.dumps(PATHS))
        changed["vectors"].append({"name": "long", "path": "x" * 10})
        self.write(PATH_VECTORS, json.dumps(changed, indent=2))
        self.assert_passes(self.guard())

    def test_it_takes_well_under_thirty_seconds_on_this_repository(self):
        started = time.monotonic()
        completed = subprocess.run([sys.executable, "-I", str(SCRIPT), "--base", "HEAD"], cwd=ROOT, capture_output=True, text=True)
        self.assert_passes(completed)
        self.assertLess(time.monotonic() - started, 10)

    # Deleted and renamed scenario tests.

    def test_deleting_a_tagged_e2e_test_fails_naming_it(self):
        self.replace(E2E_SPEC, """  it("[AC-04] a note created on A appears on B", async function () {
    await createNote("a.md");
  });
""", "")
        self.assert_fails_naming(self.guard(), "deleted or renamed: [AC-04] a note created on A appears on B")

    def test_renaming_a_tagged_test_fails_naming_it(self):
        self.replace(VITEST_SPEC, "[P4-03] refuses a wrong passphrase", "[P4-03] refuses a bad passphrase")
        self.assert_fails_naming(self.guard(), "deleted or renamed: [P4-03] refuses a wrong passphrase")

    def test_deleting_one_of_two_go_subtests_fails_naming_it(self):
        self.replace(GO_TEST, """	t.Run("[P3-13] a viewer reads, and their commits are refused", func(t *testing.T) {
		requireDenied(t, viewer)
	})
""", "")
        self.assert_fails_naming(self.guard(), "deleted or renamed: [P3-13] a viewer reads, and their commits are refused")

    def test_renaming_a_go_acceptance_function_fails_naming_it(self):
        self.replace(GO_TEST, "func TestAC22OfflineRestore(", "func TestOfflineRestore(")
        self.assert_fails_naming(self.guard(), "deleted or renamed: func TestAC22OfflineRestore")

    def test_deleting_a_tagged_test_file_fails(self):
        (self.repository / VITEST_SPEC).unlink()
        self.assert_fails_naming(self.guard(), "[P4-03]", "[AC-25] three devices converge (seed %i)")

    def test_commenting_out_a_tagged_test_fails(self):
        self.replace(E2E_SPEC, """  it("[AC-04] a note created on A appears on B", async function () {
    await createNote("a.md");
  });
""", """  // it("[AC-04] a note created on A appears on B", async function () {
  //   await createNote("a.md");
  // });
""")
        self.assert_fails_naming(self.guard(), "deleted or renamed: [AC-04]")

    def test_commenting_out_a_go_subtest_fails(self):
        self.replace(GO_TEST, '\tt.Run("[P3-13] a viewer', '\t/* t.Run("[P3-13] a viewer')
        self.replace(GO_TEST, "requireDenied(t, viewer)\n\t})\n", "requireDenied(t, viewer)\n\t}) */\n")
        self.assert_fails_naming(self.guard(), "deleted or renamed: [P3-13] a viewer reads")

    # Newly skipped scenario tests.

    def test_it_skip_fails_naming_the_test(self):
        self.replace(E2E_SPEC, 'it("[AC-04]', 'it.skip("[AC-04]')
        self.assert_fails_naming(self.guard(), "[AC-04] a note created on A appears on B")

    def test_xit_fails(self):
        self.replace(E2E_SPEC, 'it("[AC-04]', 'xit("[AC-04]')
        self.assert_fails_naming(self.guard(), "[AC-04]")

    def test_skip_if_on_an_each_test_fails(self):
        self.replace(VITEST_SPEC, "it.each(seeds)(", "it.skipIf(slow).each(seeds)(")
        self.assert_fails_naming(self.guard(), "[AC-25] three devices converge")

    def test_a_skipped_describe_around_a_tagged_test_fails(self):
        self.replace(VITEST_SPEC, 'describe("encryption"', 'describe.skip("encryption"')
        self.assert_fails_naming(self.guard(), "[P4-03]", "[AC-25]")

    def test_only_elsewhere_in_the_file_fails(self):
        self.replace(E2E_SPEC, 'it("an untagged test"', 'it.only("an untagged test"')
        self.assert_fails_naming(self.guard(), "[AC-04]", "[AC-05]")

    def test_a_new_this_skip_in_the_body_fails(self):
        self.replace(E2E_SPEC, 'await createNote("a.md");', 'this.skip();\n    await createNote("a.md");')
        self.assert_fails_naming(self.guard(), "[AC-04]")

    def test_a_new_t_skip_in_a_go_subtest_fails(self):
        self.replace(GO_TEST, "requireDenied(t, viewer)", 't.Skip("flaky")\n\t\trequireDenied(t, viewer)')
        self.assert_fails_naming(self.guard(), "[P3-13] a viewer reads, and their commits are refused")

    def test_a_new_t_skip_before_a_go_subtest_in_its_parent_fails(self):
        self.replace(GO_TEST, "\tt.Parallel()\n", '\tt.Parallel()\n\tt.Skipf("later")\n')
        self.assert_fails_naming(self.guard(), "[P3-13] a non-member can neither read nor write")

    def test_a_new_t_skip_in_a_go_acceptance_function_fails(self):
        self.replace(GO_TEST, "\trestore(t)", "\tt.SkipNow()\n\trestore(t)")
        self.assert_fails_naming(self.guard(), "TestAC22OfflineRestore")

    def test_an_existing_conditional_skip_kept_passes(self):
        self.replace(E2E_SPEC, "await editNote(\"a.md\");", "await editNote(\"b.md\");")
        self.assert_passes(self.guard())

    # Vectors.

    def test_removing_a_crypto_vector_fails_naming_it(self):
        changed = json.loads(json.dumps(CRYPTO))
        del changed["aead"][1]
        self.write(CRYPTO_VECTORS, json.dumps(changed, indent=2))
        self.assert_fails_naming(self.guard(), "aead", "short")

    def test_removing_a_rejected_vector_fails(self):
        changed = json.loads(json.dumps(CRYPTO))
        changed["rejected"] = []
        self.write(CRYPTO_VECTORS, json.dumps(changed, indent=2))
        self.assert_fails_naming(self.guard(), "truncated")

    def test_removing_a_nested_unnamed_vector_fails(self):
        changed = json.loads(json.dumps(CRYPTO))
        changed["identity_keys"]["membership_log"]["escrow_rotations"].pop()
        self.write(CRYPTO_VECTORS, json.dumps(changed, indent=2))
        self.assert_fails_naming(self.guard(), "escrow_rotations")

    def test_removing_a_whole_vector_set_fails(self):
        changed = json.loads(json.dumps(CRYPTO))
        del changed["standards"]
        self.write(CRYPTO_VECTORS, json.dumps(changed, indent=2))
        self.assert_fails_naming(self.guard(), "rfc7748")

    def test_removing_a_path_vector_fails(self):
        changed = json.loads(json.dumps(PATHS))
        del changed["vectors"][0]
        self.write(PATH_VECTORS, json.dumps(changed, indent=2))
        self.assert_fails_naming(self.guard(), "ascii")

    def test_deleting_a_vector_file_fails(self):
        (self.repository / PATH_VECTORS).unlink()
        self.assert_fails_naming(self.guard(), "ascii", "nfc")

    def test_removing_a_vector_with_a_reason_in_the_pr_body_passes(self):
        changed = json.loads(json.dumps(PATHS))
        del changed["vectors"][0]
        self.write(PATH_VECTORS, json.dumps(changed, indent=2))
        self.assert_passes(self.guard(body="Summary.\r\n\r\nVectors-removed: the ascii case duplicated another\r\n"))

    def test_a_vectors_removed_line_without_a_reason_does_not_count(self):
        changed = json.loads(json.dumps(PATHS))
        del changed["vectors"][0]
        self.write(PATH_VECTORS, json.dumps(changed, indent=2))
        self.assert_fails_naming(self.guard(body="Vectors-removed:   \n"), "ascii")

    def test_a_vectors_removed_line_does_not_excuse_a_deleted_test(self):
        self.replace(E2E_SPEC, 'it("[AC-04]', 'it.skip("[AC-04]')
        self.assert_fails_naming(self.guard(body="Vectors-removed: regenerated\n"), "[AC-04]")

    # The owner's override.

    def test_the_approval_label_lets_a_deletion_pass(self):
        (self.repository / VITEST_SPEC).unlink()
        (self.repository / PATH_VECTORS).unlink()
        self.assert_passes(self.guard(labels="area:server,test-removal-approved"))

    def test_another_label_does_not(self):
        (self.repository / VITEST_SPEC).unlink()
        self.assert_fails_naming(self.guard(labels="test-removal-approved-not,area:server"), "[P4-03]")


if __name__ == "__main__":
    unittest.main()
