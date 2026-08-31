#!/bin/sh
# Install Graphify and register its merge driver in the requested checkout.
#
# For CI. Any job that may merge, rebase, cherry-pick or otherwise combine commits
# has to run this BEFORE the operation: .gitattributes marks
# graphify-out/graph.json merge=graphify, and a runner without that driver
# registered falls back to a line-based text merge on generated JSON, which
# produces a conflicted or structurally invalid graph instead of a union.
#
# Call it as the step right after checkout and uv setup:
#     - name: Install the Graphify merge driver
#       run: sh scripts/agent/ensure-graphify-merge-driver.sh .

usage() {
	echo "usage: ensure-graphify-merge-driver.sh [REPOSITORY]" >&2
	exit 2
}

main() {
	# shellcheck source=scripts/agent/agent_env.sh
	. "$(dirname "$0")/agent_env.sh"
	scrub_git_env
	[ "$#" -le 1 ] || usage
	require_tool git
	require_tool uv

	root=$(resolve_root "${1:-.}") || exit $?

	uv tool install --upgrade 'graphifyy>=0.9.51' || {
		echo "ensure-graphify-merge-driver.sh: Graphify installation failed" >&2
		exit 1
	}

	# `graphify hook install` registers the merge driver and writes its own hooks
	# into .git/hooks/. Those are inert in a clone that has opted into the tracked
	# hooks via scripts/setup-hooks.sh, because core.hooksPath overrides
	# .git/hooks entirely; the driver registration is what this script is for.
	(cd "$root" && graphify hook install) || {
		echo "ensure-graphify-merge-driver.sh: Graphify hook installation failed in '$root'" >&2
		exit 1
	}

	driver=$(git -C "$root" config --local --get merge.graphify.driver 2>/dev/null || :)
	case "$driver" in
		*"graphify merge-driver %O %A %B"*) ;;
		*)
			echo "ensure-graphify-merge-driver.sh: merge.graphify.driver must contain 'graphify merge-driver %O %A %B' (got: '${driver:-missing}')" >&2
			exit 1
			;;
	esac
}

main "$@"
