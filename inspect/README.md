# Leveret Inspect

The Kotlin/JVM component of the [Leveret monorepo](https://github.com/leveret-dev/leveret).
It has an independent Gradle build; the TypeScript reviewer does not yet call these modules.
New issues and pull requests belong in `leveret-dev/leveret`.

## Modules

| Path | Purpose |
|---|---|
| `runtime/` | Configuration loading, runtime directories, and logging; produces `bin/leveret-inspect` |
| `persistence/` | Embedded H2 storage, connection pooling, schema initialization, and transactions |
| `java-classpath/` | Cache-only Maven and Gradle-lockfile classpath resolution, without executing the target build or accessing the network |

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

The executable loads settings, prepares its directories, and reports the resolved
configuration. It does not yet invoke an analysis pipeline.

The installation contains `conf/leveret.properties`. Recognized settings resolve from
that file, environment variables, `-Dkey=value` application arguments, and JVM system
properties, in that order; later sources take precedence. Environment names are uppercased
with dots replaced by underscores, such as `LEVERET_LOG_LEVEL`.

Relative directory settings resolve against the installation home. `data/` is durable,
`logs/` contains `leveret.log`, and `temp/` is cleared at startup. Do not put durable data
in `temp/`. Restrict configuration, data, and log access to the account running the process.

## License

Project-owned code uses the repository's [AGPL-3.0-or-later license](../LICENSE).
Third-party notices, including those in the Gradle wrapper, remain intact.
