# SonarQube Community Build Process Runtime Specification

## 1. Identity and provenance

This specification describes the process runtime shipped with SonarQube Community Build `26.8.0.126808`, published on 2026-08-05 from Git tag `26.8.0.126808` and commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The release artifact is `sonarqube-26.8.0.126808.zip`, whose recorded SHA-256 is `ea1c5c1932f9c25350eafc4cdb1a839527c117e5d98b5fcf222a715b6b50a1f2`. The authoritative public release is https://github.com/SonarSource/sonarqube/releases/tag/26.8.0.126808. [Provenance: `manifest/release-baseline.md`; https://github.com/SonarSource/sonarqube/releases/tag/26.8.0.126808]

The covered production source is licensed under `LGPL-3.0-or-later`. This is a clean-room behavioral specification, not a copy marker and not legal advice. [Provenance: `LICENSE.txt`; `manifest/license-map.md`]

Pinned source scope:

- `sonar-application/src/main/java/org/sonar/application/App.java` and `sonar-application/src/main/assembly/conf/sonar.properties` for the monitor entry point and operator configuration surface.
- `server/sonar-main/src/main/java/org/sonar/application/` for configuration loading, directory preparation, command creation, child supervision, readiness, restart, shutdown, and application logging.
- `server/sonar-process/src/main/java/org/sonar/process/` for process identifiers, child entry-point lifecycle, shared-memory commands, timeout validation, and common logging.
- `sonar-shutdowner/src/main/java/org/sonar/application/Shutdowner.java` for the standalone hard-stop requester.

## 2. Purpose, scope, and exclusions

The process runtime turns one installation home into a supervised SonarQube node. It loads node-level settings, prepares runtime directories, launches enabled child processes in dependency order, observes readiness, forwards early output, coordinates restart and shutdown, and emits operator logs. It owns the stable process identifiers and the node and child lifecycle state machines. [Provenance: `sonar-application/src/main/java/org/sonar/application/App.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `server/sonar-process/src/main/java/org/sonar/process/ProcessId.java`]

This specification does not describe archive construction, service-wrapper internals, platform-specific packaging scripts, bundled JRE construction, or WinSW internals. It also does not redefine search behavior, HTTP routes and health payloads, compute-task behavior, database compatibility, plugin loading, or telemetry health composition. Those contracts belong respectively to `platform/search-indexing/`, `platform/http-api/`, `platform/compute-engine/`, `platform/persistence/`, `platform/plugin-extension-runtime/`, and `platform/telemetry-monitoring/`. [Provenance: `manifest/component-inventory.md`; `manifest/dependency-map.md`]

Pinned source contains multi-node process-selection branches. This specification records only their process-runtime effects. It does not assert availability or entitlement of any commercial clustering feature. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/ClusterSettings.java`]

## 3. Owned contracts and dependencies

This part is the sole owner of:

- process keys, IPC indexes, human-readable names, and log-file prefixes;
- node and child lifecycle states and allowed transitions;
- dependency-ordered launch and reverse-ordered stop;
- operational readiness aggregation;
- shared-memory stop, hard-stop, restart, readiness, and system-information URL slots;
- restart reload boundaries and shutdown escalation;
- monitor and child log routing, format selection, and rotation.

Consumers must reference these contracts rather than create parallel lifecycle or IPC definitions. Persistence supplies database readiness and migration state but does not redefine process readiness. Search, HTTP, and compute components declare their own internal readiness and then publish the common process-runtime operational signal. [Provenance: `manifest/dependency-map.md`; `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/ProcessCommands.java`]

Runtime dependencies are a Java runtime, a writable installation runtime area, operating-system process creation, and the Sonar-facing health interface of the local search child. Third-party process, logging, or search implementations are dependencies and are not specified beyond these interoperability points. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/ProcessLauncherImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/process/EsManagedProcess.java`]

### 3.1 Accepted inputs and outputs

Accepted inputs are installation-home configuration, recognized environment and JVM overrides, application `-Dkey=value` arguments, operating-system shutdown signals, child liveness and readiness observations, and local IPC flags. The runtime also consumes the configured Java executable environment and writable data, log, web, and temporary paths. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/AppSettingsLoaderImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/AppFileSystem.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/ProcessCommands.java`]

Outputs are launched and terminated child processes; node and child lifecycle changes; `UP` and `OPERATIONAL` readiness state; acknowledged restart state; dedicated process log files and optional console records; and final monitor termination. HTTP health documents, database state, search indexes, and compute results are outputs of their owning parts, not this runtime. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `server/sonar-process/src/main/java/org/sonar/process/ProcessEntryPoint.java`; `manifest/dependency-map.md`]

## 4. Installation-home and configuration contract

### 4.1 Home and directories

The monitor derives installation home from the location of its application artifact. `sonar.path.home` is then set to that absolute path after file, environment, command-line, and JVM-system-property loading; an operator-supplied value does not replace the derived home. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/AppSettingsLoaderImpl.java`]

The runtime recognizes these directory properties:

| Property | Default | Runtime behavior |
|---|---:|---|
| `sonar.path.data` | `data` | Persistent node data directory; created if absent and never cleared by process startup. |
| `sonar.path.logs` | `logs` | Log directory; created if absent. |
| `sonar.path.temp` | `temp` | Runtime scratch and IPC directory; created or cleaned at monitor startup and internal restart. |
| `sonar.path.web` | `web` | Web runtime directory; created if absent. |
| `sonar.path.home` | derived | Absolute installation home; runtime-owned. |

A relative configured path is resolved against installation home and converted to an absolute path. Existing paths must be directories. Failure to create a directory, or a configured path resolving to a non-directory, aborts startup. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/FileSystemSettings.java`; `server/sonar-main/src/main/java/org/sonar/application/AppFileSystem.java`]

At startup and internal restart, the temporary directory is cleaned to one level beneath its root. The shared-memory file is retained long enough to be remapped and then all process command slots are cleared. Other files and child directories at that level are removed. Persistent data and logs are not cleaned. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/AppFileSystem.java`; `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/AllProcessesCommands.java`]

### 4.2 Configuration sources and precedence

The base file is `${sonar.path.home}/conf/sonar.properties`, decoded as UTF-8. A missing file produces a warning and an empty base configuration; an unreadable existing file fails loading. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/AppSettingsLoaderImpl.java`]

For recognized keys, later sources override earlier ones in this order:

1. `conf/sonar.properties`;
2. environment variables;
3. application arguments in `-Dkey=value` form;
4. JVM system properties whose names begin with `sonar.`;
5. runtime-owned `sonar.path.home`;
6. defaults, applied only to still-unset keys.

Environment names are the uppercase property name with dots and dashes replaced by underscores. Only declared process properties, file-present properties, and recognized dynamic settings are eligible for environment override. Every application argument must begin with `-D` and contain `=`; any malformed argument fails configuration loading. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/AppSettingsLoaderImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/config/CommandLineParser.java`]

### 4.3 JVM options

The process-specific option properties are `sonar.search.javaOpts`, `sonar.search.javaAdditionalOpts`, `sonar.web.javaOpts`, `sonar.web.javaAdditionalOpts`, `sonar.ce.javaOpts`, and `sonar.ce.javaAdditionalOpts`. Primary properties default to the release values recorded below; additional properties default to empty.

| Process | Primary default |
|---|---|
| Search | `-Xmx512m -Xms512m -XX:MaxDirectMemorySize=256m -XX:+HeapDumpOnOutOfMemoryError` |
| Web | `-Xmx512m -Xms128m -XX:+HeapDumpOnOutOfMemoryError` |
| Compute engine | `-Xmx512m -Xms128m -XX:+HeapDumpOnOutOfMemoryError` |

Every supplied option must be nonempty and begin with `-`. Process-mandatory options, including UTF-8 encoding, headless mode, the runtime temporary directory, and required module access, cannot be replaced with a different value. Exact duplicate options are collapsed while insertion order is retained. An invalid option or attempted mandatory-option override fails command construction. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`; `server/sonar-main/src/main/java/org/sonar/application/command/JvmOptions.java`; `server/sonar-main/src/main/java/org/sonar/application/command/WebJvmOptions.java`; `server/sonar-main/src/main/java/org/sonar/application/command/CeJvmOptions.java`; `server/sonar-main/src/main/java/org/sonar/application/command/EsJvmOptions.java`]

`ES_JAVA_OPTS` is ignored and causes a warning. Web and compute children do not inherit `JAVA_TOOL_OPTIONS`. Operators must use the Sonar properties above. Proxy-related JVM properties are propagated unless the process-specific option list already defines the same property. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/command/CommandFactoryImpl.java`]

## 5. Process identities and launch topology

The stable identities are:

| Process | Key | IPC index | Log prefix | Human-readable name |
|---|---:|---:|---|---|
| Monitor | `app` | 0 | `sonar` | SonarQube |
| Search | `es` | 1 | `es` | ElasticSearch |
| Web server | `web` | 2 | `web` | Web Server |
| Compute engine | `ce` | 3 | `ce` | Compute Engine |

The IPC layout reserves five process slots; this release uses indexes 0 through 3. Unknown process keys and indexes outside 0 through 4 are rejected. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessId.java`; `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/ProcessCommands.java`; `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/AllProcessesCommands.java`]

In standalone mode, enabled children are search, web, and compute. Startup attempts follow that dependency order, but later processes are gated rather than launched concurrently without prerequisites:

1. Search launches first.
2. Web waits until search is operational.
3. The startup-leading web process performs shared initialization; a nonleader web process waits for that initialization.
4. Compute launches only after web and search are operational.

The monitor logs its first wait for search. In the multi-node compatibility branch, an application node enables web and compute, while a search node enables only search. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/config/ClusterSettings.java`]

Child Java processes inherit the monitor environment except for explicit additions and suppressions. Web and compute receive effective settings through a temporary properties file in `sonar.path.temp`; that file also carries internal `process.key`, `process.index`, `process.gracefulStopTimeout`, and `process.sharedDir` fields. Standard error is merged into standard output. A failure to create the temporary file or operating-system child process is a launch failure. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/ProcessLauncherImpl.java`; `server/sonar-process/src/main/java/org/sonar/process/ProcessEntryPoint.java`]

## 6. Lifecycle and readiness

### 6.1 Node state machine

The node begins in `INIT`. Allowed transitions are:

- `INIT` to `STARTING`;
- `STARTING` to `OPERATIONAL`, `RESTARTING`, `STOPPING`, or `HARD_STOPPING`;
- `OPERATIONAL` to `RESTARTING`, `STOPPING`, or `HARD_STOPPING`;
- `RESTARTING` to `STARTING` or `HARD_STOPPING`;
- `STOPPING` to `FINALIZE_STOPPING` or `HARD_STOPPING`;
- `HARD_STOPPING` to `FINALIZE_STOPPING`;
- `FINALIZE_STOPPING` to `STOPPED`.

`STOPPED` is terminal for the monitor instance. Invalid or duplicate transition requests are ignored rather than creating a second transition. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/NodeLifecycle.java`]

### 6.2 Child state machine

Each supervisor-side child begins in `INIT` and may move through `STARTING`, `STARTED`, `STOPPING` or `HARD_STOPPING`, `FINALIZE_STOPPING`, and `STOPPED`. `STARTED` means that the operating-system process was launched and watchers were installed; it is not the node readiness signal. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessLifecycle.java`; `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`]

Inside web and compute children, lifecycle adds an `OPERATIONAL` state. A child first reports `UP` when its monitored component is no longer down, then reports `OPERATIONAL` only when the component reaches its operational status. The supervisor polls command state every 500 ms and emits each operational event once. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessEntryPoint.java`; `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`]

Search readiness does not use the child operational byte. The supervisor queries the Sonar-facing search health interface: `YELLOW` or `GREEN` is operational; `RED`, an error, or an absent connection is not. Connection refusal is retried at 100 ms intervals for up to 600 attempts during one readiness check. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/EsManagedProcess.java`]

The node becomes `OPERATIONAL` only after every enabled child has emitted its operational event. Operator HTTP health details are owned by `platform/http-api/`; this state is the process-runtime readiness contract they consume. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `manifest/dependency-map.md`]

## 7. IPC contract

Local monitor, web, and compute IPC commands share one memory-mapped file named `sharedmemory` under `sonar.path.temp`; the layout reserves a slot for every process index, including search. Each slot is 513 bytes: five one-byte flags, an eight-byte ping field, and a 500-byte ASCII system-information URL field. The flags represent `UP`, hard stop, graceful stop, restart request, and `OPERATIONAL`. The restart requester clears its request only after the monitor acknowledges it. URLs longer than 500 encoded bytes are rejected. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/AllProcessesCommands.java`; `server/sonar-main/src/main/java/org/sonar/application/process/EsManagedProcess.java`]

A main child command view clears its own slot before use. Secondary views can read and write without clearing. Monitor startup clears every reserved slot to prevent stale state from an earlier process instance. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/DefaultProcessCommands.java`; `server/sonar-main/src/main/java/org/sonar/application/AppFileSystem.java`]

IPC is local-file coordination, not a network protocol. It has no authentication or message encryption. Filesystem ownership and permissions on installation home and `sonar.path.temp` are therefore part of the trust boundary. Untrusted users must not be able to modify the temporary settings files or the shared-memory file. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/ProcessLauncherImpl.java`; `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/AllProcessesCommands.java`]

## 8. Restart and shutdown

### 8.1 Internal restart

Web or compute may set the restart flag. The supervisor acknowledges it, moves the node to `RESTARTING`, gracefully stops all enabled children, reloads configuration, resets temporary filesystem and IPC state, reconfigures monitor logging, resets shared application state, and schedules children again. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/AppReloaderImpl.java`]

Internal restart is rejected in the multi-node compatibility branch. `sonar.path.data`, `sonar.path.web`, `sonar.path.logs`, `sonar.path.temp`, and `sonar.cluster.enabled` must remain unchanged across an internal restart. A reload or reschedule failure is logged and converted to a hard stop. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/AppReloaderImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]

An unexpected child exit is not treated as an automatic per-child restart. If no restart or stop is in progress, the supervisor hard-stops the whole node. This prevents a partially operational node. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`]

### 8.2 Graceful stop

Normal stop order is compute, web, then search. Each enabled child receives a graceful-stop command and the supervisor waits synchronously. Search maps graceful stop directly to operating-system termination. Web and compute run their own graceful-stop logic. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/process/EsManagedProcess.java`; `server/sonar-process/src/main/java/org/sonar/process/ProcessEntryPoint.java`]

`sonar.web.gracefulStopTimeOutInMs` defaults to `240000`; `sonar.ce.gracefulStopTimeOutInMs` defaults to `21600000`. Values must parse as integers of at least 1 ms. The child receives the configured value plus 30 seconds; the supervisor allows the configured value plus 60 seconds before escalating. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`; `server/sonar-main/src/main/java/org/sonar/application/command/CommandFactoryImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]

`sonar.enableStopCommand` enables the monitor's graceful-stop IPC watcher. With the property absent or false, that watcher is not started. The hard-stop watcher always runs. A JVM shutdown hook, including Ctrl-C handling, stops command watchers and performs a blocking graceful node stop. Releasing the startup-leader lock is best-effort and cannot prevent child termination. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/StopRequestWatcherImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/HardStopRequestWatcherImpl.java`; `sonar-application/src/main/java/org/sonar/application/App.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]

### 8.3 Hard stop and escalation

Hard stop follows the same reverse dependency order. A child given a hard-stop command has a one-second internal stop deadline. The supervisor waits up to one minute for a hard stop and then forcibly destroys any remaining operating-system process, closes streams, drains output gobblers, and finalizes the child state. A graceful-stop timeout also escalates to this path. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessEntryPoint.java`; `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]

The standalone shutdown helper derives installation home only to read `conf/sonar.properties`. It resolves a relative `sonar.path.temp`, including the default `temp`, against the helper process's current working directory rather than installation home. A correct standalone invocation must therefore run with installation home as its working directory or configure an absolute temporary path. The helper writes the monitor hard-stop flag, prints an error to standard error and exits 1 on a detected configuration or I/O failure. If invoked from another working directory with a relative temp path, it can create a different `temp/sharedmemory`, exit successfully, and leave the running node untouched. [Provenance: `sonar-shutdowner/src/main/java/org/sonar/application/Shutdowner.java`]

Only failures after settings have loaded, logging has configured, and execution has entered the guarded startup phase are caught, logged, and followed by monitor status 0. Earlier failures, including malformed application arguments, unreadable configuration, settings validation, or logging setup, escape that guard and normally produce a nonzero JVM exit. Operators must still use readiness and logs, rather than status 0 alone, to distinguish successful startup from a failure inside the guarded phase. [Provenance: `sonar-application/src/main/java/org/sonar/application/App.java`; `server/sonar-main/src/main/java/org/sonar/application/config/AppSettingsLoaderImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/config/CommandLineParser.java`]

## 9. Logging contract

Each process writes a dedicated active log under `sonar.path.logs`: `sonar.log`, `es.log`, `web.log`, and `ce.log`. Child standard output and standard error are merged and drained so that early startup and crash output remains observable. When `sonar.log.console=true`, child log output is also forwarded to the monitor's standard output; the default is false. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessId.java`; `server/sonar-main/src/main/java/org/sonar/application/AppLogging.java`; `server/sonar-main/src/main/java/org/sonar/application/process/StreamGobbler.java`; `server/sonar-process/src/main/java/org/sonar/process/logging/LogbackHelper.java`]

`sonar.log.level` is the global threshold. `sonar.log.level.app`, `sonar.log.level.web`, `sonar.log.level.ce`, and `sonar.log.level.es` override it for their process. Supported values are `INFO`, `DEBUG`, and `TRACE`; default is `INFO`. A process-specific value has higher precedence than the global value. Unsupported levels fail logging configuration. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/logging/AbstractLogHelper.java`; `server/sonar-process/src/main/java/org/sonar/process/logging/LogLevelConfig.java`]

`sonar.log.jsonOutput` defaults to false. Plain output contains timestamp, severity, optional node name, process key, thread identity, shortened logger name, and message. JSON output contains `nodename` when present, `process`, nonexcluded diagnostic-context fields, `timestamp`, `severity`, `logger`, `message`, and a `stacktrace` array when an exception exists. Each event is one terminated record; newlines in JSON messages are normalized. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/logging/AbstractLogHelper.java`; `server/sonar-process/src/main/java/org/sonar/process/logging/LogbackJsonLayout.java`]

`sonar.log.rollingPolicy` defaults to `time:yyyy-MM-dd`. Supported forms are `time:<date-pattern>`, `size:<file-size>`, and `none`. `sonar.log.maxFiles` defaults to 7. Time rotation keeps that many periods; size rotation uses numbered files from 1 through the configured maximum; `none` keeps only the active file and delegates rotation to the operator. An unsupported policy fails logging configuration. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/logging/LogbackHelper.java`; `sonar-application/src/main/assembly/conf/sonar.properties`]

SQL statement logging belongs to `platform/persistence/`; access logging belongs to `platform/http-api/`. This part owns only process-level routing and file policy. [Provenance: `manifest/dependency-map.md`]

## 10. Failure, partial-result, and recovery behavior

- Settings-loading and logging-configuration failures occur before the monitor's guarded startup phase, prevent child scheduling, and normally terminate with nonzero JVM status. This includes malformed application arguments, unreadable configuration, JDBC or cluster settings validation, and unsupported monitor logging configuration. [Provenance: `sonar-application/src/main/java/org/sonar/application/App.java`; `server/sonar-main/src/main/java/org/sonar/application/config/AppSettingsLoaderImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/config/CommandLineParser.java`; `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`; `server/sonar-main/src/main/java/org/sonar/application/config/ClusterSettings.java`; `server/sonar-main/src/main/java/org/sonar/application/AppLogging.java`]
- Directory preparation, child command construction, mandatory JVM-option, or launch failures occur inside the guarded phase. They are logged as startup failures, remaining children are stopped as applicable, and the monitor then follows its status-0 termination path. [Provenance: `sonar-application/src/main/java/org/sonar/application/App.java`; `server/sonar-main/src/main/java/org/sonar/application/AppFileSystem.java`; `server/sonar-main/src/main/java/org/sonar/application/command/JvmOptions.java`; `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]
- Failure to launch a child moves that child directly toward stopped state; the scheduler then hard-stops the node. No later dependency is reported operational. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]
- A readiness check error leaves the child nonoperational. Search health errors are logged; web and compute remain gated on their operational flags. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/EsManagedProcess.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]
- Interrupted startup restores the interrupt flag and proceeds to node termination. Interrupted stop waits are logged and the hard-stop/finalization path prevents orphaned children. [Provenance: `sonar-application/src/main/java/org/sonar/application/App.java`; `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`]
- Subprocess output-reader failures are intentionally suppressed; they do not change process state. Readiness and operating-system liveness remain authoritative. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/StreamGobbler.java`]

Recovery after a terminal `STOPPED` monitor requires starting a new monitor instance. Internal restart is only the explicit child-requested path described above; it is not a general crash-recovery loop. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/NodeLifecycle.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]

## 11. Security and trust boundaries

- Installation home, configuration, log, data, and temporary paths are trusted local resources. The runtime must not follow operator-controlled configuration or IPC from untrusted writers. Temporary property files can contain effective secrets, and SQL or process logging can expose sensitive values at high verbosity; filesystem and log access must be restricted. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/ProcessLauncherImpl.java`; `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/AllProcessesCommands.java`]
- The process launcher inherits the monitor environment by default. Only explicit suppressions are removed. Operators must treat inherited environment variables as child-visible. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/command/AbstractCommand.java`; `server/sonar-main/src/main/java/org/sonar/application/ProcessLauncherImpl.java`]
- Search readiness uses a local Sonar-facing connector and must not be substituted with unauthenticated Internet exposure. Search network configuration and index security are owned by `platform/search-indexing/`. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/EsManagedProcess.java`; `manifest/dependency-map.md`]
- Hard-stop IPC can terminate the whole node. Access to `sonar.path.temp` is equivalent to a local administrative control. [Provenance: `sonar-shutdowner/src/main/java/org/sonar/application/Shutdowner.java`; `server/sonar-main/src/main/java/org/sonar/application/HardStopRequestWatcherImpl.java`]

## 12. Compatibility and limits

- Process keys, indexes, and log prefixes are release-coupled and must remain exactly as listed for IPC and log compatibility. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessId.java`]
- IPC supports at most five indexed processes and a 500-byte ASCII system-information URL. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/ProcessCommands.java`; `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/AllProcessesCommands.java`]
- Internal restart cannot change data, web, log, or temp paths or cluster activation, and is unavailable when the cluster compatibility branch is active. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/AppReloaderImpl.java`]
- Startup topology is dependency-ordered; readiness is not a promise that every higher-level HTTP feature, background task, or index is healthy. Those parts publish their own health within the common operational state. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `manifest/dependency-map.md`]
- This specification is pinned to release `26.8.0.126808`; later process keys, properties, timeouts, or lifecycle behavior are out of scope. [Provenance: `manifest/release-baseline.md`]

## 13. Acceptance scenarios

### Scenario 1: Standalone startup reaches operational state

Preconditions: valid installation directories and settings, all three children can start, search reaches `YELLOW` or `GREEN`, and web and compute publish their operational flags.

Action: start the monitor.

Expected outcome: search launches first; web launches after search is operational; compute launches after web and search are operational; the node logs each process as up and finally logs that SonarQube is operational. No later child launches before its prerequisite. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/process/EsManagedProcess.java`]

### Scenario 2: Configuration precedence is deterministic

Preconditions: one recognized property has distinct values in `sonar.properties`, its environment variable, an application `-D` argument, and a JVM `sonar.*` system property.

Action: load settings.

Expected outcome: the JVM system-property value wins. Removing it exposes the application-argument value, then the environment value, then the file value. `sonar.path.home` remains runtime-derived. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/AppSettingsLoaderImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/config/CommandLineParser.java`]

### Scenario 3: Search never becomes ready

Preconditions: search starts at operating-system level but its health remains `RED` or unavailable.

Action: wait for startup.

Expected outcome: web and compute do not become scheduled through their normal gates, and the node never reports `OPERATIONAL`. Health-check errors appear in process logs. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/EsManagedProcess.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]

### Scenario 4: Unexpected child loss stops the node

Preconditions: the node is starting or operational and no stop or restart is active.

Action: terminate the web or compute operating-system process.

Expected outcome: its stop watcher observes exit immediately, the scheduler treats it as an unexpected disappearance, and all remaining children are hard-stopped. The runtime does not restart only the failed child. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]

### Scenario 5: Graceful stop preserves reverse dependency order

Preconditions: standalone node is operational.

Action: deliver a normal monitor shutdown request.

Expected outcome: compute stops before web, web before search. Each child gets its configured grace period; a survivor is escalated to hard stop and eventual forced destruction. Final state is `STOPPED`. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`]

### Scenario 6: Internal restart reloads allowed settings

Preconditions: standalone node is operational; a reloadable logging or JVM-option property changes; immutable path and cluster properties do not.

Action: a child requests restart through IPC.

Expected outcome: request is acknowledged, all children stop, settings and logging reload, temporary state is reset, and dependency-ordered startup begins again. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/AppReloaderImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]

### Scenario 7: Internal restart rejects an immutable path change

Preconditions: standalone node is operational and `sonar.path.temp` changes before an internal restart.

Action: request restart.

Expected outcome: reload reports that the property cannot change on restart, restart fails, and the scheduler hard-stops the node rather than continuing with mixed paths. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/AppReloaderImpl.java`; `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`]

### Scenario 8: Logging modes remain compatible

Preconditions: default logging settings.

Action: start and stop the node, then repeat with `sonar.log.jsonOutput=true`, a process-specific log level, and a supported rolling policy.

Expected outcome: active files use `sonar`, `es`, `web`, and `ce` prefixes; default output is plain `INFO` with daily rotation and seven retained periods; JSON mode emits the defined fields; the process-specific threshold overrides global level. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessId.java`; `server/sonar-process/src/main/java/org/sonar/process/logging/LogbackHelper.java`; `server/sonar-process/src/main/java/org/sonar/process/logging/LogbackJsonLayout.java`]

### Scenario 9: IPC is reset across a new monitor

Preconditions: a previous instance left readiness or restart bytes in `sonar.path.temp/sharedmemory`.

Action: start a new monitor using the same temporary directory.

Expected outcome: all reserved slots are cleared before scheduling, so stale operational or restart state cannot make a child ready or trigger a restart. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/AppFileSystem.java`; `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/DefaultProcessCommands.java`]

### Scenario 10: Shutdown helper uses the intended IPC file

Preconditions: `sonar.path.temp` is relative and a node is running with installation home as its runtime base.

Action: invoke the standalone shutdown helper first with installation home as current working directory, then in a separate observation invoke it from another directory.

Expected outcome: the first invocation writes the running node's hard-stop flag. The second can exit successfully after creating or updating a different relative `temp/sharedmemory`, but it does not stop the node. Configuring an absolute `sonar.path.temp` removes the working-directory ambiguity. [Provenance: `sonar-shutdowner/src/main/java/org/sonar/application/Shutdowner.java`]

## 14. Provenance index

- Release and license: `manifest/release-baseline.md`, `manifest/license-map.md`, `LICENSE.txt`.
- Monitor bootstrap: `sonar-application/src/main/java/org/sonar/application/App.java`.
- Operator settings template: `sonar-application/src/main/assembly/conf/sonar.properties`.
- Settings and filesystem: `server/sonar-main/src/main/java/org/sonar/application/config/AppSettingsLoaderImpl.java`, `server/sonar-main/src/main/java/org/sonar/application/config/CommandLineParser.java`, `server/sonar-main/src/main/java/org/sonar/application/config/FileSystemSettings.java`, and `server/sonar-main/src/main/java/org/sonar/application/AppFileSystem.java`.
- Scheduling and state: `server/sonar-main/src/main/java/org/sonar/application/SchedulerImpl.java`, `server/sonar-main/src/main/java/org/sonar/application/NodeLifecycle.java`, `server/sonar-main/src/main/java/org/sonar/application/AppReloaderImpl.java`, and `server/sonar-main/src/main/java/org/sonar/application/config/ClusterSettings.java`.
- Child launch and monitoring: `server/sonar-main/src/main/java/org/sonar/application/ProcessLauncherImpl.java`, `server/sonar-main/src/main/java/org/sonar/application/command/CommandFactoryImpl.java`, `server/sonar-main/src/main/java/org/sonar/application/command/JvmOptions.java`, and `server/sonar-main/src/main/java/org/sonar/application/process/ManagedProcessHandler.java`.
- Child entry point and identifiers: `server/sonar-process/src/main/java/org/sonar/process/ProcessEntryPoint.java`, `server/sonar-process/src/main/java/org/sonar/process/Lifecycle.java`, `server/sonar-process/src/main/java/org/sonar/process/ProcessId.java`, and `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`.
- IPC: `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/AllProcessesCommands.java`, `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/DefaultProcessCommands.java`, and `server/sonar-process/src/main/java/org/sonar/process/sharedmemoryfile/ProcessCommands.java`.
- Readiness: `server/sonar-main/src/main/java/org/sonar/application/process/EsManagedProcess.java` and `server/sonar-main/src/main/java/org/sonar/application/process/ProcessCommandsManagedProcess.java`.
- Shutdown helper: `sonar-shutdowner/src/main/java/org/sonar/application/Shutdowner.java`.
- Logging: `server/sonar-main/src/main/java/org/sonar/application/AppLogging.java`, `server/sonar-main/src/main/java/org/sonar/application/process/StreamGobbler.java`, and `server/sonar-process/src/main/java/org/sonar/process/logging/AbstractLogHelper.java`, `server/sonar-process/src/main/java/org/sonar/process/logging/LogLevelConfig.java`, `server/sonar-process/src/main/java/org/sonar/process/logging/LogbackHelper.java`, and `server/sonar-process/src/main/java/org/sonar/process/logging/LogbackJsonLayout.java`.
