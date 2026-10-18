/**
 * Reports whether `path` is vault-relative on every supported platform
 * (SPEC.md §6.2): "/" and "\" are both separators; the path must not start
 * with a separator (which also rules out UNC, `\\?\` and `\\.\` prefixes) or
 * with a drive letter and colon (`C:`, `C:x`, `C:\x`, `C:/x`); and no segment
 * may be empty or made only of dots and spaces (`.`, `..`, and forms such as
 * `.. ` or `...` that Windows reduces to them). Names that are merely
 * unmaterializable on Windows (`CON.md`, `ab:c.md`, trailing dots or spaces)
 * are accepted. Length and character-set limits are not checked here.
 *
 * Must match internal/vaultpath (Go) exactly; testdata/paths/validity.json is
 * the shared conformance suite. Every path received from the server, including
 * E2EE paths after decryption, must pass this before it touches the disk.
 */
export function isVaultRelativePath(path: string): boolean {
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split(/[/\\]/).every((segment) => !/^[. ]*$/.test(segment));
}
