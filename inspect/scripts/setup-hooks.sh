#!/bin/sh
# One-time developer setup: activate tracked Git hooks and bootstrap CodeGraph.
#
# Run once after cloning:
#   sh scripts/setup-hooks.sh
#
# git cannot auto-apply a committed core.hooksPath (by design — cloning a repo
# must not silently install executable hooks), so this single explicit opt-in is
# the closest to "automatic". After running it, .githooks/post-commit and
# .githooks/post-checkout keep graphify-out/ current in this clone. When CodeGraph
# is installed, the same command also creates this checkout's exact-root index.

set -eu

root=$(git rev-parse --show-toplevel)
git -C "$root" config core.hooksPath .githooks

# .gitattributes marks graphify-out/graph.json merge=graphify; register the driver
# so a fresh clone resolves parallel graph updates through the union driver instead
# of a text merge on generated JSON.
if command -v graphify >/dev/null 2>&1; then
	# Resolve the interpreter that actually imports graphify. A bare python3 on
	# PATH usually cannot, so probe the uv tool install the way the hooks do.
	gfy_py=''
	[ -f graphify-out/.graphify_python ] && gfy_py=$(cat graphify-out/.graphify_python)
	if [ -z "$gfy_py" ] && command -v uv >/dev/null 2>&1; then
		gfy_py=$(uv tool run --from graphifyy python -c 'import sys; print(sys.executable)' 2>/dev/null || true)
	fi
	if [ -z "$gfy_py" ]; then
		gfy_bin=$(command -v graphify || true)
		[ -n "$gfy_bin" ] && gfy_py=$(head -1 "$gfy_bin" | tr -d '#!')
	fi
	if [ -n "$gfy_py" ] && "$gfy_py" -c "import graphify" 2>/dev/null; then
		git -C "$root" config merge.graphify.name "graphify graph union merge"
		git -C "$root" config merge.graphify.driver "\"$gfy_py\" -m graphify merge-driver %O %A %B"
	else
		printf 'graphify interpreter not resolvable; merge=graphify driver not registered\n' >&2
	fi
fi

if command -v codegraph >/dev/null 2>&1; then
	script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
	sh "$script_dir/agent/ensure-codegraph.sh" "$root"
fi

printf 'core.hooksPath set to: %s\n' "$(git -C "$root" config core.hooksPath)"
printf 'Active hooks:\n'
for hook in "$root"/.githooks/*; do
	[ -f "$hook" ] && printf '  %s\n' "$(basename "$hook")"
done
