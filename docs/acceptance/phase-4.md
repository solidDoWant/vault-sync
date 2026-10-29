# Phase 4 acceptance checklist: end-to-end encryption

Owner-approved on 2026-10-29. **This list is the definition of done for Phase 4. Only the owner adds to it or changes it.**

Phase 4 is done when:
- every scenario below passes as an automated test on `master` (named `[P4-nn] …`), apart from P4-18, which the owner signs off;
- a security review focused on the cryptography and a narrow bug hunt have run, and their critical and high findings are fixed;
- the release is cut.

Design: `docs/design/encryption.md` and `docs/design/crypto.md`.

| Id | Scenario |
|---|---|
| P4-01 | Creating a vault offers end-to-end encryption. Escrow defaults to the server's configured default (on unless configured otherwise) and can be turned off. The server's database and S3 then hold only ciphertext for contents and paths. |
| P4-02 | A second device of the same user unlocks with the passphrase and syncs the encrypted vault. Edits, merges (AC-11), conflict copies (AC-12), renames and deletes behave exactly as in a plaintext vault. |
| P4-03 | A wrong passphrase is refused, and repeated wrong attempts are rate-limited. |
| P4-04 | Changing the passphrase keeps every unlocked device working. A new device needs the new passphrase. |
| P4-05 | An invited user redeems a code and can read the whole vault, history included, without any other member being online. |
| P4-06 | A revoked or expired invitation's code no longer grants the vault's keys. |
| P4-07 | Removing a member rotates the vault key, and the removed member can't decrypt anything committed afterwards. |
| P4-08 | An owner rotates the vault key by hand. Other devices pick up the new key on their next sync, commits in flight under the old key are retried and land, and two rotations at once leave exactly one new key. |
| P4-09 | Re-encrypting history: afterwards no revision uses an older key, and the old keys are retired. Editing continues meanwhile. Two runs at once, or a rotation during a run, still end with every revision on the newest key. |
| P4-10 | Converting a plaintext vault to encrypted in place keeps its history and its members. It requires every member to have encryption set up. After the switch, plaintext commits are refused, and history is re-encrypted. |
| P4-11 | The export job decrypts an escrowed encrypted vault to plaintext. A vault without escrow is skipped and reported. |
| P4-12 | Rotating the deployment's escrow key with the export job re-wraps every escrow slot (including vaults deleted within 30 days). A slot wrapped to the old key during the switch is caught. The old key can then be retired, and an escrow slot opens with the standard `age` tool. |
| P4-13 | The import tool imports Markdown into an encrypted vault, using the escrow key or the user's passphrase. |
| P4-14 | Lost passphrase: devices keep their local files, the server's copy stays unreadable without escrow, and the documented escrow recovery restores an escrowed vault. |
| P4-15 | Unlocking takes no more than a few seconds on the Android emulator, with Argon2id at 64 MiB and 3 passes, using WebAssembly SIMD where available. |
| P4-16 | The server never receives plaintext contents, paths, vault keys, passphrases or private keys. A test checks the database, S3 and the logs after the scenarios above. |
| P4-17 | Every key wrapping uses the hybrid post-quantum scheme (X25519 + ML-KEM-768). Cross-language test vectors pass in Go and TypeScript. |
| P4-18 | "How encryption works" (`docs/encryption.md`) is approved by the owner. |

## Out of scope for Phase 4

Live co-editing (Phase 5); revoking a single lost device's user key (rotate the vault key instead); per-vault passphrases; an external crypto audit.
