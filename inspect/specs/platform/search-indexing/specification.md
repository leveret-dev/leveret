# Search and Indexing Specification

## 1. Identity and provenance

This specification describes search and indexing in SonarQube Community Build `26.8.0.126808`, released on 2026-08-05 from Git tag `26.8.0.126808` and commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. Primary production source is `server/sonar-webserver-es`, with shared index definitions, documents, indexers, and query support in `server/sonar-server-common`, startup orchestration in `server/sonar-webserver-core`, relational iterators/queues in `server/sonar-db-dao`, and CE-triggered synchronization in `server/sonar-ce-task-projectanalysis`.

The bundled search server and Java client version is `9.4.3`, pinned by `gradle.properties` and root `build.gradle`. Elasticsearch is a dependency, not a Sonar component re-specified here. Sonar-owned production source is `LGPL-3.0-or-later`; evidence is root `LICENSE.txt` and file headers. This document specifies Sonar-facing behavior only.

## 2. Purpose, ownership, and exclusions

Search-indexing owns derived search indexes, mappings, documents, routing, database-to-index synchronization, permission projections, filtered search, facets, statistics, and recovery after indexing failure. The relational database remains authoritative; indexes are disposable projections.

Ownership boundaries are:

- `platform/persistence/` owns relational schema, migration, transaction, and database compatibility. This specification owns detection of database-vendor mismatch for derived indexes and resynchronization from relational rows.
- `platform/compute-engine/` owns report-task ordering. It invokes analysis indexers after enabling an analysis; this specification owns what each indexer writes and how search catches up.
- `platform/project-configuration/` owns rule, active-rule, quality-profile, metric, project, tag, and setting identities. Search projects those values and accepts their identifiers as filters.
- `platform/analysis-results/` owns issue, hotspot, measure, source, duplication, and history state. Search projects issue and measure fields without redefining lifecycle transitions.
- `platform/identity-access/` owns users, groups, permissions, and authorization decisions. Search owns authorization documents and the mandatory query filter derived from the current session.
- `platform/http-api/` owns generic request parsing, pagination validation, errors, and serialization. Search owns the query/filter/facet semantics named here.
- `platform/events-notifications/` owns event delivery. Search consumes committed project-entity and main-analysis events through the indexer event contract.
- Process startup, search-process health, ports, TLS, and JVM settings belong to `platform/process-runtime/`.

Community Build search scope contains project, main-project issue, main-project measure, rule, active-rule, authorization, and metadata projections. Non-main branches, pull requests, applications, portfolios, sub-portfolios, view documents, hierarchy refresh, commercial index types, and private extensions are explicitly excluded. Shared source may still register dormant fields, mappings, or indexer classes for those products; their presence is not a Community capability. Generic SCA rating keys in the project-measure allowlist likewise do not establish that Community Build produces commercial SCA data.

Evidence: `manifest/dependency-map.md`; `server/sonar-webserver-es/src/main/java/org/sonar/server/es/IndexCreator.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/IndexersImpl.java`.

## 3. Common index model and configuration

All in-scope Sonar indexes have lowercase names, dynamic mapping disabled, explicit fields, and a type discriminator. Relational indexes use a parent authorization document plus child data documents and require routing so parent and child share a shard. Simple indexes have no parent relation. Unless a definition explicitly enables `_source`, production data documents omit it and searches normally return IDs plus aggregations; callers load authoritative details from the database. The `metadatas` index retains/stores its value for lifecycle state. Shared `views` source retention is described only as an excluded mapping fact in section 5.6.

Every index includes shared analyzers. Search n-grams have minimum length 2 and maximum length 15; longer query tokens are truncated to 15 for gram matching. Sortable text is trimmed and lowercased. Prefix analyzers use edge n-grams, with case-sensitive and lowercase variants. Word search lowercases, removes stop words, folds accents, and stems English. Rule-description search strips HTML before English analysis.

Default settings and exact overrides are:

- Per-index shard override: `sonar.search.<index-name>.shards`. It must resolve to an integer accepted by Elasticsearch. Definition defaults are listed in the index catalog.
- Standalone mode uses zero replicas. Cluster mode uses resolved `sonar.search.replicas`, default 1. Cluster enablement itself is process-runtime configuration.
- Ordinary definition refresh defaults to 30 seconds. A refresh value of `-1` means no periodic refresh; Sonar bulk operations explicitly refresh on completion.
- `sonar.internal.es.disableIndexes`, default false, suppresses startup population but does not change mappings. It is internal and not a supported end-user compatibility promise.
- Recovery settings are `sonar.search.recovery.initialDelayInMs`, `sonar.search.recovery.delayInMs`, `sonar.search.recovery.minAgeInMs`, and `sonar.search.recovery.loopLimit`; defaults are specified in section 7.

A definition hash covers mappings, relations, cluster setting, shard count, refresh interval, and custom metadata. Project-measure hash metadata also includes the exact indexed metric allowlist, so changing that list rebuilds the index.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/es/Index.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/newindex/NewIndex.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/newindex/SettingsConfiguration.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/newindex/DefaultIndexSettings.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/newindex/DefaultIndexSettingsElement.java`; `server/sonar-server-common/src/test/java/org/sonar/server/es/IndexDefinitionHashTest.java`.

## 4. Index lifecycle

### 4.1 Creation and structural change

At web-server startup Sonar creates `metadatas` first. If it already exists and Elasticsearch marked it `index.blocks.read_only_allow_delete=true`, Sonar clears that setting. Sonar compares the database vendor stored in metadata to the current JDBC dialect. If absent or different, it deletes every known data index except `metadatas`; it then records the current vendor.

For each defined data index:

1. If absent, Sonar records its definition hash, records every main/relation type as uninitialized, creates the index with settings, waits for cluster status yellow, installs mapping, and waits for yellow again.
2. If present but hash differs, Sonar deletes and recreates it through the same sequence.
3. If present and unchanged, Sonar only clears the read-only-delete block when set.

A create or mapping response that is not acknowledged fails startup. An index is never treated as compatible merely because its name exists.

Evidence: `server/sonar-webserver-es/src/main/java/org/sonar/server/es/IndexCreator.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/es/metadata/EsDbCompatibilityImpl.java`; `server/sonar-webserver-es/src/test/java/org/sonar/server/es/IndexCreatorTest.java`.

### 4.2 Population and initialized state

Startup indexers receive only their uninitialized types. Synchronous Community indexers populate before marking each type initialized and wait for yellow before the metadata flag is set. The issue indexer is asynchronous: startup marks each project’s main analysis row as needing issue synchronization, creates one CE issue-sync task for that row, and marks the type initialized after successfully triggering task creation rather than after every issue document has been written. Query consumers that require complete issue data must use the synchronization guard in section 8.

Synchronous Community population covers project entity definitions, project measures, rule documents, active-rule children, and project authorization parents. Issue population orders projects with a known last analysis from newest to oldest, then projects without analyses. Existing issue-sync queue/activity rows are removed before a full index-creation schedule is built.

Evidence: `server/sonar-webserver-core/src/main/java/org/sonar/server/es/IndexerStartupTask.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/StartupIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/index/IssueIndexer.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/issue/index/AsyncIssueIndexingImpl.java`; `server/sonar-webserver-core/src/test/java/org/sonar/server/es/IndexerStartupTaskTest.java`; `server/sonar-webserver-core/src/test/java/org/sonar/server/es/IndexerStartupTaskAsyncTest.java`; `server/sonar-webserver-core/src/test/java/org/sonar/server/es/IndexerStartupTaskMockTest.java`.

### 4.3 Large and regular bulk modes

Regular bulk indexing is synchronous on the caller thread, flushes at 1,000 operations, retries only `es_rejected_execution_exception` failures up to 8 times with exponential backoff beginning at 50 ms, refreshes the target index, and then reports per-item success/failure to its listener.

Large startup indexing batches at approximately 1 MiB, permits processor-based concurrent requests, temporarily sets replicas to zero and periodic refresh to `-1`, refreshes and force-merges after indexing, then restores prior settings. Its bulk ingester uses the same 50 ms, 8-retry exponential rejection policy. Failure policy remains indexer-specific: startup and direct analysis paths generally fail on any unrecoverable item; resilient event paths retain failed queue rows.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/es/BulkIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/IndexingListener.java`; `server/sonar-server-common/src/it/java/org/sonar/server/es/BulkIndexerIT.java`.

## 5. Complete index and document catalog

### 5.1 `metadatas`

`metadatas` is a simple index with main type `metadata`, 1 shard, manual refresh, and field `value` as a stored, non-searchable keyword. Document IDs are lifecycle keys:

- `<index>.indexStructure` stores the definition hash;
- `<index>.<main-type>.initialized` stores a main-type Boolean;
- `<index>.<main-type>.<relation>.initialized` stores a relation Boolean;
- `dbVendor` stores the JDBC dialect ID.

Writes refresh immediately. Missing initialized metadata means false.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/es/metadata/MetadataIndexDefinition.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/metadata/MetadataIndexImpl.java`; `server/sonar-server-common/src/it/java/org/sonar/server/es/metadata/MetadataIndexIT.java`.

### 5.2 `components`

`components` is an authorized relation index with 5 shards and manual refresh. Main type `auth` contains authorization fields described in section 6. Child type `component` contains:

- `uuid`: non-normalized keyword and document ID;
- `key`: keyword with sortable lowercase subfield;
- `name`: stored text with field data, term positions/offsets, sortable, prefix, case-insensitive prefix, and gram subfields for search/highlighting;
- `qualifier`: keyword.

The child parent is `auth_<projectUuid>`, with project authorization routing. Community documents cover projects only. A missing relational project in a recovery event deletes its indexed document.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/component/index/ComponentIndexDefinition.java`; `server/sonar-server-common/src/main/java/org/sonar/server/component/index/ComponentDoc.java`; `server/sonar-server-common/src/main/java/org/sonar/server/component/index/EntityDefinitionIndexer.java`; `server/sonar-server-common/src/it/java/org/sonar/server/component/index/EntityDefinitionIndexerIT.java`.

### 5.3 `issues`

`issues` is an authorized relation index with 5 shards and manual refresh. Main type is `auth`; child type is `issue`. Issue document ID is issue key, parent is `auth_<projectUuid>`, and routing uses that authorization parent. `_source` is disabled.

The complete mapped issue field set is:

- identity/location: `key`, `component`, `project`, underlying main-analysis `branch`, `isMainBranch`, `scope`, `language`, `line`, `filePath`, `dirPath`;
- assignment and author: `assignee`, `authorLogin`;
- lifecycle/result: `status`, `issueStatus`, `resolution`, `issueCreatedAt`, `issueUpdatedAt`, `issueClosedAt`, `effort`;
- rule classification: `ruleUuid`, `severity`, `severityValue`, `type`, `tags`, `cleanCodeAttributeCategory`, `prioritizedRule`, `fromSonarQubeUpdate`;
- impacts: nested `impacts` objects with `softwareQuality` and `severity`;
- security standards: `pciDss-3.2`, `pciDss-4.0`, `owaspAsvs-4.0`, `owaspAsvs-4.0-level`, `owaspMobileTop10-2024`, `owaspTop10`, `owaspTop10-2021`, `sansTop25`, `cwe`, `stig-ASD_V5R3`, `casa`, `sonarsourceSecurity`, and `vulnerabilityProbability`;
- new-code and integration: `isNewCodeReference`, `codeVariants`, `linkedTicketStatus`;
- stable sort auxiliaries: `mqrSortRank` and `standardSortRank`.

Dates are date-time fields; effort is long; line is integer; severity and sort ranks are bytes; main-analysis, new-code-reference, prioritized-rule, and SonarQube-update flags are Boolean; impacts are nested; other fields are keywords. `assignee`, `filePath`, `key`, `project`, and `status` have sortable subfields where defined. In Community documents, `branch` identifies the project’s underlying main analysis row and `isMainBranch` is true. `isNewCodeReference` is a shared mapping field, not a non-main-branch search capability.

`standardSortRank` encodes rule type then legacy severity: code smell, bug, vulnerability, hotspot ranks 0 through 3; `INFO`, `MINOR`, `MAJOR`, `CRITICAL`, `BLOCKER` ranks 0 through 4. `mqrSortRank` encodes quality then impact severity: maintainability, reliability, security ranks 0 through 2; `INFO`, `LOW`, `MEDIUM`, `HIGH`, `BLOCKER` ranks 0 through 4. Maximum ranks are 19 and 14 respectively.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/issue/index/IssueIndexDefinition.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/index/IssueDoc.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/index/IssueIterator.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/index/IssueIndexer.java`; `server/sonar-server-common/src/test/java/org/sonar/server/issue/index/IssueIndexDefinitionTest.java`; `server/sonar-server-common/src/it/java/org/sonar/server/issue/index/IssueIndexerIT.java`.

### 5.4 `projectmeasures`

`projectmeasures` is an authorized relation index with 5 shards and manual refresh. Main type is `auth`; child type `projectmeasure` has project UUID as document ID and authorization parent/routing. Community documents cover projects only and use main-project analysis data.

Fields are:

- `uuid`, `key`, `name`, `qualifier`;
- `analysedAt` and `createdAt` date-times;
- `qualityGateStatus`, represented for ordering/filtering as 1 for `OK` and 3 for `ERROR`;
- `tags` and `languages` keyword arrays;
- nested `measures` objects with keyword `key` and double `value`;
- nested `nclocLanguageDistribution` objects with keyword `language` and integer `ncloc`.

Exact numeric metric allowlist is `ncloc`, `lines`, `duplicated_lines_density`, `coverage`, `sqale_rating`, `reliability_rating`, `security_rating`, `security_hotspots_reviewed`, `security_review_rating`, `new_security_rating`, `new_security_hotspots_reviewed`, `new_security_review_rating`, `new_maintainability_rating`, `new_coverage`, `new_duplicated_lines_density`, `new_lines`, `new_reliability_rating`, the corresponding six legacy/new software-quality rating keys, plus `sca_rating_any_issue` and `new_sca_rating_any_issue` when values exist. `ncloc_language_distribution` populates language arrays/distribution rather than a numeric nested entry, and `alert_status` populates gate status. This allowlist is part of definition hash.

A provisioned but unanalyzed project is indexed with no `analysedAt`. Missing projects on recovery are deleted.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/measure/index/ProjectMeasuresIndexDefinition.java`; `server/sonar-server-common/src/main/java/org/sonar/server/measure/index/ProjectMeasuresDoc.java`; `server/sonar-server-common/src/main/java/org/sonar/server/measure/index/ProjectMeasuresIndexer.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/measure/ProjectMeasuresIndexerIterator.java`; `server/sonar-server-common/src/it/java/org/sonar/server/measure/index/ProjectMeasuresIndexerIT.java`.

### 5.5 `rules`

`rules` is a non-authorized relation index with 2 shards and manual refresh. Main type `rule` uses rule UUID as document ID and routing. Child type `activeRule` uses `ar_<active-rule-uuid>` as document ID, parent/routing rule UUID.

Rule fields are:

- `ruleUuid`, composite `key`, repository `repo`, plugin `ruleKey`, non-searchable `internalKey`;
- `name`, non-primary-search `htmlDesc`, `severity`, `status`, language `lang`, `tags`;
- `isTemplate`, `isExternal`, `templateKey`, `type`, `createdAt`, `updatedAt`;
- security categories `cwe`, `owaspTop10`, `owaspTop10-2021`, `owaspMobileTop10-2024`, `sansTop25`, `sonarsourceSecurity`;
- `cleanCodeAttributeCategory`;
- nested `impacts` containing `softwareQuality` and `severity`.

Active-rule child fields are `activeRule_uuid`, `activeRule_inheritance`, `activeRule_ruleProfile`, `activeRule_severity`, `activeRule_prioritizedRule`, and nested `activeRule_impacts` containing software quality and severity. Missing inheritance is indexed as `NONE`; missing prioritized flag is false.

Rule descriptions are the concatenated rendered description sections. Rule tags combine user and system tags. Security-standard projection derives categories from stored rule security data; multiple SonarSource-category mappings are logged deterministically. Deleted rules/active rules are removed when a recovery item no longer resolves. Deleting a rule profile removes all child active-rule documents for that profile.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/rule/index/RuleIndexDefinition.java`; `server/sonar-server-common/src/main/java/org/sonar/server/rule/index/RuleDoc.java`; `server/sonar-server-common/src/main/java/org/sonar/server/rule/index/RuleIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/qualityprofile/index/ActiveRuleDoc.java`; `server/sonar-server-common/src/main/java/org/sonar/server/qualityprofile/index/ActiveRuleIndexer.java`; `server/sonar-server-common/src/it/java/org/sonar/server/rule/index/RuleIndexIT.java`; `server/sonar-server-common/src/it/java/org/sonar/server/qualityprofile/index/ActiveRuleIndexerIT.java`.

### 5.6 Excluded shared `views` definition

Shared source defines simple index `views` with 5 shards, type `view`, keyword fields `uuid` and `projects`, and enabled `_source`. Community Build produces no application, portfolio, sub-portfolio, or view documents and exposes no view-hierarchy refresh or lookup contract. An empty shared mapping may exist as packaging compatibility, but independent Community implementations must not infer document population or hierarchy behavior from it.

Evidence for the excluded mapping boundary: `server/sonar-server-common/src/main/java/org/sonar/server/view/index/ViewIndexDefinition.java`; `manifest/component-inventory.md`.

## 6. Permission projection and trust boundary

Authorized indexes use `auth` parent documents with fields:

- `auth_allowAnyone`: true for public entities;
- `auth_groupIds`: granted group UUIDs for restricted entities;
- `auth_userIds`: granted user UUIDs for restricted entities.

Authorization document ID is `auth_<entityUuid>` and routing is entity UUID. For a public entity, user/group arrays need not be stored. For a restricted entity, allow-anyone is false and granted UUID arrays are stored.

Every ordinary component, issue, and project-measure query includes a has-parent authorization filter. A document is visible when its parent allows anyone, or current session user UUID is granted, or any current session group UUID is granted. Anonymous sessions can match only allow-anyone. Parent query scoring is disabled. Internal project-measure callers may explicitly request authorization bypass; this flag must not be exposed as an unguarded end-user option.

Permission changes are committed with one `es_queue` item per authorized index scope, then indexed. Missing entities delete authorization parents. Children without a matching visible parent cannot pass the permission filter. Identity-access remains responsible for obtaining correct session user/group membership and enforcing administration permissions.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/permission/index/IndexAuthorizationConstants.java`; `server/sonar-server-common/src/main/java/org/sonar/server/permission/index/AuthorizationDoc.java`; `server/sonar-server-common/src/main/java/org/sonar/server/permission/index/PermissionIndexer.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/permission/index/WebAuthorizationTypeSupport.java`; `server/sonar-server-common/src/test/java/org/sonar/server/permission/index/AuthorizationDocTest.java`; `server/sonar-server-common/src/test/java/org/sonar/server/permission/index/PermissionIndexerTest.java`.

## 7. Synchronization and recovery

### 7.1 Analysis synchronization

After CE enables a relational analysis, it invokes registered analysis indexers sequentially:

- issue index writes all main-project issues or a changed-issue subset;
- project-measure index rewrites the project document;
- entity-definition index rewrites the project document;
- issue statistics update their project projection.

Issue index supports diff indexing for successive main-project analyses. CE uses a diff only when the prior main-project report task succeeded and the project is not flagged for issue sync; otherwise it indexes the full main-project issue set. Empty diff performs no issue write. Direct analysis indexing uses fail-on-error and therefore fails the CE task on unrecoverable indexing errors; it does not create `es_queue` recovery items itself. This preserves CE’s visible late-failure contract.

Evidence: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/IndexAnalysisStep.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/index/IssueIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/measure/index/ProjectMeasuresIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/component/index/EntityDefinitionIndexer.java`; `server/sonar-ce-task-projectanalysis/src/it/java/org/sonar/ce/task/projectanalysis/step/IndexAnalysisStepIT.java`.

### 7.2 Transaction-coupled event synchronization

For mutable project-entity or main-analysis events, each event indexer first inserts durable `es_queue` rows in the same database transaction as the source change. The coordinator commits once, then calls each indexer with only its own rows. Successful writes delete recovery rows; failed writes leave them for later replay. This makes search eventually consistent without losing a committed source change if the process crashes after database commit.

Community event coverage is:

- project entity definition: creation, deletion, and project-key update; not tags or permission change;
- project authorization parents: creation, deletion, and permission change; not key/tags;
- project measures: creation, deletion, key update, tags update, and measure change; not permission-only changes;
- project issues: project deletion and main-analysis deletion; not creation, key/tags/permission/measure-only changes;
- rules and active rules: explicit committed rule/profile mutations.

A recovery item contains UUID, formatted document type, document ID, optional ID semantic, optional routing, and creation time. Document-type formats must map to a registered resilient indexer.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/es/IndexersImpl.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/ResilientIndexer.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/es/EsQueueDto.java`; `server/sonar-server-common/src/main/java/org/sonar/server/component/index/EntityDefinitionIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/permission/index/PermissionIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/measure/index/ProjectMeasuresIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/index/IssueIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/rule/index/RuleIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/qualityprofile/index/ActiveRuleIndexer.java`.

### 7.3 Recovery daemon

One low-priority recovery thread runs at fixed rate. Defaults are:

- `sonar.search.recovery.delayInMs = 300000`;
- `sonar.search.recovery.minAgeInMs = 300000`;
- `sonar.search.recovery.loopLimit = 10000`;
- `sonar.search.recovery.initialDelayInMs`: random integer from zero through half the configured delay, inclusive.

Only queue rows created at or before current time minus minimum age are selected. Each loop groups rows by formatted document type and dispatches the registered resilient indexer. One-to-one listeners delete rows for each successfully written/deleted document. One-to-many listeners delete their source row only when the complete derived set succeeded. When a loop success ratio is 0.70 or lower, recovery stops that run and waits for the next schedule. An empty result stops the loop. Unsupported document types are logged and retained for manual repair. Any daemon throwable is logged and cannot terminate scheduling permanently. Shutdown requests orderly executor shutdown and waits up to 5 seconds. If recovery is still running after that wait, `stop` returns and the in-flight operation may continue. Only interruption of the thread performing the wait causes `shutdownNow`; that interruption is logged and restored on the caller thread.

Evidence: `server/sonar-webserver-es/src/main/java/org/sonar/server/es/RecoveryIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/OneToOneResilientIndexingListener.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/OneToManyResilientIndexingListener.java`; `server/sonar-db-dao/src/main/resources/org/sonar/db/es/EsQueueMapper.xml`; `server/sonar-webserver-es/src/test/java/org/sonar/server/es/RecoveryIndexerTest.java`.

## 8. Issue-index rebuild state and operator recovery

Creating the issue index marks each Community project’s main analysis row `need_issue_sync=true` and schedules one CE issue-sync task for that row. A successful task indexes the project’s issue set and clears that flag. Search consumers can check:

- completed project count versus total project count;
- whether any issue-sync task is pending or in progress;
- whether any issue-sync task failed or was canceled;
- whether the queue is empty while unsynchronized projects remain.

When a requested project needs sync, query services throw an index-sync-in-progress error instead of returning knowingly partial issue results. Status messages distinguish active indexing, failed/canceled tasks requiring administrator review/retry, and a stuck state where the queue is empty but `need_issue_sync=true` remains.

Operator recovery endpoint `POST /api/issues/reindex` accepts required project key, requires `Administer System`, deletes prior issue-sync tasks for that project, marks its main analysis row as needing sync, submits a replacement task, and returns no content. Generic request/error behavior belongs to HTTP API. `GET api/ce/indexation_status` exposes completed/total project count from this synchronization state.

Evidence: `server/sonar-webserver-core/src/main/java/org/sonar/server/issue/index/AsyncIssueIndexingImpl.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/taskprocessor/IndexIssuesStep.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/issue/index/IssueIndexSyncProgressChecker.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/issue/index/IssueSyncProgress.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/ReindexAction.java`; `server/sonar-webserver-webapi/src/it/java/org/sonar/server/issue/ws/ReindexActionIT.java`; `server/sonar-ce-task-projectanalysis/src/it/java/org/sonar/ce/task/projectanalysis/taskprocessor/IndexIssuesStepIT.java`.

## 9. Component search and suggestions

Component search always applies authorization. It optionally applies advanced text search and a qualifier set. Qualifier values are ORed; qualifier filter and text query are ANDed. Results contain document IDs, track exact total hits, use caller offset/limit, and sort by normalized name ascending.

Text search tokenizes on Java-style word boundaries and combines all query tokens. Result-generating matches are:

- normalized component key match, boost 50;
- case-insensitive name-prefix match, boost 2;
- partial name gram match, boost 0.5.

Ordering-only boosts are exact case-insensitive name, boost 2.5; case-sensitive prefix, boost 3; recently browsed key, boost 100; favorite key, boost 1000. A later token in prefix mode uses partial grams. Tokens longer than 15 characters are truncated only for gram lookup.

Suggestions require at least one qualifier; otherwise result is empty. One keyed facet bucket is built per requested qualifier. Each bucket returns top hits with requested skip/limit, score descending then name ascending, exact total, and HTML-encoded name highlights delimited by `<mark>` and `</mark>`. Authorization and component-type filters apply before buckets.

Evidence: `server/sonar-webserver-es/src/main/java/org/sonar/server/component/index/ComponentIndex.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/component/index/ComponentQuery.java`; `server/sonar-server-common/src/main/java/org/sonar/server/component/index/SuggestionQuery.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/textsearch/ComponentTextSearchQueryFactory.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/textsearch/ComponentTextSearchFeatureRepertoire.java`; tests under exact pinned directory `server/sonar-webserver-es/src/test/java/org/sonar/server/component/index/`.

## 10. Issue search, filtering, sorting, and facets

### 10.1 Filters

Issue search always filters child type `issue` and applies authorization. Source is not returned; exact total hits are tracked. Collections are ORed within one field and ANDed across fields. Supported filter dimensions are:

- issue keys; legacy severities; impact severities; impact software qualities;
- legacy statuses; new issue statuses; resolutions; assigned/unassigned; resolved/unresolved;
- component UUIDs, project UUIDs, directory prefixes, exact file paths, and component-only mode;
- rule UUIDs, assignee UUIDs, authors, scopes, languages, tags, legacy types;
- clean-code attribute categories, prioritized-rule flag, code variants, linked-ticket statuses, and SonarQube-update origin;
- exact creation time, creation lower/upper bounds, and per-project new-code lower bounds;
- `pciDss-3.2`, `pciDss-4.0`, `owaspAsvs-4.0` with optional level defaulting to 3, `owaspMobileTop10-2024`, `owaspTop10`, `owaspTop10-2021`, `stig-ASD_V5R3`, `casa`, `sansTop25`, `cwe`, and `sonarsourceSecurity`;
- compliance-category rule UUIDs.

When both impact quality and severity are supplied, both must match the same nested impact object. Directory matching is prefix-based. Creation lower bounds may be inclusive or exclusive according to the resolved period start; upper bound is exclusive. Lower bound must not be in the future and must be earlier than upper bound. Filters outside the Community boundary in section 2 are excluded.

Security-category filters additionally constrain results to vulnerabilities/hotspots in standard mode or to security-impact issues/hotspots in multi-quality mode. OWASP ASVS category input expands to requirements at selected level; a full requirement is retained only if it belongs to that level.

Evidence: `server/sonar-webserver-es/src/main/java/org/sonar/server/issue/index/IssueQuery.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/issue/index/IssueIndex.java`; `server/sonar-webserver-es/src/test/java/org/sonar/server/issue/index/IssueIndexTest.java`; integration tests under exact pinned directory `server/sonar-server-common/src/it/java/org/sonar/server/issue/index/`.

### 10.2 Sorting

Public sort identifiers and stable tie-breaks are:

- `CREATION_DATE`, `UPDATE_DATE`, `CLOSE_DATE`, `SEVERITY`, or `STATUS`, followed by issue key;
- `FILE_LINE`: project, file path, line, severity descending relative to requested direction, then key;
- `HOTSPOTS`: vulnerability probability descending, SonarSource security category, rule UUID, project, file path, line, key;
- `TYPE_SEVERITY`: encoded standard rank descending, then key;
- `QUALITY_SEVERITY`: encoded multi-quality rank descending, then key.

Without an explicit sort, order is creation date descending, then project, file path, line, and key ascending. Missing values are placed consistently according to requested direction. When project UUID filter is present and no facets are requested, the request uses authorization-parent routing for those projects.

Evidence: `server/sonar-webserver-es/src/main/java/org/sonar/server/issue/index/IssueIndex.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/issue/index/IssueQuery.java`; `server/sonar-webserver-es/src/test/java/org/sonar/server/issue/index/IssueIndexTest.java`.

### 10.3 Facets

Issue facet names are `severities`, `impactSoftwareQualities`, `impactSeverities`, `cleanCodeAttributeCategories`, `statuses`, `resolutions`, `issueStatuses`, `types`, `scopes`, `languages`, `rules`, `tags`, `author`, `projects`, `files`, `directories`, `assignees`, `assigned_to_me`, `pciDss-3.2`, `pciDss-4.0`, `owaspAsvs-4.0`, `owaspMobileTop10-2024`, `owaspTop10`, `owaspTop10-2021`, `stig-ASD_V5R3`, `casa`, `sansTop25`, `cwe`, `createdAt`, `sonarsourceSecurity`, `codeVariants`, `prioritizedRule`, `fromSonarQubeUpdate`, and linked-ticket status. `compliance` is the compliance-filter facet.

All except creation date are sticky: their aggregation excludes that facet’s own active filter while retaining other filters, so alternatives and selected zero-count values remain meaningful. Resolution and assignee facets include a missing bucket. Finite-enum facets use enum cardinality; security facets default to 15 terms; unbounded dimensions cap at 100. `assigned_to_me` returns one bucket and Boolean facets return two. `facetMode=effort` sums issue effort in each bucket and orders by effort descending instead of count. A top-level effort aggregation is also available.

Security report aggregations provide vulnerabilities, impact/severity distribution, hotspots to review, hotspots reviewed, optional CWE distribution, and standard-specific category/requirement distribution. They are derived from indexed issue fields and do not redefine issue lifecycle.

Evidence: `server/sonar-webserver-es/src/main/java/org/sonar/server/issue/index/Facet.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/issue/index/IssueIndex.java`; tests under exact pinned directory `server/sonar-webserver-es/src/test/java/org/sonar/server/issue/index/`.

## 11. Project-measure search and statistics

Project-measure search always filters child type and, unless an explicitly trusted internal caller sets ignore-authorization, applies authorization. Filters include project UUIDs, qualifiers, languages, tags, gate status, text, and any number of numeric metric criteria. Text uses project name/key gram search. Multiple criteria for one metric are ANDed against the same metric-key nested population.

Metric operators are `<`, `<=`, `>`, `>=`, and `=`. A no-data criterion matches documents that have no nested value for that metric. An unsupported operator fails rather than being approximated. Gate status maps `OK` to 1 and `ERROR` to 3.

Sort identifiers are `name`, `analysisDate`, `creationDate`, `alert_status`, or an indexed metric key. Name uses normalized ascending/descending order. Gate and metric sorts use project name as next tie-breaker. Every sort ends with project key ascending for determinism.

Facets are:

- range facets `ncloc` and `new_lines` at 1,000, 10,000, 100,000, 500,000;
- coverage/new coverage at 30, 50, 70, 80, with no-data bucket;
- duplication/new duplication density at 3, 5, 10, 20, with no-data bucket;
- security hotspots reviewed/new reviewed at 30, 50, 70, 80;
- A–E rating facets for legacy and new maintainability, reliability, security, security review, six software-quality rating families, and the two admitted SCA rating keys;
- `alert_status`, `languages`, `qualifier`, and `tags`.

Facets are sticky where their definitions require it and preserve selected entries. Default term facet size is 10.

Support statistics restrict to project qualifier and return total project count, projects without analysis, project count by language, total `ncloc`, and `ncloc` by language. Tag search is authorization-filtered, key-sorted, has maximum page size 100 and maximum page 20, and returns empty for nonpositive requested size.

Evidence: `server/sonar-webserver-es/src/main/java/org/sonar/server/measure/index/ProjectMeasuresQuery.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/measure/index/ProjectMeasuresIndex.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/measure/index/ProjectMeasuresStatistics.java`; tests under exact pinned directory `server/sonar-webserver-es/src/test/java/org/sonar/server/measure/index/`.

## 12. Rule and active-rule search

Rule search is not project-authorized. It always selects main rule documents and excludes `REMOVED` unless caller supplies an explicit status filter. External rules are excluded by default and included only when `includeExternal=true`.

Filters include composite key, plugin rule key, internal key, languages, repositories, severities, statuses, tags, types, template flag/key, creation lower bound, external flag, clean-code category, impacts, security standards, and compliance rule sets. With a quality profile and activation Boolean, search uses active-rule children to include or exclude active rules and may also filter inheritance, active severity, active impact severity, prioritized flag, or compare-to profile. When both rule impact quality and severity are provided, they must match the same nested impact. Tags are ORed. Compliance collections are ANDed across requested standards and ORed within each standard’s exact rule keys, composite keys, or repositories.

Text search requires every token to match at least one of name grams or English HTML description. Additional relevance clauses boost composite key 30, plugin rule key 15, and language 3. Name grams are boosted 20 and description phrases 3. Blank text is match-all.

Sortable fields are `name`, `updatedAt`, `createdAt`, and `key`; name/key use normalized subfields. Paginated search returns exact IDs and facets. Unpaginated search uses `search_after` rather than a fixed result window.

Facet identifiers are `languages`, `tags`, `repositories`, `severities`, `active_severities`, `statuses`, `types`, legacy default `true`, `cwe`, `sansTop25`, `owaspTop10`, `owaspTop10-2021`, `owaspMobileTop10-2024`, `sonarsourceSecurity`, `cleanCodeAttributeCategories`, `impactSoftwareQualities`, `impactSeverities`, `active_impactSeverities`, `complianceStandards`, and compliance filter `compliance`. Facets are sticky. Security facets restrict to security-impact/hotspot rules according to active quality mode. Status facet excludes `REMOVED`. Active-rule facets are emitted only with a profile and traverse child documents.

Evidence: `server/sonar-server-common/src/main/java/org/sonar/server/rule/index/RuleQuery.java`; `server/sonar-server-common/src/main/java/org/sonar/server/rule/index/RuleIndex.java`; `server/sonar-server-common/src/it/java/org/sonar/server/rule/index/RuleIndexIT.java`.

## 13. Failure, consistency, and security requirements

- Database is source of truth. Deleting/rebuilding any data index must be recoverable by startup indexing or issue-sync tasks.
- Definition or database-vendor mismatch requires rebuild; Sonar must not query a structurally stale index as compatible.
- Index create/mapping acknowledgement failure stops startup. A read-only-delete block is cleared before normal operation.
- Direct CE analysis indexing fails the CE task on unrecoverable item failure. Event-driven indexing commits database truth first and remains eventually consistent through `es_queue`.
- Recovery rows are removed only under one-to-one or one-to-many success rules. Unknown row types remain visible for manual repair.
- Queries over authorized indexes must never omit permission parent filtering except a separately authorized internal code path. Client-supplied user/group IDs must never replace server session identity.
- Source-disabled indexes must not be treated as record stores. Query results are IDs/aggregations; relational reads supply authoritative response content.
- Issue consumers must not return silently partial results while required project issue synchronization is known incomplete; they must expose temporary unavailability.
- Highlight output must be HTML encoded before `<mark>` tags are inserted.
- User text is analyzed through fixed query builders and exact/terms/range clauses; it is not accepted as raw Elasticsearch query syntax.
- Mapping is dynamic-false. Unknown document fields are not a supported extension mechanism.
- Search queue and metadata settings are internal trust-boundary state. Ordinary users cannot mutate them through search APIs.

## 14. Acceptance scenarios

1. **Fresh startup.** Given no indexes, startup creates `metadatas`, records hashes/uninitialized types, creates declared Community mappings, waits for yellow, populates synchronous project/rule/authorization types, schedules project issue-sync tasks, and records initialized flags.
2. **Mapping change.** Given an existing index whose stored definition hash differs, startup deletes and recreates it. Its types become uninitialized and are repopulated; stale documents do not survive.
3. **Database vendor change.** Given metadata records a different vendor, startup deletes all known data indexes except `metadatas`, records current vendor, and rebuilds projections.
4. **Read-only recovery.** Given an unchanged index with `index.blocks.read_only_allow_delete=true`, startup clears the setting without rebuilding.
5. **Private project query.** Given a restricted project and no matching user/group grant, its component, issue, and project-measure children do not appear. A granted group or user makes them visible; a public parent is visible anonymously.
6. **Event failure.** Given a committed rule update and failed Elasticsearch write, rule recovery row remains. A later recovery success updates/deletes the document and removes only the successful row.
7. **One-to-many failure.** Given one project issue-sync recovery row produces many issue operations and one fails, the source row remains. It is deleted only after a run where the whole project issue operation set succeeds.
8. **Circuit breaker.** Given a recovery loop with success ratio 0.70 or lower, daemon stops that run and leaves failures for the next scheduled run.
9. **Issue rebuild guard.** Given any requested project has `need_issue_sync=true`, guarded issue search returns temporary-unavailable state rather than partial hits. After its sync task succeeds and flag clears, search proceeds.
10. **Manual issue recovery.** Given a stuck project, system administrator posts project key to `/api/issues/reindex`; prior project issue-sync tasks are replaced and one task is submitted for the main project analysis row, with no-content response.
11. **Component relevance.** Given a favorite and a recently browsed component both matching text, favorite receives larger boost. Permission filtering still removes either unauthorized component before ranking.
12. **Nested impact filter.** Given an issue with maintainability/high and security/low impacts, filtering security plus high does not match because values occur in different nested objects.
13. **Sticky facet.** Given severity `MAJOR` selected, severity facet counts alternatives with severity filter removed while all other filters remain; selected values remain representable even at zero.
14. **Project no-data metric.** Given project has no nested `coverage` value, a no-data coverage criterion matches it; a numeric comparison does not.
15. **Rule defaults.** Given blank text and no status/external override, search returns non-removed, non-external rules. Explicit status and `includeExternal=true` alter only those defaults.
16. **Project deletion recovery.** Given a deleted project and failed post-commit index writes, durable recovery rows remain for project documents and authorization. A later successful recovery deletes derived documents and removes the corresponding rows.
17. **Large startup indexing.** Given replicas and periodic refresh enabled, large population temporarily disables both, performs bulk work, refreshes/force-merges, then restores original settings even though ordinary search documents do not retain `_source`.

## 15. Provenance index

All source paths are relative to commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`.

- Release/dependency identity: `gradle.properties`; `build.gradle`; `LICENSE.txt`.
- Lifecycle: `server/sonar-webserver-es/src/main/java/org/sonar/server/es/IndexCreator.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/es/RecoveryIndexer.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/es/IndexerStartupTask.java`.
- Common settings and bulk behavior: `server/sonar-server-common/src/main/java/org/sonar/server/es/newindex/NewIndex.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/newindex/SettingsConfiguration.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/newindex/DefaultIndexSettings.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/BulkIndexer.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/IndexingListener.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/IndexingResult.java`.
- Index catalog: full definition, document, and indexer paths in section 5; authorization paths in section 6.
- Search behavior: `server/sonar-webserver-es/src/main/java/org/sonar/server/component/index/ComponentIndex.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/issue/index/IssueIndex.java`; `server/sonar-webserver-es/src/main/java/org/sonar/server/measure/index/ProjectMeasuresIndex.java`; `server/sonar-server-common/src/main/java/org/sonar/server/rule/index/RuleIndex.java`.
- Recovery persistence: `server/sonar-db-dao/src/main/java/org/sonar/db/es/EsQueueDto.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/es/EsQueueDao.java`; `server/sonar-db-dao/src/main/resources/org/sonar/db/es/EsQueueMapper.xml`.
- Issue synchronization/reindex API: `server/sonar-webserver-core/src/main/java/org/sonar/server/issue/index/AsyncIssueIndexingImpl.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/issue/ws/ReindexAction.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/taskprocessor/IndexIssuesStep.java`.
- Pinned tests: exact production-adjacent test files named in sections 3 through 12.
- Official release: https://github.com/SonarSource/sonarqube/releases/tag/26.8.0.126808 .
