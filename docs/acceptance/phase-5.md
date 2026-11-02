# Phase 5 acceptance checklist: live editing

Draft for owner approval (2026-11-02). **This list is the definition of done for Phase 5. Only the owner adds to it or changes it.**

Phase 5 is done when:
- every scenario below passes as an automated test on `master` (named `[P5-nn] …`), apart from P5-17, which the owner signs off;
- a security review of the live channel and a narrow bug hunt (data loss and crashes) have run, and their critical and high findings are fixed;
- the `0.5.0` release is cut.

Design: `docs/design/live-editing.md`, plus `docs/design/engine.md` for sync.

In the scenarios, "two people" are two users who are members of the vault, each on their own device. Unless a scenario says otherwise, it holds in a plaintext vault and in an encrypted vault.

| Id | Scenario |
|---|---|
| P5-01 | Two people open the same note. Each person's typing appears in the other's editor within 2 seconds. After both stop, both editors, both files and the server's head hold the same text. |
| P5-02 | Two people open the same note at the same moment and type at once, in the same line and in different lines. The text never contains the note twice, and nobody gets a conflict copy. |
| P5-03 | Three devices edit one note for several minutes. History shows ordinary revisions of the note, and restoring one of them works as it does today. |
| P5-04 | A device opens a note that it edited while offline. Its offline edits are kept, and the device then joins the session with everyone else's text. |
| P5-05 | During a session, a device that does not have the note open (or runs an older plugin) edits it. The edit appears in the open editors. If it cannot be merged, the editors keep their text and the other version becomes a conflict copy. |
| P5-06 | During a session, another plugin (`processFrontMatter`) or an external editor changes the note on one device. The change appears in the other editors. |
| P5-07 | Each person sees the other people's cursors and selections, labelled with their name and a color, and a list of who has the note open. Within 30 seconds of a person closing the note or losing the connection, their cursor and their entry disappear. |
| P5-08 | A device loses its connection during a session and types offline. Its offline edits and the others' edits merge when it reconnects, after a short outage and after a long one. |
| P5-09 | The app is killed on a device during a session, just after typing. After a restart, no edit that was typed and saved to disk on any device is missing from the note. At most one conflict copy is created. |
| P5-10 | One server replica is stopped during a session. The editors keep working after reconnecting, and no edit is lost. |
| P5-11 | Live editing works in Obsidian's emulated mobile mode, and between a mobile device and a desktop. Putting the mobile app in the background leaves the session, and returning rejoins it. |
| P5-12 | A viewer sees the live edits and cursors of others and appears in the list of people. The viewer cannot type, and the server refuses live edits from a viewer's device, even from a modified client. |
| P5-13 | The note is renamed during a session: the session continues under the new name. The note is deleted on another device during a session: the text that people are editing is kept as the note. |
| P5-14 | A member is removed during a session: they stop receiving edits and cursors at once, and the others continue. A non-member cannot join a session or send to one. |
| P5-15 | In an encrypted vault, the server's database, its logs and the frames that it relays contain no note text, cursor position or path. A key rotation during a session does not interrupt it. |
| P5-16 | Undo in the editor undoes only your own edits. |
| P5-17 | The user documentation page on live editing is approved by the owner. It states the known limits, including that a plugin which changes every open copy of a note at once can duplicate that change. |

## Out of scope for Phase 5

Live editing of files other than Markdown notes; live views of notes that are not open in an editor; per-character authorship; comments and suggestions; a "follow this user" mode; live editing with devices that run older versions.
