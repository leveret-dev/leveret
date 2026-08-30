#!/bin/sh
# Initialize repository-intelligence tools for one exact worktree root.
#
# Invoked by `.config/wt.toml` pre-start whenever a worktree is created, and safe to
# run by hand. Every tool below is handed the resolved root as an argument; none of
# them is allowed to infer it from the working directory.

usage() {
	echo "usage: init-worktree-tools.sh [WORKTREE]" >&2
	exit 2
}

main() {
	# shellcheck source=scripts/agent/agent_env.sh
	. "$(dirname "$0")/agent_env.sh"
	scrub_git_env
	[ "$#" -le 1 ] || usage
	require_tool git

	root=$(resolve_root "${1:-.}") || exit $?

	# CodeGraph: an exact-root index, created on first use and rebuilt when stale.
	if have_tool codegraph; then
		sh "$(dirname "$0")/ensure-codegraph.sh" "$root" || exit $?
	else
		echo "codegraph not installed; skipping its index for $root" >&2
	fi

	# Graphify: refreshing an existing root graph is mechanical, so it stays
	# automated. Building the FIRST graph is not -- its scope (which trees, whether
	# the semantic layer earns its cost, what .graphifyignore allows) is a judgement
	# call, so defer it to an AI-assisted `/graphify` run rather than picking a
	# default unattended.
	if have_tool graphify; then
		if [ -f "$root/graphify-out/graph.json" ]; then
			graphify update "$root" || exit $?
		else
			echo "No Graphify root graph in $root; run /graphify in your AI assistant to build one." >&2
		fi
	else
		echo "graphify not installed; skipping its graph for $root" >&2
	fi
}

main "$@"
