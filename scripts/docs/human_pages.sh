#!/usr/bin/env bash
# Prints the human-facing Markdown pages, one per line: the front door, the
# release notes, SPEC.md and every page under docs/ except docs/agents/
# (agent instructions, exempt from the style rules).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
printf '%s\n' README.md CHANGELOG.md SPEC.md
git ls-files --cached --others --exclude-standard -- 'docs/*.md' ':!docs/agents/' | sort
