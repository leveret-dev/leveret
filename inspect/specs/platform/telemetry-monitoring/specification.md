# Telemetry and Monitoring Specification

## 1. Identity and license

This specification describes telemetry and operational monitoring bundled with SonarQube Community Build `26.8.0.126808`, published 2026-08-05 from Git tag `26.8.0.126808` and commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The authoritative source is `SonarSource/sonarqube` at that commit. The telemetry implementation is primarily in `server/sonar-telemetry`, `server/sonar-telemetry-core`, `server/sonar-webserver-monitoring`, and the health and system-information packages in the Web server modules. [Provenance: `manifest/release-baseline.md`; `manifest/component-inventory.md`; source paths above]

The inspected production source is `LGPL-3.0-or-later` and does not qualify for a GPL/AGPL copy marker. This is a behavioral clean-room specification, not legal advice. [Provenance: root `LICENSE.txt`; `manifest/license-map.md`]

## 2. Purpose, ownership, and strict separation from delivery

This part owns:

- voluntary usage telemetry gating, opt-out signalling, collection cadence, upload sequence, and sent-metric state;
- telemetry message envelopes and the Community Build metric vocabulary;
- operational health composition and health APIs;
- Prometheus-compatible runtime metrics and their collection schedules; and
- administrator system-information output and uptime observations.

It consumes process state, Compute Engine task state, search state, provider integration state, persisted projects/users/measures, and authentication. It does not redefine those feature states. It also does not own user-visible email, webhook, or IDE notification delivery; those belong to `platform/events-notifications/`. Telemetry and monitoring observe the system. A telemetry upload, health status, log entry, gauge value, or connected-client count must never be represented as proof that a user-visible notification was delivered or acknowledged. [Provenance: `manifest/dependency-map.md`; `server/sonar-telemetry`; `server/sonar-webserver-monitoring`]

External SonarSource telemetry endpoints and Prometheus scrapers are trust-boundary peers. Their server implementations are out of scope. Commercial data providers are not inferred. Classes present in shared source are specified only where Community Build registers or directly invokes them.

## 3. Telemetry configuration and precedence

The process-property layer supplies these observed defaults:

| Key | Observed default | Meaning |
|---|---|---|
| `sonar.telemetry.enable` | `true` | Master gate for scheduled and direct telemetry paths that inspect it. |
| `sonar.telemetry.url` | `https://telemetry.sonarsource.com/sonarqube` | Legacy aggregate POST and opt-out DELETE endpoint. |
| `sonar.telemetry.metrics.url` | `https://telemetry.sonarsource.com/sonarqube/metrics` | Metric-envelope POST endpoint. |
| `sonar.telemetry.frequencyInSeconds` | `10800` | Delay before the first daemon check and fixed delay between subsequent checks. |
| `sonar.telemetry.compression` | `true` | Whether scheduled POST bodies are gzip-compressed. |
| `sonar.telemetry.metricsBatchSize` | `10000` | Maximum number of metric entries per modern envelope. Must be positive. |
| `sonar.telemetry.lock.delay` | `60` when absent | Lease supplied to the global `TelemetryStat` lock. |

Process-property values are loaded into runtime configuration before component startup. The daemon requires an explicit resolved boolean for `sonar.telemetry.enable` and integer for `sonar.telemetry.frequencyInSeconds`; the standard process defaults satisfy those requirements. Endpoint configuration is read when the telemetry client starts. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`; `server/sonar-telemetry/src/main/java/org/sonar/telemetry/TelemetryDaemon.java`; `server/sonar-telemetry-core/src/main/java/org/sonar/telemetry/core/TelemetryClient.java`; `server/sonar-telemetry/src/main/java/org/sonar/telemetry/metrics/TelemetryMetricsLoader.java`]

`sonar.performanceMonitoring.enabled` is a separate operational-observability gate, observed default `false`. It enables Web API and MyBatis timing observations only; it does not gate health, uptime, queue, search, integration, or connected-IDE gauges. [Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/platform/web/WebApiV1MetricsInterceptor.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/common/WebApiV2MetricsInterceptor.java`; `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/MyBatisMetricsInterceptor.java`]

## 4. Telemetry lifecycle, locking, and sequence

### 4.1 Enable, disable, and opt-out transitions

At Web telemetry-daemon startup:

1. If telemetry is disabled and internal property `telemetry.optOut` is absent, the client sends one DELETE to `sonar.telemetry.url` with JSON field `id` equal to the installation/server ID, then stores the current epoch milliseconds in `telemetry.optOut` and logs that sharing is disabled.
2. If telemetry remains disabled and `telemetry.optOut` already exists, no further opt-out request is sent.
3. If telemetry becomes enabled while `telemetry.optOut` exists, the marker is removed.
4. When disabled, the scheduled upload service is not started.
5. When enabled, the daemon logs that sharing is enabled and schedules checks; it does not upload immediately at startup.

The opt-out HTTP client catches transport I/O failure and still allows the local opt-out marker to be written. Thus the marker records that the installation attempted its one-time transition; it is not a remote acknowledgement. [Provenance: `server/sonar-telemetry/src/main/java/org/sonar/telemetry/TelemetryDaemon.java`; `server/sonar-telemetry-core/src/main/java/org/sonar/telemetry/core/TelemetryClient.java`; `server/sonar-telemetry/src/test/java/org/sonar/telemetry/TelemetryDaemonTest.java`]

Direct telemetry emitters for database migration, DevOps configuration, issue-index creation, project analysis, and merged-pull-request purge independently read the same `sonar.telemetry.enable` gate and do nothing when it is false or unresolved. The startup event `Analytics.Server.Started` is emitted to the unified event dispatcher regardless of this local gate; the pinned source has no Community production telemetry handler for that event, and publication failure is isolated from startup. [Provenance: direct emitter sources cited in section 7; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/telemetry/ServerStartupEventPublisher.java`]

### 4.2 Scheduled check and daily upload gate

The daemon owns one minimum-priority scheduled thread. It uses fixed delay equal to `sonar.telemetry.frequencyInSeconds` for both initial delay and repeat delay. Each invocation first attempts global lock `TelemetryStat` with the configured lease. Failure to acquire ends that invocation without changing timestamps or sequence. After acquiring, it reads internal property `telemetry.lastPing` and uploads only when the property is absent or at least 86,400,000 milliseconds old. The default three-hour scheduler therefore checks four times per day but normally uploads no more than once per elapsed 24 hours. [Provenance: `server/sonar-telemetry/src/main/java/org/sonar/telemetry/TelemetryDaemon.java`]

The successful scheduled sequence is strictly:

1. load, serialize, and POST the legacy aggregate;
2. reset the legacy loader’s in-memory assembly maps;
3. load modern provider metrics, partition them into messages, and POST each message in order;
4. in one database transaction, upsert last-sent state for every eligible provider key and dimension;
5. run every provider’s post-send cleanup hook;
6. write `telemetry.lastPing`; and
7. initialize `telemetry.messageSeq` to `1` if absent, otherwise increment its stored decimal value by one.

The legacy payload uses the next sequence number: stored value plus one, with absent treated as zero. Therefore the first completed payload carries `messageSequenceNumber` 1 and leaves stored sequence 1. A failure before the final property update leaves `telemetry.lastPing` and the sequence unchanged, making a later scheduled check eligible again. There is no explicit retry timer beyond the next fixed-delay check. [Provenance: `server/sonar-telemetry/src/main/java/org/sonar/telemetry/TelemetryDaemon.java`; `server/sonar-telemetry/src/main/java/org/sonar/telemetry/legacy/TelemetryDataLoaderImpl.java`; `server/sonar-telemetry/src/test/java/org/sonar/telemetry/TelemetryDaemonTest.java`]

### 4.3 Metric-level cadence state

Modern provider state is persisted by the unique combination of metric key and dimension with `lastSent` epoch milliseconds. An `ADHOC` provider is eligible whenever the daily daemon reaches it. A metric with no prior state is eligible. Otherwise `DAILY`, `WEEKLY`, and `MONTHLY` are eligible only when the corresponding whole-unit difference between the stored instant and current instant in the server’s system time zone is greater than zero. The state applies to the provider key as a whole, including all keyed values returned by that provider. [Provenance: `server/sonar-telemetry/src/main/java/org/sonar/telemetry/metrics/util/SentMetricsStorage.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/telemetry/TelemetryMetricsSentDao.java`]

Eligible metrics are grouped by dimension in stable provider iteration order. Each dimension is split into messages of at most `sonar.telemetry.metricsBatchSize` entries. A nonpositive batch size fails the invocation. Every message receives a fresh message UUID and the installation ID. Sent-state rows are updated only after all message POST calls return without I/O failure. Post-send hooks run only after those database updates commit; ad hoc in-memory counters use the hook to clear accumulated values. [Provenance: `server/sonar-telemetry/src/main/java/org/sonar/telemetry/metrics/TelemetryMetricsLoader.java`; `server/sonar-telemetry-core/src/main/java/org/sonar/telemetry/core/AbstractMultiValueCounterDataProvider.java`]

## 5. Telemetry transport and failure semantics

Legacy and modern uploads use HTTP POST with JSON media type. Opt-out uses DELETE with a JSON body against the legacy endpoint. When compression is enabled, POST bodies are gzip-compressed. The pinned client always sends `Content-Encoding: gzip` on POST, including when compression is configured false; this observed wire behavior is part of compatibility. It also sends `Content-Type: application/json`. [Provenance: `server/sonar-telemetry-core/src/main/java/org/sonar/telemetry/core/TelemetryClient.java`; `server/sonar-telemetry/src/test/java/org/sonar/telemetry/TelemetryClientCompressionTest.java`]

A completed HTTP exchange is treated as completion regardless of status code; the client closes the response without inspecting success status. I/O failure is the only transport result propagated by synchronous POST methods. The daemon catches all exceptions, logs them at debug level, and leaves the scheduler alive. It has no exponential backoff or status-based retry. Direct asynchronous upload creates a daemon thread per message, catches I/O failure, logs at debug level, and does not retry. [Provenance: `server/sonar-telemetry-core/src/main/java/org/sonar/telemetry/core/TelemetryClient.java`; `server/sonar-telemetry/src/main/java/org/sonar/telemetry/TelemetryDaemon.java`]

Failure isolation has deliberate limits. One modern provider throwing while values are loaded aborts the modern collection for that invocation; there is no per-provider catch. A failure after the legacy POST but before modern completion can therefore produce a legacy upload without advancing `lastPing` or sequence. Some already-POSTed modern batches can also be repeated on the next invocation because sent-state is committed only after every batch returns. This is at-least-one-attempt behavior, not exactly-once delivery. [Provenance: `TelemetryDaemon.java`; `TelemetryMetricsLoader.java`]

## 6. Telemetry message schemas

### 6.1 Modern metric envelope

A modern JSON message has fields:

- `message_uuid`: unique message identifier;
- `installation_id`: server installation identifier;
- `dimension`: one of `installation`, `user`, `project`, `language`, `analysis`, or `fixsuggestion`; and
- `metric_values`: a set of metric objects.

Every metric object has `key`, `value`, `type`, and `granularity`. The supported declared value types are the values of `TelemetryDataType`; registered Community providers use boolean, string, and integer. A user metric adds `user_uuid`, a project metric adds `project_uuid`, a language metric adds `language`, an analysis metric adds `project_uuid`, `analysis_type`, and `analysis_uuid`, and a fix-suggestion metric adds `project_uuid` and `fix_suggestion_uuid`. Analysis types are `branch` and `pull_request`. [Provenance: `server/sonar-telemetry-core/src/main/java/org/sonar/telemetry/core/schema/`; `Dimension.java`; `Granularity.java`; `TelemetryDataType.java`]

Provider contracts require metric-key-plus-dimension uniqueness. A provider may return one value or a map whose keys supply user UUID, project UUID, language, or a suffix/subcategory according to dimension mapping. Providers returning no value contribute no metric entry. [Provenance: `server/sonar-telemetry-core/src/main/java/org/sonar/telemetry/core/TelemetryDataProvider.java`; `server/sonar-telemetry/src/main/java/org/sonar/telemetry/metrics/TelemetryMetricsMapper.java`]

### 6.2 Legacy aggregate

The legacy daily object contains installation `id`, product `version`, `messageSequenceNumber`, UTC `localTimestamp`, `ncdId`, optional lowercase `edition`, `defaultQualityGate`, `sonarway_quality_gate_uuid`, database name/version, installed plugin name/version pairs, optional `customSecurityConfig`, Community indicators `hasUnanalyzedC` and `hasUnanalyzedCpp`, optional installation date/version, and `container`. [Provenance: `server/sonar-telemetry/src/main/java/org/sonar/telemetry/legacy/TelemetryDataJsonWriter.java`; `TelemetryDataLoaderImpl.java`]

When available it also contains:

- `users`, with SHA3-224-hashed `userUuid`, active/inactive status, identity provider, last activity, last SonarLint activity, and managed flag;
- `projects`, with project UUID, latest analysis, language, LOC, and quality-profile UUID;
- `projects-general-stats`, with project UUID, branch/PR counts, quality-gate UUID, detected SCM/CI/DevOps platform, new-code-definition ID, creation method, monorepo and AI-code-assurance flags, and optional bugs, vulnerabilities, security hotspots, technical debt, development cost, and external-security-report export time;
- `branches`, with project/branch UUID, new-code-definition ID, green-gate and analysis counts, and purge exclusion;
- `new-code-definitions`, with derived `ncdId`, type, value, and scope;
- `quality-gates`, with UUID, Clean-as-You-Code status, AI-code-assurance qualification flag, and condition metric/operator/error threshold;
- `quality-profiles`, with UUID, parent, language, default/built-in flags, optional built-in parent, and activated/deactivated/overridden rule counts;
- `managedInstanceInformation`; and
- `cloudUsage` container/Kubernetes observations.

Project and branch UUIDs in this legacy payload are not hashed. Analysis properties contribute SCM and CI observations; no source code or issue text is included by this writer. Registered telemetry extensions may append fields. [Provenance: `server/sonar-telemetry/src/main/java/org/sonar/telemetry/legacy/TelemetryData.java`; `TelemetryDataJsonWriter.java`; `TelemetryDataLoaderImpl.java`; `CloudUsageDataProvider.java`; `QualityProfileDataProvider.java`]

## 7. Complete registered Community telemetry vocabulary

### 7.1 Scheduled provider metrics

The following providers are registered in the Community Web container or its Web API modules. `ADHOC` here means sent at the next otherwise-eligible scheduled daily upload, not immediately.

| Metric key | Dimension | Granularity | Type | Value semantics |
|---|---|---|---|---|
| `version` | installation | daily | string | Current server version. |
| `multi_quality_rule_mode_enabled` | installation | weekly | boolean | Global MQR-mode property; absence is observed as `true`. |
| `ncloc_per_language` | language | daily | integer | Sum of LOC per language using each project’s selected largest-LOC branch data. |
| `user_enabled` | user | daily | boolean | Active flag keyed by SHA3-224 hash of user UUID; users are read in pages of 1000. |
| `is_fips_enabled` | installation | daily | boolean | Runtime FIPS detection result. |
| `internet_protocol_version` | installation | monthly | integer | `6` when configured Web host is recognized as IPv6, otherwise `4`. |
| `issue_count_by_status` | installation | daily | integer | Counts of main-branch issues keyed by the status/resolution mapping returned by persistence. |
| `agentic_qg_projects_count` | installation | weekly | integer | Count of projects resolved as using quality gate `Sonar way for Agentic AI`. |
| `agentic_qg_ncd_failed_count` | installation | weekly | integer | Count of latest agentic-project analyses at a new-code reset point whose gate status is `ERROR`. |
| `agentic_qp_projects_count` | language | weekly | integer | Count of projects using quality profile `Sonar agentic AI`, keyed by language. |
| `project_main_branch_qg_at_nc_start` | project | monthly | string | Historical quality-gate status on the last main-branch snapshot before the current new-code period; projects lacking evidence are omitted. |
| `applications_total_count` | installation | adhoc | integer | Application count. Community source registers the provider; no commercial application behavior is inferred. |
| `portfolio_using_selection_mode` | installation | adhoc | integer | Portfolio counts keyed by stored selection mode. No availability beyond registered source is inferred. |
| `subportfolio_using_selection_mode` | installation | adhoc | integer | Subportfolio counts keyed by stored selection mode. No availability beyond registered source is inferred. |
| `application_report_pdf_subscriptions` | installation | daily | integer | Stored application report-subscription count. |
| `portfolio_report_pdf_subscriptions` | installation | daily | integer | Stored portfolio report-subscription count. |
| `project_report_pdf_subscriptions` | project | daily | integer | Stored report-subscription count keyed by project UUID. |
| `email_conf_host` | installation | weekly | string | Top private domain of configured SMTP host, or `NOT_SET`, `EMPTY_DOMAIN`, `NOT_VALID_DOMAIN_NAME`, `DOMAIN_NOT_UNDER_PUBLIC_SUFFIX`, or `NOT_VALID_DOMAIN`. |
| `email_conf_auth_method` | installation | weekly | string | Stored email authentication method or `NOT_SET`. |
| `project_badges_count` | installation | adhoc | integer | In-memory badge request counts keyed by requested project metric; cleared after successful scheduled send. |
| `portfolio_activity_graph_type` | installation | adhoc | integer | In-memory portfolio activity requests keyed by graph type; cleared after successful scheduled send. |
| `portfolio_activity_requested_metric` | installation | adhoc | boolean | Keys of portfolio activity metrics requested since the preceding successful scheduled send, each with value true; cleared afterward. |

[Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/platformlevel/PlatformLevel4.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/telemetry/`; `server/sonar-server-common/src/main/java/org/sonar/server/telemetry/`; `server/sonar-server-common/src/main/java/org/sonar/server/notification/email/telemetry/`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/telemetry/`; Web API module registrations]

### 7.2 Direct ad hoc metric messages

The direct enabled-gated emitters add these public keys:

| Trigger | Dimension | Keys and semantics |
|---|---|---|
| Completed database migration at Web startup | installation | `db_migration_success`; `db_migration_completed_steps`; `db_migration_total_time_ms`; and one integer `db_migration_step_duration.<step>` per recorded step. No message is sent when there is no migration data. |
| Manual or automatic DevOps/authentication configuration | installation | `devops_config_manual_alm`, `devops_config_auto_alm`, `devops_config_auto_auth_setup`, `auth_config_manual_alm`, `auth_config_auto_alm`. Values identify ALM ID or automatic-auth boolean. |
| Completion of asynchronous issue-index creation | installation | `async_issue_indexing_duration`, `async_issue_indexing_task_total_count`, and `async_issue_indexing_task_failure_count`. Progress is checked immediately and every five seconds until no issue-sync task is pending or in progress. Starting a new monitor cancels the preceding monitor without interrupting it. |
| Project analysis | analysis | `analyzed_ncloc`; main-branch dynamic `indexed_files.<sanitized-language>.unanalyzed.total` and `indexed_files.<sanitized-language>.analyzed.total`; scanner-report telemetry keys; and Compute Engine step telemetry keys. All values are strings, granularity is adhoc, analysis type is `branch` or `pull_request`, and one analysis message is capped at 1000 unique metric entries. Earlier provider groups have priority when capacity is exhausted. Missing NCLOC is `NOT_SET`. |
| Purge of stale pull-request branches | project | `project_pr_qg_failed_count`, `project_pr_qg_passed_count`, and, for qualifying agentic-gate projects with failures, `agentic_qg_pr_merge_failed_count`. Metrics are cleared before the enabled check/send, so disabled telemetry does not retain them for later. |

[Provenance: `server/sonar-webserver-core/src/main/java/org/sonar/server/platform/db/migration/DatabaseMigrationTelemetry.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/telemetry/DevOpsConfigurationTelemetry.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/issue/index/AsyncIssueIndexCreationTelemetry.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/SendAnalysisTelemetryStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/purge/TelemetryQGOnMergedPRDataLoader.java`; `TelemetryQGOnMergedPRProvider.java`]

The unified cross-domain event `Analytics.Server.Started`, schema version `1.0`, carries `serverId` and `version` with source `Server`/`ServerStartupEventPublisher`. It is an event-pipeline observation rather than a metric-envelope POST in the inspected Community source. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/telemetry/ServerStartupEventPublisher.java`; `platform/events-notifications/specification.md`]

## 8. Operational Prometheus metrics

### 8.1 Endpoint and authorization

`GET api/monitoring/metrics` returns all samples from the default Prometheus collector registry. It supports default `text/plain` and negotiated `application/openmetrics-text`. The endpoint returns UTF-8 status 200 only after authorization by one of: valid `X-Sonar-Passcode` system passcode, system-administrator session in normal mode, or a valid bearer passcode. In safe mode there is no authenticated user session, so system or bearer passcode is required. The act of registering the action sets `sonarqube_health_web_status` to 1. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/monitoring/MetricsAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/SafeModeMonitoringMetricAction.java`; `MonitoringWs.java`]

### 8.2 Metric-family catalog

The Community runtime registers these SonarQube-owned families:

| Family | Kind and labels | Observation |
|---|---|---|
| `sonarqube_health_web_status` | gauge | 1 when the monitoring action is registered in the live Web process. |
| `sonarqube_health_compute_engine_status` | gauge | 1 when CE is operational, otherwise 0. |
| `sonarqube_health_elasticsearch_status` | gauge | 1 when search health is green/yellow and disk safety checks pass; 0 for red/unavailable, read-only index, critically low free space, or check failure. |
| `sonarqube_health_integration_github_status` | gauge | 1 only when configured GitHub integrations validate; no configuration or failure produces 0. |
| `sonarqube_health_integration_gitlab_status` | gauge | Same classification for GitLab. |
| `sonarqube_health_integration_bitbucket_status` | gauge | Same classification for Bitbucket Cloud/Server. |
| `sonarqube_health_integration_azuredevops_status` | gauge | Same classification for Azure DevOps. |
| `sonarqube_compute_engine_pending_tasks_total` | gauge | Current shared count of `PENDING` CE queue rows. |
| `sonarqube_compute_engine_tasks_running_duration_seconds` | summary; labels `task_type`, `project_key` | Observes successful entity-associated CE task durations selected since the previous collector timestamp. The pinned collector passes stored `executionTimeMs` without unit conversion despite the `_seconds` family name. |
| `sonarqube_compute_engine_system_tasks_running_duration_seconds` | summary; label `task_type` | Same observed unconverted stored duration for successful system tasks without entity UUID. |
| `sonarqube_elasticsearch_disk_space_free_bytes` | gauge; label `node_name` | Available bytes for each returned search node. |
| `sonarqube_elasticsearch_disk_space_total_bytes` | gauge; label `node_name` | Total bytes for each returned search node. |
| `sonarqube_elasticsearch_read_only_indices_total` | gauge | Count of indices with `index.blocks.read_only_allow_delete=true`. |
| `sonarqube_elasticsearch_disk_usage_percent` | gauge | Maximum used-space percentage among returned search nodes. |
| `sonarqube_web_uptime_minutes` | gauge | JVM runtime uptime truncated to whole minutes. |
| `sonarqube_number_of_connected_sonarlint_clients` | gauge | Current in-memory registered IDE SSE connections in this Web process. |
| `sonarqube_db_query_duration_seconds` | histogram; label `mapper_method` | MyBatis query/update duration when performance monitoring is enabled. Buckets: 0.01, 0.1, 0.5, 1, 5, and 10 seconds. Mapper label retains the final class-and-method portion. |
| `sonarqube_web_api_v1_request_duration_seconds` | histogram; label `endpoint` | Legacy action duration when performance monitoring is enabled. Buckets: 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, and 10 seconds. |
| `sonarqube_web_api_v2_request_duration_seconds` | histogram; labels `endpoint`, `http_method` | V2 request duration when performance monitoring is enabled; unmatched patterns use `unknown`. Same buckets as V1. |
| `sonarqube_license_days_before_expiration_total` | gauge | Registered license-oriented family. No Community update source is present in the inspected registration, so no nonzero Community behavior is claimed. |
| `sonarqube_license_number_of_lines_remaining_total` | gauge | Registered license-oriented family; no Community update behavior is inferred. |
| `sonarqube_license_number_of_lines_analyzed_total` | gauge | Registered license-oriented family; no Community update behavior is inferred. |

Prometheus client libraries may expose suffixed samples such as histogram buckets/count/sum and summary count/sum. The family names, labels, bucket boundaries, and observed update inputs above are the owned compatibility contract. [Provenance: `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ServerMonitoringMetrics.java`; task and interceptor sources below]

### 8.3 Collection scheduling and state

All periodic monitoring tasks share one daemon, single-thread scheduled executor. Each task uses fixed delay. An exception from a task is caught, logged as a warning, and does not cancel that task’s future invocations or other tasks. Because the executor is shared and single-threaded, a slow task delays other due tasks. Stop calls orderly shutdown without awaiting completion. [Provenance: `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/MainCollector.java`]

Observed task configuration and defaults are:

| Tasks | Initial-delay key/default | Period key/default |
|---|---|---|
| CE operational status and connected SonarLint clients | `sonar.server.monitoring.other.initial.delay` / 10,000 ms | `sonar.server.monitoring.other.period` / 10,000 ms |
| Pending CE tasks and recent successful CE durations | `sonar.server.monitoring.ce.initial.delay` / 10,000 ms | `sonar.server.monitoring.ce.period` / 30,000 ms |
| GitHub, GitLab, Bitbucket, and Azure health | `sonar.server.monitoring.devops.initial.delay` / 10,000 ms | `sonar.server.monitoring.devops.period` / 300,000 ms |
| Elasticsearch health and disk | `sonar.server.monitoring.es.initial.delay` / 10,000 ms | `sonar.server.monitoring.es.period` / 10,000 ms |
| Web uptime | `sonar.server.monitoring.webuptime.initial.delay` / 10,000 ms | `sonar.server.monitoring.webuptime.period` / 5,000 ms |

[Provenance: `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ComputeEngineMetricStatusTask.java`; `SonarLintConnectedClientsTask.java`; `ce/ComputeEngineMetricsTask.java`; `devops/DevOpsMetricsTask.java`; `ElasticSearchMetricTask.java`; `WebUptimeTask.java`]

The Elasticsearch metric task reads node statistics, cluster status, index settings, and disk capacity. `sonar.server.monitoring.es.disk.threshold.percent` has observed default 15.0 percent free. Any read-only index or minimum free-space percentage across nodes below that threshold forces the health gauge to 0. Otherwise green and yellow cluster status map to 1 and red/null map to 0. Search-query exceptions set status to 0; node-stat failure can leave per-node disk gauges at their prior values. Read-only-index and disk-percentage subcheck failures log errors and return neutral zero values so cluster health remains the fallback. [Provenance: `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ElasticSearchMetricTask.java`]

Recent CE durations use an in-memory timestamp initialized to collector construction time. Each successful run advances it to current time after querying. Per-task missing duration or entity key is logged and skipped without aborting the remaining tasks. Pending count reads a fresh database count. No durable monitoring cursor is owned beyond underlying CE activity rows. [Provenance: `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ce/RecentTasksDurationTask.java`; `ce/NumberOfTasksInQueueTask.java`]

V1 request duration is recorded in post-action only when pre-action stored a start time. V2 duration is recorded after completion, including completion with an exception. MyBatis duration is recorded in a `finally` path, including failed queries. Disabling performance monitoring prevents timing and label allocation at these hooks. [Provenance: `WebApiV1MetricsInterceptor.java`; `WebApiV2MetricsInterceptor.java`; `MyBatisMetricsInterceptor.java`]

## 9. Health model and APIs

### 9.1 Health states and reduction

Health is one of `GREEN`, `YELLOW`, or `RED`, with a set of nonblank cause strings. `GREEN` means fully working; `YELLOW` means usable but requiring attention; `RED` means not operational. Multiple checks reduce to the worst status in that order and the union of all causes. With no checks, the identity result is green. [Provenance: `server/sonar-webserver-api/src/main/java/org/sonar/server/health/Health.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/health/HealthReducer.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/health/HealthCheckerImpl.java`]

Community standalone node health consists of:

- Web status: green only when platform is up, database migration state is none or succeeded, and no restart is in progress; otherwise red with `SonarQube webserver is not up`.
- Database connection: green only when a read-only session’s liveness query returns the expected value; runtime failure is caught and becomes red with `Can't connect to DB`.
- Compute Engine status: green only when CE reports operational; otherwise red with `Compute Engine is not operational`.
- Search status: green/yellow/red follows Elasticsearch cluster status; unavailable or null status is red. Yellow and red causes identify the Elasticsearch status.

Safe mode substitutes an always-red Web check, retains database and standalone search checks, and omits the CE check. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/HealthCheckerModule.java`; `SafeModeHealthCheckerModule.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/health/WebServerStatusNodeCheck.java`; `WebServerSafemodeNodeCheck.java`; `DbConnectionNodeCheck.java`; `CeStatusNodeCheck.java`; `EsStatusCheck.java`; `EsStatusNodeCheck.java`]

The source also contains cluster aggregation checks for application-node count, application-node states, search-node count, and search cluster status. Community Build does not expose a cluster deployment entitlement, so this specification records their response compatibility without inferring commercial availability: no application node is red; exactly one is yellow; all-red nodes are red; mixed red/yellow/green is reduced to yellow unless no usable node remains; fewer than three search nodes is yellow; and Elasticsearch status is merged with that recommendation. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/health/AppNodeClusterCheck.java`; `EsStatusClusterCheck.java`]

### 9.2 Health endpoints

`GET api/system/health` requires system-administrator permission or a valid system passcode. In safe mode only the passcode path is available. Standalone output contains `health` and zero or more `causes.message` values. A cluster-capable runtime additionally returns sorted application-node details with health, causes, type, name, host, port, and start time. IPv6 host strings are bracketed. Health is serialized as JSON or protobuf according to the shared Web API negotiation contract. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/HealthAction.java`; `HealthActionSupport.java`; `SafeModeHealthAction.java`; `sonar-ws/src/main/protobuf/ws-system.proto`]

`GET /api/v2/system/health` also requires either `X-Sonar-Passcode` or a system-administrator session. It returns the Health object directly with status and causes in standalone or safe mode. If invoked in a non-standalone runtime, it returns HTTP 501 because this pinned V2 controller does not implement cluster output. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/WebApiEndpoints.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/system/controller/HealthController.java`]

Health APIs are synchronous snapshots. They do not persist transitions, retry failed checks, or mutate feature state. A red health response is operational evidence, not a notification and not an automatic shutdown command.

## 10. System information and uptime

`GET api/system/info` requires system-administrator permission. It writes current health first, as public fields `Health` and `Health Causes`, then ordered system-information sections. In Community standalone mode the registered local sections are `System`, `Database`, `Bundled`, `Plugins`, `Web JVM State`, `Web Database Connection`, `Web Logging`, `Web JVM Properties`, `Search State`, `Search Indexes`, `ALMs`, `Server Push Connections`, and `Settings`; the writer also appends Compute Engine sections when the internal CE system-info call returns them. Absence of CE information omits those sections rather than suppressing local information. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/InfoAction.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/platform/SystemInfoWriterModule.java`; `StandaloneSystemInfoWriter.java`; `AbstractSystemInfoWriter.java`]

The `System` section exposes server ID, version, edition label, line count, container state, external provisioning/authentication descriptions, enabled identity providers, high-availability flag fixed false in standalone, official-distribution check, force-authentication state, home/data/temp paths, and processor count. Database information includes product, version, user, JDBC URL/driver, and default isolation. Bundled and plugin sections map plugin keys to versions/descriptions. Runtime sections expose JVM memory/thread/load and properties, connection-pool state, log level/path, CE queue statistics, search resource/index state, ALM configuration summaries, and connected SonarLint client count. [Provenance: `server/sonar-webserver-core/src/main/java/org/sonar/server/platform/monitoring/StandaloneSystemSection.java`; section implementations under the same package; CE `systeminfo` sources]

`Settings` contains sorted effective settings and the default new-code definition. Values defined as password type, keys ending `.secured`, keys containing `password` or `passcode`, and the authentication JWT secret are replaced by `xxxxxxxx`. Other effective settings, JVM properties, paths, provider summaries, project keys in metric labels, and runtime data can still be sensitive; administrator authorization is therefore mandatory. [Provenance: `server/sonar-webserver-core/src/main/java/org/sonar/server/platform/monitoring/SettingsSection.java`]

The Prometheus uptime gauge is JVM uptime divided by 60,000 and truncated to whole minutes, refreshed with the cadence in section 8.3. It resets on Web JVM restart. System-info health and uptime are observations; neither implies a user-visible delivery.

## 11. Concurrency, recovery, and security boundaries

The telemetry daemon serializes its own scheduled work and uses a database-backed global lease to avoid simultaneous scheduled uploads across processes. Modern ad hoc counters use concurrent maps and atomic values; their post-send clearing can race with increments, so values arriving at the clear boundary may belong to either reporting interval. Direct asynchronous messages use independent daemon threads and do not share the scheduled lock or daily gate after their enabled check. [Provenance: `TelemetryDaemon.java`; `AbstractMultiValueCounterDataProvider.java`; Web API telemetry providers; `TelemetryClient.java`]

Monitoring periodic tasks are serialized within one Web process but are not guarded by the telemetry lock. Provider integration validations perform external calls and map exceptions to a red gauge without exposing credentials. The metrics endpoint, health endpoints, and system-info endpoint must retain their distinct authorization rules. System passcodes and bearer passcodes are credentials and must not be emitted as labels or settings values. [Provenance: `MainCollector.java`; integration metric tasks; monitoring and health actions; `SettingsSection.java`]

Telemetry contains stable installation IDs, project UUIDs, hashed user UUIDs in most user observations, infrastructure versions, configuration categories, and usage counts. Transport must therefore use the configured HTTPS defaults unless an operator deliberately overrides them. Endpoint overrides cross an administrator-controlled trust boundary. No upload response body or status is used to change product feature state.

Failure recovery is deliberately observational:

- daemon exceptions are debug-logged and retried only by the next ordinary check;
- monitoring-task exceptions are warning-logged and isolated to that invocation;
- health check failures become health status where the check catches them, while an uncaught check failure fails the health request;
- system-info CE absence yields partial local output;
- Prometheus samples retain their last value when a failed collector path does not explicitly overwrite them; and
- no failure in telemetry is permitted to fail server startup through the startup publisher path.

[Provenance: cited daemon, collector, health, system-info, and startup-event sources]

## 12. Compatibility and limits

An independent implementation must preserve:

- configuration keys and observed defaults stated here;
- one-time opt-out-marker behavior;
- three-hour default check cadence combined with the elapsed-24-hour upload gate;
- lock name `TelemetryStat`, internal properties `telemetry.optOut`, `telemetry.lastPing`, and `telemetry.messageSeq`, and sequence-update ordering;
- modern envelope and metric field names, dimensions, granularities, and registered metric keys;
- the legacy field names and omission rules;
- HTTP methods, endpoints, compression header behavior, and lack of status-code validation;
- Prometheus family names, labels, bucket boundaries, and the pinned CE-duration unit mismatch;
- health status precedence, cause preservation, API authentication, and V2 cluster 501 behavior; and
- administrator-only system-information output with mandatory secret redaction.

The scheduled modern message batch size defaults to 10,000 metrics per dimension message. Analysis ad hoc messages are separately capped at 1,000 unique metrics. User enumeration pages at 1,000. Polling, transport, database, and Prometheus library limits not stated in inspected source are dependency behavior and must not be invented. [Provenance: `TelemetryMetricsLoader.java`; `SendAnalysisTelemetryStep.java`; `TelemetryUserEnabledProvider.java`]

## 13. Acceptance scenarios

1. **First disable.** Given telemetry defaults were overridden to disabled and no `telemetry.optOut` exists, startup sends one DELETE containing only installation `id`, stores the opt-out time, starts no upload scheduler, and does not treat the DELETE result as user-visible delivery.
2. **Repeated disable.** Given the opt-out marker exists, a later disabled startup sends no second DELETE.
3. **Re-enable.** Given telemetry is enabled and the marker exists, startup removes it and schedules the first check after the configured frequency.
4. **Daily gate.** Given default frequency and a last ping 20 hours old, a check acquires the lock but sends nothing. Once the last ping is at least 24 hours old, including exactly 86,400,000 milliseconds, the next check runs the complete sequence.
5. **Lock contention.** Given another process holds `TelemetryStat`, a check sends nothing and changes neither last ping nor sequence.
6. **Sequence.** Given stored sequence 10, a successful legacy payload carries 11 and final stored sequence is 11. A failure before final property update leaves 10.
7. **Partial upload failure.** Given legacy POST succeeds and a later metric POST raises I/O failure, provider sent-state and `lastPing` are not advanced; a later check can repeat data. No exponential retry is scheduled.
8. **HTTP error response.** Given the telemetry endpoint returns an HTTP error response without transport failure, the pinned client closes it and treats the call as completed; status does not drive retry.
9. **Provider cadence.** Given a weekly provider has a sent timestamp in the same whole-week interval, it is omitted while an ad hoc provider remains eligible at the next daily upload.
10. **Batch validation.** Given `sonar.telemetry.metricsBatchSize` is zero, modern metric loading fails that invocation, the daemon logs at debug level, and later checks remain scheduled.
11. **Analysis limit.** Given more than 1,000 candidate analysis metrics, at most 1,000 unique entries are sent, with analyzed NCLOC and earlier provider groups taking collection priority.
12. **Metrics authorization.** Given no system passcode, bearer passcode, or normal-mode system-administrator session, `api/monitoring/metrics` is forbidden.
13. **Performance gate.** Given `sonar.performanceMonitoring.enabled=false`, API and MyBatis timing histograms receive no new observation while uptime and periodic health gauges continue to update.
14. **Collector failure isolation.** Given one periodic monitoring task throws, it is logged and the single-thread scheduler continues later invocations and other registered tasks.
15. **Search disk health.** Given a read-only search index or free disk below the observed 15-percent threshold, the Prometheus Elasticsearch health gauge is 0 even if cluster color is yellow or green.
16. **Standalone health reduction.** Given DB is green, Web is green, CE is red, and search is yellow, `api/system/health` is red and includes both CE and search causes.
17. **Safe mode.** Given the server is in safe mode, health is red because Web is not up, the CE check is absent, and only a valid system passcode can access the legacy endpoint.
18. **V2 cluster limit.** Given a non-standalone runtime reaches `/api/v2/system/health` with valid authorization, it receives HTTP 501 rather than a fabricated cluster response.
19. **System-info redaction.** Given an effective `.secured`, password, passcode, or JWT-secret setting, `api/system/info` emits `xxxxxxxx` for its value.
20. **Observability separation.** Given `sonarqube_number_of_connected_sonarlint_clients` is nonzero or a telemetry message POST completes, no email/webhook/IDE acknowledgement state is created; user-visible delivery remains governed by `platform/events-notifications/`.

## 14. Provenance index

- Baseline and license: `manifest/release-baseline.md`, `manifest/license-map.md`, root `LICENSE.txt`.
- Telemetry defaults: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`.
- Scheduled lifecycle and transport: `server/sonar-telemetry/src/main/java/org/sonar/telemetry/TelemetryDaemon.java`; `server/sonar-telemetry-core/src/main/java/org/sonar/telemetry/core/TelemetryClient.java`.
- Legacy schema and collection: `server/sonar-telemetry/src/main/java/org/sonar/telemetry/legacy/`.
- Modern schema, cadence, and provider mapping: `server/sonar-telemetry-core/src/main/java/org/sonar/telemetry/core/`; `server/sonar-telemetry/src/main/java/org/sonar/telemetry/metrics/`; `server/sonar-db-dao/src/main/java/org/sonar/db/telemetry/`.
- Registered provider catalog: `server/sonar-webserver/src/main/java/org/sonar/server/platform/platformlevel/PlatformLevel4.java`; provider paths cited in section 7.
- Direct metrics: migration, DevOps, issue-index, analysis-step, and pull-request-purge paths cited in section 7.2.
- Prometheus registry and scheduling: `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/`; API interceptors in `sonar-webserver-core` and `sonar-webserver-webapi-v2`.
- Monitoring API: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/monitoring/`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/SafeModeMonitoringMetricAction.java`.
- Health: `server/sonar-webserver-api/src/main/java/org/sonar/server/health/`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/health/`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/health/`; legacy and V2 health controllers.
- System information: `server/sonar-webserver-core/src/main/java/org/sonar/server/platform/`; `server/sonar-webserver-core/src/main/java/org/sonar/server/platform/monitoring/`; `server/sonar-process/src/main/java/org/sonar/process/systeminfo/`.
