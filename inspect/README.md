# Leveret Inspect

Static analysis platform built from the specifications in `specs/`. It lives in the
[Leveret monorepo](https://github.com/leveret-dev/leveret) under `inspect/`. It is a
self-contained Gradle build with no runtime coupling to the TypeScript code at the
repository root. See [`../docs/monorepo.md`](../docs/monorepo.md) for how the two were joined.

All paths in this file and in the documents under `inspect/docs/` and `inspect/specs/` are
relative to `inspect/`.

## Layout

| Path | Contents |
|---|---|
| `specs/` | Behavioural specifications and provenance records, scoped by the approved scope decision below |
| `docs/` | Implementation designs, plans, spikes, and operator documentation. Scope: [`docs/specs/2026-08-29-scope-decision.md`](docs/specs/2026-08-29-scope-decision.md) |
| `runtime/` | Process runtime (`platform/process-runtime`): settings, runtime directories, logging, startup. Produces the runnable `bin/leveret-inspect` |
| `persistence/` | Embedded relational store (H2 behind HikariCP) and schema, session, and pool handling. Depends on `runtime` |
| `java-classpath/` | Cache-only Java classpath workers. They read Maven models or Gradle dependency lockfiles and resolve artifacts from a local Maven-format cache without running the target build or accessing the network |

Module names, Kotlin packages (`com.leveret.inspect.*`), and the Gradle root project name
(`leveret-inspect`) are unchanged by the move into the monorepo.

## Build

A JDK 25 or newer is required. Bytecode targets JDK 25, and dependency versions are pinned
in `gradle/libs.versions.toml` and the module build scripts. The Gradle wrapper downloads
Gradle itself.

The classpath oracle tests additionally require Linux with Bubblewrap (`bwrap`), Git,
Maven, and a JDK 21 installation selected with `LEVERET_ORACLE_JAVA21`. The oracle
harnesses fetch pinned fixture repositories and dependencies when their caches are cold.
Only the test oracles execute those fixture builds; the classpath workers do not.

From the repository root:

```sh
npm run build:inspect   # ./inspect/gradlew -p inspect build
npm run test:inspect    # ./inspect/gradlew -p inspect test
```

From `inspect/` (equivalent, and what standalone use looked like before the merge):

```sh
./gradlew build                    # compile and test every module
./gradlew test                     # tests only
./gradlew :runtime:test            # one module
./gradlew :runtime:installDist     # runnable installation under runtime/build/install
```

Operating a built installation: [`docs/operating-the-engine.md`](docs/operating-the-engine.md).

## Developer setup

Git hooks are configured once per clone from the **repository root**, not from `inspect/`:

```sh
sh scripts/setup-hooks.sh
```

The script points `core.hooksPath` at the root `.githooks/`. Inspect's duplicate repository
hooks and setup scripts have been removed. Historical setup instructions under `inspect/docs/`
do not override the monorepo setup.
