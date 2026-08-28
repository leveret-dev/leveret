# Flex analyzer specification

## 1. Identity and conformance baseline

This specification defines the Flex analyzer bundled with SonarQube Community Build `26.8.0.126808`. The bundled artifact is `org.sonarsource.flex:sonar-flex-plugin:2.18.0.6281`. Its authoritative source is `SonarSource/sonar-flex`, tag `2.18.0.6281`, commit `84cf021e37206d01e7f04ffe7172c40d0ee8ad85`. Analyzer-owned source is licensed under Sonar Source-Available License v1.0, recorded here as `LicenseRef-SSAL-1.0`; this is a full clean-room behavioral specification, not a copy instruction. [F1][F2][F3]

The plugin key and language/rule-repository key are `flex`; the displayed language name is `Flex`. The packaged plugin requires the `flex` language, declares minimum plugin API compatibility `9.9`, and is implemented for Java 17-era Community Build packaging. [F4][F5]

## 2. Purpose, scope, and exclusions

The analyzer recognizes ActionScript source, parses ActionScript 2 and ActionScript 3 syntax, applies the active `flex` rules, emits source measures, highlighting and duplication tokens, and optionally imports Cobertura coverage. [F6][F7]

Only main source files are analyzed. Test files are outside the sensor predicate. MXML is deliberately unsupported: after language classification, any input URI whose path ends case-sensitively with `mxml` is removed from source analysis. Cobertura records ending in lowercase `.mxml` are likewise ignored without a missing-resource warning. No MXML parser, rule execution, measures, highlighting, duplication, or coverage mapping is required. [F7][F8]

The analyzer does not own project indexing, profile activation, issue persistence or lifecycle, aggregate duplication calculation, aggregate coverage metrics, quality gates, or scanner-report transport. Those belong to platform and scanner contracts. It has no test-execution importer, symbol index, dependency graph, external-issue importer, or language-server protocol. [F4][F7][F8]

## 3. Dependencies and owned contracts

The analyzer consumes Sonar plugin API `13.8.0.4399`, SSLR `1.26.0.4194`, analyzer commons `2.28.0.5085`, and the scanner services for active rules, input files, measures, issues, highlighting, CPD tokens and coverage. The plugin packages its analyzer code and selected XML-streaming dependencies while treating the plugin API as provided. [F4][F5]

This component owns:

- language recognition and `sonar.flex.file.suffixes` behavior;
- ActionScript lexical and grammar behavior;
- rule repository `flex`, built-in profile `Sonar way`, and every rule in section 8;
- per-file measures and line data;
- ActionScript highlighting and normalized CPD token production;
- Flex Cobertura path discovery and source-line/condition mapping.

It consumes active-rule selection, issue/measure storage, generic exclusions, report serialization and downstream aggregation without redefining them.

## 4. Inputs, recognition, and configuration

### 4.1 Source recognition

`sonar.flex.file.suffixes` is a project- or module-scoped multi-value property. Its declared default is `as`. Values are trimmed and empty values are removed. If no non-empty value remains, the analyzer restores the single suffix `as`; an empty list therefore does not disable recognition. Suffix spelling is passed to the scanner language registry without adding a leading dot. [F5][F9]

Only scanner-indexed `MAIN` files classified as `flex` are candidates. The later MXML path exclusion still applies even if custom suffixes cause an MXML file to be classified as Flex. [F7]

### 4.2 Coverage configuration

`sonar.flex.cobertura.reportPaths` is a project- or module-scoped multi-value property containing absolute paths or paths relative to the scanner module base directory. `sonar.flex.cobertura.reportPath` is its deprecated singular key. The current key takes the platform-defined precedence over its deprecated alias. With no configured paths, the sensor logs that no report was provided. Each configured missing path is logged and skipped; other configured reports continue. [F5][F8]

### 4.3 Rule configuration

Only active rules run. Rule parameters use their rule metadata values. Invalid regular expressions or otherwise invalid parameters fail that rule or file according to the check implementation; the analyzer does not silently substitute another configured value. Built-in `Sonar way` activates these keys by default: `ActionScript2`, `CommentedCode`, `NonEmptyCaseWithoutBreak`, `S100`, `S101`, `S107`, `S108`, `S115`, `S116`, `S117`, `S120`, `S127`, `S1066`, `S1068`, `S1116`, `S1117`, `S1125`, `S1144`, `S1170`, `S1172`, `S1185`, `S1186`, `S1301`, `S1434`, `S1435`, `S1439`, `S1444`, `S1445`, `S1446`, `S1447`, `S1455`, `S1462`, `S1463`, `S1464`, `S1465`, `S1466`, `S1467`, `S1468`, `S1470`, `S1481`, `S1871`, `S1952`, `S3923`, `S4507`, `S4524`, `SwitchWithoutDefault`, and `WithStatement`. All other cataloged rules remain available for custom profiles. [F10]

## 5. Processing model and lifecycle

For each eligible file, the sensor reads the complete content using the input file's declared charset, creates a fresh parser, and attempts a full parse. Successful parsing is followed by measure calculation. Every active check then receives a fresh per-file visitor context. Finally, a separate lexical pass produces highlighting and CPD tokens. Files are visited in scanner order. [F7]

A parser recognition failure does not abort later files. It creates a visitor context containing the failure instead of a syntax tree, logs the file and parser message, skips all AST-derived measures, runs the active checks so `ParsingError` can report the failure, and still attempts the lexical highlighting/CPD pass. Checks that require an AST naturally see no nodes. An unreadable source file is fatal to the sensor through an `IllegalStateException`. [F7][F11]

The descriptor advertises independent-file processing outside SonarLint when runtime API is at least 9.3. Reflection failure while advertising that capability is logged and analysis continues. The implementation owns no durable state. Check result lists and metric visitors are reset for each file. [F7]

## 6. Parser and semantic model

The SSLR lexer recognizes ActionScript identifiers, keywords, punctuators, numeric and string/character literals, comments, regular-expression literals and XML-related syntax used by the grammar. The grammar builds a concrete AST for packages, imports, classes, interfaces, functions, metadata, declarations, statements and expressions. Rules use syntax and local structural relationships; this release does not build a cross-file type-resolution, symbol, inheritance or bytecode semantic model. [F12][F13]

ActionScript 2 and 3 are accepted as documented. Rule `ActionScript2` separately detects legacy textual operators that are unavailable in ActionScript 3; accepting a construct is therefore distinct from recommending it. [F6][F14]

## 7. Outputs

### 7.1 Measures

On a successful parse the analyzer emits `ncloc`, `comment_lines`, `classes`, `functions`, `statements`, `complexity`, `executable_lines_data`, and line-level `ncloc_data`. Classes include class and interface definitions. Functions include declarations and function expressions. Statements cover declarations, expressions, control-flow, transfer, exception and empty statements. Executable-line data contains each statement-start line once. Complexity is cyclomatic complexity derived from the AST. A parse-failed file receives none of these measures. [F7][F15][F16]

A line containing `NOSONAR` inside a comment is omitted from `comment_lines`; this visitor-level behavior does not itself define platform issue suppression. [F15]

### 7.2 Highlighting

Numeric literals are highlighted as constants, other literals as strings, language keywords as keywords, and trivia comments as comments. Highlighting uses exact lexer token ranges and is saved once per file. EOF is not highlighted. [F17]

### 7.3 Duplication tokens

Every non-EOF token except tokens in an `import` directive is emitted to CPD. Import suppression begins at the `import` keyword and ends at its semicolon. String/character literals normalize to one common token image; numeric literals normalize to another; all other token images retain their lexical value. This component emits tokens only; duplicate-block thresholds and aggregation are platform-owned. [F17]

### 7.4 Issues

A rule issue uses repository `flex` and the cataloged key. Issues are either file-level or anchored to the full source line containing the reported node/token. Rules may attach remediation gap cost. No secondary locations or quick fixes are emitted by this analyzer. [F7][F18]

### 7.5 Cobertura coverage

For each existing report, the importer traverses package/class records, maps each class `filename` to a `MAIN` Flex input file by normalized path suffix, and records line hits. A branch line with parseable `condition-coverage` contributes total and covered conditions. Multiple class records for the same source file reuse the file lookup. Unmapped non-MXML files produce warnings; unmapped lowercase `.mxml` files do not. [F8]

The XML reader disables validation, DTD support and external entities, and is not namespace-aware. Malformed XML, non-numeric hit data, malformed condition totals or report I/O errors fail that report through an unchecked analysis exception; the importer does not invent partial values. [F8]

## 8. Complete rule catalog

Catalog membership, keys, metadata, parameters and check behavior are pinned by the registered check list, annotated classes and rule metadata at the cited revision. Unless a row says otherwise, a rule has no parameters, analyzes a successfully parsed main ActionScript file, and reports the starting line of the offending construct. “File” means a file-level issue. [F10][F11][F19]

| Rule key | Detection semantics, exclusions, and location | Parameters and defaults | Type; default severity |
|---|---|---|---|
| `CommentRegularExpression` | Reports each comment matching the configured expression; no matches occur with an empty expression. Location is the matching comment line. | `regularExpression` = empty; `message` = `The regular expression matches this comment.` | Code smell; Major |
| `LineLength` | Reports each physical line longer than the limit. Location is that line. | `maximumLineLength` = `80` | Code smell; Major |
| `S134` | Reports control-flow nesting beyond the configured depth for `if`, loops and `switch`. | `max` = `3` | Code smell; Critical |
| `XPath` | Reports AST nodes selected by the configured XPath and uses the configured message; an empty query selects nothing. | `xpathQuery` = empty; `message` = `The XPath expression matches this piece of code` | Code smell; Major |
| `FunctionComplexity` | Reports functions whose cyclomatic complexity exceeds the limit; the issue gap is the excess. | `maximumFunctionComplexityThreshold` = `10` | Code smell; Critical |
| `ClassComplexity` | Reports classes whose accumulated cyclomatic complexity exceeds the limit; the issue gap is the excess. | `maximumClassComplexityThreshold` = `80` | Code smell; Critical |
| `OneStatementPerLine` | Reports a line containing more than one statement. | None | Code smell; Major |
| `CommentedCode` | Reports comments recognized as disabled ActionScript rather than prose. Ordinary comments are excluded. | None | Code smell; Major |
| `SwitchWithoutDefault` | Reports a `switch` with no `default` clause. | None | Code smell; Critical |
| `WithStatement` | Reports every `with` statement. | None | Bug; Major |
| `NonEmptyCaseWithoutBreak` | Uses a syntax heuristic on every case except the final case element. It accepts a final `break`, `return`, `throw`, or `continue`, recursively unwraps a final statement that consists solely of a block, and skips the case entirely when it contains at least two descendant jump statements of those kinds. Otherwise, when the final directive is a statement ending in another construct, it reports the last case label; empty/non-statement endings are not reported. | None | Code smell; Blocker |
| `FunctionSinglePointOfExit` | Reports functions with return points other than one final exit. | None | Code smell; Minor |
| `ActionScript2` | Reports legacy ActionScript 2 textual logical, equality, relational, addition and negation operators that ActionScript 3 does not support. | None | Code smell; Major |
| `S107` | Reports functions with more than the configured number of parameters. | `max` = `7` | Code smell; Major |
| `S115` | Reports constant names not matching the configured expression. | `format` = `^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$` | Code smell; Critical |
| `S116` | Reports field names not matching the configured expression. | `format` = `^[_a-z][a-zA-Z0-9]*$` | Code smell; Minor |
| `S1435` | Reports declarations that use the unrestricted `*` type. | None | Code smell; Critical |
| `S1301` | Reports a `switch` having fewer than three `case` clauses, because a simpler conditional form is expected. | None | Code smell; Minor |
| `S1116` | Reports empty statements. | None | Code smell; Minor |
| `S1142` | Reports functions containing more than the configured number of `return` statements. | `max` = `3` | Code smell; Major |
| `S1066` | Reports nested `if` statements that can be combined into one condition. | None | Code smell; Major |
| `S1440` | Reports non-strict equality or inequality operators. | None | Code smell; Major |
| `S101` | Reports class names not matching the configured expression. | `format` = `^[A-Z][a-zA-Z0-9]*$` | Code smell; Minor |
| `S120` | Reports package names not matching the configured dotted-lowercase expression. | `format` = `^[a-z]+(\.[a-z][a-z0-9]*)*$` | Code smell; Minor |
| `S1151` | Reports a switch case whose non-comment code spans more than the configured number of lines. | `max` = `5` | Code smell; Major |
| `S1455` | Reports a class declared with a package-qualified multi-part class name instead of nesting the class declaration inside a package definition. | None | Code smell; Minor |
| `S1314` | Reports octal numeric values. | None | Code smell; Blocker |
| `S1448` | Reports a class with too many methods. The boolean determines whether non-public methods count. | `maximumFunctionThreshold` = `20`; `countNonpublicMethods` = `true` | Code smell; Major |
| `S1145` | Reports `if` conditions that are literal `true` or `false`. | None | Bug; Major |
| `S117` | Reports local variable or parameter names not matching the configured expression. | `format` = `^[_a-z][a-zA-Z0-9]*$` | Code smell; Minor |
| `S1125` | Reports redundant comparisons to Boolean literals. | None | Code smell; Minor |
| `S1444` | Reports mutable public static fields; constants are excluded. | None | Code smell; Minor |
| `S1446` | Reports dynamic class declarations. | None | Code smell; Blocker |
| `S1439` | Reports labels attached to constructs other than `while`, `do` or `for`. | None | Code smell; Major |
| `S1445` | Reports a constructor explicitly declared with a `void` return type. | None | Code smell; Minor |
| `S1447` | Reports a constructor at its declaration when any direct constructor-body directive has a first statement of kind `if`, `switch`, `do`, `while`, or `for`. Nested control flow and allocation or other work without one of those direct statements are excluded. | None | Code smell; Major |
| `S108` | Reports empty nested blocks. | None | Code smell; Major |
| `S1442` | Reports calls to `Alert.show`. | None | Vulnerability; Minor |
| `S4507` | Reports enabled debug-oriented compilation features. | None | Vulnerability; Minor |
| `S1185` | Reports an override whose body only delegates to the same superclass method. | None | Code smell; Minor |
| `S1462` | Reports literal event names supplied to event-listener APIs rather than shared constants. | None | Code smell; Critical |
| `S1170` | Reports public constants, and public fields initialized at declaration, that are not both `static` and `const`. | None | Code smell; Minor |
| `S1463` | Reports event metadata that does not declare an event type. | None | Code smell; Critical |
| `S1469` | Reports array fields whose element type is not specified by the supported metadata. | None | Code smell; Blocker |
| `S1468` | Reports wildcard domain authorization passed to `Security.allowDomain`. Narrowly named domains are excluded. | None | Vulnerability; Blocker |
| `S1470` | Reports a class extending `Event` that does not override `clone`. | None | Bug; Major |
| `S1465` | Reports a `LocalConnection` configuration that permits wildcard or insufficiently narrow domains. | None | Vulnerability; Critical |
| `S1466` | Reports assignments that set `flash.system.Security.exactSettings` to `false`. | None | Vulnerability; Blocker |
| `S1312` | Reports logger fields that are not private static constants or whose names fail the configured expression. | `format` = `LOG(?:GER)?` | Code smell; Minor |
| `S100` | Reports function names not matching the configured expression. | `format` = `^[a-z][a-zA-Z0-9]*$` | Code smell; Minor |
| `S1438` | Reports statements missing a terminating semicolon where the grammar permits detection. | None | Code smell; Minor |
| `S1434` | Reports declarations using the generic `Object` type. | None | Code smell; Critical |
| `S1464` | Reports `ManagedEvents` metadata entries without companion `Event` metadata. | None | Bug; Major |
| `S1467` | Reports event dispatch from a constructor. | None | Bug; Major |
| `S1144` | Reports private functions with no usage in the analyzed file/class structure. | None | Code smell; Major |
| `S1117` | Reports a local variable that shadows a field. | None | Code smell; Major |
| `S1068` | Reports private fields with no usage in the analyzed file/class structure. | None | Code smell; Major |
| `S1481` | Reports local variables that are declared but never used. | None | Code smell; Minor |
| `S1454` | Reports an arithmetic expression containing multiple increment or decrement operators. | None | Bug; Major |
| `S138` | Reports functions exceeding the configured number of non-comment lines. | `max` = `100` | Code smell; Major |
| `S1951` | Reports use of the `trace` function. | None | Vulnerability; Minor |
| `S1784` | Reports methods without an explicit visibility modifier. | None | Bug; Minor |
| `S1821` | Reports a `switch` nested inside another `switch`. | None | Code smell; Critical |
| `S1186` | Reports empty methods, subject to the check's recognized intentional-empty forms. | None | Code smell; Critical |
| `S1820` | Reports a class with too many fields. The boolean determines whether non-public fields count. | `maximumFieldThreshold` = `20`; `countNonpublicFields` = `true` | Code smell; Major |
| `S1172` | Reports function parameters with no use in the function body. | None | Code smell; Major |
| `S1451` | Reports a file whose initial content lacks the configured literal or regular-expression header. Location is file-level. An empty default means activation requires profile configuration to be useful. | `headerFormat` = empty; `isRegularExpression` = `false` | Code smell; Blocker |
| `S1950` | Reports duplicate switch-case conditions; location is the later duplicate. | None | Bug; Minor |
| `S1952` | Reports object instantiation inside a loop. | None | Code smell; Major |
| `S1176` | Reports missing ASDoc on enabled categories of public classes, properties, methods, method parameters and method returns. Each Boolean independently disables its category. | `asdoc_classes`, `asdoc_properties`, `asdoc_methods`, `asdoc_method_param`, `asdoc_method_return` = `true` | Code smell; Major |
| `S1982` | Reports assignment or use of the `MovieClip.onEnterFrame` handler. | None | Code smell; Minor |
| `S127` | Reports a `for` loop whose stop condition depends on a value modified by the loop. | None | Code smell; Major |
| `S1871` | Reports a conditional branch whose implementation duplicates another branch; location is the duplicate branch. | None | Code smell; Major |
| `S4524` | Reports a `default` switch clause positioned anywhere except first or last. | None | Code smell; Critical |
| `S3923` | Reports a conditional structure when every branch has the same implementation. | None | Bug; Major |
| `ParsingError` | Reports the parser recognition failure at the parser-provided line and uses the parser message. It is the only rule designed to operate on a failed parse. | None | Code smell; Major |

## 9. Failure, partial results, and recovery

A source parse recognition failure is isolated to that file as described in section 5. A runtime exception outside that recognized parser path, including a read failure or lexer failure, propagates and can fail the sensor. Rule configuration errors are not converted into fabricated findings. Later scanner runs retry from source; no analyzer-owned recovery state exists. [F7][F11]

A missing Cobertura report is a non-fatal skip. A malformed existing report is fatal to that import. Coverage already saved from earlier configured reports may remain in the scanner context if a later report fails; the analyzer has no rollback transaction across reports. [F8]

Cancellation is not explicitly polled by the Flex sensor. Cancellation behavior therefore follows scanner/runtime interruption rather than a Flex-owned state transition. [F7]

## 10. Security and trust boundaries

Source files, active-rule parameters and Cobertura reports are untrusted project inputs. The analyzer parses but never executes ActionScript. XPath rules operate on the analyzer AST, not on external resources. Cobertura parsing disables DTDs, validation and external entities. Report paths are operator-supplied and may be absolute; access control is inherited from the scanner process. Issues and measures are proposals to scanner APIs and acquire persistence and visibility only through platform contracts. [F7][F8][F19]

## 11. Compatibility and limits

Compatibility requires public language key `flex`, rule repository/key pairs, setting keys, default suffix behavior, metric keys, issue locations and coverage mapping described here. The analyzer has no cross-file semantic resolution. MXML remains excluded. ActionScript source must fit scanner memory because complete file contents and ASTs are held per file. No fixed analyzer-owned file-size, token-count or timeout limit is declared. [F7][F9][F12]

## 12. Acceptance scenarios

1. **Default recognition.** Given an indexed main file ending in `.as` and no suffix override, analysis parses it and produces enabled issues, measures, highlighting and CPD tokens. A test file with the same suffix is ignored.
2. **Empty suffix override.** Given only blank values for `sonar.flex.file.suffixes`, the analyzer restores `as`; it does not disable Flex.
3. **MXML exclusion.** Given a file classified as `flex` whose URI path ends in lowercase `mxml`, no source analysis output is produced for that file.
4. **Parse failure.** Given malformed ActionScript and active `flex:ParsingError`, the analyzer reports the parser message on its line, emits no AST-derived measures, attempts lexical highlighting/CPD, and continues to later files.
5. **CPD normalization.** Given two otherwise identical files whose string and numeric literal values differ, their corresponding CPD token images remain equal; import directives contribute no CPD tokens.
6. **Coverage mapping.** Given a valid configured Cobertura report whose class filename resolves by path suffix to a main Flex file, line hits and branch totals are recorded. An unknown non-MXML path logs a warning; an unknown `.mxml` path does not.
7. **Coverage hardening.** Given a report containing an external entity, the importer does not resolve it because external entities and DTD support are disabled.
8. **Independent files.** Given one recognition failure and one valid file, the valid file is still analyzed; given an unreadable source file, the sensor fails rather than silently omitting it.

## 13. Provenance index

- **[F1]** `manifest/component-inventory.md`, Flex row; `manifest/release-baseline.md`.
- **[F2]** `manifest/license-map.md`, `SonarSource/sonar-flex` row.
- **[F3]** `sonar-flex` tag `2.18.0.6281`, commit `84cf021e37206d01e7f04ffe7172c40d0ee8ad85`: `LICENSE.txt`, root `pom.xml`.
- **[F4]** Same revision: root `pom.xml`; `sonar-flex-plugin/pom.xml`.
- **[F5]** Same revision: `sonar-flex-plugin/src/main/java/org/sonar/plugins/flex/FlexPlugin.java`.
- **[F6]** Same revision: `sonar-flex-plugin/src/main/resources/static/documentation.md`.
- **[F7]** Same revision: `sonar-flex-plugin/src/main/java/org/sonar/plugins/flex/FlexSquidSensor.java`.
- **[F8]** Same revision: `sonar-flex-plugin/src/main/java/org/sonar/plugins/flex/cobertura/CoberturaSensor.java`; `sonar-flex-plugin/src/main/java/org/sonar/plugins/flex/cobertura/CoberturaReportParser.java`.
- **[F9]** Same revision: `sonar-flex-plugin/src/main/java/org/sonar/plugins/flex/core/Flex.java`.
- **[F10]** Same revision: `flex-checks/src/main/java/org/sonar/flex/checks/CheckList.java`; `flex-checks/src/main/resources/org/sonar/l10n/flex/rules/flex/Sonar_way_profile.json`.
- **[F11]** Same revision: `flex-checks/src/main/java/org/sonar/flex/checks/ParsingErrorCheck.java`; `flex-squid/src/main/java/org/sonar/flex/FlexVisitor.java`; `flex-squid/src/main/java/org/sonar/flex/FlexVisitorContext.java`.
- **[F12]** Same revision: `flex-squid/src/main/java/org/sonar/flex/parser/FlexParser.java`; `flex-squid/src/main/java/org/sonar/flex/FlexGrammar.java`.
- **[F13]** Same revision: `flex-squid/src/main/java/org/sonar/flex/lexer/FlexLexer.java`; `flex-squid/src/main/java/org/sonar/flex/api/FlexTokenType.java`.
- **[F14]** Same revision: `flex-checks/src/main/java/org/sonar/flex/checks/ActionScript2Check.java`.
- **[F15]** Same revision: `flex-squid/src/main/java/org/sonar/flex/metrics/FileMetrics.java`; `flex-squid/src/main/java/org/sonar/flex/metrics/FileLinesVisitor.java`.
- **[F16]** Same revision: `flex-squid/src/main/java/org/sonar/flex/metrics/ComplexityVisitor.java`.
- **[F17]** Same revision: `sonar-flex-plugin/src/main/java/org/sonar/plugins/flex/FlexTokensVisitor.java`.
- **[F18]** Same revision: `flex-squid/src/main/java/org/sonar/flex/Issue.java`; `flex-squid/src/main/java/org/sonar/flex/FlexCheck.java`.
- **[F19]** Same revision: all registered classes under `flex-checks/src/main/java/org/sonar/flex/checks/` and matching metadata under `flex-checks/src/main/resources/org/sonar/l10n/flex/rules/flex/`.
