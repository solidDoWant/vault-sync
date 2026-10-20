#!/usr/bin/env bash
# Refreshes vendorHash in nix/server.nix after go.mod or go.sum changed
# (make update-vendor-hash). Nix pins the hash of the vendored Go module
# dependencies, so the image build (make build-images, the release-artifacts
# CI job) fails until it matches go.sum again.
#
# The hash is set to lib.fakeHash, the module derivation is built so Nix
# reports the real hash, and that hash is written back and checked with a
# second build. On any failure the file is restored.
#
# Needs nix and network access to download the Go modules.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

file=nix/server.nix
pattern='^(  vendorHash = )"[^"]*";$'
if [[ $(grep -cE "$pattern" "$file") -ne 1 ]]; then
	echo "update-vendor-hash: expected exactly one 'vendorHash = \"...\";' line in $file" >&2
	exit 1
fi

backup="$(mktemp)"
log="$(mktemp)"
cp "$file" "$backup"
restore=true
cleanup() {
	if $restore; then
		cp "$backup" "$file"
	fi
	rm -f "$backup" "$log"
}
trap cleanup EXIT

old="$(sed -nE 's/^  vendorHash = "([^"]*)";$/\1/p' "$file")"
sed -i.bak -E "s|${pattern}|\\1lib.fakeHash;|" "$file"
rm -f "$file.bak"

# Only the vendored-modules derivation: the server itself need not compile.
if nix build --no-link .#server.goModules >"$log" 2>&1; then
	echo "update-vendor-hash: building with lib.fakeHash unexpectedly succeeded" >&2
	exit 1
fi
new="$(sed -nE 's/^[[:space:]]*got:[[:space:]]*(sha256-[A-Za-z0-9+\/=]+)$/\1/p' "$log" | tail -n 1)"
if [[ -z $new ]]; then
	echo "update-vendor-hash: Nix reported no hash; its output:" >&2
	cat "$log" >&2
	exit 1
fi

sed -i.bak -E "s|^(  vendorHash = )lib.fakeHash;$|\\1\"${new}\";|" "$file"
rm -f "$file.bak"
if ! nix build --no-link .#server.goModules >"$log" 2>&1; then
	echo "update-vendor-hash: the module derivation does not build with ${new}; its output:" >&2
	cat "$log" >&2
	exit 1
fi
restore=false

if [[ $new == "$old" ]]; then
	echo "update-vendor-hash: vendorHash is already current (${new})"
else
	echo "update-vendor-hash: vendorHash ${old} -> ${new}"
fi
