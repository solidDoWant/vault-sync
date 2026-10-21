// Device names are one user's text that other members see (#548).

const invisible = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * `name` without the characters the server refuses in device names (SPEC.md
 * §6.2): control characters, format characters (bidi embeddings, overrides,
 * isolates and marks, zero-width characters, the byte order mark) and line
 * or paragraph separators. Names registered before that rule may hold them.
 */
export function withoutInvisibleCharacters(name: string): string {
  return name.replace(invisible, "");
}

/** The longest device name the server registers, in UTF-8 bytes (SPEC.md §6.2). */
export const maxDeviceNameBytes = 256;

const encoder = new TextEncoder();

/**
 * The name this device goes by: the Device name setting, without invisible
 * characters (which the server refuses) and surrounding spaces, cut to the
 * longest start of at most maxDeviceNameBytes that ends on a whole character
 * (#557), or `defaultName` when that leaves nothing.
 */
export function deviceNameOf(setting: string, defaultName: string): string {
  const name = withinBytes(withoutInvisibleCharacters(setting).trim(), maxDeviceNameBytes).trim();
  return name === "" ? defaultName : name;
}

/** The longest start of `text`, whole code points only, whose UTF-8 encoding fits in `limit` bytes. */
function withinBytes(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += encoder.encode(character).length;
    if (bytes > limit) break;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * The server refused the name this device registers with (INVALID_ARGUMENT),
 * for example because it holds a format character this device's Unicode
 * tables do not know yet, so withoutInvisibleCharacters kept it (#557).
 */
export class DeviceNameError extends Error {
  override readonly name = "DeviceNameError";
  constructor(serverMessage: string) {
    super(`The server refused this device's name (${serverMessage}). Change the Device name setting in Vault Sync's settings; sync registers the device with the new name when it tries again.`);
  }
}
