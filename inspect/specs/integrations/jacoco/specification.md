# JaCoCo XML Importer Integration Specification

## 1. Identity and provenance

This specification covers the JaCoCo XML report importer bundled with SonarQube Community Build `26.8.0.126808`.

- Artifact: `org.sonarsource.jacoco:sonar-jacoco-plugin:1.6.0.5741`.
- Plugin key: `jacoco`.
- Display name: `JaCoCo`.
- Source repository: `https://github.com/SonarSource/sonar-jacoco`.
- Git tag: `1.6.0.5741`.
- Git commit: `d7ac50ea711e3321dabc2e4fbb7edf757507f892`.
- License: `LGPL-3.0-or-later`. Root license and production headers permit GNU LGPL version 3 or later.
- Entry point: `org.sonar.plugins.jacoco.JacocoPlugin`.
- Declared purpose: import JaCoCo XML coverage reports.

The SonarQube release pins this exact artifact in root dependency management and includes it in `sonar-application/bundled_plugins.gradle`.

Provenance: official POM `https://repo1.maven.org/maven2/org/sonarsource/jacoco/sonar-jacoco-plugin/1.6.0.5741/sonar-jacoco-plugin-1.6.0.5741.pom`; tag `https://github.com/SonarSource/sonar-jacoco/tree/1.6.0.5741`; commit `https://github.com/SonarSource/sonar-jacoco/commit/d7ac50ea711e3321dabc2e4fbb7edf757507f892`; source paths `build.gradle`, `gradle.properties`, `LICENSE.txt`, `src/main/java/org/sonar/plugins/jacoco/JacocoPlugin.java`; SonarQube paths `build.gradle` and `sonar-application/bundled_plugins.gradle`.

## 2. Purpose

The integration reads JaCoCo XML produced before analysis, maps report source-file entries to files already indexed by the scanner, and records line and branch coverage observations. It supports ordinary module reports and project-level aggregate reports.

It is an importer only. It does not instrument bytecode, launch tests, read JaCoCo execution-data files, merge JaCoCo binaries, generate XML, calculate platform coverage percentages, or own coverage metric keys.

Provenance: `src/main/java/org/sonar/plugins/jacoco/JacocoSensor.java`; `JacocoAggregateSensor.java`; `ReportImporter.java`; artifact manifest definitions in `build.gradle`.

## 3. Scope and exclusions

### 3.1 Included behavior

This specification owns:

- registration and configuration of ordinary and aggregate XML import;
- discovery of exact, absolute, relative, and wildcard report paths;
- default ordinary report locations and fallback precedence;
- UTF-8 streaming parse of JaCoCo package, source-file, group, and line elements;
- module-local and project-wide source mapping;
- Kotlin package-declaration fallback mapping;
- translation of instruction and branch counters to scanner line/condition coverage observations;
- per-report and per-file failure isolation;
- warnings, telemetry, lifecycle state, compatibility, trust boundaries, and acceptance outcomes.

### 3.2 Excluded behavior

The following are outside this specification:

- JaCoCo agent, test runner, Gradle/Maven task, bytecode instrumentation, execution-data, report generation, class analysis, filtering, and producer-side aggregation internals;
- standalone scanner launcher behavior;
- Java, Kotlin, Scala, Groovy, or Gosu analyzer behavior;
- scanner file indexing, report serialization, coverage merge storage, upload, server persistence, coverage metric aggregation, and quality-gate policy, except where this importer depends on those contracts;
- LCOV, Cobertura, generic coverage XML, Scoverage, SimpleCov, and other coverage formats;
- commercial behavior and any report producer not evidenced by the accepted XML surface.

## 4. Dependencies and owned contracts

### 4.1 Scanner dependencies

The importer requires:

- scanner plugin API `13.8.0.4399` at build time for configuration, filesystem, sensor, warning, telemetry, and coverage APIs;
- scanner engine lifecycle that runs module sensors before project sensors, keeps a scanner-side project context for one analysis, and serializes saved coverage into the scanner report;
- indexed input files with relative path, filename, language, type, contents, line count, and module/project configuration;
- `sonar.projectBaseDir`, `sonar.projectKey`, `sonar.sources`, and optional `sonar.moduleKey` supplied by the scanner;
- platform coverage storage and aggregation after the importer saves line and condition observations.

### 4.2 Language eligibility

Plugin metadata declares `Plugin-RequiredForLanguages` as `gosu,groovy,java,kotlin,scala`. With scanner selective plugin loading enabled, at least one of those detected language keys makes this plugin eligible for download. The sensors themselves do not apply an additional language predicate once loaded; they search indexed files and use Kotlin-specific fallback only for `.kt` paths.

### 4.3 Owned output contract

For each matched source file, the importer may save:

- a line-hit observation of 1 when covered instructions are positive;
- a line-hit observation of 0 when the line has instruction or branch data but no covered instruction;
- total branch conditions equal to covered plus missed branches when either is positive;
- covered branch conditions equal to the covered-branch count.

It defines no rules, issues, highlighting, symbols, CPD tokens, test execution, or custom metric identifiers. Standard coverage metric ownership remains with project configuration and compute processing.

Provenance: `build.gradle`; `src/main/java/org/sonar/plugins/jacoco/ReportImporter.java`; scanner-engine source `org/sonar/scanner/sensor/DefaultSensorStorage.java`; `manifest/dependency-map.md`.

## 5. Configuration

### 5.1 Ordinary XML reports

`sonar.coverage.jacoco.xmlReportPaths` is a project-scoped, multi-value property. Each value may be:

- an absolute file path;
- a path relative to the current module scanner filesystem base directory;
- a wildcard pattern containing `*`, `**`, or `?`.

Empty configured values are ignored. Equal resolved `Path` values are deduplicated by set equality.

When at least one configured pattern resolves to a regular file, only resolved configured files are imported. Default paths are not added. If multiple configured patterns are present and one has no match, that missing pattern is logged at information level while matches from other patterns remain effective.

When the property is absent, or every nonempty configured pattern resolves to no file, the importer checks these default paths relative to the current module base directory:

1. `target/site/jacoco/jacoco.xml`
2. `target/site/jacoco-it/jacoco.xml`
3. `build/reports/jacoco/test/jacocoTestReport.xml`

If explicit patterns were provided but none matched, fallback to defaults also emits an analysis warning containing the configured values and default locations. If no explicit value was supplied, use of defaults is informational only. If no default file exists, the ordinary sensor records no coverage and returns successfully.

### 5.2 Aggregate XML reports

`sonar.coverage.jacoco.aggregateXmlReportPaths` is a project-scoped, multi-value property. It accepts the same absolute, relative, and wildcard path forms. Equal resolved `Path` values are deduplicated by set equality.

Aggregate import has no default locations and no fallback. Every configured pattern with no match produces a log warning and one analysis warning. An absent or empty property produces no aggregate import. The sensor adds telemetry key `sonar.coverage.jacoco.aggregateXmlReportPaths.set` with string value `true` when the key exists, including an empty value, and `false` when absent.

### 5.3 Precedence and coexistence

Ordinary and aggregate settings are independent; neither overrides the other. Ordinary reports execute in each module sensor. Aggregate reports execute later at project level. The same physical report can be configured in both properties, but it is not deduplicated across the two sensor kinds. Within one property, deduplication uses `Path.equals` only: paths are not canonicalized and physical identity is not checked. Lexical aliases such as a path containing `.` and a normalized-looking alias, or a direct path and a symbolic-link path, can therefore import the same physical report more than once. Coverage observations are handed to scanner storage, whose merge behavior is monotonic rather than importer-owned replacement.

Provenance: `src/main/java/org/sonar/plugins/jacoco/JacocoPlugin.java`; `ReportPathsProvider.java`; `TelemetryProperties.java`; tests `src/test/java/org/sonar/plugins/jacoco/ReportPathsProviderTest.java`, `JacocoSensorTest.java`, and `JacocoAggregateSensorTest.java`.

## 6. Report path scanning

### 6.1 Non-wildcard paths

A non-wildcard value is resolved against the sensor base directory. Absolute values remain absolute under normal path resolution. The path is accepted only when it identifies a regular file. A directory or missing path yields no match.

Both slash directions are normalized for cross-platform path handling.

### 6.2 Wildcard paths

For a wildcard value, the importer separates any fixed path prefix before the first wildcard and starts traversal from the most specific resulting directory. It then recursively visits regular files to a maximum depth of 64 and applies Sonar wildcard matching to normalized absolute paths.

A missing traversal root yields no matches. Wildcard traversal from a filesystem root is refused for performance reasons. I/O and runtime failures during path scanning are logged and converted to no matches rather than thrown to the sensor. Subsequent ordinary fallback or aggregate missing-pattern behavior still applies.

The path scanner does not impose project-containment checks on explicitly configured absolute paths or fixed prefixes. Filesystem permissions determine which report files can be read.

Provenance: `src/main/java/org/sonar/plugins/jacoco/WildcardPatternFileScanner.java`; tests `src/test/java/org/sonar/plugins/jacoco/WildcardPatternFileScannerTest.java`.

## 7. Accepted JaCoCo XML

### 7.1 Encoding and parser safety

Reports are read as UTF-8. Parsing is streaming, namespace-unaware, and has DTD support disabled. External DTD content is therefore not required or processed. The importer does not require an XML namespace or a declared JaCoCo report version.

### 7.2 Relevant structure

Only these elements and attributes affect imported coverage:

- `group` may provide mandatory attribute `name`. Its current value is associated with contained source files and is used only by project aggregate mapping.
- `package` requires attribute `name`.
- `sourcefile` requires attribute `name` and must occur while a package is active.
- `line` must occur while a source file is active. It requires integer attribute `nr`. Optional integer attributes `mi`, `ci`, `mb`, and `cb` represent missed instructions, covered instructions, missed branches, and covered branches. A missing optional counter is treated as zero.

Other standard JaCoCo elements and counters, including sessions, classes, methods, and aggregate counters, are ignored by this importer. Coverage comes only from source-file line entries.

A source file in the default package is represented by an empty package name and is eligible for mapping. A report with groups may identify a module or subproject by group name; ordinary module import deliberately disregards group names.

### 7.3 Invalid structure

The report is invalid when a required name or line number is absent, an integer attribute cannot be parsed, a source file occurs outside a package, a line occurs outside a source file, the XML is malformed, or the file cannot be read as UTF-8 XML. Error text identifies the report and, where available, XML line and column.

Optional counters are not required to be present together. Their values are passed to scanner coverage validation; nonsensical line numbers or counters may be rejected during per-file save even when XML parsing succeeded.

Provenance: `src/main/java/org/sonar/plugins/jacoco/XmlReportParser.java`; tests `src/test/java/org/sonar/plugins/jacoco/XmlReportParserTest.java` and XML resources under `src/test/resources/`.

## 8. Source-file mapping

### 8.1 Common path construction

For each XML source file, the importer combines package path and filename. When package name is empty, the filename alone is used. Otherwise the expected suffix is the package path followed by the filename. Scanner input-file relative paths are indexed in reverse segment order so source-root prefixes need not appear in the XML.

### 8.2 Ordinary module mapping

The ordinary sensor builds its locator from all input files visible to the current module sensor context. It ignores XML group names and selects a file whose indexed relative path ends with the XML package-and-filename suffix.

When multiple indexed paths share the same suffix, ordinary mapping returns the first indexed leaf. It does not reject ambiguity. Scanner index order therefore decides between duplicate main/test or source-root paths with identical suffixes.

### 8.3 Aggregate project mapping

Before aggregate import, the project sensor has access to module contexts recorded by all ordinary module sensor invocations. Each context contains:

- a module name derived from `sonar.moduleKey`, or from `sonar.projectKey` when no module key exists;
- for a key containing colons, the segment after the last colon;
- the module base directory;
- source roots from `sonar.sources`, resolved against the module base when relative.

The aggregate sensor first tries the path suffix plus XML group name. If that is ambiguous or absent, it finds the first recorded module whose derived name equals the group and reconstructs candidates from that module's source roots. If the XML source file has no group, aggregate mapping falls back to group-agnostic suffix lookup, equivalent to ordinary first-match behavior.

Duplicate module names are not independently disambiguated beyond first matching module context.

### 8.4 Kotlin fallback

If ordinary or aggregate suffix lookup fails for a filename ending in `.kt`, the importer lazily reads indexed Kotlin files and extracts each declared package. It maps the resolved package plus filename to the input file.

The package recognizer tolerates leading shebang text, whitespace, comments, strings, file annotations, comments inside a package header, Unicode identifier characters, and backtick-escaped identifiers. A Kotlin file with no package declaration has no Kotlin fallback entry. An unreadable Kotlin file is logged and omitted from the fallback map.

### 8.5 Missing source

When no input file matches, the source file is skipped and a warning names its XML filename. Other source files and reports continue.

Provenance: `src/main/java/org/sonar/plugins/jacoco/FileLocator.java`; `ModuleFileLocator.java`; `ProjectFileLocator.java`; `ReversePathTree.java`; `KotlinFileLocator.java`; `ModuleCoverageContext.java`; `ProjectCoverageContext.java`; tests `FileLocatorTest.java`, `ReversePathTreeTest.java`, `KotlinFileLocatorTest.java`, and `ModuleCoverageContextTest.java`.

## 9. Coverage translation and merging

For every line in a mapped XML source file:

1. If either `cb` or `mb` is positive, total conditions are `cb + mb`, and covered conditions are `cb`.
2. If branch conditions exist, or either `ci` or `mi` is positive, a line-hit observation is saved.
3. The line-hit value is 1 when `ci` is positive and 0 otherwise.
4. If all four instruction and branch counters are zero, no observation is saved for that line.

Instruction counts are reduced to a binary line-hit result; their magnitude is not retained. Branch counts are retained as total and covered conditions. Method, class, and report counters do not contribute directly.

When multiple importer invocations save coverage for the same file and line, scanner engine storage merges existing observations. Line hits are combined as covered if any saved hit is positive. Total conditions take the maximum supplied value, and covered conditions take the maximum supplied value. They are not summed across reports. Values for line numbers beyond the indexed file's line count are not written by scanner storage.

After all mapped lines are staged, the importer saves one coverage object for that XML source-file entry. An entry with no effective line observations may still complete a coverage save according to scanner API behavior.

Provenance: `src/main/java/org/sonar/plugins/jacoco/ReportImporter.java`; test `src/test/java/org/sonar/plugins/jacoco/ReportImporterTest.java`; scanner-engine source `org/sonar/scanner/sensor/DefaultSensorStorage.java`.

## 10. Lifecycle and state transitions

### 10.1 Ordinary module sensor

For every module in which the plugin is active:

1. Record module name, base directory, and source roots in scanner-side project coverage context.
2. Resolve `sonar.coverage.jacoco.xmlReportPaths` using explicit-path and default fallback rules.
3. If no report exists, log that no coverage is imported and finish successfully.
4. Build a locator over current module input files and a lazy Kotlin fallback over files whose language key is `kotlin`.
5. Process each distinct resolved `Path` set member. For every parsed source file, locate an input file and save line/condition observations.

Recording module context occurs even when no ordinary report exists. This enables a later aggregate report to map sources across modules.

### 10.2 Aggregate project sensor

After module sensors have recorded their contexts:

1. Set the root project base from `sonar.projectBaseDir`.
2. Resolve `sonar.coverage.jacoco.aggregateXmlReportPaths` without defaults and record whether the property key was set.
3. If no aggregate report exists, finish successfully.
4. Build a project-wide locator over all indexed input files plus recorded module contexts and Kotlin fallback.
5. Process each distinct resolved aggregate `Path` set member and save coverage on matched files.

### 10.3 Completion

The importer owns no upload or server persistence. Saved observations remain in scanner analysis state until the scanner report is generated. Scanner and compute-engine contracts then serialize, upload, merge, aggregate, and persist coverage.

Provenance: `src/main/java/org/sonar/plugins/jacoco/JacocoSensor.java`; `JacocoAggregateSensor.java`; `ProjectCoverageContext.java`; scanner-engine source `org/sonar/scanner/scan/SpringProjectScanContainer.java`.

## 11. Persistence and concurrency

- `ProjectCoverageContext` is scanner-side, in-memory state for one analysis. It starts with no module contexts and appends one context per ordinary sensor execution.
- Report paths are held in sets. Equal `Path` values within one property are imported once; different lexical or symbolic-link paths to the same physical file remain separate and may both be imported. Iteration order is not a public contract.
- No JaCoCo data is written to a plugin-owned local cache or database.
- Ordinary module sensors and the aggregate project sensor rely on scanner lifecycle ordering and are not independently synchronized. The bundled scanner executes these sensor phases sequentially.
- Kotlin package maps are populated lazily once per locator. Later lookup reuses the in-memory map.
- Multiple reports can target one file. Scanner coverage storage performs the merge described in section 9.

Provenance: `src/main/java/org/sonar/plugins/jacoco/ProjectCoverageContext.java`; `ReportPathsProvider.java`; `KotlinFileLocator.java`; scanner-engine source `org/sonar/scanner/sensor/ProjectSensorsExecutor.java` and `DefaultSensorStorage.java`.

## 12. Failure, partial-result, and recovery behavior

### 12.1 Missing paths

- Missing ordinary explicit paths do not fail analysis. If none match, defaults are checked. A configured miss produces an analysis warning; absence of configuration does not.
- Missing aggregate paths do not fail analysis, do not trigger defaults, and produce analysis warnings per unmatched pattern.
- Path-scan exceptions and filesystem-root wildcard refusal are logged and treated as no matches.

### 12.2 Report isolation

Each resolved report is processed inside its own failure boundary. Any parse, read, or unexpected import exception for one report:

- logs an error identifying the report and exception;
- adds one unique analysis warning for that report message;
- omits coverage from that failed report to the extent it had not already been saved;
- continues with remaining reports.

Because coverage is saved source file by source file, a report that fails after earlier saves may leave those earlier observations present. There is no report-level rollback.

### 12.3 Source-file isolation

- An unmapped XML source file is warned about and skipped.
- If scanner coverage validation rejects observations for one mapped file, the importer logs that file's invalid coverage, skips its failed save, and continues with other source files. This per-file failure does not add an analysis warning through the importer.
- A Kotlin content-read failure logs the read error and removes only that file from fallback mapping.

### 12.4 Recovery

The importer has no retry loop for unreadable or invalid reports. Recovery consists of correcting report paths or XML, ensuring files are indexed under compatible package paths, and rerunning the analysis. Existing server coverage is not changed until a scanner report containing successfully imported observations is processed.

Provenance: `src/main/java/org/sonar/plugins/jacoco/ReportPathsProvider.java`; `WildcardPatternFileScanner.java`; `SensorUtils.java`; `KotlinFileLocator.java`; tests `SensorUtilsTest.java`, `JacocoSensorTest.java`, and `JacocoAggregateSensorTest.java`.

## 13. Security and trust boundaries

- Report paths are trusted scanner configuration. Absolute paths and wildcard prefixes can read any report file accessible to the scanner process; project containment is not enforced. Operators must restrict configuration and filesystem permissions.
- Wildcard traversal is bounded to depth 64 and is refused from a filesystem root, reducing accidental whole-filesystem scans. A fixed prefix should narrow broad patterns.
- XML is treated as UTF-8 data. DTD support is disabled, and namespace processing is disabled. The importer does not execute report content.
- Report content controls source filenames, group/package names, line numbers, and counters. Those values can affect mapping, warnings, and coverage observations but cannot create a new scanner input file.
- Source mapping is suffix-based and can select the first indexed file when paths are ambiguous. `[INFERENCE]` Reports used in repositories with duplicate suffixes should include aggregate group names or otherwise ensure unique indexed paths to prevent coverage attribution to an unintended file.
- Kotlin fallback reads source contents already available to the scanner. It does not access files outside the indexed Kotlin stream.
- Logs and analysis warnings expose configured report paths and source filenames. They must be handled according to checkout confidentiality requirements.
- The importer sends no network request itself. Imported coverage crosses the network only as part of the scanner report under scanner-gateway authentication and TLS.

Provenance: `src/main/java/org/sonar/plugins/jacoco/WildcardPatternFileScanner.java`; `XmlReportParser.java`; `ReversePathTree.java`; `SensorUtils.java`; `KotlinFileLocator.java`.

## 14. Compatibility and limits

- Release target is plugin `1.6.0.5741` at commit `d7ac50ea711e3321dabc2e4fbb7edf757507f892` with Community Build `26.8.0.126808`.
- Production classes target Java 11 bytecode. Runtime compatibility is governed by the host scanner, which requires Java 21 for this baseline.
- Build dependency is scanner plugin API `13.8.0.4399`.
- Plugin manifest declares minimum `Sonar-Version` `6.7`, `SonarLint-Supported=false`, and `Plugin-ChildFirstClassLoader=false`. The exact baseline pairing, not the historical minimum alone, is the conformance target.
- Selective loading eligibility is `gosu`, `groovy`, `java`, `kotlin`, or `scala`.
- Only XML reports with relevant JaCoCo `package`, `sourcefile`, and `line` information are useful. Binary `.exec` data is unsupported.
- No explicit JaCoCo producer version is checked. Compatibility is structural: required XML elements and integer attributes must meet section 7.
- Wildcard traversal depth is at most 64. Equal resolved `Path` values are imported once per ordinary or aggregate property; no canonical or physical-file deduplication occurs.
- Source lookup is suffix-based and may be ambiguous. Group-aware aggregate lookup improves but does not guarantee uniqueness when module names collide.
- Counter magnitudes for instructions are reduced to line covered/not-covered. Branch totals and covered branches remain integer condition counts.
- This plugin supplies no rules, issue locations, source highlighting, symbols, CPD, test execution, or coverage-file generation.

Provenance: `build.gradle`; `src/main/java/org/sonar/plugins/jacoco/WildcardPatternFileScanner.java`; `FileLocator.java`; `ReportImporter.java`.

## 15. Acceptance scenarios

1. **Pinned component.** Given the Community Build dependency inventory, the bundled plugin is `1.6.0.5741`. The source tag resolves to commit `d7ac50ea711e3321dabc2e4fbb7edf757507f892`, and the plugin reports LGPL 3 licensing.
2. **Ordinary explicit report.** Given `sonar.coverage.jacoco.xmlReportPaths` resolving to one regular XML file, the importer uses that file and does not add any default report, even if a default path also exists.
3. **Ordinary fallback.** Given a configured ordinary path that matches nothing and a valid file at `target/site/jacoco/jacoco.xml`, the importer warns about the configured miss, imports the default report, and continues analysis.
4. **No ordinary report.** Given no ordinary property and no file at any default location, the module sensor records module context, imports no coverage, logs an informational message, and succeeds.
5. **Aggregate missing report.** Given an aggregate pattern that matches nothing, the importer adds an analysis warning, does not check ordinary default paths, and succeeds with no aggregate coverage.
6. **Wildcard selection.** Given a wildcard beneath a fixed subdirectory, only regular files matching within 64 levels are returned. Given a wildcard whose traversal base is filesystem root, no file is returned and an error is logged.
7. **Line translation.** Given a mapped line with covered instructions, its line-hit observation is 1. Given only missed instructions, its line-hit observation is 0. Given covered and missed branches, total and covered conditions reflect their respective counts.
8. **Zero counters.** Given a line whose `mi`, `ci`, `mb`, and `cb` are all absent or zero, the importer creates no line or condition observation for that line.
9. **Missing optional counters.** Given a valid line with `nr` and no counter attributes, parsing succeeds and all optional counters are treated as zero.
10. **Malformed report isolation.** Given one malformed and one valid configured report, the malformed report adds an analysis warning, the valid report is still imported, and the JaCoCo sensor does not fail the overall analysis.
11. **Invalid file coverage isolation.** Given a valid XML report with one source entry whose line is outside scanner validity and another valid source entry, the invalid file is logged and skipped while valid file coverage is saved.
12. **Ordinary suffix ambiguity.** Given two indexed files with the same package-and-filename suffix, ordinary mapping selects the first indexed match rather than failing.
13. **Aggregate group disambiguation.** Given two modules with the same source suffix and an XML group matching one module's derived name, aggregate mapping attributes coverage to that module when its recorded source context resolves the path.
14. **Aggregate without group.** Given an aggregate source file without a group name and ambiguous suffixes, mapping falls back to the first group-agnostic indexed match.
15. **Kotlin fallback.** Given a `.kt` report entry whose directory suffix does not match but whose indexed Kotlin file declares the XML package and filename, the fallback locates the file and imports coverage.
16. **Unknown source.** Given an XML source file absent from indexed scanner files, the importer warns, saves no coverage for it, and processes later files.
17. **Report-path equality.** Given multiple patterns producing equal resolved `Path` values, that set member is imported once within the relevant property. Given distinct lexical aliases or a direct path and symbolic-link path to the same physical report, each distinct `Path` may be imported.
18. **Ordinary and aggregate coexistence.** Given ordinary and aggregate reports both covering one line, both sensors save observations; scanner storage merges line hits by covered-any and condition counts by maximum, not by addition.
19. **DTD independence.** Given a report that references the standard JaCoCo DTD but whose relevant elements are otherwise readable, the importer does not fetch or process the DTD and uses the inline XML data.
20. **No producer behavior.** Given only JaCoCo binary execution data and no XML, the plugin imports nothing; it does not generate XML or run tests.

## 16. Provenance index

- Identity, artifact metadata, compatibility, and license: `build.gradle`, `gradle.properties`, `LICENSE.txt`, `LICENSE_HEADER`, and the tag/commit URLs in section 1.
- Plugin registration and public properties: `src/main/java/org/sonar/plugins/jacoco/JacocoPlugin.java`.
- Ordinary lifecycle: `src/main/java/org/sonar/plugins/jacoco/JacocoSensor.java`.
- Aggregate lifecycle: `src/main/java/org/sonar/plugins/jacoco/JacocoAggregateSensor.java`.
- Path defaults, precedence, warnings, and telemetry: `src/main/java/org/sonar/plugins/jacoco/ReportPathsProvider.java`; `TelemetryProperties.java`.
- Wildcard and path behavior: `src/main/java/org/sonar/plugins/jacoco/WildcardPatternFileScanner.java`.
- XML contract: `src/main/java/org/sonar/plugins/jacoco/XmlReportParser.java`.
- File mapping: `src/main/java/org/sonar/plugins/jacoco/FileLocator.java`; `ModuleFileLocator.java`; `ProjectFileLocator.java`; `ReversePathTree.java`; `KotlinFileLocator.java`.
- Module/project state: `src/main/java/org/sonar/plugins/jacoco/ModuleCoverageContext.java`; `ProjectCoverageContext.java`.
- Coverage translation and failures: `src/main/java/org/sonar/plugins/jacoco/ReportImporter.java`; `SensorUtils.java`.
- Behavioral tests: `src/test/java/org/sonar/plugins/jacoco/ReportPathsProviderTest.java`; `WildcardPatternFileScannerTest.java`; `XmlReportParserTest.java`; `FileLocatorTest.java`; `ReversePathTreeTest.java`; `KotlinFileLocatorTest.java`; `ReportImporterTest.java`; `SensorUtilsTest.java`; `JacocoSensorTest.java`; `JacocoAggregateSensorTest.java`.
- Scanner merge and execution dependencies: scanner-engine artifact paths `org/sonar/scanner/sensor/DefaultSensorStorage.java` and `org/sonar/scanner/scan/SpringProjectScanContainer.java`.
