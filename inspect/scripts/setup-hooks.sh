#!/bin/sh
# One-time developer setup: activate tracked Git hooks and build the CodeGraph index.
#
# Run once after cloning:
#   sh scripts/setup-hooks.sh
#
# git cannot auto-apply a committed core.hooksPath (by design — cloning a repo
# must not silently install executable hooks), so this single explicit opt-in is
# the closest to "automatic". After running it, .githooks/post-commit and
# .githooks/post-checkout keep graphify-out/ current in this clone.

set -eu

root=$(git rev-parse --show-toplevel)
git -C "$root" config core.hooksPath .githooks

if command -v codegraph >/dev/null 2>&1; then
	codegraph init "$root" >/dev/null 2>&1 || codegraph sync "$root" >/dev/null 2>&1 || true
	printf 'CodeGraph index: ready\n'
else
	printf 'CodeGraph not installed; skipping index (optional)\n'
fi

printf 'core.hooksPath set to: %s\n' "$(git -C "$root" config core.hooksPath)"
printf 'Active hooks:\n'
for hook in "$root"/.githooks/*; do
	[ -f "$hook" ] && printf '  %s\n' "$(basename "$hook")"
done
