# Persistence Implementation Design

**Date:** 2026-08-29
**Status:** Approved
**Implements:** `specs/platform/persistence/specification.md` (pinned baseline `26.8.0.126808`)
**Part:** `platform/persistence` — second implemented part of Leveret Inspect
**Consumes:** `platform/process-runtime` (settings loading, validation hook, log configuration)

## 1. Goal

Give Leveret Inspect transactional relational storage: connection configuration, pooled writer and
read-only sessions, dialect-aware schema construction, a forward-only migration engine with durable
history, charset verification, and SQL diagnostics.

This part is the sole owner of the connection contract, the transaction and batching model, the
schema-definition model and DDL generation, migration numbering, ordering, history and state, and
pool and SQL observability. Every later stateful part obtains storage through these contracts and
registers its own tables and migration steps rather than defining a second migration history,
transaction model, or DDL builder.

## 2. Scope

In scope:

- database properties, defaults, embedded-versus-external selection, and pool-range validation;
- provider recognition and dialect resolution, failing on any unrecognized dialect;
- pooled writer and read-only data sources with observable pool counts;
- explicit sessions with caller-controlled transactions, batched upserts, large-input partitioning,
  conditional updates reported by affected-row counts, and streamed column values;
- the schema-definition model: identifier validation, logical column types, primary-key and index
  naming, auto-increment rules, and dialect-specific DDL generation;
- migration numbering, registration, ordering, per-step commit semantics, `schema_migrations`
  history, database-version states, migration status and progress, and resume-after-failure
  behavior;
- charset and collation verification for the supported production dialect;
- the embedded database server lifecycle;
- SQL trace profiling with normalized statements and bounded parameter rendering.

Out of scope for this part (owned elsewhere or deferred):

- every domain table, DAO, and query. Persistence supplies the schema-definition model, the migration
  registry, and sessions; the owning part contributes its tables, steps, and SQL. No domain table is
  declared in this module;
- HTTP endpoints for migration state, and the authorization around them (`platform/http-api`,
  `platform/identity-access`);
- search index synchronization semantics, even where a relational table coordinates it
  (`platform/search-indexing`);
- health publication and JMX registration of pool counts (`platform/telemetry-monitoring`);
- node ordering, readiness, and startup leadership (`platform/process-runtime`); persistence reports
  connection or migration failure to its caller and never redefines node lifecycle.

## 3. Naming and compatibility policy

Naming is Leveret Inspect's own. The specification's behavior is implemented; its vendor-specific
spellings, its historical migration chain, and its legacy-installation compatibility shims are not.
Leveret Inspect has no installed base, so nothing in this part exists to upgrade a database created
by another product.

| Surface | Decision |
|---|---|
| Gradle module | `persistence/` |
| Java package root | `com.leveret.inspect.db` |
| Property prefix | `leveret.` only, loaded by the process-runtime loader |
| Supported provider tokens | `h2`, `postgresql` |
| Dialect identifiers | `h2`, `postgresql` |
| History table | `schema_migrations`, one nonnullable `version` column of length 255 |
| Migration number format | `YYYY_MM_NNN`, compared as a decimal integer |
| Embedded database name | `leveret`, under the node data directory |
| SQL trace logger | `sql` |

Deliberately not implemented, because Leveret Inspect will not use them:

- **Oracle and SQL Server dialects.** Upstream supports them for its existing customers. Their cost
  here is large and specific: identity emulation through sequences and triggers, bounded `IN`-list
  partitioning, `NULL`/`NOT NULL` retry transformations, Unicode varchar variants, a global
  character-set probe, and case-sensitivity repair that drops and recreates indexes. Both dialects
  are recognized as unsupported and fail configuration; nothing silently falls back to a similar SQL
  form.
- **The historical migration catalog.** Upstream registers every migration ever shipped so an old
  database can be walked forward. Leveret Inspect starts from an empty database, so the registry
  begins empty and each part registers only steps that build its own schema. The direct-upgrade floor
  and its release label disappear with it; `REQUIRES_UPGRADE` and `REQUIRES_DOWNGRADE` are still
  computed against the registry maximum.
- **The 117-table canonical inventory.** Table ownership follows part ownership. Charset checking
  checks the table set its caller supplies, so it covers exactly the schema that exists.
- **Driver directory discovery.** Upstream scans a provider-specific directory, requires exactly one
  driver JAR, and hands a derived driver path to child processes because one driver is
  operator-supplied. Both supported drivers are ordinary build dependencies on the classpath, so
  there is no directory layout, no ambiguity failure, and no driver-path handoff.
- **Reserved-keyword exemptions.** Upstream retains the identifiers `groups` and `value` for
  compatibility with its own existing schemas. New identifiers here are validated with no
  exemptions, which also removes the embedded-database keyword-compatibility option from the
  generated URL.
- **Reverse migrations.** Migration state is forward-only; recovery from a newer schema is an
  operator restore.

The pool, the drivers, and the embedded server are third-party dependencies. Only Sonar-facing
configuration, statement, state, and failure behavior is implemented here.

## 4. Stack and build

- Kotlin on the JVM, bytecode target JDK 25, matching `runtime/`.
- New Gradle module `persistence/`, depending on `runtime` for settings loading and the validation
  hook.
- HikariCP `6.3.0` for pooling. The specification's pool contract is Hikari's observable contract:
  maximum pool size, minimum idle, a connection-acquisition timeout of at least 250 ms, idle
  timeout, keepalive interval, maximum lifetime, and validation timeout all map one to one, and the
  documented failure ranges are the pool's own rejections rather than a reimplementation.
- H2 `2.3.232` and PostgreSQL JDBC `42.7.7` as compile-and-runtime dependencies.
- No SQL-mapping framework. Sessions are thin wrappers over JDBC. The owned contract is the session,
  its transaction boundary, and its statement helpers; an object-relational mapper would add a second
  configuration lifecycle, an XML statement dialect, and a startup-ordering rule
  (mapper configuration must follow the writer data source) that only exist because upstream uses
  one. Parts write their own SQL against a session.
- Logging through SLF4J, configured by the process runtime.
- Tests: JUnit 5 and AssertJ, exercising real databases. Every behavior that does not depend on a
  production server runs against H2. PostgreSQL-specific behavior — encoding and collation checks,
  serial identity, upsert form — runs against a server addressed by `LEVERET_TEST_POSTGRES_URL` and
  is skipped by assumption when that variable is absent, so the default suite needs no container
  runtime.

## 5. Structure

```
persistence/src/main/kotlin/com/leveret/inspect/db/
  config/     Database property keys, defaults, embedded selection, pool configuration
  dialect/    Dialect contract, H2 and PostgreSQL implementations, resolution and rejection
  pool/       Writer and read-only data sources, pool observations, embedded server lifecycle
  session/    Session factory, transaction boundary, batching, partitioning, streaming
  profiling/  SQL normalization, parameter rendering, statement wrappers
  schema/     Identifier validation, column model, DDL builders
  migration/  Numbers, step contracts, registry, history, version state, engine, status
  charset/    Charset and collation verification per dialect
```

| Unit | Responsibility | Depends on |
|---|---|---|
| `config.DatabaseKeys` | property names and defaults | — |
| `config.DatabaseSettings` | resolve URL, credentials, embedded selection, validated pool values | `runtime.config.Settings` |
| `dialect.Dialect` | dialect identity, quoting, literals, identity form, pagination, upsert, metadata queries | — |
| `dialect.Dialects` | provider token to dialect, rejection of anything else | `Dialect` |
| `pool.Database` | writer and read-only pooled data sources, lifecycle, `PoolStats` | `DatabaseSettings`, `Dialect` |
| `pool.EmbeddedDatabase` | loopback embedded server start and stop | `DatabaseSettings` |
| `session.SessionFactory` | open writer or read-only sessions | `Database` |
| `session.DbSession` | connection ownership, commit, rollback, statement helpers, batching | `Dialect`, `SqlProfiler` |
| `session.LargeInputs` | partitioned reads and updates over oversized input collections | — |
| `profiling.SqlLogFormatter` | statement normalization and bounded parameter rendering | — |
| `profiling.ProfilingStatements` | timing and trace logging wrappers preserving return and failure behavior | `SqlLogFormatter` |
| `schema.Identifiers` | table, column, constraint, and index name validation | — |
| `schema.ColumnDef` | logical column types, sizes, nullability, defaults | `Dialect` |
| `schema.CreateTableBuilder` | table DDL, primary-key naming, auto-increment form | `ColumnDef`, `Dialect` |
| `schema.IndexBuilders` | create, drop, and rename index and constraint statements | `Dialect` |
| `schema.AlterBuilders` | add, alter, drop, and rename column and table statements | `ColumnDef`, `Dialect` |
| `migration.MigrationNumber` | number parsing, validation, ordering | — |
| `migration.MigrationStep` | DDL-change and data-change step contracts and their commit rules | `DbSession`, `Dialect` |
| `migration.MigrationRegistry` | registration, uniqueness, numeric ordering, selection from a floor | `MigrationNumber` |
| `migration.MigrationHistory` | history table creation, recorded numbers, success insertion | `DbSession` |
| `migration.DatabaseVersion` | recorded maximum versus registry maximum, four version states | `MigrationHistory`, `MigrationRegistry` |
| `migration.MigrationEngine` | stage sequence, ordered execution, per-step history, first-failure stop | all of `migration` |
| `migration.MigrationState` | operator-visible status, counts, timings, last error | — |
| `charset.CharsetChecker` | encoding and collation verification per dialect and checker state | `Dialect`, `DbSession` |

## 6. Configuration contract

Loading, precedence, and environment naming belong to `platform/process-runtime`. This part
contributes keys, defaults, and validation.

| Canonical property | Default | Contract |
|---|---|---|
| `leveret.jdbc.url` | generated embedded URL | external URL and provider selector |
| `leveret.jdbc.username` | empty | JDBC user |
| `leveret.jdbc.password` | empty | JDBC password |
| `leveret.embeddedDatabase.port` | `9092` when embedded is selected | embedded server TCP port on loopback |
| `leveret.jdbc.maxActive` | `60` | maximum pooled connections; integers 1 through `2147483647` |
| `leveret.jdbc.minIdle` | `10` | minimum idle pooled connections |
| `leveret.jdbc.maxWait` | `8000` | acquisition timeout in milliseconds; `0` means the `2147483647` sentinel; other values must be at least 250 |
| `leveret.jdbc.idleTimeout` | `600000` | idle connection retirement in milliseconds |
| `leveret.jdbc.keepaliveTime` | `180000` | keepalive interval in milliseconds |
| `leveret.jdbc.maxLifetime` | `1800000` | maximum connection lifetime in milliseconds |
| `leveret.jdbc.validationTimeout` | `5000` | validation timeout in milliseconds |
| `leveret.autoDatabaseUpgrade` | `false` | opt-in automatic migration, read by the startup-leading process |

Selection rules:

- an explicitly present `leveret.embeddedDatabase.port` selects the embedded database and takes
  precedence over `leveret.jdbc.url`; the ignored URL is reported by a warning that states whether it
  matched the generated URL;
- with neither key present, the embedded database is selected on port `9092` against the loopback
  database named `leveret` under the data directory;
- a present URL must be a nonempty `jdbc:<provider>:` form whose case-normalized provider is `h2` or
  `postgresql`; anything else fails configuration before a connection is attempted.

Provider validation already exists in the process runtime's pre-guard validation hook. Its accepted
set narrows from four tokens to `h2` and `postgresql`, keeping one owner for the rejection message.

Pool sizing guidance stays with the operator template: size `leveret.jdbc.maxActive` against
concurrent web and compute demand, approximately 1.2 times the maximum HTTP worker count. Exhaustion
is observable as acquisition failure after the effective wait, never as a silent overrun of the
maximum.

## 7. Dialects

The dialect is resolved once from the provider token and owns every statement difference:

| Concern | H2 | PostgreSQL |
|---|---|---|
| Identifier quoting | quoted uppercase-insensitive form | quoted lowercase form |
| Boolean literals | `true` and `false` | `true` and `false` |
| Auto-increment | identity column | `serial`-equivalent identity column |
| Pagination | `limit` and `offset` | `limit` and `offset` |
| Upsert | merge on conflict target | `on conflict` clause |
| Large text and binary | `clob` and `blob` | `text` and `bytea` |
| Index discovery | information schema | catalog views |
| Charset verification | none required | database encoding and column collation |

Only these two dialect identifiers exist. An unsupported identifier fails at resolution; no builder
emits a superficially similar statement for an unknown dialect. A builder may return more than one
statement for one logical operation, and the migration transaction rules in section 9 then apply per
statement.

## 8. Schema definition model

Identifier rules, applied to every generated name:

- table names at most 25 characters; constraint and index names at most 30;
- lowercase ASCII letters, digits, and underscores only; no leading digit or underscore;
- reserved SQL keywords rejected, with no exemptions;
- case-insensitive comparison used only where an operation must accept an existing mixed-case index
  name.

Column model: logical varchar, large text, binary, boolean, tiny, small, integer, bigint, decimal,
and timestamp types. Nullability is always explicit. String defaults are quoted; Boolean defaults use
the dialect literal. Varchar is limited to 4000 characters; the standard identifier field is 40
characters.

Table rules: the default primary-key constraint is named `pk_<table>`; composite primary keys
preserve declared column order; auto-increment is allowed only on a nonnullable numeric column named
`id`, at most one per table. Relationships are logical, enforced by application operations and unique
indexes rather than physical foreign keys.

## 9. Sessions, transactions, and migration steps

Sessions come from the factory in two flavors, writer and read-only, both with autocommit disabled.
Ordinary work is caller-controlled: a session's mutations stay in the caller's transaction and the
session commits only when told to. A part that needs a narrower boundary commits inside its own
operation deliberately; persistence provides the primitives rather than wrapping every call in an
assumed all-or-nothing transaction.

Provided primitives, each mirroring an observable boundary from the specification:

- conditional updates that report affected rows, so a claim that changed exactly one row can be
  distinguished from a lost race without a read-then-write gap;
- batched upserts that default to 250 rows, commit each full batch, and commit the final partial
  batch, leaving earlier batches durable after a later failure;
- partitioned reads and updates for oversized input collections, at 1000 elements per partition, so a
  statement stays within driver and planner limits;
- profiled prepared statements handed to the caller, so character and binary column values are bound
  as streams and committed by the caller's own boundary rather than through a second write API.

Migration steps come in two forms. A DDL step runs on a non-autocommit writer connection and commits
after each generated statement, so a multi-statement step is not atomic as a whole. A data step uses
a separate read connection and writer connection, both with autocommit disabled, and requests a
relaxed isolation level only when the driver reports support for it.

A migration number is inserted into `schema_migrations` only after its step returns successfully,
using a separate committed connection. Failure during a step leaves no success row; failure between
schema work and history insertion can leave schema changes without a history record, which the
operator resolves from the logged failing step. Migration execution is serialized by startup
leadership, and the progress object is explicitly single-threaded; concurrent migration is outside
the contract.

## 10. Migration engine and version state

Registry rules: numbers are nonnegative and unique, descriptions nonempty, ordering strictly numeric
rather than declaration order.

Execution stages:

1. read the current maximum recorded number;
2. select every registered step above it, which selects all steps on a fresh database;
3. publish total count and start state to the status listener;
4. execute in strictly increasing numeric order;
5. after each success, insert the number, increment progress, and record duration and start time;
6. stop at the first failure, report it, and leave later steps unexecuted.

Version states are `FRESH_INSTALL` when no number is recorded, `UP_TO_DATE` when the recorded maximum
equals the registry maximum, `REQUIRES_UPGRADE` when it is lower, and `REQUIRES_DOWNGRADE` when it is
higher. A newer schema is never treated as current and no success row is ever inserted to suppress an
error.

Operator-visible statuses are `NO_MIGRATION`, `MIGRATION_RUNNING`, `MIGRATION_FAILED`,
`MIGRATION_SUCCEEDED`, `NOT_SUPPORTED`, and `MIGRATION_REQUIRED`. State carries start time, last
error, completed and total counts, and an estimated finish time only after at least one step
completes during a running migration. An embedded-database upgrade reports `NOT_SUPPORTED`.

A retry after failure begins after the highest recorded success, so the failed number is selected
again. Because DDL statements and data batches commit incrementally, a failed step can be partially
applied; automatic retry is safe only when the step tolerates its own applied effects, and otherwise
the operator restores a backup or repairs the schema from the logged failure.

## 11. Charset and collation

The checker runs in fresh-install, upgrade, and startup states. H2 requires no check. PostgreSQL must
report a UTF-8-capable database encoding in every state, and on upgrade and startup every varchar
column in the supplied table set must either inherit the default collation or use a UTF-8 collation.
Nonconforming columns fail the check; nothing is rewritten automatically. An unsupported dialect
fails rather than skipping verification.

## 12. Observability

Pool observations expose active, total, idle, maximum, and minimum-idle counts plus configured
maximum lifetime and connection-wait milliseconds. When a live pool view is unavailable, active,
total, and idle report zero. The value object is returned by the database component; JMX registration
and health composition belong to `platform/telemetry-monitoring`.

SQL profiling is enabled when logger `sql` is trace-enabled. Every statement execution is timed and
logged, including failing executions, and original return values and exceptions are preserved
exactly. Records contain normalized SQL — newlines and tabs collapsed to spaces, repeated whitespace
collapsed — and, for prepared statements, captured parameters rendered to at most 500 characters each
with a distinct null representation and escaped newlines.

Trace SQL output can contain credentials, tokens, personal data, and source material. It is
privileged diagnostic output: restricted access, restricted retention, never enabled by default.

## 13. Security and trust boundaries

- Credentials arrive through process configuration and must not reach command lines, ordinary logs,
  migration errors, or unprotected temporary files. Errors keep provider, schema, column, and
  migration context without echoing secrets.
- The JDBC principal is trusted to mutate the whole schema and should hold no unrelated privileges.
- Session inputs are trusted typed values, but JDBC remains a boundary against malformed stored data:
  statement parameters stay bound values, and every generated identifier passes validation.
- `schema_migrations` is privileged control state. Manual edits can skip migrations or force a
  downgrade status and are unsupported except as an evidence-backed recovery operation.

## 14. Failure behavior

- Malformed URL, unsupported provider, unavailable database, invalid credentials, invalid pool ranges,
  unsupported dialect, and failed charset verification prevent persistence from becoming usable and
  are reported to the caller; node lifecycle consequences belong to the process runtime.
- Pool acquisition fails after the effective wait; a configured zero is the finite sentinel, not an
  indefinite wait.
- Migration execution stops at the first failing step, with the failing number absent from history
  and earlier numbers durable.
- A recorded maximum above the registry maximum is `REQUIRES_DOWNGRADE`, and this release supplies no
  reverse migration.
- History insertion failure and a missing history table after the ensuring component runs are fatal.

## 15. Testing strategy

Development is test-first: one failing test per behavior, then the minimal implementation.

Unit and H2-backed coverage:

- property defaults, embedded selection precedence with its warning, generated URL form, provider
  rejection, and every documented pool-range rejection;
- dialect resolution and rejection, and per-dialect statement generation;
- identifier validation limits and keyword rejection; column model rendering; table, index, and alter
  DDL including primary-key naming and the single auto-increment rule;
- session transaction boundaries: rollback discards, commit persists, conditional update reports
  affected rows, batch upsert commits per batch, partitioning splits oversized inputs, streamed
  values persist;
- SQL normalization, parameter truncation at 500 characters, null distinction, newline escaping, and
  preserved exception behavior under profiling;
- migration number validation and ordering, registry uniqueness and selection, history creation and
  recorded numbers, all four version states, engine stage sequence, first-failure stop, and
  resume-after-failure selection;
- pool observations with and without a live pool view.

PostgreSQL-backed coverage, skipped without `LEVERET_TEST_POSTGRES_URL`: encoding check, column
collation check, identity column form, upsert form, and a full migration run against a real server.

The specification's eleven acceptance scenarios map as follows, with the two dropped dialects
recorded as decisions rather than gaps:

| Scenario | Assertion |
|---|---|
| 1 Default embedded selection | no URL and no port yields embedded provider, port 9092, loopback database `leveret` |
| 2 Explicit port wins over URL | port plus PostgreSQL URL yields embedded selection and an inconsistency warning |
| 3 Supported external database starts | PostgreSQL data sources start, sessions read and write, pool counts observable |
| 4 Unsupported provider fails early | any token other than `h2` and `postgresql` fails settings validation with no fallback |
| 5 SQL Server collation | not applicable; SQL Server is not implemented by decision |
| 6 Fresh database reaches registry maximum | history table created, steps run in numeric order, each success recorded, state `UP_TO_DATE` |
| 7 Failed migration resumes from history | earlier numbers durable, failed number absent, retry reselects it and later steps |
| 8 Newer schema requires downgrade | recorded maximum above registry maximum reports `REQUIRES_DOWNGRADE` and runs nothing |
| 9 Atomic claim under contention | two conditional claims of one row: exactly one reports one affected row, the other reports none |
| 10 Pool exhaustion honors timeout | acquisition fails after the configured wait, maximum never exceeded |
| 11 Profiling preserves behavior | successful and failing executions keep their result and emit duration and normalized SQL |

Smoke verification for the part is a migration run against a fresh embedded database that reaches
`UP_TO_DATE`, followed by a session that writes and reads a row through the created schema.

## 16. Risks and deferrals

- The migration registry ships empty by design. The first part that owns tables also delivers the
  first steps, and until then only test steps exercise the engine.
- PostgreSQL-specific behavior is verified only where a server is available. Without
  `LEVERET_TEST_POSTGRES_URL` the default suite proves dialect statement generation but not server
  acceptance.
- Pool counts are exposed as values, not published. A consumer needing JMX or health output waits for
  `platform/telemetry-monitoring`.
- Adding a dialect later means implementing its statement differences, its charset handler, and its
  identity form; the dialect contract is the seam that keeps that additive.
