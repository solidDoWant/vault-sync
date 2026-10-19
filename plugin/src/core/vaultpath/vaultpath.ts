/**
 * Reports whether `path` is vault-relative on every supported platform
 * (SPEC.md §6.2): "/" and "\" are both separators; the path must not start
 * with a separator (which also rules out UNC, `\\?\` and `\\.\` prefixes) or
 * with a drive letter and colon (`C:`, `C:x`, `C:\x`, `C:/x`); and no segment
 * may be empty or made only of dots and spaces (`.`, `..`, and forms such as
 * `.. ` or `...` that Windows reduces to them). Names that are merely
 * unmaterializable on Windows (`CON.md`, `ab:c.md`, trailing dots or spaces)
 * are accepted. Length and character-set limits are checked separately, by
 * {@link isPathText}.
 *
 * Must match internal/vaultpath (Go) exactly; testdata/paths/validity.json is
 * the shared conformance suite. Every path received from the server, including
 * E2EE paths after decryption, must pass this before it touches the disk.
 */
export function isVaultRelativePath(path: string): boolean {
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split(/[/\\]/).every((segment) => !/^[. ]*$/.test(segment));
}

/**
 * Reports whether a commit may create or rename a document into `path`
 * (SPEC.md §6.2): it is vault-relative, contains no "\" (decision #191) and
 * does not start with one code point and a colon (decision #148). Windows
 * reads "\" as a separator and other platforms as part of a name, so `a/b`
 * and `a\b` would otherwise be two live documents naming one file on
 * Windows; and Win32 reads any first character followed by ":" (`1:x.md`,
 * `é:x.md`) as a drive. A document committed before these rules keeps its
 * path, which still passes {@link isVaultRelativePath}; the server accepts it
 * only as the unchanged path of a live document (an edit or a delete in
 * place).
 *
 * Must match `CheckNew` in internal/vaultpath (Go) exactly, on the `new`
 * field of testdata/paths/validity.json.
 */
export function isNewVaultPath(path: string): boolean {
  // With the u flag, [^] is one code point, including a surrogate pair.
  return isVaultRelativePath(path) && !path.includes("\\") && !/^[^]:/u.test(path);
}

/** The most UTF-8 bytes a plaintext path may have (SPEC.md §6.2; MaxBytes in internal/vaultpath). */
export const maxPathBytes = 4096;

const encoder = new TextEncoder();

/** A UTF-16 surrogate that is not half of a pair: it has no UTF-8 form. */
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Reports whether `path` is 1 to {@link maxPathBytes} bytes of UTF-8 with no
 * control character (Unicode category Cc: U+0000 to U+001F and U+007F to
 * U+009F), the server's length and character-set rule for a plaintext path
 * (SPEC.md §6.2, #148). A string with a lone surrogate, which has no UTF-8
 * form, is refused. A client applies this, with
 * {@link isVaultRelativePath}, to every path it receives before it touches
 * the disk, including E2EE paths after decryption, which the server cannot
 * check.
 *
 * Must match `CheckText` in internal/vaultpath (Go) exactly;
 * testdata/paths/text.json is the shared conformance suite.
 */
export function isPathText(path: string): boolean {
  if (path === "" || loneSurrogate.test(path) || /\p{Cc}/u.test(path)) return false;
  return encoder.encode(path).length <= maxPathBytes;
}
