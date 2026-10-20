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

/**
 * The name this device goes by: the Device name setting, without invisible
 * characters (which the server refuses) and surrounding spaces, or
 * `defaultName` when that leaves nothing.
 */
export function deviceNameOf(setting: string, defaultName: string): string {
  const name = withoutInvisibleCharacters(setting).trim();
  return name === "" ? defaultName : name;
}
