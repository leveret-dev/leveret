#!/bin/sh
# One-time developer setup: install Graphify, activate tracked hooks, bootstrap
# CodeGraph, and pin Worktrunk worktrees to the sibling .<repo>_worktrees root.
#
# Run once after cloning:
#   sh scripts/setup-hooks.sh
#
# git cannot auto-apply a committed core.hooksPath (by design — cloning a repo
# must not silently install executable hooks), so this single explicit opt-in is
# the closest to "automatic".

set -eu

root=$(git rev-parse --show-toplevel)
script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
sh "$script_dir/agent/ensure-graphify.sh" "$root" >/dev/null
git -C "$root" config core.hooksPath .githooks

if command -v codegraph >/dev/null 2>&1; then
	sh "$script_dir/agent/ensure-codegraph.sh" "$root"
fi

sh "$script_dir/agent/configure-worktrunk.sh" || printf 'worktrunk config not updated\n' >&2

printf 'core.hooksPath set to: %s\n' "$(git -C "$root" config core.hooksPath)"
printf 'Active hooks:\n'
for hook in "$root"/.githooks/*; do
	[ -f "$hook" ] && printf '  %s\n' "$(basename "$hook")"
done
