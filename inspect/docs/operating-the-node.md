# Operating a Leveret Inspect node

A node is one installation directory supervised by a monitor process. The monitor loads settings,
prepares runtime directories, starts the search, web, and compute processes in dependency order, and
coordinates restart and shutdown.

## Directory layout

| Directory | Property | Purpose |
|---|---|---|
| `conf/` | — | `leveret.properties`, the operator configuration file |
| `data/` | `leveret.path.data` | persistent node data; never cleared by startup |
| `logs/` | `leveret.path.logs` | active and rotated log files |
| `temp/` | `leveret.path.temp` | runtime scratch and the local command file; cleaned at startup and internal restart |
| `web/` | `leveret.path.web` | web runtime directory |

The installation home is derived from the location of the application artifact. A configured value
for the home property is ignored. A relative value for any other directory resolves against the
home and is converted to an absolute path. A configured path that exists as a file, or a directory
that cannot be created, stops startup.

## Configuration precedence

For a recognized key, later sources override earlier ones:

1. `conf/leveret.properties`, read as UTF-8;
2. environment variables, named by uppercasing the key and replacing dots with underscores;
3. application arguments in `-Dkey=value` form;
4. JVM system properties;
5. built-in defaults, applied only to keys still unset.

A missing configuration file is a warning, not an error. An unreadable file, a malformed application
argument, an unsupported log level, an unsupported rolling policy, or an unrecognized database
provider stops startup before any child process is launched, with a nonzero exit status.

## Processes

| Process | Log file | Started |
|---|---|---|
| Monitor | `leveret.log` | first |
| Search | `search.log` | first child |
| Web server | `web.log` | after search is operational |
| Compute engine | `ce.log` | after web and search are operational |

Search readiness is read from the local search health interface: yellow or green counts as
operational, red does not. Web and compute publish their own readiness. The node reports operational
only after every process has reported operational, so a node that never reaches that state should be
diagnosed from the log of the earliest process that has not reported.

An unexpected child exit stops the whole node. A single failed process is never restarted on its own,
because a partially operational node reports misleading results.

## Database

A node stores everything durable in one relational database. Two providers are supported: embedded H2
for evaluation and testing, and PostgreSQL 14 or later for production. The provider token in
`leveret.jdbc.url` must be `h2` or `postgresql`; anything else stops startup before a connection is
attempted.

Selection rules:

- neither `leveret.jdbc.url` nor `leveret.embeddedDatabase.port` set selects the embedded database on
  loopback port 9092, stored under the data directory;
- setting `leveret.embeddedDatabase.port` selects the embedded database and makes a configured URL
  ineffective; the startup log states the effective URL;
- an external URL requires an existing database or schema whose principal may create tables, indexes,
  and triggers. PostgreSQL must report a UTF-8 database encoding, and managed varchar columns must
  inherit the default collation or use a UTF-8 collation. A nonconforming database is rejected rather
  than rewritten.

The connection pool is bounded by `leveret.jdbc.maxActive`, sized against concurrent web and compute
demand at roughly 1.2 times the maximum HTTP worker count. Exhaustion surfaces as a failed
acquisition after `leveret.jdbc.maxWait` milliseconds; a configured `0` is the finite 2147483647 ms
sentinel, not an indefinite wait.

Migrations are forward-only. Each completed step records its number in `schema_migrations`, so a run
interrupted by a failure resumes at the failed step and every later one. Setting
`leveret.autoDatabaseUpgrade` to true runs pending migrations at startup. Because schema statements
and data batches commit incrementally, a failed step can be partially applied: read the logged
failing step before retrying, and restore a backup when that step cannot tolerate its own applied
effects. A database whose highest recorded migration is newer than the running release reports
`REQUIRES_DOWNGRADE`; no reverse migration exists, so recovery means running a compatible release or
restoring a compatible backup. Never edit `schema_migrations` to clear an error, which skips required
migrations instead of resolving them.

Statement tracing is off by default and is enabled by raising logger `sql` to trace level. Trace
records contain bound parameter values, which can include credentials, tokens, personal data, and
analyzed source. Treat that output as privileged: restrict who can enable it, where it lands, and how
long it is retained.

## Stopping

Normal shutdown stops compute, then web, then search. Each process receives its configured grace
period before stopping is escalated to termination. Interrupting the monitor in the foreground
performs the same ordered shutdown.

Two shutdown paths exist:

- graceful stop, available to local tooling when `leveret.enableStopCommand` is true;
- hard stop, always available, requested by the bundled hard-stop helper.

The hard-stop helper reads `conf/leveret.properties` from the installation home and resolves a
relative temporary path against that home, so it reaches the running node from any working
directory.

## Security

The installation home, the configuration file, and the temporary directory are trusted local
resources. The temporary directory carries the effective settings handed to child processes and the
local command file, so write access to it is equivalent to local administrative control of the node:
it can stop the node or observe secrets. Restrict its ownership and permissions accordingly. Raising
log verbosity can also surface sensitive values, so treat the log directory as protected.

## Logging

Plain output is one line per event: timestamp, severity, optional node name, process key, thread,
shortened logger name, and message. Setting `leveret.log.jsonOutput` to true emits one JSON record
per event instead. Rotation defaults to daily with seven retained periods; `size:<file-size>` uses
numbered files, and `none` leaves rotation to the operator.
