# Process Runtime Implementation Design

**Date:** 2026-08-28
**Status:** Approved
**Implements:** `specs/platform/process-runtime/specification.md` (pinned baseline `26.8.0.126808`)
**Part:** `platform/process-runtime` — first implemented part of Leveret Inspect

## 1. Goal

Deliver the supervised-node process runtime for Leveret Inspect: one installation home is turned into a
node that loads settings, prepares runtime directories, launches child processes in dependency order,
observes readiness, coordinates restart and shutdown, and routes operator logs.

This part owns the process identifiers, the node and child lifecycle state machines, the local
inter-process command contract, and the log file policy. Every later part consumes those contracts
rather than redefining them.

## 2. Scope

In scope:

- settings loading with deterministic precedence, alias resolution, and validation;
- runtime directory preparation and temporary-directory cleaning;
- process identities, launch topology, and readiness aggregation;
- child process launch, supervision, and output draining;
- memory-mapped local command file (readiness, stop, hard stop, restart, system-information URL);
- graceful stop, hard stop, escalation, and internal restart;
- per-process log files, levels, layouts, and rolling policies;
- monitor entry point, standalone hard-stop requester, and the reusable child entry point that the
  web and compute children will embed.

Out of scope for this part (owned elsewhere or deferred):

- search, web, and compute behavior — this part only launches and gates them;
- relational schema, migrations, and pool behavior (`platform/persistence`);
- HTTP routing and health payloads (`platform/http-api`);
- multi-node clustering: only the rejection paths that the runtime must honor are implemented;
- archive construction, service wrappers, platform packaging scripts, bundled runtime images.

## 3. Naming and compatibility policy

Product, packages, documentation, log filenames, and canonical configuration keys use Leveret Inspect
naming. Identifiers that the specification marks release-coupled — the local command-file layout,
process keys, and process indexes — are preserved verbatim so existing scanners, operator tooling, and
bundled analyzers remain interoperable.

| Surface | Decision |
|---|---|
| Java package root | `com.leveret.inspect.runtime` |
| Canonical property prefix | `leveret.` |
| Legacy property prefix | `sonar.` accepted as a compatibility alias for every canonical key |
| Base configuration file | `conf/leveret.properties`, falling back to `conf/sonar.properties` |
| Environment variable names | canonical name uppercased with dots and dashes replaced by underscores; the legacy-prefixed form is also accepted |
| Process keys and indexes | `app` 0, `es` 1, `web` 2, `ce` 3 — verbatim |
| Command-file name and layout | `sharedmemory`, five 513-byte slots — verbatim |
| Monitor log file | `leveret.log` |
| Child log files | `es.log`, `web.log`, `ce.log` |

Alias resolution rules:

- a canonical key and its legacy alias carrying equal values resolve silently;
- a canonical key and its legacy alias carrying different values resolve to the canonical value and
  emit a warning naming both keys;
- a legacy-only key resolves to the canonical key and is eligible for every precedence source that the
  canonical key is eligible for.

Human-readable process names are `Leveret Inspect`, `Search`, `Web Server`, and `Compute Engine`. The
search process key stays `es` because it is part of the preserved command-file layout.

## 4. Stack and build

- Kotlin on the JVM, language and toolchain target JDK 21.
- Gradle with the Kotlin DSL, one module: `runtime/`.
- Logging through SLF4J with a Logback backend configured programmatically. The specification treats
  the logging framework as a third-party dependency, so only the observable file, level, layout, and
  rotation behavior is implemented here.
- Tests: JUnit 5 and AssertJ. No mocking framework; child processes and readiness endpoints are
  exercised with real processes and a real loopback HTTP server.

One module rather than four mirrors behavior instead of incidental build structure. The monitor, the
hard-stop requester, and the child entry point are separate entry points inside one artifact because
children are separate operating-system processes, not separate distributions.

## 5. Structure

```
runtime/src/main/kotlin/com/leveret/inspect/runtime/
  config/     Settings, precedence, aliases, argument parsing, validation
  fs/         Directory resolution, creation, temporary-directory cleaning
  ipc/        Memory-mapped command file and per-process command views
  proc/       Process identities, child lifecycle, JVM options, launcher, readiness probes
  supervise/  Node lifecycle, scheduler, reload, stop escalation, command watchers
  log/        Log configuration, layouts, rolling policies
  App.kt              Monitor entry point
  Shutdowner.kt       Standalone hard-stop requester
  ChildEntryPoint.kt  Reusable child lifecycle host
```

Responsibilities and boundaries:

| Unit | Responsibility | Depends on |
|---|---|---|
| `config.Settings` | immutable resolved key-value view with typed accessors | — |
| `config.SettingsLoader` | source ordering, alias resolution, derived home, defaults | `Settings` |
| `config.CommandLineParser` | `-Dkey=value` argument parsing and rejection | — |
| `config.SettingsValidator` | connection-provider and cluster validation before the guarded phase | `Settings` |
| `fs.RuntimeFileSystem` | resolve, verify, create, and clean runtime directories | `Settings` |
| `ipc.CommandFile` | mapped byte layout, slot allocation, slot clearing | `fs` |
| `ipc.ProcessCommands` | one process's flags, ping field, and system-information URL | `CommandFile` |
| `proc.ProcessId` | keys, indexes, log prefixes, display names, lookup and rejection | — |
| `proc.JvmOptions` | option validation, mandatory-option protection, duplicate collapsing | `Settings` |
| `proc.CommandFactory` | per-child command construction and settings handoff file | `JvmOptions`, `Settings` |
| `proc.ProcessLauncher` | operating-system process creation, environment control, output draining | `CommandFactory` |
| `proc.ChildHandler` | child lifecycle machine, watchers, readiness observation, stop escalation | `ProcessCommands`, `ProcessLauncher` |
| `proc.SearchHealth` | search readiness probe over the local search health interface | — |
| `supervise.NodeLifecycle` | node state machine with legal transitions only | — |
| `supervise.Scheduler` | dependency-ordered start, gates, restart, reverse-ordered stop | `ChildHandler`, `NodeLifecycle` |
| `supervise.Reloader` | settings reload with immutable-property rejection | `SettingsLoader` |
| `supervise.StopWatchers` | stop and hard-stop command watchers, shutdown hook | `ProcessCommands`, `Scheduler` |
| `log.LogConfig` | file targets, level precedence, layout selection, rolling policy | `Settings` |

## 6. Configuration contract

### 6.1 Precedence

For a recognized key, later sources override earlier ones:

1. `conf/leveret.properties`, otherwise `conf/sonar.properties`, decoded as UTF-8;
2. environment variables;
3. application arguments in `-Dkey=value` form;
4. JVM system properties whose names begin with the canonical or legacy prefix;
5. the runtime-owned installation home;
6. defaults, applied only to keys still unset.

A missing configuration file produces a warning and an empty base configuration. An existing but
unreadable file fails loading. Every application argument must begin with `-D` and contain `=`; any
malformed argument fails configuration loading. Only declared properties, file-present properties, and
recognized dynamic settings are eligible for environment override.

Installation home is derived from the location of the running application artifact and is written to
`leveret.path.home` after all other sources are applied; an operator-supplied value never replaces it.

### 6.2 Directories

| Canonical property | Default | Behavior |
|---|---|---|
| `leveret.path.data` | `data` | persistent node data; created if absent, never cleared by startup |
| `leveret.path.logs` | `logs` | log directory; created if absent |
| `leveret.path.temp` | `temp` | runtime scratch and command-file directory; created or cleaned at startup and internal restart |
| `leveret.path.web` | `web` | web runtime directory; created if absent |
| `leveret.path.home` | derived | absolute installation home, runtime-owned |

A relative configured path resolves against installation home and is converted to absolute. An
existing path that is not a directory, or a directory that cannot be created, aborts startup.

Temporary-directory cleaning removes files and child directories one level beneath the temporary root.
The command file is retained long enough to be remapped, then every slot is cleared. Persistent data
and logs are never cleaned.

### 6.3 JVM options

| Process | Primary default |
|---|---|
| Search | `-Xmx512m -Xms512m -XX:MaxDirectMemorySize=256m -XX:+HeapDumpOnOutOfMemoryError` |
| Web | `-Xmx512m -Xms128m -XX:+HeapDumpOnOutOfMemoryError` |
| Compute engine | `-Xmx512m -Xms128m -XX:+HeapDumpOnOutOfMemoryError` |

Properties are `leveret.<search|web|ce>.javaOpts` and `leveret.<search|web|ce>.javaAdditionalOpts`;
additional properties default to empty. Every supplied option must be nonempty and begin with `-`.
Mandatory options — UTF-8 encoding, headless mode, the runtime temporary directory, and required
module access — cannot be given a different value; an attempted override fails command construction.
Exact duplicates are collapsed with insertion order retained. Proxy-related system properties
propagate unless the process option list already defines the same property.

The search-specific external options variable is ignored with a warning. Web and compute children do
not inherit generic JVM tool options.

### 6.4 Stop and log properties

| Canonical property | Default | Behavior |
|---|---|---|
| `leveret.web.gracefulStopTimeOutInMs` | `240000` | integer of at least 1 |
| `leveret.ce.gracefulStopTimeOutInMs` | `21600000` | integer of at least 1 |
| `leveret.enableStopCommand` | absent or false | enables the graceful-stop command watcher |
| `leveret.log.level` | `INFO` | global threshold; `INFO`, `DEBUG`, `TRACE` |
| `leveret.log.level.<app\|web\|ce\|es>` | unset | per-process override, higher precedence than global |
| `leveret.log.console` | `false` | forward child log output to monitor standard output |
| `leveret.log.jsonOutput` | `false` | select the JSON layout |
| `leveret.log.rollingPolicy` | `time:yyyy-MM-dd` | `time:<pattern>`, `size:<file-size>`, or `none` |
| `leveret.log.maxFiles` | `7` | retained periods or numbered files |

Unsupported levels and unsupported rolling policies fail logging configuration. The hard-stop watcher
always runs regardless of the stop-command property.

### 6.5 Validation performed before the guarded phase

Settings validation runs before child scheduling and, on failure, terminates with nonzero status:

- the connection URL must be a nonempty `jdbc:<provider>:` form whose provider, case-normalized, is
  one of `h2`, `sqlserver`, `oracle`, `postgresql`; any other value fails;
- cluster activation is recognized and, when set, disables internal restart and narrows the enabled
  child set as the specification describes.

Full connection, pool, and migration behavior belongs to `platform/persistence`. This part exposes a
validation hook so that the persistence implementation can extend validation without duplicating the
loading algorithm.

## 7. Process identities and launch topology

| Process | Key | Index | Log prefix | Display name |
|---|---|---:|---|---|
| Monitor | `app` | 0 | `leveret` | Leveret Inspect |
| Search | `es` | 1 | `es` | Search |
| Web server | `web` | 2 | `web` | Web Server |
| Compute engine | `ce` | 3 | `ce` | Compute Engine |

Five slots are reserved; this release uses indexes 0 through 3. Unknown keys and indexes outside 0
through 4 are rejected.

Standalone startup enables search, web, and compute, gated rather than concurrent:

1. search launches first;
2. web waits until search is operational;
3. the startup-leading web process performs shared initialization; a non-leading web process waits for
   that initialization to complete;
4. compute launches only after web and search are operational.

The monitor logs its first wait for search. Children inherit the monitor environment except explicit
additions and suppressions. Web and compute receive effective settings through a temporary properties
file in the temporary directory; that file also carries the internal process key, process index,
graceful-stop timeout, and shared directory fields. Standard error is merged into standard output.
Failure to create the handoff file or the operating-system process is a launch failure.

Readiness:

- web and compute publish `UP` when their monitored component is no longer down, then `OPERATIONAL`
  when it reaches operational status; the supervisor polls command state every 500 ms and emits each
  operational event once;
- search readiness uses the local search health interface instead of the operational flag: yellow or
  green is operational, red or an error is not, and connection refusal is retried at 100 ms intervals
  for up to 600 attempts within one readiness check;
- the node becomes operational only after every enabled child has emitted its operational event.

The search health probe is expressed as an interface with a loopback HTTP implementation, addressed by
`leveret.search.host` defaulting to `127.0.0.1` and `leveret.search.port` defaulting to `9001`. These
two keys are a provisional handoff; `platform/search-indexing` becomes their owner when implemented.

## 8. Lifecycle state machines

Node states begin at `INIT`. Legal transitions:

- `INIT` to `STARTING`;
- `STARTING` to `OPERATIONAL`, `RESTARTING`, `STOPPING`, or `HARD_STOPPING`;
- `OPERATIONAL` to `RESTARTING`, `STOPPING`, or `HARD_STOPPING`;
- `RESTARTING` to `STARTING` or `HARD_STOPPING`;
- `STOPPING` to `FINALIZE_STOPPING` or `HARD_STOPPING`;
- `HARD_STOPPING` to `FINALIZE_STOPPING`;
- `FINALIZE_STOPPING` to `STOPPED`.

`STOPPED` is terminal for a monitor instance. Invalid and duplicate transition requests are ignored
rather than producing a second transition.

Supervisor-side child states are `INIT`, `STARTING`, `STARTED`, `STOPPING` or `HARD_STOPPING`,
`FINALIZE_STOPPING`, `STOPPED`. `STARTED` means the operating-system process was launched and watchers
installed; it is not node readiness. Inside web and compute children the lifecycle adds
`OPERATIONAL`.

## 9. Local command contract

One memory-mapped file named `sharedmemory` under the temporary directory carries a slot for every
process index, including search. Each slot is 513 bytes: five one-byte flags, an eight-byte ping
field, and a 500-byte ASCII system-information URL field. Flags are `UP`, hard stop, graceful stop,
restart request, and `OPERATIONAL`. A restart requester clears its request only after the monitor
acknowledges it. URLs longer than 500 encoded bytes are rejected.

A main child view clears its own slot before use; secondary views read and write without clearing.
Monitor startup clears every reserved slot so state from an earlier instance cannot make a child
appear ready or trigger a restart.

This is local file coordination, not a network protocol: no authentication, no encryption. Filesystem
ownership and permissions on installation home and the temporary directory are part of the trust
boundary, and the handoff properties file can contain effective secrets.

## 10. Restart and shutdown

Internal restart: web or compute sets the restart flag; the supervisor acknowledges it, moves the node
to `RESTARTING`, gracefully stops all enabled children, reloads configuration, resets temporary
filesystem and command state, reconfigures monitor logging, resets shared application state, and
schedules children again. Data, web, log, and temporary paths and cluster activation must not change
across an internal restart; a rejected reload or failed reschedule is logged and converted to a hard
stop. Internal restart is rejected while cluster activation is set.

An unexpected child exit is never an automatic per-child restart. With no stop or restart in progress,
the supervisor hard-stops the whole node.

Graceful stop order is compute, web, then search. Search maps graceful stop to operating-system
termination; web and compute run their own graceful-stop logic. A child receives its configured
timeout plus 30 seconds; the supervisor allows the configured timeout plus 60 seconds before
escalating. A shutdown hook, including interrupt handling, stops the command watchers and performs a
blocking graceful node stop; releasing the startup-leader lock is best-effort.

Hard stop follows the same reverse order. A hard-stopped child has a one-second internal deadline; the
supervisor waits up to one minute, then forcibly destroys any remaining process, closes streams,
drains output readers, and finalizes child state. A graceful-stop timeout escalates into this path.

The standalone hard-stop requester derives installation home only to read the configuration file. It
resolves a relative temporary path against its own working directory rather than installation home, so
a correct invocation runs with installation home as working directory or configures an absolute
temporary path. It writes the monitor hard-stop flag, and on a detected configuration or input-output
failure prints an error to standard error and exits 1.

## 11. Failure behavior

- Settings loading, settings validation, and logging configuration run before the guarded startup
  phase. Their failures prevent child scheduling and terminate with nonzero status. This includes
  malformed application arguments, an unreadable configuration file, connection or cluster validation
  failures, and unsupported logging configuration.
- Directory preparation, command construction, mandatory-option violations, and launch failures occur
  inside the guarded phase: they are logged as startup failures, applicable children are stopped, and
  the monitor then follows its status-0 termination path. Operators must use readiness and logs, not
  exit status alone, to distinguish successful startup from a guarded-phase failure.
- A failed child launch moves that child toward stopped state and the scheduler hard-stops the node.
  No later dependency is reported operational.
- A readiness-check error leaves the child non-operational. Search health errors are logged.
- Interrupted startup restores the interrupt flag and proceeds to node termination. Interrupted stop
  waits are logged and the hard-stop path prevents orphaned children.
- Output-reader failures are suppressed and never change process state; readiness and operating-system
  liveness remain authoritative.
- Recovery after a terminal stopped monitor requires a new monitor instance.

## 12. Logging

Each process writes a dedicated active log under the log directory: `leveret.log`, `es.log`,
`web.log`, `ce.log`. Child standard output and standard error are merged and drained so early startup
and crash output stay observable, and are additionally forwarded to monitor standard output when
console logging is enabled.

Plain records contain timestamp, severity, optional node name, process key, thread identity, shortened
logger name, and message. JSON records contain the node name when present, the process key,
non-excluded diagnostic-context fields, timestamp, severity, logger, message, and a stack-trace array
when an exception exists. Each event is one terminated record and newlines inside JSON messages are
normalized.

Time-based rotation keeps the configured number of periods; size-based rotation uses numbered files
from 1 through the configured maximum; the `none` policy keeps only the active file. SQL statement
logging and access logging belong to their owning parts.

## 13. Testing strategy

Development is test-first: a failing test per behavior, then the minimal implementation.

Unit coverage:

- precedence across all five sources, alias conflict warning, derived home override, malformed
  argument rejection, environment eligibility;
- directory resolution, non-directory rejection, one-level temporary cleaning with command-file
  retention, data and log preservation;
- command-file byte layout round-trip, slot isolation, oversized URL rejection, clear-on-start,
  restart acknowledgement ordering;
- node and child state machines: every legal transition, and silence on illegal or duplicate
  transitions;
- JVM option validation, mandatory-option protection, duplicate collapsing, proxy propagation;
- log level precedence, plain and JSON field sets, all three rolling policies, unsupported-value
  failures;
- process identity lookup and index rejection.

Integration coverage runs a real monitor process against a loopback search health server and two real
children hosted by the child entry point. The specification's ten acceptance scenarios map one to one:

| Scenario | Integration assertion |
|---|---|
| 1 Standalone startup reaches operational | launch order search, web, compute; node reports operational |
| 2 Configuration precedence is deterministic | removing each source in turn exposes the next value; home stays derived |
| 3 Search never becomes ready | web and compute never scheduled; node never operational; health errors logged |
| 4 Unexpected child loss stops the node | killing web hard-stops remaining children, no per-child restart |
| 5 Graceful stop preserves reverse order | compute before web before search; survivor escalated |
| 6 Internal restart reloads allowed settings | acknowledgement, full stop, reload, temporary reset, restart |
| 7 Internal restart rejects immutable change | reload reports the immutable property and the node hard-stops |
| 8 Logging modes remain compatible | file prefixes, default plain daily rotation with 7 periods, JSON fields, per-process threshold |
| 9 Command state is reset across monitors | stale flags cannot make a child ready or trigger restart |
| 10 Hard-stop requester targets the intended file | home-relative invocation stops the node; foreign working directory does not |

Smoke verification for the part is a real monitor launch that reaches operational state with stub
children and then stops in reverse order, observed from the log files.

## 14. Risks and deferrals

- The search readiness address keys are provisional and transfer to `platform/search-indexing`.
- Cluster mode is implemented only as recognized rejection and enabled-child narrowing; no
  multi-node coordination is built.
- The connection-setting validation implemented here is the minimum the monitor needs before the
  guarded phase; `platform/persistence` extends it through the validation hook.
- Memory-mapped file behavior differs across operating systems in flush timing; integration tests
  assert observable flag transitions rather than mapping internals.
