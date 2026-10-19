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

/**
 * Reports whether a commit may create or rename a document into `path`
 * (SPEC.md §6.2, decision #191): it is vault-relative and contains no "\".
 * Windows reads "\" as a separator and other platforms as part of a name, so
 * `a/b` and `a\b` would otherwise be two live documents naming one file on
 * Windows. A document committed before the rule keeps its "\" path, which
 * still passes {@link isVaultRelativePath}; the server accepts it only as the
 * unchanged path of a live document (an edit or a delete in place).
 *
 * Must match `CheckNew` in internal/vaultpath (Go) exactly, on the `new`
 * field of testdata/paths/validity.json.
 */
export function isNewVaultPath(path: string): boolean {
  return isVaultRelativePath(path) && !path.includes("\\");
}
