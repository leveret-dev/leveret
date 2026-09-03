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

	# graspologic_native supplies the Leiden binding cluster.py calls first. The
	# `leiden` extra installs graspologic, whose metadata stops below Python 3.13, so
	# from 3.13 the extra installs nothing and clustering silently degrades to
	# NetworkX Louvain. Naming the native abi3 wheel keeps Leiden on every
	# interpreter. Drop this once Graphify-Labs/graphify#3310 ships and use
	# `graphifyy[leiden]`.
	uv tool install --upgrade --with 'graspologic-native>=1.2.1,<2.0.0' 'graphifyy>=0.9.51' 1>&2 ||
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
