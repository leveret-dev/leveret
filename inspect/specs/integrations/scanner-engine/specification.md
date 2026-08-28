# Scanner Engine Integration Specification

## 1. Identity and provenance

This specification covers the embedded Community scanner engine bundled with SonarQube Community Build `26.8.0.126808`.

- Product artifact: `org.sonarsource.scanner.engine:sonar-scanner-engine-community:13.5.0.4089`.
- Authoritative clean-room source: `sonar-scanner-engine-community-13.5.0.4089-sources.jar`.
- Source-artifact SHA-256: `e29ebcc0e7102825dfa0990dbb0cb403031570913966c058d6f6253f7c8c9564`.
- POM-declared SCM URL: `https://github.com/SonarSource/sonar-scanner-engine`. The repository and its GitHub API endpoint currently return 404, so this URL is provenance metadata, not a retrievable source tree.
- Git provenance limitation: the release POM publishes no SCM tag, revision, or commit, and no matching immutable Git tag or commit is available for `13.5.0.4089`. The hashed source artifact is the only retrievable authoritative source; no repository branch can substitute for it.
- Product pin: SonarQube `gradle.properties` sets `scannerEngineVersion=13.5.0.4089`, and `sonar-application/build.gradle` packages `sonar-scanner-engine-community` as the scanner engine.
- License: `LGPL-3.0-or-later`. The POM declares GNU LGPL 3, and production source headers permit version 3 or later. This is a weak-copyleft component and requires a full clean-room specification.

Provenance: official POM at `https://repo1.maven.org/maven2/org/sonarsource/scanner/engine/sonar-scanner-engine-community/13.5.0.4089/sonar-scanner-engine-community-13.5.0.4089.pom`; official checksum at `https://repo1.maven.org/maven2/org/sonarsource/scanner/engine/sonar-scanner-engine-community/13.5.0.4089/sonar-scanner-engine-community-13.5.0.4089-sources.jar.sha256`; SonarQube paths `gradle.properties` and `sonar-application/build.gradle`; source-artifact paths `org/sonar/scanner/bootstrap/ScannerMain.java` and `org/sonar/scanner/bootstrap/SpringGlobalContainer.java`.

## 2. Purpose

The scanner engine turns a configured source checkout into a version-coupled scanner report for a SonarQube server. It obtains server-owned settings and analysis metadata, discovers and indexes files, loads server-selected scanner plugins, executes their scanner-side extensions, gathers issues and analysis data, computes shared scanner results such as SCM blame and duplications, builds the report, and submits it to the compute-engine queue.

The engine is server-directed. The configured SonarQube server supplies plugin metadata, analyzer binaries, settings, languages, quality profiles, active rules, metrics, feature flags, prior file metadata, and optional analysis cache data. The engine does not independently choose rule policy or persist final analysis results.

Provenance: `org/sonar/scanner/bootstrap/SpringGlobalContainer.java`; `org/sonar/scanner/bootstrap/SpringScannerContainer.java`; `org/sonar/scanner/scan/SpringProjectScanContainer.java`; `org/sonar/scanner/report/ReportPublisher.java`.

## 3. Scope and exclusions

### 3.1 Included behavior

This specification owns:

- the engine process input, logging, success/failure status, and per-run lifecycle;
- scanner, environment, server, project, and module configuration merging;
- server bootstrap requests needed to conduct analysis;
- plugin selection, verified download caching, loading, scanner-side extension execution, and unloading;
- project and module model construction;
- source and test file discovery, filtering, language recognition, metadata generation, and status detection;
- ordered module sensors, project sensors, shared scanner processing, report steps, upload, optional quality-gate wait, and post-jobs;
- scanner-side storage validation for analyzer results;
- generic coverage, generic test-execution, generic external-issue, and SARIF imports built into the engine;
- Git and SVN SCM selection, ignore handling, changed-file data, revision, and blame publication;
- analysis cache consumption and production;
- duplication computation from analyzer-provided tokens;
- scanner report metadata and local `report-task.txt` production;
- failure, partial-result, cleanup, concurrency, and security behavior at scanner boundaries.

### 3.2 Excluded behavior

The following are outside this specification:

- standalone Scanner CLI, Maven, Gradle, .NET, and NPM launcher products, including their argument syntax, installation, JRE provisioning, and build-tool integration;
- analyzer-specific parsing, semantic models, rule catalogs, metrics, highlighting, symbols, coverage formats, and external-report adapters, which belong to analyzer specifications;
- plugin compatibility policy and classloader isolation details, owned by `platform/plugin-extension-runtime/`;
- scanner bootstrap download, HTTP wire serialization, report protobuf schema, upload authorization, and report storage, owned by `platform/scanner-gateway/`;
- compute-engine queueing, report interpretation, persistence, issue tracking, metric aggregation, and quality-gate evaluation, owned by `platform/compute-engine/`, `platform/project-configuration/`, and `platform/analysis-results/`;
- server implementations of Git hosting, identity, project creation, and permissions;
- commercial branch, pull-request, portfolio, and SCA behavior;
- internals of downloaded analyzer plugins, Git, SVN, SARIF producers, and coverage producers.

## 4. Dependencies and owned contracts

### 4.1 Required dependencies

- A compatible SonarQube scanner gateway supplies version, settings, plugin metadata and files, analysis metadata, report upload, and task-status APIs.
- Plugin runtime metadata identifies scanner-side extensions and whether a plugin is bundled or external.
- Project configuration supplies project identity, server settings, profiles, rules, metrics, and new-code policy.
- Analyzers supply file-language behavior and sensor outputs through the scanner plugin API.
- Compute engine accepts the scanner report and returns a task identifier.
- A Java runtime of major version 21 or newer is required. A parseable lower major version causes fail-fast termination. A malformed `java.version` value is not itself rejected. A 32-bit runtime is accepted but produces an analysis warning.
- Local filesystem access is required for the checkout, working directory, user cache, optional reports, key stores, trust stores, and report metadata.

### 4.2 Contracts owned here

The engine owns orchestration and the conversion of scanner-plugin API observations into scanner-report domains. Accepted sensor observations include measures, ordinary and external issues, ad hoc rules, syntax highlighting, symbol declarations and references, line and branch coverage, CPD tokens, significant-code ranges, issue resolutions, context properties, telemetry, cache entries, test execution, and registered analysis-data streams.

The engine defines no analyzer rule keys and no independent metric catalog. It loads server metrics and rejects unknown metrics, metrics forbidden to sensors, duplicate measures on one component, duplicate highlighting or symbol tables for one file, and unsupported measure value types. It ignores deprecated or server-computed metrics where the scanner contract says they are no longer analyzer-owned.

Provenance: `org/sonar/scanner/bootstrap/JREDeprecationChecker.java`; `org/sonar/scanner/sensor/DefaultSensorStorage.java`; `org/sonar/scanner/report/MetadataPublisher.java`; `manifest/dependency-map.md`.

## 5. Engine invocation interface

### 5.1 Input

The embedded entry point reads one UTF-8 JSON value from standard input. The top-level `scannerProperties` field, when present, is an array of objects with string `key` and `value` fields.

- A null top-level value, an absent `scannerProperties` field, or a null array yields no input properties.
- A null array item, an item with both fields null, a null key, or a null value is ignored with a warning.
- Duplicate keys are warned about; the last array value becomes effective.
- Malformed JSON fails the run.
- `sonar.scanner.app` and `sonar.scanner.appVersion` identify the launcher environment in the scanner user agent and telemetry. They are metadata, not alternate engine modes.

### 5.2 Output and process status

The engine sends formatted log events to standard output. It logs startup, Java runtime identity, analysis stages, warnings, total duration, and success. It returns status `0` only after the full configured lifecycle completes; any uncaught failure returns status `1`.

User-oriented configuration and authorization failures are logged without a stack trace at normal verbosity. Debug mode includes the causal stack. Unexpected failures always include a stack trace. Logging is stopped during final cleanup.

### 5.3 Embedded Java facade

The artifact also exposes the legacy scanner API facade `org.sonar.batch.bootstrapper.Batch`. Its builder accepts a global string-property map, launcher environment information, externally supplied components, an optional log callback, and a switch controlling whether the engine configures logging. Environment properties are added to the supplied global map under the same non-overwrite rules as the process entry point.

Execution is synchronized on one facade instance. It creates and runs the same global scanner container and returns the facade after success. Runtime failures propagate; at nonverbose level, a nested user-facing `MessageException` is unwrapped and returned as the effective exception. Externally supplied components participate in container extension discovery. This facade is an engine integration contract only; behavior of products that invoke it remains excluded.

Provenance: `org/sonar/scanner/bootstrap/ScannerMain.java`; `org/sonar/batch/bootstrapper/Batch.java`; `org/sonar/batch/bootstrapper/EnvironmentInformation.java`; `org/sonar/batch/bootstrapper/LoggingConfiguration.java`; `org/sonar/batch/bootstrapper/LogOutput.java`.

## 6. Configuration model

### 6.1 Input and environment precedence

The JSON `scannerProperties` array has priority over environment-derived properties. The engine then processes environment variables as follows:

1. Every nonempty `SONAR_SCANNER_` suffix except `SONAR_SCANNER_JSON_PARAMS` is lowercased by underscore-separated segment and mapped to a `sonar.scanner.` camel-case property. It is added only when the input did not already define that property.
2. `SONAR_SCANNER_JSON_PARAMS` may contain a JSON string-to-string property map. It adds only missing properties.
3. Deprecated `SONARQUBE_SCANNER_PARAMS` is used only when `SONAR_SCANNER_JSON_PARAMS` is absent. If both differ, the deprecated value is ignored with a warning.
4. `SONAR_TOKEN` is a dedicated credential fallback. `sonar.token` overrides it; deprecated `sonar.login` is used only when neither token source is nonblank.
5. `sonar.userHome` overrides `SONAR_USER_HOME`, which overrides the operating-system user home plus `.sonar`.

Encrypted scanner-property values are decrypted before configuration becomes immutable. Their use emits a deprecation warning. Missing or incorrect secret material fails analysis rather than silently retaining ciphertext.

Provenance: `org/sonar/scanner/bootstrap/EnvironmentConfig.java`; `org/sonar/scanner/bootstrap/ScannerProperties.java`; `org/sonar/scanner/bootstrap/SonarUserHomeProvider.java`; `org/sonar/scanner/http/ScannerWsClientProvider.java`.

### 6.2 Server, project, and module precedence

Configuration layers are applied from lower to higher precedence:

- Global effective configuration: global server settings, then scanner input properties.
- Project effective configuration: extension-provided additional properties, global server settings, project server settings, then root project scanner properties.
- Module effective configuration: extension-provided additional properties, global server settings, project server settings, then scanner properties inherited from root through the module ancestry; descendant values override ancestors.

Properties under `sonar.global.` are accepted only from global server settings. A same-named scanner, project, module, or extension value is discarded in favor of the server value.

Inherited server settings are normally omitted from the project map. Language suffix and filename-pattern settings ending in `.file.suffixes` or `.file.patterns` remain available even when inherited. Multi-value server settings become comma-separated values; property sets become indexed child properties plus an index list.

Provenance: `org/sonar/scanner/bootstrap/GlobalConfigurationProvider.java`; `org/sonar/scanner/scan/ProjectConfigurationProvider.java`; `org/sonar/scanner/scan/ModuleConfigurationProvider.java`; `org/sonar/scanner/scan/SonarGlobalPropertiesFilter.java`; `org/sonar/scanner/repository/settings/AbstractSettingsLoader.java`.

### 6.3 Public configuration keys and defaults

| Area | Keys and required behavior |
|---|---|
| Server and credentials | `sonar.host.url` defaults to `http://localhost:9000`. `sonar.token` is preferred; `SONAR_TOKEN` and then deprecated `sonar.login` are fallbacks. `sonar.password` is rejected. |
| Engine identity and logging | `sonar.scanner.app` and `sonar.scanner.appVersion` identify the invoking product. `sonar.verbose=true`, `sonar.log.level` of `DEBUG` or `TRACE`, and deprecated `sonar.log.profilingLevel` of `BASIC` or `FULL` enable verbose engine logging. |
| HTTP timing | `sonar.scanner.connectTimeout` defaults to 5 seconds. `sonar.scanner.socketTimeout` defaults to legacy `sonar.ws.timeout`, whose default is 60 seconds. `sonar.scanner.responseTimeout` defaults to zero, meaning no whole-response deadline in this client contract. Values are seconds; ISO-8601 duration syntax is also accepted by the engine. `sonar.ws.report.timeout` defaults to 60 seconds for report upload writes. |
| Proxy | `sonar.scanner.proxyHost`; `sonar.scanner.proxyPort`, defaulting to 443 for an HTTPS server URL and 80 otherwise; `sonar.scanner.proxyUser`; and `sonar.scanner.proxyPassword`. Scanner proxy credentials override corresponding JVM proxy credential properties. JVM HTTP proxy host handling remains available through the HTTP stack. |
| TLS | `sonar.scanner.keystorePath`, `sonar.scanner.keystorePassword`, `sonar.scanner.truststorePath`, `sonar.scanner.truststorePassword`, and `sonar.scanner.skipSystemTruststore`. Default stores are `ssl/keystore.p12` and `ssl/truststore.p12` under Sonar user home. JVM default trust material is always loaded; operating-system trust material is also loaded unless explicitly skipped. |
| Cache and plugins | `sonar.userHome`; `sonar.plugins.downloadOnlyRequired`, default `true`; `sonar.plugins.download.timeout`, default 300 seconds; and `sonar.analysisCache.enabled`, default `true`. |
| Project model | `sonar.projectKey` is mandatory. `sonar.projectBaseDir` defaults to the current absolute directory. `sonar.projectName`, `sonar.projectVersion`, `sonar.projectDescription`, `sonar.buildString`, `sonar.projectDate`, `sonar.links.homepage`, `sonar.links.ci`, `sonar.links.issue`, and `sonar.links.scm` populate report metadata when present. `sonar.working.directory` defaults to `.scannerwork` under the project base. Legacy `sonar.modules` and per-child `sonar.moduleKey` build a module tree. |
| Sources and tests | `sonar.sources` and `sonar.tests` accept comma-separated files or directories but no `*` or `**`. If a leaf project has no explicit sources, no child modules, and no tests, its base directory is the main-source default. `sonar.inclusions`, `sonar.exclusions`, `sonar.test.inclusions`, and `sonar.test.exclusions` apply path patterns. `sonar.filesize.limit` defaults to 20 MB. `sonar.scanner.excludeHiddenFiles` defaults to `false`. `sonar.sourceEncoding` supplies the user encoding considered by metadata detection. `sonar.preloadFileMetadata` defaults to `false`. |
| Language detection | `sonar.lang.patterns.<languageKey>` overrides server-provided suffix and filename patterns for that language. Server properties such as `sonar.java.file.suffixes`, `sonar.javascript.file.suffixes`, and their `.file.patterns` counterparts supply defaults. |
| Coverage and duplication exclusions | `sonar.coverage.exclusions` and `sonar.cpd.exclusions` mark indexed files as excluded from those computations. `sonar.cpd.<languageKey>.minimumTokens` defaults to 100 for non-Java duplicate filtering. `sonar.cpd.<languageKey>.minimumLines` defaults to 10, with observed legacy defaults of 20 for ABAP and 30 for COBOL. |
| SCM | `sonar.scm.disabled`, `sonar.scm.provider`, `sonar.scm.exclusions.disabled`, `sonar.scm.forceReloadAll`, and `sonar.scm.revision`. The force-reload default is `false`. |
| Report lifecycle | `sonar.scanner.keepReport` defaults to `false`; verbose mode also keeps it. `sonar.scanner.metadataFilePath` must be absolute when set; otherwise metadata goes to `report-task.txt` in the work directory. `sonar.qualitygate.wait` defaults to `false`; `sonar.qualitygate.timeout` defaults to 300 seconds. |
| Generic imports | `sonar.coverageReportPaths`, `sonar.testExecutionReportPaths`, deprecated `sonar.genericcoverage.unitTestReportPaths`, `sonar.externalIssuesReportPaths`, and `sonar.sarifReportPaths`. Paths may be absolute or project-relative as resolved by the scanner filesystem. |
| CI | `sonar.ci.autoconfig.disabled` defaults to `false`; setting it to `true` disables CI auto-detection. Detected SCM revision, DevOps URL, and project identifier may contribute to report or submitted-task metadata. |
| Removed modes | `sonar.task` defaults to `scan` and accepts only `scan`. `sonar.analysis.mode` defaults to `publish` and accepts only `publish`. Removed task `views`, any other task, preview analysis, deprecated `sonar.branch`, and `sonar.password` fail fast. |

The Community engine artifact registers no `BranchConfigurationLoader` or `ProjectBranchesLoader`. Without an extension, it uses main-branch defaults and an empty branch list. Hidden `sonar.branch.name` and `sonar.pullrequest.*` definitions therefore do not establish Community branch or pull-request analysis behavior. This specification records only the default and the explicit rejection of legacy `sonar.branch`.

CI detection covers AppVeyor, AWS CodeBuild, Azure DevOps, Bamboo, Bitbucket Pipelines, Bitrise, Buildkite, CircleCI, Cirrus CI, Codemagic, Drone, GitHub Actions, GitLab CI, Jenkins, Semaphore, and Travis CI. No match yields empty CI metadata. More than one match fails analysis and directs the operator to correct environment variables or disable auto-configuration.

Provenance: `org/sonar/scanner/http/ScannerWsClientProvider.java`; `org/sonar/scanner/scan/ScanProperties.java`; `org/sonar/scanner/scan/ProjectReactorBuilder.java`; `org/sonar/scanner/scan/branch/BranchConfigurationProvider.java`; `org/sonar/scanner/scan/branch/ProjectBranchesProvider.java`; `org/sonar/scanner/scan/filesystem/HiddenFilesVisitorHelper.java`; `org/sonar/scanner/scan/filesystem/LanguageDetection.java`; `org/sonar/scanner/cache/AnalysisCacheEnabled.java`; `org/sonar/scanner/bootstrap/PluginFiles.java`; `org/sonar/scanner/cpd/CpdSettings.java`; `org/sonar/scanner/sensor/DefaultSensorStorage.java`; `org/sonar/scanner/ci/CiConfigurationProvider.java`; `org/sonar/scanner/bootstrap/SpringScannerContainer.java`; SonarQube path `sonar-core/src/main/java/org/sonar/core/config/ScannerProperties.java`.

## 7. Server-facing interfaces

The engine consumes the following observable server paths. Media type and response structure remain scanner-gateway contracts; this specification records when and why the engine uses them.

| Path | Engine use |
|---|---|
| `api/server/version` | Obtain server version and establish server identity. |
| `api/plugins/installed` | List plugin key, content hash, update time, type, and optional required-language set. |
| `api/plugins/download` | Download one plugin by `plugin`; require the `Sonar-MD5` response header and verify downloaded bytes before caching. |
| `api/settings/values.protobuf` | Load global settings; with `component`, load project settings. A 404 produces an empty setting map. |
| `/api/languages/list` | Load server-supported language keys and names before applying configured suffix and filename patterns. |
| `/api/qualityprofiles/search.protobuf` | Load project profiles; a project 404 falls back to default profiles. Absence of any resulting profile is fatal. |
| `/api/v2/analysis/active_rules` | Load active rules for `projectKey`, including rule key, profile, language, parameters, timestamps, impacts, template key, and deprecated keys. |
| `/api/metrics/search` | Load all metric pages with page size 500. |
| `/batch/project.protobuf` | Load prior file hashes and SCM revisions by project and optional reference branch. A 404 continues with no prior repository data. |
| `/api/new_code_periods/show.protobuf` | Resolve the configured project and branch new-code definition when needed. |
| `/api/features/list` | Load enabled feature flags. |
| `api/analysis_cache/get` | Load prior sensor cache by project and optional reference branch, accepting gzip. A 404 means no cache. |
| `api/ce/submit` | Upload the ZIP report as multipart field `report` with project key, project name, and optional repeated task characteristics. Parse the returned task identifier. |
| `api/ce/task` | Poll submitted task status when quality-gate waiting is enabled. |
| `api/qualitygates/project_status` | Obtain final gate status by analysis identifier after successful compute processing. |

Authentication failures are normalized before endpoint-specific parsing. HTTP 401 distinguishes missing from rejected credentials; HTTP 403 reports lack of analyze or create permission; a JSON error from HTTP 400 is surfaced. Other unsuccessful responses remain HTTP failures. A successful response carrying `SonarQube-Authentication-Token-Expiration` within seven days of expiry produces one analysis warning per expiry date.

Provenance: `org/sonar/scanner/platform/DefaultServer.java`; `org/sonar/scanner/bootstrap/ScannerPluginInstaller.java`; `org/sonar/scanner/bootstrap/PluginFiles.java`; `org/sonar/scanner/repository/settings/AbstractSettingsLoader.java`; `org/sonar/scanner/repository/language/DefaultLanguagesLoader.java`; `org/sonar/scanner/repository/DefaultQualityProfileLoader.java`; `org/sonar/scanner/rule/DefaultActiveRulesLoader.java`; `org/sonar/scanner/repository/DefaultMetricsRepositoryLoader.java`; `org/sonar/scanner/repository/DefaultProjectRepositoriesLoader.java`; `org/sonar/scanner/repository/DefaultNewCodePeriodLoader.java`; `org/sonar/scanner/repository/featureflags/DefaultFeatureFlagsLoader.java`; `org/sonar/scanner/cache/DefaultAnalysisCacheLoader.java`; `org/sonar/scanner/report/ReportPublisher.java`; `org/sonar/scanner/qualitygate/QualityGateCheck.java`; `org/sonar/scanner/http/DefaultScannerWsClient.java`.

## 8. Processing lifecycle and state transitions

### 8.1 Bootstrap

1. The engine configures output and verbosity, parses JSON input, merges environment properties, decrypts supported encrypted values, and creates immutable scanner properties.
2. It constructs an authenticated HTTP client and local user-home directories, loads server version and global settings, and validates Java compatibility.
3. It requests the plugin index. With `sonar.plugins.downloadOnlyRequired=true`, it first loads plugins not restricted to particular languages. Otherwise it downloads every listed plugin.
4. Each plugin file is obtained from the content-hash cache or downloaded, checksum-verified, placed in the cache, expanded into a temporary area, loaded, and registered. Core and plugin scanner-side extensions are installed.
5. Removed tasks and non-publish analysis modes are rejected before project scanning.

### 8.2 Project preparation

1. The root project and legacy module tree are built. Duplicate module IDs or keys, missing mandatory properties, nonexistent declared source/test paths, wildcard source/test paths, nonexistent module base directories, or invalid work paths fail preparation.
2. Global and project server metadata, languages, profiles, active rules, metrics, prior file metadata, feature flags, branch defaults, and optional cache are made available to extensions.
3. Work directories are cleaned and recreated while retaining the lock file. A nonblocking exclusive lock is acquired for the project work directory; failure means another analysis is already running.
4. Files are preprocessed recursively by module. Main and test roots, path inclusions, exclusions, SCM ignore state, symlink safety, project/module containment, hidden-file policy, and size limit decide scope. Language patterns are evaluated at this stage.
5. Plugins restricted to detected languages are then downloaded and installed. A file matching more than one language pattern fails analysis rather than selecting one arbitrarily.
6. Project builders may refine the model before final indexing. Files receive stable scanner IDs, main/test classification, language, charset, line count, content hash, status against prior analysis, coverage/CPD exclusion flags, and hidden visibility state.

### 8.3 Sensor and shared processing

1. Modules are traversed child-first. Each module's eligible legacy sensors execute in selected order.
2. Project sensors execute sequentially in the extension dictionary's selected order. Unconfigured sensors and sensors whose file/language predicates do not match are skipped by their optimizers.
3. Built-in post-phase zero coverage adds zero hits for executable main-file lines only when no coverage has already been defined and the file is not coverage-excluded.
4. SCM publication either computes blame for changed, forced, or revision-missing nonempty files or marks eligible unchanged data for copying from the prior analysis.
5. CPD runs over analyzer-supplied blocks. Non-Java groups below configured token threshold are filtered. A per-file computation exceeding five minutes is omitted with a warning. At most 100 clone groups per file and 100 references per group are written.
6. Report steps finalize metadata, active rules, components, context properties, telemetry, sensor cache, tests, sources, changed lines, warnings, and issue resolutions, alongside data written during sensors.

A sensor or post-job exception is not converted to a partial success; it aborts the remaining normal lifecycle. Sensor execution is sequential. The CPD detector uses one worker and waits for each file before continuing.

### 8.4 Report, upload, gate, and shutdown

1. Report content is written into a temporary report directory, then compressed into a ZIP.
2. Unless running the test-only medium mode, the ZIP is submitted to `api/ce/submit`.
3. The returned task identifier is combined with project, server, dashboard, branch, and task URLs and written as UTF-8 key-value lines to the configured metadata path.
4. If `sonar.qualitygate.wait=false`, upload acknowledgement is the end of server interaction. Success means submission succeeded, not that compute processing finished.
5. If gate waiting is enabled, the engine polls task status every five seconds until `SUCCESS`, `FAILED`, `CANCELED`, or the configured deadline. Only task `SUCCESS` followed by quality-gate `OK` is successful. Any other terminal task or gate status fails the engine after report submission.
6. Eligible post-jobs run after upload and any gate wait.
7. Plugin classloaders are unloaded, locks released, and containers stopped. The generated report directory is deleted unless `sonar.scanner.keepReport=true` or verbose mode is enabled.

Provenance: `org/sonar/scanner/bootstrap/SpringGlobalContainer.java`; `org/sonar/scanner/bootstrap/ScannerPluginRepository.java`; `org/sonar/scanner/scan/ProjectReactorBuilder.java`; `org/sonar/scanner/scan/ProjectLock.java`; `org/sonar/scanner/scan/WorkDirectoriesInitializer.java`; `org/sonar/scanner/scan/filesystem/ProjectFilePreprocessor.java`; `org/sonar/scanner/scan/filesystem/FilePreprocessor.java`; `org/sonar/scanner/scan/filesystem/LanguageDetection.java`; `org/sonar/scanner/scan/SpringProjectScanContainer.java`; `org/sonar/scanner/scan/SpringModuleScanContainer.java`; `org/sonar/scanner/sensor/ProjectSensorsExecutor.java`; `org/sonar/scanner/source/ZeroCoverageSensor.java`; `org/sonar/scanner/scm/ScmPublisher.java`; `org/sonar/scanner/cpd/CpdExecutor.java`; `org/sonar/scanner/report/ReportPublisher.java`; `org/sonar/scanner/qualitygate/QualityGateCheck.java`; `org/sonar/scanner/postjob/PostJobsExecutor.java`.

## 9. File recognition and metadata

### 9.1 Scope decisions

Declared source/test roots accept files or directories. Directory traversal follows symbolic links, but a symbolic-link file is ignored if its target is missing, outside the project base, or outside its module base. Any resolved file outside the project or module base is ignored. SCM ignore filtering applies only when the selected provider offers it and SCM exclusions are enabled.

The scanner work directory and Sonar user home are never traversed as hidden source directories. Other hidden files are included and marked hidden by default; setting `sonar.scanner.excludeHiddenFiles=true` removes them from scope. Files larger than `sonar.filesize.limit` are removed. Coverage and CPD exclusions do not remove a file from general analysis.

### 9.2 Language and charset

Language recognition uses project-relative paths. A language-specific `sonar.lang.patterns.<key>` list has priority over suffix and filename patterns obtained from server settings. Suffixes are normalized to lowercase and a leading dot is removed. No matching language leaves the file indexed without a language; multiple matches are fatal.

Charset detection examines an initial byte window. A byte-order mark has first priority and is removed from the content stream. Without a mark, the engine tests UTF-8, UTF-16, configured encoding, and a Windows-1252 fallback. Unreadable or unsupported content may fail metadata generation according to the input-file contract. Published changed source is normalized to UTF-8 with line boundaries preserved.

### 9.3 Status and incremental data

Prior file hashes from `/batch/project.protobuf` distinguish `ADDED`, `CHANGED`, and `SAME`. Components carry status, old path when known, test flag, language, line count, and unchanged optimization marker. Changed sources are embedded in the report; unchanged data may be copied on the server when the protocol permits. The analysis cache is read into memory when enabled. Cache output is disabled for pull-request configuration and otherwise closed into the report at publication.

Provenance: `org/sonar/scanner/scan/filesystem/ProjectFilePreprocessor.java`; `org/sonar/scanner/scan/filesystem/FilePreprocessor.java`; `org/sonar/scanner/scan/filesystem/HiddenFilesVisitorHelper.java`; `org/sonar/scanner/scan/filesystem/LanguageDetection.java`; `org/sonar/scanner/scan/filesystem/CharsetDetector.java`; `org/sonar/scanner/scan/filesystem/ByteCharsetDetector.java`; `org/sonar/scanner/report/ComponentsPublisher.java`; `org/sonar/scanner/report/SourcePublisher.java`; `org/sonar/scanner/cache/AnalysisCacheProvider.java`.

## 10. Built-in generic report imports

### 10.1 Generic coverage XML

`sonar.coverageReportPaths` enables project-level import of one or more resolved XML files. Each report must have root `coverage` with `version="1"`. Each `file` has mandatory `path`; each `lineToCover` has mandatory positive `lineNumber` and boolean `covered`. Optional `branchesToCover` and `coveredBranches` are nonnegative, and covered branches must not exceed total branches. Unknown elements, missing fields, invalid values, wrong version, or unreadable files fail analysis. Files not indexed with a known language are skipped; up to five example paths are logged.

### 10.2 Generic test-execution XML

`sonar.testExecutionReportPaths` enables module-level import. Deprecated `sonar.genericcoverage.unitTestReportPaths` maps to it with a warning. Root `testExecutions` with `version="1"` is accepted; deprecated root `unitTest` is also accepted with a warning. A `file` must identify an indexed test file. Each `testCase` requires a name and nonnegative duration and may carry first descendant status `skipped`, `failure`, or `error`; absence means success. A reference to a main file, invalid report, or unreadable path fails analysis. Unknown files are skipped and summarized.

### 10.3 Generic external issues

`sonar.externalIssuesReportPaths` imports JSON reports. Current format contains both `rules` and `issues`; deprecated format contains only `issues` and emits a warning. Current rules require unique `id`, `engineId`, and `name`, plus type, impacts, or both. Type and severity must appear together; impacts must be nonempty when supplied and are forbidden for `SECURITY_HOTSPOT`. Current issues reference a rule declared in the same report and must not repeat deprecated issue-level type or severity. Every issue requires a primary file path and message; a supplied range requires a start line. Secondary locations require file path, text range, and start line. The deprecated format instead requires issue-level `engineId`, `ruleId`, severity, and type. A primary path absent from indexed files causes that issue to be skipped and counted as unknown; an absent secondary path omits only that secondary location. Malformed or inconsistent reports fail analysis.

### 10.4 SARIF

`sonar.sarifReportPaths` imports SARIF 2.1.0 through the shared SARIF contract. Failures are isolated per configured file, and supported runs within a file may be partially imported. A failed file or run is logged; any file-level failure adds one analysis warning, while successfully imported files and runs remain in the report.

Generic XML parsing disables DTD processing and namespace awareness. Imported observations are subject to normal scanner storage validation and report merging.

Provenance: `org/sonar/scanner/genericcoverage/GenericCoverageSensor.java`; `org/sonar/scanner/genericcoverage/GenericCoverageReportParser.java`; `org/sonar/scanner/genericcoverage/GenericTestExecutionSensor.java`; `org/sonar/scanner/genericcoverage/GenericTestExecutionReportParser.java`; `org/sonar/scanner/genericcoverage/StaxParser.java`; `org/sonar/scanner/externalissue/ExternalIssueReport.java`; `org/sonar/scanner/externalissue/ExternalIssueReportValidator.java`; `org/sonar/scanner/externalissue/ExternalIssuesImportSensor.java`; `org/sonar/scanner/externalissue/sarif/SarifIssuesImportSensor.java`.

## 11. Report outputs

The report contains only protocol-supported domains and uses scanner IDs to relate data to components. Observable content includes:

- analysis date, project key/version/build string, root component reference, quality profiles, plugin keys and update timestamps, language file counts, SCM revision and relative root, optional branch/reference data, and new-code reference branch;
- project identity, name, description, links, indexed file paths, main/test type, language, line count, status, old path, and unchanged marker;
- changed source text in UTF-8;
- active rules and parameters;
- analyzer measures, issues, external issues, ad hoc rules, highlighting, symbols, significant code, line/condition coverage, CPD results, test execution, context properties, issue resolutions, analysis warnings, telemetry, analysis cache, SCM changesets, changed lines, and registered extension data;
- an analysis-context log listing plugins and effective Sonar properties, with sensitive values masked.

The analysis-context log masks `sonar.login`, keys ending in `password` case-insensitively, keys containing `.secured`, and keys containing `.token`. Values are truncated to 1,000 characters in that log.

After upload, the local metadata file contains `projectKey`, `serverUrl`, `serverVersion`, optional `branch`, `dashboardUrl`, `ceTaskId`, and `ceTaskUrl`.

The scanner report's exact file layout and protobuf compatibility are owned by `platform/scanner-gateway/`; this specification requires production of equivalent observations, not duplication of that wire schema.

Provenance: `org/sonar/scanner/report/MetadataPublisher.java`; `org/sonar/scanner/report/ComponentsPublisher.java`; `org/sonar/scanner/report/AnalysisContextReportPublisher.java`; `org/sonar/scanner/report/ReportPublisher.java`; `org/sonar/scanner/sensor/DefaultSensorStorage.java`.

## 12. Persistence, concurrency, and cleanup

- Plugin binaries persist under the Sonar user-home `cache` directory, partitioned by server-provided content hash. Downloads use temporary files and an atomic move when supported. If another process populates the target first, the existing target wins.
- Plugin list metadata is held for one engine run. A listed plugin that returns 404 causes the engine to refresh the index and retry the complete selected plugin set once. A second miss is fatal.
- Analysis cache input is memory-resident for one run. Updated cache entries are part of the scanner report, not a separate local durable store.
- Project work content is cleared at startup except the lock file. Module work directories are cleaned child-first and recreated.
- One analysis may own a given work directory. The lock is nonblocking and is released on container shutdown.
- Sensors and post-jobs are sequential. CPD uses one worker and enforces a per-file deadline. No ordering guarantee should be inferred among extension-provided property sources or other collections whose API does not define order.
- Temporary report data is removed at shutdown unless keep-report or verbose behavior retains it. The persistent plugin cache is not removed.

Provenance: `org/sonar/scanner/bootstrap/PluginFiles.java`; `org/sonar/scanner/bootstrap/ScannerPluginInstaller.java`; `org/sonar/scanner/cache/AnalysisCacheMemoryStorage.java`; `org/sonar/scanner/cache/AnalysisCacheProvider.java`; `org/sonar/scanner/scan/WorkDirectoriesInitializer.java`; `org/sonar/scanner/scan/ProjectLock.java`; `org/sonar/scanner/sensor/ProjectSensorsExecutor.java`; `org/sonar/scanner/cpd/CpdExecutor.java`; `org/sonar/scanner/report/ReportPublisher.java`.

## 13. Failure, partial-result, and recovery behavior

### 13.1 Fatal failures

The run fails on malformed engine JSON; invalid mandatory project configuration; unsupported Java; removed task or analysis mode; unresolved language ambiguity; work-directory or lock failure; required server metadata failure; plugin parsing, checksum, or repeated download failure; uncaught analyzer sensor failure; invalid generic coverage, test, or external-issue report; fatal SCM blame failure; non-timeout CPD failure; report generation or upload failure; response parse failure; local metadata write failure; post-job failure; gate timeout; abnormal compute task; or non-OK quality gate when waiting.

A network exception does not prove that a remote write was rejected: the server might have accepted a report before the connection failed. The engine provides no independent transaction rollback. Recovery is a fresh analysis after checking server task state and local configuration.

### 13.2 Deliberate partial results

- Project settings 404 becomes no project settings.
- Prior project repository 404 becomes no incremental file metadata.
- Analysis cache 404 becomes an empty cache.
- Quality-profile project 404 falls back to default profiles.
- Plugin disappearance receives one refreshed-index retry.
- Missing SCM provider skips blame and emits a warning rather than failing.
- SARIF failures are isolated by file or run and add analysis warnings.
- A CPD timeout omits duplication data for that file and continues.
- Files absent from generic reports' indexed scope are ignored where that report contract explicitly permits it.

There is no usable server result before successful report submission. After submission, later local metadata, quality-gate, or post-job failure can still produce process status `1` even though a compute task exists. Operators must use the returned or server-observed task identifier for recovery.

Provenance: `org/sonar/scanner/http/DefaultScannerWsClient.java`; `org/sonar/scanner/bootstrap/ScannerPluginInstaller.java`; `org/sonar/scanner/repository/settings/AbstractSettingsLoader.java`; `org/sonar/scanner/repository/DefaultProjectRepositoriesLoader.java`; `org/sonar/scanner/repository/DefaultQualityProfileLoader.java`; `org/sonar/scanner/cache/DefaultAnalysisCacheLoader.java`; `org/sonar/scanner/externalissue/sarif/SarifIssuesImportSensor.java`; `org/sonar/scanner/cpd/CpdExecutor.java`; `org/sonar/scanner/report/ReportPublisher.java`; `org/sonar/scanner/qualitygate/QualityGateCheck.java`.

## 14. Security and trust boundaries

- The SonarQube server is an authenticated configuration and code-distribution boundary. The engine executes scanner-side code from server-listed plugins. `[INFERENCE]` A configured server must therefore be trusted to supply executable analyzer content, not merely analysis data.
- TLS uses JVM default trust and, by default, operating-system trust. Optional PKCS#12 identity and trust stores extend those materials. `sonar.scanner.skipSystemTruststore=true` removes operating-system trust loading but does not disable JVM default trust.
- Tokens and proxy/store passwords are secrets. The analysis-context report masks known sensitive key forms, but operators must still restrict logs, environment, JSON input, work directories, user cache, and metadata files.
- Plugin downloads require the server's `Sonar-MD5` value to match downloaded bytes. This detects transfer or cache mismatch but is not a signature or independent publisher-authentication mechanism.
- Plugin cache path construction verifies that a plugin key cannot escape its hash directory.
- Source roots, generic report paths, certificate paths, and custom work/metadata paths are operator-controlled local read/write boundaries. Absolute paths are accepted where documented. Filesystem permissions must limit what the engine can read and overwrite.
- Source text, SCM author data, report contents, imported findings, telemetry, and task characteristics cross from the local checkout to the server.
- Generic XML parsing disables DTD processing. SARIF and JSON inputs are data-only imports; they do not authorize local execution.
- Symlink target and project/module containment checks prevent indexed file links from escaping configured roots. They do not constrain explicitly configured report, key-store, trust-store, metadata, or user-home paths.

Provenance: `org/sonar/scanner/http/ScannerWsClientProvider.java`; `org/sonar/scanner/http/DefaultScannerWsClient.java`; `org/sonar/scanner/bootstrap/PluginFiles.java`; `org/sonar/scanner/report/AnalysisContextReportPublisher.java`; `org/sonar/scanner/scan/filesystem/FilePreprocessor.java`; `org/sonar/scanner/genericcoverage/StaxParser.java`.

## 15. Compatibility and limits

- Runtime requires Java 21 or newer. A 32-bit runtime remains accepted with a deprecation warning.
- This specification targets scanner engine `13.5.0.4089` with SonarQube Community Build `26.8.0.126808`. Report protocol and scanner gateway must be compatible with that pairing.
- Plugin API compatibility, required-language metadata, and classloader isolation remain plugin-runtime contracts. The engine honors `requiredForLanguages` and plugin type from server metadata.
- Only `scan` and `publish` modes exist. Medium mode is test-only and is not a production analysis mode.
- File traversal depth is filesystem-dependent and follows directories recursively. The default maximum analyzed file size is 20 MB.
- Generic XML formats accept only their declared version 1. SARIF import is 2.1.0.
- CPD retains at most 100 groups per file and 100 duplicate references per group and allows five minutes per file.
- Plugin download timeout defaults to 300 seconds. Report upload write timeout defaults to 60 seconds. Quality-gate wait defaults to 300 seconds and polls every five seconds.
- Scanner success after ordinary submission does not imply completed compute processing or a passed quality gate.

## 16. Acceptance scenarios

1. **Pinned identity.** Given the Community Build distribution, inspecting its dependency pin identifies scanner engine `13.5.0.4089`. Inspecting the official source artifact produces the recorded SHA-256. No Git commit is represented as exact artifact provenance.
2. **Minimal project.** Given valid server credentials, `sonar.projectKey`, and a project base with no explicit sources, modules, or tests, the engine indexes eligible files below the base, loads plugins for detected languages, runs sensors, submits a report, writes `report-task.txt`, and exits `0` when gate waiting is disabled.
3. **Input precedence.** Given a JSON input property and a conflicting `SONAR_SCANNER_JSON_PARAMS` entry, the JSON input remains effective and the environment value is ignored with a warning.
4. **Server precedence.** Given one key in global server, project server, and project scanner layers, the project scanner value is effective, except a `sonar.global.` key remains the global server value.
5. **Language ambiguity.** Given an indexed path matching patterns for two server languages, preprocessing fails and no report is submitted.
6. **Source containment.** Given a source symlink whose target is outside its module base, the file is ignored and no source or analyzer observations for it appear in the report.
7. **Selective plugin load.** Given `sonar.plugins.downloadOnlyRequired=true`, an optional plugin whose `requiredForLanguages` set does not intersect detected languages is not downloaded. A matching plugin is downloaded after language detection.
8. **Plugin integrity.** Given a downloaded plugin whose bytes do not match `Sonar-MD5`, the engine does not cache or execute it and the analysis fails.
9. **Plugin race recovery.** Given a plugin listed and then removed, the engine refreshes the plugin list once. If the refreshed selection no longer requires it, analysis proceeds; if it remains listed and still returns 404, analysis fails.
10. **Concurrent analysis.** Given one process holding the project work-directory lock, a second process using that work directory fails before sensor execution with an analysis-in-progress error.
11. **Generic import failure.** Given malformed generic coverage XML, the generic sensor fails the analysis. Given one malformed SARIF file and one valid SARIF file, valid findings remain, failed findings are omitted, and an analysis warning is reported.
12. **Report upload.** Given a successful `api/ce/submit` response, the metadata file contains the project, server, dashboard, task ID, and task URL. The scanner reports submission success without claiming server processing is complete.
13. **Quality-gate wait pass.** Given `sonar.qualitygate.wait=true`, a compute task that reaches `SUCCESS`, and gate status `OK` before the timeout, the engine logs a passed status, runs post-jobs, and exits `0`.
14. **Quality-gate wait fail.** Given a report already accepted but a failed/canceled compute task, non-OK gate, or timeout, the engine exits `1`; the submitted server task is not rolled back.
15. **Metadata write failure after upload.** Given a successful upload and an unwritable metadata destination, the engine exits `1` even though the compute task may continue on the server.
16. **Cache miss.** Given `sonar.analysisCache.enabled=true` and HTTP 404 from `api/analysis_cache/get`, sensors receive an empty read cache and analysis continues.
17. **Cleanup.** Given a successful ordinary run with keep-report and verbose both false, the temporary report directory is removed, the work lock is released, and plugin content remains in user cache.

## 17. Provenance index

- Artifact identity, license, repository association, and missing revision: official Maven POM and source checksum URLs in section 1.
- Community distribution pin: SonarQube `gradle.properties`; `sonar-application/build.gradle`.
- Invocation and environment: `org/sonar/scanner/bootstrap/ScannerMain.java`; `EnvironmentConfig.java`; `ScannerProperties.java`; `SonarUserHomeProvider.java`.
- Bootstrap, plugins, and extensions: `org/sonar/scanner/bootstrap/SpringGlobalContainer.java`; `SpringScannerContainer.java`; `ScannerPluginRepository.java`; `ScannerPluginInstaller.java`; `PluginFiles.java`.
- HTTP, authentication, proxy, and TLS: `org/sonar/scanner/http/ScannerWsClientProvider.java`; `DefaultScannerWsClient.java`; `http/ssl/CertificateStore.java`.
- Server metadata: `org/sonar/scanner/repository/`; `org/sonar/scanner/repository/settings/`; `org/sonar/scanner/repository/language/`; `org/sonar/scanner/repository/featureflags/`; `org/sonar/scanner/rule/`.
- Project and module configuration: `org/sonar/scanner/scan/ProjectReactorBuilder.java`; `ProjectConfigurationProvider.java`; `ModuleConfigurationProvider.java`; `ProjectReactorValidator.java`.
- Filesystem and language behavior: `org/sonar/scanner/scan/filesystem/`.
- Sensor ordering and storage: `org/sonar/scanner/scan/SpringModuleScanContainer.java`; `SpringProjectScanContainer.java`; `org/sonar/scanner/sensor/`.
- Generic reports and SARIF: `org/sonar/scanner/genericcoverage/`; `org/sonar/scanner/externalissue/`; `org/sonar/scanner/externalissue/sarif/`.
- SCM, cache, CPD, and CI: `org/sonar/scanner/scm/`; `org/sonar/scanner/cache/`; `org/sonar/scanner/cpd/`; `org/sonar/scanner/ci/`.
- Report and quality-gate lifecycle: `org/sonar/scanner/report/`; `org/sonar/scanner/qualitygate/QualityGateCheck.java`; `org/sonar/scanner/postjob/PostJobsExecutor.java`.
