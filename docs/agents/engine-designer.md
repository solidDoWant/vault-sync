# Engine designer playbook

An issue labelled `design` is engine design work, not a bug fix. The issue-worker the scheduler starts on it follows this playbook instead of the usual procedure, while still following its handoff, time-box and push rules.

Only this role changes the engine design's rules and invariants (`docs/design/engine-path-ownership.md` §4.9 and §5). A design issue batches the open `design-gap` issues: counterexamples that the current rules either do not decide or decide in conflicting ways. The job is to keep the design **small and coherent**, not to make each counterexample pass.

## Why this role exists

Until 2026-10-22, every engine fix PR could amend the rules. Each worker saw one simulation seed and made the smallest change that passed it, so the rules grew one exception at a time. On 2026-10-22, about 30 PRs edited §4.9, many adding clauses that name a single issue (`except ... (#874)`). Rules built that way conflict with each other in new combinations, the simulation finds those combinations, and the cycle repeats. This role breaks that loop.

## Procedure

1. **Load context.** Read `CLAUDE.md`, the design document in full (§3–§5, §10), `SPEC.md` §2 and §6–§8, and every `design-gap` issue linked from the design issue, with its minimized trace.
2. **Find the shared cause.** For each gap, name the invariant (INV-n) at stake and the rules (PO-n) involved: missing, silent or conflicting. Group the gaps by shared cause. Several gaps usually come from one missing concept or one rule that is too specific.
3. **Prefer generalizing to adding.** For each group, in this order:
   1. Restate an existing rule more generally, so it covers the gaps and the cases it already covered.
   2. Merge or remove rules that the generalization makes redundant.
   3. Only then add a rule.

   A rule states a principle in terms of the model's vocabulary (§3). It never names an issue, a seed or a single scenario, and never carries an `except (#n)` clause. Move the issue references and history to a changelog list at the end of §4.9. If a gap shows that an invariant itself is wrong, or that two invariants cannot both hold, stop: label the design issue `needs-human`, explain the conflict in plain words on it, and hand back `blocked`.
4. **Decide undecided behaviour by the owner's policy** (§10.3 of the design: what Obsidian Sync does, then whatever loses the least data, then whatever is simplest). Record each such product-level choice on the decision log (#52) in the usual format, citing the policy step that decided it.
5. **Rewrite the existing exception clauses.** Every PR on a `design` issue also rewrites at least the §4.9 clauses that name an issue, until none remain.
6. **Write the change as one PR.** It touches only the design document (plus `SPEC.md` where behaviour changes), not engine code. The PR body has:
   - a table of each gap → the rule or invariant that now decides it, and the expected outcome;
   - the number of §4.9 rules and the length of §4.9 in words before and after (the length should not grow without a stated reason);
   - each product decision taken under the §10.3 policy.
7. **Close the loop.** On each `design-gap` issue, comment what the design now says and set it `status:todo`; a worker then implements it under the normal fix rule. Hand back with `HANDOFF: pr-ready`.

## Rules

- Never edit engine or simulation code in a design PR.
- Never weaken an invariant to make a gap disappear. Changing an invariant's meaning requires the owner (`needs-human`).
- Never add a simulation checker exception; that remains §10.1 item 4's process.
