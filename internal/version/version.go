// Package version reports the build version of vault-sync binaries.
package version

// version is stamped at build time with
// -ldflags "-X github.com/solidDoWant/vault-sync/internal/version.version=...".
var version = ""

// String returns the build version, or "unknown" for unstamped builds.
func String() string {
	if version == "" {
		return "unknown"
	}

	return version
}
