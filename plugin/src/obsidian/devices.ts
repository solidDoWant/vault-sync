import { timestampDate } from "@bufbuild/protobuf/wkt";

import type { Device } from "../gen/vaultsync/v1/types_pb";
import type { ProtocolClient } from "../core/protocol/client";
import type { PluginData } from "./data";
import { isolated, shownName } from "./display-text";

// The device list in the settings (#590): the signed-in user's devices, with
// this installation's marked, and removing another one. No Obsidian import,
// so it is unit-tested against an in-memory server; settings.ts shows it.

/** One device as the settings list it. */
export interface DeviceRow {
  id: string;
  /** The device's name as it is shown (shownName, isolated), or its id when the name shows nothing. */
  label: string;
  /** Whether it is this installation's device, which cannot be removed from here. */
  current: boolean;
  /** When it last synced (committed a change), or that it never has. */
  description: string;
}

/** The signed-in user's devices that are not removed, oldest first, as the server lists them. */
export async function listDevices(client: ProtocolClient): Promise<Device[]> {
  return (await client.devices.listDevices({})).devices;
}

/**
 * The rows of the device list. `currentId` is this installation's device
 * (data.device), unless it was removed; `formatDate` shows a time in the
 * user's locale.
 */
export function deviceRows(devices: readonly Device[], currentId: string | undefined, formatDate: (date: Date) => string): DeviceRow[] {
  return devices.map((device) => {
    const name = shownName(device.name);
    const current = device.id === currentId;
    const activity = device.lastActivityTime === undefined ? "Has not synced a change yet." : `Last synced a change ${formatDate(timestampDate(device.lastActivityTime))}.`;
    return {
      id: device.id,
      label: name === "" ? `device ${device.id.slice(0, 8)}` : isolated(name),
      current,
      description: current ? `This device. ${activity}` : activity,
    };
  });
}

/** This installation's device, unless the server removed it. */
export function currentDeviceId(data: PluginData): string | undefined {
  return data.device?.removed === true ? undefined : data.device?.id;
}

/**
 * Removes another of the user's devices (RemoveDevice). This installation's
 * own device is refused: removing it would stop this device's sync, so it is
 * removed from another device.
 */
export async function removeOtherDevice(client: ProtocolClient, data: PluginData, deviceId: string): Promise<void> {
  if (deviceId === currentDeviceId(data)) throw new Error("this device cannot remove itself; remove it from another device");
  await client.devices.removeDevice({ deviceId });
}

/**
 * The device list's removals (#625): at most one RemoveDevice per device. A
 * second request for a device whose removal is in flight, or done, is ignored
 * instead of reaching the server, which would refuse it with NOT_FOUND. A
 * failed removal can be tried again.
 */
export class DeviceRemovals {
  private readonly started = new Set<string>();

  constructor(private readonly remove: (deviceId: string) => Promise<void>) {}

  /** Whether `deviceId`'s removal is in flight or done. */
  has(deviceId: string): boolean {
    return this.started.has(deviceId);
  }

  /** Removes `deviceId`; resolves `false`, without a request, if its removal is in flight or done. */
  async start(deviceId: string): Promise<boolean> {
    if (this.started.has(deviceId)) return false;
    this.started.add(deviceId);
    try {
      await this.remove(deviceId);
    } catch (error) {
      this.started.delete(deviceId);
      throw error;
    }
    return true;
  }
}

/** Where a device list shows what its loads resolve to. */
export interface DeviceListView {
  rows(rows: DeviceRow[]): void;
  error(error: unknown): void;
}

/**
 * The ListDevices loads of one device list on screen (#634). Only the latest
 * load may paint it: an older response that resolves last, e.g. the first
 * load's after a removal reloaded the list, would show the removed device
 * again. Once closed (the list is no longer shown), it sends and paints
 * nothing.
 */
export class DeviceListLoads {
  private latest = 0;
  private closed = false;

  constructor(
    private readonly list: () => Promise<DeviceRow[]>,
    private readonly view: DeviceListView,
  ) {}

  /** Lists the devices and paints them, unless a later load was started or the list was closed by then. */
  load(): void {
    if (this.closed) return;
    const load = ++this.latest;
    const current = () => !this.closed && load === this.latest;
    void this.list().then(
      (rows) => {
        if (current()) this.view.rows(rows);
      },
      (error: unknown) => {
        if (current()) this.view.error(error);
      },
    );
  }

  /** Stops the list's loads: the ones in flight paint nothing, and later ones are not sent. */
  close(): void {
    this.closed = true;
  }
}
