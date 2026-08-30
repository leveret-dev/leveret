#!/bin/sh
# agent_env.sh -- shared environment helpers for the agent-ops scripts in this directory.
#
# AGENT-MAINTAINED: these scripts encode environment mechanics that drift (tool
# installs, managed sessions, worktree layouts). When an environment change breaks
# one, fix the script in the same session and land it through the normal flow --
# never work around it silently in a transcript.
#
# Exit codes reserved across scripts/agent/: 0 success, 1 check failed,
# 2 usage/precondition, 4 required tool missing.

require_tool() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "TOOL-MISSING: $1" >&2
		exit 4
	fi
}

# An optional tool: absent is fine and reported, but present-and-broken is not.
# Returns 0 when the caller should run it, 1 when it is not installed.
have_tool() {
	command -v "$1" >/dev/null 2>&1
}

# Resolve one worktree argument to an absolute, symlink-free repository root.
#
# Never trust the process's working directory for this. A tool that infers its
# root from cwd fails outright when the cwd is a worktree that has since been
# removed -- the observed failure mode being Graphify's "current working directory
# no longer exists". CDPATH is cleared because a stray CDPATH entry can silently
# redirect `cd`, and `pwd -P` resolves symlinks so two spellings of one root do
# not produce two indexes.
resolve_root() {
	if ! _root=$(git -C "${1:-.}" rev-parse --show-toplevel 2>/dev/null); then
		echo "resolve_root: '${1:-.}' is not a git worktree" >&2
		return 2
	fi
	if ! _root=$(CDPATH='' cd "$_root" && pwd -P); then
		echo "resolve_root: cannot resolve '$_root'" >&2
		return 2
	fi
	printf '%s\n' "$_root"
}

# Drop inherited git environment before touching git.
#
# Why a FUNCTION and not a bare top-level unset: a subprocess cannot unset vars in
# the PARENT shell. Sourcing a file that calls `unset` at top level does work for a
# sourced file, but collecting it into a function the caller invokes means the unset
# runs in the caller's own shell context -- the only place it can affect the
# caller's git operations.
#
# Under a git hook these vars point at the live repo's objects and index, so any git
# command in a child process operates on the REAL repo instead of the worktree the
# caller named. One call per entry point eliminates the class.
scrub_git_env() {
	unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_COMMON_DIR
}
