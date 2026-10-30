# Devices

For: people who use the Obsidian plugin. You have [signed in](getting-started.md).

Each copy of the plugin, in each Obsidian vault on each device, is one **device** on the server. This page explains device names, the device list, and how to remove a device.

## Registration

Before its first sync, the plugin registers this device with the server, once. Restarts and new sign-ins with the same account use the same device. Another account or another server gets a new device.

You can have up to 100 devices. Every installation and every reinstall registers a new device, so remove the ones that you no longer use. When you reach the limit, the status shows `error` with a message that your account reached the server's device limit. Sync does not start on this device, and your files are not touched. Remove a device in the device list on another device.

## Device name

The **Device name** setting names this device. The name shows in the device list, in the history, and in the names of [conflict copies](conflicts-and-history.md). If it is empty, the plugin uses the platform: `Windows`, `Mac`, `Linux`, `Android` or `iOS`.

When you change the name while signed in, the plugin renames the device on the server about a second after you stop typing. The device keeps its history. If the rename fails, a notice says so, and the setting goes back to the last accepted name. A change made before the first registration completes is applied when it completes.

The plugin removes invisible characters from the name, and cuts it to 256 bytes. In conflict copies, the name is cut to 40 characters, and characters that are not allowed in file names become `-`.

If the server still refuses the name, the status says so and names the setting. Change the name, and the plugin registers the device with the new name at its next try.

## The device list

The **Devices** section lists the devices of your account, oldest first. Each entry shows the device name and when the device last synced a change, to the minute, or that it did not sync yet. This device is marked **This device**.

## Remove a device

1. On another device, open **Settings → Vault Sync → Devices**.
2. Click **Remove** next to the device, and confirm.

The removed device stops syncing at once. Its files, and its changes that did not sync yet, stay on it. Its history and its name in the history stay on the server. A device cannot remove itself.

## When this device was removed

If you removed this device from another device, its next sync is refused:

- Sync stops, a notice shows, and the status shows `device removed`.
- The plugin does not register again by itself, not even after a restart, because the removal can be on purpose.
- Your files and your changes that did not sync yet stay on this device.

To sync again, click **Register again** in the **Sync** section of the settings. The plugin registers this device as a new device, with the current device name, and pushes your waiting changes. A change that reached the server just before the removal is not pushed twice.

Signing out does not remove a device from the list (see [Getting started](getting-started.md#sign-in)).
