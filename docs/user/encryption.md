# End-to-end encryption

For: people who use the Obsidian plugin. You have [signed in](getting-started.md). You do not need to know how encryption works.

This page says what end-to-end encryption protects, how to set it up, what your recovery passphrase is for, and what happens if you forget it.

End-to-end encrypted vaults cannot sync yet. You can set up your key, and you can create an encrypted vault, but you cannot connect to one. This page describes how encryption works once sync of encrypted vaults is ready.

## In short

- Encryption is a choice for each vault. In an encrypted vault, your device encrypts your notes, attachments and file names before upload. A vault without encryption is a plaintext vault.
- You have one **recovery passphrase** for all your encrypted vaults. You enter it once on each device.
- Your passphrase never leaves your device. If you forget it, nobody can get your encrypted notes back from the server, not even your admin, unless the vault has **escrow**. Write it down.
- Conflicts, renames, deletes and history work in an encrypted vault exactly as in a plaintext vault.

## What the server cannot see, and what it can

In an encrypted vault, the server cannot read your files, their older versions, the names of files and folders, your keys or your passphrase.

The server can still see the vault's name, its members, their roles and devices, and whether the vault uses encryption and escrow. It also sees how many files there are, the exact size of each version, about how long each path is, and when and from which device each file changes. It can tell when two versions belong to the same file, or when two attachments have the same content, but not their names or content.

For the full list, see [Encryption for operators](../admin/encryption.md#what-the-server-can-and-cannot-see).

## Set up encryption

Open **Settings → Vault Sync → End-to-end encryption**. It shows one of four states.

### Not enabled

1. Click **Enable**.
2. Enter a new recovery passphrase twice. It must have at least 10 characters.
3. Write the passphrase down, and keep it in a safe place.

Your device creates your key and locks it with the passphrase. The server gets only the locked key. Choose a long passphrase that you do not use anywhere else. Someone who steals a copy of the server's data can try to guess it, and a long passphrase makes that impossible in practice.

### Enabled on another device

Click **Unlock** and enter your passphrase. This takes about a second on a desktop and several seconds on a phone. One unlock opens every encrypted vault that you belong to, until you sign out.

If the passphrase is wrong, the plugin says "The passphrase is wrong." After 10 wrong passphrases in an hour, from any of your devices, the server refuses every try, even with the right passphrase, until the hour is over. The dialog shows when you can try again.

If two devices enable encryption at the same moment, the server keeps the first key. If the second device then reports a wrong passphrase, unlock it with the passphrase that you chose on the first device.

### Unlocked

**Change passphrase** asks for the current passphrase once and a new one twice. Unlocked devices keep working. A device that unlocks later needs the new passphrase. A wrong current passphrase counts against the same limit of 10 an hour.

An older backup of the server still holds your key locked with the old passphrase. So if your passphrase leaked, a new passphrase protects you against the live server only.

### Key changed

The server now has a different key for your account than this device has, for example after the server was reset. Click **Unlock** and enter the passphrase of the key on the server.

## Create an encrypted vault

When you create a vault (see [Getting started](getting-started.md#connect-a-vault)), turn on **End-to-end encryption**. Your key must be unlocked on this device. You choose this once, when you create the vault. You can also convert a plaintext vault later (see below).

## Escrow

Escrow gives your admin's backup a way to read the vault. With escrow, your admin can:

- make plaintext backups of the vault
- restore the vault if every member loses their passphrase.

Without escrow, only the members can read the vault, and former members what they saw while members. Nothing can recover it if every member loses their passphrase and every device.

**Escrow** is on by default unless your admin changed the default. You can turn it off when you create a vault. It is not offered when the server has no escrow key. The settings show whether a vault has escrow.

If an owner turns escrow off later, new changes are no longer readable by the backup. Older versions stay readable by it until the owner re-encrypts the history.

### The escrow fingerprint

The escrow fingerprint is a short code that identifies the server's escrow key. It has eight groups of four characters, for example `7Z1Z Z8ND Z01N DEDJ AYZY KQZ8 R7YY 9X99`. Your device remembers the escrow key that it saw first on this server. The plugin always shows the fingerprint of that remembered key, not only the key that the server offers now.

The plugin shows the escrow fingerprint in two places:

- Under the **Escrow** toggle, when you create a vault.
- In the **Fingerprints** line of the **Sharing** section, for a vault with escrow. If your device remembers a different escrow key than the vault uses, the plugin shows both fingerprints, each with its label.

Your admin can publish the fingerprint, for example on an internal web page. Compare the two before you create a vault with escrow:

1. Get the fingerprint from your admin over a channel that you trust, for example your company's intranet or in person.
2. Compare it, group by group, with the fingerprint that the plugin shows.
3. If they are different, do not turn on escrow, and tell your admin. A different fingerprint can mean that someone swapped the escrow key.

### When the escrow key changes

Your admin can replace the escrow key. Usually the old key signs the change, and your device accepts the new key without asking you. If the old key did not sign the change, your device cannot prove that the new key comes from your admin. Then the plugin asks you. This also happens when someone who controls the server swaps the key.

The plugin opens the **The server's escrow key changed** window when you open the settings to create a vault, or when you look at the **Sharing** section of a vault with escrow that you own. The window shows the fingerprint of the previous key and the fingerprint of the new key. To answer it:

1. Get the escrow fingerprint from your admin over a channel that you trust.
2. Compare it, group by group, with the new fingerprint in the window.
3. If they are the same, type the last group of the new fingerprint (four characters) and select **Accept the new escrow key**.
4. If they are different, select **Decline**, and tell your admin.

If you accept, the keys of the vaults that you own are also encrypted to the new escrow key from now on, and new vaults use it. Each of your devices asks you on its own.

If you decline, or close the window, escrow keeps the previous key. Your notes keep syncing. Your vaults with escrow show "Escrow uses the previous key: the server's escrow key changed", with a **Review the change** button that opens the window again. You cannot create or convert a vault with escrow until you accept. The plugin does not ask again by itself, unless the server offers another new key.

For more detail, see [Encryption for operators](../admin/encryption.md#escrow).

## If you forget your passphrase

- **Your devices keep your files.** Every unlocked device keeps your key and your files, and keeps syncing until you sign out. Do not sign out of your last unlocked device.
- **Without escrow**, the server's copy of a vault that no other member can open is lost. Nobody can decrypt it, not even your admin.
- **With escrow**, ask your admin. They can give you a plaintext copy of the vault, or restore it into an encrypted vault. For that, they need the vault fingerprint from a member (see [Sharing](sharing.md#fingerprints-in-an-encrypted-vault)).

Other members of a shared vault keep their own keys and passphrases.

## For owners of an encrypted vault

Each encrypted vault has a key. The key changes over time. When it changes, your devices get the new key at their next sync.

- **Removing a member** changes the key at once. The removed member never gets the new key. They keep what they read before.
- **When a member leaves**, the key changes the next time an owner's device syncs. Until then, the member who left still has the current key.
- **Rotate key** changes the key by hand. It is in **Advanced**, under the vault's name. Confirm to start it. If another owner rotates at the same moment, only one new key is made.

Older versions stay encrypted with older keys. **Re-encrypt history**, next to **Rotate key**, encrypts them again with the newest key, and then the server deletes the older keys. Sync and editing continue while it runs. If it stops, run it again, and it continues where it stopped. Old backups of the server still hold the older keys.

### Convert a plaintext vault

Owners of a plaintext vault see **Convert to end-to-end encryption** in the **Sharing** section. Members, notes and history are kept.

1. Make sure that every member set up encryption, and revoke all open invitations. If not, the plugin lists what is missing.
2. The plugin lists every member with the fingerprint of their key. Compare each one with that member over a channel that you trust, for example in person.
3. Confirm that you compared them, choose escrow if the server offers it, and convert.
4. Run **Re-encrypt history**. The notice after the conversion has a **Show Re-encrypt history** button. Until it finishes, the server still holds the old versions as plaintext.

Plaintext backups made before the conversion stay plaintext.

## What encryption does not protect

- **Withheld or old changes.** A server that misbehaves can hold back changes, deliver them late, show an older version of a file, or stop serving the vault. It cannot slip in a key or a member: if it tries, the status shows `stopped: key data doesn't verify` (see [Troubleshooting](troubleshooting.md)).
- **Who wrote a change.** The names in the history come from the server. Encryption does not prove them.
- **A device that someone else controls**, and **members**: every member can read the whole vault and keep copies.
- **File names after a removal.** A removed member who later gets a copy of the server's data can test whether a file with a name that they guess exists. They cannot read the names that exist.
- **Old backups.** Backups of the server keep old keys and your key locked with any old passphrase.

Admins find the full threat model in [Security model](../admin/security.md#threat-model-for-encrypted-vaults).
