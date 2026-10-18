import { Code, ConnectError } from "@connectrpc/connect";

/** The Connect code of `error`, or undefined if it is not a ConnectError. */
export function errorCode(error: unknown): Code | undefined {
  return error instanceof ConnectError ? error.code : undefined;
}
