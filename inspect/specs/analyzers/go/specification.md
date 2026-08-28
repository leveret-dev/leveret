# Go Analyzer Specification

## 1. Identity, authority, and license

This specification covers Go analyzer bundled with SonarQube Community Build `26.8.0.126808`:

- Maven component: `org.sonarsource.go:sonar-go-plugin:1.40.0.6765`.
- Plugin key and native rule repository key: `go`.
- Language key and display name: `go`, `Go`.
- Authoritative source artifact: `sonar-go-plugin-1.40.0.6765-sources.jar`, SHA-256 `b23c92da0d081b9138809607fb9a1209c8256a50abfbc3715c6773b1ac0ce555`.
- Corroborating packaged plugin: `sonar-go-plugin-1.40.0.6765.jar`, SHA-256 `d66cc8a445ac3c961ac89697e65c2db497a0246b8bd939206bebedabc27b4662`.
- Publication POM: `org.sonarsource.go:sonar-go-plugin:1.40.0.6765`, published 2026-06-29.
- Analyzer-owned source and native-converter payloads: Sonar Source-Available License v1.0, recorded as `LicenseRef-SSAL-1.0`. Bundled `golang.org/x/tools` material carries its three-clause BSD notice. This is a provenance statement, not legal advice.

POM and source archive both identify SSALv1. Packaged plugin manifest separately says `Plugin-License: GNU LGPL 3`; that manifest field conflicts with source archive license and repository license map. This specification follows license text shipped in exact source artifact for analyzer-owned source and preserves third-party notices.

### 1.1 Provenance limitation

No public Git tag matches `1.40.0.6765`. Published POM names repository but no immutable SCM revision. Packaged manifest records `Implementation-Build: edac69edd12daf71eca056933ebdcd345aac8ed8`, but that value does not resolve to evidenced public source revision. Candidate public commit `ba90d496cc57d793b867a82ff656a51fc7993735` is corroborating evidence only. Its plugin-module Java source and rule resources were byte-for-byte equal to exact source archive during audit, but its check, common-model, and native-parser source modules are not asserted as artifact provenance. No behavior below rests solely on candidate branch.

Exact source archive omits source for shaded check, semantic-model, and converter modules. For those surfaces this specification uses only exact archive resources, packaged class metadata, packaged native-member inventory, and direct behavior observed from exact native member. Candidate source may explain an observation, but does not establish it.

## 2. Purpose, scope, and exclusions

Analyzer recognizes indexed Go files, converts each directory-sized package batch into a typed syntax model, emits native-rule issues, source symbols, metrics, syntax highlighting, and CPD tokens, and imports Go test, coverage, and external-linter reports. It also reads indexed `go.mod` files for module, version, and replacement context.

Analyzer owns:

- Go language recognition and Go-specific exclusions;
- Go parser process selection and invocation;
- Go AST, semantic, module-context, issue, metric, symbol, highlighting, and CPD production;
- native `go` repository rule catalog and default `Sonar way` profile;
- Go coverage and test-report adaptation;
- `govet`, `golint`, `gometalinter`, and `golangci-lint` report adaptation and external repositories.

Analyzer does not own scanner indexing, generic source/test classification, active-rule selection, issue lifecycle, metric persistence, quality profiles after creation, report upload, quality gates, or server telemetry transport. Those belong to scanner engine and platform contract owners. Analyzer does not run user linters or tests. It only imports their reports. Commercial Go extensions and any private rule catalog are excluded.

## 3. Dependencies and owned contracts

Analyzer requires Sonar plugin/extension runtime, scanner file system, active-rule API, sensor result APIs, cache APIs, Analyzer Commons rule/profile/report helpers, and XML safe-parser support. Packaged manifest declares minimum Java runtime 11, minimum Sonar API line `6.7`, `SonarLint-Supported: true`, and required language `go`. SonarQube Community Build baseline supplies actual compatible runtime.

Five native parser executables are packaged. Exact members, byte sizes, and SHA-256 values are:

| Member | Host | Bytes | SHA-256 |
|---|---|---:|---|
| `sonar-go-to-slang-darwin-amd64` | macOS x86-64 | 7,465,104 | `c465748fb7def40812758dd066628b52879e43fffd0191cb873c287efb4435dc` |
| `sonar-go-to-slang-darwin-arm64` | macOS ARM64 | 7,283,074 | `37298b8e7abf051fe13e414181752f452f09989252a41fc00cde8dfa38bd7bf1` |
| `sonar-go-to-slang-linux-amd64` | Linux x86-64 | 7,516,322 | `11e6ebcdaa3c7dccd66b7cb94110b2a753474381b70c77e64d9e3baed54f5357` |
| `sonar-go-to-slang-linux-arm64` | Linux ARM64 | 7,274,658 | `1c9d27feda3ffc665fbd733fa17e51ff627b5869244616dfa6c0d5aa0f67a4bd` |
| `sonar-go-to-slang-windows-amd64.exe` | Windows x86-64 | 7,618,048 | `ba483b035f99cdfa06e7142b061a8e7bfce92906fdaa0a31da5755d491a180c7` |

Exact binary metadata contains Go toolchain `go1.26.4` and `golang.org/x/tools v0.41.0`. Build toolchain is not a formal minimum or maximum supported Go source version.

## 4. Recognition, configuration, and precedence

### 4.1 Files and project state

Language suffix property is `sonar.go.file.suffixes`. Default is `.go`. Multiple suffixes are accepted at project scope; an empty configured array falls back to `.go`.

`sonar.go.exclusions` accepts project-scoped wildcard patterns. Default is `**/vendor/**,**/*.pb.go,**/*.pb.gorm.go`. Filter applies only to files already classified as language `go`; non-Go files always pass this filter. Paths are matched against input-file URI text.

`sonar.go.activate` is project-scoped boolean, default `true`. `false` skips native Go source analysis. It does not redefine scanner indexing and does not disable separately configured report sensors.

If both `sonar.tests` and `sonar.test.inclusions` are absent, filename ending `_test.go` is treated as test for rule-scope purposes. If either property is present, scanner-assigned `MAIN` or `TEST` type is authoritative and suffix heuristic is not applied.

Indexed paths matching `**/go.mod` are inspected outside SonarLint. Analyzer recognizes first valid `module` directive, first valid `go` directive, and single-line or parenthesized `replace` directives. It does not claim interpretation of `require`, `exclude`, `retract`, or `toolchain` directives. Recognized Go version has positive decimal major and minor, optional patch, and optional beta or release-candidate suffix; prerelease suffix is discarded. Missing or unrecognized version becomes `unknown`. Closest ancestor module data is selected for each source directory. Nested modules therefore override outer module data.

Internal `sonar.go.internal.source.version`, when valid, overrides versions found in all `go.mod` files and logs precedence warning when both exist. Invalid value is ignored. Internal `sonar.go.internal.moduleName` overrides closest detected module name passed to parser. These are internal deployment controls, not stable end-user configuration promises.

### 4.2 Public report settings

| Property | Accepted values and default |
|---|---|
| `sonar.go.tests.reportPaths` | Multiple absolute or project-relative Go `test -json` report files. No default and no wildcard expansion. |
| `sonar.go.coverage.reportPaths` | Multiple absolute or project-relative Go cover-profile files. `*` and `?` patterns are expanded relative to project base. No default. |
| `sonar.go.govet.reportPaths` | Multiple absolute or relative line-report files. Default empty. |
| `sonar.go.golint.reportPaths` | Multiple absolute or relative line-report files. Default empty. |
| `sonar.go.gometalinter.reportPaths` | Multiple absolute or relative line-report files. Default empty. |
| `sonar.go.golangci-lint.reportPaths` | Multiple absolute or relative Checkstyle XML files. Default empty. |

Report extensions are not registered in SonarLint. Source rules, symbols, and issue suppression remain available there; metrics, CPD, highlighting, coverage, tests, and external-report imports do not.

### 4.3 Internal diagnostics

`sonar.internal.analysis.failFast`, default `false`, changes parse or outer sensor failures from logged partial analysis to thrown analysis failure. `sonar.go.internal.debugTypeCheck`, default `false`, enables native type-check diagnostics. `sonar.go.converter.validation` accepts `throw` or `log`; any other value logs warning and disables validation. `sonar.go.duration.statistics`, default `false`, logs visitor durations and memory observations. These keys are diagnostic/internal and not portable public API.

## 5. Parsing, AST, semantics, imports, and lifecycle

1. Sensor exits if deactivated. In SonarLint it also exits when native converter could not initialize.
2. Analyzer discovers all indexed Go files and classifies source/test context.
3. Files are grouped by containing URI directory. Cancellation is checked between groups.
4. Analyzer discovers `go.mod` files and builds nearest-module context.
5. Unchanged-file cache is consulted. Fully reusable files skip parsing; partially reusable files run only visitors whose cached result could not be restored.
6. Empty or whitespace-only files are omitted from parser batch.
7. Each remaining directory batch is sent to selected embedded native executable with module name. Files in same directory are parsed and type-checked together.
8. Parser returns either tree or error for each file. Valid files in same batch remain usable when sibling file has syntax error.
9. Visitors run in order: suppression discovery; main-file metrics outside SonarLint; line suppression; symbols; main-only rules; main-and-test rules; then CPD and highlighting outside SonarLint.
10. Per-file content hash is stored after visitor processing. Converter is terminated in finalization path, then timing and memory diagnostics are emitted.

Exact native execution observations establish these semantic contracts:

- Same-package declarations and references in sibling files share stable symbol identity within batch.
- Standard-library import member can carry resolved function type and package identity.
- Unavailable third-party import does not by itself become parse error: import alias retains package path while unresolved member has unknown type and no resolved symbol identity.
- Output carries per-file token/comment metadata, physical text ranges, typed identifiers, package identity, symbol identity where resolved, and control-flow metadata.
- Syntax error in one file produces file-specific error while valid sibling produces tree in same process result.

Analyzer emits symbols through scanner symbol API. Exact source artifact shows symbol visitor registration but does not expose shaded visitor source; this specification therefore does not assert candidate-only declaration/reference edge cases.

Parser executable is extracted to analyzer instance temporary directory and made executable. A fresh native process handles each directory batch. Packaged class metadata exposes five-second process-exit timeout, forced termination on timeout or cleanup, nonzero-exit failure, interruption propagation, and per-file maximum of 1,500,000 reported bytes. Oversized file becomes per-file parser error and should be excluded. Exact archive does not publish a formal maximum number of files per directory.

## 6. Issues, suppression, and default profile

Native repository is `go`, named `SonarAnalyzer`. Rule activation and parameter overrides come from platform quality-profile contract. `Sonar way` is default built-in Go profile and activates:

`S100`, `S107`, `S108`, `S117`, `S1110`, `S1125`, `S1134`, `S1135`, `S1186`, `S1192`, `S1479`, `S1656`, `S1763`, `S1764`, `S1862`, `S1871`, `S1940`, `S2757`, `S3776`, `S3923`, `S4144`, `S4663`.

Issue ranges are checked against indexed file bounds. Invalid parser ranges are discarded with diagnostic logging, or fail analysis in fail-fast mode. Rules can provide primary range, secondary ranges, and remediation gap.

Non-header comment whose trimmed text begins `NOSONAR`, case-insensitively, suppresses issues on its nonblank comment lines. Lowercase `nolint` directive suppresses same lines when bare or when linter list contains `all` or `gosec`; other linter names do not suppress. Due text-based handling, matching block comments are also honored. Header comments before first declaration do not create suppression lines.

### 6.1 Complete native rule catalog

Classification format is legacy type, default severity, clean-code impact when metadata supplies it. `All` means main and test files; `Main` means main files only. Parameter names are case-sensitive.

| Key | Classification and scope | Detection, exclusions, location | Parameters |
|---|---|---|---|
| `S100` | Code Smell, Minor, Maintainability Low; All | Reports function name that fails configured naming expression. Main and test naming expressions differ; issue is on function identifier. | `format=^(_|[a-zA-Z0-9]+)$`; `formatForTests=^(_|[a-zA-Z0-9_]+)$`. |
| `S103` | Code Smell, Major, Maintainability Medium; All | Reports physical line longer than configured limit. Import lines and comments containing only URL links are excluded; issue is on overlong line. | `maximumLineLength=120`. |
| `S104` | Code Smell, Major, Maintainability Medium; All | Reports file whose parser-provided noncomment line count exceeds limit; file-level issue. | `Max=750`. |
| `S1067` | Code Smell, Critical, Maintainability High; All | Reports expression containing more configured conditional operators than allowed; Go-relevant operators are conditional conjunction and disjunction. Issue is on expression. | `max=3`. |
| `S107` | Code Smell, Major, Maintainability Medium; All | Reports function with more formal parameters than limit; location is function declaration. | `Max=7`. |
| `S108` | Code Smell, Major, Maintainability Medium; All | Reports empty nested block. Block containing comment and infinite loop with neither initializer nor post statement are excluded; location is empty block. | None. |
| `S1110` | Code Smell, Major, Maintainability Medium; All | Reports parentheses pair that is redundant rather than disambiguating expression; location is redundant pair. | None. |
| `S1125` | Code Smell, Minor, Maintainability Low; All | Reports boolean literal whose use in logical expression or comparison is redundant; location is literal/expression. | None. |
| `S1134` | Code Smell, Major, Maintainability Medium; All | Reports case-insensitive `FIXME` word in comment and locates tag. CWE-546. | None. |
| `S1135` | Code Smell, Info, Maintainability Info; All | Reports case-insensitive `TODO` word in comment and locates tag. CWE-546. | None. |
| `S1145` | Bug, Major; All | Reports `if` whose condition is literal true or false; location is offending conditional. CWE-489, CWE-570, CWE-571. | None. |
| `S1151` | Code Smell, Major, Maintainability Medium; Main | Reports switch case clause with more parser-provided lines of code than limit; location is case clause. | `max=6`. |
| `S117` | Code Smell, Minor, Maintainability Low; All | Reports local-variable or function-parameter identifier not matching naming expression. | `format=^(_|[a-zA-Z0-9]+)$`. |
| `S1186` | Code Smell, Critical, Maintainability High; Main | Reports function with empty body. Body comment explains intentional emptiness and excludes issue; location is function. | None. |
| `S1192` | Code Smell, Critical, Maintainability High; Main | Reports repeated string literal at configured occurrence count. Excludes literals of at most five characters, word-only literals, and arguments to recognized logging/error functions; location is duplicate literal set. | `threshold=3`. |
| `S122` | Code Smell, Major, Maintainability Medium; All | Reports multiple statements on one physical line. Single nested statement in control-flow construct is excluded; location is offending statement. | None. |
| `S126` | Code Smell, Critical, Maintainability High; All | Reports `if`/`else if` chain lacking final `else`. Excludes chain where every branch ends with `return` or `break`; location is chain. | None. |
| `S131` | Code Smell, Critical, Maintainability High; All | Reports switch without default clause; location is switch. CWE-478. | None. |
| `S1314` | Code Smell, Blocker, Maintainability Blocker; All | Reports leading-zero integer literal interpreted as octal; location is literal. | None. |
| `S134` | Code Smell, Critical, Maintainability High; All | Reports first `if`, `for`, or `switch` reaching configured nesting threshold. Default allows three levels and reports fourth; deeper members of same nest do not add duplicate threshold issue. | `max=4`. |
| `S138` | Code Smell, Major, Maintainability Medium; Main | Reports function or method whose lines of code exceed limit; location is function. | `max=120`. |
| `S1451` | Code Smell, Blocker, Maintainability Blocker; All | Reports file whose beginning does not match required literal header lines or anchored regular expression; file-level location. | `headerFormat` empty text by default; `isRegularExpression=false`. |
| `S1479` | Code Smell, Major, Maintainability Medium; All | Reports switch with more case clauses than limit; location is switch. | `maximum=30`. |
| `S1656` | Bug, Major, Reliability Medium; All | Reports assignment whose target and source resolve to same variable; location is assignment. | None. |
| `S1763` | Bug, Major, Reliability Medium; Main | Reports first unlabeled statement unreachable after control-flow jump; location is unreachable statement. CWE-561. | None. |
| `S1764` | Bug, Major, Reliability Medium; All | Reports binary expression with structurally identical operands. Multiplication, addition, left shift, and assignment are excluded; self-assignment belongs to `S1656`. | None. |
| `S1821` | Code Smell, Critical, Maintainability High; All | Reports switch nested inside another switch; location is inner switch. | None. |
| `S1862` | Bug, Major, Reliability Medium; All | Reports repeated condition in related `if`/`else if` chain and repeated value among switch cases; location is later duplicate with original available for comparison. | None. |
| `S1871` | Code Smell, Major, Maintainability Medium; Main | Reports two conditional or switch branches with identical implementation. Single-statement branches are excluded; location is duplicate branch. | None. |
| `S1940` | Code Smell, Minor, Maintainability Low; All | Reports negation of comparison when direct opposite operator is clearer; location is inverted boolean check. | None. |
| `S2260` | Code Smell, Major; All | Represents parser failure. Analyzer always records analysis error; if rule active it also creates issue on parsed error line, or safe file fallback when line is unavailable. | None. |
| `S2757` | Bug, Major, Reliability Medium; All | Reports contiguous `=+`, `=-`, or `=!` followed by whitespace because sequence resembles reversed compound/comparison operator; location is operator sequence. | None. |
| `S3776` | Code Smell, Critical, Maintainability High; All | Reports function cognitive complexity above threshold. Flow breaks increment score, nesting adds weight, recursion increments, ordinary calls do not; location is function and excess can determine remediation gap. | `threshold=15`. |
| `S3923` | Bug, Major, Reliability Medium; All | Reports conditional or switch where all branches have identical implementation. Excludes `if` chain without final `else` and switch without default; location is whole structure. | None. |
| `S4144` | Code Smell, Major, Maintainability Medium; All | Reports function whose implementation duplicates another. Functions with fewer than two statements are excluded; location is later duplicate function. | None. |
| `S4663` | Code Smell, Minor, Maintainability Low; Main | Reports empty multiline/block comment; location is comment. | None. |

All 36 rule keys have exact paired HTML and JSON resources. Parameter names/defaults above are present in runtime-visible metadata of exact packaged check classes. Candidate implementation was not used to add any unverified rule.

All rules have status `ready`. Quick-fix metadata is `infeasible` for `S1134`, `S1135`, `S1186`, `S1479`, `S1763`, `S1871`, `S2260`, `S3776`, and `S4144`; it is `unknown` for remaining rules and therefore promises no automatic fix.

Default remediation is:

- five minutes per issue for `S100`, `S108`, `S1125`, `S1151`, `S1186`, `S126`, `S131`, `S1314`, `S1451`, and `S1763`;
- 30 minutes per issue for `S1479` and `S2260`; 20 minutes for `S107` and `S138`; 15 minutes for `S3923` and `S4144`; ten minutes for `S134`, `S1821`, `S1862`, and `S1871`;
- three minutes for `S1656`; two minutes for `S1145`, `S117`, `S1764`, `S1940`, and `S2757`; one minute for `S103`, `S1110`, `S122`, and `S4663`; one hour for `S104`; zero minutes for tracking rules `S1134` and `S1135`;
- linear five-minute offset plus one minute per excess point for `S1067` and `S3776`, and two-minute offset plus two minutes per duplicate instance for `S1192`.

## 7. Metrics, symbols, highlighting, and CPD

Metrics run only on `MAIN` files and emit:

- `ncloc`: distinct parser-reported lines of code, capped to physical file line count;
- `comment_lines`: nonblank comment-content lines excluding file header and `NOSONAR` comments;
- `functions`: named functions with bodies;
- `classes`: converted class-declaration nodes;
- `complexity`: one for each named function with body, plus each `if`, loop, non-default case, conditional conjunction, and conditional disjunction;
- `statements`: executable statements excluding package, import, function, class, native, and block declarations;
- `cognitive_complexity`: file aggregate from same cognitive-complexity model as `S3776`;
- per-line `ncloc_data` and `executable_lines_data`.

Executable-line starts exclude package, import, class, function, block, variable, and generic declaration nodes. Blank/comment-only content does not become executable line.

Syntax highlighting marks all comments, keyword tokens, string literals, and other literal constants. Symbol visitor runs for main and test files in both SonarQube and SonarLint.

CPD runs only on `MAIN` files. It emits tokens beginning at parser-designated first CPD token, preserves source token ranges and token text, but normalizes every string literal token to `LITERAL`. Other token text remains exact. CPD tokens can be restored from scanner cache for unchanged files.

## 8. Cache, concurrency, persistence, and telemetry

Analysis is sequential across directory batches in sensor thread. No analyzer-owned durable database exists. Persistent cross-analysis state is scanner cache only:

- file-content hash key uses input-file key;
- CPD token cache uses separate input-file key;
- file is skippable only when scanner status is unchanged, cache is enabled, and cached hash equals current input MD5;
- each cache-aware visitor must restore prior result; otherwise file is parsed and only successful visitors are skipped;
- cache read, copy, serialization, or write failure logs warning/debug and falls back to current analysis where possible.

On scanner API 10.9 or newer, project sensor sends telemetry properties `go.used_version`, `go.parse_failures_count`, `go.coverage_absolute_path`, `go.coverage_relative_no_module_in_go_mod_dir`, `go.coverage_absolute_no_module_in_report_path`, `go.coverage_relative_path`, `go.coverage_relative_no_module_in_report_path`, `go.coverage_relative_sub_paths`, and `go.coverage_unresolved`. Version value is sorted distinct semicolon list, `noGoModFile` when no version was collected, or internal override. Coverage properties are emitted only after coverage import attempt produced statistics. Telemetry transport and opt-out belong to platform telemetry contract.

## 9. Test report behavior

`sonar.go.tests.reportPaths` consumes newline-delimited JSON generated by Go test command with JSON output. Only lines beginning with `{` are considered. Relevant record requires fields `Action`, `Package`, `Test`, and `Elapsed`; accepted actions are `pass`, `fail`, and `skip`. Other events are ignored.

Records map to indexed Go `TEST` files. Package path resolves to directory, then analyzer finds base test function declaration; subtest suffix after first `/` is removed for file matching. Package resolution progressively removes leading path segments until project directory is found. Missing file or malformed line logs warning and does not stop other records.

Per test file analyzer saves `tests`, `test_failures`, `skipped_tests`, and `test_execution_time` in milliseconds. It does not run tests and does not import stdout as issue.

## 10. Coverage behavior

`sonar.go.coverage.reportPaths` consumes Go cover profile. First line must identify coverage mode. Each later nonempty record supplies file path, start and end line/column, statement count, and hit count; statement count is ignored. Malformed individual data line is ignored with debug log. A missing/invalid mode rejects that report. Hit-count overflow saturates at maximum signed 32-bit value.

Coverage is saved in batches of 10,000 report lines and at end. For each range, blank physical lines are ignored, leading/trailing braces and control characters are trimmed from effective range, and all remaining lines receive range hit count. Only line hits are emitted; no branch-condition coverage is synthesized.

Coverage path resolution precedence is:

1. exact absolute path;
2. module prefix removed, relative to matching `go.mod` directory;
3. module prefix removed, absolute relative to coverage report directory;
4. exact project-relative path;
5. module prefix removed, project-relative from report directory;
6. progressively shorter relative suffixes.

When several module names prefix report path, longest prefix wins. Unresolved or non-indexed file logs warning and is skipped. Failure for one file or report preserves previously saved coverage and other reports.

## 11. External linter imports

### 11.1 `go vet`, Golint, and GoMetaLinter

Go vet accepts lines with file, line, optional column, and message. Package-banner and exit-status lines are ignored. Imported type is Bug. Exact external repository `govet` defines keys: `appends`, `asmdecl`, `assign`, `atomic`, `bools`, `buildtag`, `cgocall`, `composites`, `copylocks`, `defers`, `directive`, `errorsas`, `framepointer`, `httpresponse`, `ifaceassert`, `loopclosure`, `lostcancel`, `nilfunc`, `printf`, `shift`, `sigchanyzer`, `slog`, `stdmethods`, `stdversion`, `stringintconv`, `structtag`, `testinggoroutine`, `tests`, `timeformat`, `unmarshal`, `unreachable`, `unsafeptr`, and `unusedresult`. Known message shapes map to these keys; unmatched messages use `issue`.

Golint accepts file, line, column, and message. Imported type is Code Smell. Exact external repository `golint` defines keys: `PackageComment`, `BlankImports`, `Imports`, `Exported`, `Names`, `VarDecls`, `Elses`, `Ranges`, `Errorf`, `Errors`, `ErrorStrings`, `ReceiverNames`, `IncDec`, `ErrorReturn`, `UnexportedReturn`, `TimeNames`, `ContextKeyTypes`, and `ContextArgs`. Known message shapes map to these keys; unmatched messages use `issue`.

GoMetaLinter accepts file, line, column, severity `error` or `warning`, message, and linter name. `error` maps to Bug; `warning` maps to Code Smell. Trailing parenthesized rule identifier of 1–20 alphanumeric, underscore, or hyphen characters becomes rule key and is removed from message. Linter name `vet` maps to repository `govet`; otherwise reported linter name is engine ID. Without explicit identifier, same known govet/golint message mapping applies or falls back to `issue`.

These line importers use Major severity and five-minute constant remediation. Missing or unreadable report and unresolved source file log warning; other reports and lines continue.

### 11.2 GolangCI-Lint Checkstyle mapping

Input root must be `checkstyle`. Nested `file` uses `name`; nested `error` uses `line`, `severity`, `source`, and `message`. File resolves by exact indexed absolute or relative path. Missing message is ignored. Missing line creates file-level location. `severity=error` maps Bug; all other values map Code Smell. `severity=info` maps Minor; all other values map Major. Remediation is five minutes.

For ordinary source, rule ID is `<source>.<lowercase type>.<lowercase severity>` under engine `golangci-lint`. Exact metadata registers 122 `<source>.bug.major` keys for following sources:

- `asasalint`, `asciicheck`, `bidichk`, `bodyclose`, `canonicalheader`, `containedctx`, `contextcheck`, `copyloopvar`, `cyclop`, `decorder`, `depguard`, `dogsled`, `dupl`, `dupword`, `durationcheck`, `errcheck`, `errchkjson`, `errname`, `errorlint`, `exhaustive`, `exhaustruct`, `exptostd`, `forbidigo`, `forcetypeassert`, `funcorder`, `fatcontext`, `funlen`, `ginkgolinter`, `gocheckcompilerdirectives`, `gochecknoglobals`, `gochecknoinits`, `gochecksumtype`, `gocognit`, `goconst`, `gocritic`, `gocyclo`, `godot`, `godox`, `err113`, `goheader`;
- `mnd`, `gomoddirectives`, `gomodguard`, `goprintffuncname`, `gosec`, `gosmopolitan`, `govet`, `grouper`, `iface`, `importas`, `inamedparam`, `ineffassign`, `interfacebloat`, `intrange`, `ireturn`, `lll`, `loggercheck`, `maintidx`, `makezero`, `mirror`, `misspell`, `musttag`, `nakedret`, `nestif`, `nilerr`, `nilnesserr`, `nilnil`, `nlreturn`, `noctx`, `nonamedreturns`, `nosprintfhostport`, `paralleltest`, `perfsprint`, `prealloc`, `predeclared`, `promlinter`, `protogetter`, `reassign`, `recvcheck`, `revive`;
- `rowserrcheck`, `sloglint`, `sqlclosecheck`, `spancheck`, `staticcheck`, `tagalign`, `tagliatelle`, `testableexamples`, `testifylint`, `testpackage`, `thelper`, `tparallel`, `typecheck`, `unconvert`, `unparam`, `unused`, `usestdlibvars`, `usetesting`, `varnamelen`, `wastedassign`, `whitespace`, `wrapcheck`, `wsl`, `zerologlint`, `nolintlint`, `deadcode`, `execinquery`, `exhaustivestruct`, `exportloopref`, `golint`, `gomnd`, `gosimple`, `ifshort`, `interfacer`, `maligned`, `megacheck`, `nosnakecase`, `scopelint`, `structcheck`, `stylecheck`, `tenv`, `varcheck`.

All 122 are named `Issue raised by <source>` and classified Reliability Medium in exact metadata.

Two overrides apply:

- source `gosec` always imports as Major Vulnerability under engine/rule `golangci-lint:gosec`; exact metadata additionally classifies this rule Security High. `gosec.bug.major` remains registered because it is one of generic mappings but override selects `gosec` for imported gosec issues;
- source `govet` whose message starts with lowercase alphabetic check name followed by colon maps to engine `govet` and that prefix rule key. Without matching prefix it follows ordinary `golangci-lint:govet.bug.major` mapping.

Malformed XML, unexpected root, I/O error, or runtime parse error rejects that report and logs warning. Earlier reports or issues already saved are not rolled back. XML factory is safe StAX factory and must not resolve untrusted external entities.

## 12. Failures, partial results, and recovery

- Unsupported OS/architecture or missing native member causes converter initialization warning. SonarLint skips Go analysis. SonarQube source sensor logs outer analysis error and returns by default; fail-fast rethrows.
- File read failure becomes parse exception for directory. Directory logs warning; fail-fast rethrows. Other directories continue otherwise.
- Native timeout, nonzero exit, interruption, invalid output, or process launch error fails current directory. Process is forcibly terminated and resources closed.
- Per-file parser error records analysis error, increments telemetry, and, when active, creates `S2260`. Valid sibling files continue. Fail-fast converts any per-file parse error into analysis failure after errors are recorded.
- Visitor runtime failure records analysis error on that file and continues remaining visitors. It does not become parser issue.
- Invalid issue/highlight/CPD range is dropped rather than writing out-of-bounds result; fail-fast can escalate invalid issue range.
- Cancellation stops before next directory and cancels progress report. Converter finalization still runs.
- Missing report paths warn and continue. Malformed report units are skipped at smallest supported granularity described above.
- Coverage importer catches top-level failure and keeps source analysis. Test importer catches report read/line failures. External-linter importer never runs a linter as recovery.
- Cache failure degrades to recomputation; it must not suppress current results solely because cache entry is corrupt.

## 13. Security and trust boundaries

Project source, `go.mod`, linter XML/text, test JSON, and coverage profiles are untrusted inputs. Parser runs as child process with scanner-user privileges and receives file names/content and detected module name. Implementations must preserve process timeout/termination, file-size guard, range validation, and per-file isolation. No user-provided executable is launched.

Native executable must come from packaged artifact, be selected only from supported matrix, and be extracted to instance temporary directory. Existing extracted file is reused only when bytes match packaged member. Unsupported host must not fall back to another architecture.

External report paths are operator-controlled. Imported issue locations may target only indexed files resolved through scanner predicates. XML parsing must retain external-entity-safe factory. Report messages are data, not executable content. Analyzer exposes no network configuration or credential handling and must not claim dependency download behavior.

## 14. Compatibility and limits

- Supported native hosts are exactly Windows x86-64, Linux x86-64/ARM64, and macOS x86-64/ARM64. No 32-bit, Windows ARM64, or other Unix member is packaged.
- Host architecture aliases recognized by packaged selector include `aarch64`, `arm64`, `armv8`, `x86_64`, `amd64`, and `x64`; unsupported combination fails initialization.
- Embedded Go `1.26.4` build and `x/tools 0.41.0` are implementation evidence, not declared source-language support range. Exact artifact provides no authoritative minimum Go language version. Go syntax accepted by native parser and `go.mod` recognition rules above define compatibility.
- Source file over 1,500,000 reported bytes is rejected per file.
- Directory analysis is package-batch based. Cross-directory project packages are not supplied as source in same native invocation; unresolved imported members may remain unknown without making file syntactically invalid.
- Reports are Community Build scanner-side features only. SonarLint excludes them.
- Candidate commit behavior beyond exact source/resource/class/runtime evidence is explicitly out of scope.

## 15. Acceptance scenarios

1. With default settings, indexed `.go` file outside vendor/generated defaults is analyzed. Indexed `.pb.go`, `.pb.gorm.go`, or path under `vendor` is filtered. Expected outcome: only accepted Go files reach parser.
2. With neither test property set, `_test.go` file is treated as test for rule scope. With either test property set, scanner type wins. Expected outcome: Main-only rules and metrics do not run on scanner test file.
3. Set `sonar.go.activate=false`. Expected outcome: native source analysis produces no Go issues, symbols, metrics, CPD, or highlighting; independently configured report sensor behavior is unchanged.
4. Analyze two valid same-package files in one directory where one references declaration in other. Expected outcome: reference resolves to same symbol identity and type as declaration.
5. Analyze file importing available standard package and another unavailable third-party package. Expected outcome: available member type resolves; unavailable member remains unknown without parser issue solely for missing import.
6. Put valid and syntactically invalid files in same directory with fail-fast disabled and `S2260` active. Expected outcome: valid file results remain; invalid file has analysis error and parser issue. With fail-fast enabled, analysis fails after errors.
7. Provide nested `go.mod` and valid internal source-version override. Expected outcome: closest module name is used per directory, override version takes precedence globally, and warning records precedence.
8. Analyze Main file containing functions, branches, comments, literals, and repeated source tokens. Expected outcome: listed metrics, highlighting, symbols, and CPD are emitted; CPD replaces string contents with `LITERAL`.
9. Activate `S103` with shorter configured maximum and place URL-only comment and import beyond limit beside ordinary overlong line. Expected outcome: ordinary line issue only; documented exclusions remain silent.
10. Place lowercase bare `nolint` on issue line and name only unrelated linter on another. Expected outcome: bare directive suppresses line; unrelated linter name does not. Header directive suppresses nothing.
11. Import GolangCI-Lint Checkstyle issue with source `gosec`. Expected outcome: Major Vulnerability under `golangci-lint:gosec`. Import govet source message with recognized prefix. Expected outcome: engine becomes `govet` and prefix becomes rule key.
12. Import coverage file whose path includes module prefix. Expected outcome: resolver follows documented precedence, records line hits, ignores blank/brace-only range edges, and skips unresolved files without aborting source analysis.
13. Import Go test JSON containing parent and subtest terminal events. Expected outcome: both map to base test function file and aggregate tests, failures/skips, and elapsed milliseconds.
14. Reanalyze unchanged file with valid hash and CPD caches. Expected outcome: reusable visitors restore results and parser is skipped only when every cache-aware visitor succeeds; corrupt cache forces recomputation.
15. Run on unsupported architecture. Expected outcome: no alternate binary is executed; initialization failure is logged, with SonarLint skip or SonarQube default partial failure behavior described above.

## 16. Provenance index

### Exact Maven and distribution evidence

- Maven directory: https://repo1.maven.org/maven2/org/sonarsource/go/sonar-go-plugin/1.40.0.6765/
- POM: https://repo1.maven.org/maven2/org/sonarsource/go/sonar-go-plugin/1.40.0.6765/sonar-go-plugin-1.40.0.6765.pom
- Source archive and checksum: https://repo1.maven.org/maven2/org/sonarsource/go/sonar-go-plugin/1.40.0.6765/sonar-go-plugin-1.40.0.6765-sources.jar and adjacent `.sha256`.
- Packaged plugin manifest: `sonar-go-plugin-1.40.0.6765.jar!/META-INF/MANIFEST.MF`.
- Native members and notices: `sonar-go-plugin-1.40.0.6765.jar!/sonar-go-to-slang-*`; source archive `licenses/sonar-go-to-slang-*-licenses/`.
- Exact native behavior probes used `sonar-go-to-slang-darwin-arm64`, SHA-256 `37298b8e7abf051fe13e414181752f452f09989252a41fc00cde8dfa38bd7bf1`, for same-package linking, standard and unresolved imports, semantic fields, and mixed valid/invalid result.

### Exact source paths

- Registration and settings: `org/sonar/go/plugin/GoPlugin.java`, `GoLanguage.java`, `GoExclusionsFileFilter.java`, `InputFileDiscovery.java`.
- Main flow and errors: `org/sonar/go/plugin/GoSensor.java`, `InputFileContext.java`, `converter/ASTConverterValidation.java`, `report/GoProgressReport.java`.
- Module/version context: `org/sonar/go/plugin/GoModFileFinder.java`, `GoModFileAnalyzer.java`, `GoModFileDataStore.java`.
- Metrics and rendering: `org/sonar/go/plugin/MetricVisitor.java`, `CyclomaticComplexityVisitor.java`, `StatementsVisitor.java`, `CommentAnalysisUtils.java`, `SyntaxHighlighter.java`, `CpdVisitor.java`.
- Suppression and cache: `org/sonar/go/plugin/IssueSuppressionVisitor.java`, `SkipNoSonarLinesVisitor.java`, `caching/CacheHandler.java`, `caching/HashCacheUtils.java`.
- Rule repository/profile: `org/sonar/go/plugin/GoRulesDefinition.java`, `GoProfileDefinition.java`, `org/sonar/l10n/go/rules/go/Sonar_way_profile.json`.
- Rule metadata and detection descriptions: `org/sonar/l10n/go/rules/go/S100.{html,json}` through all 36 paired resources listed in section 6.1. Exact parameter annotation evidence is in packaged `org/sonar/go/checks/*Check.class` entries; no decompiled source is reproduced here.
- Test import: `org/sonar/go/testreport/GoTestSensor.java`.
- Coverage import: `org/sonar/go/coverage/GoCoverSensor.java`, `CoverageStat.java`, `Coverage.java`, `FileCoverage.java`, `GoCoverageStorageImpl.java`.
- External import: `org/sonar/go/externalreport/AbstractPropertyHandlerSensor.java`, `AbstractReportSensor.java`, `CheckstyleFormatImporter.java`, `ExternalIssue.java`, `ExternalKeyUtils.java`, four report sensors, and three rule definitions.
- External catalogs: `org/sonar/l10n/go/rules/govet/rules.json`, `golint/rules.json`, `golangci-lint/rules.json`.
- Telemetry: `org/sonar/go/plugin/GoProjectSensor.java`, `org/sonar/go/coverage/FileResolutionStatistics.java`.

### Corroborating-only source

- Repository: https://github.com/SonarSource/sonar-go
- Candidate commit: `ba90d496cc57d793b867a82ff656a51fc7993735`.
- Candidate was used only to understand names and compare exact plugin-module files. No candidate-only parser, semantic, rule, or host behavior is asserted.
