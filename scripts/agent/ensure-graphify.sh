#!/bin/sh
# Install or upgrade Graphify. Apply a language-override patch only when this
# checkout (or the trusted helper next to this script) ships one.
# Usage: ensure-graphify.sh [REPOSITORY]

set -eu

usage() {
	echo "usage: ensure-graphify.sh [REPOSITORY]" >&2
	exit 2
}

fail() {
	echo "ensure-graphify.sh: $*" >&2
	exit 1
}

main() {
	# shellcheck source=scripts/agent/agent_env.sh
	. "$(dirname "$0")/agent_env.sh"
	# shellcheck source=scripts/agent/resolve-graphify.sh
	. "$(dirname "$0")/resolve-graphify.sh"
	scrub_git_env "$0"
	[ "$#" -le 1 ] || usage
	require_tool git
	require_tool uv

	target=${1:-.}
	root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null) || {
		echo "ensure-graphify.sh: '$target' is not a git worktree" >&2
		exit 2
	}
	root=$(CDPATH='' cd "$root" && pwd -P) || {
		echo "ensure-graphify.sh: cannot resolve Git root '$root'" >&2
		exit 2
	}
	# Prefer the target checkout's patch; foreign targets fall back to a trusted
	# sibling helper. No patch file is required — Leveret has no PHP .inc override.
	patch_graphify=$root/scripts/agent/patch-graphify.sh
	[ -f "$patch_graphify" ] || patch_graphify=$(dirname "$0")/patch-graphify.sh

	# Install the pfBlockerNG fork's integration head at an immutable commit (0.9.85),
	# as pfBlockerNG does. Its `leiden` extra pulls the native Leiden binding on every
	# interpreter, so clustering never silently falls back to Louvain. Bump the SHA
	# when the fork's integration branch advances.
	uv tool install --upgrade 'graphifyy[leiden] @ git+https://github.com/pfBlockerNG/graphify@ff80347d986a7fd25864dd7aa5c1fb14dc5e2a18' 1>&2 ||
		fail 'Graphify installation failed'
	graphify_bin=$(resolve_graphify_launcher) ||
		fail 'cannot resolve the installed Graphify launcher'
	if [ -f "$patch_graphify" ]; then
		sh "$patch_graphify" ||
			fail "Graphify language-override patch failed for '$root'"
	fi
	printf '%s\n' "$graphify_bin"
}

main "$@"
