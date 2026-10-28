#!/usr/bin/env bash
# Proves one group of the Dafny files in plugin/verified/ (make verify-group),
# so CI can verify them as parallel jobs that each fit the job's time limit
# (#1031: one `dafny verify` of every file outgrew it). The groups are listed
# in plugin/verified/verify-groups.txt, one `<group> <file>` line per file,
# the file relative to plugin/verified/.
#
#   verify-group.sh --check    every .dfy file under plugin/verified/ is in
#                              exactly one group, and every listed file exists
#   verify-group.sh --matrix   the group names as a JSON array (CI's matrix),
#                              after --check
#   verify-group.sh GROUP      --check, then `dafny verify` the group's files
#
# Every mode runs --check first, so a new file that is in no group fails the
# CI job instead of being left unverified. VERIFIED_DIR and VERIFY_GROUPS
# override the directory and the groups file (for the script's own test).
set -euo pipefail
export LC_ALL=C

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verified_dir="${VERIFIED_DIR:-$repo_root/plugin/verified}"
groups_file="${VERIFY_GROUPS:-$verified_dir/verify-groups.txt}"

# The `<group> <file>` lines of the groups file, without comments and blank
# lines.
entries() {
  sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$groups_file"
}

check() {
  local ok=0 listed present
  if [[ ! -f "$groups_file" ]]; then
    echo "verify-group: no groups file $groups_file" >&2
    return 1
  fi
  if entries | awk 'NF != 2 { exit 1 }'; then :; else
    echo "verify-group: every line of $groups_file must be '<group> <file>'" >&2
    return 1
  fi
  listed="$(entries | awk '{ print $2 }' | sort)"
  present="$(cd "$verified_dir" && find . -name '*.dfy' -type f | sed 's|^\./||' | sort)"
  local duplicate
  duplicate="$(printf '%s\n' "$listed" | uniq -d)"
  if [[ -n "$duplicate" ]]; then
    echo "verify-group: listed in more than one group: ${duplicate//$'\n'/ }" >&2
    ok=1
  fi
  local missing extra
  missing="$(comm -13 <(printf '%s\n' "$listed" | uniq) <(printf '%s\n' "$present"))"
  extra="$(comm -23 <(printf '%s\n' "$listed" | uniq) <(printf '%s\n' "$present"))"
  if [[ -n "$missing" ]]; then
    echo "verify-group: in no group of $groups_file (add it to one): ${missing//$'\n'/ }" >&2
    ok=1
  fi
  if [[ -n "$extra" ]]; then
    echo "verify-group: listed but not present: ${extra//$'\n'/ }" >&2
    ok=1
  fi
  return "$ok"
}

case "${1:-}" in
  --check)
    check
    ;;
  --matrix)
    check
    entries | awk '{ print $1 }' | sort -u | awk 'BEGIN { printf "[" } NR > 1 { printf "," } { printf "\"%s\"", $1 } END { print "]" }'
    ;;
  "" | -*)
    echo "usage: $0 --check | --matrix | GROUP" >&2
    exit 2
    ;;
  *)
    check
    group="$1"
    mapfile -t files < <(entries | awk -v group="$group" '$1 == group { print $2 }')
    if [[ ${#files[@]} -eq 0 ]]; then
      echo "verify-group: no files in group $group" >&2
      exit 1
    fi
    cd "$verified_dir"
    echo "dafny verify ${files[*]}"
    dafny verify "${files[@]}"
    ;;
esac
