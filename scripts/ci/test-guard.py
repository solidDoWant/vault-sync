#!/usr/bin/env python3
"""Fails a pull request that deletes or skips a checklist scenario test or
removes a crypto or path vector (`make test-guard`, the `test-guard` CI job).

It compares HEAD with its merge base with `--base` (default `origin/master`):

- Scenario tests are the tests whose title starts with a checklist id,
  `[AC-nn]` or `[Pn-nn]` (vitest and mocha `it`/`test`/`describe`, including
  `.each`, and Go `t.Run` subtests), and the Go functions `func TestACnn...`.
  A test is identified by its title (or function name), wherever it lives, so
  moving one between files is fine. Every title at the base must still exist
  at HEAD as often as before, and none may become skipped: a `.skip`,
  `.skipIf`, `.runIf` or `.todo` modifier, `xit`/`xdescribe`, a skipped
  `describe` around it, a new `.only` in its file, or more skip calls
  (`t.Skip`, `this.skip()`, ...) in its body, or for a Go subtest in its
  parent test before it, than at the base. Commented-out code does not count.
- Vectors are the entries of the lists in `testdata/crypto/vectors.json` and
  `testdata/paths/vectors.json`, identified by their JSON path and `name` (or
  `seq`, or their position). Every entry at the base must still exist at
  HEAD; its values may change. A line `Vectors-removed: <reason>` in the pull
  request body (TEST_GUARD_PR_BODY) allows removing vectors.
- The label `test-removal-approved` (TEST_GUARD_PR_LABELS, comma-separated),
  which only the owner applies, turns the whole check off.
"""

import argparse
import collections
import json
import os
import re
import subprocess
import sys

TAG = r"\[(?:AC|P\d+)-\d+\]"
SOURCE_PATTERNS = ["*.go", "*.ts", "*.mts", "*.cts", "*.tsx", "*.js", "*.mjs"]
VECTOR_FILES = ["testdata/crypto/vectors.json", "testdata/paths/vectors.json"]
APPROVAL_LABEL = "test-removal-approved"
VECTORS_REMOVED = re.compile(r"^Vectors-removed:[ \t]*\S", re.MULTILINE)

# JavaScript test functions; x-prefixed ones are skipped, f-prefixed focused.
JS_TEST_ROOTS = {"it", "test", "describe", "suite", "specify", "context", "xit", "xtest", "xdescribe", "xcontext", "xspecify", "fit", "fdescribe"}
JS_SKIP_MODIFIERS = {"skip", "skipIf", "runIf", "todo"}
JS_CALL = re.compile(r"(?<![\w.$])(" + "|".join(sorted(JS_TEST_ROOTS, key=len, reverse=True)) + r")(?=\s*[.(])")
GO_SUBTEST = re.compile(r"\b\w+\.Run\s*\(")
GO_FUNCTION = re.compile(r"^func (TestAC\d+\w*)\s*\(", re.MULTILINE)
GO_TOP_LEVEL = re.compile(r"^func ", re.MULTILINE)
SKIP_CALL = re.compile(r"(?:\b\w+\.(?:Skip|Skipf|SkipNow|skip)|(?<![\w.$])skip)\s*\(")
STRING = re.compile(r"\"(?:[^\"\\\n]|\\.)*\"|'(?:[^'\\\n]|\\.)*'|`[^`]*`")
TITLE = re.compile(r"(?:\"((?:[^\"\\\n]|\\.)*)\"|'((?:[^'\\\n]|\\.)*)'|`([^`]*)`)")


Test = collections.namedtuple("Test", "title path skipped skip_calls")


def git(*arguments, check=True):
    completed = subprocess.run(["git", *arguments], capture_output=True, text=True, encoding="utf-8")
    if check and completed.returncode != 0:
        raise SystemExit(f"test-guard: git {' '.join(arguments)} failed: {completed.stderr.strip()}")
    return completed


def mask_comments(text):
    """The text with `//` and `/* */` comments blanked out (newlines kept), so
    commented-out tests and skips don't count. Strings are kept."""
    out = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char in "\"'`":
            match = STRING.match(text, index)
            end = match.end() if match else index + 1
            out.append(text[index:end])
            index = end
        elif text.startswith("//", index):
            end = text.find("\n", index)
            end = length if end < 0 else end
            out.append(" " * (end - index))
            index = end
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            end = length if end < 0 else end + 2
            out.append(re.sub(r"[^\n]", " ", text[index:end]))
            index = end
        else:
            out.append(char)
            index += 1
    return "".join(out)


def closing(text, open_index):
    """The index just past the bracket that closes the one at open_index
    (comments already masked; strings skipped), or the end of the text."""
    depth = 0
    index = open_index
    while index < len(text):
        char = text[index]
        if char in "\"'`":
            match = STRING.match(text, index)
            index = match.end() if match else index + 1
            continue
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return len(text)


def skip_whitespace(text, index):
    while index < len(text) and text[index].isspace():
        index += 1
    return index


def tagged_title(text, open_index):
    """The first argument of the call whose `(` is at open_index, if it is a
    string literal starting with a checklist id."""
    match = TITLE.match(text, skip_whitespace(text, open_index + 1))
    if not match:
        return None
    title = next(group for group in match.groups() if group is not None)
    return " ".join(title.split()) if re.match(TAG, title) else None


def js_calls(text):
    """(root, modifiers, arguments start, arguments end) of every JavaScript
    test call: the callee chain `it.skipIf(x).each(y)` up to the call whose
    arguments are not followed by another call or member access."""
    for match in JS_CALL.finditer(text):
        modifiers = []
        index = match.end()
        while True:
            index = skip_whitespace(text, index)
            if index < len(text) and text[index] == ".":
                name = re.compile(r"\s*([\w$]+)").match(text, index + 1)
                if not name:
                    break
                modifiers.append(name.group(1))
                index = name.end()
            elif index < len(text) and text[index] == "(":
                end = closing(text, index)
                after = skip_whitespace(text, end)
                if after < len(text) and text[after] in ".(":
                    index = end
                    continue
                yield match.group(1), modifiers, index, end
                break
            else:
                break


def js_tests(path, text):
    calls = list(js_calls(text))
    skipped_spans = [(start, end) for root, modifiers, start, end in calls if is_skipped(root, modifiers)]
    focused = any(root in {"fit", "fdescribe"} or "only" in modifiers for root, modifiers, _, _ in calls)
    tests = []
    for root, modifiers, start, end in calls:
        title = tagged_title(text, start)
        if title is None:
            continue
        skipped = is_skipped(root, modifiers) or any(span_start < start < span_end for span_start, span_end in skipped_spans)
        tests.append(Test(title, path, skipped, len(SKIP_CALL.findall(text, start, end))))
    return tests, focused


def is_skipped(root, modifiers):
    return root.startswith("x") or any(modifier in JS_SKIP_MODIFIERS for modifier in modifiers)


def go_tests(path, text):
    tests = []
    for match in GO_FUNCTION.finditer(text):
        body = text.find("{", closing(text, match.end() - 1))
        end = closing(text, body) if body >= 0 else len(text)
        tests.append(Test(f"func {match.group(1)}", path, False, len(SKIP_CALL.findall(text, match.start(), end))))
    tops = [match.start() for match in GO_TOP_LEVEL.finditer(text)]
    for match in GO_SUBTEST.finditer(text):
        start = match.end() - 1
        title = tagged_title(text, start)
        if title is None:
            continue
        parent = max((top for top in tops if top < match.start()), default=0)
        skip_calls = len(SKIP_CALL.findall(text, parent, match.start())) + len(SKIP_CALL.findall(text, start, closing(text, start)))
        tests.append(Test(title, path, False, skip_calls))
    return tests, False


def scenario_tests(ref):
    """The scenario tests at ref, and the paths of files with a focused test."""
    listing = git("grep", "-lE", r"\[(AC|P[0-9]+)-[0-9]+\]|func TestAC[0-9]", ref, "--", *SOURCE_PATTERNS, check=False)
    if listing.returncode not in (0, 1):
        raise SystemExit(f"test-guard: git grep failed: {listing.stderr.strip()}")
    tests = []
    focused = []
    for line in listing.stdout.splitlines():
        path = line.split(":", 1)[1]
        if "node_modules/" in path:
            continue
        text = mask_comments(git("show", f"{ref}:{path}").stdout)
        found, has_focus = (go_tests if path.endswith(".go") else js_tests)(path, text)
        tests.extend(found)
        if has_focus and found:
            focused.append(path)
    return tests, focused


def test_problems(base, head):
    base_tests, base_focused = scenario_tests(base)
    head_tests, head_focused = scenario_tests(head)
    newly_focused = set(head_focused) - set(base_focused)
    problems = []
    by_title = collections.defaultdict(lambda: ([], []))
    for test in base_tests:
        by_title[test.title][0].append(test)
    for test in head_tests:
        by_title[test.title][1].append(test)
    for title, (before, after) in sorted(by_title.items()):
        if not before:
            continue
        where = ", ".join(sorted({test.path for test in before}))
        if len(after) < len(before):
            problems.append(f"deleted or renamed: {title} (was in {where})")
            continue
        active_before = sum(not test.skipped for test in before)
        active_after = sum(not test.skipped and test.path not in newly_focused for test in after)
        if active_after < active_before:
            problems.append(f"newly skipped: {title} (in {', '.join(sorted({test.path for test in after}))})")
        elif sum(test.skip_calls for test in after) > sum(test.skip_calls for test in before):
            problems.append(f"new skip call in its body: {title} (in {', '.join(sorted({test.path for test in after}))})")
    return problems


def vector_entries(node, path=""):
    """The keys of the vectors in a vectors.json document: its lists' entries,
    under every object; an entry's own values (lists included) are values."""
    keys = []
    if isinstance(node, dict):
        for name, value in node.items():
            keys.extend(vector_entries(value, f"{path}.{name}" if path else name))
    elif isinstance(node, list):
        for position, item in enumerate(node):
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                key = f"name={item['name']}"
            elif isinstance(item, dict) and "seq" in item:
                key = f"seq={item['seq']}"
            else:
                key = f"#{position}"
            keys.append(f"{path}[{key}]")
    return keys


def load_vectors(ref, path):
    shown = git("show", f"{ref}:{path}", check=False)
    if shown.returncode != 0:
        return None
    try:
        return json.loads(shown.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"test-guard: {path} at {ref} is not valid JSON: {error}") from error


def vector_problems(base, head):
    problems = []
    for path in VECTOR_FILES:
        before = load_vectors(base, path)
        if before is None:
            continue
        after = load_vectors(head, path)
        remaining = collections.Counter(vector_entries(after if after is not None else {}))
        for key, count in sorted(collections.Counter(vector_entries(before)).items()):
            if remaining[key] < count:
                problems.append(f"removed vector: {path} {key}")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", default="origin/master", help="the branch the pull request merges into")
    parser.add_argument("--head", default="HEAD")
    arguments = parser.parse_args()

    labels = {label.strip() for label in os.environ.get("TEST_GUARD_PR_LABELS", "").split(",")}
    if APPROVAL_LABEL in labels:
        print(f"test-guard: skipped, the pull request has the {APPROVAL_LABEL} label")
        return 0
    base = git("merge-base", arguments.base, arguments.head).stdout.strip()
    problems = test_problems(base, arguments.head)
    removed_vectors = vector_problems(base, arguments.head)
    body = os.environ.get("TEST_GUARD_PR_BODY", "").replace("\r", "")
    if removed_vectors and VECTORS_REMOVED.search(body):
        print("test-guard: vectors removed, as the pull request body's Vectors-removed: line says:")
        for problem in removed_vectors:
            print(f"  {problem}")
    else:
        problems.extend(removed_vectors)
    if not problems:
        print(f"test-guard: no scenario test or vector removed or skipped since {base[:12]}")
        return 0
    print(f"test-guard: since the merge base {base[:12]}:")
    for problem in problems:
        print(f"  {problem}")
    print(
        "Restore them. Vectors may be removed with a `Vectors-removed: <reason>` line in the pull request body;"
        f" anything else needs the owner's {APPROVAL_LABEL} label, then a re-run of this job."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
