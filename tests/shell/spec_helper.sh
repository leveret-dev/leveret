#!/bin/sh
# shellcheck shell=sh
# shellspec spec_helper — shared setup for the POSIX-sh test suite.

ROOT="${SHELLSPEC_PROJECT_ROOT}"

unset CODEX_THREAD_ID OMP_CLI PI_CLI

# shellcheck source=scripts/lib/git-env-scrub.sh
. "${ROOT}/scripts/lib/git-env-scrub.sh"
scrub_git_env() { pfb_scrub_git_env; }

git_fixture() {
	GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git "$@"
}

make_wt_stub() {
	cat > "$1/wt" <<'WTSTUB'
#!/bin/sh
wt_path=''
wt_branch=''
while [ "$#" -gt 0 ]; do
  case $1 in
    --config-set)
      wt_path=${2#worktree-path=\"}
      wt_path=${wt_path%\"}
      shift 2
      ;;
    switch)
      shift
      wt_branch=${1:-}
      [ "$#" -eq 0 ] || shift
      ;;
    *) shift ;;
  esac
done
git worktree add "$wt_path" "$wt_branch" >/dev/null 2>&1 || exit $?
printf '%s\n' "✓ Created worktree for $wt_branch @ $wt_path" >&2
WTSTUB
	chmod +x "$1/wt"
}

silently() {
	"$@" >/dev/null 2>&1
}

export ROOT
