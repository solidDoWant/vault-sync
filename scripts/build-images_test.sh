#!/usr/bin/env bash
# Tests which tags scripts/build-images.sh and scripts/publish-release.sh
# push, with nix, govulncheck, docker, helm and make replaced by stubs on
# PATH that log their arguments. Cases:
#
#   - build-images with PUSH_ALL=true pushes :VERSION and :latest for a final
#     version, and only :VERSION for a pre-release (latest is not moved);
#   - build-images without PUSH_ALL pushes nothing;
#   - publish-release builds and pushes through make with PUSH_ALL=true and
#     checks that the image and the chart resolve; it refuses a tag that is
#     not a release version before building anything, and fails when the
#     pushed image does not resolve;
#   - `make release PUSH_ALL=true` (printed with make -n) builds and pushes
#     no image and no chart, so it needs no registry credentials.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_images="$repo_root/scripts/build-images.sh"
publish="$repo_root/scripts/publish-release.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1" >&2
	failures=$((failures + 1))
}

mkdir -p "$work/bin"
export STUB_LOG="$work/stub.log"
for tool in nix govulncheck docker helm make; do
	cat >"$work/bin/$tool" <<EOF
#!/usr/bin/env bash
printf '%s\n' "$tool \$*" >>"\$STUB_LOG"
EOF
	chmod +x "$work/bin/$tool"
done
# `nix build --print-out-paths` prints a store path; the image script it
# prints is run and piped into `docker load`.
cat >"$work/bin/nix" <<EOF
#!/usr/bin/env bash
printf '%s\n' "nix \$*" >>"\$STUB_LOG"
echo "$work/bin/image-script"
EOF
printf '#!/usr/bin/env bash\necho image\n' >"$work/bin/image-script"
# docker fails `manifest inspect` when DOCKER_INSPECT_FAILS is set.
cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "docker $*" >>"$STUB_LOG"
if [[ $1 == manifest && -n ${DOCKER_INSPECT_FAILS:-} ]]; then
	echo "manifest unknown" >&2
	exit 1
fi
cat >/dev/null
EOF
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"

image=ghcr.io/soliddowant/vault-sync

# pushes VERSION PUSH_ALL: the tags build-images.sh pushes, one per line.
pushes() {
	: >"$STUB_LOG"
	"$build_images" "$1" "$2" "$image" >"$work/out" 2>&1 </dev/null || {
		echo "build-images failed: $(cat "$work/out")"
		return
	}
	sed -n 's/^docker push //p' "$STUB_LOG"
}

expect_pushes() {
	local label="$1" expected="$2" actual
	actual="$(pushes "$3" "$4")"
	if [[ $actual == "$expected" ]]; then
		pass "$label"
	else
		fail "$label: pushed '$actual', want '$expected'"
	fi
}

expect_pushes "a final version pushes :VERSION and :latest" \
	"$image:1.2.3"$'\n'"$image:latest" 1.2.3 true
expect_pushes "a release candidate pushes only :VERSION (latest is not moved)" \
	"$image:1.2.3-rc.1" 1.2.3-rc.1 true
expect_pushes "without PUSH_ALL nothing is pushed" "" 1.2.3 false

: >"$STUB_LOG"
if "$build_images" 1.2.3 true "$image" >"$work/out" 2>&1 </dev/null &&
	grep -q "^govulncheck -mode=binary $work/bin/image-script/bin/vault-sync-server$" "$STUB_LOG"; then
	pass "build-images checks the binary with govulncheck"
else
	fail "build-images checks the binary with govulncheck: $(cat "$work/out" "$STUB_LOG")"
fi

# --- publish-release --------------------------------------------------------

: >"$STUB_LOG"
if "$publish" 1.2.3-rc.1 >"$work/out" 2>&1 </dev/null &&
	grep -qxF "make build-images helm VERSION=1.2.3-rc.1 PUSH_ALL=true CONTAINER_REGISTRY=ghcr.io/soliddowant" "$STUB_LOG" &&
	grep -qxF "docker manifest inspect $image:1.2.3-rc.1" "$STUB_LOG" &&
	grep -qxF "helm show chart oci://ghcr.io/soliddowant/charts/vault-sync --version 1.2.3-rc.1" "$STUB_LOG"; then
	pass "publish-release pushes the image and chart and checks that both resolve"
else
	fail "publish-release pushes the image and chart and checks that both resolve: $(cat "$work/out" "$STUB_LOG")"
fi

for version in v1.2.3 1.2.3+build.1 1.2 latest; do
	: >"$STUB_LOG"
	if "$publish" "$version" >"$work/out" 2>&1 </dev/null; then
		fail "publish-release refuses tag '$version' (succeeded)"
	elif [[ -s $STUB_LOG ]]; then
		fail "publish-release refuses tag '$version' (built anyway: $(cat "$STUB_LOG"))"
	else
		pass "publish-release refuses tag '$version'"
	fi
done

: >"$STUB_LOG"
if DOCKER_INSPECT_FAILS=1 "$publish" 1.2.3 >"$work/out" 2>&1 </dev/null; then
	fail "publish-release fails when the pushed image does not resolve"
else
	pass "publish-release fails when the pushed image does not resolve"
fi

# --- make release -----------------------------------------------------------

# The real make, not the stub.
if plan="$(PATH="${PATH#"$work/bin:"}" make -s -n -C "$repo_root" release VERSION=1.2.3 PUSH_ALL=true 2>&1)"; then
	if grep -qE 'build-images|helm (package|push)|docker (push|login)|registry login' <<<"$plan"; then
		fail "make release builds or pushes no image or chart: $(grep -E 'build-images|helm (package|push)|docker (push|login)|registry login' <<<"$plan")"
	else
		pass "make release builds or pushes no image or chart"
	fi
else
	fail "make -n release succeeds: $plan"
fi

if [[ $failures -ne 0 ]]; then
	echo "build-images_test: $failures case(s) failed" >&2
	exit 1
fi
echo "build-images_test: all cases passed"
