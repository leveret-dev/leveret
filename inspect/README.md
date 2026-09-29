# Leveret Inspect

The Kotlin/JVM component of the [Leveret monorepo](https://github.com/leveret-dev/leveret).
It has an independent Gradle build; the TypeScript reviewer calls its Java
analysis module only when a trusted host configuration is supplied.
New issues and pull requests belong in `leveret-dev/leveret`.

## Modules

| Path | Purpose |
|---|---|
| `runtime/` | Configuration loading, runtime directories, and logging; produces `bin/leveret-inspect` |
| `persistence/` | Embedded H2 storage, connection pooling, schema initialization, and transactions |
| `java-classpath/` | Cache-only Maven and Gradle-lockfile classpath resolution, without executing the target build or accessing the network |
| `java-analysis/` | JDT extraction of checked Java method calls and method-reference expressions, with explicit unresolved coverage |

Only current implementation files are included. Original repository history, research,
specifications, and generated indexes are not part of this component.

## Build and test

Requires JDK 25 or newer; bytecode targets JDK 25. Dependency versions are pinned in
`gradle/libs.versions.toml` and the module build scripts.

From the monorepo root:

```sh
npm run build:inspect
npm run test:inspect
```

Both commands run the JVM tests. The classpath oracle tests additionally require Linux,
Bubblewrap (`bwrap`), Git, Maven, and JDK 21. Set `LEVERET_ORACLE_JAVA21` to the JDK 21
installation. Cold oracle caches fetch pinned fixture repositories and dependencies.
The test oracles execute fixture build tools; the classpath workers do not.
`java-analysis` currently extracts a single module's configured main/test Java roots.
It resolves source bindings against cache-only classpaths; unresolved sites and missing
dependencies remain coverage gaps, not checked references. Extraction reads sources
and JARs without running the target build or tests. Its Java source level is explicit
and distinct from the worker JDK; broader module resolution is not supported.
Eclipse JDT Core 3.46.0 is used under EPL-2.0; the installed distribution must
retain its license notice.

From `inspect/`:

```sh
./gradlew build                  # compile, package, and test every module
./gradlew assemble              # package without running tests
./gradlew :runtime:installDist   # install under runtime/build/install/leveret-inspect
```

On Windows, use `gradlew.bat` for build tasks that do not require the Linux-only oracle tests.
Git hooks and development tooling are configured only from the monorepo root with
`sh scripts/setup-hooks.sh`.

## Run the runtime

After `:runtime:installDist`, run from `inspect/`:

```sh
runtime/build/install/leveret-inspect/bin/leveret-inspect -Dleveret.log.console=true
```

Without the `java` subcommand, the executable loads settings, prepares its
directories, and reports the resolved configuration; it does not analyze a
repository or clear data for internal Java worker commands.

The installation contains `conf/leveret.properties`. Recognized settings resolve from
that file, environment variables, `-Dkey=value` application arguments, and JVM system
properties, in that order; later sources take precedence. Environment names are uppercased
with dots replaced by underscores, such as `LEVERET_LOG_LEVEL`.

Relative directory settings resolve against the installation home. `data/` is durable,
`logs/` contains `leveret.log`, and `temp/` is cleared at startup. Do not put durable data
in `temp/`. Restrict configuration, data, and log access to the account running the process.

## Internal Java reference worker

The host bridge invokes `leveret-inspect java --request /work/request.json` with
one host-generated JSON command. This is an internal protocol, not a separate
Inspect service or an API for reviewed source to invoke. Analysis uses Git
objects for pinned base/head snapshots, verifies every selected head source
and build metadata file against the live checkout, and rejects dirty or
untracked Java inputs. Skipped Java roots/modules remain in incomplete coverage.
Completed analyses are stored in a dedicated H2 file outside the checkout.

Trusted configuration is a SHA-256-pinned JSON file outside the reviewed
checkout. It selects `repositoryId`, the installed `distribution`, a
`distributionFiles` map containing the launcher and every `lib/` JAR with
SHA-256 digests, `jdkHome` and `jdkFiles` digests for `bin/java`, `release`,
`lib/modules`, and `lib/server/libjvm.so`, the operator-owned bare `cache`,
one `module`, `build` (`maven` or `gradle`), one `mainRoots` and one
`testRoots` entry, `javaLevel`, and positive `limits`. No target repository
file chooses the executable, cache, mounts, or worker limits. Only classpath
artifacts already in the cache are copied into private scratch; provisioning
and target builds are not worker operations.

The reviewer accepts only the paired `LEVERET_INSPECT_JAVA_CONFIG` (absolute
path outside the checkout) and `LEVERET_INSPECT_JAVA_CONFIG_SHA256` (digest of
that file). With neither supplied, Java references are explicitly unavailable.
With both supplied, initialization failures stop the configured review rather
than producing an empty checked-reference list. `leveret_java_references`
selects a declaration by a position inside its name token on the requested
base/head side, returns out-of-diff checked references with separate coverage,
and pages details within its byte budget. Model-visible results carry the
existing tool evidence ID; the model cannot select the worker or its mounts.

The supported extraction host is Linux x86-64 with usable Bubblewrap user,
network, PID, and mount namespaces and `prlimit`. Unavailable isolation fails
closed. Defaults: 1 GiB JVM heap, 8 GiB virtual address-space soft/hard limit,
256 MiB metaspace, 128 MiB each for direct buffers and code cache, a 180-second
deadline, and 8 MiB stdout/stderr capture. The address-space limit is not an
RSS guarantee. The worker receives no inherited provider/GitHub credentials,
HOME contents, network, target executables, or target build invocation.

## License

Project-owned code uses the repository's [AGPL-3.0-or-later license](../LICENSE).
Third-party notices, including those in the Gradle wrapper, remain intact.
The distribution also includes [JDT and Gson notices](runtime/src/main/assembly/THIRD-PARTY-NOTICES.txt).
