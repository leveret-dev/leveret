# CSS Analyzer Specification

## Identity, license, and authority

This specification covers repository and language key `css` in bundled artifact `org.sonarsource.javascript:sonar-javascript-plugin:13.4.0.43982:multi`, pinned by Community Build `26.8.0.126808`. Source authority is SonarSource/SonarJS tag `13.4.0.43982`, commit `d02b514f8007f18a798876fc9361b9c233ab2f02`. Analyzer-owned source uses Sonar Source-Available License v1.0 (`LicenseRef-SSAL-1.0`); PostCSS, Stylelint, syntax adapters, and other dependencies retain their notices. [I1][I2]

## Purpose, scope, dependencies, and ownership

CSS analyzer recognizes CSS, Less, SCSS, and Sass, parses with pinned PostCSS-family syntax adapters, executes active `css` rules, emits parser/rule issues, syntax highlighting, NCLOC/comment measures, and NOSONAR lines, and imports external Stylelint issues. Embedded style selection and host projection for HTML/Vue belongs to `../embedded-web-yaml/specification.md`. Shared Node bridge/runtime belongs to `../javascript/specification.md#shared-bridge-and-runtime-contract`; this file does not redefine it. Platform owns profiles, core metric identifiers, issue lifecycle, and persisted duplication/coverage contracts. [B1][C2][C3]

CSS analyzer has no coverage importer, symbol table, executable-line measure, structural counts, complexity, cognitive complexity, or CPD tokens. Embedded adapter never transfers CSS metrics to HTML/Vue hosts. [C3][B2]

## Inputs, recognition, configuration, and precedence

Language key is `css`. `sonar.css.file.suffixes` defaults to `.css,.less,.scss,.sass`. Configured values are trimmed, lower-cased, dot-prefixed, de-duplicated, and replace defaults. `sonar.javascript.css.additional.file.suffixes` defaults to `.vue,.html,.htm,.xhtml` and selects extension-based embedded style analysis; details and ownership are in embedded specification. [C3][B2]

Pure CSS-family files bypass JavaScript maximum-size and bundle filters. Files named `.min.css` or `-min.css`, and `.css` content averaging more than 200 characters per line, are excluded as minified; preprocessor suffixes are not average-line filtered by this gate. Main/test classification follows scanner input type. [B2]

Active quality profile supplies Stylelint keys and rule configurations. No parameter means enabled value true; configured parameters override generated defaults. Parser selection is plain PostCSS for CSS, `postcss-less` 6.0.0, `postcss-scss` 4.0.9, and `postcss-sass` 0.5.0. Embedded HTML/Vue uses `postcss-html` 1.8.1 with nested syntax selection. Stylelint is 17.14.1; Sonar CSS custom rules and `@stylistic/stylelint-plugin` 5.2.1 are loaded alongside core rules. [C2][I1]

Rules `css:S8770`, `css:S8775`, and `css:S8777` are CSS-only: they run on `.css` and CSS-language embedded blocks, never `.scss`, `.sass`, or `.less`, and warnings within embedded blocks marked `scss`, `sass`, `less`, `stylus`, or `styl` are removed. Other active CSS rules are eligible across supported syntax unless their own semantics do not match. [C2]

## Processing, outputs, metrics, highlighting, and state

Input is sanitized by replacing Unicode characters U+2000 through U+200F with spaces and normalizing CR-only line endings to LF for stable PostCSS locations. Lint runs first. A Stylelint `CssSyntaxError` is converted to parser failure; ordinary issues preserve rule key/message and convert one-based Stylelint columns to zero-based platform columns. Invalid/missing positions fall back to line 1, column 0; `no-empty-source` omits invalid end range. [C3]

Pure main CSS produces issues, highlighting, `ncloc`, `comment_lines`, per-line `ncloc_data`, and NOSONAR lines. Declarations and at-rules count all source lines from start through end; rules count selector/opening and closing lines; comments count their full ranges. Code and comment sets are independent, so a line containing both contributes to both metrics. `NOSONAR` is case-sensitive in CSS comments and registers comment start line. No functions, statements, classes, complexity, cognitive complexity, executable-line data, symbols, or CPD are written. [C3][B2]

Highlighting marks comments, at-rule names, selector IDs, hexadecimal colors, properties, preprocessor variables, strings, and numeric/unit values using platform token classes. Main files receive highlighting; test files receive highlighting only and suppress issues and measures. SonarLint returns issues and NOSONAR only, without server highlighting/measures. Failure during metrics/highlighting preserves already produced issues and warns. [C3]

Pure CSS files are always analyzed rather than restored from JavaScript scanner cache. Embedded CSS runs when its host is analyzed; unchanged `js`, `web`, or `yaml` hosts may be omitted by host cache strategy. No analyzer-owned durable state exists; active Stylelint configuration resets each project run. If no CSS rules are active, CSS linter resets and embedded CSS pass is skipped. [B2][C2]

## External Stylelint reports

`sonar.css.stylelint.reportPaths` defaults empty and triggers only when configured in SonarQube. It accepts multiple report paths through platform external-report resolver. JSON may carry UTF-8/16/32 BOM; absent BOM means UTF-8. Each file record supplies `source` and `warnings`; each warning uses `rule`, `text`, and line. Source resolves by relative or absolute indexed path. External issue location is whole line, engine `stylelint`, and classification/severity/remediation come from 170 packaged Stylelint identifiers. Missing input warns; unreadable report or malformed JSON logs error and other reports continue. [C3]

Imported Stylelint reports do not feed native CSS rule deduplication and do not create measures, highlighting, or fixes. Native CSS rules also expose no implementation quick fixes in this release. [C2][C3]

## Failure, recovery, security, compatibility, and limits

Having no CSS inputs is a successful no-op. CSS parser failure records an analysis error and emits `css:S2260` only when active; ordinary rules and metrics for that file are absent. Unlike JS/TS runtime errors, CSS file failures do not trigger internal fail-fast branch. Invalid issue/highlight positions warn and preserve other outputs. Shared bridge startup/runtime failures still fail project according to JavaScript contract because CSS uses same process. [B1][B2][C3]

CSS content, custom suffixes, embedded host markup, rule parameters, and external report paths are untrusted. Implementations must bound parser resource use, normalize paths to indexed files, validate ranges, keep bridge on loopback, and never evaluate CSS/preprocessor expressions. Stylelint plugins are bundled trusted code; project-supplied Stylelint configuration or plugins are not loaded by this contract. [B1][C2][C3]

Compatibility requires Java 17, plugin API minimum `9.14.0.375`, shared Node support, PostCSS 8.5.20, Stylelint 17.14.1, and pinned syntax adapters. CSS parser behavior outside these versions is not promised. Analyzer has no host metrics for HTML/Vue, no coverage, no CPD, and no symbols. [I1][C3]

## Acceptance scenarios

1. Default `.css`, `.less`, `.scss`, and `.sass` files select corresponding parser; custom suffix override replaces defaults.
2. A `.min.css` file is skipped; a large non-minified CSS file is not rejected by JavaScript 1000 kB limit.
3. Main `.scss` runs ordinary eligible CSS rules but never CSS-only `S8770`, `S8775`, or `S8777`.
4. Test CSS parses and highlights but emits no native CSS issues or measures.
5. A line containing declaration and comment contributes to both NCLOC and comment-line counts.
6. CSS parsing failure records analysis error and optional `css:S2260`; no other file outputs are accepted.
7. Embedded SCSS block in Vue cannot report CSS-only rule; `css:S8757` also suppresses `!default` and `!global` there based on embedded `source.lang`. Ordinary compatible CSS rules remain eligible, and CSS pass contributes no Vue host metrics.
8. UTF-16 Stylelint report with BOM imports whole-line external issues; unknown source path warns and is skipped.
9. Metrics/highlighting exception after successful lint preserves lint issues and omits failed artifacts.
10. No active CSS rules means additional embedded CSS pass is skipped and linter state from prior project is not reused.

## Complete CSS rule catalog

Catalog contains 43 repository definitions: 42 executable CSS rules and parser-failure rule `S2260`. Public titles are externally visible compatibility strings and state concise detection requirements. [C1][C2]

| Fully qualified key | Public title and detection requirement | Classification | Status, scope, default profiles | Syntax eligibility and exclusions | Parameters | Issue location and quick fix |
|---|---|---|---|---|---|---|
| css:S125 | Sections of code should not be commented out | CODE_SMELL; Major; MAINTAINABILITY=MEDIUM | ready; All; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S1116 | Extra semicolons should be removed | CODE_SMELL; Minor; MAINTAINABILITY=LOW | ready; All; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S1128 | Duplicate imports should be removed | CODE_SMELL; Minor; MAINTAINABILITY=LOW | ready; All; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S1874 | Deprecated CSS features should not be used | CODE_SMELL; Minor; MAINTAINABILITY=LOW | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoreSelectors`, `ignoreKeywords`, and `ignoreAtRules`, each defaulting to an empty list. | Stylelint-reported primary range; no implementation quick fix. |
| css:S2260 | CSS parser failure | CODE_SMELL; Major; legacy classification only | ready; Main; none | Parser-failure path for any recognized CSS-family syntax; issue exists only when rule is active. | None. | parser position with line/column fallback; no implementation quick fix. |
| css:S4647 | Color definitions should be valid | BUG; Blocker; RELIABILITY=BLOCKER | ready; All; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4648 | Duplicated font names should be removed | CODE_SMELL; Major; MAINTAINABILITY=MEDIUM | ready; All; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4649 | Font declarations should contain at least one generic font family | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoreFontFamilies`, default empty. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4650 | "calc" operands should be correctly spaced | BUG; Blocker; RELIABILITY=BLOCKER | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4651 | "linear-gradient" directions should be valid | BUG; Critical; RELIABILITY=HIGH | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4652 | Strings should not contain new lines | CODE_SMELL; Major; MAINTAINABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4653 | Units should be valid | BUG; Blocker; RELIABILITY=BLOCKER | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoreFunctions`, default image-set, spacer, spacing, size, rem, em, fluid. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4654 | CSS properties should be valid | BUG; Blocker; RELIABILITY=BLOCKER | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoreProperties`, default composes and names beginning with mso-; `ignoreSelectors`, default selectors beginning with :export or :import. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4655 | "!important" should not be used on "keyframes" | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4656 | Properties should not be duplicated | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoreFallbacks`, default true. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4657 | Shorthand properties that override related longhand properties should be avoided | BUG; Critical; RELIABILITY=HIGH | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4658 | Empty blocks should be removed | CODE_SMELL; Major; MAINTAINABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4659 | Pseudo-class selectors should be valid | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoredPseudoClasses`, default local, global, export, import, deep. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4660 | Pseudo-element selectors should be valid | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignorePseudoElements`, default ng-deep, v-deep, deep. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4661 | Media features should be valid | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4662 | "at-rules" should be valid | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoreAtRules`, default value, at-root, content, debug, each, else, error, for, function, if, include, mixin, return, warn, while, extend, use, forward, tailwind, apply, layer, container, theme, utility, custom-variant, source, plugin, config, reference, and names beginning with at-sign. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4663 | Multi-line comments should not be empty | CODE_SMELL; Minor; MAINTAINABILITY=LOW | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4664 | Selectors of lower specificity should come before overriding selectors of higher specificity | CODE_SMELL; Critical; MAINTAINABILITY=HIGH | ready; Main; none | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4666 | Selectors should not be duplicated | CODE_SMELL; Major; MAINTAINABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4667 | CSS files should not be empty | CODE_SMELL; Major; MAINTAINABILITY=MEDIUM | ready; All; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4668 | Single line comment syntax should not be used | BUG; Blocker; RELIABILITY=BLOCKER | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S4670 | Selectors should be known | BUG; Critical; RELIABILITY=HIGH | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoreTypes`, default names beginning with mat-, md-, or fa-; `ignore`, default custom-elements. | Stylelint-reported primary range; no implementation quick fix. |
| css:S5362 | Expressions within "calc" should be valid | BUG; Critical; legacy classification only | deprecated; All; none | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S7923 | CSS should not restrict page orientation using transform properties | CODE_SMELL; Minor; MAINTAINABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S7924 | Text and background colors should have sufficient contrast | CODE_SMELL; Major; MAINTAINABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S7925 | Text spacing properties should not use "!important" in style attributes | CODE_SMELL; Minor; MAINTAINABILITY=LOW | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8757 | CSS annotations should be known | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files and supported embedded style blocks; on `.scss`/`.sass` roots or embedded roots whose `source.lang` is `scss` or `sass`, warnings for `!default` and `!global` are suppressed. | `ignoreAnnotations`, default empty. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8759 | "at-rules" should not be vendor-prefixed | CODE_SMELL; Major; MAINTAINABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoredAtRules`, default empty. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8765 | Custom properties should be wrapped in "var()" when used as values | BUG; Blocker; RELIABILITY=BLOCKER | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8767 | CSS declarations should be placed in valid positions | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoredAtRules`, default empty. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8769 | Redundant nested style rules should be removed | CODE_SMELL; Major; MAINTAINABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8770 | Descriptors within "at-rules" should be valid | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; plain CSS and CSS-language embedded blocks only; excluded from SCSS, Sass, Less, and non-CSS embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8773 | Keyframe selectors should not be duplicated | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8774 | An+B selectors should be matchable | BUG; Critical; RELIABILITY=HIGH | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8775 | At-rule descriptor values should be valid | BUG; Blocker; RELIABILITY=BLOCKER | ready; Main; Sonar way | Main files; plain CSS and CSS-language embedded blocks only; excluded from SCSS, Sass, Less, and non-CSS embedded style blocks. | None. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8776 | Nesting selectors should have a scoping root | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoredAtRules`, default empty. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8777 | "at-rule" preludes should be valid | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; plain CSS and CSS-language embedded blocks only; excluded from SCSS, Sass, Less, and non-CSS embedded style blocks. | `ignoredAtRules`, default empty. | Stylelint-reported primary range; no implementation quick fix. |
| css:S8778 | "@import" rules should precede all other statements | BUG; Major; RELIABILITY=MEDIUM | ready; Main; Sonar way | Main files; CSS, SCSS, Sass, Less, and supported embedded style blocks. | `ignoredAtRules`, default empty. | Stylelint-reported primary range; no implementation quick fix. |

## Provenance index

All observations are from tag `13.4.0.43982`, commit `d02b514f8007f18a798876fc9361b9c233ab2f02`, unless an official URL is shown.

- [I1] `LICENSE.txt`; `README.md`; `pom.xml`; `sonar-plugin/sonar-javascript-plugin/pom.xml`; official source tag: https://github.com/SonarSource/SonarJS/tree/13.4.0.43982
- [I2] Community Build `build.gradle` line carrying `org.sonarsource.javascript:sonar-javascript-plugin:13.4.0.43982`; `sonar-application/bundled_plugins.gradle` classifier `multi` at SonarQube tag `26.8.0.126808`.
- [B1] `sonar-plugin/bridge/src/main/java/org/sonar/plugins/javascript/bridge/BridgeServerImpl.java`; `EmbeddedNode.java`; `NodeDeprecationWarning.java`; `sonar-plugin/bridge/src/main/java/org/sonar/plugins/javascript/nodejs/NodeCommandBuilderImpl.java`; `tools/sync-nodejs-versions.mjs`; `package.json`.
- [B2] `sonar-plugin/sonar-javascript-plugin/src/main/java/org/sonar/plugins/javascript/analysis/WebSensor.java`; `AnalysisProcessor.java`; `JsTsContext.java`; `packages/analysis/src/analyzeProject.ts`; `packages/analysis/src/analyzeFile.ts`; `packages/analysis/src/common/configuration.ts`; `packages/analysis/src/common/filter/`.
- [R1] `sonar-plugin/javascript-checks/src/main/resources/org/sonar/l10n/javascript/rules/javascript/`; each catalog row derives from the JSON file whose basename equals its displayed short key.
- [R2] `packages/analysis/src/jsts/rules/`; each catalog row derives from its same-named rule directory, including `meta.ts`, optional `config.ts`, implementation/decorator, and tests; `tools/generate-eslint-meta.ts`; `packages/analysis/src/jsts/rules/helpers/`.
- [R3] `sonar-plugin/javascript-checks/src/main/java/org/sonar/javascript/checks/CheckList.java`; `sonar-plugin/sonar-javascript-plugin/src/main/java/org/sonar/plugins/javascript/rules/JavaScriptRulesDefinition.java`; `TypeScriptRulesDefinition.java`; `JavaScriptProfilesDefinition.java`.
- [M1] `packages/analysis/src/jsts/analysis/file-artifacts.ts`; `packages/analysis/src/jsts/analysis/analyzer.ts`; `sonar-plugin/sonar-javascript-plugin/src/main/java/org/sonar/plugins/javascript/analysis/AnalysisProcessor.java`.
- [T1] `packages/analysis/src/analyzeWithProgram.ts`; `analyzeWithIncrementalProgram.ts`; `analyzeWithoutProgram.ts`; `file-stores/tsconfigs.ts`; `jsts/program/tsconfig/options.ts`; `jsts/program/factory.ts`.
- [E1] `packages/analysis/src/html/`; `packages/analysis/src/yaml/`; `packages/analysis/src/jsts/embedded/`; `sonar-plugin/sonar-javascript-plugin/src/main/java/org/sonar/plugins/javascript/JavaScriptFilePredicate.java`.
- [C1] `sonar-plugin/css/src/main/resources/org/sonar/l10n/css/rules/css/`; each CSS catalog row derives from the JSON file whose basename equals its displayed short key.
- [C2] `packages/analysis/src/css/rules/metadata.ts`; `packages/analysis/src/css/linter/`; `sonar-plugin/css/src/main/java/org/sonar/css/CssRulesDefinition.java`.
- [C3] `packages/analysis/src/css/analysis/`; `sonar-plugin/css/src/main/java/org/sonar/css/CssLanguage.java`; `StylelintReportSensor.java`.
- [X1] `sonar-plugin/sonar-javascript-plugin/src/main/java/org/sonar/plugins/javascript/external/`; `rules/EslintRulesDefinition.java`; `TslintRulesDefinition.java`; packaged external-rule JSON under `sonar-plugin/javascript-checks/src/main/resources/org/sonar/l10n/javascript/rules/eslint/` and `sonar-plugin/sonar-javascript-plugin/src/main/resources/org/sonar/l10n/typescript/rules/`.
- [L1] `sonar-plugin/sonar-javascript-plugin/src/main/java/org/sonar/plugins/javascript/lcov/`; official LCOV format project: https://github.com/linux-test-project/lcov
