import { Plugin } from "obsidian";

import { PROTOCOL_VERSION } from "./core/version";

export default class VaultSyncPlugin extends Plugin {
  override onload(): void {
    console.debug(`vault-sync loaded (protocol v${String(PROTOCOL_VERSION)})`);
  }
}
