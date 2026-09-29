#shellcheck shell=sh
# .githooks/pre-commit root-graph refresh: a commit that stages any path other
# than graphify-out/graph.json rebuilds the graph in place through
# scripts/agent/check-graph-fresh.sh --refresh and stages the result, so the
# commit and its graph always agree. A stubbed checker records its arguments and
# writes controllable bytes.

Describe '.githooks/pre-commit root-graph refresh'
  gitc() { git_fixture -C "$repo" "$@"; }

  make_repo() {
    scrub_git_env
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    repo="$(mktemp -d "${SHELLSPEC_TMPBASE:-/tmp}/precommit-graph.XXXXXX")"
    git_fixture -C "$repo" init -q
    mkdir -p "$repo/.githooks" "$repo/src" "$repo/scripts/agent" "$repo/graphify-out/memory"
    cp "$ROOT/.githooks/pre-commit" "$repo/.githooks/pre-commit"
    check_log="$repo/check-graph-fresh.log"
    export GRAPH_CHECK_LOG="$check_log"
    cat > "$repo/scripts/agent/check-graph-fresh.sh" <<'CHECK'
#!/bin/sh
printf '%s\n' "$*" >> "$GRAPH_CHECK_LOG"
[ "${GRAPH_CHECK_RC:-0}" -eq 0 ] || exit "$GRAPH_CHECK_RC"
printf 'rebuilt graph\n' > graphify-out/graph.json
CHECK
    printf 'committed graph\n' > "$repo/graphify-out/graph.json"
    gitc add graphify-out/graph.json
    gitc -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m seed --no-verify
    printf 'export {}\n' > "$repo/src/ok.ts"
  }
  cleanup() {
    rm -rf "$repo"
    unset GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GRAPH_CHECK_LOG GRAPH_CHECK_RC
  }
  Before 'make_repo'
  After 'cleanup'

  staged_graph() { gitc diff --cached --name-only -- graphify-out/graph.json; }

  It 'rebuilds the graph in place and stages it when a path outside the graph is staged'
    gitc add src/ok.ts
    When run sh -c "cd '$repo' && sh .githooks/pre-commit"
    The status should equal 0
    The output should include '[pre-commit] graph freshness'
    The contents of file "$check_log" should equal '--refresh'
    The contents of file "$repo/graphify-out/graph.json" should equal 'rebuilt graph'
    The result of function staged_graph should equal 'graphify-out/graph.json'
  End

  It 'rebuilds nothing when only graphify-out/graph.json itself is staged'
    printf 'hand-refreshed graph\n' > "$repo/graphify-out/graph.json"
    gitc add graphify-out/graph.json
    When run sh -c "cd '$repo' && sh .githooks/pre-commit"
    The status should equal 0
    The output should not include 'graph freshness'
    The file "$check_log" should not be exist
    The contents of file "$repo/graphify-out/graph.json" should equal 'hand-refreshed graph'
  End

  It 'rebuilds when only a graphify-out/memory/ record is staged: records are graph nodes'
    printf 'query record\n' > "$repo/graphify-out/memory/x.md"
    gitc add graphify-out/memory/x.md
    When run sh -c "cd '$repo' && sh .githooks/pre-commit"
    The status should equal 0
    The output should include '[pre-commit] graph freshness'
    The result of function staged_graph should equal 'graphify-out/graph.json'
  End

  It 'rebuilds when the lone staged path merely SPLITS into graph.json lines'
    hostile="$repo/graphify-out/graph.json
graphify-out/graph.json"
    mkdir -p "$(dirname "$hostile")"
    printf 'not the graph\n' > "$hostile"
    gitc add -- "graphify-out/graph.json
graphify-out/graph.json"
    When run sh -c "cd '$repo' && sh .githooks/pre-commit"
    The status should equal 0
    The output should include '[pre-commit] graph freshness'
    The result of function staged_graph should equal 'graphify-out/graph.json'
  End

  It 'rebuilds nothing with an empty index'
    When run sh -c "cd '$repo' && sh .githooks/pre-commit"
    The status should equal 0
    The output should not include 'graph freshness'
    The file "$check_log" should not be exist
  End

  It 'still rebuilds and stages the graph during a rebase'
    mkdir -p "$repo/.git/rebase-merge"
    gitc add src/ok.ts
    When run sh -c "cd '$repo' && sh .githooks/pre-commit"
    The status should equal 0
    The output should include '[pre-commit] graph freshness'
    The result of function staged_graph should equal 'graphify-out/graph.json'
  End

  Context 'checker failure'
    Parameters
      1 'rebuild failed'
      4 'Graphify launcher missing'
    End

    It "fails the commit and stages nothing when the checker exits $1 ($2)"
      export GRAPH_CHECK_RC="$1"
      gitc add src/ok.ts
      When run sh -c "cd '$repo' && sh .githooks/pre-commit"
      The status should equal 1
      The output should include '[pre-commit] graph freshness'
      The stderr should include '[pre-commit] FAILED: graph freshness'
      The result of function staged_graph should equal ''
    End
  End

  It 'fails the commit when the checker is missing'
    rm -f "$repo/scripts/agent/check-graph-fresh.sh"
    gitc add src/ok.ts
    When run sh -c "cd '$repo' && sh .githooks/pre-commit"
    The status should equal 1
    The output should include '[pre-commit] graph freshness'
    The stderr should include '[pre-commit] FAILED: graph freshness'
  End
End
