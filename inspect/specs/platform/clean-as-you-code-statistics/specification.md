# Clean as You Code Statistics Specification

## 1. Identity, provenance, and license

This specification covers the bundled Clean as You Code statistics plugin in SonarQube Community Build `26.8.0.126808`.

- Maven coordinate: `org.sonarsource.plugins.cayc:sonar-cayc-plugin:2.6.0.3665`.
- Published JAR SHA-256: `b84b927b7d746b98cbe52ae87ae64f8802c0b8eeec5d2cf012577d92a0f6307b`.
- Plugin key: `cayc`.
- Plugin name: `Clean as You Code`.
- Source repository: `https://github.com/SonarSource/sonar-cayc-stats-plugin`.
- Source tag: `2.6.0.3665`.
- Source commit: `55c5ecf4a75806328950c2526ed2660a69e5376b`.
- License: `LGPL-3.0-or-later`; the published POM describes GNU LGPL v3 and the source headers permit version 3 or any later version.

[Provenance: Maven Central `https://repo1.maven.org/maven2/org/sonarsource/plugins/cayc/sonar-cayc-plugin/2.6.0.3665/`; source tag root `LICENSE` and `pom.xml`; SonarQube commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`, root build and bundled-plugin declarations]

The published artifact, tag, and commit agree on version and source repository. Unlike the web application, this plugin has an exact public source tag and immutable commit. No branch-head behavior is used.

## 2. Purpose, scope, and exclusions

The plugin supplies one historical statistics page intended to illustrate a hypothetical benefit of focusing on new code. It reads the current set of unresolved Bugs and Vulnerabilities, groups them by creation date over a bounded history, shows their cumulative current-state curve, and compares that curve with a client-side projection that assumes a 20% annual reduction after a selected historical starting point. [Provenance: `src/main/ts/api.ts`, `src/main/ts/components/useData.ts`, `src/main/ts/components/utils.ts`, `src/main/ts/components/Chart.tsx`, and `src/main/ts/constants.ts` at commit `55c5ecf4a75806328950c2526ed2660a69e5376b`]

The page is demonstrative statistics, not a policy engine. It does not define new code, calculate or select a quality gate, change a quality profile, alter an issue, enforce remediation, run analysis, add rules, publish metrics, or persist a projection. New-code definitions, project-level overrides, gate conditions, and all actual Clean as You Code policy remain owned by `platform/project-configuration/`; issue data and lifecycle remain owned by `platform/analysis-results/`. [Provenance: `manifest/dependency-map.md`; plugin extension list in `src/main/java/org/sonar/plugin/cayc/CleanAsYouCodePlugin.java`; official docs `https://docs.sonarsource.com/sonarqube-community-build/user-guide/about-new-code.md` and `https://docs.sonarsource.com/sonarqube-community-build/project-administration/adjusting-analysis/configuring-new-code-calculation.md`]

The plugin has no analyzer, language, file-suffix, parser, semantic model, sensor, scanner property, rule repository, rule key, metric key, highlighting, symbol, CPD, coverage, test-report, or external-report behavior. Its rule catalog and metric catalog are empty. It does not claim commercial Clean as You Code features.

## 3. Dependencies and owned contracts

The plugin depends on the following external contracts:

- Plugin discovery and page registration from `platform/plugin-extension-runtime/`. The published plugin descriptor requires SonarQube 8.9 or newer, names entry class `org.sonar.plugin.cayc.CleanAsYouCodePlugin`, and registers only a page definition.
- Browser extension hosting from `platform/web-ui/`. The UI registers extension key `cayc/stats`; the host route is `/extension/cayc/stats` beneath the configured web context.
- HTTP routing, authentication, validation, and errors from `platform/http-api/` and `platform/identity-access/`.
- Project visibility and stable component keys from `platform/project-configuration/`.
- Issue search and creation-date facet semantics from `platform/analysis-results/` and `platform/search-indexing/`.
- Host localization, base URL, request helper, extension bridge, and global error surface provided by the SonarQube browser runtime.

[Provenance: published POM; `src/main/java/org/sonar/plugin/cayc/CAYCPageDefinition.java`; `src/main/java/org/sonar/plugin/cayc/CleanAsYouCodePlugin.java`; `src/main/ts/stats.tsx`; `src/main/ts/api.ts`; `manifest/dependency-map.md`]

The plugin owns only page registration, its visible presentation, project and period selectors, issue-history request orchestration, cumulative transformation, hypothetical projection, and page-local loading/empty/error states.

## 4. Page registration and browser surface

At server plugin startup, the plugin registers one global page with key `cayc/stats` and visible name `Focusing on new code`. When the plugin is active, the host includes that page in its extension navigation; the pinned black-box evidence reaches it through the global “More” menu and the `Focusing on new code` link. The Web UI extension route resolves it as `/extension/cayc/stats`. [Provenance: `src/main/java/org/sonar/plugin/cayc/CAYCPageDefinition.java`; `src/main/ts/stats.tsx`; `src/bbt/java/org/sonar/plugin/cayc/bbt/CAYCChartDataBBT.java`; Web UI route contract in `platform/web-ui/specification.md`]

The page contains two bordered cards in a vertically stacked container capped at 1280 CSS pixels:

1. An introduction card shows a decorative Clean as You Code illustration, heading `Focusing on new code`, and explanatory text stating that focusing on new-code quality can improve code quality and that the chart illustrates what could have happened.
2. A chart card shows the heading `Focus on new code`, a Project selector, a Period selector, and one of loading, request-failed, no-data, or graph content.

[Provenance: `src/main/ts/components/CleanAsYouCode.tsx`, `CAYCPresentation.tsx`, `Chart.tsx`, and `src/main/resources/org/sonar/l10n/cayc.properties`]

## 5. Accepted inputs and API dependencies

### 5.1 Issue statistics

The plugin issues 15 same-origin requests to `/api/issues/search`. It divides the period from approximately 15 years before the current calendar date through the current date into 15 consecutive one-year windows. Each request supplies date-only `createdAfter` and `createdBefore` values formatted as `yyyy-MM-dd`, `types=BUG,VULNERABILITY`, `resolved=false`, and `facets=createdAt`. The date construction compensates for the browser's timezone offset before subtracting years. [Provenance: `src/main/ts/api.ts`]

When a project is selected, each issue request also supplies both `components=<projectKey>` and `componentKeys=<projectKey>` with the same value. With the default all-project selection, neither parameter is sent. The API decides visibility and facet content; the plugin does not bypass project permissions or request hidden projects.

The response contract consumed by the plugin is a `facets` array whose first element has `values`; each value supplies a parseable date string `val` and integer `count`. The plugin does not consume returned issue records. [Provenance: `src/main/ts/api.ts`]

### 5.2 Project selection

Project options come from `/api/components/search_projects`. Opening the asynchronous selector loads options. Typing a project name waits 250 milliseconds before requesting; a non-empty term is sent as filter expression `query = "<entered text>"`. Returned components are mapped to their stable `key` and visible `name`. The selector caches loaded options during the mounted page, is searchable, and is clearable. [Provenance: `src/main/ts/api.ts` and `src/main/ts/components/Chart.tsx`]

The default option has an empty value and visible label `all projects`. Clearing a selected project restores that default and triggers the all-project issue request set.

### 5.3 Period selection

Candidate projection periods are ordered as 6 months, 1 year, 2 years, 5 years, and 10 years. A candidate is available only when the observed chart span is strictly longer than that period. The default is the longest available candidate. The Period selector is not searchable. [Provenance: `src/main/ts/components/useData.ts`]

There are no server settings, project settings, URL parameters, scanner properties, environment variables, or plugin-specific persisted preferences that modify the 15-year range, issue types, unresolved filter, period choices, or 20% projection rate in this release.

## 6. Statistics and projection semantics

### 6.1 Current-state series

The 15 issue-search requests execute concurrently and complete as one aggregate operation. Their yearly results are kept in chronological request order. Leading yearly windows whose facet counts total zero are omitted. Beginning with the first yearly window having a positive total, every returned creation-date bucket from that and later windows is appended in API order. [Provenance: `src/main/ts/api.ts`]

The plugin converts the creation-date buckets into a cumulative series. The value at each point is the running sum of unresolved Bug and Vulnerability counts returned for that point and every earlier retained point. Thus the final “Current state” number is the count accumulated from returned matching buckets in the bounded request range; it is not a count of all issue types, Security Hotspots, resolved issues, or issues older than the queried range. [Provenance: `src/main/ts/components/useData.ts`; black-box comparison in `src/bbt/java/org/sonar/plugin/cayc/bbt/CAYCChartDataBBT.java`]

The current-state series is historical by creation date but filtered using current unresolved state. Resolving or deleting an issue can therefore change the historical curve on the next page load even though its original creation date has not changed. This follows directly from `resolved=false`; the page does not store historical snapshots.

### 6.2 Hypothetical Clean as You Code series

For the selected period, the starting date is the chart's final date minus the selected number of months. If a cumulative point occurs in that same calendar month, its cumulative count becomes the projection's starting count and the projected series uses that point and all later retained points. For each projected point `m` months after the starting point, the count is the nearest whole number to $N \times 0.8^{m/12}$, where $N$ is the starting count. This represents 20% fewer issues per year with exponential monthly interpolation. [Provenance: `src/main/ts/constants.ts`, `src/main/ts/components/utils.ts`, and `src/main/ts/components/useData.ts`; numeric expectations in `src/main/ts/components/__tests__/utils-test.ts`]

If no retained point shares the selected starting month, the pinned release uses the first retained point as the decay baseline but produces a projected output only for the last retained source point. This is released edge behavior, not a generalized interpolation requirement. [Provenance: `src/main/ts/components/utils.ts`]

### 6.3 Visible graph and numbers

The graph uses a 500 by 300 plotting area and a 250-pixel annotation area. Its horizontal time scale spans the first and last cumulative dates. Its vertical scale starts at zero, extends to one and one-half times the final cumulative count, and chooses display-friendly ticks. The current curve is visually red/pink; the projection is green. Vertical markers label the chart start, selected projection start, and `Now`; the projection-start marker is dashed. [Provenance: `src/main/ts/constants.ts`, `src/main/ts/components/useData.ts`, `src/main/ts/components/Chart.tsx`, `ChartLine.tsx`, `ChartVerticalMarker.tsx`, and `Line.tsx`]

At the final date, the page visibly labels both `Current state` and `Focus on new code` and displays each count with compact significant-digit formatting. It also states `You would have with no extra effort:` followed by the compact-formatted difference between final current count and final projected count as `<count> fewer bugs and vulnerabilities`. The projection is hypothetical; it is never written back as an issue, measure, gate result, or project setting. [Provenance: `src/main/ts/components/Chart.tsx`, `ChartLine.tsx`, and localization bundle]

## 7. Processing lifecycle, state, and concurrency

1. On mount, the introduction renders and chart state begins as loading.
2. The plugin launches all 15 issue-facet requests for the current project selection.
3. It waits for all requests. No partial yearly series is rendered.
4. It discards leading empty years, creates cumulative points, calculates chart domains and eligible periods, and selects the longest eligible period.
5. A second page-local transformation recalculates projection start and values whenever cumulative data, date range, or selected period changes.
6. Selecting or clearing a project starts a new complete 15-request cycle and recomputes derived values when that cycle settles. A prior cycle is neither canceled nor generation-checked.
7. Selecting a period changes only the client-side projection; it does not re-query issues.
8. Unmounting the page discards all page-local state. No page state is persisted on the server or in browser storage.

[Provenance: `src/main/ts/components/useData.ts` and `Chart.tsx`]

The plugin has no task queue, worker, database table, index, alarm, scheduled job, or cross-user shared state. Requests from separate browsers are independent. Within one load, all 15 issue windows start concurrently and form one fail-fast aggregate; any rejected window fails that aggregate and discards otherwise successful window results. Overlapping project selections remain independent aggregates. Every successful aggregate may update page data when it settles, so the last success to write determines the stored chart data even when it belongs to an older selection. Any aggregate rejection sets a failure flag that later successes do not clear; an older rejection can therefore replace newer data with the sticky error state. [Provenance: `src/main/ts/api.ts` and `src/main/ts/components/useData.ts`]

## 8. Accessibility-visible behavior

The Project selector exposes accessible name `Project`; the Period selector exposes accessible name `Period`. Both are operable controls supplied by the selector component. The introduction illustration is marked `aria-hidden`. The graph's arrow decoration is also hidden from accessibility APIs. The final current and projected labels and issue counts are SVG text, and the savings statement is ordinary visible text, so the result is not communicated only through red/green curves. [Provenance: `src/main/ts/components/CAYCPresentation.tsx`, `Chart.tsx`, and `ChartLine.tsx`; accessible-name assertions in `src/main/ts/components/__tests__/CleanAsYouCode-test.tsx`]

The released SVG graph has no chart-level accessible name, description, table alternative, or explicit image role. The spinner has no page-specific accessible status text. These omissions are part of the observed release and must not be misrepresented as present capability. The request-failed and no-data messages are ordinary paragraphs rather than asserted live alerts. [Provenance: `src/main/ts/components/Chart.tsx` and `Spinner.tsx`]

## 9. Failure, partial-result, and recovery behavior

### 9.1 Issue request failure

If any of the 15 issue requests rejects, the plugin stops loading, discards the full aggregate, and replaces the chart with `An error occurred while fetching issue information. Please try again later.` It does not render a partial curve from successful years. There is no in-page retry control. The failure flag is not cleared by the pinned page state, and the error branch hides the selectors, so recovery requires leaving/remounting the page or reloading after the API recovers. Remount or reload also discards outstanding page-local selection aggregates, preventing an older completion from overwriting the fresh page. [Provenance: `src/main/ts/api.ts`, `src/main/ts/components/useData.ts`, `Chart.tsx`, localization bundle, and failure assertion in `src/main/ts/components/__tests__/CleanAsYouCode-test.tsx`]

A malformed successful response that lacks the expected first facet or values causes the same aggregate failure path through a rejected transformation; it does not invent zero data.

### 9.2 No data and insufficient history

If all requests produce no retained creation-date buckets, the chart stops loading and displays `There are no issues on this project.` The same applies when derived current/projection data cannot produce graph content. Period options exist only for durations shorter than the retained span; a short history can therefore offer no period option. [Provenance: `src/main/ts/components/useData.ts`, `Chart.tsx`, localization bundle, and no-data assertion in `src/main/ts/components/__tests__/CleanAsYouCode-test.tsx`]

### 9.3 Project lookup failure

If project search fails, the host global-error mechanism receives the error and the project API helper returns an empty option list. The current chart remains based on its existing project selection; the plugin does not replace it with unauthorized or fabricated projects. Reopening or typing in the selector after API recovery performs another debounced lookup according to the selector's cache behavior. [Provenance: `src/main/ts/api.ts` and `src/main/ts/components/Chart.tsx`]

### 9.4 Plugin or host failure

If the plugin is not loaded or page registration fails, the host has no `cayc/stats` navigation entry and `/extension/cayc/stats` is not a functioning page. If its frontend asset cannot load, the host extension surface cannot render the statistics. Recovery is plugin/server repair followed by page reload; there is no offline or server-side fallback rendering.

## 10. Security and trust boundaries

The browser trusts only same-origin API responses after the server applies session and project visibility rules. Project names and issue facet data are display/data inputs, not authorization. A user may select only a key returned through allowed project discovery or manually manipulate a request, but `/api/issues/search` must independently enforce visibility. Hidden projects must not contribute through this plugin unless the calling user is authorized to search their issues.

The plugin receives no password, token value, source code, issue message, comment, or raw file content. It sends a project key and project-name search expression to existing APIs. Authentication cookies, CSRF protection, request validation, API query grammar, response escaping, rate limits, and audit behavior belong to the host contracts. The client-side projection must never be treated as security, compliance, quality-gate, or historical evidence because it is a fixed hypothetical model computed from current unresolved issue facets.

## 11. Compatibility and limits

The plugin descriptor declares SonarQube minimum version 8.9. Its published build uses Sonar plugin API `9.17.0.587`, Java release 11, and host-provided plugin API at runtime. The target bundled combination is Community Build `26.8.0.126808`; compatibility beyond the descriptor is not asserted. [Provenance: published POM and plugin metadata]

The query horizon is fixed at 15 yearly windows. Only unresolved `BUG` and `VULNERABILITY` types contribute. Security Hotspots, Code Smells, accepted/resolved issues, issue transitions over time, issues outside the returned facet range, and deleted housekeeping data are not modeled. The projection rate is fixed at 20% per year and is not calibrated from the project. It does not model issue creation after the selected start, actual fixes, rule/profile changes, analyzer upgrades, project versions, quality-gate conditions, or new-code definitions. Date-only requests and browser date parsing inherit host API and browser calendar behavior.

The project list and issue facets inherit server permission, pagination, search, retention, and size limits. The page offers no export, API of its own, durable snapshot, comparison between two projects, custom date range, custom decay rate, or commercial analytics.

## 12. Acceptance scenarios

1. **Page registration.** Given Community Build has loaded plugin `cayc`, opening the global extension navigation exposes `Focusing on new code`; selecting it mounts `/extension/cayc/stats` and shows the introduction and chart card. With the plugin absent, no such registered page is available.
2. **All-project request set.** Given no project selection, mounting the page sends 15 issue searches covering consecutive one-year windows with `types=BUG,VULNERABILITY`, `resolved=false`, and `facets=createdAt`, without `components` or `componentKeys`. It waits for every request before rendering a curve.
3. **Project filter.** Given project search returns key `sample` with visible name `Sample`, selecting `Sample` repeats all 15 issue searches and sends both `components=sample` and `componentKeys=sample`. Clearing the selector restores `all projects` and repeats requests without either project parameter.
4. **Cumulative current state.** Given chronological retained facet buckets with counts 2, 3, and 5, the visible current series values are 2, 5, and 10 and the final Current state is 10 issues. Counts from leading all-zero yearly windows do not create earlier graph points.
5. **Projection calculation.** Given a retained starting point of 1000 issues and a projected point 12 months later, the projected value at that later point is 800. At 6 months it is the nearest whole number to $1000 \times 0.8^{1/2}$. No server mutation or metric is emitted.
6. **Available periods and default.** Given retained history strictly longer than 5 years but not strictly longer than 10, options through 5 years are offered and 5 years is selected by default. A duration exactly equal to the chart span is not offered.
7. **Period-only interaction.** Given a loaded graph, changing Period recomputes projection start, projected curve, projected final count, and “fewer bugs and vulnerabilities” without issuing another issue or project API request.
8. **No data.** Given every yearly facet result is empty, loading ends and `There are no issues on this project.` is shown. No zero-valued graph or unsupported policy conclusion is displayed.
9. **One yearly request fails.** Given 14 yearly searches succeed and one rejects, no partial history is rendered. The request-failed message replaces the chart controls. After API recovery, reloading/remounting the page starts a fresh 15-request aggregate.
10. **Project search fails.** Given issue data is already displayed and project lookup rejects, the host receives a global error and no unauthorized/fabricated options are shown; existing chart data remains tied to the current selection.
11. **Accessible controls and results.** Given chart data, accessibility inspection finds controls named `Project` and `Period`, excludes the illustration and arrow as decorative, and can read Current state, Focus on new code, both issue counts, and the savings sentence. It does not expect an accessible chart description or named spinner that the release does not provide.
12. **Policy ownership.** Given an administrator changes the project's new-code definition or quality gate, the plugin neither writes nor overrides either setting. It continues to query current unresolved Bugs and Vulnerabilities and applies the same fixed hypothetical decay model. Actual project policy remains visible and enforceable only through project configuration and analysis-result contracts.
13. **Bounded type scope.** Given unresolved Bugs, Vulnerabilities, Code Smells, and Security Hotspots exist, only Bug and Vulnerability facet counts affect both curves. The page does not imply that omitted finding types were fixed or policy-compliant.
14. **Missing selected month.** Given the chosen historical start month has no retained facet point, the released fallback uses the first retained count as decay baseline and emits only the final retained date in the projection series. It does not synthesize missing monthly points.
15. **Overlapping project selections.** Given the user selects project A and then project B before A's 15-request aggregate settles, both aggregates continue. If B completes and then A completes, A's older result overwrites the B chart. If A instead fails after B succeeds, the sticky request-failed state replaces the B chart. Reloading or leaving and remounting the page after selections settle starts fresh state without those outstanding page-local aggregates.

## 13. Provenance index

### Immutable artifact and release evidence

- Maven artifact, POM, checksum, and metadata: `https://repo1.maven.org/maven2/org/sonarsource/plugins/cayc/sonar-cayc-plugin/2.6.0.3665/`.
- SonarQube Community Build tag `26.8.0.126808`, commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`: root dependency version and `sonar-application/bundled_plugins.gradle`.
- Source tag `2.6.0.3665`, commit `55c5ecf4a75806328950c2526ed2660a69e5376b` at `https://github.com/SonarSource/sonar-cayc-stats-plugin/tree/2.6.0.3665`.

### Pinned source paths

- Identity and registration: `pom.xml`, `LICENSE`, `src/main/java/org/sonar/plugin/cayc/CleanAsYouCodePlugin.java`, and `CAYCPageDefinition.java`.
- Browser entry and localization: `src/main/ts/stats.tsx` and `src/main/resources/org/sonar/l10n/cayc.properties`.
- API contract: `src/main/ts/api.ts`.
- Constants and data lifecycle: `src/main/ts/constants.ts`, `src/main/ts/components/useData.ts`, and `src/main/ts/components/utils.ts`.
- Presentation and accessibility: `src/main/ts/components/CleanAsYouCode.tsx`, `CAYCPresentation.tsx`, `Chart.tsx`, `ChartLine.tsx`, `ChartVerticalLabel.tsx`, `ChartVerticalMarker.tsx`, `Line.tsx`, `VerticalLine.tsx`, and `Spinner.tsx`.
- Behavioral evidence: `src/main/ts/components/__tests__/CleanAsYouCode-test.tsx`, `utils-test.ts`, `src/bbt/java/org/sonar/plugin/cayc/bbt/CAYCChartDataBBT.java`, and `src/test/java/org/sonar/plugin/cayc/CAYCPageDefinitionTest.java`.

### Official Community Build policy documentation

- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/about-new-code.md`
- `https://docs.sonarsource.com/sonarqube-community-build/project-administration/adjusting-analysis/configuring-new-code-calculation.md`
- `https://docs.sonarsource.com/sonarqube-community-build/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/issues/retrieving.md`

These official pages establish policy and issue-search context only. The pinned plugin commit establishes page-specific statistics behavior.
