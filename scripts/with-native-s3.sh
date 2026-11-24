#!/usr/bin/env bash
# Starts the pinned versitygw release natively as the S3-compatible store,
# exports its connection details as the VAULT_SYNC_TEST_S3_* variables
# internal/testinfra reads, runs the given command, and stops the gateway on
# exit, whether the command passes, fails, or is interrupted.
#
# For hosts without Linux containers, where scripts/with-test-stack.sh cannot
# run: the plugin e2e CI jobs on macOS and Windows (Git Bash) use it
# (docs/testing/e2e.md). The gateway is the same release, with the same
# credentials and region, as the s3 service of deploy/compose/compose.test.yaml.
#
# VERSITYGW_PORT (default 7070) is the loopback port it listens on.
# VERSITYGW_CACHE_DIR (default ${RUNNER_TEMP:-${TMPDIR:-/tmp}}/versitygw) holds
# the downloaded release archive. Its SHA-256 is checked on every run, not
# only after the download, and the executable is extracted afresh into a
# private temporary directory, so a cache another local user can write to
# cannot substitute a different binary.
#
# `with-native-s3.sh --check-pin` only checks that the pinned version is the
# versitygw image of deploy/compose/compose.test.yaml and exits; `make test`
# runs it, so a compose image bump without a matching pin here fails the
# required checks, not only the optional macOS and Windows e2e jobs.
#
# `with-native-s3.sh --update-pin vX.Y.Z` rewrites the pinned version and
# checksums from that release's checksums.txt (see below).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -eq 0 ]]; then
	echo "usage: $0 command [argument ...] | --check-pin | --update-pin version" >&2
	exit 2
fi

die() {
	echo "with-native-s3: $*" >&2
	exit 1
}

# The release assets whose SHA-256 is pinned below.
pinned_suffixes="Darwin_arm64.tar.gz Darwin_x86_64.tar.gz Linux_arm64.tar.gz Linux_x86_64.tar.gz Windows_arm64.zip Windows_x86_64.zip"

# `with-native-s3.sh --update-pin vX.Y.Z` rewrites the pinned version and
# checksums in this script from that release's checksums.txt and exits. The
# renovate-fixups workflow runs it when Renovate bumps the compose image.
if [[ $1 == --update-pin ]]; then
	new_version="${2:-}"
	[[ $new_version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--update-pin needs a version like v1.2.3, got '${new_version}'"
	checksums="$(curl --fail --silent --show-error --location --retry 5 \
		"https://github.com/versity/versitygw/releases/download/${new_version}/checksums.txt")"
	edits=(-e "s/^version=v[0-9.]*\$/version=${new_version}/")
	for suffix in $pinned_suffixes; do
		sum="$(awk -v asset="versitygw_${new_version}_${suffix}" '$2 == asset { print $1 }' <<<"$checksums")"
		[[ $sum =~ ^[0-9a-f]{64}$ ]] || die "no SHA-256 for versitygw_${new_version}_${suffix} in the ${new_version} checksums.txt"
		edits+=(-e "s/^${suffix}) expected=[0-9a-f]* ;;\$/${suffix}) expected=${sum} ;;/")
	done
	script=scripts/with-native-s3.sh
	updated="$(sed "${edits[@]}" "$script")"
	printf '%s\n' "$updated" >"$script"
	echo "with-native-s3: pinned versitygw ${new_version}"
	exit 0
fi

# Must match the versitygw image tag in compose.test.yaml (checked
# below). The SHA-256 of each release asset (from the release's checksums.txt)
# is pinned further down; --update-pin updates them together with the version.
version=v1.11.0
compose_file=deploy/compose/compose.test.yaml
if ! grep -q "image: mirror.gcr.io/versity/versitygw:${version}@" "$compose_file"; then
	die "versitygw ${version} is not the image in ${compose_file}; update the version and checksums in scripts/with-native-s3.sh to match it"
fi
if [[ $1 == --check-pin ]]; then
	echo "with-native-s3: versitygw ${version} matches ${compose_file}"
	exit 0
fi

case "$(uname -s)" in
Darwin) os=Darwin ;;
Linux) os=Linux ;;
MINGW* | MSYS* | CYGWIN*) os=Windows ;;
*)
	echo "with-native-s3: unsupported OS $(uname -s)" >&2
	exit 1
	;;
esac

case "$(uname -m)" in
x86_64 | amd64) arch=x86_64 ;;
arm64 | aarch64) arch=arm64 ;;
*)
	echo "with-native-s3: unsupported architecture $(uname -m)" >&2
	exit 1
	;;
esac

if [[ $os == Windows ]]; then
	suffix="${os}_${arch}.zip"
	executable=versitygw.exe
else
	suffix="${os}_${arch}.tar.gz"
	executable=versitygw
fi

# A case, not an associative array: macOS ships bash 3.2.
case "$suffix" in
Darwin_arm64.tar.gz) expected=678555913e0eb574f38d1daef36fcc584392e9ae2bb966ee6d3d6bbab1e14c31 ;;
Darwin_x86_64.tar.gz) expected=1a2b405a3c2e4d771510d528c2b1ea364d382b2afe1e3b08f0295a16613a6674 ;;
Linux_arm64.tar.gz) expected=8bd88019511c288de3ce2e5f0efb86f4092a98f7067371a1a8fa461ec0cc161b ;;
Linux_x86_64.tar.gz) expected=1f075c9dc92fef232f5b3c7465711ddc5e1b062b2b6df4a3bd246a4be5b35b52 ;;
Windows_arm64.zip) expected=35b89c150d0b919a03da8abd0687f9f3a896f2d39bed35d5cfdeb9377d28e659 ;;
Windows_x86_64.zip) expected=2c647cf9ed07ba9d35fdfbb38bb139bc8fde15dc0c94775cacfdf8ba4fdaf33a ;;
*) die "no pinned SHA-256 for versitygw ${version} asset ${suffix}" ;;
esac

asset="versitygw_${version}_${suffix}"

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	else
		shasum -a 256 "$1" | cut -d ' ' -f 1
	fi
}

# Native Windows programs need Windows paths.
native_path() {
	if [[ $os == Windows ]]; then
		cygpath -w "$1"
	else
		echo "$1"
	fi
}

cache_dir="${VERSITYGW_CACHE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/versitygw}"
archive="${cache_dir}/${asset}"

port="${VERSITYGW_PORT:-7070}"
state="$(mktemp -d)"
mkdir "${state}/data" "${state}/meta" "${state}/extracted"

gateway_pid=""
cleanup() {
	if [[ -n $gateway_pid ]]; then
		kill "$gateway_pid" 2>/dev/null || true
		wait "$gateway_pid" 2>/dev/null || true
	fi
	rm -rf "$state"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A cached archive with the wrong hash (a partial download, or one planted
# by someone else) is replaced.
if [[ -f $archive && "$(sha256 "$archive")" != "$expected" ]]; then
	echo "with-native-s3: cached ${archive} does not have the pinned SHA-256; downloading it again" >&2
	rm -f "$archive"
fi
if [[ ! -f $archive ]]; then
	mkdir -p "$cache_dir"
	curl --fail --silent --show-error --location --retry 5 \
		--output "${state}/${asset}" \
		"https://github.com/versity/versitygw/releases/download/${version}/${asset}"
	mv "${state}/${asset}" "$archive"
fi

# Checked on every run, right before extraction; the copy in the private
# state directory is what is verified and extracted.
cp "$archive" "${state}/${asset}"
actual="$(sha256 "${state}/${asset}")"
if [[ $actual != "$expected" ]]; then
	die "${asset} has SHA-256 ${actual}, expected ${expected}"
fi

# Extracted into the private state directory; only the executable is used.
if [[ $os == Windows ]]; then
	powershell.exe -NoProfile -NonInteractive -Command \
		"Expand-Archive -LiteralPath '$(native_path "${state}/${asset}")' -DestinationPath '$(native_path "${state}/extracted")'"
else
	tar -xzf "${state}/${asset}" -C "${state}/extracted"
fi

binary="$(find "${state}/extracted" -type f -name "$executable" | head -n 1)"
if [[ -z $binary ]]; then
	die "${asset} contains no ${executable}"
fi
chmod +x "$binary"

# Metadata goes to a sidecar directory: the posix backend otherwise needs
# extended attributes, which Windows does not have.
ROOT_ACCESS_KEY_ID=vault-sync-test \
	ROOT_SECRET_ACCESS_KEY=vault-sync-test-secret \
	VGW_REGION=us-east-1 \
	"$binary" --port "127.0.0.1:${port}" \
	posix --sidecar "$(native_path "${state}/meta")" "$(native_path "${state}/data")" \
	>"${state}/gateway.log" 2>&1 &
gateway_pid=$!

# Any HTTP response (an unsigned request is refused with an S3 error) means
# it is listening.
if ! curl --silent --output /dev/null --retry 60 --retry-delay 1 --retry-connrefused \
	"http://127.0.0.1:${port}/"; then
	echo "with-native-s3: versitygw did not start; its output:" >&2
	cat "${state}/gateway.log" >&2
	exit 1
fi

echo "with-native-s3: versitygw ${version} (${asset}) listening on 127.0.0.1:${port}" >&2

export VAULT_SYNC_TEST_S3_ENDPOINT="http://127.0.0.1:${port}"
export VAULT_SYNC_TEST_S3_REGION="us-east-1"
export VAULT_SYNC_TEST_S3_ACCESS_KEY="vault-sync-test"
export VAULT_SYNC_TEST_S3_SECRET_KEY="vault-sync-test-secret"

"$@"
