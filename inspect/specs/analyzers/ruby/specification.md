# Ruby Analyzer Specification

## 1. Identity and provenance

This specification covers the Ruby analyzer bundled with SonarQube Community Build `26.8.0.126808`.

- Distribution artifact: `org.sonarsource.slang:sonar-ruby-plugin:1.24.0.2550`.
- Plugin key: `ruby`; language key: `ruby`; native rule repository key: `ruby`.
- Plugin release source: `SonarSource/sonar-ruby`, tag `1.24.0.2550`, commit `406444ea31e5724951252db4bb87a74a69893dae`.
- Primary license: Sonar Source-Available License v1.0, recorded as `LicenseRef-SSAL-1.0`. It is not a GPL or AGPL copy-marker case.
- Shared analyzer dependencies: `org.sonarsource.slang:slang-api:1.21.0.8303`, `slang-checks:1.21.0.8303`, and `slang-plugin:1.21.0.8303`; Analyzer Commons `2.27.0.5007`; Sonar Plugin API `12.0.0.2960` at plugin build time.
- Embedded parser dependencies: JRuby `9.4.14.0`, `parser` gem `3.3.10.0`, `ast` gem `2.4.3`, and Java Racc gem `1.8.1-java`.
- The embedded JRuby payload offers GPL v2, LGPL v2.1, or EPL v2 alternatives. It is not an exclusively GPL-licensed subtree; an implementation or redistribution must choose an applicable alternative and preserve dependency notices. Parser-gem and other packaged dependency notices remain independently applicable.
- Manifest compatibility: minimum Sonar API version declared by the plugin is `6.7`, minimum JRE is 17, child-first class loading is disabled, SonarLint support is declared, and the plugin is required only when Ruby files exist.

### Shared-engine provenance limit

Ruby pins SLang `1.21.0.8303`, and the exact published Maven source artifacts were reviewed. Their locally verified SHA-256 values are `0661e8d735bfaaea75db6ffa15d7731efe686a7d04a9a031fd1b043de0d513d9` for `slang-api`, `97ec97b7f487d76a33781eeca166592e08ca825adf62197c9cb9929c4c94fc31` for `slang-checks`, and `9f5206d25910a282859a6f63b93edc5d3021d0b6fcab4323ee6c143f5534a569` for `slang-plugin`. The public `SonarSource/slang` repository has no matching tag or otherwise proven public commit for this version. Consequently, this specification attributes shared behavior to those exact artifacts, not to a Git revision. It makes no claim about unobserved SLang revisions or internals.

## 2. Purpose, ownership, and exclusions

The analyzer recognizes Ruby source, parses it without executing project code, converts the parser result into the shared SLang syntax model, runs Ruby-native rules, and emits issues, source measures, highlighting, and duplication tokens. In SonarQube mode it also imports SimpleCov line coverage and RuboCop external issues.

This part owns Ruby recognition, conversion, native rule semantics, Ruby-specific settings, Ruby test-file heuristics, and Ruby report adapters. It consumes platform contracts for file indexing, effective settings, active rules and parameters, quality profiles, scanner caching, issue and measure transport, persistence, and issue lifecycle.

The following are outside scope:

- RuboCop and SimpleCov execution. The analyzer only reads their output.
- Generic scanner source/test/exclusion precedence and storage of produced results.
- Branch coverage, test-execution reports, dependency resolution, bytecode, runtime reflection, cross-file type resolution, or data-flow analysis.
- Commercial Ruby behavior and behavior from later plugin or SLang releases.
- JRuby, the parser gems, and SLang as independently reimplemented products.

## 3. Language and file recognition

### 3.1 Language registration

The language display name is Ruby and the stable language key is `ruby`. By default, files ending in `.rb` are Ruby inputs. `sonar.ruby.file.suffixes` is a project-scoped multi-value setting; a nonempty effective value replaces the default suffix list. An absent or empty list falls back to `.rb`. Filename, shebang, and file content do not independently cause Ruby recognition.

`sonar.ruby.exclusions` is a project-scoped multi-value exclusion surface with default `**/vendor/**`. The Ruby input-file filter leaves non-Ruby files untouched and rejects Ruby files whose URI matches an effective wildcard. Generic scanner exclusions remain platform-owned and apply independently.

Only indexed `MAIN` Ruby files reach native analysis. Indexed `TEST` files are not parsed by the Ruby sensor. A file indexed as main may nevertheless be marked test-like for rule execution when `sonar.tests` is absent and its project-relative path matches `**/*_spec.rb` or `**/*_test.rb`. Setting a nonblank `sonar.tests`, or setting `sonar.testFileHeuristic.disabled=true`, disables that path heuristic. The heuristic emits one analysis warning when it first classifies a file and affects only rules that consult the test classification; it does not change metrics or scanner file type. In this release, native rule `S2068` is the only Ruby rule that suppresses findings on test-classified input.

### 3.2 Accepted syntax and conversion

The embedded parser uses the Ruby 3.3 dialect supplied by `Parser::Ruby33`. This is the compatibility boundary evidenced by the pinned source; no broader Ruby-version guarantee is made. Parser warnings are ignored and parser errors are fatal for the current file. Input is forced to the parser's default encoding before tokenization.

One embedded JRuby runtime is initialized for a sensor execution. The analyzer loads only its bundled parser libraries and fixed parser bridge. It requests an AST, comments, and lexical tokens. Comment tokens are removed from the normal token stream but retained as comments. The converter preserves source ranges and classifies keywords, string literals, and other tokens for downstream services.

The converter gives structured SLang forms to classes, functions, parameters, variables, assignments, blocks, conditionals, `case` branches, loops, exception handling, returns and jumps, literals, and recognized unary and binary operators. Other valid Ruby nodes remain syntax-preserving native nodes with converted children rather than being discarded. A comments-only file produces a top-level tree. A whitespace-only file is skipped before parsing. A nonblank file from which neither tokens nor comments can be obtained is a parse failure.

The resulting model is syntactic. No classpath, gem graph, symbol binding, inferred type, call graph, or cross-file semantic index is constructed. Syntactic-equivalence checks compare converted structures; they do not prove runtime equivalence.

## 4. Configuration and precedence

The analyzer consumes the effective values already resolved by the scanner and platform. Within this analyzer, explicit nonempty language suffixes replace the fallback; explicit rule parameters replace the defaults below; configured report paths select report importers. There is no report auto-discovery beyond the registered SimpleCov default.

| Key | Scope and default | Effect |
|---|---|---|
| `sonar.ruby.file.suffixes` | Project, multi-value; `.rb` | Ruby file recognition. |
| `sonar.ruby.exclusions` | Project, multi-value; `**/vendor/**` | Ruby-only URI wildcard filter. |
| `sonar.ruby.coverage.reportPaths` | Project, multi-value; `coverage/.resultset.json` | SimpleCov JSON report paths, absolute or relative to project base. |
| `sonar.ruby.rubocop.reportPaths` | Project, multi-value; no default | RuboCop JSON report paths, absolute or relative to project base. |
| `sonar.tests` | Scanner setting; no analyzer default | A nonblank value disables Ruby's fallback test-path heuristic. |
| `sonar.testFileHeuristic.disabled` | Boolean; `false` | `true` disables fallback test classification. |
| `sonar.slang.converter.validation` | Diagnostic setting; unset | Unset disables validation; `throw` makes the first converted-tree invariant failure a file parse failure; `log` records the first failure of each kind and reports them when conversion terminates. Any other value is an analysis configuration failure. |
| `sonar.slang.duration.statistics` | Diagnostic boolean; `false` | When true, logs aggregate parse and visitor durations. It does not change results. |

Rule activation and rule-parameter precedence belong to the project-configuration contract. The analyzer registers a built-in `Sonar way` profile. Its native active keys are `S100`, `S101`, `S107`, `S108`, `S117`, `S131`, `S1066`, `S1110`, `S1134`, `S1135`, `S1145`, `S1172`, `S1186`, `S1192`, `S1313`, `S1479`, `S1481`, `S1656`, `S1763`, `S1764`, `S1862`, `S1871`, `S1940`, `S2068`, `S2757`, `S3776`, `S3923`, `S4144`, and `S4663`. `ParsingError` and the other shipped native rules remain available for profile activation. The beta server-side `RubyProfileRegistrar` extension may append rule keys from any repository to this built-in profile; it does not define those rules or alter their implementations.

## 5. Native analysis pipeline and lifecycle

For each indexed main Ruby file, in scanner iteration order, the analyzer performs these stages:

1. Check cancellation before starting the file.
2. Determine test-like status from scanner type or, for an otherwise-main file, the fallback path heuristic.
3. If unchanged-file skipping is available, require both scanner status `SAME` and a matching cached content hash. Reuse cached CPD tokens when possible; a cache miss or malformed cache entry causes normal parsing rather than loss of analysis.
4. Read content. A read failure becomes a parse/analysis error for that file.
5. Skip content containing only whitespace.
6. Parse and convert Ruby syntax.
7. Run SonarQube visitors in fixed order: discover declaration-level suppression metadata; calculate and save metrics; register non-header `NOSONAR` lines; run active checks; emit CPD tokens; then save syntax highlighting. Ruby has no source annotation form that populates SLang suppression annotations, so `NOSONAR` is its effective native inline suppression mechanism. Because each visitor has an independent failure boundary, outputs saved by an earlier visitor remain when a later visitor fails.
8. Store the next-analysis content hash and terminate the JRuby converter after the sensor finishes, is cancelled, or exits through the protected analysis loop.

Native file traversal is sequential. The analyzer holds no durable project state. Scanner caches are optimization state only; platform parts own persisted issues, measures, coverage, source, and duplication results.

In SonarLint, visitor order is suppression discovery, `NOSONAR` registration, then native checks. The SonarQube-only visitors for metrics, CPD, and highlighting are not registered. RuboCop and SimpleCov importers and their property definitions are also omitted. The Ruby profile definition remains registered, subject to the consuming product's profile contract.

## 6. Native rule catalog

There are 42 shipped native rule keys, including `ParsingError`. Classification below is legacy rule type and default severity. A “file location” means an issue without a text range. Rules run only when active.

Exact Ruby naming defaults are `S100.format = ^(@{0,2}[\da-z_]+[!?=]?)|([*+-/%=!><~]+)|(\[]=?)$`, `S117.format` with the same value, and `S101.format = ^[A-Z][a-zA-Z0-9]*$`.

| Key | Classification | Detection, exclusions, parameters, and issue location |
|---|---|---|
| `ParsingError` | Code smell / Major | On a read or conversion failure, records an analysis error and, when this rule is active, a native issue. Location is the parser-reported line when available, otherwise the file. Whitespace-only files are excluded. |
| `S100` | Code smell / Minor | Reports a non-constructor function name that fails `format`, using the exact Ruby naming default stated above. Nameless functions are excluded. Location: function-name identifier. |
| `S101` | Code smell / Minor | Reports a class name that fails `format`, default `^[A-Z][a-zA-Z0-9]*$`. Classes without an identifier are excluded. Location: class identifier. |
| `S103` | Code smell / Major | Reports each physical line longer than `maximumLineLength`, default 200. Location: complete line range. |
| `S104` | Code smell / Major | Reports when file noncomment lines of code exceed `Max`, default 1000. Location: file. |
| `S105` | Code smell / Minor | Reports once when any tab character occurs anywhere in file content. Location: file. |
| `S1066` | Code smell / Major | Reports an `if` without an `else` whose sole then-branch statement is another `if` without an `else`. Location: outer keyword; nested keyword is secondary. |
| `S1067` | Code smell / Critical | Counts conditional AND/OR operators in the outer binary expression and reports above `max`, default 3. Nested binary nodes do not receive duplicate issues. Location: full expression; effort gap is excess operator count. |
| `S107` | Code smell / Major | Reports non-constructor, non-override functions with more than `Max` parameters, default 7. Location: function name, or full function when nameless; excess parameters are secondary locations. |
| `S108` | Code smell / Major | Reports an uncommented empty block, or a `case` with no branches. Function bodies, native-node blocks, and `while`/`until` loop bodies are excluded from the block check. Location: empty block or match structure. |
| `S1110` | Code smell / Major | Reports a parenthesized expression directly nested in another parenthesized expression. Location: inner opening parenthesis; inner closing parenthesis is secondary. |
| `S1134` | Code smell / Major | Finds the case-insensitive standalone marker `FIXME` in comments. Location: marker text. |
| `S1135` | Code smell / Info | Finds the case-insensitive standalone marker `TODO` in comments. Location: marker text. |
| `S1145` | Bug / Major | Reports an `if` condition that is a Boolean literal, or a simple same-operator logical expression made inevitably false by a false operand or inevitably true by a true operand. Parentheses are ignored. Location: condition. |
| `S1151` | Code smell / Major | Reports a `case` branch whose noncomment lines exceed `max`, default 15. Location: branch highlight range. |
| `S117` | Code smell / Minor | Reports function parameters and local variables declared inside a function when the identifier fails `format`; default is the Ruby regex used by `S100`. Location: identifier. |
| `S1172` | Code smell / Major | Uses syntactic references to find unused parameters in top-level functions and private non-override methods. Constructors, case-insensitive `main`, bodyless functions, ordinary public methods, any method containing an implicit `super` call, and parameters referenced in the body are excluded. The release first retains the complete unused-parameter list, then uses interpolated/evaluated/query-like string-token names only to control reporting: for each unused name absent from those tokens, it emits one identical grouped issue anchored on the first unused identifier, with every member of the original unfiltered unused list as a secondary location. Therefore two unmentioned unused names produce two identical issues; a string-mentioned name remains in the reported group when another unused name is unmentioned; only when every unused name appears in those string tokens is no issue emitted. |
| `S1186` | Code smell / Critical | Reports a non-constructor function with an empty body unless the body or its closing line contains a comment. Location: body. |
| `S1192` | Code smell / Critical | Groups identical string contents across a file. Contents must be longer than five characters, contain something other than word characters, and occur at least `threshold` times; default 3. Location: first literal; remaining occurrences are secondary; effort gap is occurrence count minus one. |
| `S122` | Code smell / Major | Reports when multiple top-level or block statements start on one line. Location: second statement; third and later statements are secondary. |
| `S126` | Code smell / Critical | Reports an `if`/`elsif` chain with no final `else` when at least one branch does not end in return, break/continue, or raise. A lone `if` without `elsif` is excluded. Location: final `elsif` transition. |
| `S131` | Code smell / Critical | Reports a `case` structure with no default branch. Location: `case` keyword. |
| `S1313` | Code smell / Minor | Reports a string whose complete content is a valid IPv4 or IPv6 address, optionally in the accepted URL form. Excludes invalid numeric forms; IPv4 loopback, `2.5.*`, documentation networks, broadcast, and unspecified addresses; and IPv6 loopback, unspecified, documentation, and mapped-loopback forms. Location: string literal. |
| `S1314` | Code smell / Blocker | Reports an octal integer except values below 8 and exactly three-digit octal values used as permission-like masks. Location: literal. |
| `S134` | Code smell / Critical | Reports control-flow nesting deeper than `max`, default 3, across conditionals, loops, `case`, and exception handling. `elsif` chains do not add depth and ternary forms are excluded. Location: offending control-flow keyword; enclosing levels are secondary. |
| `S138` | Code smell / Major | Reports a function body with more than `max` noncomment lines, default 100. Bodyless functions are excluded. Location: function highlight range. |
| `S1451` | Code smell / Blocker | With `isRegularExpression=false` by default, requires the file's first lines to equal `headerFormat` line for line; `headerFormat` defaults to an empty string. With `isRegularExpression=true`, searches from the beginning using the configured multiline expression. Location: file. An invalid expression fails check initialization; an empty regular-expression format is invalid for this implementation. |
| `S1479` | Code smell / Major | Reports a `case` with more than `maximum` branches, default 30. Location: `case` keyword; every branch is secondary. |
| `S1481` | Code smell / Minor | In outermost function scopes, reports a declared local with no syntactically equivalent use. Nested function scopes are not checked independently. Names found in interpolated/evaluated/query-like string tokens are excluded. Location: variable identifier. |
| `S1656` | Bug / Major | Reports a plain assignment whose left and right sides are syntactically equivalent. Compound assignments are excluded. Location: assignment expression. |
| `S1763` | Bug / Major | Reports a return, raise, break, or continue followed by another statement in the same block. Location: terminating statement. |
| `S1764` | Bug / Major | Reports syntactically equivalent operands for binary operators other than addition and multiplication. Placeholder-containing expressions are excluded. Location: right operand; left operand is secondary. |
| `S1821` | Code smell / Critical | Reports any `case` nested within another `case`. Location: nested `case` keyword. |
| `S1862` | Bug / Major | Reports later syntactically duplicated conditions in an `if`/`elsif` chain or `case` branches. Parentheses are ignored. Location: duplicate condition; original is secondary. |
| `S1871` | Code smell / Major | Reports a later branch with a syntactically duplicated implementation when the duplicated body spans multiple lines. Structures in which every present branch is identical are left to `S3923`. Location: duplicate body; original body is secondary. |
| `S1940` | Code smell / Minor | Reports negation of an equality or ordering comparison when the opposite comparison operator can express it directly. Location: complete negated expression. |
| `S2068` | Vulnerability / Major | Outside test-classified files, reports nonempty string assignments to variables or members whose names contain a configured credential word, credential-like key/value text inside string literals, and URLs with distinct user and password components. `credentialWords` defaults to `password,passwd,pwd,passphrase`. It excludes values classified as fake, placeholder, interpolated, environment/config sourced, encrypted, secret-store references, structured noncredentials, common sample values, and query placeholders; it also excludes a value containing the same credential word as its variable name. Location: assigned identifier/member or string literal. |
| `S2757` | Bug / Major | Reports a plain assignment followed immediately by a unary negation, plus, or minus token when whitespace exists before the assignment token but not between the two operator tokens. Location: the adjacent operator pair. |
| `S3776` | Code smell / Critical | Computes function Cognitive Complexity and reports values above `threshold`, default 15. Named functions only. Loops, matches, catches, conditionals, `else`, logical-operator sequence changes, and nesting contribute according to the shared model. Location: function highlight range; each increment is secondary; effort gap is excess complexity. |
| `S3923` | Bug / Major | Reports an `if`/`elsif`/`else` or `case` only when it has more than one branch, includes a final branch, and every branch body is syntactically equivalent. Location: complete conditional structure. |
| `S4144` | Code smell / Major | Within the same syntactic parent, reports later non-constructor functions whose parameters, native children, and body match an earlier function. A candidate body must contain at least two statements. Location: duplicate function name or function; original name/function is secondary. |
| `S4663` | Code smell / Minor | Reports a multi-line comment whose content becomes empty after trimming. Location: comment. |

## 7. Measures, highlighting, symbols, and duplication

In SonarQube mode, a successfully converted file produces these core measures:

- `ncloc`: distinct token-derived lines of code.
- `comment_lines`: nonblank comment-content lines, excluding comments before the first declaration and excluding `NOSONAR` comments.
- `functions`: named declarations with bodies.
- `classes`: converted class declarations.
- `complexity`: one increment for each named function with a body, conditional, loop, non-default `case` branch, and conditional AND/OR operator.
- `statements`: nondeclaration entries in blocks plus eligible nonnative top-level entries.
- `cognitive_complexity`: shared Cognitive Complexity over the complete file tree.
- Per-line data keys `ncloc_data` and `executable_lines_data`. An executable line is the starting line of a top-level or block member other than a package, import, class, function, or block node.

Syntax highlighting marks comments, keyword tokens, string literals, and other literals as constants. Ruby modules and unsupported syntax retained as native nodes do not become classes or functions unless the converter expressly gives them that structured form.

The analyzer registers no symbol-table or symbol-reference producer. It emits no semantic index.

CPD receives the converter's noncomment token stream. String-literal token text is normalized to `LITERAL`; other token text is preserved. Ruby sets no later CPD start marker, so all normal tokens are submitted. CPD tokens and content hashes may be cached; cache corruption degrades to full analysis and a warning rather than changing intended results.

## 8. SimpleCov coverage import

The SimpleCov sensor is SonarQube-only and is enabled for analyses containing Ruby. It reads each effective `sonar.ruby.coverage.reportPaths` entry after trimming whitespace. Relative paths resolve through the scanner file system or project base; absolute paths are accepted. The registered default is `coverage/.resultset.json`.

Two JSON shapes are accepted:

- JSON Formatter shape: a top-level `coverage` object maps absolute source paths to objects containing a `lines` array.
- Legacy result-set shape: each top-level test-framework entry contains a `coverage` object mapping absolute source paths directly to hit arrays. This shape is imported but produces a deprecation warning recommending the newer formatter.

Array index one maps to source line one. Each numeric hit eligible for import is a JSON integer the parser represented as a signed 64-bit value, and the importer narrows it to signed 32 bits before merging. A parser-accepted value within signed 64-bit range but outside signed 32-bit range wraps modulo 2^32; a JSON integer the parser cannot represent as signed 64-bit may instead reject that report before narrowing and follows malformed-report behavior. Contributions are added with signed 32-bit arithmetic across framework entries and successfully parsed configured reports, so sums may also wrap. A numeric zero records an uncovered executable line. Null represents unavailable coverage and is not saved unless another report contributes a positive count; null combined only with zero remains unavailable. Other array value types are ignored. If narrowing or addition produces a negative hit count, coverage recording for that resolved file can fail at the coverage API boundary; the importer logs invalid coverage for that file and continues with other files.

Coverage is attached only when the report's absolute path resolves to an indexed input file. The importer does not independently validate language or suffix. Unresolved files produce warnings unless their paths match Ruby exclusions. Coverage consists only of line hits; no branch observations are emitted.

A missing explicitly configured report logs an error and does not block other paths. A malformed JSON report is isolated, logged, and does not block valid reports. An I/O failure while collecting report content aborts that importer execution. Invalid line numbers for one resolved file are logged and do not block other resolved files.

## 9. RuboCop external-issue import

The RuboCop sensor is SonarQube-only and runs only when `sonar.ruby.rubocop.reportPaths` is present. Each configured path names one JSON file; relative paths resolve against project base. Wildcard expansion is not performed. Missing paths create a scanner warning and a user-visible analysis warning while existing paths continue.

The report root may contain a `files` array. Each file entry supplies `path` and an optional `offenses` array. Each offense supplies `cop_name`, `message`, and optional `location`. Location fields are `start_line`, `start_column`, `last_line`, and `last_column`; if `start_line` is absent, `line` is used as its fallback.

A valid offense requires nonblank rule key, file path, and message. The path must resolve through the scanner input-file path predicate. Unresolved paths are skipped and summarized once, sorted, with at most 20 names shown. The importer does not run RuboCop and does not require the target input to have a Ruby suffix once the path resolves.

The external engine id is `rubocop`, and external repository keys appear under `external_rubocop`. The issue rule id is the report's `cop_name`; the report message is preserved. A complete location becomes a range after converting RuboCop's one-based start column to a zero-based scanner offset. A start line without a complete range selects the entire line. An invalid range falls back to the start line when that line is valid. With no start line, the issue is file-located.

The bundled external metadata catalog contains 542 known RuboCop keys: 535 code smells and 7 vulnerabilities, with 282 Minor, 142 Major, and 118 Info defaults. All have five-minute constant remediation metadata. A known id receives catalog type, severity, and remediation. An id absent from the catalog is still imported with Code Smell, Major, and five minutes. External findings are report-driven and are not native Ruby-rule findings.

Malformed JSON, unreadable files, invalid field types, and invalid locations are logged at report level. Failure does not roll back issues already saved before a runtime location error. An empty or missing `files` array yields no issues.

## 10. Failure, partial results, and recovery

- A file parse failure does not stop later files. It records an analysis error and optionally `ruby:ParsingError`; native metrics, highlighting, CPD, and rule issues for that file are absent.
- A failure in one post-parse visitor records an analysis error, logs the failure, and allows later visitors for that file to run. Results from earlier successful visitors remain partial.
- Cancellation is observed between files. Converter termination still occurs inside the analysis lifecycle.
- Empty and whitespace-only files produce no native results and no parse error.
- Missing or corrupt caches trigger ordinary analysis. Cache write failures warn but do not fail analysis.
- SimpleCov and RuboCop failures follow their independent partial-result behavior described above; one importer does not define native-analysis success.
- The analyzer performs no retries. A corrected source file, setting, or report is recovered on the next scanner analysis.

## 11. Security and trust boundaries

Ruby source and imported reports are untrusted input. The analyzer must tokenize and parse source, never evaluate it. The embedded JRuby runtime executes only the bundled parser bridge and libraries; project Ruby files, gems, initializers, and macros are not loaded or run. No network access is required for source analysis.

Report paths are trusted scanner configuration and may name any local file readable by the scanner process. RuboCop messages and ids are untrusted external data and must be passed through platform serialization. Report source paths can attach data only to already indexed files; they cannot create components. JSON parse and location failures must remain bounded to the behaviors above rather than causing project code execution.

`NOSONAR` is recognized case-insensitively only when it begins trimmed non-header comment content. Nonblank lines of that comment are registered with the platform suppression filter. A `NOSONAR` in a file-header comment is not registered.

## 12. Acceptance scenarios

1. **Default recognition:** Given indexed main files with `.rb` and unrelated suffixes, when no suffix override is set, only the `.rb` files are offered to the Ruby sensor.
2. **Ruby exclusion:** Given a recognized Ruby file under a vendor path and the default exclusion, analysis omits that file. A coverage entry for the same excluded path produces no missing-file warning.
3. **Custom suffix:** Given a nonempty `sonar.ruby.file.suffixes`, files matching that list are recognized and `.rb` is not implicitly added.
4. **Parser dialect:** Given valid Ruby 3.3-dialect content, analysis creates a converted tree without executing the file. Given invalid content with a diagnostic position, the file receives an analysis error and an active `ParsingError` issue on the reported line.
5. **Comments-only input:** Given a nonblank file containing only comments, analysis retains comments for highlighting and comment rules without raising the no-AST parse failure.
6. **Test heuristic:** Given a main-indexed path ending `_spec.rb`, no configured `sonar.tests`, and active `S2068`, the file is classified test-like, one heuristic warning is emitted, and `S2068` produces no issue. Other active native rules and normal metrics still run.
7. **Native parameter:** Given an active naming rule with a project-specific regular expression, detection uses that expression rather than the shipped default and anchors an issue on each nonconforming identifier in scope.
8. **Metrics and CPD:** Given a valid nonempty file in SonarQube mode, the analyzer emits all listed file measures, line data, highlighting, and CPD tokens; string token contents are normalized only for CPD.
9. **SimpleCov merge:** Given two valid configured reports containing in-range hit arrays for the same absolute indexed file, hit counts are merged by one-based line number and saved as line coverage; null-only lines remain unavailable.
10. **SimpleCov overflow:** Given a parser-produced signed 64-bit hit count outside signed 32-bit range but within signed 64-bit range, or a sum of signed 32-bit contributions that exceeds signed 32-bit range, narrowing or addition wraps. If the result is negative and the coverage API rejects it, that file's coverage is not saved, invalid coverage is logged, and other files continue. A JSON integer outside the parser's signed 64-bit representation may reject the report before narrowing instead.
11. **SimpleCov partial failure:** Given one malformed report and one valid report, the malformed file is logged while coverage from the valid report is saved.
12. **RuboCop range:** Given a valid offense with complete location fields and a resolvable path, one `external_rubocop` issue is created at the converted range with the report rule id and message.
13. **Unknown RuboCop id:** Given a valid offense whose id is absent from the bundled catalog, it is still imported as Code Smell/Major with five-minute remediation.
14. **Missing external reports:** Given a configured nonexistent RuboCop path, no external issue is created; log and analysis warnings identify the configuration failure, while native analysis remains available.
15. **Unchanged-file cache failure:** Given an unchanged file and an unreadable CPD cache entry, the analyzer performs full parsing and regenerates results rather than silently skipping the file.
16. **SonarLint:** Given the SonarLint product, native checks and suppression run, but SimpleCov, RuboCop, source measures, highlighting, and CPD are not emitted by this plugin.

## 13. Provenance index

- Release pin, dependencies, plugin manifest, parser gem versions: `settings.gradle`, `gradle.properties`, `sonar-ruby-plugin/build.gradle`, `jruby-repackaged/build.gradle` at commit `406444ea31e5724951252db4bb87a74a69893dae`.
- Language keys, suffixes, exclusions, coverage and RuboCop settings, product gating: `sonar-ruby-plugin/src/main/java/org/sonarsource/ruby/plugin/RubyPlugin.java`, `RubyLanguage.java`, and `RubyExclusionsFileFilter.java`.
- Sensor wiring, test patterns, profile, rule registration: `RubySensor.java`, `RubyCheckList.java`, `RubyProfileDefinition.java`, `RubyRulesDefinition.java`, and `sonar-ruby-plugin/src/main/resources/org/sonar/l10n/ruby/rules/ruby/Sonar_way_profile.json`.
- Ruby parser and conversion: `sonar-ruby-plugin/src/main/resources/whitequark_parser_init.rb`; `sonar-ruby-plugin/src/main/java/org/sonarsource/ruby/converter/RubyConverter.java`, `RubyVisitor.java`, adapters, and converter tests.
- Ruby-specific unused checks: `sonar-ruby-plugin/src/main/java/org/sonarsource/ruby/checks/UnusedFunctionParameterRubyCheck.java`, `UnusedLocalVariableRubyCheck.java`, and their tests/resources.
- Native metadata: `sonar-ruby-plugin/src/main/resources/org/sonar/l10n/ruby/rules/ruby/*.json` and corresponding HTML descriptions.
- SimpleCov: `sonar-ruby-plugin/src/main/java/org/sonarsource/ruby/plugin/SimpleCovSensor.java`, `SimpleCovSensorTest.java`, and `src/test/resources/coverage/`.
- RuboCop: `sonar-ruby-plugin/src/main/java/org/sonarsource/ruby/externalreport/rubocop/`, its tests, and `src/main/resources/org/sonar/l10n/ruby/rules/rubocop/rules.json`.
- Shared pipeline, metrics, suppression, cache, CPD, highlighting, and checks: exact Maven sources at [slang-plugin 1.21.0.8303](https://repo1.maven.org/maven2/org/sonarsource/slang/slang-plugin/1.21.0.8303/slang-plugin-1.21.0.8303-sources.jar), [slang-checks 1.21.0.8303](https://repo1.maven.org/maven2/org/sonarsource/slang/slang-checks/1.21.0.8303/slang-checks-1.21.0.8303-sources.jar), and [slang-api 1.21.0.8303](https://repo1.maven.org/maven2/org/sonarsource/slang/slang-api/1.21.0.8303/slang-api-1.21.0.8303-sources.jar).
- Report-path and external-rule defaults: exact Maven source `org.sonarsource.analyzer-commons:sonar-analyzer-commons:2.27.0.5007`, SHA-256 `9f815a83b4eab83d202e8043317608e1f5071f573ecd09928633b4b2387f4271`.
- Bundle evidence: SonarQube `build.gradle` dependency `org.sonarsource.slang:sonar-ruby-plugin:1.24.0.2550` and `sonar-application/bundled_plugins.gradle` at commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`.
- Public release source: [tag `1.24.0.2550`](https://github.com/SonarSource/sonar-ruby/tree/1.24.0.2550) and [commit `406444ea31e5724951252db4bb87a74a69893dae`](https://github.com/SonarSource/sonar-ruby/commit/406444ea31e5724951252db4bb87a74a69893dae).
