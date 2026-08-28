# SonarQube Community Build Persistence Specification

## 1. Identity and provenance

This specification describes relational persistence shipped with SonarQube Community Build `26.8.0.126808`, published on 2026-08-05 from Git tag `26.8.0.126808` and commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The release artifact is `sonarqube-26.8.0.126808.zip`, whose recorded SHA-256 is `ea1c5c1932f9c25350eafc4cdb1a839527c117e5d98b5fcf222a715b6b50a1f2`. The authoritative release is https://github.com/SonarSource/sonarqube/releases/tag/26.8.0.126808. [Provenance: `manifest/release-baseline.md`; https://github.com/SonarSource/sonarqube/releases/tag/26.8.0.126808]

The covered production source is licensed under `LGPL-3.0-or-later`. This is a clean-room behavioral specification, not a copy marker and not legal advice. [Provenance: `LICENSE.txt`; `manifest/license-map.md`]

Pinned primary source scope:

- `server/sonar-db-dao/src/main/` for persistence aggregates, mapper contracts, connection-pool observability, and DAO transaction boundaries;
- `server/sonar-db-migration/src/main/` for schema, dialect-neutral DDL, charset and collation checks, migration history, migration state, and every registered migration;
- `server/sonar-db-profiling/src/main/` for optional SQL execution profiling;
- the pinned runtime configuration declarations in `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`, `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`, and `sonar-application/src/main/assembly/conf/sonar.properties` where they define the Sonar-facing database input contract.

## 2. Purpose, scope, and exclusions

Persistence owns the relational schema, connection and session contract, transaction boundaries, database-dialect adaptation, migration ordering and history, schema-version states, charset and collation invariants, aggregate DAO registration, SQL profiling, and pool observations consumed by the rest of the platform. [Provenance: `manifest/dependency-map.md`; `server/sonar-db-dao/src/main/java/org/sonar/db/DefaultMyBatis.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/MigrationConfigurationModule.java`]

This specification does not redefine business meaning or lifecycle for projects, rules, profiles, permissions, issues, compute tasks, search documents, events, integrations, or other domain entities. Their platform specifications own those states. Persistence owns only how those parts obtain transactional relational storage. It also does not define the HTTP transport for migration actions; routing, authorization, and response envelopes belong to `platform/http-api/` and `platform/identity-access/`. [Provenance: `manifest/dependency-map.md`]

Third-party database engines, JDBC drivers, connection pools, and SQL-mapping libraries are not reimplemented here. Only Sonar-facing compatibility, configuration, statements, state, and failure behavior are specified. Packaging mechanics are excluded. [Provenance: `manifest/component-inventory.md`]

Schema names associated with capabilities not otherwise available in Community Build are recorded only when the pinned Community migration registry manipulates them. Their presence does not assert any commercial feature behavior. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/MigrationConfigurationModule.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/`]

## 3. Owned contracts and consumers

This part is the sole owner of:

- accepted JDBC providers and connection-property precedence;
- database and schema compatibility prerequisites;
- connection-pool defaults and pool exhaustion behavior;
- the logical schema, table and identifier invariants, primary keys, unique indexes, and migration-produced schema state;
- session, commit, rollback, batching, conditional-update, and streaming-value persistence boundaries;
- migration numbers, ordering, history, progress, and failure state;
- database-specific SQL selection and DDL generation;
- SQL profiling fields and pool observations.

All stateful platform parts consume these contracts. They may own domain-specific state machines and query semantics, but they must not define another migration history, transaction model, or relational schema owner. [Provenance: `manifest/dependency-map.md`; `server/sonar-db-dao/src/main/java/org/sonar/db/DbClient.java`]

The process runtime owns node ordering and readiness. Persistence reports connection or migration failure to its caller; it does not redefine node lifecycle. Search indexes are derived state owned by `platform/search-indexing/`, even where relational tables such as `es_queue` coordinate their synchronization. [Provenance: `manifest/dependency-map.md`]

### 3.1 Accepted inputs and outputs

Accepted operator inputs are the JDBC URL and provider, credentials, embedded port, pool limits and timeouts, automatic-upgrade flag, driver files, database/schema selection, and an existing database state. Internal consumers supply explicit sessions, typed aggregate values, identifiers, filters, pagination, streams, conditional old/new values, and migration invocations. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`; `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/DbClient.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/engine/MigrationEngine.java`]

Outputs are pooled writer and read-only sessions; query records, counts, streams, and affected-row results; committed aggregate state; dialect-compatible schema objects; `schema_migrations` history; migration version, progress, error, and timing state; pool observations; and optional trace SQL records. HTTP migration responses and business-domain transitions are outputs of their contract owners, not persistence. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/DefaultMyBatis.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/DatabaseMBean.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationState.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfilingPreparedStatementHandler.java`; `manifest/dependency-map.md`]

## 4. Supported databases and driver contract

### 4.1 Supported server families

Production database families in the pinned operator configuration are:

- Oracle 19c and 21c, using the thin JDBC client;
- PostgreSQL 14 or later;
- Microsoft SQL Server 2016, 2017, 2019, or 2022, and SQL Azure.

Embedded H2 is the default when no external JDBC URL is supplied. It is intended for evaluation and testing, not production. [Provenance: `sonar-application/src/main/assembly/conf/sonar.properties`]

The runtime recognizes exactly the JDBC provider tokens `h2`, `sqlserver`, `oracle`, and `postgresql`, case-normalized after parsing a nonempty `jdbc:<provider>:...` URL. A malformed URL or any other provider fails configuration with an operator-facing error. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`]

The pinned build supplies Sonar-facing interoperability with H2 `2.3.232`, Microsoft JDBC `13.4.0.jre11`, and PostgreSQL JDBC `42.7.11`. Oracle's driver is operator-supplied. These coordinates identify tested/bundled adapters; this specification does not describe their internals. [Provenance: `build.gradle`; `sonar-application/build.gradle`]

### 4.2 Driver discovery

Provider-to-directory mapping is fixed:

| Provider | Driver directory |
|---|---|
| H2 | `lib/jdbc/h2` |
| SQL Server | `lib/jdbc/mssql` |
| PostgreSQL | `lib/jdbc/postgresql` |
| Oracle | `extensions/jdbc-driver/oracle` |

H2, PostgreSQL, and Oracle directories must contain exactly one JAR. SQL Server may contain supporting JARs, but one file whose name begins with `mssql-jdbc` must be present and is selected as the driver; other JARs in that directory are added as supporting libraries. A missing directory, empty driver directory, missing SQL Server driver, or multiple non-SQL-Server driver JARs fails startup. Derived `sonar.jdbc.driverPath` and `sonar.jdbc.additionalLibPaths` values are runtime handoff fields, not independent schema settings. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`; `server/sonar-main/src/main/java/org/sonar/application/command/CommandFactoryImpl.java`]

### 4.3 Database-specific prerequisites

The JDBC principal must be able to create tables, indexes, and triggers. For an external database, the target database or schema exists before SonarQube starts. [Provenance: `sonar-application/src/main/assembly/conf/sonar.properties`]

For Oracle, only the thin-client URL form is supported. For PostgreSQL, the default schema is `public`; a different schema is selected through the JDBC `currentSchema` parameter. For SQL Server, the database must use a case-sensitive and accent-sensitive, or binary-equivalent, collation. Integrated security uses no `sonar.jdbc.username` or `sonar.jdbc.password`; SQL authentication uses both as appropriate. [Provenance: `sonar-application/src/main/assembly/conf/sonar.properties`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/MssqlCharsetHandler.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/PostgresCharsetHandler.java`]

## 5. Configuration, defaults, and precedence

Database properties follow the process-runtime source precedence: configuration file, recognized environment override, application `-D` argument, then JVM `sonar.*` system property; defaults fill only absent keys. `platform/process-runtime/` owns the generic loading algorithm. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/AppSettingsLoaderImpl.java`; `manifest/dependency-map.md`]

| Property | Default | Contract |
|---|---:|---|
| `sonar.jdbc.url` | embedded H2 URL | External JDBC URL and provider selector. |
| `sonar.jdbc.username` | empty | JDBC user. |
| `sonar.jdbc.password` | empty | JDBC password. |
| `sonar.embeddedDatabase.port` | `9092` when embedded is selected by default | Embedded H2 TCP port. |
| `sonar.jdbc.maxActive` | `60` | Maximum pooled connections. Accepted values are integers from 1 through `2147483647`; zero and negative values fail data-source initialization, and larger values fail integer parsing. |
| `sonar.jdbc.minIdle` | `10` | Minimum idle pooled connections. |
| `sonar.jdbc.maxWait` | `8000` ms | Connection acquisition timeout. Zero maps to `2147483647` ms; positive values must be at least 250 ms; negative values and positive values below 250 ms fail data-source initialization. |
| `sonar.jdbc.idleTimeout` | `600000` ms | Idle connection retirement setting. |
| `sonar.jdbc.keepaliveTime` | `180000` ms | Connection keepalive interval. |
| `sonar.jdbc.maxLifetime` | `1800000` ms | Maximum pooled connection lifetime. |
| `sonar.jdbc.validationTimeout` | `5000` ms | Connection validation timeout. |
| `sonar.autoDatabaseUpgrade` | `false` | Opt-in automatic migration flag consumed by server upgrade orchestration. |

[Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`; `server/sonar-db-migration/src/main/java/org/sonar/db/DefaultDatabase.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfiledDataSource.java`; `sonar-application/src/main/assembly/conf/sonar.properties`; `build.gradle`]

If `sonar.embeddedDatabase.port` is explicitly present, embedded H2 takes precedence over `sonar.jdbc.url`. If both are present, the URL is ignored and a warning explains whether it matched the generated embedded URL. If neither is present, port 9092 and the loopback H2 database named `sonar` are selected. The generated URL includes the H2 `NON_KEYWORDS=VALUE` compatibility option and uses bracketed notation for an IPv6 loopback address. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`]

Connection-pool exhaustion is observable as failure to acquire a connection after the effective `sonar.jdbc.maxWait`. A configured zero is a finite `2147483647` ms sentinel, not an indefinite wait. The operator should size `sonar.jdbc.maxActive` against concurrent web and compute demand; the shipped recommendation is 1.2 times the maximum HTTP worker count. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/db/DefaultDatabase.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfiledDataSource.java`; `sonar-application/src/main/assembly/conf/sonar.properties`; `build.gradle`]

## 6. Persistence aggregates and accepted operations

`DbClient` is the aggregate facade. The pinned DAO module registers mappings for these persistence areas: administrative alerts; ALM credentials and project bindings; audit; compute queue, activity, scanner context, inputs, characteristics, and task messages; components, branches, analyses, links, and analysis properties; duplications; entities; index synchronization queue; events; issues and changes; Jira-compatible bindings; measures and metrics; migration logs and migration history; new-code periods; notifications; permissions and templates; plugins; portfolios; projects; properties; provisioning; push events; quality gates; quality profiles and active rules; reports; rules and repositories; scanner cache; SCIM; source data; telemetry; users, groups, sessions, tokens, AI-tool usage, and SAML replay identifiers; webhooks and deliveries. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/DbClient.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/DefaultMyBatis.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/DaoModule.java`]

These are persistence capabilities, not ownership of domain semantics. Each DAO accepts an explicit database session for ordinary mapped operations. Inputs are typed aggregate records, stable identifiers, query filters, pagination, binary or character streams, and conditional old/new values. Outputs are optional or required records, collections, counts, streams, update counts, and persisted rows. Mapper resources select database-specific statements by dialect where common SQL cannot preserve the same result. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/`; `server/sonar-db-dao/src/main/resources/org/sonar/db/`]

The database and writer data source must start before mapper configuration. Startup fails if mapper initialization occurs without a writer data source. Read-only and writer sessions may use distinct configurations; runtime interceptors must be applied to both when they differ. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/StartMyBatis.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/DefaultMyBatis.java`]

## 7. Transaction and concurrency contract

### 7.1 Ordinary DAO sessions

Many ordinary DAO methods accept an explicit database session and issue no commit themselves; their mutations remain grouped under the supplied session's caller-controlled transaction. Other DAO methods commit internally and establish narrower boundaries, including the cases below. Writer and read-only sessions are separate persistence interfaces. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/DefaultMyBatis.java`; commit sites throughout `server/sonar-db-dao/src/main/java/org/sonar/db/`]

Some persistence methods intentionally define a narrower commit boundary:

- atomic queue claiming conditionally changes one `PENDING` row to `IN_PROGRESS`, rereads it, and commits only when exactly one row changed;
- streamed compute inputs, scanner contexts, and scanner cache values commit after the direct JDBC write;
- purge operations commit between deletion phases and partitions, so a later failure can leave an earlier purge phase durable;
- selected bulk renames, notification deletions, permission-template mutations, issue-change deletion, audit purge, and report-stat updates commit within the DAO operation.

An independent implementation must preserve these observed boundaries rather than wrapping every facade call in an assumed all-or-nothing transaction. Domain states named above remain owned by their respective specifications. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeQueueDao.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeTaskInputDao.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeScannerContextDao.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/scannercache/ScannerAnalysisCacheDao.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/purge/PurgeCommands.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/notification/NotificationQueueDao.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/permission/template/PermissionTemplateDao.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/issue/IssueChangeDao.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/audit/AuditDao.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/report/IssueStatsByRuleKeyDaoImpl.java`]

Large input collections are partitioned to remain compatible with database parameter limits, including Oracle's bounded `IN` lists. Concurrency-sensitive transitions use conditional updates and affected-row counts rather than a read-then-unconditional-write race. [Provenance: uses of `DatabaseUtils.executeLargeInputs`, `DatabaseUtils.executeLargeUpdates`, and `DatabaseUtils.PARTITION_SIZE_FOR_ORACLE` under `server/sonar-db-dao/src/main/java/org/sonar/db/`; `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeQueueDao.java`]

### 7.2 Migration transactions

DDL migration steps use a non-autocommit writer connection, but commit after each generated SQL statement. A multi-statement DDL step is therefore not atomic as a whole. Oracle-specific retries may remove an already-satisfied `NULL` or `NOT NULL` clause and retry up to ten transformations for the two recognized Oracle error conditions. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/DdlChange.java`]

Data-change steps use a separate read connection and writer connection, both with autocommit disabled. The reader requests `READ_UNCOMMITTED` only if the driver reports support. Batched upserts default to 250 rows, commit each full batch, and commit the final partial batch. A later failure can therefore retain earlier batches. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/DataChange.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/UpsertImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MassUpdate.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MassRowSplitter.java`]

A migration number is written to `schema_migrations` only after its step returns successfully. The history insert uses a separate connection and is committed when autocommit is disabled. Failure during a step leaves no success row for that step; failure after schema work but during history insertion can leave schema changes without the corresponding history record. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationStepsExecutorImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/history/MigrationHistoryImpl.java`]

The migration history component is intended to run only in the startup-leading web process. The in-memory migration progress object is explicitly not thread-safe. Migration execution must therefore be serialized by startup leadership; concurrent migration execution is outside the supported contract. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/history/MigrationHistoryTable.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationStateImpl.java`]

## 8. Schema invariants

### 8.1 Identifier and type rules

Generated table names are at most 25 characters; constraint and index names are at most 30. New identifiers use lowercase ASCII letters, digits, and underscores, cannot begin with a digit or underscore, and cannot be a reserved SQL keyword except for the retained compatibility identifiers `groups` and `value`. Case-insensitive validation is reserved for operations that must accept an existing mixed-case index name. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/def/Validations.java`]

The schema definition model supports logical varchar, CLOB, BLOB, boolean, tiny/small/integer, bigint, decimal, and timestamp columns. Nullability is explicit. String defaults are quoted; Boolean defaults use dialect values. `VARCHAR` is limited to 4000 characters by the shared schema convention; standard UUID fields are 40 characters. The legacy user UUID limit is 255. Oracle varchar lengths use character semantics unless a legacy migration explicitly preserves old behavior; SQL Server varchar-compatible fields are Unicode. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/def/`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/CreateInitialSchema.java`]

A default primary-key constraint is named `pk_<table>`. Composite primary keys preserve declared column order. Auto-increment is allowed only on a nonnullable numeric column named `id`, with one such column at most per table; the DDL builder emits the supported dialect's identity, serial, or sequence-and-trigger form. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/sql/CreateTableBuilder.java`]

Schema relationships are predominantly logical and enforced by application operations and unique indexes rather than physical foreign keys. Registered migration classes explicitly retain that rule for agent-job and LLM-provider relationships. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202605/CreateAgentJobsTable.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202605/CreateRemediationAgentJobsTable.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202605/CreateLlmProviderMappingsTable.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/sql/CreateTableBuilder.java`]

### 8.2 Canonical Community table inventory

The pinned migration module declares the following 117-table SonarQube inventory for Community-wide metadata and charset checks:

- `a3s_analysis_usages`, `a3s_context_items`, `a3s_contexts`, `active_rules`, `active_rule_parameters`, `admin_alert_status`, `alm_settings`, `alm_pats`, `analysis_properties`, `app_branch_project_branch`, `app_projects`, `atlassian_auth_details`;
- `audits`, `ce_activity`, `ce_queue`, `ce_task_characteristics`, `ce_task_input`, `ce_task_message`, `ce_scanner_context`, `components`, `default_qprofiles`, `deprecated_rule_keys`, `devops_perms_mapping`, `duplications_index`;
- `es_queue`, `events`, `event_component_changes`, `external_groups`, `file_sources`, `github_orgs_groups`, `groups`, `groups_users`, `group_roles`, `internal_component_props`, `internal_properties`, `issue_stats_by_rule_key`;
- `issue_ttr_history`, `issues`, `issues_fixed`, `issues_impacts`, `issue_changes`, `llm_providers`, `llm_provider_mappings`, `measures`, `metrics`, `migration_logs`, `new_code_periods`, `new_code_reference_issues`;
- `notifications`, `org_qprofiles`, `permission_templates`, `perm_templates_users`, `perm_templates_groups`, `perm_tpl_characteristics`, `plugins`, `portfolios`, `portfolio_projects`, `portfolio_proj_branches`, `portfolio_references`, `projects`;
- `project_alm_settings`, `project_badge_token`, `project_branches`, `project_dependencies`, `project_links`, `project_measures`, `project_qprofiles`, `project_qgates`, `properties`, `push_events`, `qprofile_changes`, `qprofile_edit_groups`;
- `qprofile_edit_users`, `quality_gates`, `qgate_user_permissions`, `qgate_group_permissions`, `quality_gate_conditions`, `saml_message_ids`, `report_schedules`, `report_subscriptions`, `rules`, `rule_desc_sections`, `rule_tags`, `rules_default_impacts`;
- `rules_parameters`, `rules_profiles`, `rule_repositories`, `sca_analyses`, `sca_dependencies`, `sca_encountered_licenses`, `sca_ir_cve_locations`, `sca_issue_dimensions`, `sca_issues`, `sca_issues_releases`, `sca_issue_rels_changes`, `sca_lic_prof_categories`;
- `sca_lic_prof_customs`, `sca_lic_prof_projects`, `sca_license_profiles`, `sca_releases`, `sca_ttr_history`, `sca_vulnerability_issues`, `scanner_analysis_cache`, `schema_migrations`, `scim_groups`, `scim_users`, `scm_accounts`, `session_tokens`;
- `snapshots`, `telemetry_metrics_sent`, `users`, `user_ai_tool_usages`, `user_dismissed_messages`, `user_roles`, `user_tokens`, `webhooks`, `webhook_deliveries`.

[Provenance: `server/sonar-db-migration/src/main/java/org/sonar/db/version/SqTables.java`]

The initial schema and dated migration registry also create, rename, alter, or drop compatibility tables outside this canonical metadata-check set. Those operations remain mandatory migration behavior because every version class is registered. They do not grant or specify a user-facing feature. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/MigrationConfigurationModule.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/`]

### 8.3 Charset and collation

The charset checker supports only `h2`, `oracle`, `postgresql`, and `mssql` dialect IDs; any other dialect fails. H2 requires no charset check. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/DatabaseCharsetChecker.java`]

PostgreSQL must report a UTF-8-capable database encoding on fresh install, upgrade, and startup. On upgrade and startup, every varchar column in the canonical SonarQube table set must either inherit default collation or use a UTF-8 collation. Nonconforming columns fail the check; they are not rewritten automatically. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/PostgresCharsetHandler.java`]

Oracle checks `NLS_CHARACTERSET` for UTF-8 support only on a fresh install. It does not recheck on upgrade or ordinary startup because character set is database-global. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/OracleCharsetHandler.java`]

SQL Server requires the database default collation to be case-sensitive and accent-sensitive, or binary-equivalent, in all checker states. On upgrade and startup, nonconforming varchar columns in canonical SonarQube tables are repaired: affected indexes are removed, the column collation is changed while preserving type, size, and nullability, and the indexes are recreated. A database with an invalid default collation is rejected rather than globally rewritten. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/MssqlCharsetHandler.java`; `server/sonar-db-migration/src/main/java/org/sonar/db/version/SqTables.java`]

## 9. Migration states, history, and processing

### 9.1 History schema and version comparison

`schema_migrations` is created if absent before history startup. It contains a nonnullable varchar `version` column of length 255. Each successful registered step contributes its decimal migration number. History reads all values, converts them to numbers, sorts them, and treats the maximum as current. Missing history table after the ensuring component runs, unreadable rows, or failed history insertion is fatal. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/history/MigrationHistoryTableImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/history/MigrationHistoryImpl.java`]

Version states are:

- `FRESH_INSTALL` when no migration number exists;
- `UP_TO_DATE` when the recorded maximum equals the registry maximum;
- `REQUIRES_UPGRADE` when the recorded maximum is lower;
- `REQUIRES_DOWNGRADE` when the recorded maximum is higher.

No downgrade steps are provided. The maximum registered migration in this release is `2026_05_038`. The minimum directly upgradable database version is migration `2025_06_026`, identified for Community Build operators as `25.12`. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/DatabaseVersion.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202605/DbVersion202605.java`]

Operator-visible migration statuses are `NO_MIGRATION`, `MIGRATION_RUNNING`, `MIGRATION_FAILED`, `MIGRATION_SUCCEEDED`, `NOT_SUPPORTED`, and `MIGRATION_REQUIRED`. State includes start time, last error, completed and total step counts, and an estimated finish time only after at least one step completes while a migration is running. Embedded-database upgrade is represented as `NOT_SUPPORTED`. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationState.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationStateImpl.java`]

### 9.2 Execution stages

Migration execution performs these stages:

1. Read the current maximum history number.
2. Select every registered step whose number is at least the next number after that maximum; a fresh database selects all steps.
3. Publish total step count and migration start state through the supplied status listener.
4. Execute steps in strictly increasing numeric order.
5. After each successful step, insert its number into `schema_migrations`, increment progress, and record in-memory duration, success, start time, and target application version.
6. Stop at the first failure, report failure, and leave later steps unexecuted.

[Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/engine/MigrationEngineImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationStepRegistryImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationStepsImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationStepsExecutorImpl.java`]

Migration numbers must be nonnegative and unique. Descriptions must be nonempty and step classes nonnull. Registry order is numeric, not declaration order. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationNumber.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationStepRegistryImpl.java`]

### 9.3 Complete registered migration catalog

The following migration numbers and effects are registered in this release. Schema entries do not imply corresponding feature availability.

#### Initial steps

- `1`: create the pinned initial schema.
- `2`: populate initial reference data.

[Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/DbVersion00.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/CreateInitialSchema.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/PopulateInitialSchema.java`]

#### 2026.1 steps

- `2026_01_000`: add index `components_copy_component_uuid`.
- `2026_01_001`: populate internal property `analyses.counter.date`.
- `2026_01_002`: add the unique current-analysis constraint for root snapshots where `islast` is true.
- `2026_01_003`: add `part_number` to `ce_task_input`.
- `2026_01_004`: add `part_count` to `ce_queue`.

[Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202601/DbVersion202601.java`]

#### 2026.2 steps

- `2026_02_000`: create `sca_ir_cve_locations`.
- `2026_02_001`: create `integration_bindings`.

[Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202602/DbVersion202602.java`]

#### 2026.3 steps

- `2026_03_000`: add `epss_score`, `epss_percentile`, and `known_exploited` to `sca_vulnerability_issues`.
- `2026_03_001`: convert `sca_analyses.failed_reason` to CLOB storage.
- `2026_03_002`: seed the GitLab Planner permission mapping.
- `2026_03_003`: seed the GitLab Security Manager permission mapping.
- `2026_03_004`: add nullable `component_uuid` to `sca_issues_releases`.
- `2026_03_005`: backfill that component identifier from `sca_releases`.
- `2026_03_006`: make the backfilled component identifier nonnullable.
- `2026_03_007`: create `admin_alert_status`.

[Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202603/DbVersion202603.java`]

#### 2026.4 steps

- `2026_04_000` and `2026_04_001`: remove redundant unique indexes from `issues_impacts` and `rules_default_impacts`.
- `2026_04_002` and `2026_04_003`: normalize the corresponding Oracle primary-key index names to `pk_issues_impacts` and `pk_rules_default_impacts`.
- `2026_04_004`: remove redundant index `issue_changes_issue_key`.
- `2026_04_005`, `2026_04_006`, and `2026_04_007`: add `updated_at` indexes for `sca_issues`, `sca_releases`, and `sca_issues_releases`.
- `2026_04_008`: align portfolio privacy with the matching component.
- `2026_04_009`: remove the retired `Sonar way for AI Code` quality gate.
- `2026_04_010`: add `organization_uuid` to `sca_encountered_licenses` and replace its unique index.
- `2026_04_011`: create `architecture_models`.
- `2026_04_012`: drop `architecture_graphs`.
- `2026_04_013`: grant existing project administrators the architecture-administration permission record.
- `2026_04_014`: add `signature_type` to `sca_ir_cve_locations`.
- `2026_04_015`, `2026_04_016`, `2026_04_017`, and `2026_04_018`: create `arch_graph_metadata`, `arch_graph_blobs`, `arch_scanner_data`, and `arch_directives`, respectively.
- `2026_04_019`: drop `architecture_models`.
- `2026_04_020`: create `arch_intended`.
- `2026_04_021`: add `origin` to `arch_directives`.

[Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202604/DbVersion202604.java`]

#### 2026.5 steps

- `2026_05_000`, `2026_05_001`, and `2026_05_002`: create `a3s_contexts`, `a3s_context_items`, and `a3s_analysis_usages`.
- `2026_05_003` and `2026_05_004`: create `agent_schedules` and `agent_sched_proc_issues`.
- `2026_05_005`: add `reachability_analyzed` to `sca_issues_releases`.
- `2026_05_006`: seed the global `*` schedule row.
- `2026_05_007` and `2026_05_008`: create `issue_count_dimensions` and `issue_count_history`.
- `2026_05_009` and `2026_05_010`: create `measure_key_mapping` and `measure_history`.
- `2026_05_011`: enlarge `issue_stats_by_rule_key.rule_key`.
- `2026_05_012` and `2026_05_013`: create `sca_issue_dimensions` and `sca_ttr_history`.
- `2026_05_014`: make `a3s_contexts.branch_name` nullable.
- `2026_05_015`: add `producer` to `issues`.
- `2026_05_016`: create transitional table `agentic_job`.
- `2026_05_017` and `2026_05_018`: create `llm_providers` and `llm_provider_mappings`.
- `2026_05_019`: create `arch_boundary_descriptors`.
- `2026_05_020`: rename `arch_intended` to `arch_models`.
- `2026_05_021`: rename index `arch_intended_uuid` to `arch_models_uuid`.
- `2026_05_022` and `2026_05_023`: create `arch_patterns` and `arch_model_patterns`.
- `2026_05_024`: rename the primary-key constraint to `pk_arch_models`.
- `2026_05_025`, `2026_05_026`, and `2026_05_027`: create `arch_org_placeholders`, `arch_proj_relations`, and `arch_proj_org_compo`.
- `2026_05_028`: create `dashboards`.
- `2026_05_029`: create `issue_ttr_history`.
- `2026_05_030` and `2026_05_031`: remove `sca_ttr_history_uq_idx` and `sca_ttr_history_ent_type_epoch`.
- `2026_05_032`: resize `sca_ttr_history.entity_id` and `entity_type`.
- `2026_05_033`: add `url` and `repo_id` to `project_alm_settings`.
- `2026_05_034` and `2026_05_035`: add `updated_at` indexes to `sca_dependencies` and `sca_ir_cve_locations`.
- `2026_05_036` and `2026_05_037`: create `agent_jobs` and `remediation_agent_jobs`.
- `2026_05_038`: drop transitional table `agentic_job`.

[Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202605/DbVersion202605.java`]

## 10. Dialect behavior

DDL and mapper behavior must preserve equivalent Sonar results across H2, PostgreSQL, Oracle, and SQL Server. Differences include Unicode string types, Boolean literals, auto-increment forms, pagination and row limits, merge/upsert syntax, single-row selects, binary values, CLOB/BLOB handling, index and primary-key discovery, and constraint renaming. Database-specific mapper statements use database IDs `h2`, `postgresql`, `oracle`, and `mssql`; common statements are used when equivalent. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/sql/`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/def/`; `server/sonar-db-dao/src/main/resources/org/sonar/db/`]

Unsupported dialect IDs must fail rather than silently falling back to a superficially similar SQL form. DDL builders may return more than one statement for one logical operation, notably Oracle auto-increment sequences and triggers; the migration transaction rules in section 7 remain applicable. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/sql/CreateTableBuilder.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/DatabaseCharsetChecker.java`]

## 11. Profiling and observability

`DatabaseMBean` exposes pool active, total, idle, maximum, and minimum-idle connection counts, plus configured maximum lifetime and connection-wait milliseconds. If a live pool management view is unavailable, active, total, and idle report zero. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/DatabaseMBean.java`]

`ProfiledDataSource` can switch its connection interceptor at runtime. Pass-through mode returns ordinary connections. Profiled mode wraps connections, prepared statements, and statements while delegating all data-source and pool controls to the underlying pool. [Provenance: `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfiledDataSource.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/NullConnectionInterceptor.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfiledConnectionInterceptor.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfilingConnectionHandler.java`]

In profiled mode, every statement method whose name begins with `execute` is timed and logged to logger `sql` at trace level, including failed executions because logging occurs during finalization. Prepared-statement output contains normalized SQL and, when present, captured parameter values. Direct statements contain normalized SQL. SQL newlines and tabs collapse to spaces; repeated whitespace collapses; each parameter is rendered up to 500 characters, with null represented distinctly and embedded newlines escaped. [Provenance: `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfilingPreparedStatementHandler.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfilingStatementHandler.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/SqlLogFormatter.java`]

Trace SQL logging can expose credentials, tokens, personal data, source material, or other sensitive row values. It must be treated as privileged diagnostic output with restricted access and retention. [Provenance: `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfilingPreparedStatementHandler.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/SqlLogFormatter.java`]

## 12. Failure, partial-result, and recovery behavior

### 12.1 Connection and compatibility failures

Bad URL syntax, unsupported provider, missing or ambiguous driver files, unavailable database, invalid credentials, pool-acquisition timeout, invalid pool ranges, insufficient DDL privileges, unsupported dialect, wrong charset, or invalid SQL Server collation prevents persistence from becoming usable. In particular, `sonar.jdbc.maxActive` outside 1 through `2147483647`, negative `sonar.jdbc.maxWait`, and positive `sonar.jdbc.maxWait` below 250 ms fail configuration parsing or data-source initialization. Errors retain the provider, directory, schema, column, or migration context needed for diagnosis while callers must avoid echoing secret credentials. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`; `server/sonar-db-migration/src/main/java/org/sonar/db/DefaultDatabase.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfiledDataSource.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/`; `server/sonar-db-dao/src/main/java/org/sonar/db/StartMyBatis.java`; `build.gradle`]

A schema whose maximum recorded migration exceeds `2026_05_038` is `REQUIRES_DOWNGRADE`. This release supplies no reverse migration. Recovery is to use an application release compatible with that schema or restore a compatible database backup; this runtime must not pretend the newer schema is current. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/DatabaseVersion.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202605/DbVersion202605.java`]

A schema older than the direct-upgrade floor is unsupported even though individual historical numbers can be compared. It must first follow the supported upgrade path to Community Build `25.12`. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/DatabaseVersion.java`]

### 12.2 Migration failure and resume

Execution stops at the first failing step. The failing step is not written to `schema_migrations`; completed earlier steps and committed batches remain durable. A later run begins after the highest recorded successful number, so the failed step is selected again. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/engine/MigrationEngineImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationStepsExecutorImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/history/MigrationHistoryImpl.java`]

Because DDL statements and data batches commit incrementally, a failed step can be partially applied. Automatic retry is safe only when that step tolerates its already-applied effects. Otherwise the operator must restore a pre-migration backup or repair the partial schema according to the logged failing step before retrying. The runtime must never insert a success history row merely to suppress the error. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/DdlChange.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/UpsertImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MassUpdate.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationStepsExecutorImpl.java`]

Migration progress logs record total and completed counts, each step number and description, success or failure, and duration. Global completion is logged as success only when every selected step completes. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationStepsExecutorImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationLoggerContext.java`]

## 13. Security and trust boundaries

- Database credentials and encrypted configuration values cross from process configuration into web and compute child properties. They must not be exposed in command lines, ordinary logs, migration errors, or unprotected temporary files. Configuration loading and process-file protection are owned by `platform/process-runtime/`. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`; `manifest/dependency-map.md`]
- The JDBC principal is trusted to mutate the entire Sonar schema, including tables, indexes, sequences, and triggers. It should not have unrelated database privileges. [Provenance: `sonar-application/src/main/assembly/conf/sonar.properties`; migration DDL under `server/sonar-db-migration/src/main/java/`]
- DAO inputs are trusted internal typed values, but JDBC remains a boundary against malformed or hostile stored data. Mapper parameters must remain bound values; database identifiers used by migration builders must pass identifier validation. [Provenance: `server/sonar-db-dao/src/main/resources/org/sonar/db/`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/def/Validations.java`]
- `schema_migrations` is privileged control state. Manual edits can skip required migrations or force downgrade status and are unsupported except as an evidence-backed recovery operation. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/history/MigrationHistoryImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/DatabaseVersion.java`]
- SQL trace output contains bound parameter values and is a sensitive diagnostic channel. [Provenance: `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfilingPreparedStatementHandler.java`]

## 14. Compatibility and limits

- Database and driver support is limited to the four provider tokens and production server versions listed in section 4. No compatibility is inferred for later database releases or alternate JDBC provider tokens. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`; `sonar-application/src/main/assembly/conf/sonar.properties`]
- The embedded database is not a production or supported upgrade target. Multi-node runtime rejects embedded H2. [Provenance: `sonar-application/src/main/assembly/conf/sonar.properties`; `server/sonar-main/src/main/java/org/sonar/application/config/ClusterSettings.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationState.java`]
- Schema names, migration numbers, column limits, primary-key names, and unique indexes are compatibility identifiers. They must not be silently renamed or renumbered. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/sql/`]
- Migration state is forward-only. Backups and external database recovery are operator responsibilities; this module does not implement rollback migrations. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/DatabaseVersion.java`; registered versions under `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/`]
- This specification is pinned to release `26.8.0.126808`. Later schemas, migration steps, drivers, or database-version support are out of scope. [Provenance: `manifest/release-baseline.md`]

## 15. Acceptance scenarios

### Scenario 1: Default embedded database selection

Preconditions: neither `sonar.jdbc.url` nor `sonar.embeddedDatabase.port` is configured and the H2 driver directory is valid.

Action: load persistence settings.

Expected outcome: provider is H2, port is 9092, the loopback URL targets database `sonar` with `NON_KEYWORDS=VALUE`, and no external provider is selected. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`]

### Scenario 2: Explicit embedded port wins over URL

Preconditions: `sonar.embeddedDatabase.port` and a PostgreSQL `sonar.jdbc.url` are both set.

Action: load persistence settings.

Expected outcome: H2 is selected using the configured embedded port, PostgreSQL URL is ignored, and an inconsistency warning states the effective URL. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`]

### Scenario 3: Supported external database starts

Preconditions: a supported PostgreSQL, Oracle, or SQL Server instance meets the version, schema, charset/collation, credentials, privilege, and driver requirements.

Action: start persistence and mapper configuration.

Expected outcome: writer data source starts before mappings, the correct dialect-specific statements load, sessions can read and write, and pool observations expose configured and current counts. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/StartMyBatis.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/DefaultMyBatis.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/DatabaseMBean.java`; mapper resources under `server/sonar-db-dao/src/main/resources/org/sonar/db/`]

### Scenario 4: Unsupported JDBC provider fails early

Preconditions: `sonar.jdbc.url` names a provider other than `h2`, `sqlserver`, `oracle`, or `postgresql`.

Action: load settings.

Expected outcome: configuration fails with the unsupported provider name before child persistence startup. No fallback database is selected. [Provenance: `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`]

### Scenario 5: SQL Server collation is rejected or repaired correctly

Preconditions: SQL Server default collation is case-insensitive, or individual Sonar varchar columns are case-insensitive while the default is valid.

Action: run charset checking.

Expected outcome: invalid default collation fails with a case-sensitive/accent-sensitive target. With a valid default during startup or upgrade, nonconforming Sonar columns are repaired while their indexes are dropped and recreated. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/MssqlCharsetHandler.java`]

### Scenario 6: Fresh database reaches the pinned migration maximum

Preconditions: writable supported empty schema and no migration rows.

Action: execute migrations.

Expected outcome: `schema_migrations` exists; initial schema and population run first; all dated steps run in numeric order through `2026_05_038`; each successful step records its number; final version status is `UP_TO_DATE`. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/history/MigrationHistoryTableImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/engine/MigrationEngineImpl.java`; version registries under `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/`]

### Scenario 7: Failed migration resumes from history

Preconditions: several steps succeed and the next step fails after at least one internal DDL statement or data batch commits.

Action: inspect state, correct or restore the partial database as required, then run migration again.

Expected outcome: completed earlier numbers remain in `schema_migrations`; failed number is absent; status reports failure and logs identify the step; retry selects the failed number and every later step. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/MigrationStepsExecutorImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/DdlChange.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/UpsertImpl.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/history/MigrationHistoryImpl.java`]

### Scenario 8: Newer schema requires downgrade

Preconditions: the highest `schema_migrations.version` exceeds `2026_05_038`.

Action: evaluate database version.

Expected outcome: status is `REQUIRES_DOWNGRADE`; no forward step or automatic history edit treats it as current. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/DatabaseVersion.java`]

### Scenario 9: Atomic queue claim under contention

Preconditions: two workers attempt to claim the same pending compute row.

Action: both issue the conditional claim.

Expected outcome: only the transaction that changes exactly one pending row receives and commits the claimed row; the other receives an empty result. Compute task state meaning remains owned by `platform/compute-engine/`. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeQueueDao.java`; `manifest/dependency-map.md`]

### Scenario 10: Pool exhaustion honors timeout

Preconditions: all allowed connections are active and `sonar.jdbc.maxWait=8000`.

Action: request another connection without any connection returning.

Expected outcome: acquisition fails after the configured wait rather than silently exceeding `sonar.jdbc.maxActive`. Pool MBean maximum and current counts remain observable. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`; `sonar-application/src/main/assembly/conf/sonar.properties`; `server/sonar-db-dao/src/main/java/org/sonar/db/DatabaseMBean.java`]

### Scenario 11: SQL profiling preserves execution behavior

Preconditions: profiled interceptor is enabled and SQL logger is at trace level.

Action: execute one prepared statement successfully and one that raises a database exception.

Expected outcome: both executions retain their original return or exception behavior; each emits duration and normalized SQL; prepared parameters are logged with null distinction, newline escaping, and 500-character maximum rendering. [Provenance: `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/ProfilingPreparedStatementHandler.java`; `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/SqlLogFormatter.java`]

## 16. Provenance index

- Release and license: `manifest/release-baseline.md`, `manifest/license-map.md`, `LICENSE.txt`.
- JDBC properties and defaults: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`, `server/sonar-main/src/main/java/org/sonar/application/config/JdbcSettings.java`, and `sonar-application/src/main/assembly/conf/sonar.properties`.
- Driver versions and inclusion: `build.gradle`, `sonar-application/build.gradle`.
- Aggregate facade and mappings: `server/sonar-db-dao/src/main/java/org/sonar/db/DbClient.java`, `server/sonar-db-dao/src/main/java/org/sonar/db/DefaultMyBatis.java`, `server/sonar-db-dao/src/main/java/org/sonar/db/DaoModule.java`, aggregate packages under `server/sonar-db-dao/src/main/java/org/sonar/db/`, and mapper resources under `server/sonar-db-dao/src/main/resources/org/sonar/db/`.
- Startup and pool observations: `server/sonar-db-dao/src/main/java/org/sonar/db/StartMyBatis.java`, `server/sonar-db-dao/src/main/java/org/sonar/db/DatabaseMBean.java`.
- Canonical table set: `server/sonar-db-migration/src/main/java/org/sonar/db/version/SqTables.java`.
- Schema definitions: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/CreateInitialSchema.java`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/def/`, and `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/sql/`.
- Charset and collation: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/charset/`.
- Migration registration: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/MigrationConfigurationModule.java`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202601/`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202602/`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202603/`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202604/`, and `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202605/`.
- Migration engine and history: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/engine/`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/step/`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/history/`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationState.java`, `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationStateImpl.java`, and `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationLoggerContext.java`.
- SQL profiling: `server/sonar-db-profiling/src/main/java/org/sonar/db/profiling/`.
