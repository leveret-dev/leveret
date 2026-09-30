#shellcheck shell=sh
# setup-hooks.sh strips Graphify's post-commit/post-checkout blocks from both
# .git/hooks and .githooks, since the pre-commit refresh replaces them, without
# running `graphify hook install` or `graphify hook uninstall`. PATH holds only
# the tools setup needs plus uv/graphify stubs, so a host CodeGraph never runs.

Describe 'setup-hooks.sh Graphify hook cleanup'
  script_abs="${SHELLSPEC_PROJECT_ROOT:-$PWD}/scripts/setup-hooks.sh"

  setup() {
    scrub_git_env
    fixture=$(mktemp -d "${TMPDIR:-/tmp}/setup_hooks.XXXXXX") || return 1
    fixture=$(cd "$fixture" && pwd -P) || return 1
    primary="$fixture/primary"
    git_fixture init -q "$primary" &&
      mkdir -p "$primary/.githooks" "$primary/.git/hooks" &&
      true > "$primary/.githooks/pre-commit" || return 1
    bin="$fixture/bin"; mkdir -p "$bin"
    for tool in awk basename cat chmod dirname git grep mkdir mktemp mv rm sed sh tail touch tr wc; do
      ln -s "$(command -v "$tool")" "$bin/$tool"
    done
    graphify_log="$fixture/graphify.log"
    true > "$graphify_log"
    printf '%s\n' '#!/bin/sh' 'exit 0' > "$bin/uv"
    printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$*" >> "$GRAPHIFY_LOG"' > "$bin/graphify"
    chmod +x "$bin/uv" "$bin/graphify"
    export GRAPHIFY_LOG="$graphify_log" XDG_CONFIG_HOME="$fixture/config"
  }
  cleanup() { rm -rf "$fixture"; unset GRAPHIFY_LOG XDG_CONFIG_HOME; }
  BeforeEach 'setup'
  AfterEach 'cleanup'

  run_setup() { env PATH="$bin" sh -c 'cd "$1" && exec sh "$2"' _ "$primary" "$script_abs"; }
  hook() { printf '%s\n' "$@" > "$primary/$HOOK"; chmod +x "$primary/$HOOK"; }

  It 'removes pure Graphify post-commit and post-checkout hooks from both hook dirs'
    HOOK=.git/hooks/post-commit hook '#!/bin/sh' '# graphify-hook-start' 'echo g' '# graphify-hook-end'
    HOOK=.git/hooks/post-checkout hook '#!/bin/sh' '# graphify-checkout-hook-start' 'echo g' '# graphify-checkout-hook-end'
    HOOK=.githooks/post-commit hook '#!/bin/sh' '# graphify-hook-start' 'echo g' '# graphify-hook-end'
    When run run_setup
    The status should equal 0
    The output should include 'core.hooksPath set to: .githooks'
    The path "$primary/.git/hooks/post-commit" should not be exist
    The path "$primary/.git/hooks/post-checkout" should not be exist
    The path "$primary/.githooks/post-commit" should not be exist
    The path "$primary/.githooks/pre-commit" should be exist
    The contents of file "$graphify_log" should equal ''
  End

  It 'keeps custom lines and the execute bit on a mixed hook'
    HOOK=.git/hooks/post-commit hook '#!/bin/sh' 'echo custom' '# graphify-hook-start' 'echo g' '# graphify-hook-end'
    When run run_setup
    The status should equal 0
    The output should include 'core.hooksPath set to: .githooks'
    The contents of file "$primary/.git/hooks/post-commit" should equal "$(printf '#!/bin/sh\necho custom')"
    The path "$primary/.git/hooks/post-commit" should be executable
  End

  It 'leaves a start marker without its end marker untouched'
    HOOK=.git/hooks/post-commit hook '#!/bin/sh' 'echo keep-me' '# graphify-hook-start' 'echo truncated'
    When run run_setup
    The status should equal 0
    The output should include 'core.hooksPath set to: .githooks'
    The contents of file "$primary/.git/hooks/post-commit" should include 'echo truncated'
  End

  It 'leaves a start marker after an earlier end marker untouched'
    HOOK=.git/hooks/post-commit hook '#!/bin/sh' '# graphify-hook-end' 'echo after-end' '# graphify-hook-start' 'echo dangling'
    When run run_setup
    The status should equal 0
    The output should include 'core.hooksPath set to: .githooks'
    The contents of file "$primary/.git/hooks/post-commit" should include 'echo after-end'
    The contents of file "$primary/.git/hooks/post-commit" should include 'echo dangling'
  End

  It 'keeps a dangling start after a complete block, and a later hashbang line'
    HOOK=.git/hooks/post-commit hook '#!/bin/sh' '# graphify-hook-start' 'echo g' '# graphify-hook-end' '#!keep-hashbang' '# graphify-hook-start' 'echo dangling'
    When run run_setup
    The status should equal 0
    The output should include 'core.hooksPath set to: .githooks'
    The contents of file "$primary/.git/hooks/post-commit" should include '#!keep-hashbang'
    The contents of file "$primary/.git/hooks/post-commit" should include 'echo dangling'
    The contents of file "$primary/.git/hooks/post-commit" should not include 'echo g'
  End
End
