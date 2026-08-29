# Leveret Inspect

Static analysis platform built from the specifications in `specs/`.

## Layout

| Path | Contents |
|---|---|
| `specs/` | Behavioural specifications: 14 platform parts, 20 analyzers, 8 integrations, plus the coordination manifest |
| `docs/` | Implementation designs, plans, and operator documentation |
| `runtime/` | Kotlin implementation. Currently the process runtime: `platform/process-runtime` |

## Build

Requires a JDK; bytecode targets JDK 25.

```sh
./gradlew :runtime:test        # unit tests
./gradlew :runtime:installDist # runnable installation under runtime/build/install
```

Operating a built installation: `docs/operating-the-engine.md`.

## Developer setup

```sh
sh scripts/setup-hooks.sh
```

Activates the tracked hooks in `.githooks/`, which keep the `graphify-out/`
knowledge graph current after each commit and branch switch, and builds the
local CodeGraph index. Git will not activate committed hooks on its own, so this
opt-in is required once per clone.
