/** Highest sync protocol version this client speaks (SPEC.md §4.1). */
export const PROTOCOL_VERSION = 1;

/** Reports whether this client can talk to a server advertising `serverVersion`. */
export function isProtocolCompatible(serverVersion: number): boolean {
  return Number.isInteger(serverVersion) && serverVersion >= PROTOCOL_VERSION;
}
