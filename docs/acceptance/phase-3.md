# Phase 3 acceptance checklist: vault sharing

Owner-approved on 2026-10-29. **This list is the definition of done for Phase 3. Only the owner adds to it or changes it.**

Phase 3 is done when:
- every scenario below passes as an automated test on `master` (test names start with the id, for example `[P3-01] …`; `make acceptance` reports them);
- a security review and a narrow bug hunt have run, and their critical and high findings are fixed;
- the `0.3.0` release is cut.

Design: `docs/design/sharing.md`, plus `docs/design/engine.md` for sync.

In the scenarios, "users" are different accounts on the identity provider, and each user has their own devices.

| Id | Scenario |
|---|---|
| P3-01 | An owner invites a user with a code. The user redeems it, the vault syncs to their device, and both users' edits sync both ways. |
| P3-02 | History shows which user, and which of their devices, made each change. |
| P3-03 | Two users edit the same lines: there is exactly one conflict copy, named `<name> (Conflicted copy <user> <device> <YYYYMMDDHHMM>).<ext>`. |
| P3-04 | A revoked invitation code, and an expired one, are refused with a clear message. |
| P3-05 | An owner changes a member's role (editor to viewer, and back). It takes effect on the member's devices without signing in again. |
| P3-06 | A viewer's notes open read-only, with a banner. Editing in Obsidian is blocked, and nothing is uploaded. |
| P3-07 | A viewer's file is changed outside Obsidian: the change is not uploaded, the shared version is restored, and the viewer's version is kept in `.vault-sync/local-copies/` (never synced), with a notice. |
| P3-08 | An owner removes a member: within one sync cycle, the member's devices stop syncing, keep their files, and show "no longer a member". |
| P3-09 | A member leaves a vault on their own, from the plugin: the same outcome as P3-08. |
| P3-10 | The last owner can't be demoted or leave, and is told why. Promoting another member to owner, then leaving, works. |
| P3-11 | After every other member is removed, the vault keeps working as a normal single-user vault. |
| P3-12 | An owner deletes a vault after typing its name: every member's devices stop syncing, keep their files, and show "vault deleted". The server keeps the data for 30 days, then purges it. Within those 30 days the operator can undo the deletion with `vault-sync-server vault undelete <id>`. |
| P3-13 | The server refuses access by role, whatever the client does: a non-member or a removed member can't read or write; a viewer's commits and blob uploads are refused (`PERMISSION_DENIED`), even from a client modified to send them. |

## Out of scope for Phase 3

End-to-end encryption, live co-editing, copying a note into one of your own vaults (backlog), invitations tied to a specific account (any signed-in user may redeem a code), and per-folder permissions.
