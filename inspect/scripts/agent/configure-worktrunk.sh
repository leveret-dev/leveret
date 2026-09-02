#!/bin/sh
# Pin Worktrunk's worktree-path to the sibling .<repo>_worktrees root.
# Extracted from pfBlockerNG setup-agent-tools.sh so `wt switch` never cuts into /tmp.

set -eu

configure_worktrunk() {
	worktrunk_dir=${XDG_CONFIG_HOME:-$HOME/.config}/worktrunk
	worktrunk_config=$worktrunk_dir/config.toml
	worktrunk_path='worktree-path = "{{ repo_path }}/../.{{ repo }}_worktrees/{{ branch | sanitize }}"'
	mkdir -p "$worktrunk_dir"
	[ -f "$worktrunk_config" ] || touch "$worktrunk_config"
	worktrunk_trailing_newline=1
	if [ -s "$worktrunk_config" ]; then
		worktrunk_last_byte_lines=$(tail -c 1 "$worktrunk_config" | wc -l | tr -d '[:space:]')
		[ "$worktrunk_last_byte_lines" -eq 1 ] || worktrunk_trailing_newline=0
	fi
	worktrunk_tmp=$(mktemp "$worktrunk_dir/config.toml.XXXXXX") || return 1
	if ! awk \
		-v managed="$worktrunk_path" \
		-v trailing_newline="$worktrunk_trailing_newline" \
		-v single_key="'worktree-path'" \
		-v basic_multiline='"""' \
		-v literal_multiline="'''" '
		function emit(line) {
			if (emitted) printf "\n"
			printf "%s", line
			emitted = 1
		}
		function is_managed_key(line, equals, key) {
			equals = index(line, "=")
			if (!equals) return 0
			key = substr(line, 1, equals - 1)
			sub(/^[[:space:]]+/, "", key)
			sub(/[[:space:]]+$/, "", key)
			return key == "worktree-path" ||
				key == "\"worktree-path\"" ||
				key == single_key
		}
		BEGIN { root = 1; found = 0; emitted = 0; unsafe = 0 }
		root && $0 !~ /^[[:space:]]*#/ &&
			(index($0, basic_multiline) || index($0, literal_multiline)) {
			unsafe = 1
		}
		root && index($0, "=") {
			array_value = substr($0, index($0, "=") + 1)
			sub(/^[[:space:]]+/, "", array_value)
			if (substr(array_value, 1, 1) == "[") {
				unsafe = 1
			}
		}
		root && /^[[:space:]]*\[/ {
			if (!found) {
				emit(managed)
				found = 1
			}
			root = 0
		}
		root && is_managed_key($0) {
			if (!found) {
				emit(managed)
				found = 1
			}
			next
		}
		{ emit($0) }
		END {
			if (unsafe) exit 1
			if (root && !found) emit(managed)
			if (trailing_newline) printf "\n"
		}
	' "$worktrunk_config" > "$worktrunk_tmp"; then
		rm -f "$worktrunk_tmp"
		return 1
	fi
	mv "$worktrunk_tmp" "$worktrunk_config"
}

configure_worktrunk
