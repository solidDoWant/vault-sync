#!/usr/bin/env bash
# Tests scripts/test-images.sh against a stub `docker` (and `sleep`) on PATH:
# which images it pulls, its backoff (longer on a rate limit), when it gives
# up, and what it saves and loads.
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-images.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

base_pg=registry.example/postgres:18@sha256:aaa
pg14=registry.example/postgres:14@sha256:ccc
s3=registry.example/s3:1@sha256:bbb

# The stub docker: `compose ... config --images` prints the base stack's
# images, or the PostgreSQL 14 variant's when that override is among the
# files; `image inspect` succeeds for images listed in $STUB/present; each
# `pull` consumes the next line of $STUB/pulls (ok, 429 or 500) and records
# the image in $STUB/pulled; save and load record their arguments, and load
# marks the images in $STUB/archive present.
cat >"$work/bin/docker" <<EOF
#!/usr/bin/env bash
set -euo pipefail
stub=\$STUB
case "\$1" in
compose)
	if [[ " \$* " == *compose.test-postgres14.yaml* ]]; then
		printf '%s\n' "$s3" "$pg14"
	else
		printf '%s\n' "$s3" "$base_pg"
	fi
	;;
image)
	grep -qxF "\$3" "\$stub/present"
	;;
pull)
	echo "\$3" >>"\$stub/pulled"
	result=\$(head -n 1 "\$stub/pulls")
	sed -i 1d "\$stub/pulls"
	case \$result in
	ok) echo "\$3" >>"\$stub/present" ;;
	429) echo "Error response from daemon: toomanyrequests: Quota exceeded for quota metric 'Requests per project'" >&2; exit 1 ;;
	*) echo "Error response from daemon: received unexpected HTTP status: 500 Internal Server Error" >&2; exit 1 ;;
	esac
	;;
tag)
	echo "\$*" >>"\$stub/tagged"
	;;
save)
	echo "\$*" >>"\$stub/saved"
	;;
load)
	echo "\$*" >>"\$stub/loaded"
	cat "\$stub/archive" >>"\$stub/present"
	;;
*)
	echo "stub docker: unexpected \$*" >&2
	exit 99
	;;
esac
EOF
cat >"$work/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "$1" >>"$STUB/slept"
EOF
chmod +x "$work/bin/docker" "$work/bin/sleep"

fail() {
	echo "FAIL: $*" >&2
	[[ -f $work/out ]] && cat "$work/out" >&2
	exit 1
}

# run name expected-exit pull-results present-images -- arguments...
run() {
	local name=$1 want=$2 pulls=$3 present=$4 got=0
	shift 5
	export STUB="$work/$name"
	rm -rf "$STUB"
	mkdir "$STUB"
	printf '%s\n' $pulls >"$STUB/pulls"
	printf '%s\n' $present >"$STUB/present"
	printf '%s\n' ${ARCHIVE_IMAGES:-} >"$STUB/archive"
	touch "$STUB/pulled" "$STUB/slept" "$STUB/tagged" "$STUB/saved" "$STUB/loaded"
	PATH="$work/bin:$PATH" "$script" "$@" >"$work/out" 2>&1 || got=$?
	[[ $got -eq $want ]] || fail "$name: exit $got, want $want"
}

# expect name file expected-lines...
expect() {
	local name=$1 file=$2 got want
	shift 2
	got=$(cat "$work/$name/$file")
	want=$(printf '%s\n' "$@")
	[[ $got == "$want" ]] || fail "$name: $file is '$got', want '$want'"
}

run fresh 0 "ok ok" "" -- pull deploy/compose/compose.test.yaml
expect fresh pulled "$s3" "$base_pg"
expect fresh slept

run present 0 "" "$s3 $base_pg" -- pull deploy/compose/compose.test.yaml
expect present pulled

run partly-present 0 "ok" "$s3" -- pull deploy/compose/compose.test.yaml deploy/compose/compose.test-postgres14.yaml
expect partly-present pulled "$pg14"

run every-variant 0 "ok ok ok" "" -- pull
expect every-variant pulled "$pg14" "$base_pg" "$s3"

run transient 0 "500 500 ok ok" "" -- pull deploy/compose/compose.test.yaml
expect transient slept 5 15
expect transient pulled "$s3" "$s3" "$s3" "$base_pg"

run rate-limited 0 "429 429 429 ok ok" "" -- pull deploy/compose/compose.test.yaml
expect rate-limited slept 60 120 240

run gives-up 1 "500 500 500 500" "" -- pull deploy/compose/compose.test.yaml
expect gives-up slept 5 15 45
expect gives-up pulled "$s3" "$s3" "$s3" "$s3"
grep -q "pulling $s3 failed 4 times; giving up" "$work/out" || fail "gives-up: names the image"

run gives-up-rate-limited 1 "429 429 429 429" "" -- pull deploy/compose/compose.test.yaml
expect gives-up-rate-limited slept 60 120 240

run save 0 "ok" "$s3 $pg14" -- save "$work/images.tar"
expect save pulled "$base_pg"
expect save tagged "tag $pg14 ${pg14%@*}" "tag $base_pg ${base_pg%@*}" "tag $s3 ${s3%@*}"
expect save saved "save --output $work/images.tar ${pg14%@*} ${base_pg%@*} ${s3%@*}"

ARCHIVE_IMAGES="$base_pg $pg14 $s3" run load 0 "" "" -- load "$work/images.tar"
expect load loaded "load --quiet --input $work/images.tar"
grep -q "every test image loaded" "$work/out" || fail "load: reports a complete load"

ARCHIVE_IMAGES="$base_pg $s3" run load-partial 0 "" "" -- load "$work/images.tar"
grep -q "$pg14 is not in" "$work/out" || fail "load-partial: names the missing image"
grep -q "every test image loaded" "$work/out" && fail "load-partial: claims a complete load"

run usage 2 "" "" -- frobnicate

echo "test-images_test: ok"
