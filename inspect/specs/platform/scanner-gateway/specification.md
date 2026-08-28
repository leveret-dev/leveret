# Scanner Gateway Specification

## 1. Identity and authority

This specification describes scanner-facing gateway behavior in SonarQube Community Build 26.8.0.126808, tag `26.8.0.126808`, commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`.

Wire compatibility is pinned to:

- `org.sonarsource.scanner.engine:sonar-scanner-engine-community:13.5.0.4089`, whose inspected source artifact has SHA-256 `e29ebcc0e7102825dfa0990dbb0cb403031570913966c058d6f6253f7c8c9564`;
- `org.sonarsource.scanner.engine:scanner-engine-protocol-server:13.5.0.4089`, whose inspected source artifact has SHA-256 `6defe692b11f69da99fa0ffabbdc57956d5923f3e8269ed96f4975173bbcef72`;
- the `sonar-ws` and `sonar-sarif` modules at the pinned platform commit;
- SARIF 2.1.0, based on the OASIS errata-01 schema at `https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json`.

SonarQube production source, scanner engine artifacts, and generated Sonar protocol libraries are licensed under `LGPL-3.0-or-later`. The bundled SARIF schema carries its OASIS document notice. This specification records behavior and is not legal advice.

## 2. Purpose, scope, and exclusions

The gateway is the server boundary used to bootstrap scanners, publish analyzer plugins and configuration referentials, receive a completed scanner report, retain scanner cache data, and acknowledge durable handoff to the compute queue. It owns:

- server/scanner-engine and optional JRE bootstrap metadata and downloads;
- installed-plugin metadata and scanner plugin JAR download;
- scanner-facing active-rule and project-repository views;
- scanner-report HTTP submission, report-part persistence, queue handoff, and acknowledgement;
- exact scanner-report archive, protobuf, and framing compatibility;
- branch-scoped analysis-cache retrieval, clearing, persistence, and retention;
- SARIF 2.1.0 data-model serialization/deserialization compatibility supplied by the platform.

The gateway does not execute scanner-engine steps, index files, run analyzers, import SARIF results into issues, construct reports, process report contents, calculate measures, track issues, evaluate quality gates, or expose compute-task state. Scanner execution belongs to `integrations/scanner-engine/`; project/profile/rule policy belongs to `platform/project-configuration/`; report processing and task state belong to `platform/compute-engine/`. This specification stops when a valid upload is stored and a compute task is acknowledged.

Generic route dispatch, media-type parsing, authentication mechanisms, status serialization, and cross-origin behavior belong to `platform/http-api/` and `platform/identity-access/`. The gateway adds the route-specific permission and validation rules stated here.

## 3. Bootstrap APIs

All paths below are relative to the SonarQube context path. Versioned analysis controllers are mounted below `/api/v2`.

### 3.1 Server version

`GET /api/v2/analysis/version` returns HTTP 200 with `text/plain` containing the running SonarQube server version. In this release the value is `26.8.0.126808` for the pinned distribution. The legacy scanner path `GET /api/server/version` remains the scanner-engine 13.5.0.4089 compatibility endpoint and returns the same server version as plain response content.

### 3.2 Scanner-engine metadata and download

`GET /api/v2/analysis/engine` supports representation selection by `Accept`:

- JSON returns `filename` and lowercase hexadecimal `sha256` for the scanner-engine JAR;
- `application/octet-stream` returns the JAR bytes.

The server searches visible files beneath `<home>/lib/scanner`, selects the first file whose name ends in `.jar`, and computes SHA-256. Successfully computed metadata is cached for the process lifetime. A missing scanner directory or no matching JAR returns not found without populating that cache, so adding a JAR can make the next request succeed without restart. A failure to read the file while hashing is an I/O failure, not an empty metadata response.

Legacy bootstrap remains available:

- `GET /batch/index` returns `text/plain`; each visible scanner JAR is represented by its filename, a vertical bar, its lowercase MD5, and a line feed;
- `GET /batch/file?name=<filename>` returns the named contained file as `application/java-archive`.

`/batch/file` requires `name`. It rejects a target only when the target does not exist or its canonical path is outside the canonical `<home>/lib/scanner` root. It does not require index membership, `.jar` extension, visibility, a top-level path, or a path string free of traversal segments. A traversal-containing name whose canonical target remains inside the root is served. On Unix, an absolute-looking child name may still be resolved beneath the root by the path-construction behavior and served when containment holds. Any existing contained target, including an unlisted, hidden, nested, or non-JAR file, is therefore reachable; operators must keep unrelated or sensitive files out of this directory. Legacy MD5 values are cache identifiers, not authenticity proofs. New clients should use SHA-256 metadata.

### 3.3 JRE metadata and download

`GET /api/v2/analysis/jres` returns JSON metadata for available scanner JREs. Optional `os` and `arch` filters are case-insensitive. Supported OS aliases are `win`, `windows`, `win32`, `linux`, `mac`, `macos`, `darwin`, and `alpine`. Supported architecture aliases are `x86_64`, `x86-64`, `amd64`, `x64`, `arm64`, and `aarch64`. An unsupported nonblank alias is a bad request.

`GET /api/v2/analysis/jres/{id}` returns one JSON metadata object. The same path with `Accept: application/octet-stream` returns its binary archive. An unknown ID or missing archive returns not found.

Each object has exact fields `id`, `filename`, `sha256`, `javaPath`, `os`, and `arch`. The pinned distribution advertises:

| id | filename | sha256 | javaPath | os | arch |
|---|---|---|---|---|---|
| `96f1e8cc-acdc-404d-81cd-9ddaf80f0d58` | `OpenJDK21U-jre_x64_linux_hotspot_21.0.11_10.tar.gz` | `e5038aae3ca9ff670bc696496b0728dbd23d280026bad30291cb919221ecfdcb` | `jdk-21.0.11+10-jre/bin/java` | `linux` | `x64` |
| `2a759188-5604-4ef3-89d7-5a8b0db8e98a` | `OpenJDK21U-jre_aarch64_linux_hotspot_21.0.11_10.tar.gz` | `fa23d9d9945053e67bcc7638410eabf1e17a7672c7c95a24f70cd08b8407d36e` | `jdk-21.0.11+10-jre/bin/java` | `linux` | `aarch64` |
| `027b58e0-8aa3-4781-8e6c-d6f4d3dbd631` | `OpenJDK21U-jre_x64_alpine-linux_hotspot_21.0.11_10.tar.gz` | `b75c9f0dd052adfd213f0c2c1cc0c8a6d4539a8de9f7947d2b8fc45d18289975` | `jdk-21.0.11+10-jre/bin/java` | `alpine` | `x64` |
| `eca33a8b-62fb-4123-bb94-2a963b671aab` | `OpenJDK21U-jre_x64_windows_hotspot_21.0.11_10.zip` | `be26677aaa20b39a62edcaab4c8857a8b76673b0f45abc0b6143b142b62717e4` | `jdk-21.0.11+10-jre/bin/java.exe` | `windows` | `x64` |
| `1b33237f-2364-4e88-bf4e-3bdb39d73972` | `OpenJDK21U-jre_x64_mac_hotspot_21.0.11_10.tar.gz` | `b341fb8ed5b70d49066b98176bc98e30f55082192403deb60e0cd5948b6e7923` | `jdk-21.0.11+10-jre/Contents/Home/bin/java` | `mac` | `x64` |
| `074703b3-f1d5-48c8-b7f3-deff34fd8732` | `OpenJDK21U-jre_aarch64_mac_hotspot_21.0.11_10.tar.gz` | `4b7a8cd23102c251c8b8be42a9a5f1263fb337cf1037f6f64b25f3070efe4b76` | `jdk-21.0.11+10-jre/Contents/Home/bin/java` | `mac` | `aarch64` |

Global boolean `sonar.jreAutoProvisioning.disabled` defaults to `false`. When true, collection discovery returns an empty list. The pinned handler does not apply that switch to direct lookup by a known ID; disabling discovery is not deletion of packaged archives. Operators enabling it must provide a compatible JRE to scanners through their build environment.

## 4. Scanner referentials and plugin artifacts

### 4.1 Installed plugins

`GET /api/plugins/installed` requires either an authenticated session or global scan permission. Results are sorted by plugin name, then key. Optional `f=category` requests update-center category and may require update-center connectivity. Internal parameter `type` accepts persisted plugin types and filters the result.

The response is available as protobuf or JSON under normal Web API media negotiation. Protobuf uses proto2 `InstalledPluginsWsResponse`, field 1 `plugins`, containing `PluginDetails` with these wire fields:

1. `key`; 2. `name`; 3. `description`; 4. `category`; 5. `version`; 6. `license`; 7. `organizationName`; 8. `organizationUrl`; 9. `editionBundled`; 10. `homepageUrl`; 11. `issueTrackerUrl`; 12. `implementationBuild`; 13. `filename`; 14. `hash`; 15. `sonarLintSupported`; 16. `documentationPath`; 17. `updatedAt`; 18. `type`; 19. repeated `requiredForLanguages`.

`hash` is the plugin JAR's lowercase MD5. `type` is `BUNDLED` or `EXTERNAL`. `version` uses nonblank display version when present, otherwise manifest version. Missing optional descriptor values remain absent. `documentationPath` is retained for wire compatibility although deprecated.

`GET /api/plugins/download?plugin=<key>` is an internal scanner route. It returns the loaded JAR as `application/java-archive` and header `Sonar-MD5` equal to metadata `hash`. Unknown key returns not found. The action performs no independent per-plugin authorization; deployment-level HTTP access policy remains the HTTP/identity contract.

Plugin descriptors, compatibility, and isolation belong to `platform/plugin-extension-runtime/`. The gateway publishes only plugins accepted by that runtime.

### 4.2 Active rules

`GET /api/v2/analysis/active_rules?projectKey=<key>` returns JSON array entries with:

- `ruleKey`, containing `repository` and `rule`;
- `name`, `severity`, `createdAt`, `updatedAt`, `language`, and `qProfileKey`;
- optional `internalKey` and `templateRuleKey`;
- optional nonempty `deprecatedKeys`, each with `repository` and `rule`;
- optional nonempty `params`, each with `key` and `value`;
- optional nonempty `impacts`, mapping software-quality identifiers to impact severities.

If the project key resolves, project-specific active rules are returned. If it does not resolve, default active rules are returned rather than not found. Rule/profile selection semantics remain owned by project configuration.

### 4.3 Project file repository

`GET /batch/project.protobuf` is the version-coupled project repository route. Required parameter `key` is the root project key. Optional parameters are `profile`, `branch`, and `pullRequest`. `key` must identify a root project; module keys are rejected. The caller needs project `SCAN` or global `SCAN` permission. An unauthorized caller receives the analysis-not-authorized failure.

The proto2 `WsProjectResponse` retains field 3 `fileDataByModuleAndPath` for compatibility and uses field 5 `fileDataByPath` in this release. Each path maps to `FileData`, whose optional field 1 is source `hash` and field 2 is SCM `revision`. Main branch is used when neither branch selector is supplied. A branch or pull request with no existing component yields an empty file map. The route returns prior enabled-file hashes and revisions; it does not analyze files.

### 4.4 Other project-configuration bootstrap routes

Scanner engine 13.5.0.4089 also consumes these existing platform contracts:

- `/api/settings/values.protobuf`, optionally with `component=<projectKey>`;
- `/api/qualityprofiles/search.protobuf?project=<projectKey>`, with default-profile fallback through `defaults=true` when project lookup is not found;
- `/api/metrics/search?ps=500&p=<page>`;
- `/api/languages/list`;
- `/api/new_code_periods/show.protobuf`;
- `/api/features/list`.

The gateway must keep these routes reachable with their existing protobuf/JSON representations. Settings values are assembled in precedence order default, global, then component; the component value wins. Installation-file settings are excluded from the response. Secured values are never returned; only their keys may appear in `setSecuredSettings`. Component requests require Browse, project Scan, or global Scan permission. Full fields, validation, rule/profile policy, metric vocabulary, language ownership, new-code policy, and feature semantics belong to `platform/project-configuration/` and analyzer specifications and are not duplicated here.

## 5. Protobuf and HTTP response compatibility

Legacy Web API messages in `sonar-ws` use proto2 and preserve their field numbers. When an action writes a protobuf-capable message, requested media type `application/x-protobuf` produces binary protobuf; other requested media types produce JSON from the same message. JSON is UTF-8. Serialization failure is a server failure and must not silently switch representation.

Binary files use route-specific media types: `application/java-archive` for legacy scanner/plugin JARs and `application/octet-stream` for v2 engine/JRE downloads. Report upload uses a ZIP multipart part. Generic request errors and status envelopes are defined by the HTTP API specification.

Clients must tolerate omitted optional proto2 fields and unknown additive fields. They must not renumber known fields. Scanner-report protobuf is a separate proto3, release-coupled contract described in section 7.

## 6. Report submission and acknowledgement

### 6.1 Request

`POST /api/ce/submit` is an internal multipart submission route. Required fields are:

- `projectKey`, maximum 400 characters;
- `report`, a ZIP file part containing the scanner report.

Optional fields are:

- `projectName`; if absent or blank it defaults to `projectKey`, and values longer than 500 characters are abbreviated to 500;
- repeatable `characteristic`, each formatted as one `key=value` pair using the first equals sign as separator.

Supported characteristic keys are `branch`, `branchType`, `pullRequest`, `devOpsPlatformUrl`, and `devOpsPlatformProjectIdentifier`. Duplicate keys are rejected. A malformed pair is rejected. Well-formed unsupported keys are ignored. Community Build does not infer commercial branch behavior beyond the branch component behavior present in this pinned source.

The caller needs project `SCAN` permission or global `SCAN`. If the project does not exist, the caller also needs `PROVISION_PROJECTS`, and permission-template or supported DevOps provisioning checks must show that the caller can scan the created project. A key already used by a non-project component is rejected.

### 6.2 Storage and handoff

The gateway copies the request body to a temporary file before database storage. Global integer `sonar.report.partMaxSizeMBytes` defaults to `450`. The configured value is multiplied by 1,048,576 using signed 32-bit arithmetic and is not range-checked. Usable values are therefore 1 through 2047 MiB. Within that range, a report no larger than the threshold is stored as one part; a larger report is split without transformation into contiguous byte ranges of at most the threshold, with one-based consecutive part numbers. Zero makes every nonempty upload reach division by zero and fail before acknowledgement. At 2048 the threshold overflows to `-2147483648`; a report of exactly 2 GiB can then produce zero persisted parts and still be acknowledged for later downstream failure. Negative or larger overflowing values likewise have unsupported split behavior and must be rejected operationally rather than treated as valid limits.

Report parts are committed before queue submission metadata is finalized. Queue metadata identifies task type `REPORT`, branch component, main project, submitter UUID, accepted characteristics, and part count. The gateway does not parse or validate protobuf content during HTTP upload.

Temporary upload and split files are deleted after use. Failure to delete a temporary file is logged but does not invalidate an otherwise stored submission.

### 6.3 Response and acknowledgement meaning

On success, the route returns proto2 `Ce.SubmitResponse` or its JSON rendering:

- field 1 `taskId`: newly submitted compute-task UUID;
- field 2 `projectId`: target branch component UUID.

Acknowledgement means the report bytes were stored and a compute task was submitted. It does not mean report extraction, protobuf validation, analysis processing, persistence of results, indexing, or quality-gate evaluation succeeded. Clients use compute-engine APIs for later status; those APIs are outside this gateway contract.

Invalid characteristics or project identity return a request error. Permission failures return insufficient privileges. A detected failure while saving, sizing, splitting, or persisting the report is returned as server failure and emits no success acknowledgement. An upload-layer `IllegalStateException` becomes HTTP 500 with its message. This guarantee applies only when the failure is detected: the gateway does not validate that part count is positive, and signed overflow at `sonar.report.partMaxSizeMBytes=2048` can silently produce zero parts and still acknowledge. Compute processing failures after acknowledgement do not retroactively change the upload response.

## 7. Scanner report archive and protobuf contract

### 7.1 Version coupling and archive safety

The accepted report is a ZIP directory produced for scanner engine/protocol 13.5.0.4089. The route description explicitly states that report format is not a stable public API and changes between SonarQube versions. Compatibility requires the pinned protocol, not merely syntactically valid protobuf.

At compute handoff, persisted parts are concatenated in part-number order. A missing part fails extraction. ZIP extraction rejects entries that normalize outside the target directory and stops when total extracted bytes exceed `4,000,000,000`. The reconstructed ZIP file is removed after extraction attempt. Report processing beyond archive reconstruction belongs to the compute-engine specification.

### 7.2 File layout and framing

`metadata.pb` is mandatory and contains one `Metadata` message. Each `component-<ref>.pb` is mandatory for every referenced component and contains one `Component` message. Missing mandatory metadata or component data is fatal when read.

Optional singleton files are:

- `changesets-<ref>.pb`: one `Changesets` message;
- `changed-lines-<ref>.pb`: one `ChangedLines` message;
- `analysis-cache2.pb`: opaque gateway cache blob described in section 8;
- `source-<ref>.txt`: source content;
- `sca/dependency-files.tar.xz`: dependency-file archive.

Optional length-delimited protobuf streams are:

- `activerules.pb` with `ActiveRule`;
- `adhocrules.pb` with `AdHocRule`;
- `context-props.pb` with `ContextProperty`;
- `telemetry-entries.pb` with `TelemetryEntry`;
- `analysis-warnings.pb` with `AnalysisWarning`;
- `issues-<ref>.pb` with `Issue`;
- `external-issues-<ref>.pb` with `ExternalIssue`;
- `measures-<ref>.pb` with `Measure`;
- `duplications-<ref>.pb` with `Duplication`;
- `cpd-text-block-<ref>.pb` with `CpdTextBlock`;
- `syntax-highlightings-<ref>.pb` with `SyntaxHighlightingRule`;
- `symbols-<ref>.pb` with `Symbol`;
- `coverages-<ref>.pb` with `LineCoverage`;
- `sgnificant-code-<ref>.pb` with `LineSgnificantCode`; the historical misspelling is part of the wire filename and type name;
- `issue-resolution-<ref>.pb` with `IssueResolution`.

An absent optional stream is an empty stream. An absent optional singleton is absent, not a default instance. `analysis.log` may be present as scanner diagnostic output; it is not protobuf input.

### 7.3 Proto3 message fields

Field numbers and types below are normative. Unlisted gaps remain unused by this pinned schema and must not be repurposed by a compatible 13.5.0.4089 producer.

- `Metadata`: 1 `int64 analysis_date`; 3 `string project_key`; 5 `int32 root_component_ref`; 6 `bool cross_project_duplication_activated`; 7 `map<string,QProfile> qprofiles_per_language`; 8 `map<string,Plugin> plugins_by_key`; 9 `string branch_name`; 10 `BranchType branch_type`; 11 `string reference_branch_name`; 12 `string relative_path_from_scm_root`; 13 `string scm_revision_id`; 14 `string pull_request_key`; 16 `string projectVersion`; 17 `string buildString`; 18 `string target_branch_name`; 21 `string new_code_reference_branch`; 22 `map<string,int32> analyzed_indexed_file_count_per_type`; 23 `map<string,int32> not_analyzed_indexed_file_count_per_type`.
- `Metadata.QProfile`: 1 `string key`; 2 `string name`; 3 `string language`; 4 `int64 rulesUpdatedAt`.
- `Metadata.Plugin`: 1 `string key`; 2 `int64 updatedAt`.
- `ContextProperty`: 1 `string key`; 2 `string value`.
- `TelemetryEntry`: 1 `string key`; 2 `string value`.
- `ActiveRule`: 1 `string rule_repository`; 2 `string rule_key`; 3 `Severity severity`; 4 `map<string,string> params_by_key`; 5 `int64 createdAt`; 6 `int64 updatedAt`; 7 `string q_profile_key`; 8 repeated `Impact impacts`.
- `ComponentLink`: 1 `ComponentLinkType type`; 2 `string href`.
- `Component`: 1 `int32 ref`; 3 `string name`; 4 `ComponentType type`; 5 `bool is_test`; 6 `string language`; 7 packed repeated `int32 child_ref`; 8 repeated `ComponentLink link`; 10 `string key`; 11 `int32 lines`; 12 `string description`; 13 `FileStatus status`; 14 `string project_relative_path`; 15 `bool markedAsUnchanged`; 16 `string old_relative_file_path`.
- `Measure`: 1 `string metric_key`; oneof value fields 2 `BoolValue boolean_value`, 3 `IntValue int_value`, 4 `LongValue long_value`, 5 `DoubleValue double_value`, or 6 `StringValue string_value`. `BoolValue`, `IntValue`, `LongValue`, and `DoubleValue` use field 1 for their typed value and field 2 `string data`; `StringValue` uses field 1 `string value`.
- `Issue`: 1 `string rule_repository`; 2 `string rule_key`; 3 `string msg`; 4 optional `Severity overriddenSeverity`; 5 `double gap`; 6 `TextRange text_range`; 7 repeated `Flow flow`; 8 `bool quickFixAvailable`; 9 optional `string ruleDescriptionContextKey`; 10 repeated `MessageFormatting msgFormatting`; 11 repeated `string codeVariants`; 12 repeated `Impact overriddenImpacts`; 13 repeated `string internal_tags`.
- `IssueResolution`: 1 `TextRange text_range`; 2 `IssueResolutionStatus status`; 3 repeated `string rule_keys`; 4 `string comment`.
- `ExternalIssue`: 1 `string engine_id`; 2 `string rule_id`; 3 `string msg`; 4 optional `Severity severity`; 5 `int64 effort`; 6 `TextRange text_range`; 7 repeated `Flow flow`; 8 optional `IssueType type`; 9 repeated `MessageFormatting msgFormatting`; 10 repeated `Impact impacts`; 11 optional `string cleanCodeAttribute`.
- `AdHocRule`: 1 `string engine_id`; 2 `string rule_id`; 3 `string name`; 4 `string description`; 5 optional `Severity severity`; 6 optional `IssueType type`; 7 optional `string cleanCodeAttribute`; 8 repeated `Impact defaultImpacts`.
- `IssueLocation`: 1 `int32 component_ref`; 2 `TextRange text_range`; 3 `string msg`; 4 repeated `MessageFormatting msgFormatting`.
- `MessageFormatting`: 1 `int32 start`; 2 `int32 end`; 3 `MessageFormattingType type`.
- `Flow`: 1 repeated `IssueLocation location`; 2 `string description`; 3 `FlowType type`.
- `Changesets`: 1 `int32 component_ref`; 2 `bool copy_from_previous`; 3 repeated `Changeset changeset`; 4 packed repeated `int32 changesetIndexByLine`. `Changeset` uses 1 `string revision`, 2 `string author`, and 3 `int64 date`.
- `Duplicate`: 1 `int32 other_file_ref`; 2 `TextRange range`.
- `Duplication`: 1 `TextRange origin_position`; 2 repeated `Duplicate duplicate`.
- `CpdTextBlock`: 1 `string hash`; 2 `int32 start_line`; 3 `int32 end_line`; 4 `int32 start_token_index`; 5 `int32 end_token_index`.
- `TextRange`: 1 `int32 start_line`; 2 `int32 end_line`; 3 `int32 start_offset`; 4 `int32 end_offset`.
- `LineSgnificantCode`: 1 `int32 line`; 2 `int32 start_offset`; 3 `int32 end_offset`.
- `ChangedLines`: 1 repeated `int32 line`.
- `Symbol`: 1 `TextRange declaration`; 2 repeated `TextRange reference`.
- `LineCoverage`: 1 `int32 line`; 2 `int32 conditions`; oneof 3 `bool hits`; oneof 5 `int32 covered_conditions`.
- `SyntaxHighlightingRule`: 1 `TextRange range`; 2 `HighlightingType type`.
- `AnalysisWarning`: 1 `string text`; 2 `int64 timestamp`.
- `Impact`: 1 `SoftwareQuality software_quality`; 2 `ImpactSeverity severity`.

### 7.4 Enum wire values

- `Severity`: `UNSET_SEVERITY=0`, `INFO=1`, `MINOR=2`, `MAJOR=3`, `CRITICAL=4`, `BLOCKER=5`.
- `IssueResolutionStatus`: `DEFAULT=0`, `FALSE_POSITIVE=1`.
- `IssueType`: `UNSET=0`, `CODE_SMELL=1`, `BUG=2`, `VULNERABILITY=3`, `SECURITY_HOTSPOT=4`.
- `MessageFormattingType`: `CODE=0`.
- `FlowType`: `UNDEFINED=0`, `DATA=1`, `EXECUTION=2`.
- `ImpactSeverity`: `ImpactSeverity_UNKNOWN_IMPACT_SEVERITY=0`, `ImpactSeverity_LOW=1`, `ImpactSeverity_MEDIUM=2`, `ImpactSeverity_HIGH=3`, `ImpactSeverity_INFO=4`, `ImpactSeverity_BLOCKER=5`.
- `SoftwareQuality`: `UNKNOWN_IMPACT_QUALITY=0`, `MAINTAINABILITY=1`, `RELIABILITY=2`, `SECURITY=3`.
- `Metadata.BranchType`: `UNSET=0`, `BRANCH=1`, `PULL_REQUEST=2`.
- `ComponentLinkType`: `UNSET=0`, `HOME=1`, `SCM=2`, `IGNORED_SCM_DEV=3`, `ISSUE=4`, `CI=5`.
- `ComponentType`: `UNSET=0`, `PROJECT=1`, `MODULE=2`, `DIRECTORY=3`, `FILE=4`.
- `FileStatus`: `UNAVAILABLE=0`, `SAME=1`, `CHANGED=2`, `ADDED=3`.
- `HighlightingType`: `UNSET=0`, `ANNOTATION=1`, `CONSTANT=2`, `COMMENT=3`, `STRUCTURED_COMMENT=5`, `KEYWORD=6`, `HIGHLIGHTING_STRING=7`, `KEYWORD_LIGHT=8`, `PREPROCESS_DIRECTIVE=9`.

Unknown proto3 fields must be preserved or ignored according to protobuf compatibility rules, but unknown enum handling must not be reinterpreted as a known semantic value. Exact field numbers, oneof membership, packed encoding, and stream framing are required.

## 8. Analysis cache

### 8.1 Retrieval

`GET /api/analysis_cache/get` requires `project`; optional `branch` selects a branch, otherwise the main branch is used. The caller needs project `SCAN`, project `ADMIN`, or global `SCAN`. Unknown project/branch follows component lookup failure behavior. A known branch with no cache returns not found with `No cache for given branch or pull request`.

Cache data is stored in gzip form. If any comma-separated `Accept-Encoding` token, after trimming, equals lowercase `gzip`, the server copies stored bytes unchanged and sets `Content-Encoding: gzip`. Otherwise it decompresses the stored stream and returns uncompressed bytes. Matching is exact and case-sensitive; quality parameters are not interpreted by this route.

The uncompressed payload is a length-delimited proto3 stream of `SensorCacheEntry`: field 1 `string key`, field 2 `bytes data`. Scanner production requires unique keys within one generated cache. The gateway treats keys and bytes as opaque plugin data.

### 8.2 Update and persistence

When a successfully processed report contains `analysis-cache2.pb`, cache persistence replaces the target branch's existing cache with that gzip blob in one database transaction. If the report has no cache file, the prior cache is left unchanged. An I/O error while reading the cache is logged by the cache persistence step; it does not create a partial replacement.

Storage has one row per branch UUID. Concurrent replacements are serialized by database transaction/primary-key behavior; retrieval observes a committed old or new blob, never an intentionally merged cache. Project or branch deletion removes its cache through purge behavior.

### 8.3 Clearing and retention

`POST /api/analysis_cache/clear` is internal and requires global `ADMINISTER` permission. Optional `project` limits clearing to all branches of a project. Optional `branch` limits it to one branch and is invalid without `project`. With neither parameter all scanner cache is removed. Unknown project or branch results in no matching removal, not creation of an error cache. Success returns no content.

Internal setting `sonar.dbcleaner.daysBeforeDeletingScannerCache` controls retention. The default is 7 days; missing, zero, or negative values fall back to 7. Cleanup is scheduled once per day with the first run at the next UTC midnight. Cache not associated with a sufficiently recent analysis is removed. This scheduler owns cache retention only; it does not define compute-task processing.

## 9. SARIF 2.1.0 compatibility

The platform exposes a typed SARIF 2.1.0 model generated from the bundled OASIS errata-01 JSON Schema. Root `version` accepts only `2.1.0`; the schema requires `version` and `runs` and disallows additional root properties. Consumers requiring complete field constraints must use the bundled `sonar-sarif/src/main/resources/sarif/sarif-schema-2.1.0.json` as the normative vocabulary.

`SarifSerializer` provides two operations:

- serialize a typed SARIF 2.1.0 object to pretty-printed JSON;
- deserialize a filesystem path into the typed SARIF 2.1.0 model.

Deserialization includes source locations in parser errors and classifies expected failures:

- `SYNTAX`: invalid JSON syntax or non-UTF-8 input;
- `VALUE`: numeric overflow or type mismatch reported as out-of-range/overflow mapping failure;
- `MAPPING`: schema-model mapping failure, including unsupported SARIF version;
- `FILE_NOT_FOUND`: missing local report file.

A classified exception includes category, message, cause, and parser line number when available; absent line information is `-1`. Unsupported version message identifies the submitted version. Other I/O failures are unclassified illegal-state failures. Serialization mapping failure is an illegal state.

The serializer does not fetch the URI in `$schema` and does not make SARIF a network trust source. The pinned mapper creates a typed object; it must not be advertised as proof that every JSON Schema constraint was validated unless a separate validator actually ran.

There is no gateway endpoint that accepts raw SARIF as an alternative to the scanner-report ZIP. Mapping SARIF runs, rules, results, levels, regions, and paths into scanner issues is scanner-engine execution and is explicitly outside this specification. Gateway compatibility begins after those observations have been represented as `ExternalIssue`, `AdHocRule`, `IssueLocation`, `Flow`, and related scanner-report messages.

## 10. Failure, recovery, and partial results

Successfully computed v2 engine metadata is process-cached, so changing bytes after a successful metadata response requires restart before SHA-256 is recomputed. A not-found lookup is not cached: adding a previously missing engine JAR can satisfy the next v2 metadata request without restart. The legacy batch index is built separately at startup and remains unchanged until restart. JRE metadata is loaded at component initialization; invalid packaged metadata prevents successful initialization.

A plugin or engine download interrupted before completion produces no valid checksum match at the client. Clients must verify the advertised SHA-256 or `Sonar-MD5` as applicable before cache reuse. Checksums detect corruption but do not authenticate publisher identity.

Detected request-validation, permission, temporary-file, database, split, persistence, or queue-submission failures produce no success acknowledgement. The gateway does not perform a final completeness check on stored report parts; configuration overflow can therefore acknowledge a task with zero parts, whose later compute failure is represented by task status. Once any acknowledgement is returned, later report-format or compute failure does not change the upload response.

A missing persisted report part, corrupt ZIP, archive traversal, decompressed-size excess, missing `metadata.pb`, missing referenced component file, malformed protobuf, or incompatible protocol fails downstream report consumption. The gateway must retain enough task identity for compute failure reporting; it must not guess defaults for malformed mandatory report content.

Optional report streams may be absent and are read as empty. This is valid partial content, not failure. Optional singleton data may be absent as described in section 7. Cache absence returns 404 and scanner engine 13.5.0.4089 treats that as an empty previous cache; other cache HTTP failures abort cache loading.

## 11. Security and trust boundaries

- Bootstrap JARs and JREs are executable content. SHA-256/MD5 support integrity and cache identity; transport authentication and trusted distribution origin remain required.
- Plugin download exposes only artifacts already accepted by plugin runtime. Filename-based legacy engine download enforces canonical containment.
- Report upload requires scan authority, and project creation requires provisioning authority plus future scan access. A successful upload cannot grant project permission.
- Uploaded ZIPs are untrusted. Extraction prevents path escape and caps total expanded data at 4,000,000,000 bytes. The HTTP layer and deployment must independently constrain request size, connection time, and temporary/durable storage; no lower gateway upload cap was observed in the pinned submit action.
- Report parts are opaque until compute consumption. Upload acknowledgement must not claim semantic validation.
- Scanner cache is branch-scoped and protected by scan/admin permissions. Cache bytes are plugin-controlled opaque data and must not be executed by the gateway.
- SARIF reads local files only. `$schema`, artifact URIs, and result links are data and are not dereferenced by the serializer.
- Secured settings values are withheld from scanner bootstrap responses.

## 12. Compatibility limits

- Scanner report format is exactly coupled to scanner protocol 13.5.0.4089. It is not a stable cross-release API.
- Legacy `/batch` and proto2 Web API compatibility remains required for clients that use it, even where v2 JSON/bootstrap routes exist.
- MD5 must remain available where named by legacy protocol, but must never be described as signature verification.
- Community Build behavior only is specified. Commercial branch, pull-request, SCA, or proprietary analyzer behavior must not be inferred from fields that exist in shared messages.
- Scanner engine execution, report construction choices, SARIF-to-issue mapping, and compute semantics remain out of gateway scope.

## 13. Acceptance scenarios

### 13.1 V2 engine bootstrap

Given the pinned engine JAR in `<home>/lib/scanner`, when a client requests JSON from `/api/v2/analysis/engine`, it receives filename and matching SHA-256. Requesting the same path as `application/octet-stream` returns identical JAR bytes. With no JAR, metadata returns not found; adding a JAR allows the next request to succeed because failure was not cached. After successful metadata computation, changing JAR bytes does not change the cached SHA-256 until restart.

### 13.2 Legacy engine bootstrap traversal

Given `/batch/index` lists one JAR, when a client requests that exact `name`, it receives `application/java-archive`. A missing target or a name whose canonical target escapes the scanner root returns not found and no outside file is read. A traversal-containing name that canonicalizes inside the root is served. An existing contained file that was not listed, including a nested or non-JAR file, is also returned; index membership and path-string form are not authorization boundaries.

### 13.3 Filtered JRE discovery

Given default configuration, when `os=darwin&arch=arm64` is requested, only metadata ID `074703b3-f1d5-48c8-b7f3-deff34fd8732` is returned. With `sonar.jreAutoProvisioning.disabled=true`, collection discovery is empty.

### 13.4 Plugin metadata and download

Given an authenticated scanner principal and an installed Java plugin, when installed-plugin metadata is requested, its key, filename, MD5 hash, type, update time, and required language keys are present. Download by that key returns the same bytes and MD5 in `Sonar-MD5`. Unknown key returns not found.

### 13.5 Active rules for absent project

Given a project key that does not resolve, when active rules are requested, the gateway returns default active rules rather than not found. Rule selection itself follows project-configuration policy.

### 13.6 Project repository authorization

Given a caller with project `SCAN`, when `/batch/project.protobuf` is requested for an existing branch, response field 5 maps paths to prior source hashes and revisions. A caller without project or global scan permission is rejected.

### 13.7 Small report submission

Given a permitted caller, valid project, and ZIP smaller than 450 MiB under default configuration, when the multipart request is submitted, one database part is committed, one report task is submitted, and response fields `taskId` and `projectId` are returned. No claim about completed analysis is made.

### 13.8 Split report submission

Given a report larger than the configured part threshold, when upload succeeds, its bytes are split into consecutive one-based parts and concatenating those parts exactly reproduces the submitted ZIP. The acknowledgement reports one task, not one task per part.

Given `sonar.report.partMaxSizeMBytes=0` and a nonempty report, submission fails on division by zero without acknowledgement. Given value `2048` and a report of exactly 2 GiB, signed overflow can record zero parts and still return an acknowledgement whose compute task later fails. A compatible deployment constrains the setting to 1 through 2047.

### 13.9 Invalid characteristics

Given two `characteristic` values with key `branch`, or a value without `=`, when submission is attempted, the request is rejected before acknowledgement. A unique well-formed unknown key is ignored.

### 13.10 Corrupt archive after acknowledgement

Given permitted upload of bytes that are not a valid ZIP, when submission storage succeeds, the gateway may acknowledge a task because it does not parse content during upload. Later extraction fails that compute task. No analysis result is published.

### 13.11 ZIP expansion attack

Given a ZIP whose entry escapes the target or whose expanded bytes exceed 4,000,000,000, when report extraction begins, extraction fails, no outside path is written, and compute failure records the report error.

### 13.12 Cache gzip negotiation

Given a stored branch cache, when `Accept-Encoding` contains exact token `gzip`, response carries stored gzip bytes and `Content-Encoding: gzip`. Without that token, response carries the decompressed length-delimited `SensorCacheEntry` stream.

### 13.13 Missing and retained cache

Given no cache for a known branch, retrieval returns 404. Given a prior cache and a later successfully processed report with no `analysis-cache2.pb`, the prior cache remains available. Given a later report with cache data, the replacement becomes visible atomically after commit.

### 13.14 Cache administration

Given a global administrator, `POST /api/analysis_cache/clear` with one project and branch removes only that branch cache and returns no content. Supplying branch without project is rejected. A nonadministrator is rejected.

### 13.15 Protobuf compatibility

Given a report with required metadata, referenced component files, correct field numbers, and length-delimited optional streams, when consumed by protocol 13.5.0.4089 it can be decoded. Renumbering `Metadata.project_key` away from field 3 or writing streamed issues as one undelimited aggregate is incompatible and fails acceptance.

### 13.16 SARIF version failure

Given a local SARIF file whose `version` is not `2.1.0`, when deserialized, failure category is `MAPPING` and message identifies unsupported version. Invalid JSON yields `SYNTAX` with a parser line when available. No URI from the document is fetched.

## 14. Provenance index

- Release and artifact pins: `manifest/release-baseline.md`; `manifest/component-inventory.md`; `manifest/license-map.md`; pinned `gradle.properties`; root `build.gradle`.
- Scanner engine v2 bootstrap: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/analysis/controller/ScannerEngineController.java`; `DefaultScannerEngineController.java`; `service/ScannerEngineHandlerImpl.java`; `response/EngineInfoRestResponse.java`.
- Legacy engine bootstrap: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/batch/BatchIndex.java`; `IndexAction.java`; `FileAction.java`.
- Version routes: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/analysis/controller/VersionController.java`; `DefaultVersionController.java`; scanner artifact `org/sonar/scanner/platform/DefaultServer.java`.
- JRE routes, filters, and metadata: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/analysis/controller/JresController.java`; `DefaultJresController.java`; `service/JresHandlerImpl.java`; `response/JreInfoRestResponse.java`; `common/model/OS.java`; `Arch.java`; `sonar-application/src/main/resources/jres-metadata.json`; `sonar-core/src/main/java/org/sonar/core/config/CorePropertyDefinitions.java`.
- Plugin metadata and download: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/plugins/ws/InstalledAction.java`; `DownloadAction.java`; `PluginWSCommons.java`; `sonar-ws/src/main/protobuf/ws-plugins.proto`; `server/sonar-webserver-api/src/main/java/org/sonar/server/plugins/PluginFilesAndMd5.java`.
- Active rules: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/analysis/controller/ActiveRulesController.java`; `service/ActiveRulesHandlerImpl.java`; `server/sonar-server-common/src/main/java/org/sonar/server/rule/ActiveRuleRestReponse.java`.
- Project repository: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/batch/ProjectAction.java`; `ProjectDataLoader.java`; `sonar-ws/src/main/protobuf/ws-batch.proto`.
- Settings bootstrap: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/setting/ws/ValuesAction.java`; scanner artifact `org/sonar/scanner/repository/settings/AbstractSettingsLoader.java`.
- Other scanner referential consumers: scanner artifact `org/sonar/scanner/repository/DefaultQualityProfileLoader.java`; `DefaultMetricsRepositoryLoader.java`; `DefaultNewCodePeriodLoader.java`; `language/DefaultLanguagesLoader.java`; `rule/DefaultActiveRulesLoader.java`; `repository/featureflags/DefaultFeatureFlagsLoader.java`.
- Protobuf/JSON negotiation: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/WsUtils.java`; `sonar-ws/src/main/protobuf/ws-ce.proto`; `ws-plugins.proto`; `ws-batch.proto`.
- Submission and report parts: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/SubmitAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/queue/ReportSubmitter.java`; `sonar-core/src/main/java/org/sonar/core/config/CorePropertyDefinitions.java`; `sonar-core/src/main/java/org/sonar/core/ce/CeTaskCharacteristics.java`.
- Report ZIP production interoperability: scanner artifact `org/sonar/scanner/report/ReportPublisher.java`.
- Report archive layout and protobuf framing: protocol artifact `org/sonar/scanner/protocol/output/FileStructure.java`; `ScannerReportReader.java`; `ScannerReportWriter.java`.
- Report messages and enums: protocol artifact `org/sonar/scanner/protocol/output/ScannerReport.java`; `org/sonar/scanner/protocol/Constants.java`.
- Extraction safety and ceiling: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/ExtractReportStep.java`; plugin API 13.8.0.4399 `org/sonar/api/utils/ZipUtils.java`.
- Cache API and persistence: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/scannercache/ws/GetAction.java`; `ClearAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/scannercache/ScannerCache.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/PersistScannerAnalysisCacheStep.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/scannercache/ScannerAnalysisCacheDao.java`.
- Cache wire data and consumer behavior: scanner artifact `org/sonar/scanner/cache/WriteCacheImpl.java`; `DefaultAnalysisCacheLoader.java`; protocol artifact `org/sonar/scanner/protocol/internal/ScannerInternal.java`.
- Cache retention: `sonar-core/src/main/java/org/sonar/core/config/PurgeConstants.java`; `server/sonar-ce/src/main/java/org/sonar/ce/analysis/cache/cleaning/AnalysisCacheCleaningSchedulerImpl.java`.
- SARIF schema and notice: `sonar-sarif/src/main/resources/sarif/sarif-schema-2.1.0.json`; `sonar-sarif/src/main/resources/sarif/README.md`.
- SARIF serializer and errors: `sonar-core/src/main/java/org/sonar/core/sarif/SarifSerializer.java`; `SarifSerializerImpl.java`; `SarifDeserializationException.java`.
