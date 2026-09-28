# Monorepo: Leveret and Leveret Inspect

[`leveret-dev/leveret`](https://github.com/leveret-dev/leveret) is the canonical repository
for both components. Tracking issue:
[leveret-dev/leveret#76](https://github.com/leveret-dev/leveret/issues/76).

## Layout and boundary

| Component | Location | Toolchain |
|---|---|---|
| Leveret (engine, MCP server, runner, GitHub App) | repository root | Node.js, TypeScript, npm |
| Leveret Inspect (Kotlin/JVM static analysis platform) | [`inspect/`](../inspect/README.md) | JDK 25+, Gradle wrapper |

The components share a repository, not a runtime. Nothing in the TypeScript code calls the
Kotlin modules or the reverse, and the merge added no integration. Inspect keeps its own
`inspect/settings.gradle.kts`, module names (`runtime`, `persistence`, `java-classpath`),
Kotlin packages (`com.leveret.inspect.*`), and pinned dependency versions. Its approved scope
is [`inspect/docs/specs/2026-08-29-scope-decision.md`](../inspect/docs/specs/2026-08-29-scope-decision.md).

Documents imported into `inspect/` are historical and keep their original relative paths.
Read every path in them as relative to `inspect/`.

## Commands

Use the [root command table](../README.md#repository-layout) for combined and per-component
builds. Inspect's [build prerequisites](../inspect/README.md#build) also cover its oracle tests.

Hooks are set up only from the repository root with `sh scripts/setup-hooks.sh`.
Inspect's duplicate hooks, developer scripts, tooling tests, and stale generated indexes
are removed after the history import; the root owns their shared replacements.

The root knowledge graph covers both components. Inspect no longer restricts indexing to
its old standalone corpus; new graph builds include its classpath worker as well as its
runtime, persistence, specifications, and design documents. Run graph tooling from the
repository root.

## Import provenance

Inspect history was imported from
[`leveret-dev/leveret-inspect`](https://github.com/leveret-dev/leveret-inspect) at commit
`e42436d5f4beea70657a2dbd50f8b653c13d6402`.

- 74 source commits were replayed under `inspect/` on top of Leveret commit
  `f24b584554704763efcead35163a8975f802906e`. The import tip is
  `1f9812be8853ea2c8cb507df4d08c48070c607b9`.
- Each commit keeps its message content, author, and author date. Its hash changed:
  `main` requires linear history, so the commits were replayed rather than merged.
  Original SHAs remain available in the source repository, not as ancestors of monorepo `main`.
- At the import tip, all 118 imported files match the source at `e42436d` byte for byte,
  including file modes. Subsequent monorepo integration updates documentation and removes
  duplicate repository tooling and stale generated indexes; production code is unchanged.
- Uncommitted local work in the original checkouts is not part of the import. Only the
  commits up to the source SHA above were brought over.

The source repository was private at import. Publishing the replayed history makes all
imported revisions visible, including files later removed from the current tree; it is
not limited to the final `inspect/` snapshot.

## Issues and pull requests

- Historical issues and pull requests keep their source-repository identity. Reference them
  as `leveret-dev/leveret-inspect#N`; a bare `#N` in imported commit messages or documents
  refers to that repository, not this one.
- New issues and pull requests, for either component, go to `leveret-dev/leveret`.
- `leveret-dev/leveret-inspect` is left in place as a historical record. It is neither
  deleted nor archived by this migration.
- The outstanding Graphify tooling fix from
  [leveret-dev/leveret-inspect#5](https://github.com/leveret-dev/leveret-inspect/issues/5) and
  [leveret-dev/leveret-inspect#6](https://github.com/leveret-dev/leveret-inspect/pull/6)
  already has its monorepo counterparts:
  [leveret-dev/leveret#74](https://github.com/leveret-dev/leveret/issues/74) and
  [leveret-dev/leveret#75](https://github.com/leveret-dev/leveret/pull/75).
  It now targets the root `scripts/agent/ensure-graphify.sh` and its root shell tests,
  not another copy under `inspect/`.
