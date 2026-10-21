#!/usr/bin/env python3
"""Tests scripts/agents/scheduler.py with fake GitHub data, a fake `claude`
executable and a throwaway git repository (no network, no real agents).

  python3 scripts/agents/scheduler_test.py   (also run by `make test`)
"""

from __future__ import annotations

import datetime as dt
import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scheduler as s  # noqa: E402

CFG = s.deep_merge(s.DEFAULT_CONFIG, {})
NOW = dt.datetime(2026, 10, 21, 5, 0, tzinfo=dt.timezone.utc)
MS2 = "Phase 2 — Single-user file sync"
MS3 = "Phase 3 — Vault sharing"
MILESTONES = {MS2: 2, MS3: 3}


def issue(n, title=None, status="status:todo", milestone=MS2, labels=(), parent=None, blocked_by=(), author="solidDoWant",
          sub_issues=0):
    lab = set(labels) | ({status} if status else set())
    return s.Issue(n, title or f"feat(x): issue {n}", author, lab, milestone, parent, list(blocked_by), sub_issues)


def review(verdict, commit, url="https://example/r", headline=""):
    return s.Review(verdict, commit, url, "2026-10-21T00:00:00Z", headline or f"**Verdict: {verdict}**")


def pr(n, issue_n, head="h" * 40, check="success", draft=False, auto=False, mergeable="MERGEABLE", reviews=(),
       author="solidDoWant", branch=None, files=("internal/x.go",), failed=()):
    return s.PR(n, f"feat(x): pr {n}", author, draft, branch or f"feat/x-{issue_n}", head, mergeable, "CLEAN", auto,
                [issue_n] if issue_n else [], list(files), list(reviews), check, list(failed))


def snap(issues=(), prs=()):
    return s.Snapshot({i.number: i for i in issues}, {p.number: p for p in prs}, dict(MILESTONES))


def plan_for(sn, state=None, holds=None, cfg=CFG):
    st = {"sessions": {}, "running": {}, "failures": {}, "gave_up": {}, "ci_reruns": {}, "specials": {}}
    st.update(state or {})
    return s.build_plan(sn, st, cfg, holds or {}, NOW)


def keys(plan):
    return [j.key for j in plan.jobs]


class VerdictTest(unittest.TestCase):
    def test_real_headlines(self):
        cases = {
            "**Verdict: merge** (full review). No blocking findings.": "merge",
            "**Verdict: changes requested.** There is one blocking test gap": "changes",
            "**Verdict: no blocking findings; merging once CI is green on the updated branch.**": "merge",
            "**Verdict: request changes (rebase needed).** While CI ran": "changes",
            "**Verdict: approve and merge** (full review; no blocking findings).": "merge",
            "**Verdict: request changes** (one blocking finding, in the plugin's handling": "changes",
            "**Verdict: reject.** The approach is out of scope.": "reject",
            "**Verdict: merge (light review).** Auto-merge armed at `9a5aa16f`.": "merge",
            "Thanks, addressed in abc123": None,
        }
        for body, want in cases.items():
            with self.subTest(body=body):
                self.assertEqual(s.parse_verdict(body)[0], want)


class PlanTest(unittest.TestCase):
    def test_priority_order_across_tiers(self):
        sn = snap(
            [issue(1), issue(2, status="status:in-review"), issue(3, status="status:in-review"),
             issue(4, status="status:in-review"), issue(5, status="status:in-review")],
            [
                pr(10, 2, head="a" * 40, check="success"),  # T2 review
                pr(11, 3, head="b" * 40, reviews=[review("changes", "b" * 40)]),  # T3 worker
                pr(12, 4, auto=True, mergeable="CONFLICTING"),  # T1 reviewer
                pr(13, 5, check="pending"),  # waits for CI
            ],
        )
        plan = plan_for(sn)
        self.assertEqual(keys(plan), ["reviewer:pr-12", "reviewer:pr-10", "worker:3", "worker:1"])
        self.assertIn(("PR #13", "CI pending"), plan.skipped)

    def test_armed_ci_failure_reruns_once_then_worker(self):
        failed = [{"name": "unit", "url": "https://x/1", "run_id": 99}]
        sn = snap([issue(2, status="status:in-review")], [pr(10, 2, check="failure", auto=True, failed=failed)])
        plan = plan_for(sn)
        self.assertEqual(plan.reruns, [(10, [99], ["unit"])])
        self.assertEqual(keys(plan), [])
        plan = plan_for(sn, {"ci_reruns": {"10": {"sha": "h" * 40, "jobs": ["unit"]}}})
        self.assertEqual(plan.reruns, [])
        self.assertEqual(keys(plan), ["worker:2"])
        self.assertIn("unit (https://x/1)", plan.jobs[0].trigger)

    def test_red_unarmed_pr_goes_to_reviewer(self):
        plan = plan_for(snap([issue(2, status="status:in-review")], [pr(10, 2, check="failure")]))
        self.assertEqual(keys(plan), ["reviewer:pr-10"])

    def test_reviewed_head_and_moved_head(self):
        approved = pr(10, 2, head="a" * 40, reviews=[review("merge", "a" * 40)])
        self.assertEqual(keys(plan_for(snap([issue(2, status="status:in-review")], [approved]))), [])
        # The worker pushed after a change request: back to a reviewer once CI finishes.
        moved = pr(10, 2, head="c" * 40, reviews=[review("changes", "a" * 40)])
        self.assertEqual(keys(plan_for(snap([issue(2, status="status:in-review")], [moved]))), ["reviewer:pr-10"])

    def test_conflicting_unreviewed_pr_does_not_wait_for_ci(self):
        sn = snap([issue(2, status="status:in-review")], [pr(10, 2, check="missing", mergeable="CONFLICTING")])
        self.assertEqual(keys(plan_for(sn)), ["reviewer:pr-10"])

    def test_skips_drafts_renovate_foreign_prs_and_holds(self):
        sn = snap([issue(2, status="status:in-review"), issue(3, status="status:in-review")], [
            pr(10, 2, draft=True),
            pr(11, None, author="renovate", branch="renovate/go"),
            pr(12, None, branch="renovate/npm"),
            pr(13, 3),
        ])
        self.assertEqual(keys(plan_for(sn, holds={"pr:13": "operator"})), [])
        self.assertEqual(keys(plan_for(sn, holds={"issue:3": "wait for bug hunt"})), [])
        self.assertEqual(keys(plan_for(sn)), ["reviewer:pr-13"])

    def test_ready_issue_filters(self):
        sn = snap([
            issue(1),
            issue(2, author="mallory"),
            issue(3, labels=["needs-human"]),
            issue(4, blocked_by=[(1, "OPEN")]),
            issue(5, blocked_by=[(1, "CLOSED")]),
            issue(6, status="status:triage"),
            issue(7, sub_issues=3),  # a tracker
            issue(8, author="github-actions"),
            issue(9, status="status:blocked"),
        ])
        plan = plan_for(sn, holds={"issue:5": "x"})
        self.assertEqual(sorted(keys(plan)), ["worker:1", "worker:8"])
        self.assertIn(("#4", "blocked by #1"), plan.skipped)

    def test_ready_order_phase_critical_dependents(self):
        sn = snap([
            issue(1, labels=["severity:high"], milestone=MS3),  # later phase, even if critical
            issue(2),  # current phase, other
            issue(3, parent=552),  # refactor step: critical
            issue(4, parent=100),  # planned (parent is the phase epic)
            issue(100, labels=["epic"], status=None, sub_issues=5),
            issue(5, labels=["follow-up"], parent=100),  # follow-up: not planned
            issue(6),  # unblocks 7 and (transitively) 8
            issue(7, blocked_by=[(6, "OPEN")]),
            issue(8, blocked_by=[(7, "OPEN")]),
        ])
        self.assertEqual(keys(plan_for(sn)), ["worker:3", "worker:4", "worker:6", "worker:2", "worker:5", "worker:1"])

    def test_in_progress_issue_without_pr_or_agent_is_resumed(self):
        sn = snap([issue(1, status="status:in-progress"), issue(2, status="status:in-progress")],
                  [pr(10, 2, check="pending")])
        plan = plan_for(sn)
        self.assertEqual(keys(plan), ["worker:1"])
        self.assertEqual(plan.jobs[0].tier, 4)

    def test_continuations_and_wait_pr(self):
        sessions = {
            "worker:1": {"role": "issue-worker", "issue": 1, "handoff": {"state": "incomplete"}},
            "worker:2": {"role": "issue-worker", "issue": 2, "interrupted": "usage limit"},
            "worker:3": {"role": "issue-worker", "issue": 3, "handoff": {"state": "wait-pr", "pr": 77}},
            "worker:4": {"role": "issue-worker", "issue": 4, "handoff": {"state": "wait-pr", "pr": 10}},
        }
        sn = snap([issue(n, status="status:in-progress") for n in (1, 2, 3, 4)], [pr(10, 99, check="pending")])
        plan = plan_for(sn, {"sessions": sessions})
        self.assertEqual(keys(plan), ["worker:1", "worker:2", "worker:3"])
        self.assertIn("PR #77", plan.jobs[2].trigger)

    def test_question_answered_resumes_with_note(self):
        sessions = {"worker:1": {"role": "issue-worker", "issue": 1, "handoff": {"state": "question"}}}
        self.assertEqual(keys(plan_for(snap([issue(1, status="status:in-progress")]), {"sessions": sessions})), [])
        plan = plan_for(snap([issue(1)]), {"sessions": sessions})
        self.assertIn("answered or unblocked", plan.jobs[0].trigger)

    def test_special_jobs_and_release_lock(self):
        specials = {"hunt-1": {"role": "bug-hunter", "brief": "sync under faults", "priority": 0},
                    "rel": {"role": "release-manager", "brief": "release 0.2.0", "priority": 1}}
        plan = plan_for(snap([issue(1)]), {"specials": specials})
        self.assertEqual(keys(plan), ["special:hunt-1", "special:rel", "worker:1"])
        self.assertEqual(plan.jobs[1].locks, ("release",))

    def test_review_rounds_give_up_and_planner_override(self):
        reviews = [review("changes", c * 40) for c in "abc"]
        sn = snap([issue(2, status="status:in-review")], [pr(10, 2, head="c" * 40, reviews=reviews)])
        plan = plan_for(sn)
        self.assertEqual(keys(plan), [])
        self.assertEqual([g[0] for g in plan.gave_up], ["worker:2"])
        record = {"kind": "rounds", "issue": 2, "pr": 10, "head": "c" * 40, "why": "x", "rounds": 3}
        blocked = snap([issue(2, status="status:blocked")], [pr(10, 2, head="c" * 40, reviews=reviews)])
        plan = plan_for(blocked, {"gave_up": {"worker:2": record}})
        self.assertEqual((keys(plan), plan.gave_up), ([], []))
        # The planner lifted status:blocked: the worker runs again.
        plan = plan_for(sn, {"gave_up": {"worker:2": record}})
        self.assertEqual((keys(plan), plan.cleared), (["worker:2"], ["worker:2"]))
        # ...and the acknowledged rounds no longer count.
        self.assertEqual(keys(plan_for(sn, {"rounds_ack": {"worker:2": 3}})), ["worker:2"])

    def test_light_review_hint(self):
        sn = snap([issue(2, status="status:in-review")], [pr(10, 2, files=["docs/a.md", "plugin/src/x.test.ts"])])
        self.assertIn("light review", plan_for(sn).jobs[0].trigger)
        sn = snap([issue(2, status="status:in-review")], [pr(10, 2, files=["docs/a.md", "internal/x.go"])])
        self.assertNotIn("light review", plan_for(sn).jobs[0].trigger)

    def test_pr_issue_mapping(self):
        self.assertEqual(s.pr_issue(pr(1, 611, branch="refactor/engine-569")), 611)
        p = pr(1, None, branch="refactor/engine-569")
        p.closing = [611, 569, 628]
        self.assertEqual(s.pr_issue(p), 569)
        p.closing = []
        self.assertEqual(s.pr_issue(p), 569)
        self.assertIsNone(s.pr_issue(pr(1, None, branch="docs/readme")))


class SelectTest(unittest.TestCase):
    def test_locks_one_holder(self):
        engine = r"refactor(engine): R{}"
        sn = snap([issue(1, engine.format(5)), issue(2, engine.format(6)), issue(3)])
        plan = plan_for(sn)
        chosen, queue = s.select_jobs(plan, {"running": {}}, CFG, 5, {}, NOW)
        self.assertEqual([j.key for j in chosen], ["worker:1", "worker:3"])
        self.assertEqual(dict((j.key, st) for j, st in queue)["worker:2"], "lock engine.ts held by #1")

    def test_lock_held_by_in_flight_issue(self):
        engine = "refactor(engine): R{}"
        sn = snap([issue(1, engine.format(5), status="status:in-review"), issue(2, engine.format(6))],
                  [pr(10, 1, check="success")])
        locks = s.in_flight_locks(sn, {"running": {}}, CFG)
        self.assertEqual(locks, {"engine.ts": "#1"})
        chosen, _ = s.select_jobs(plan_for(sn), {"running": {}}, CFG, 5, locks, NOW)
        # The holder's own PR is reviewed; the next engine step waits.
        self.assertEqual([j.key for j in chosen], ["reviewer:pr-10"])

    def test_claims_backoff_and_free_slots(self):
        sn = snap([issue(1), issue(2), issue(3), issue(4, status="status:in-review")], [pr(10, 4)])
        state = {"running": {"j": {"key": "worker:9", "claims": ["issue:4", "pr:10"], "locks": []}},
                 "failures": {"worker:2": {"count": 1, "next_allowed": s.iso(NOW + dt.timedelta(minutes=5))}}}
        chosen, queue = s.select_jobs(plan_for(sn), state, CFG, 1, {}, NOW)
        status = dict((j.key, st) for j, st in queue)
        self.assertEqual([j.key for j in chosen], ["worker:1"])
        self.assertEqual(status["reviewer:pr-10"], "claimed by a running job")
        self.assertTrue(status["worker:2"].startswith("backoff until"))
        self.assertEqual(status["worker:3"], "ready")


class SessionTest(unittest.TestCase):
    def test_decide_session(self):
        self.assertEqual(s.decide_session(None, 150000)[0], "fresh")
        self.assertEqual(s.decide_session({"session_id": "x"}, 150000)[0], "fresh")
        self.assertEqual(s.decide_session({"session_id": "x", "context_tokens": 149999}, 150000)[0], "resume")
        self.assertEqual(s.decide_session({"session_id": "x", "context_tokens": 150000}, 150000)[0], "fresh")

    def test_fresh_prompt_seeds_previous_report(self):
        job = s.Job("worker:5", "issue-worker", 3, (), "r", "Address the review", 5, 9)
        text = s.fresh_prompt(job, Path("/wt"), "note", {"last_report": "did A\nHANDOFF: pr-ready"}, "context 2 >= 1")
        self.assertIn("> did A", text)
        self.assertIn("Work only on issue #5", text)
        self.assertIn("issue #5 (PR #9)", text)


class ParseTest(unittest.TestCase):
    def test_limit_reset(self):
        cases = [
            ("You've hit your session limit · resets 3am (UTC)", NOW.replace(hour=3), True),
            ("You've hit your session limit · resets 10pm (UTC)", NOW.replace(hour=22), False),
            ("You've hit your session limit · resets 5:30am (UTC)", NOW.replace(hour=5, minute=30), False),
            ("You've hit your weekly limit · resets Oct 23, 9am (UTC)", NOW.replace(day=23, hour=9), False),
            ("You've hit your weekly limit · resets Mon 9am (UTC)", NOW.replace(day=26, hour=9), False),
        ]
        for text, want, next_day in cases:
            with self.subTest(text=text):
                if next_day:
                    want += dt.timedelta(days=1)
                self.assertEqual(s.parse_limit_reset(text, NOW), want)
        berlin = s.parse_limit_reset("resets 9am (Europe/Berlin)", NOW)
        self.assertEqual(berlin, NOW.replace(hour=7))
        self.assertIsNone(s.parse_limit_reset("You've hit your session limit", NOW))

    def test_handoff(self):
        self.assertEqual(s.parse_handoff("report\nHANDOFF: pr-ready"), {"state": "pr-ready", "pr": None})
        self.assertEqual(s.parse_handoff("x\nHANDOFF: wait-pr #123\n"), {"state": "wait-pr", "pr": 123})
        self.assertIsNone(s.parse_handoff("HANDOFF: maybe"))
        self.assertIsNone(s.parse_handoff(None))

    def test_classify_exit(self):
        limit = {"result": "You've hit your session limit · resets 3am (UTC)", "is_error": True,
                 "api_error": "usage_limit_reached"}
        self.assertEqual(s.classify_exit(1, limit, ""), "limit")
        self.assertEqual(s.classify_exit(0, {"result": "ok", "is_error": False}, ""), "ok")
        self.assertEqual(s.classify_exit(1, {"result": None}, "boom"), "failed")
        self.assertEqual(s.classify_exit(0, {"result": "x", "is_error": True}, ""), "failed")
        self.assertEqual(s.classify_exit(1, {}, "No conversation found with session ID: x"), "resume-missing")

    def test_parse_stream_context_from_last_main_turn(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.jsonl"
            events = [
                {"type": "system", "subtype": "init", "session_id": "S"},
                {"type": "assistant", "session_id": "S", "parent_tool_use_id": None, "message": {"usage": {
                    "input_tokens": 1, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 10,
                    "output_tokens": 5}}},
                {"type": "assistant", "session_id": "S", "parent_tool_use_id": "sub", "message": {"usage": {
                    "input_tokens": 1, "cache_read_input_tokens": 99999}}},
                {"type": "result", "session_id": "S", "result": "done", "is_error": False, "total_cost_usd": 0.5,
                 "num_turns": 2, "usage": {"input_tokens": 2}},
            ]
            path.write_text("\n".join(json.dumps(e) for e in events) + "\nnot json\n")
            info = s.parse_stream(path)
            self.assertEqual((info["session_id"], info["context_tokens"], info["cost_usd"], info["result"]),
                             ("S", 116, 0.5, "done"))


# --------------------------------------------------------------------------
# Scheduler with a fake claude and a throwaway repository

FAKE_CLAUDE = textwrap.dedent("""\
    #!/usr/bin/env python3
    # Fake claude: appends its argv to $FAKE_CLAUDE_CALLS and behaves per
    # $FAKE_CLAUDE_MODE: ok | limit | crash | sleep.
    import json, os, sys, time
    args = sys.argv[1:]
    with open(os.environ["FAKE_CLAUDE_CALLS"], "a") as f:
        f.write(json.dumps({"argv": args, "cwd": os.getcwd()}) + "\\n")
    mode = os.environ.get("FAKE_CLAUDE_MODE", "ok")
    sid = args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
    def emit(ev):
        ev.setdefault("session_id", sid)
        print(json.dumps(ev), flush=True)
    if mode == "crash":
        print("boom", file=sys.stderr)
        sys.exit(1)
    if mode == "sleep":
        time.sleep(float(os.environ.get("FAKE_CLAUDE_SLEEP", "30")))
    emit({"type": "system", "subtype": "init"})
    if mode == "limit":
        emit({"type": "result", "subtype": "success", "is_error": True, "api_error": "usage_limit_reached",
              "result": "You've hit your session limit · resets 3am (UTC)", "total_cost_usd": 0})
        sys.exit(1)
    ctx = int(os.environ.get("FAKE_CLAUDE_CONTEXT", "1000"))
    emit({"type": "assistant", "parent_tool_use_id": None,
          "message": {"usage": {"input_tokens": 10, "cache_read_input_tokens": ctx - 10, "output_tokens": 0}}})
    emit({"type": "result", "subtype": "success", "is_error": False, "total_cost_usd": 0.25, "num_turns": 1,
          "result": os.environ.get("FAKE_CLAUDE_RESULT", "Did the thing.\\nHANDOFF: pr-ready"),
          "usage": {"input_tokens": 10}})
""")


class FakeGitHub:
    def __init__(self, snapshot):
        self.snap = snapshot
        self.writes = []

    def snapshot(self):
        return self.snap

    def pm_comments(self, since):
        return []

    def rerun_failed(self, run_id):
        self.writes.append(("rerun", run_id))

    def set_status(self, issue, status, remove):
        self.writes.append(("status", issue, status))

    def comment(self, number, body):
        self.writes.append(("comment", number, body))


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


class SchedulerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo = root / "repo"
        git("init", "-q", "--bare", "-b", "master", str(root / "origin.git"), cwd=root)
        git("clone", "-q", str(root / "origin.git"), str(self.repo), cwd=root)
        for args in (("config", "user.email", "t@example.com"), ("config", "user.name", "t")):
            git(*args, cwd=self.repo)
        (self.repo / ".claude" / "agents").mkdir(parents=True)
        (self.repo / ".claude" / "agents" / "issue-worker.md").write_text(
            "---\nname: issue-worker\ndescription: Works one issue.\n---\n\nYou implement one issue.\n")
        (self.repo / ".gitignore").write_text(".pm/\n.claude/worktrees/\n")
        git("add", ".gitignore", ".claude/agents/issue-worker.md", cwd=self.repo)
        git("commit", "-q", "-m", "init", cwd=self.repo)
        git("push", "-q", "origin", "HEAD:master", cwd=self.repo)
        git("switch", "-q", "-c", "feat/x-2", cwd=self.repo)
        git("commit", "-q", "--allow-empty", "-m", "pr", cwd=self.repo)
        git("push", "-q", "origin", "feat/x-2", cwd=self.repo)
        git("switch", "-q", "master", cwd=self.repo)
        git("branch", "-q", "-D", "feat/x-2", cwd=self.repo)
        fake = root / "claude"
        fake.write_text(FAKE_CLAUDE)
        fake.chmod(0o755)
        self.calls = root / "calls.jsonl"
        self.env = {"FAKE_CLAUDE_CALLS": str(self.calls), "FAKE_CLAUDE_MODE": "ok"}
        self.old_env = {k: os.environ.get(k) for k in list(self.env) + ["FAKE_CLAUDE_CONTEXT", "FAKE_CLAUDE_RESULT"]}
        os.environ.update(self.env)
        self.gh = FakeGitHub(snap([issue(1)]))
        self.sched = s.Scheduler(self.repo, github=self.gh, claude_bin=str(fake), log_dir=root / "logs",
                                 out=io.StringIO())
        self.sched.housekeeping = lambda: None

    def tearDown(self):
        for k, v in self.old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for run in self.sched.state["running"].values():
            try:
                os.killpg(run["pid"], 9)
            except (OSError, TypeError):
                pass
        self.tmp.cleanup()

    def calls_made(self):
        if not self.calls.exists():
            return []
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def wait_idle(self):
        deadline = time.time() + 20
        while self.sched.state["running"] and time.time() < deadline:
            time.sleep(0.05)
            self.sched.reap()
        self.assertEqual(self.sched.state["running"], {})

    def events(self, kind):
        log = self.sched.event_log
        return [e for e in map(json.loads, log.read_text().splitlines()) if e["event"] == kind] if log.exists() else []

    def disable_planner(self):
        self.sched.state["planner"]["last_start"] = s.iso(s.now_utc())

    def test_launch_records_session_then_resumes_in_same_worktree(self):
        self.disable_planner()
        self.sched.poll()
        self.wait_idle()
        call = self.calls_made()[0]
        argv = call["argv"]
        self.assertEqual(argv[argv.index("--agent") + 1], "issue-worker")
        self.assertIn("--session-id", argv)
        self.assertNotIn("--resume", argv)
        self.assertEqual(Path(call["cwd"]).name, "issue-1")
        self.assertIn(("status", 1, "status:in-progress"), self.gh.writes)
        agents = json.loads(Path(argv[argv.index("--agents") + 1]).read_text())
        self.assertEqual(agents["issue-worker"]["prompt"], "You implement one issue.")
        sess = self.sched.state["sessions"]["worker:1"]
        first_sid = argv[argv.index("--session-id") + 1]
        self.assertEqual((sess["session_id"], sess["context_tokens"], sess["handoff"]["state"]),
                         (first_sid, 1000, "pr-ready"))
        self.assertTrue(json.loads(self.sched.state_path.read_text())["sessions"]["worker:1"])

        # Review requested changes: the same session resumes in the same worktree.
        self.gh.snap = snap([issue(1, status="status:in-review")],
                            [pr(10, 1, head="a" * 40, reviews=[review("changes", "a" * 40)])])
        self.sched.poll()
        self.wait_idle()
        call = self.calls_made()[1]
        self.assertEqual(call["argv"][call["argv"].index("--resume") + 1], first_sid)
        self.assertEqual(Path(call["cwd"]).name, "issue-1")
        self.assertIn("requested changes", call["argv"][call["argv"].index("-p") + 1])
        self.assertEqual([e["event"] for e in map(json.loads, self.sched.event_log.read_text().splitlines())
                          if e["event"] in ("fresh", "resume")], ["fresh", "resume"])

    def test_large_context_starts_fresh_seeded_with_report(self):
        self.disable_planner()
        os.environ["FAKE_CLAUDE_CONTEXT"] = "200000"
        os.environ["FAKE_CLAUDE_RESULT"] = "Implemented X; PR #10.\nHANDOFF: pr-ready"
        self.sched.poll()
        self.wait_idle()
        self.gh.snap = snap([issue(1, status="status:in-review")],
                            [pr(10, 1, head="a" * 40, reviews=[review("changes", "a" * 40)])])
        self.sched.poll()
        self.wait_idle()
        argv = self.calls_made()[1]["argv"]
        self.assertNotIn("--resume", argv)
        self.assertIn("> Implemented X; PR #10.", argv[argv.index("-p") + 1])
        self.assertIn("200000 >= 150000", self.events("fresh")[-1]["why"])

    def test_worker_on_existing_pr_branch(self):
        self.disable_planner()
        self.gh.snap = snap([issue(2, status="status:in-review")],
                            [pr(10, 2, head="a" * 40, reviews=[review("changes", "a" * 40)])])
        self.sched.poll()
        self.wait_idle()
        wt = self.repo / ".claude" / "worktrees" / "issue-2"
        head = subprocess.run(["git", "symbolic-ref", "--short", "HEAD"], cwd=wt, capture_output=True, text=True)
        self.assertEqual(head.stdout.strip(), "feat/x-2")

    def test_usage_limit_stops_launches_and_keeps_session(self):
        self.disable_planner()
        self.sched.poll()
        self.wait_idle()  # first run ok: session has context
        os.environ["FAKE_CLAUDE_MODE"] = "limit"
        self.gh.snap = snap([issue(1, status="status:in-review")],
                            [pr(10, 1, head="a" * 40, reviews=[review("changes", "a" * 40)])])
        self.sched.poll()
        self.wait_idle()
        until = s.parse_iso(self.sched.state["limit_until"])
        self.assertGreater(until, s.now_utc())
        self.assertEqual(until.minute, 2)  # 3am + the 2-minute margin
        sess = self.sched.state["sessions"]["worker:1"]
        self.assertEqual(sess["interrupted"], "usage limit")
        self.assertTrue(sess["session_id"])
        n = len(self.calls_made())
        self.sched.poll()
        self.assertEqual(len(self.calls_made()), n)
        self.assertIn("usage limit", self.sched.state["blocked_by"])
        # After the reset the interrupted session resumes with a note.
        os.environ["FAKE_CLAUDE_MODE"] = "ok"
        self.sched.state["limit_until"] = s.iso(s.now_utc() - dt.timedelta(seconds=1))
        self.sched.poll()
        self.wait_idle()
        argv = self.calls_made()[-1]["argv"]
        self.assertIn("--resume", argv)
        self.assertIn("interrupted (usage limit)", argv[argv.index("-p") + 1])
        self.assertNotIn("interrupted", self.sched.state["sessions"]["worker:1"])

    def test_three_failures_back_off_then_block_the_issue(self):
        self.disable_planner()
        os.environ["FAKE_CLAUDE_MODE"] = "crash"
        for attempt in range(1, 4):
            self.sched.state["failures"].get("worker:1", {}).pop("next_allowed", None)
            self.sched.poll()
            self.wait_idle()
            self.assertEqual(self.sched.state["failures"]["worker:1"]["count"], attempt)
            if attempt == 1:
                n = len(self.calls_made())
                self.sched.poll()  # backing off: no relaunch
                self.assertEqual(len(self.calls_made()), n)
        self.assertIn(("status", 1, "status:blocked"), self.gh.writes)
        self.assertTrue(any(w[0] == "comment" and w[1] == 1 for w in self.gh.writes))
        self.assertIn("worker:1", self.sched.state["gave_up"])
        self.assertTrue(any("gave up on worker:1" in r for r in self.sched.state["planner"]["pending"]))

    def test_reconcile_adopts_live_jobs_and_finishes_dead_ones(self):
        marker = "sched-20261021T000000Z-worker-7"
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", marker],
                                start_new_session=True)
        try:
            log = Path(self.tmp.name) / "dead.jsonl"
            log.write_text(json.dumps({"type": "result", "result": "x\nHANDOFF: done", "is_error": False,
                                       "session_id": "D"}) + "\n")
            base = {"role": "issue-worker", "started": s.iso(s.now_utc()), "mode": "fresh", "claims": [],
                    "locks": [], "trigger": "t"}
            self.sched.state["running"] = {
                "live": dict(base, key="worker:7", marker=marker, pid=proc.pid, issue=7, log=str(log)),
                "launching": dict(base, key="worker:7b", marker=marker, pid=None, issue=7, log=str(log)),
                "dead": dict(base, key="worker:8", marker="sched-gone", pid=proc.pid, issue=8, log=str(log)),
            }
            self.sched.reconcile()
            running = self.sched.state["running"]
            self.assertEqual(sorted(running), ["launching", "live"])
            self.assertEqual(running["launching"]["pid"], proc.pid)  # found by its marker
            self.assertEqual(self.sched.state["sessions"]["worker:8"]["handoff"]["state"], "done")
            # A live job is never relaunched: its claims hold.
            running["live"]["claims"] = ["issue:7"]
            self.gh.snap = snap([issue(7, status="status:in-progress")])
            self.disable_planner()
            self.sched.poll()
            self.assertEqual(self.calls_made(), [])
        finally:
            proc.kill()
            proc.wait()

    def test_cleanup_waits_for_running_job_and_complete_snapshot(self):
        self.disable_planner()
        self.sched.poll()
        self.wait_idle()
        wt = self.repo / ".claude" / "worktrees" / "issue-1"
        self.assertTrue(wt.is_dir())
        # Snapshot without issue 1 but marked incomplete: nothing is collected.
        partial = snap([])
        partial.complete = False
        self.sched.cleanup_closed(partial)
        self.assertTrue(wt.is_dir())
        # A job still running on it: kept.
        self.sched.state["running"]["x"] = {"key": "worker:1", "worktree": str(wt)}
        self.sched.cleanup_closed(snap([]))
        self.assertTrue(wt.is_dir())
        del self.sched.state["running"]["x"]
        # Closed (e.g. while the scheduler was down): worktree and session go.
        self.sched.cleanup_closed(snap([]))
        self.assertFalse(wt.exists())
        self.assertNotIn("worker:1", self.sched.state["sessions"])

    def test_gocache_clear_waits_for_running_jobs(self):
        sched = self.sched
        del sched.housekeeping  # use the real one, with its side effects stubbed
        cleared = []
        sched.sync_main_checkout = lambda: None
        sched.refresh_env_file = lambda: None
        sched.remove_orphan_stacks = lambda: None
        sched.gocache_size = lambda: 50 * 1024 ** 3
        sched.sh = lambda cmd, timeout=600: cleared.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", "")
        sched.state["running"]["x"] = {"key": "worker:9", "claims": [], "locks": [], "marker": "m", "pid": None,
                                       "log": "/nonexistent", "started": s.iso(s.now_utc())}
        sched.housekeeping()
        self.assertEqual(sched.state["maintenance"], "gocache")
        self.assertFalse(any("go clean" in c for c in cleared))
        sched.reap = lambda: 0
        self.disable_planner()
        sched.poll()  # maintenance blocks launches
        self.assertEqual(self.calls_made(), [])
        self.assertEqual(sched.state["blocked_by"], "maintenance: gocache")
        del sched.state["running"]["x"]
        sched.housekeeping()
        self.assertTrue(any("go clean -cache" in c for c in cleared))
        self.assertIsNone(sched.state["maintenance"])

    def test_pause_and_stop_files(self):
        self.disable_planner()
        (self.repo / ".pm").mkdir(exist_ok=True)
        (self.repo / ".pm" / "PAUSE").touch()
        self.sched.poll()
        self.assertEqual(self.calls_made(), [])
        (self.repo / ".pm" / "PAUSE").unlink()
        (self.repo / ".pm" / "STOP").touch()
        self.assertEqual(self.sched.run(), 0)  # nothing running: exits
        self.assertEqual(self.calls_made(), [])

    def test_queue_files_become_special_jobs(self):
        self.disable_planner()
        qdir = self.repo / ".pm" / "queue"
        qdir.mkdir(parents=True)
        (qdir / "hunt-sync.json").write_text(json.dumps({"role": "bug-hunter", "brief": "Focus: sync under faults"}))
        (qdir / "bad.json").write_text(json.dumps({"role": "issue-worker", "brief": "x"}))
        self.gh.snap = snap([])
        self.sched.poll()
        self.wait_idle()
        self.assertTrue((qdir / "bad.invalid").exists())
        self.assertFalse((qdir / "hunt-sync.json").exists())
        argv = self.calls_made()[0]["argv"]
        self.assertEqual(argv[argv.index("--agent") + 1], "bug-hunter")
        self.assertIn("Focus: sync under faults", argv[argv.index("-p") + 1])
        # HANDOFF pr-ready (not incomplete/wait-pr): the special is done.
        self.assertEqual(self.sched.state["specials"], {})

    def test_planner_runs_on_triggers_in_reserved_slot(self):
        self.gh.snap = snap([issue(n) for n in range(1, 8)] + [issue(50, status="status:triage")])
        self.sched.poll()
        self.wait_idle()
        roles = [c["argv"][c["argv"].index("--agent") + 1] if "--agent" in c["argv"] else "planner"
                 for c in self.calls_made()]
        self.assertEqual(roles.count("issue-worker"), 5)
        self.assertEqual(roles.count("planner"), 1)
        planner = [c for c in self.calls_made() if "--agent" not in c["argv"]][0]
        prompt = planner["argv"][planner["argv"].index("-p") + 1]
        self.assertIn("triage #50", prompt)
        self.assertEqual(Path(planner["cwd"]), self.repo)
        self.assertEqual(self.sched.state["planner"]["pending"], [])
        # Seen triage issues do not re-trigger it.
        self.sched.poll()
        self.assertEqual(len([c for c in self.calls_made() if "--agent" not in c["argv"]]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
