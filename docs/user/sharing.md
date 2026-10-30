# Sharing

For: people who use the Obsidian plugin. You have [connected a vault](getting-started.md).

This page explains roles, how to invite someone, how to join a vault, how to leave one, and how to delete one.

## Roles

A vault can have up to 100 members. Each member has a role:

| Role | Can do |
|---|---|
| Owner | Read and change notes. Manage members and invitations. Delete the vault. |
| Editor | Read and change notes. |
| Viewer | Read notes only. The server refuses a viewer's changes. |

A vault always has at least one owner.

The **Sharing** section of the settings shows your role in the connected vault. A role change takes effect at the member's next sync. The member does not have to sign in again.

## Manage members (owners)

Owners see the list of **Members**, oldest first, with each member's name, role, and when they joined.

- To change a role, choose a new one in the dropdown, and confirm.
- To remove a member, click **Remove**, and confirm.

You cannot demote or remove the last owner. A notice says so, and the list does not change. If the server refuses a change for another reason, a notice shows the server's message.

A removed member can no longer sync or read the vault. Their changes and the history stay. What they saw before, they can keep: the files stay on their devices. In an encrypted vault, everything saved after the removal uses a new key that they never get (see [Encryption](encryption.md)).

## Invite someone (owners)

1. In **Invite someone**, choose a role.
2. Enter how many days the invitation lasts, from 1 to 30. The default is 7.
3. Create the invitation. The code shows once, with **Copy code**. The server keeps only a scrambled form of the code, so it cannot show it again.
4. Give the code to the person over a channel that you trust.

Anyone who has the code can join until it is used, revoked or expired. A vault can have at most 100 open invitations.

**Invitations** lists the open ones, each with its role, when it was made and when it expires, and **Revoke**.

In an encrypted vault, the invitation carries the keys, so the new member can read the whole vault and its history. No other member has to be online.

## Join a vault

The plugin syncs the whole Obsidian vault that it runs in. To keep a shared vault apart from your own notes, first make or open another Obsidian vault and install vault-sync there.

1. Open **Settings → Vault Sync → Remote vault**.
2. Paste the code into **Join with an invite code**, and click **Join**.
3. If the Obsidian vault already has files, the plugin asks before it combines them (see [Getting started](getting-started.md#when-both-sides-already-have-files)).

The code works once. The plugin connects the Obsidian vault to the vault that you joined, with the role in the invitation.

If the code is wrong, expired, revoked or already used, a message says so. If you are already a member, the code is not used: choose the vault under **Connect to an existing vault**.

The plugin never logs or stores invite codes.

## As a viewer

While you are a viewer:

- Notes open read-only in reading view, with a banner that says the vault is shared with you as a viewer.
- The plugin refuses to create, rename or delete files, and shows a notice.
- The device only downloads. It never uploads anything.

If a file changes anyway (outside Obsidian, for example), the plugin moves your version to `.vault-sync/local-copies/`, at the same path, and restores the shared version. A notice says where your version is. New files are moved there too, and a deleted or renamed file is restored. `.vault-sync/` never syncs. When you become an editor, the device syncs normally, and `local-copies` stays as it is.

## Leave a vault

**Leave vault** is in the **Sharing** section. After you confirm, your membership ends:

- Sync stops, and the status shows `no longer a member`. Your files stay.
- The vault stays connected. To join again, you need a new invitation.

The last owner cannot leave. Make another member an owner first, then leave.

## When you lose access

If an owner removed you, you left on another device, or an owner deleted the vault, the device finds out at its next sync. Sync of that vault stops, your files stay, and the status shows `no longer a member` or `vault deleted`. Sync starts again only after you disconnect and connect the vault again (with access back), or restart Obsidian.

## Delete a vault (owners)

**Delete vault** asks you to type the vault's name exactly. Then it deletes the vault on the server for every member. The plugin has no undo. The server keeps the data for 30 days. In that time, only your admin can restore it, so ask your admin. Every member's local files stay.

## Fingerprints in an encrypted vault

In an encrypted vault, the **Sharing** section also shows **Fingerprints**. A fingerprint is a short code that identifies a key. Compare fingerprints with the other members over another channel, in person or by phone, to make sure that you all hold the same keys.

- Every member sees the **vault fingerprint**: 64 hex digits in groups of four. If your admin ever restores the vault from a backup, they need it.
- Owners also see each member's **key fingerprint** in the member list, in groups of four characters.

The server cannot fake these fingerprints. If a fingerprint is different from what its owner sees on their own device, someone's key was swapped. While your key is locked on this device, the lists show no fingerprints, and the section says why. A member with no key is marked as such.

For owners, [Encryption](encryption.md#for-owners-of-an-encrypted-vault) explains **Rotate key**, **Re-encrypt history** and **Convert to end-to-end encryption**.
