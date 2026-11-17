#!/bin/sh
# One-time developer setup: bootstrap CodeGraph and pin Worktrunk worktrees to
# the sibling .<repo>_worktrees root.
#
# Run once after cloning:
#   sh scripts/setup-hooks.sh

set -eu

root=$(git rev-parse --show-toplevel)
script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)

if command -v codegraph >/dev/null 2>&1; then
	sh "$script_dir/agent/ensure-codegraph.sh" "$root"
fi

sh "$script_dir/agent/configure-worktrunk.sh" || printf 'worktrunk config not updated\n' >&2
