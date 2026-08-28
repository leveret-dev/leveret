# Analysis Results Specification

## 1. Identity, baseline, and license

This specification defines the Analysis Results part of SonarQube Community Build `26.8.0.126808`, published 2026-08-05. The authoritative platform source is the `SonarSource/sonarqube` tag `26.8.0.126808` at commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The official distribution is `sonarqube-26.8.0.126808.zip`, SHA-256 `ea1c5c1932f9c25350eafc4cdb1a839527c117e5d98b5fcf222a715b6b50a1f2`. Production source is licensed `LGPL-3.0-or-later`. The version and license facts are recorded in `manifest/release-baseline.md` and `manifest/license-map.md`; the root `LICENSE.txt` in the pinned source is the primary license text.

The v2 history services consumed by this part are pinned by the platform build as `org.sonarsource.sonarqube:history-api:1.0.1.9976`, `history-core:1.0.1.9976`, and `history-server-app:1.0.1.9976`. [Provenance: `gradle.properties`; root `build.gradle`; `server/sonar-webserver-webapi-v2/build.gradle`]

## 2. Purpose, ownership, and exclusions

This part owns the persisted and externally visible result states that follow an analysis: code-quality issue workflow, legacy Security Hotspot workflow and its migration, comments, assignment, tags, manual severity and type overrides, result search/read models, current and historical measures, source presentation, duplication presentation, project-analysis events, history read models, and project badges.

It does not own analyzer detection or rule semantics; scanners and analyzers produce the original findings. It does not own compute-task ordering, initial issue tracking, initial measure calculation, duplication calculation, or quality-gate policy; those belong to the compute-engine and project-configuration parts. It does not own relational schema, search-index mechanics, authorization primitives, generic HTTP encoding, event delivery, or browser interactions. It consumes those contracts from `platform/persistence/`, `platform/search-indexing/`, `platform/identity-access/`, `platform/http-api/`, `platform/events-notifications/`, `platform/compute-engine/`, and `platform/project-configuration/`. [Provenance: `manifest/dependency-map.md`]

Commercial branch, pull-request, application, portfolio, SCA, linked-ticket, and update-origin extensions must not be inferred from extension points or changelog text. Parameters explicitly described by the Community Build route metadata as unavailable in Community Build are documented only as compatibility placeholders.

## 3. Core result model

### 3.1 Code-quality issue read model

A code-quality issue has a stable key and identifies its rule, component, project, optional line and text range, message and message formatting, secondary flows, effort, assignee, SCM author, tags, creation/update/close dates, branch or pull-request identity where available, scope, external-rule-engine marker, quick-fix availability, code variants, Clean Code attribute and category, software-quality impacts, prioritized-rule flag, update-origin flag, internal tags, and optional linked-ticket status. Responses may also carry the requesting user's permitted transitions and actions, comments, referenced components, rules, users, languages, and facets. [Provenance: `sonar-ws/src/main/protobuf/ws-issues.proto`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/SearchResponseFormat.java`]

The compatibility fields `status`, `resolution`, `severity`, and `type` remain present. The normalized `issueStatus` is the preferred lifecycle projection and has public values `OPEN`, `CONFIRMED`, `FIXED`, `FALSE_POSITIVE`, `ACCEPTED`, and `IN_SANDBOX`. An unresolved open or reopened issue projects to `OPEN`; a confirmed issue projects to `CONFIRMED`; a fixed or closed issue projects to `FIXED`; resolution `FALSE-POSITIVE` projects to `FALSE_POSITIVE`; resolution `WONTFIX` projects to `ACCEPTED`; and persisted state `IN_SANDBOX` projects directly to `IN_SANDBOX`. [Provenance: `server/sonar-db-dao/src/test/java/org/sonar/db/issue/IssueWithoutRuleInfoDtoTest.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/SearchAction.java`; exact pinned plugin API `org.sonar.api.issue.IssueStatus`; `sonar-ws/src/main/protobuf/ws-issues.proto`]

### 3.2 Security Hotspot read model

A legacy Security Hotspot search item exposes its key, component, project, security category, vulnerability probability, status, optional resolution, line and text range, message and formatting, assignee, author, dates, flows, and rule key. The detail model additionally includes component and project descriptors, rule descriptions, changelog, comments, referenced users, an authorization-derived `canChangeStatus` flag, source hash, and code variants. Closed hotspots are not accepted by the detail/mutation loader. [Provenance: `sonar-ws/src/main/protobuf/ws-hotspots.proto`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/HotspotWsSupport.java`]

The `api/hotspots` family is deprecated since `2026.4`. It remains a compatibility contract in this release while the administrative migration converts stored hotspots to ordinary issues. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/HotspotsWs.java`; hotspot action definitions]

### 3.3 Common changelog and comment model

A changelog entry identifies the actor where known, display name, avatar, active-user status, creation date, optional external user and webhook source, and a list of field differences with key, old value, and new value. Effort differences use raw minutes. A comment exposes its key, author login, rendered HTML, Markdown, creation time, and whether the requester may update it. [Provenance: `sonar-ws/src/main/protobuf/ws-commons.proto`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/ChangelogAction.java`]

## 4. Code-quality issue lifecycle

### 4.1 States and manual transitions

The persisted workflow states are `OPEN`, `CONFIRMED`, `REOPENED`, `RESOLVED`, `CLOSED`, and `IN_SANDBOX`. Manual transition keys are `confirm`, `unconfirm`, `reopen`, `resolve`, `falsepositive`, `wontfix`, and `accept`. `confirm`, `unconfirm`, and `wontfix` are retained but deprecated; `accept` is the replacement for accepting an issue without fixing it. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/issue/workflow/codequalityissue/CodeQualityIssueWorkflowTransition.java`; `CodeQualityIssueWorkflowDefinition.java` in the same package]

The complete manual transition matrix is:

| Starting state | Transition | Ending state | Resolution and side effects |
|---|---|---|---|
| `OPEN`, `REOPENED`, or `CONFIRMED` | `accept` or deprecated `wontfix` | `RESOLVED` | Set `WONTFIX`; clear assignee. |
| `OPEN`, `REOPENED`, or `CONFIRMED` | `falsepositive` | `RESOLVED` | Set `FALSE-POSITIVE`; clear assignee. |
| `OPEN`, `REOPENED`, or `CONFIRMED` | `resolve` | `RESOLVED` | Set `FIXED`; the assignee is retained. |
| `OPEN` or `REOPENED` | `confirm` | `CONFIRMED` | Clear any resolution. |
| `CONFIRMED` | `unconfirm` | `REOPENED` | Clear resolution. |
| `RESOLVED` | `reopen` | `REOPENED` | Clear resolution. |
| `IN_SANDBOX` | `reopen` | `OPEN` | Clear resolution. |
| `IN_SANDBOX` | `confirm` | `CONFIRMED` | Clear resolution. |
| `IN_SANDBOX` | `resolve` | `RESOLVED` | Set `FIXED`. |
| `IN_SANDBOX` | `falsepositive` | `RESOLVED` | Set `FALSE-POSITIVE`; clear assignee. |
| `IN_SANDBOX` | `accept` or deprecated `wontfix` | `RESOLVED` | Set `WONTFIX`; clear assignee. |

A manual transition not available from the current state is not applied. The transition list returned to a caller is state-sensitive and permission-sensitive. `confirm` and `unconfirm` are available to an authenticated user; other code-quality transitions require `Administer Issues` on the project. Reading and invoking the route also requires authentication and project Browse permission. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/TransitionService.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/DoTransitionAction.java`]

### 4.2 Automatic transitions

When a live issue is being closed because its rule or component has disappeared, any of `OPEN`, `REOPENED`, `CONFIRMED`, `RESOLVED`, or `IN_SANDBOX` moves to `CLOSED`. Automatic close clears the issue line, records the previous status, sets resolution `REMOVED` when the rule is disabled and `FIXED` otherwise, and sets the close date. A resolved `FIXED` issue that is still alive reopens to `REOPENED`, clearing resolution and close date. A closed issue with stored resolution `REMOVED` or `FIXED` that becomes live again restores its previous `OPEN`, `REOPENED`, `CONFIRMED`, or `RESOLVED` status and prior resolution and clears the close date. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/issue/workflow/codequalityissue/CodeQualityIssueWorkflowDefinition.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/workflow/issue/DefaultIssueWorkflowActions.java`]

A resolved taint vulnerability whose flow locations change is automatically reopened when the ordinary fixed-issue automatic reopen predicate does not already apply. The transition clears close date and resolution and adds an explanatory system comment. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/issue/workflow/codequalityissue/CodeQualityIssueWorkflowDefinition.java:260-274`]

### 4.3 Field mutations

`POST api/issues/assign` accepts `issue` and optional `assignee`. Absence or an empty assignee unassigns; `_me` selects the current user; a named assignee must be active. The caller must be authenticated and able to Browse the project. An effective change persists and returns the full operation issue model; an idempotent request returns the unchanged model. The separate issue-search assignee sentinel remains `__me__`. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/AssignAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/SearchAction.java`]

`POST api/issues/set_severity` requires `issue` and exactly one of `severity` or `impact`. `severity` accepts the public rule-severity set. `impact` selects a software quality and impact severity and is rejected if the issue does not support that quality. Updating the legacy severity also updates the corresponding primary software-quality impact when that impact exists; updating the primary impact also updates the legacy severity when the quality maps to the issue's type. Authentication, Browse, and `Administer Issues` are required, and issue-related live measures are refreshed. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/SetSeverityAction.java`]

`POST api/issues/set_type` requires `issue` and a non-hotspot issue type, requires `Administer Issues`, refreshes live measures, and is deprecated since `10.2`. It cannot turn an issue into a Security Hotspot. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/SetTypeAction.java`]

`POST api/issues/set_tags` replaces the complete tag set. A missing or empty `tags` value removes all tags. Tags are normalized and validated by the shared rule-tag format before persistence. Authentication and Browse are required. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/SetTagsAction.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/IssueFieldsSetter.java`]

`POST api/issues/add_comment` rejects an empty comment. `POST api/issues/edit_comment` and `delete_comment` accept a comment key and allow only the comment's original user to change or delete it, after verifying visibility of the owning issue. Add, edit, and delete require authentication and Browse. Mutation responses return the owning issue and supporting component/rule/user records. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/AddCommentAction.java`; `EditCommentAction.java`; `DeleteCommentAction.java`]

`POST api/issues/bulk_change` accepts at most 500 issue keys and one or more effective actions among `assign`, `set_severity`, `set_type`, `do_transition`, `add_tags`, and `remove_tags`; a comment is not itself an action. `sendNotifications` defaults to false. Security Hotspots and issues the caller cannot Browse are ignored. Each action is verified against the caller and issue, failures are isolated per issue/action, changed issues are saved, applicable live measures are refreshed, and the response reports `total`, `success`, `ignored`, and `failures`. A supplied comment is added only to issues whose type or severity changed in the same call. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/BulkChangeAction.java`]

### 4.4 Anticipated transitions

Internal `POST api/issues/anticipated_transitions` accepts `projectKey` plus a JSON array of future issue descriptors. Each descriptor may contain `ruleKey`, `issueMessage`, `filePath`, `line`, `lineHash`, `transition`, and `comment`; only `falsepositive`, deprecated `wontfix`, and `accept` are allowed. The caller must be authenticated and have `Administer Issues`. A successful request atomically replaces all prior anticipated transitions for the same user and project and returns HTTP 202. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/anticipatedtransition/AnticipatedTransitionsAction.java`; `AnticipatedTransitionParser.java`; `AnticipatedTransitionHandler.java`]

During the next compute analysis, anticipated entries are considered only for newly discovered, unresolved `OPEN` issues in matching files. Matching uses the recorded issue identity hints. The user's `Administer Issues` permission is checked again at consumption time; revoked users' entries are ignored. A matched transition is applied under the original user identity, receives the supplied comment or a standard automatic comment, and is marked for closure handling. A transition failure produces a compute-task message and leaves analysis processing running. [Provenance: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/issue/TransitionIssuesToAnticipatedStatesVisitor.java`; `AnticipatedTransitionRepositoryImpl.java`]

## 5. Security Hotspot lifecycle and migration

### 5.1 Review workflow

Legacy hotspot states are `TO_REVIEW`, `REVIEWED`, and `CLOSED`. Manual transition keys are `resolveasreviewed`, `resolveassafe`, `resolveasacknowledged`, and `resetastoreview`.

| Starting state | Transition | Ending state | Resolution |
|---|---|---|---|
| `TO_REVIEW` | `resolveasreviewed` | `REVIEWED` | `FIXED` |
| `TO_REVIEW` | `resolveassafe` | `REVIEWED` | `SAFE` |
| `TO_REVIEW` | `resolveasacknowledged` | `REVIEWED` | `ACKNOWLEDGED` |
| `REVIEWED` with a different review resolution | any of the three resolve transitions | `REVIEWED` | Replace with the requested resolution. |
| `REVIEWED` with `FIXED`, `SAFE`, or `ACKNOWLEDGED` | `resetastoreview` | `TO_REVIEW` | Clear resolution. |

When a hotspot is being removed, `TO_REVIEW` or `REVIEWED` automatically moves to `CLOSED`. Automatic close clears the issue line, sets resolution `REMOVED` when the rule is disabled and `FIXED` otherwise, and sets the close date. A reappearing closed hotspot with resolution `REMOVED` or `FIXED` restores its prior `TO_REVIEW` or `REVIEWED` state and prior resolution and clears the close date. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/issue/workflow/securityhotspot/SecurityHotspotWorkflowDefinition.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/workflow/issue/DefaultIssueWorkflowActions.java`; `SecurityHotspotWorkflowTransition.java`]

`POST api/hotspots/change_status` accepts `hotspot`, `status`, optional `resolution`, and optional `comment`. `TO_REVIEW` forbids a resolution; `REVIEWED` requires one of `FIXED`, `SAFE`, or `ACKNOWLEDGED`. It requires authentication and `Administer Security Hotspot`. An exact status/resolution no-op returns 204 without a mutation. An effective transition may add the comment, refreshes live measures, and returns 204. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/ChangeStatusAction.java`]

Internal deprecated `POST api/hotspots/assign` accepts optional assignee and comment. It permits assignment changes only while `TO_REVIEW` or while resolution is `ACKNOWLEDGED`; the assignee must be active and, for a private project, have Browse permission. An omitted assignee unassigns. A supplied comment is persisted only when the assignment itself changes. Hotspot comment add/edit/delete follows the same authenticated Browse and own-comment edit/delete rules as issue comments. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/AssignAction.java`; hotspot comment action classes]

### 5.2 Administrative hotspot-to-issue migration

Internal `POST api/hotspots/migrate_to_issues` requires system administration and accepts optional `project` plus `dryRun`, default false. The response echoes `dryRun` and returns per-project `projectKey`, `migrated`, and `skipped` counts. A dry run performs no writes, indexing, or measure recomputation. Internal `GET api/hotspots/migration_status` requires system administration and returns `remainingHotspots` and `complete`, optionally scoped by project key. Unknown projects return not found. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/MigrateToIssuesAction.java`; `MigrationStatusAction.java`]

Migration changes the existing issue row rather than creating a replacement, thereby preserving its key, comments, and changelog. The target type is the converted rule's current type; entries whose rule is still `SECURITY_HOTSPOT` are skipped. Every migrated row gains tag `former-hotspot`. Status mapping is: `TO_REVIEW` to `OPEN` with no resolution; `REVIEWED/ACKNOWLEDGED` to `CONFIRMED` with no resolution; `REVIEWED/FIXED` to `CLOSED/FIXED`; `REVIEWED/SAFE` to `CLOSED/WONTFIX`; an already `CLOSED` hotspot retains its status and resolution. Unexpected states are left unchanged while type and tag migration proceed. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/HotspotsToIssuesMigrator.java`]

Rows are ordered and processed with keyset pagination in pages of 1,000. Writes are committed in batches of at most 1,000 and never mix branches in one transaction. Each committed batch includes issue persistence, index-queue work, live-measure refresh, and quality-gate refresh. A crash loses only the active batch; rerunning resumes from still-hotspot rows, while already converted rows are naturally excluded. A row deleted concurrently between page selection and loading is skipped. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/HotspotsToIssuesMigrator.java`; `MigrationBatchWriter.java`]

## 6. Issue and hotspot read APIs

### 6.1 Issue routes

The public `api/issues` controller provides `search`, `changelog`, `authors`, `tags`, `add_comment`, `assign`, `bulk_change`, `delete_comment`, `do_transition`, `edit_comment`, `set_severity`, `set_tags`, and deprecated `set_type`. Internal actions are `list`, `pull`, `pull_taint`, `reindex`, `component_tags`, and `anticipated_transitions`. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/IssueWsModule.java`; action definitions]

`GET api/issues/search` is index-backed, defaults to page size 100, uses the platform maximum page size, and returns issues plus `paging`, referenced components, optional rules/users/languages, facets, and optional `effortTotal`. Supported optional expansions are `actions`, `comments`, `languages`, `rules`, `transitions`, `users`, `ruleDescriptionContextKey`, or `_all`. If issue indexing is in progress, it returns 503 rather than silently serving incomplete indexed results. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/SearchAction.java`; `SearchAdditionalField.java`; `sonar-ws/src/main/protobuf/ws-issues.proto`]

Search filters are: `issues`; `components` with deprecated key `componentKeys`; internal `projects`, `directories`, and `files`; `onComponentOnly`; `severities`; `impactSoftwareQualities`; `impactSeverities`; `cleanCodeAttributeCategories`; deprecated `statuses`; `resolutions`; `resolved`; `issueStatuses`; `prioritizedRule`; `rules`; `tags`; `types`; `scopes`; `languages`; repeatable `author`; `assignees`, including `__me__`; `assigned`; `createdAt`; inclusive `createdAfter`; exclusive `createdBefore`; `createdInLast`; `inNewCodePeriod`; `timeZone`; `codeVariants`; compliance/security filters `owaspAsvsLevel`, `pciDss-3.2`, `pciDss-4.0`, `owaspAsvs-4.0`, `owaspMobileTop10-2024`, `owaspTop10`, `owaspTop10-2021`, `stig-ASD_V5R3`, `casa`, deprecated `sansTop25`, `cwe`, `sonarsourceSecurity`, and `complianceStandards`; plus declared branch/pull-request compatibility parameters. `createdAfter` and `createdInLast` are mutually exclusive. Truthy `inNewCodePeriod` cannot be combined with `createdAfter`, requires one selected component, and is ignored for application or portfolio selection. File and directory facets require project filtering. Anonymous requests do not receive the author facet. Security Hotspots are excluded from the default type set and must be queried through the deprecated hotspot API while they remain unmigrated. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/SearchAction.java`]

Supported base facets are projects, files, assigned-to-me, severities, statuses, resolutions, rules, assignees, author, directories, scopes, languages, tags, types, all listed security standards, creation date, code variants, Clean Code categories, impact qualities and severities, issue statuses, prioritized-rule state, and compliance standards. No facet is computed unless requested. Each facet returns value/count buckets; selected values missing from the result are included with count zero where required for client consistency. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/SearchAction.java:163-211,652-713`]

Internal `GET api/issues/list` is the relational degraded-mode alternative. It requires `project` or `component`, accepts `types`, `resolved`, `inNewCodePeriod`, and branch placeholders, and returns issue details with actions, comments, and transitions. It does not count the full result set: its reported total is the requested page size and its returned page size is the number loaded. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/ListAction.java`]

Internal `GET api/issues/pull`, `pull_taint`, and `api/hotspots/pull` are unpaginated incremental streams for IDE synchronization. They require project key, branch name, and Browse permission; accept language and `changedSince` filters, with route-specific repository/resolution filters; and emit length-delimited protobuf records beginning with a server query timestamp. Without `changedSince`, only non-closed items are sent. With it, changed open records and identifiers for recently closed records are sent. Large responses are expected and are produced in database batches. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/BasePullAction.java`; `PullAction.java`; `pull/PullActionResponseWriter.java`; `sonar-ws/src/main/protobuf/ws-issues.proto`; `ws-hotspots.proto`]

### 6.2 Hotspot routes

The deprecated public hotspot routes are `GET api/hotspots/search`, `GET api/hotspots/show`, comment mutations, and `POST api/hotspots/change_status`; assignment, degraded `list`, pull, and migration actions are internal. Search requires either `project` or a nonempty `hotspots` key list. Project search accepts status, resolution, `inNewCodePeriod` default false, `onlyMine`, file, security/compliance-standard filters, and declared branch/pull-request placeholders. Key-list search cannot combine with status or resolution. Resolution is valid only with `REVIEWED`; `onlyMine` requires authentication and project selection; branch and pull request are mutually exclusive. The hotspot-key list is limited to the platform search maximum. Search defaults to 100 per page and orders by the hotspot search order. Index synchronization in progress yields 503. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/SearchAction.java`]

`GET api/hotspots/show` requires Browse and returns the full hotspot detail read model. `loadHotspot` treats a missing, non-hotspot, or closed row as not found, preventing the route and mutations from exposing obsolete rows. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/ShowAction.java`; `HotspotWsSupport.java`]

## 7. Measures and badges

### 7.1 Current measures

`GET api/measures/component` requires `component` and `metricKeys`; it accepts `additionalFields` values `metrics` and `period` plus declared branch/pull-request placeholders. Browse or Execute Analysis permission suffices. It returns the component descriptor, requested measures, optional metric descriptors, and optional new-code period. Unknown metric keys fail as not found. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/measure/ws/ComponentAction.java`; `MeasuresWsParametersBuilder.java`; `sonar-ws/src/main/protobuf/ws-measures.proto`]

`GET api/measures/component_tree` requires `component` and up to 75 `metricKeys`; defaults to strategy `all`, page size 100, maximum 500, name ascending. Strategies are `children`, `all`, and `leaves`. Optional filters and ordering are `q` with minimum length three, component qualifiers, `s` using `name`, `path`, `qualifier`, `metric`, or `metricPeriod`, `asc`, `metricSort`, `metricPeriodSort`, and `metricSortFilter` (`all` or `withMeasuresOnly`). A text query omits directories. The response contains the base component, page of descendants, requested measures, optional metric descriptors, and optional period. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/measure/ws/ComponentTreeAction.java`; `sonar-ws/src/main/protobuf/ws-measures.proto`]

Internal `GET api/measures/search` accepts at most 100 project/application/portfolio keys and required metric keys. It silently removes projects the caller cannot Browse, rejects other qualifiers or unknown metrics, and orders the flattened measure rows first by metric key and then project name. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/measure/ws/SearchAction.java`]

Measure values are strings on the wire. Boolean numeric values format as `true` only when effectively one, integral types are emitted without a decimal fraction, floating/percentage/rating types retain decimal formatting, and level/string/data/distribution types use stored text. File measures optimized at their declared best value may be absent from storage; component readers reconstruct the metric best value for eligible source and test files. Requested legacy `wont_fix_issues` is resolved from `accepted_issues` and returned under the requested alias for compatibility. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/measure/ws/MeasureValueFormatter.java`; `ComponentAction.java`; `ComponentTreeAction.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/metric/RemovedMetricConverter.java`]

### 7.2 Live measure refresh after issue changes

Issue changes marked for measure refresh load the branch, project settings, selected quality gate, all issue-derived metrics and gate-dependent metrics, then build a matrix from current persisted values. Formulas recompute affected leaf/component values, aggregate them through the component tree, reevaluate the quality gate, and insert or update changed non-null measures in the caller's database session. Categories include unresolved and accepted counts, type and severity counts, software-quality impact distributions, remediation effort and ratings, new-code variants, prioritized-rule and sandbox counts, and hotspot review counts/percentages/ratings. Metric definitions and quality-gate policy remain owned by project configuration. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/measure/live/LiveMeasureUpdaterWorkflow.java`; `LiveMeasureTreeUpdaterImpl.java`; `MeasureUpdateFormulaFactoryImpl.java`]

An individual issue save writes the issue and its changelog, commits/indexes it, optionally refreshes live measures and gate state, then schedules notifications where supported. Pull-request changes do not schedule issue-change notifications. Mutation routes expose no conditional version or ETag; concurrent writers therefore serialize only through database transactions and each response reflects the mutation that completed for that request. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/WebIssueStorage.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/IssueUpdater.java`]

### 7.3 Project badges

`GET api/project_badges/measure` returns SVG for these metric keys: `coverage`, `duplicated_lines_density`, `ncloc`, `alert_status`, `security_hotspots`, `bugs`, `code_smells`, `vulnerabilities`, `sqale_rating`, `reliability_rating`, `security_rating`, `sqale_index`, `software_quality_reliability_issues`, `software_quality_maintainability_issues`, `software_quality_security_issues`, `software_quality_maintainability_rating`, `software_quality_reliability_rating`, `software_quality_security_rating`, and `software_quality_maintainability_remediation_effort`. Numeric, percentage, duration, quality-gate, and A–E rating values receive type-appropriate labels and colors. `GET api/project_badges/quality_gate` returns the branch quality-gate SVG. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/badge/ws/MeasureAction.java`; `QualityGateAction.java`]

Badge requests require `project`; optional `branch` selects a branch, not a pull request. A badge token is required for private projects or whenever `sonar.forceAuthentication` is enabled. `GET api/project_badges/token` requires Browse, returns the existing token or creates one, and `POST api/project_badges/renew_token` requires project administration, replaces the token, and returns 204. SVG responses set `Access-Control-Allow-Origin: *`, `Cache-Control: no-cache`, and an ETag; a matching `If-None-Match` yields 304. Missing data and access failures are rendered as error SVGs with immediate expiry rather than a JSON error. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/badge/ws/ProjectBadgesSupport.java`; `TokenAction.java`; `TokenRenewAction.java`; `AbstractProjectBadgesWsAction.java`]

## 8. Source presentation

All source routes enforce `See Source Code` (`CODEVIEWER`) on the file or project. Browse permission alone is insufficient. Raw source is untrusted project content; HTML views must escape `<`, `>`, and `&` before adding server-generated highlighting and symbol markup. SCM authors are hidden from anonymous callers even where source access is otherwise possible. [Provenance: source action classes under `server/sonar-webserver-webapi/src/main/java/org/sonar/server/source/ws/`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/source/HtmlTextDecorator.java`]

`GET api/sources/raw` requires file `key`, accepts internal branch/pull-request selectors, and emits UTF-8 `text/plain`, appending a newline after every stored line. A file with no stored source produces an empty successful body. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/source/ws/RawAction.java`]

`GET api/sources/show` requires `key`, defaults `from` to 1, accepts inclusive `to`, clamps `from` to at least one, and returns `sources` as ordered line-number/decorated-text pairs. Missing source returns not found. Internal `GET api/sources/index` uses `resource`, inclusive `from`, and exclusive `to`, and returns a single object mapping line-number strings to raw text. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/source/ws/ShowAction.java`; `IndexAction.java`]

Internal `GET api/sources/lines` accepts either file `uuid` or `key`; UUID cannot be combined with branch or pull request, and branch selection requires a key. `from` defaults to 1 and `to` is inclusive. Each line can expose `line`, HTML-decorated `code`, `scmRevision`, authenticated-only `scmAuthor`, `scmDate`, coverage hits and branch-condition counts under both compatibility and current field names, `duplicated`, and `isNew`. `isNew` uses the stored flag when present; otherwise it compares SCM date with the last analysis period date. Missing source returns not found. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/source/ws/LinesAction.java`; `LinesJsonWriter.java`]

`GET api/sources/scm` returns line, author, commit datetime, and revision records. `commits_by_line` defaults false and then emits only the first line of each consecutive identical commit; true emits every line. Anonymous responses replace author with an empty string. `GET api/sources/issue_snippets` returns snippets around an issue's main and flow locations, grouped by file key with component metadata and line records; no locations or component produces 204. It includes five lines before each location, nine after the main location, five after secondary locations, and fills gaps of at most ten lines between nearby snippets. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/source/ws/ScmAction.java`; `IssueSnippetsAction.java`]

## 9. Duplication presentation

`GET api/duplications/show` requires file `key`, accepts internal branch or pull-request selectors, and enforces `See Source Code`. It reads the persisted `duplications_data` measure and returns duplication groups plus a map of referenced files. Each block has `from`, `size`, and a file reference; file descriptors include key, name, project identity/name, and optional branch or pull request. No stored data returns empty groups and files. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/duplication/ws/ShowAction.java`; `sonar-ws/src/main/protobuf/ws-duplications.proto`]

Within each group, blocks in the requested file sort first by starting line, then blocks in the same project, then cross-project blocks. Removed cross-project targets remain as unlinked textual references; pull-request references explicitly marked unavailable are likewise returned without a link. The persisted XML parser disables DTD support and validation. Malformed XML fails the request rather than returning a partial group. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/duplication/ws/DuplicationsParser.java`; `ShowResponseBuilder.java`]

## 10. Analysis and measure history

### 10.1 Legacy analysis events

`GET api/project_analyses/search` requires a Community project key and Browse, defaults to processed analyses, defaults to 100 and allows at most 500 per page, and sorts newest first. Optional filters are event `category`, inclusive `from`, inclusive `to`, and internal status; the declared branch selector does not create Community branch support. Event categories are `VERSION`, `OTHER`, `QUALITY_PROFILE`, `QUALITY_GATE`, `DEFINITION_CHANGE`, `ISSUE_DETECTION`, and `SQ_UPGRADE`. The response contains analysis key/date, events, project version, build string, manual-new-code-baseline marker, revision, and detected CI; specialized events may include quality-gate or quality-profile detail. Application, portfolio, and selected-project collection history are not reachable Community Build behavior. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/projectanalysis/ws/SearchAction.java`; `EventCategory.java`; `sonar-ws/src/main/protobuf/ws-projectanalyses.proto`; `manifest/component-inventory.md`]

`POST api/project_analyses/create_event`, `update_event`, and `delete_event` require project administration or system administration, but only `VERSION` and `OTHER` events are mutable. Names are required, nonempty, and at most 400 characters; version names are additionally at most 100 characters. A project analysis has at most one version event, and an analysis cannot contain duplicate `OTHER` names. Version events are allowed only on projects and synchronize the analysis's project-version field. Deleting a version event clears that field and is forbidden on the latest analysis. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/projectanalysis/ws/CreateEventAction.java`; `UpdateEventAction.java`; `DeleteEventAction.java`; `EventValidator.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/event/EventValidator.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/component/SnapshotDto.java`]

`POST api/project_analyses/delete` requires project administration, hides an already unprocessed analysis as not found, forbids deletion of the latest analysis and any analysis selected as a new-code baseline, then marks the analysis `UNPROCESSED` and returns 204. It is a state change, not immediate physical deletion. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/projectanalysis/ws/DeleteAction.java`]

### 10.2 Legacy measure history

`GET api/measures/search_history` requires a Community project/component and metric keys plus Browse. `from` and `to` are inclusive and accept a server-time-zone date or an offset datetime. Results are chronological. Pagination defaults to 100 and allows 1,000; it applies independently to the history values of every requested metric. Each output entry has a metric key and ordered date/value pairs. Unknown metrics fail the request. Declared application, portfolio, branch, and pull-request variants do not expand the Community history contract. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/measure/ws/SearchHistoryAction.java`; `sonar-ws/src/main/protobuf/ws-measures.proto`; `manifest/component-inventory.md`]

### 10.3 v2 history read models

The Community-reachable v2 history routes are under `/api/v2/history`, require authentication and Browse on the selected project, return JSON, and map invalid entity types, date ranges, filters, or service arguments to HTTP 400. The supported Community history entity is `PROJECT_BRANCH` for the project's main branch. The pinned history library and controller source contain application and portfolio entity types, but Community Build does not create or record those history entities; they are excluded from this specification. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/history/controller/DefaultMeasuresHistoryController.java`; `DefaultIssueCountHistoryController.java`; `HistoryControllerUtils.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/RecordHistoryStep.java`; `manifest/component-inventory.md`]

`GET /api/v2/history/measures-history` requires `entityType=PROJECT_BRANCH`, the Community project's main-branch `entityId`, nonempty `metricKeys`, and `startDate`; `endDate` is optional. It returns that main branch's measure series for the normalized date range. `GET /api/v2/history/issue-count-history` requires the same entity identity and `startDate`; optional inputs are `endDate`, `impacts`, `issueTypes`, `ruleKeys`, `severities`, `sliceBy`, and `statuses`. It returns main-branch issue-count history with the requested dimensions/slices. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/history/controller/DefaultMeasuresHistoryController.java`; `DefaultIssueCountHistoryController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/WebApiEndpoints.java`]

Application/portfolio history and collection-level per-project breakdown read models are explicitly excluded: their controller and service classes are present for unified-source compatibility, but their required collection entities and successful recording path are unavailable in Community Build. Their presence in `HistoryWebConfiguration` is not evidence of a Community transport capability. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/history/config/HistoryWebConfiguration.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/history/controller/ProjectCollectionContextLoader.java`; `manifest/component-inventory.md`]

### 10.4 Recording, partial results, and retention

At the end of Community project main-branch compute processing, history recording uses the UTC calendar date and reads issues from that main branch. Closed issues are excluded. Missing or unresolvable rules cause only those issues to be skipped with a warning. Measure history records every non-null current main-branch metric value together with metric type, and does nothing if no measures exist. Any exception in the history step is logged and does not fail the surrounding analysis, so a successful main-branch analysis may lack that day's history row. Application, portfolio, non-main-branch, and selected-project collection recording paths are not Community capabilities. [Provenance: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/RecordHistoryStep.java`; `history/RecordHistoryDelegateImpl.java`; `manifest/component-inventory.md`]

History older than global setting `sonar.dbcleaner.daysBeforeDeletingHistory` is purged. The default is 365 days. An absent or non-integer value falls back to 365; the threshold is computed in UTC. [Provenance: `sonar-core/src/main/java/org/sonar/core/config/PurgeConstants.java`; `PurgeProperties.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/history/HistoryPurgeStep.java`]

## 11. Failure, recovery, and trust boundaries

Visibility must be checked before loading auxiliary result data. Unauthorized private-project data must be omitted or reported through the identity-access error contract; bulk operations filter unauthorized rows rather than revealing them. Source and duplication routes require the stronger source-view permission. Badge access deliberately reports a generic project-not-found SVG for invalid private-project tokens. [Provenance: issue/hotspot/source/duplication/badge support classes cited above]

Unknown keys and missing components, rules, metrics, analyses, comments, or events return the HTTP API's not-found or bad-request envelope as appropriate. Illegal state transitions and incompatible parameter combinations are rejected without persistence. Single-issue mutation persistence and its changelog are committed together before indexing and downstream notifications. Bulk mutations may report a mixture of successes, ignored rows, and failures; clients must inspect all counters. Search is intentionally unavailable with 503 during index synchronization, while internal relational `list` routes provide a constrained degraded read. History recording is best-effort and migration is resumable by rerun. [Provenance: mutation and search classes cited above]

Project source, SCM identity, issue comments, and badge tokens cross trust boundaries. HTML source must be escaped; duplication XML must not resolve DTDs; comment rendering must distinguish Markdown from rendered HTML; SCM authors must not be disclosed anonymously; pass-through badge tokens must never be written into badge SVGs or error text. [Provenance: `HtmlTextDecorator.java`; `DuplicationsParser.java`; common protobuf schema; `ProjectBadgesSupport.java`]

## 12. Compatibility and limits

Public keys, route names, field names, transition keys, metric aliases, enum strings, date inclusivity, paging defaults, and response omission behavior are compatibility contracts. Internal routes are shipped and specified for same-version clients but carry no forward-compatibility guarantee. Deprecated fields and actions remain accepted exactly where this document identifies them. Branch and pull-request parameters whose route metadata says “Not available in the community edition” must not be used to claim Community Build branch capability. [Provenance: action metadata throughout `server/sonar-webserver-webapi`; `manifest/component-inventory.md`]

Important hard limits are 500 issue keys for bulk change; platform maximum page size for indexed issue search and hotspot key-list search; 75 metric keys and 500 descendants per component-tree page; 100 projects for internal measure search; 1,000 values per measure-history metric page; 500 analyses per project-analysis page; 400 characters for event names and 100 for version names; and 1,000 rows per hotspot migration page and transaction batch. Endpoints may impose smaller defaults as stated above.

## 13. Acceptance scenarios

1. **Accepting an open issue.** Given an authenticated user with Browse and `Administer Issues` and an `OPEN` assigned issue, when `do_transition` receives `accept`, the issue becomes `RESOLVED/WONTFIX`, `issueStatus` becomes `ACCEPTED`, the assignee is cleared, a changelog difference is stored, issue-derived live measures and the quality gate are refreshed, and the response returns the updated issue.

2. **Unavailable transition is a successful no-op.** Given a `RESOLVED` issue, when an authenticated caller requests `confirm`, the workflow does not invent a transition; the endpoint returns its ordinary successful issue response containing the unchanged issue, and persisted state remains unchanged.

3. **Automatic taint reopen.** Given a resolved taint vulnerability whose flow changes in a later analysis and which does not meet ordinary fixed-issue reopening, analysis reopens it to `REOPENED`, clears resolution and close date, and adds the automatic explanatory comment.

4. **Bulk partial outcome.** Given 501 requested keys, bulk change is rejected before mutation. Given at most 500 keys containing unauthorized rows, hotspots, an action failure, and valid code-quality issues, the response counts valid changes as success, unauthorized/hotspot/no-op rows as ignored, action exceptions as failures, and does not roll back independent successful rows.

5. **Anticipated acceptance.** Given a user with `Administer Issues` who submits anticipated `accept` data, the server replaces that user's earlier project entries and returns 202. If the permission is revoked before analysis, the entry is ignored. If still authorized and a new matching issue appears, it becomes accepted and receives the supplied or standard comment.

6. **Hotspot review validation.** Given a `TO_REVIEW` hotspot, `REVIEWED` without a resolution is rejected; `TO_REVIEW` with a resolution is rejected; `REVIEWED/SAFE` with hotspot administration succeeds, refreshes measures, and returns 204.

7. **Resumable migration.** Given 1,500 convertible hotspots on one branch and a failure after the first 1,000-row commit, the first batch remains converted with stable keys, changelog/comments, and `former-hotspot`; the remaining rows remain hotspots. Rerunning migrates only the remainder. Dry-run mode reports equivalent counts without changing any row.

8. **Index degradation.** Given issue-index synchronization in progress, public issue search returns 503 and does not present an incomplete total. Internal relational `api/issues/list` can still return a constrained project/component page whose total follows its documented degraded convention.

9. **Measure compatibility.** Given a request for `wont_fix_issues`, the service reads `accepted_issues` and returns the value under the requested legacy key. Given an unknown metric, it returns not found/bad request rather than a null-valued measure.

10. **Protected source.** Given Browse but not See Source Code, source and duplication requests are forbidden. Given permission and source containing markup-significant characters, decorated output escapes project text while preserving server-generated highlighting; raw output remains UTF-8 plain text.

11. **SCM anonymity.** Given an anonymous caller allowed to view a public source file, line and revision information may be returned but SCM author identity is omitted or blank as specified by the selected route.

12. **Duplication corruption.** Given no `duplications_data`, `api/duplications/show` returns an empty model. Given malformed persisted duplication XML, it fails the request and never returns a silently truncated block; external entity/DTD loading is not attempted.

13. **Analysis deletion guards.** Given the latest analysis or one selected as a new-code baseline, deletion is rejected. Given an older unreferenced processed analysis and project administration, deletion changes it to `UNPROCESSED`, returns 204, and subsequent ordinary searches omit it by default.

14. **Best-effort history.** Given a successful analysis whose history recorder cannot resolve one rule, all other eligible issue and measure history is recorded for the UTC day and only that issue is skipped. Given a recorder-wide exception, analysis completion remains successful and the missing history is observable rather than fabricated.

15. **Badge caching and privacy.** Given a valid private-project badge token, a badge returns SVG, wildcard CORS, and an ETag; a matching conditional request returns 304. Given an invalid token, the response is an immediately expired generic error SVG that does not disclose whether the project exists.

## 14. Provenance index

- Release and license: `manifest/release-baseline.md`; `manifest/license-map.md`; pinned source `LICENSE.txt`, `gradle.properties`, and root `build.gradle`.
- Ownership and dependencies: `manifest/component-inventory.md`; `manifest/dependency-map.md`.
- Issue state machine: `server/sonar-server-common/src/main/java/org/sonar/server/issue/workflow/codequalityissue/CodeQualityIssueWorkflowDefinition.java`; `CodeQualityIssueWorkflowTransition.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/TransitionService.java`.
- Hotspot state machine and migration: `server/sonar-server-common/src/main/java/org/sonar/server/issue/workflow/securityhotspot/`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/`.
- Issue and hotspot routes/read models: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/hotspot/ws/`; `sonar-ws/src/main/protobuf/ws-issues.proto`; `ws-hotspots.proto`; `ws-commons.proto`.
- Mutation persistence and live measures: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/WebIssueStorage.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/IssueUpdater.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/measure/live/`.
- Measures and aliases: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/measure/ws/`; `server/sonar-db-dao/src/main/java/org/sonar/db/metric/RemovedMetricConverter.java`; `sonar-ws/src/main/protobuf/ws-measures.proto`.
- Source and duplication: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/source/`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/duplication/ws/`; `sonar-ws/src/main/protobuf/ws-duplications.proto`.
- Analysis events and deletion: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/projectanalysis/ws/`; `sonar-ws/src/main/protobuf/ws-projectanalyses.proto`.
- v2 history and recording: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/history/`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/history/`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/RecordHistoryStep.java`.
- Badges: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/badge/ws/`.
