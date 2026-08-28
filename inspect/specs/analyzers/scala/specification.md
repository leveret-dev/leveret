# Scala Analyzer Specification

## 1. Identity and provenance

This specification covers the Scala analyzer bundled with SonarQube Community Build `26.8.0.126808`.

- Distribution artifact: `org.sonarsource.slang:sonar-scala-plugin:1.24.0.2554`.
- Plugin key: `sonarscala`; language key: `scala`; native rule repository key: `scala`.
- Plugin release source: `SonarSource/sonar-scala`, tag `1.24.0.2554`, commit `f8e0a83baf34dbe3fb8313eca792f0abd6e47ff5`.
- Primary license: Sonar Source-Available License v1.0, recorded as `LicenseRef-SSAL-1.0`. It is not a GPL or AGPL copy-marker case.
- Shared analyzer dependencies: `org.sonarsource.slang:slang-api:1.21.0.8303`, `slang-checks:1.21.0.8303`, and `slang-plugin:1.21.0.8303`; Analyzer Commons `2.27.0.5007`; Sonar XML Parsing `2.27.0.5007`; Sonar Plugin API `13.2.0.3137` at plugin build time.
- Parser dependency: `org.scalameta:scalameta_2.13:4.14.1`.
- Scalameta, the Scala library, and other packaged parser dependencies retain their own mixed permissive or weak-copyleft notices. They do not change the analyzer-owned SSAL classification, and their notices must be preserved where applicable.
- Manifest compatibility: minimum Sonar API version declared by the plugin is `6.7`, minimum JRE is 11, child-first class loading is disabled, SonarLint support is declared, and the plugin is required only when Scala files exist.

### Shared-engine provenance limit

Scala pins SLang `1.21.0.8303`, and the exact published Maven source artifacts were reviewed. Their locally verified SHA-256 values are `0661e8d735bfaaea75db6ffa15d7731efe686a7d04a9a031fd1b043de0d513d9` for `slang-api`, `97ec97b7f487d76a33781eeca166592e08ca825adf62197c9cb9929c4c94fc31` for `slang-checks`, and `9f5206d25910a282859a6f63b93edc5d3021d0b6fcab4323ee6c143f5534a569` for `slang-plugin`. The public `SonarSource/slang` repository has no matching tag or otherwise proven public commit for this version. Consequently, this specification attributes shared behavior to those exact artifacts, not to a Git revision. It makes no claim about unobserved SLang revisions or internals.

## 2. Purpose, ownership, and exclusions

The analyzer recognizes Scala source, parses it without compiling or executing project code, converts accepted syntax into the shared SLang syntax model, runs Scala-native rules, and emits issues, source measures, highlighting, and duplication tokens. In SonarQube mode it also imports Scoverage line coverage and external issues in Scalastyle-format XML for Scalastyle and Scapegoat.

This part owns Scala recognition, dialect selection, syntax conversion, native rule semantics, Scala test-file heuristics, and Scala report adapters. It consumes platform contracts for file indexing and generic exclusions, effective settings, active rules and parameters, quality profiles, scanner caching, issue and measure transport, persistence, and issue lifecycle.

The following are outside scope:

- Scala compiler execution, macros, build-tool execution, bytecode inspection, dependency resolution, classpaths, inferred types, or cross-file symbol resolution.
- Scoverage, Scalastyle, and Scapegoat execution. The analyzer reads their reports only.
- Generic scanner source/test/exclusion precedence and persistence of produced results.
- Branch coverage, test-execution reports, or report generation.
- Commercial Scala behavior and behavior from later plugin, Scalameta, or SLang releases.
- Scalameta, SLang, and the external tools as independently reimplemented products.

## 3. Language and file recognition

### 3.1 Language registration

The language display name is Scala and the stable language key is `scala`. By default, files ending in `.scala` are Scala inputs. `sonar.scala.file.suffixes` is a project-scoped multi-value setting; a nonempty effective value replaces the default suffix list. An absent or empty list falls back to `.scala`. Filename content and build metadata do not independently cause Scala recognition.

The plugin defines no Scala-specific exclusion property. Generic scanner exclusions and source/test classification remain platform-owned.

Only indexed `MAIN` Scala files reach native analysis. Indexed `TEST` files are not parsed by the Scala sensor. A file indexed as main may nevertheless be marked test-like for rule execution when `sonar.tests` is absent and its project-relative path matches `**/test/**/*Spec.scala`, `**/test/**/*Test.scala`, or `**/test/**/*Suite.scala`. Setting a nonblank `sonar.tests`, or setting `sonar.testFileHeuristic.disabled=true`, disables this fallback. The heuristic emits one analysis warning when it first classifies a file and affects only checks consulting test status; it does not alter metrics or scanner file type. In this release, native rule `S2068` is the only Scala rule that suppresses findings on test-classified input.

### 3.2 Dialects and conversion

For each nonblank file, the Scalameta parser is tried in fixed order: default Scala 2, Scala 3, then Sbt1 script dialect. The first successful parse wins. If all fail, the last parser position and messages from all attempts form a file parse failure. The configured suffix, not the filename handed to the converter, controls whether a script reaches this parser; `.sbt` is not recognized unless the suffix list is changed.

The converter clears Scalameta's tokenizer cache before every file. It removes whitespace and comments from the normal token stream while retaining comments separately. It preserves token and source ranges and classifies keywords, string literals, and other literals. It collects annotation short names and textual arguments for native issue suppression.

The converter gives structured SLang forms to packages, imports, classes, functions and constructors, parameters, variables, assignments, blocks, conditionals, loops, matches and cases, exception handling, returns and throws, literals, and recognized unary and binary operators. Unsupported but valid Scala constructs are retained as syntax-preserving native nodes with converted children. Interpolated strings with arguments remain native structures rather than ordinary string literals. Objects, traits, and other forms not expressly mapped to a class declaration remain native nodes.

The model is syntactic. There is no compiler-backed semantic model, classpath, inferred type, overload selection, macro expansion, symbol binding, call graph, or cross-file index. Rule comparisons based on names or structural equivalence do not establish semantic identity.

## 4. Configuration and precedence

The analyzer consumes effective values resolved by the scanner and platform. Explicit nonempty suffixes replace the fallback. Active-profile rule parameters replace the defaults in the native catalog. Report importers run only when their keys are configured; no Scala report has a default path.

| Key | Scope and default | Effect |
|---|---|---|
| `sonar.scala.file.suffixes` | Project, multi-value; `.scala` | Scala file recognition. |
| `sonar.scala.coverage.reportPaths` | Project, multi-value; no default | Scoverage XML report paths, absolute or relative to project base. |
| `sonar.scala.scalastyle.reportPaths` | Project, multi-value; no default | Scalastyle/checkstyle XML paths. |
| `sonar.scala.scapegoat.reportPaths` | Project, multi-value; no default | Scapegoat reports in Scalastyle/checkstyle XML form. |
| `sonar.tests` | Scanner setting; no analyzer default | A nonblank value disables Scala's fallback test-path heuristic. |
| `sonar.testFileHeuristic.disabled` | Boolean; `false` | `true` disables fallback test classification. |
| `sonar.slang.converter.validation` | Diagnostic setting; unset | Unset disables validation; `throw` makes the first converted-tree invariant failure a file parse failure; `log` records the first failure of each kind and reports them when conversion terminates. Any other value is an analysis configuration failure. |
| `sonar.slang.duration.statistics` | Diagnostic boolean; `false` | When true, logs aggregate parse and visitor durations without changing results. |

Rule activation and parameter precedence belong to the project-configuration contract. The analyzer registers a built-in `Sonar way` profile in SonarQube. Its active native keys are `ParsingError`, `S100`, `S101`, `S107`, `S108`, `S117`, `S125`, `S1066`, `S1125`, `S1134`, `S1135`, `S1144`, `S1145`, `S1172`, `S1186`, `S1192`, `S1313`, `S1479`, `S1481`, `S1656`, `S1763`, `S1764`, `S1862`, `S1871`, `S1940`, `S2068`, `S3776`, `S3923`, `S4144`, and `S4663`. Other shipped rules remain available for activation. There is no Scala profile-registrar extension in this release.

## 5. Native analysis pipeline and lifecycle

For each indexed main Scala file, in scanner iteration order, the analyzer performs these stages:

1. Check cancellation before starting the file.
2. Determine test-like status from scanner type or, for an otherwise-main file, the fallback path heuristic.
3. If unchanged-file skipping is available, require scanner status `SAME` and a matching cached content hash. Reuse cached CPD tokens when possible; a cache miss or malformed cache entry causes normal parsing.
4. Read content. A read failure becomes a parse/analysis error for that file.
5. Skip content containing only whitespace.
6. Try the three parser dialects and convert the first successful tree.
7. Run SonarQube visitors in fixed order: discover declaration-level suppression metadata; calculate and save metrics; register non-header `NOSONAR` lines; run active checks; emit CPD tokens; then save syntax highlighting. Because each visitor has an independent failure boundary, outputs saved by an earlier visitor remain when a later visitor fails.
8. Store the next-analysis content hash.

Annotation suppression recognizes annotations whose short name is `Suppress` or `SuppressWarnings` on converted functions, classes, variable declarations, and parameters. Every double-quoted argument value is treated as a candidate full rule key. A native issue is suppressed when its text range lies inside the annotated declaration and the argument equals the repository-qualified key, such as `scala:S100`. This mechanism does not suppress report-imported external issues.

Native file traversal is sequential. The analyzer keeps no durable project state. Scanner caches are optimization state only; platform parts own persisted issues, measures, source, coverage, and duplication results.

In SonarLint, visitor order is suppression discovery, `NOSONAR` registration, then native checks. The SonarQube-only visitors for metrics, CPD, and highlighting are not registered. The built-in profile, file-suffix property definition, Scoverage importer, Scalastyle importer, Scapegoat importer, and external rule repositories are also omitted by the plugin's product gating.

## 6. Native rule catalog

There are 41 shipped native rule keys, including `ParsingError`. Classification below is legacy rule type and default severity. A “file location” means an issue without a text range. Rules run only when active.

Exact Scala naming defaults are `S100.format = ^([a-z][a-zA-Z0-9]*+(_[^a-zA-Z0-9]++)?+|[^a-zA-Z0-9]++)$`, `S117.format = ^[_a-zA-Z][a-zA-Z0-9]*$`, and `S101.format = ^[A-Z][a-zA-Z0-9]*$`.

| Key | Classification | Detection, exclusions, parameters, and issue location |
|---|---|---|
| `ParsingError` | Code smell / Major | On a read or failure of all parser dialects, records an analysis error and, when active, a native issue. Location is the parser-reported line when available, otherwise the file. Whitespace-only files are excluded. This rule is active in the built-in profile. |
| `S100` | Code smell / Minor | Reports a non-constructor function name that fails `format`, using the exact Scala function/operator naming default stated above. Nameless functions are excluded. Location: function-name identifier. |
| `S101` | Code smell / Minor | Reports a class name that fails `format`, default `^[A-Z][a-zA-Z0-9]*$`. Classes without an identifier are excluded. Location: class identifier. |
| `S103` | Code smell / Major | Reports each physical line longer than `maximumLineLength`, default 200. Location: complete line range. |
| `S104` | Code smell / Major | Reports when file noncomment lines of code exceed `Max`, default 1000. Location: file. |
| `S105` | Code smell / Minor | Reports once when any tab character occurs anywhere in file content. Location: file. |
| `S1066` | Code smell / Major | Reports an `if` without an `else` whose sole then-branch statement is another `if` without an `else`. Location: outer keyword; nested keyword is secondary. |
| `S1067` | Code smell / Critical | Counts conditional AND/OR operators in the outer binary expression and reports above `max`, default 3. Nested binary nodes do not receive duplicate issues. Location: complete expression; effort gap is excess operator count. |
| `S107` | Code smell / Major | Reports non-constructor, non-override functions with more than `Max` parameters, default 7. Location: function name, or full function when nameless; excess parameters are secondary. |
| `S108` | Code smell / Major | Reports an uncommented empty block, or a match with no cases. Function bodies, native-node blocks, and `while` loop bodies are excluded from the block check. Location: empty block or match. |
| `S1125` | Code smell / Minor | Reports a redundant Boolean literal in negation, a conditional AND/OR expression, or a simple unchained `if` form. Chained `else if` forms and `if` branches represented as blocks are excluded. Location: Boolean literal. |
| `S1134` | Code smell / Major | Finds the case-insensitive standalone marker `FIXME` in comments. Location: marker text. |
| `S1135` | Code smell / Info | Finds the case-insensitive standalone marker `TODO` in comments. Location: marker text. |
| `S1144` | Code smell / Major | Within each outermost class, reports a strict private, non-override method whose name has no syntactic use in the class or matching companion object. It ignores `writeObject`, `readObject`, `writeReplace`, `readResolve`, and `readObjectNoData`. Location: method highlight range. This is syntactic and has no type-resolution guarantee. |
| `S1145` | Bug / Major | Reports an `if` condition that is a Boolean literal, or a simple same-operator logical expression made inevitably false by a false operand or inevitably true by a true operand. Parentheses are ignored. Location: condition. |
| `S1151` | Code smell / Major | Reports a match case whose noncomment lines exceed `max`, default 15. Location: case highlight range. |
| `S117` | Code smell / Minor | Reports function parameters and local variables declared inside a function when the identifier fails `format`, default `^[_a-zA-Z][a-zA-Z0-9]*$`. Location: identifier. |
| `S1172` | Code smell / Major | Uses syntactic references to find unused parameters in top-level functions and private non-override methods. Constructors, case-insensitive `main`, bodyless functions, ordinary public methods, parameters with modifiers, and parameters referenced in the body are excluded. Location: first unused identifier; all unused identifiers are secondary. |
| `S1186` | Code smell / Critical | Reports a non-constructor function with an empty body unless the body or its closing line contains a comment. Location: body. |
| `S1192` | Code smell / Critical | Groups identical string contents across a file. Contents must be longer than five characters, contain something other than word characters, and occur at least `threshold` times; default 3. String literals inside annotations are excluded. Location: first literal; remaining occurrences are secondary; effort gap is occurrence count minus one. |
| `S122` | Code smell / Major | Reports when multiple top-level or block statements start on one line. Location: second statement; third and later statements are secondary. |
| `S125` | Code smell / Major | Groups comments on consecutive lines and parses their combined content in a synthetic function body using the default Scalameta dialect. Reports groups that parse as substantive Scala code. Groups that do not parse, consist only of simple expression forms, or place multiple statements on the same reconstructed line are excluded. Location: merged comment group. |
| `S126` | Code smell / Critical | Reports an `if` without `else` when used directly as a variable initializer. It also reports an `if`/`else if` chain with no final `else` when at least one branch does not end in return, break/continue, or throw. Nested non-chain conditionals are excluded from the chain check. Location: full initializer conditional or final `else if` transition. |
| `S1313` | Code smell / Minor | Reports a string whose complete content is a valid IPv4 or IPv6 address, optionally in the accepted URL form. Excludes invalid numeric forms; IPv4 loopback, `2.5.*`, documentation networks, broadcast, and unspecified addresses; and IPv6 loopback, unspecified, documentation, and mapped-loopback forms. Location: string literal. |
| `S134` | Code smell / Critical | Reports control-flow nesting deeper than `max`, default 3, across conditionals, loops, matches, and exception handling. `else if` chains do not add depth and ternary forms are excluded. Location: offending keyword; enclosing levels are secondary. |
| `S138` | Code smell / Major | Reports a function body with more than `max` noncomment lines, default 100. Bodyless functions are excluded. Location: function highlight range. |
| `S1451` | Code smell / Blocker | With `isRegularExpression=false` by default, requires the file's first lines to equal `headerFormat` line for line; `headerFormat` defaults to an empty string. With `isRegularExpression=true`, searches from the beginning using the configured multiline expression. Location: file. An invalid expression fails check initialization; an empty regular-expression format is invalid for this implementation. |
| `S1479` | Code smell / Major | Reports a match with more than `maximum` cases, default 30. Location: match keyword; every case is secondary. |
| `S1481` | Code smell / Minor | In outermost function scopes, reports a declared local with no syntactically equivalent use. Nested function scopes are not checked independently. Location: variable identifier. |
| `S1656` | Bug / Major | Reports a plain assignment whose left and right sides are syntactically equivalent. Compound assignments are excluded. Location: assignment expression. |
| `S1763` | Bug / Major | Reports a return, throw, break, or continue followed by another statement in the same block. Location: terminating statement. |
| `S1764` | Bug / Major | Reports syntactically equivalent operands for binary operators other than addition and multiplication. Placeholder-containing expressions are excluded. Location: right operand; left operand is secondary. |
| `S1821` | Code smell / Critical | Reports any match nested within another match. Location: nested match keyword. |
| `S1862` | Bug / Major | Reports later syntactically duplicated conditions in an `if`/`else if` chain or match cases. Parentheses are ignored. Location: duplicate condition; original is secondary. |
| `S1871` | Code smell / Major | Reports a later branch with a syntactically duplicated implementation when the duplicated body spans multiple lines. Structures in which every present branch is identical are left to `S3923`. For match cases, both the original and duplicate must be cases without a pattern-bound variable; pattern-bearing cases are excluded. Location: duplicate body; original body is secondary. |
| `S1940` | Code smell / Minor | Reports negation of an equality or ordering comparison when the opposite comparison operator can express it directly. Location: complete negated expression. |
| `S2068` | Vulnerability / Major | Outside test-classified files, reports nonempty string assignments to variables or members whose names contain a configured credential word, credential-like key/value text inside string literals, and URLs with distinct user and password components. `credentialWords` defaults to `password,passwd,pwd,passphrase`. It excludes values classified as fake, placeholder, interpolated, environment/config sourced, encrypted, secret-store references, structured noncredentials, common sample values, and query placeholders; it also excludes a value containing the same credential word as its variable name. Location: assigned identifier/member or string literal. |
| `S3776` | Code smell / Critical | Computes function Cognitive Complexity and reports values above `threshold`, default 15. Named functions only. Loops, matches, catches, conditionals, `else`, logical-operator sequence changes, and nesting contribute according to the shared model. Location: function highlight range; each increment is secondary; effort gap is excess complexity. |
| `S3923` | Bug / Major | Reports an `if`/`else if`/`else` or match only when it has more than one branch, includes a final branch, and every branch body is syntactically equivalent. A match containing any pattern-bound case is excluded; conditionals are unaffected by that exclusion. Location: complete conditional structure. |
| `S4144` | Code smell / Major | Within the same syntactic parent, reports later non-constructor functions whose parameters, native children, and body match an earlier function. A candidate body must contain at least two statements. Location: duplicate function name or function; original name/function is secondary. |
| `S4663` | Code smell / Minor | Reports a multi-line comment whose content becomes empty after trimming. Location: comment. |

## 7. Measures, highlighting, symbols, and duplication

In SonarQube mode, a successfully converted file produces these core measures:

- `ncloc`: distinct token-derived lines of code.
- `comment_lines`: nonblank comment-content lines, excluding comments before the first declaration and excluding `NOSONAR` comments.
- `functions`: named declarations with bodies.
- `classes`: converted class declarations; native objects and traits are not counted as classes by this visitor.
- `complexity`: one increment for each named function with a body, conditional, loop, non-default match case, and conditional AND/OR operator.
- `statements`: nondeclaration entries in blocks plus eligible nonnative top-level entries.
- `cognitive_complexity`: shared Cognitive Complexity over the complete file tree.
- Per-line data keys `ncloc_data` and `executable_lines_data`. An executable line is the starting line of a top-level or block member other than a package, import, class, function, or block node.

Syntax highlighting marks comments, keyword tokens, string literals, and other literals as constants. The analyzer registers no symbol-table or symbol-reference producer and emits no semantic index.

CPD uses the noncomment token stream beginning with the first declaration token after package and import content. String-literal token text is normalized to `LITERAL`; other token text is preserved. Thus package and import headers do not seed Scala duplication blocks. CPD tokens and content hashes may be cached; cache corruption degrades to full analysis and a warning rather than changing intended results.

## 8. Scoverage import

The Scoverage sensor is SonarQube-only and runs only when `sonar.scala.coverage.reportPaths` is configured. Each configured path names one XML file; relative paths resolve against project base and wildcard expansion is not performed. Missing files create both log and user-visible analysis warnings while existing files continue.

The parser scans start elements named `statement` and reads three required attributes:

- `source`: absolute source-file path.
- `line`: integer one-based source line.
- `invocation-count`: integer hit count.

The `line` and `invocation-count` attributes are parsed as signed 32-bit integers. A value outside that range raises a numeric report error. Within one report, repeated statements for the same source path and line are added with signed 32-bit arithmetic, so individually valid counts can wrap. After the report is fully read, coverage is attached only when `source` exactly resolves to an indexed input file by absolute path. The importer does not independently validate language or suffix. Unresolved source paths are skipped and summarized once, sorted, with at most 20 shown. Only line hits are emitted; no branch observations are produced.

Malformed XML, missing or nonnumeric line/count attributes, out-of-range signed integers, and I/O failures log a report error and save no accumulated coverage from that report because saving occurs after parsing. A missing `source` attribute is a runtime report failure and can abort the sensor rather than being converted to the normal parse-error log path. A negative value, including one produced by repeat-count wrap, can be rejected while coverage is saved; that failure is outside the importer's listed catches and can abort the sensor after earlier report or file results were saved. Reports are processed independently; repeated statements are guaranteed to merge within one report subject to signed 32-bit behavior, but this adapter defines no cross-report merge contract for overlapping source files.

XML parsing uses the pinned safe StAX factory: DTD support, validation, entity replacement, and external entities are disabled.

## 9. Scalastyle and Scapegoat external-issue import

Both importers are SonarQube-only and use the same checkstyle-shaped XML reader. Scalastyle runs when `sonar.scala.scalastyle.reportPaths` is configured; Scapegoat runs when `sonar.scala.scapegoat.reportPaths` is configured. Each entry names one absolute or project-relative report file, without wildcard expansion. Missing files produce log and analysis warnings while existing files continue.

A report must have `checkstyle` as its root. At the next level, each `file` supplies a `name`. Direct child `error` elements supply:

- `source`: external rule id.
- `message`: issue text.
- `line`: optional one-based line.

The target file name must exactly resolve as an indexed absolute path. A valid issue requires nonempty `source` and `message`. An empty line creates a file-located issue; a nonempty valid line selects that complete line. Missing file names, empty rule ids/messages, and unresolved absolute paths create no issue. Unresolved paths are summarized once per importer, sorted, with at most 20 names shown.

The selected configuration property determines the engine, regardless of the rule-id namespace inside the report:

- Scalastyle uses engine id `scalastyle` and repository `external_scalastyle`.
- Scapegoat uses engine id `scapegoat` and repository `external_scapegoat`.

The bundled Scalastyle catalog contains 72 known keys, all Code Smell/Minor with five-minute remediation. The bundled Scapegoat catalog contains 123 known keys: 103 code smells and 20 bugs; 71 Minor and 52 Major; all use five-minute remediation. Known ids receive catalog metadata. Unknown ids are still imported as Code Smell/Major with five-minute remediation.

A malformed root, malformed XML, unreadable file, invalid line number, or other runtime report error is logged for that report. Issues saved earlier in the same stream are not rolled back. XML parsing disables DTDs, validation, entity replacement, and external entities. These importers do not run either external tool and do not turn report findings into native `scala` repository issues.

## 10. Failure, partial results, and recovery

- A file parse failure does not stop later files. It records an analysis error and active `scala:ParsingError`; native metrics, highlighting, CPD, and rule issues for that file are absent.
- A failure in one post-parse visitor records an analysis error, logs the failure, and allows later visitors for that file to run. Results from earlier successful visitors remain partial.
- Cancellation is observed between files.
- Empty and whitespace-only files produce no native results and no parse error.
- Missing or corrupt caches trigger ordinary analysis. Cache write failures warn but do not fail analysis.
- Scoverage, Scalastyle, and Scapegoat follow their independent partial-result rules above; importer failure does not redefine native-analysis success except for an uncaught runtime report failure.
- The analyzer performs no retries. Corrected source, settings, or reports are recovered by the next scanner analysis.

## 11. Security and trust boundaries

Scala source and imported reports are untrusted input. The analyzer parses syntax only; it must not invoke the project compiler, execute macros, load project classes, run Sbt, or evaluate source. No network access is required for native source analysis.

Configured report paths are trusted scanner configuration and may name any local file readable by the scanner process. External rule ids and messages are untrusted report data and must pass through platform serialization. Report source paths attach results only to indexed components and cannot create new files.

Scoverage, Scalastyle, and Scapegoat XML use a parser with DTDs and external entities disabled, preventing external-entity resolution. The report adapters do not impose an independent file-size or attribute-size limit; scanner process limits remain the enclosing boundary.

`NOSONAR` is recognized case-insensitively only when it begins trimmed non-header comment content. Nonblank lines of that comment are registered with the platform suppression filter. A `NOSONAR` in a file-header comment is not registered. `Suppress` and `SuppressWarnings` apply only to repository-qualified native rule keys and declaration-contained locations as described above.

## 12. Compatibility and limits

- Default recognition is `.scala`; Sbt syntax support is parser capability, not default `.sbt` discovery.
- Parser order is fixed, and the first successful dialect is authoritative. There is no project setting to force a dialect.
- External issue import depends on Sonar API 7.2 or later; on older runtimes the shared provider logs an incompatibility and returns no report files. The pinned Community Build satisfies this prerequisite.
- External report source paths for Scoverage, Scalastyle, and Scapegoat must be absolute and must match scanner-indexed paths exactly.
- There is no branch coverage, test-result import, symbol index, semantic model, or quick-fix producer.
- Native metrics and rules reflect the converted subset. Valid syntax retained only as native nodes remains available to generic traversal but does not acquire class/function semantics.

## 13. Acceptance scenarios

1. **Default recognition:** Given indexed main files with `.scala` and unrelated suffixes, when no suffix override is set, only `.scala` files are offered to the Scala sensor.
2. **Custom suffix and Sbt:** Given `.sbt` in `sonar.scala.file.suffixes`, an indexed Sbt script may reach the Sbt1 parser after Scala 2 and Scala 3 fail. Without that suffix override, the plugin does not discover it.
3. **Dialect fallback:** Given content rejected by Scala 2 but accepted by Scala 3, conversion succeeds with the Scala 3 result. Given content rejected by all three dialects, an analysis error and active `ParsingError` issue are created at the reported line.
4. **No compilation:** Given source containing compiler- or macro-dependent constructs, analysis parses syntax without invoking the compiler, resolving a classpath, or executing the construct.
5. **Test heuristic:** Given a main-indexed path under `test` ending `Spec.scala`, no configured `sonar.tests`, and active `S2068`, one heuristic warning is emitted and `S2068` produces no issue; other rules and normal metrics still run.
6. **Annotation suppression:** Given an active native issue wholly inside a declaration annotated with `SuppressWarnings` containing its full `scala:<key>`, that issue is omitted. The same short key without repository qualification does not match this suppression map.
7. **Native parameter:** Given an active naming rule with a project-specific regular expression, detection uses that expression rather than the shipped default and anchors issues on nonconforming identifiers in scope.
8. **Metrics and CPD:** Given a valid nonempty file in SonarQube mode, all listed file measures, line data, highlighting, and CPD tokens are emitted; package and import tokens precede the CPD start and string contents are normalized only for CPD.
9. **Scoverage aggregation:** Given a valid report with multiple in-range statements for one absolute indexed path and line, invocation counts are added with signed 32-bit arithmetic and one line-hit value is saved when the sum remains valid.
10. **Scoverage overflow:** Given individually valid invocation counts whose sum wraps to a negative signed 32-bit value, coverage saving may reject the result and abort the sensor because that save failure is not caught by the importer.
11. **Scoverage malformed report:** Given a nonnumeric or out-of-range line attribute, that report logs an error and contributes no coverage; native analysis remains independent.
12. **Scalastyle import:** Given a valid checkstyle report, resolvable absolute file, nonempty source/message, and valid line, one `external_scalastyle` issue is created on that line with catalog metadata.
13. **Scapegoat import:** Given the equivalent report through `sonar.scala.scapegoat.reportPaths`, the engine and repository are `scapegoat` and `external_scapegoat`, even though both adapters use the same XML shape.
14. **Unknown external id:** Given a valid external issue whose source is absent from the selected catalog, it is still imported as Code Smell/Major with five-minute remediation.
15. **External entity input:** Given XML containing a DTD or external entity, the report parser does not resolve it; report import fails or ignores unsupported entity material without external fetch.
16. **Unchanged-file cache failure:** Given an unchanged file and an unreadable CPD cache entry, the analyzer performs full parsing and regenerates results rather than silently skipping the file.
17. **SonarLint:** Given the SonarLint product, native checks and suppression run, but the built-in profile extension, Scoverage, Scalastyle, Scapegoat, source measures, highlighting, and CPD are not emitted by this plugin.

## 14. Provenance index

- Release pin, dependencies, plugin manifest, and Scalameta version: `settings.gradle`, `gradle.properties`, and `sonar-scala-plugin/build.gradle` at commit `f8e0a83baf34dbe3fb8313eca792f0abd6e47ff5`.
- Language key, suffix, report settings, and product gating: `sonar-scala-plugin/src/main/java/org/sonarsource/scala/plugin/ScalaPlugin.java` and `ScalaLanguage.java`.
- Sensor wiring, test patterns, profile, and rule registration: `ScalaSensor.java`, `ScalaCheckList.java`, `ScalaProfileDefinition.java`, `ScalaRulesDefinition.java`, and `sonar-scala-plugin/src/main/resources/org/sonar/l10n/scala/rules/scala/Sonar_way_profile.json`.
- Dialect selection and conversion: `sonar-scala-plugin/src/main/scala/org/sonarsource/scala/converter/ScalaConverter.scala`, `ScalaCodeVerifier.scala`, and converter tests.
- Scala-specific checks: `sonar-scala-plugin/src/main/java/org/sonarsource/scala/checks/`, including pattern-match exclusions and companion-object handling, plus corresponding tests.
- Native metadata: `sonar-scala-plugin/src/main/resources/org/sonar/l10n/scala/rules/scala/*.json` and corresponding HTML descriptions.
- Scoverage: `sonar-scala-plugin/src/main/java/org/sonarsource/scala/plugin/ScoverageSensor.java`, `ScoverageSensorTest.java`, and `src/test/resources/coverage/`.
- Scalastyle and Scapegoat: `sonar-scala-plugin/src/main/java/org/sonarsource/scala/externalreport/`, importer tests, `src/main/resources/org/sonar/l10n/scala/rules/scalastyle/rules.json`, and `scapegoat/rules.json`.
- Shared pipeline, metrics, suppression, cache, CPD, highlighting, and checks: exact Maven sources at [slang-plugin 1.21.0.8303](https://repo1.maven.org/maven2/org/sonarsource/slang/slang-plugin/1.21.0.8303/slang-plugin-1.21.0.8303-sources.jar), [slang-checks 1.21.0.8303](https://repo1.maven.org/maven2/org/sonarsource/slang/slang-checks/1.21.0.8303/slang-checks-1.21.0.8303-sources.jar), and [slang-api 1.21.0.8303](https://repo1.maven.org/maven2/org/sonarsource/slang/slang-api/1.21.0.8303/slang-api-1.21.0.8303-sources.jar).
- Report-path and external-rule defaults: exact Maven source `org.sonarsource.analyzer-commons:sonar-analyzer-commons:2.27.0.5007`, SHA-256 `9f815a83b4eab83d202e8043317608e1f5071f573ecd09928633b4b2387f4271`.
- Safe XML behavior: exact Maven source `org.sonarsource.analyzer-commons:sonar-xml-parsing:2.27.0.5007`, SHA-256 `54f5cc63fb7c58465bb3caa94c15fbd3a9ffb4b868c4e32b48d773934521f663`.
- Bundle evidence: SonarQube `build.gradle` dependency `org.sonarsource.slang:sonar-scala-plugin:1.24.0.2554` and `sonar-application/bundled_plugins.gradle` at commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`.
- Public release source: [tag `1.24.0.2554`](https://github.com/SonarSource/sonar-scala/tree/1.24.0.2554) and [commit `f8e0a83baf34dbe3fb8313eca792f0abd6e47ff5`](https://github.com/SonarSource/sonar-scala/commit/f8e0a83baf34dbe3fb8313eca792f0abd6e47ff5).
