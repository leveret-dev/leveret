# Compute Engine Specification

## 1. Identity and provenance

This specification describes the Compute Engine (CE) bundled with SonarQube Community Build `26.8.0.126808`, released on 2026-08-05 from Git tag `26.8.0.126808` and commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The authoritative production trees are `server/sonar-ce`, `server/sonar-ce-common`, `server/sonar-ce-task`, `server/sonar-ce-task-projectanalysis`, and the shared duplication engine in `sonar-duplications`. Release identity is established by `gradle.properties`, root `build.gradle`, and `sonar-application/bundled_plugins.gradle` at that commit.

The pinned SonarQube production source is licensed under `LGPL-3.0-or-later`; evidence is root `LICENSE.txt` and the license headers in the cited production files. This is a clean-room behavioral specification, not permission or legal advice.

## 2. Purpose, ownership, and exclusions

CE owns the durable compute-task queue, worker dispatch, ordered processing of uploaded analysis reports, publication of a task result, and orchestration of analysis computation. It converts the scanner-gateway report into persisted and indexed results, but does not redefine contracts owned elsewhere.

The following boundaries are mandatory:

- `platform/scanner-gateway/` owns report upload, chunk transport, scanner bootstrap, protobuf/report wire format, and upload acknowledgement. CE consumes an already stored task and its numbered report parts.
- `platform/persistence/` owns relational schemas, transaction primitives, and migrations. This specification defines how CE uses those durable aggregates and commits state transitions.
- `platform/project-configuration/` owns project, component, quality-profile, active-rule, metric, quality-gate, setting, and new-code identifiers and precedence. CE consumes the resolved effective values and performs the calculation described here.
- `platform/analysis-results/` owns issue, hotspot, measure, source, duplication, and history state vocabularies exposed to users. CE owns ingestion, matching, calculation, and persistence ordering, not subsequent user transitions.
- `platform/search-indexing/` owns index mappings, documents, permission filtering, synchronization, and recovery. CE invokes its analysis indexers only after relational results become current.
- `platform/events-notifications/` owns event, webhook, notification, and push delivery envelopes and retry state. CE decides when the analysis is ready for those publishers.
- `platform/http-api/` owns generic HTTP routing, validation, authorization-error serialization, pagination, and media types. This specification names CE-specific paths and fields only to preserve its task contract.
- Plugin loading and post-analysis extension lifecycle belong to `platform/plugin-extension-runtime/`.

Community Build scope is project main-branch analysis only. Non-main branches, pull requests, pull-request concurrency, file-move continuity, `pull_request_fixed_issues`, portfolio/view refresh, commercial task types, and private `com.sonarsource.*` extensions are explicitly excluded even where shared source contains dormant hooks or schema fields. The internal implementation of Elasticsearch, the JDBC database, and scanner report encoding is also excluded.

Evidence: `manifest/dependency-map.md`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/taskprocessor/ReportTaskProcessor.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/IndexAnalysisStep.java`.

## 3. External task contract

### 3.1 Task identity and accepted inputs

A queue submission has a CE-generated task UUID, a task type of at most 40 characters, optional component UUID and entity UUID, optional submitter UUID, a report-part count, and string characteristics. Component and entity UUIDs are either both absent or both present. UUID columns accept at most 40 characters; submitter UUID accepts at most 255 characters. The Community analysis task type is `REPORT`, targeting the project’s main analysis component. CE itself is task-type-neutral.

A `REPORT` task requires every numbered report part from `1` through the declared part count. CE concatenates parts in ascending numeric order, expands the resulting archive into a task-local temporary directory, rejects a missing part, rejects extraction errors, and limits uncompressed report content to 4,000,000,000 bytes. The temporary concatenated archive is deleted after extraction is attempted. Report transport and encoding remain scanner-gateway contracts.

Evidence: `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeQueueDto.java`; `server/sonar-ce-common/src/main/java/org/sonar/ce/queue/CeQueueImpl.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/ExtractReportStep.java`.

### 3.2 Observable states and fields

Live queue states are exactly `PENDING` and `IN_PROGRESS`. Terminal activity states are exactly `SUCCESS`, `FAILED`, and `CANCELED`. A terminal transition removes the live queue row and report input, then writes a past-activity row. The past activity retains task UUID and type, component/entity, submitter and worker, node name, submission/start/end times, execution duration, optional analysis UUID, optional error type/message/stack trace, scanner-context availability, and task messages.

Error messages are stripped of NUL characters and truncated to 1,000 characters. Error type is truncated to 20 characters, and node name to 100 characters. Stack traces have NUL characters removed. An error object is legal only with terminal state `FAILED`. `TIMEOUT` is the error type for a configured CE timeout.

Task responses under controller `api/ce` expose, when available, fields `id`, `type`, `status`, `componentId`, `componentKey`, `componentName`, `componentQualifier`, `analysisId`, `submitterLogin`, `submittedAt`, `startedAt`, `executedAt`, `executionTimeMs`, `nodeName`, `errorMessage`, `errorStacktrace`, `errorType`, `hasScannerContext`, `scannerContext`, `warningCount`, `warnings`, and `infoMessages`. A live task reports execution time as current time minus start time. A completed task reports its persisted duration.

CE-specific operations are:

- `GET api/ce/task`: one queue or activity task by task UUID, with optional additional fields.
- `GET api/ce/activity`: filtered activity and queue search. Status filter admits all five states; the default status set contains terminal activity states. Filters include component, text, type, submission lower bound, execution upper bound, and “only current”; default page size is 100.
- `GET api/ce/component`: pending, in-progress, and most recent completed task for one component.
- `POST api/ce/cancel`: cancel one pending task. An in-progress task is not cancellable through this operation.
- `POST api/ce/cancel_all`: internal operation that cancels pending tasks but leaves in-progress work running.
- `POST api/ce/pause` and `POST api/ce/resume`: internal, administrator/passcode operations controlling queue acquisition on all CE nodes.
- `GET api/ce/info`: internal worker and pause information.
- `GET api/ce/worker_count`: configured worker count.
- `GET api/ce/activity_status`: queue/activity counters for the permitted scope.
- `GET api/ce/analysis_status`: internal lookup for one required project key. It requires `Browse` on the project and returns project key/name plus warnings from the latest main-project `REPORT` activity. Each warning contains key, message, and dismissible flag; authenticated users do not receive warnings they previously dismissed.
- `POST api/ce/dismiss_analysis_warning`: internal, idempotent dismissal with required project key and warning-message key. It requires an authenticated user with `Browse`; the warning must exist and be dismissible. The durable dismissal applies to that user, project, and warning type and returns no content.
- `GET api/ce/task_types`: internal discovery route returning the distinct union of task types handled by registered CE processors. The action has no additional action-level permission check.
- `GET api/analysis_reports/is_queue_empty`: internal compatibility route with no parameters. It returns plain text `true` only when `ce_queue` has no rows. A database read failure is logged and conservatively returns `false`; the action has no additional action-level permission check.

`api/ce/submit` is deliberately not specified here because scanner-gateway owns report upload. `api/ce/indexation_status` consumes search synchronization state and is specified by search-indexing. Generic permissions and HTTP error behavior remain in their owning specifications.

Evidence: `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeActivityDto.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/CeWs.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/CeWsModule.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/TaskFormatter.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/AnalysisStatusAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/DismissAnalysisWarningAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/TaskTypesAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/IsQueueEmptyWs.java`; `server/sonar-webserver-webapi/src/it/java/org/sonar/server/ce/ws/AnalysisStatusActionIT.java`; `server/sonar-webserver-webapi/src/it/java/org/sonar/server/ce/ws/DismissAnalysisWarningActionIT.java`; `server/sonar-webserver-webapi/src/test/java/org/sonar/server/ce/ws/TaskTypesActionTest.java`.

## 4. Durable queue and worker state machine

### 4.1 Submission and uniqueness

Submission creates characteristics and a `PENDING` queue row in one caller-controlled or CE-owned database transaction. A caller may request `UNIQUE_QUEUE_PER_ENTITY`; CE declines submission if a pending task for that entity already exists. A caller may request `UNIQUE_QUEUE_PER_TASK_TYPE`; CE declines submission if a queued task of that type exists. A declined submission produces no task. Batch submission applies entity uniqueness efficiently and preserves only eligible submissions.

Within the task class selected by the current alternating worker poll, eligible rows are ordered by `created_at` ascending and task UUID ascending. This is not global FIFO across ordinary report work and `ISSUE_SYNC`: each poll prefers one class, alternates that preference on the next poll, applies entity eligibility, and falls back to the other class only when the preferred class has no candidate. Claiming uses a conditional update from `PENDING` to `IN_PROGRESS`, sets worker UUID and start/update timestamps, and succeeds for only one claimant. A concurrent loser retries through later polling rather than processing the same task.

Evidence: `server/sonar-ce-common/src/main/java/org/sonar/ce/queue/CeQueue.java`; `server/sonar-ce-common/src/main/java/org/sonar/ce/queue/CeQueueImpl.java`; `server/sonar-db-dao/src/main/resources/org/sonar/db/ce/CeQueueMapper.xml`; `server/sonar-ce-common/src/it/java/org/sonar/ce/queue/CeQueueImplIT.java`.

### 4.2 Main-project serialization and worker count

CE does not claim a pending task while another task for the same project entity is non-pending. Community `REPORT` tasks therefore execute serially per project while unrelated projects may run concurrently. Workers alternate their first-choice poll between ordinary report work and issue-index synchronization work so neither class permanently starves.


Pinned Community Build has one worker when no `WorkerCountProvider` extension is present. The built-in poll delay is 2 seconds. A provider, if installed through the extension runtime, must return an integer from 1 through 10; out-of-range values fail configuration. This does not imply any commercial provider behavior.

Evidence: `server/sonar-ce/src/main/java/org/sonar/ce/queue/NextPendingTaskPicker.java`; `server/sonar-ce/src/main/java/org/sonar/ce/configuration/CeConfigurationImpl.java`; `server/sonar-ce/src/it/java/org/sonar/ce/queue/NextPendingTaskPickerIT.java`.

### 4.3 Pause, execution, and completion

Pause is a durable cluster-wide flag. Once requested, no worker may claim another task. Running work is not interrupted. Pause status is `PAUSING` while any task remains in progress, `PAUSED` when the flag is set and no task is in progress, and `RESUMED` when the flag is absent. Resume removes the flag.

A worker that is disabled returns without claiming. An enabled worker claims one task, calls start listeners, resolves a processor by task type, runs it, finalizes the queue row, and then calls end listeners. Listener failures are logged and isolated from task processing. Missing processor yields `FAILED`. Normal return yields `SUCCESS`. A message exception or ordinary throwable yields `FAILED` and persists the error. A cancellation interruption yields `CANCELED` without an error object. A timeout interruption yields `FAILED` with error type `TIMEOUT`.

Exact property `sonar.ce.task.timeoutSeconds` is optional. When absent, CE has no built-in task-duration timeout. When present, it must be a long integer at least 1; CE compares task elapsed time at computation-step interruption points. Invalid values fail startup/configuration rather than being silently corrected.

Finalization writes the terminal activity and deletes queue input before notifying end listeners. A failure to finalize is logged; the task may remain in live storage for cleanup, and no success claim may be fabricated.

Evidence: `server/sonar-ce/src/main/java/org/sonar/ce/queue/InternalCeQueueImpl.java`; `server/sonar-ce/src/main/java/org/sonar/ce/taskprocessor/CeWorkerImpl.java`; `server/sonar-ce/src/main/java/org/sonar/ce/taskprocessor/CeTaskInterrupterProvider.java`; `server/sonar-ce-task/src/main/java/org/sonar/ce/task/CeTaskTimeoutException.java`; `server/sonar-ce/src/it/java/org/sonar/ce/taskprocessor/CeWorkerImplIT.java`.

### 4.4 Startup recovery, cleanup, and retention

CE starts worker scheduling only after worker UUIDs are broadcast and queue cleanup scheduling is installed. One cluster-wide cleanup lock prevents multiple nodes from cleaning simultaneously. Every 2 minutes, starting with zero delay, the lock holder resets `IN_PROGRESS` rows whose worker UUID is absent from the known worker set to `PENDING`, then cancels pending rows that already have a start timestamp as worn-out work. Cleanup errors are logged and retried on the next cycle. A worker also resets any stale non-pending task bearing its own UUID before claiming more work.

`cancelAll` skips in-progress tasks and is safe while workers run. `clear` includes in-progress rows but must be invoked only when workers cannot be running. Both archive removed rows as `CANCELED`.

Completed CE activities are purged daily at 23:00 UTC when the cluster cleanup lock is acquired. Activity retention is 180 days. Scanner context retention is 28 days. A purge failure leaves data intact for the next daily attempt.

Evidence: `server/sonar-ce/src/main/java/org/sonar/ce/queue/CeQueueInitializer.java`; `server/sonar-ce/src/main/java/org/sonar/ce/cleaning/CeCleaningSchedulerImpl.java`; `server/sonar-db-dao/src/main/resources/org/sonar/db/ce/CeQueueMapper.xml`; `server/sonar-ce/src/main/java/org/sonar/ce/cleaning/CeActivitiesPurgeSchedulerImpl.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/purge/PurgeDao.java`.

## 5. Ordered report-processing contract

CE executes the ordered main-project path from the shared fixed step list. Before every active Community step it checks task interruption/timeout. If a step throws, later steps do not execute. Each step records success or failure timing. Post-analysis extensions are invoked after the executor exits and receive overall `SUCCESS` only when every active ordered step completed; extension failures are logged and do not replace the primary result.

The required order is:

1. Reassemble and extract report parts; persist scanner context and analysis warnings; generate analysis UUID.
2. Load report metadata; initialize stateless analysis extensions; build component tree; validate project and chronological analysis date; load quality profiles.
3. Run pre-measure checks and record server-upgrade detection events.
4. Load file hashes/status, effective quality gate, main-project new-code periods, and prioritized rules.
5. Load in-report duplications and, when the main-project report enables it, integrate cross-project duplication candidates from the database.
6. Run the dependency/SCA extension point. Absence of an optional provider is a no-op; this specification makes no commercial capability claim.
7. Compute size, new coverage, overall coverage, comment/documentation, duplication, new-size/duplication, language distribution, unit-test, and complexity measures, in that order.
8. Load plugin measure computers; register quality-profile status; execute issue integration, ratings, SCM last-commit, and plugin measure visitors. Run post-measure checks.
9. Compute quality-gate results, aggregated quality-profile measure, quality-profile events, quality-gate events, issue-detection events, and unanalyzed-language handling.
10. Persist scanner analysis cache, components, the unprocessed main-project analysis snapshot, analysis properties, project measures, component measures, ad-hoc rules, issues, issue-change cleanup, project links, events, file sources, and cross-project duplication index.
11. Atomically switch the new main-project analysis to processed/current and apply staged component changes. Then persist optional dependency results and history.
12. Update quality-profile last-used dates; purge obsolete project data; load changed issues; invoke analysis indexers; update issue-sync need; compute project NCLOC bookkeeping; persist push events.
13. Send issue notifications only after indexes and database state are current.
14. Run stateless finish extensions; publish the analysis UUID into task result; send analysis/step telemetry last.

The authoritative shared order is `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/ReportComputationSteps.java`. Steps outside the Community boundary in section 2 are omitted from the active path above and create no compatibility requirement here. Execution and stop-on-first-failure semantics are in `server/sonar-ce-task/src/main/java/org/sonar/ce/task/step/ComputationStepExecutor.java`. Task-scoped container behavior is in `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/taskprocessor/ReportTaskProcessor.java`. Shared list order is locked by `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/step/ReportComputationStepsTest.java`.

## 6. Component and report validation

CE must reject processing when the task no longer resolves required project identity, when report project key differs from submission entity key, when project lookup fails, or when the effective project key contains disallowed characters. Main-project analysis date must be strictly later than the latest known analysis for that project; equal or older dates fail with chronological-order guidance.

The Community component tree is built from the report root and persistent main-project identity.

Evidence: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/LoadReportAnalysisMetadataHolderStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/BuildComponentTreeStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/ValidateProjectStep.java`.

## 7. Measure computation

### 7.1 Admission, precedence, and persistence

CE lazily reads scanner measures once per report component. Only metrics registered in `ScannerMetrics` are admitted; unknown metric keys are ignored and logged once per key. `ncloc` from test files is discarded. A CE-computed value has precedence over a later scanner value because report loading uses “do not override.” Exact metric registration and configuration precedence belong to project-configuration.

Empty measures are not persisted. Best-value-optimized measures are omitted when their implied best value is sufficient. `executable_lines_data` and `ncloc_data` are never persisted as ordinary component measures. File `duplications_data` is generated during persistence. Component measure documents are inserted or updated only when their computed content hash changed. Payload transactions are committed when accumulated JSON exceeds 50,000,000 characters and once at the end. Non-core string values above 100,000 characters produce a CE warning because of expected performance impact.

Evidence: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/measure/MeasureRepositoryImpl.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/metric/ReportMetricValidatorImpl.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/PersistMeasuresStep.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/measure/MeasureRepositoryImplTest.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/metric/ReportMetricValidatorImplTest.java`.

### 7.2 Complete CE aggregation families

Metric identifiers are owned by project-configuration; the following is the complete computation behavior CE applies to those registered keys in this pipeline.

- Size: `files` and `lines` count non-test files and their physical lines. `generated_lines`, `ncloc`, `generated_ncloc`, `functions`, `statements`, and `classes` sum child values. `complexity` and `cognitive_complexity` also sum child values. `ncloc_language_distribution` groups `ncloc` by file language, using an unknown-language bucket when absent.
- Comments and documentation: `comment_lines` sums child values. `comment_lines_density` is `100 × comment_lines / (ncloc + comment_lines)` when the denominator is positive. `public_api` and `public_undocumented_api` sum. `public_documented_api_density` is `100 × (public_api - public_undocumented_api) / public_api` when public API count is positive.
- Coverage: line reports produce `lines_to_cover`, `uncovered_lines`, `conditions_to_cover`, and `uncovered_conditions`; reported covered conditions are capped at reported total conditions. Counts sum through the tree. `line_coverage` is covered lines divided by lines to cover, `branch_coverage` is covered conditions divided by conditions to cover, and `coverage` combines both populations. Percentages are multiplied by 100 and omitted when their denominator is zero. `new_lines_to_cover`, `new_uncovered_lines`, `new_conditions_to_cover`, `new_uncovered_conditions`, `new_line_coverage`, `new_branch_coverage`, and `new_coverage` apply the same rules only to lines classified as new by the resolved new-code period.
- Tests: `tests`, `test_errors`, `test_failures`, `skipped_tests`, and `test_execution_time` sum available child values. `test_success_density` is `100 - 100 × (errors + failures) / tests`, only when tests are positive and error/failure counts are present and non-negative.
- Duplication: `duplicated_files`, `duplicated_blocks`, and `duplicated_lines` aggregate non-test files. Duplicated lines are distinct line numbers, so overlapping blocks do not double-count them. A file with at least one duplication increments duplicated-file count once. Original and same-file duplicate blocks count; cross-file counterparts do not create extra blocks in the origin file. `duplicated_lines_density` is capped at 100 and omitted when physical line count is zero. New-code keys `new_lines`, `new_duplicated_lines`, `new_duplicated_blocks`, and `new_duplicated_lines_density` count only changed lines intersecting duplication blocks; each intersecting block counts once and each changed duplicated line once.
- Issue totals: CE produces unresolved total, open/reopened/confirmed totals, false-positive, accepted, high-impact accepted, and sandbox totals; legacy severity totals `INFO` through `BLOCKER`; type totals for code smells, bugs, vulnerabilities, and security hotspots; impact-severity totals; and software-quality totals for maintainability, reliability, and security. New-code variants are emitted only when new-issue classification is enabled. Sandbox issues are counted only in sandbox metrics. Unresolved hotspots count as hotspots but do not enter ordinary unresolved severity totals. Accepted issues are excluded from unresolved totals; high-impact accepted means at least one `HIGH` or `BLOCKER` software-quality impact.
- Effort: unresolved non-sandbox issue effort is summed by legacy type into maintainability debt, reliability remediation effort, or security remediation effort; hotspots contribute no type effort. The same issue effort is independently added to every software quality present in its impact map. New-code effort uses the same rules for issues classified as new.
- Maintainability: development cost is non-comment line count multiplied by resolved development-cost setting. Debt ratio is remediation effort divided by development cost and expressed as a percentage. Maintainability rating uses the resolved debt-rating grid. Effort to reach rating A is the positive excess over the B lower-bound cost. Both legacy-type and software-quality maintainability families are produced; new-code equivalents use new-code cost and effort.
- Reliability and security: unresolved, non-sandbox bugs and vulnerabilities determine legacy ratings from their worst severity. Software-quality reliability/security ratings use the worst impact severity for that quality. New-code ratings use only issues classified as new.
- Security review: `security_hotspots_reviewed_status` and `security_hotspots_to_review_status` count reviewed and to-review hotspots. `security_hotspots_reviewed` is reviewed divided by total hotspots times 100 and is absent when there are no hotspots. `security_review_rating` is A when no percentage exists or percentage is at least 80, B at 70, C at 50, D at 30, and E below 30. New-code review metrics use the analogous new-hotspot population.
- Quality profiles and analysis metadata: CE aggregates `quality_profiles` and records last commit date and server-origin metadata where applicable.

Evidence: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/SizeMeasuresStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/CommentMeasuresStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/CoverageMeasuresStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/NewCoverageMeasuresStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/UnitTestMeasuresStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/issue/IssueCounter.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/issue/EffortAggregator.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/issue/NewEffortAggregator.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/qualitymodel/MaintainabilityMeasuresVisitor.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/qualitymodel/ReliabilityAndSecurityRatingMeasuresVisitor.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/qualitymodel/SecurityReviewMeasuresVisitor.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/formula/coverage/CoverageFormula.java`; tests under exact pinned directory `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/`.

## 8. Issue integration

CE admits internal report issues only when their rule is active in the resolved profile. Scanner-side common-rule issues are ignored because CE supplies those rules itself. Issue-level severity overrides profile severity; otherwise resolved active-rule severity applies. Impact precedence is rule default, then active-profile overrides for qualities already present, then issue-level overrides for qualities already present. Security hotspots carry no software-quality impact map. External issues use repository key `external_<engineId>:<ruleId>`, create or update an ad-hoc rule as needed, accept report type/severity or compatible stored/default impact fallbacks, default missing external effort to zero, and begin as `TO_REVIEW` for hotspots or `OPEN` otherwise.

Multi-location flows retain data/execution flow type, messages, formatting, ranges, and locations that resolve inside the main-project component tree. File-level exclusion patterns run before tracking. Multi-criteria exclusions win; inclusions restrict only rules matched by an inclusion rule pattern. Exact property naming and precedence belong to project-configuration.

For each main-project component, CE obtains raw issues and issues from the prior main-project analysis. Unchanged files may reuse prior issues without tracking unless an involved analyzer plugin changed after that analysis. Changed files are tracked using line hashes and location hashes, partitioning results into new, matched/merged, and closed issues. New issues receive initial lifecycle state and automatic transitions before ordered issue visitors. Existing matches merge persistent state; unmatched former issues are marked for automatic closure. Only new or changed records enter the persistence cache.

Issue persistence batches statements but commits one issue transaction at the end. Concurrent UI updates are protected by update-time comparison; conflicts reload the database issue and merge through the conflict resolver rather than overwriting newer user state.

Issue lifecycle names and user transition rules are owned by analysis-results. Analyzer rule detection remains analyzer-owned.

Evidence: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/issue/TrackerRawInputFactory.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/issue/filter/IssueFilter.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/issue/IntegrateIssuesVisitor.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/PersistIssuesStep.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/issue/TrackerRawInputFactoryTest.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/issue/filter/IssueFilterTest.java`.

## 9. Duplication integration

In-report duplication groups contain one origin block and zero or more same-file or other-file blocks. A nonzero other-file reference must not refer to the origin file. Cross-project processing runs only when the main-project report enables it. It matches scanner CPD block hashes against stored candidates of the same language, excluding the current base analysis, then integrates matching blocks through the bundled duplication engine. Empty CPD block streams are valid, including analyzer thresholds and CPD exclusions.

For each file with duplication data, persisted `duplications_data` contains ordered groups and blocks with start line, inclusive length, resource key, and link-disabled marker. Resource keys are XML escaped. Detailed result-state presentation belongs to analysis-results.

Evidence: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/LoadDuplicationsFromReportStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/LoadCrossProjectDuplicationsRepositoryStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/duplication/CrossProjectDuplicationStatusHolderImpl.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/duplication/DuplicationMeasures.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/duplication/ComputeDuplicationDataMeasure.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/step/LoadDuplicationsFromReportStepTest.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/duplication/DuplicationMeasuresTest.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/duplication/ComputeDuplicationDataMeasureTest.java`.

## 10. Quality-gate evaluation

CE loads the effective main-project gate chosen by project-configuration. Conditions support metric types `INT`, `MILLISEC`, `RATING`, `WORK_DUR`, `FLOAT`, `PERCENT`, and `LEVEL`, and operators `GREATER_THAN` and `LESS_THAN`. A no-value measure evaluates as OK for direct comparison, but a completely absent metric is not evaluated and receives condition status `NO_VALUE` in the post-analysis contract. Invalid threshold text or an unsupported type/operator fails the task.

When multiple conditions target one metric, CE evaluates each and keeps the worst result for that metric. It attaches that result and a human-readable label to the metric measure. Any error condition makes global result `ERROR`; otherwise it is `OK`. CE persists global `alert_status` and structured `quality_gate_details`, including evaluated conditions and whether small-change conditions were ignored, and exposes condition results to post-analysis extensions.

Resolved property `sonar.qualitygate.ignoreSmallChanges` defaults to true. When true, a failing condition is changed to OK for these small-change cases only:

- `new_coverage`, `new_line_coverage`, or `new_branch_coverage` when `new_lines_to_cover < 20`;
- `new_duplicated_lines_density`, `new_duplicated_lines`, or `new_duplicated_blocks` when `new_lines < 20`.

A missing size measure does not activate the exception. Setting the property false preserves the failure. Gate selection, condition definitions, and setting precedence remain project-configuration contracts.

Evidence: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/LoadQualityGateStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/QualityGateMeasuresStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/qualitygate/ConditionEvaluator.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/SmallChangesetQualityGateSpecialCase.java`; `server/sonar-server-common/src/main/java/org/sonar/server/qualitygate/QualityGateEvaluatorImpl.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/step/QualityGateMeasuresStepTest.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/step/SmallChangesetQualityGateSpecialCaseTest.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/qualitygate/ConditionEvaluatorTest.java`.

## 11. Publication, visibility, and partial results

The analysis snapshot is first persisted with unprocessed status and not-current flag. Only after components, measures, issues, events, file sources, and duplication data are persisted does CE switch the snapshot to processed/current and apply staged component changes in one transaction. This switch is the relational visibility boundary.

After that boundary, CE calls every registered Community `AnalysisIndexer` for the main project. A diff-capable indexer receives changed document identifiers only when the previous main-project report task succeeded and the project is not marked as requiring full issue synchronization; otherwise it receives a full main-project reindex request. Indexers execute sequentially. An index failure stops the CE pipeline and marks the task failed even though the relational analysis may already be current. Search-indexing owns later recovery behavior and query consistency.

Notifications run after indexing so consumers can read current data. Finish extensions run next. CE then publishes a task result containing the analysis UUID. Worker finalization copies that UUID to past activity, and telemetry runs later in the active Community order. Consequently, only completion of every active step produces terminal `SUCCESS`; a late failure can leave a current relational analysis, partially updated downstream systems, and a `FAILED` task. Consumers must use terminal task status, not mere presence of an analysis UUID, as completion authority.

Post-analysis tasks run on both successful and failed pipelines. On success they receive task, project, analysis, scanner context, SCM revision, and quality-gate result for the main project. On failure quality gate is absent. Each post-task failure is isolated and logged. Webhook and notification payload/delivery rules belong to events-notifications.

Evidence: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/PersistAnalysisStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/EnableAnalysisStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/IndexAnalysisStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/PublishTaskResultStep.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/api/posttask/PostProjectAnalysisTasksExecutor.java`; `server/sonar-ce-task-projectanalysis/src/it/java/org/sonar/ce/task/projectanalysis/step/IndexAnalysisStepIT.java`.

## 12. Failure and security requirements

- Report archive expansion must enforce the 4 GB uncompressed ceiling and must not trust scanner-provided paths to escape the task temporary directory; archive safety is supplied by the shared zip utility used by the pinned source.
- Missing, malformed, chronologically invalid, or identity-inconsistent report data must fail the task. CE must not publish a synthetic success or continue later stages.
- A task timeout is cooperative at step boundaries. It does not authorize unsafe thread termination.
- Queue claims and removals must be conditional on expected state. Lost races roll back rather than creating duplicate activity.
- CE must not expose a task outside the caller’s project/system permissions. Generic authorization is owned by identity-access and HTTP API.
- Error stack traces and scanner context are optional privileged fields; ordinary task listing must not imply unrestricted disclosure.
- Analyzer and post-analysis extensions are trusted in-process plugins. Exceptions are isolated only at documented listener/post-task boundaries; computation-step exceptions fail the task.
- Database is source of truth for durable task and analysis state. Search is a derived projection and may be temporarily stale after a recoverable failure.

## 13. Acceptance scenarios

1. **Preferred-class FIFO claim with tie-breaker.** Given two pending candidates in the worker poll’s currently preferred task class and both pass entity eligibility, the earlier creation time becomes `IN_PROGRESS`; equal creation time selects lower UUID. A candidate in the other class may be older because class preference alternates before fallback. A second worker cannot claim the same row.
2. **Per-project serialization.** Given an in-progress main-project report and another pending task for the same project entity, polling leaves the second task pending while unrelated project work remains eligible.
3. **Community target boundary.** Given a Community `REPORT`, CE processes the project’s single main analysis target and follows only the active main-project stages specified above.
4. **Pause drain.** Given one running task, when pause is requested, status is `PAUSING`; no new task is claimed. After the running task finishes, status is `PAUSED`. Resume permits claiming again.
5. **Missing report part.** Given a three-part task with part 2 absent, extraction fails, later computation steps do not run, queue input is removed during finalization, and activity is `FAILED` with the functional error.
6. **Chronological validation.** Given last analysis time equal to or later than report analysis time, validation fails before measures or issues are persisted.
7. **Issue reuse on unchanged file.** Given unchanged file data and no involved plugin update since base analysis, CE reuses base issues. If an involved plugin is newer, CE performs normal raw issue tracking instead.
8. **Small change gate.** Given `new_coverage` below threshold, 19 new lines to cover, and default configuration, that condition is recorded as ignored/OK. At 20 lines, or with `sonar.qualitygate.ignoreSmallChanges=false`, it remains `ERROR`.
9. **Distinct duplication lines.** Given overlapping duplication blocks on one file, `duplicated_lines` counts each physical line once; density never exceeds 100.
10. **Late indexing failure.** Given persistence and enablement succeed but an analysis indexer fails, relational analysis is current, later notification/result steps do not run, and terminal activity is `FAILED`.
11. **Recover abandoned work.** Given an `IN_PROGRESS` task whose worker UUID is unknown, cleanup resets it, recognizes its prior start timestamp as worn out, archives it `CANCELED`, and retries cleanup on a later cycle if database work fails.
12. **History retention.** Given activity older than 180 days and scanner context older than 28 days, the next successful daily purge removes each according to its own cutoff.

## 14. Provenance index

All paths below are relative to pinned commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`.

- Identity and license: `gradle.properties`; `build.gradle`; `LICENSE.txt`.
- Queue API and implementation: `server/sonar-ce-common/src/main/java/org/sonar/ce/queue/CeQueue.java`; `server/sonar-ce-common/src/main/java/org/sonar/ce/queue/CeQueueImpl.java`; `server/sonar-ce/src/main/java/org/sonar/ce/queue/InternalCeQueue.java`; `server/sonar-ce/src/main/java/org/sonar/ce/queue/InternalCeQueueImpl.java`; `server/sonar-ce/src/main/java/org/sonar/ce/queue/NextPendingTaskPicker.java`.
- Queue persistence and ordering: `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeQueueDto.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeActivityDto.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/ce/CeQueueDao.java`; `server/sonar-db-dao/src/main/resources/org/sonar/db/ce/CeQueueMapper.xml`.
- Worker lifecycle: `server/sonar-ce/src/main/java/org/sonar/ce/taskprocessor/CeWorkerImpl.java`; `server/sonar-ce/src/main/java/org/sonar/ce/taskprocessor/CeTaskInterrupterProvider.java`; `server/sonar-ce/src/main/java/org/sonar/ce/configuration/CeConfigurationImpl.java`.
- Cleanup and retention: `server/sonar-ce/src/main/java/org/sonar/ce/cleaning/CeCleaningSchedulerImpl.java`; `server/sonar-ce/src/main/java/org/sonar/ce/cleaning/CeActivitiesPurgeSchedulerImpl.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/purge/PurgeDao.java`.
- Pipeline: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/ReportComputationSteps.java`; `server/sonar-ce-task/src/main/java/org/sonar/ce/task/step/ComputationStepExecutor.java`; `server/sonar-ce-task-projectanalysis/src/test/java/org/sonar/ce/task/projectanalysis/step/ReportComputationStepsTest.java`.
- Measure, issue, duplication, and gate evidence: full production and test paths in sections 7 through 10.
- Task HTTP projection: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/CeWsModule.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/TaskFormatter.java`; registered action files and tests named in section 3.2.
- Official release: https://github.com/SonarSource/sonarqube/releases/tag/26.8.0.126808 .
