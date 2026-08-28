# Community Build Component Inventory

## Inventory Basis

This inventory targets SonarQube Community Build `26.8.0.126808` at commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. Runtime plugin inclusion comes from `sonar-application/bundled_plugins.gradle`; exact artifact versions come from root `build.gradle` and `gradle.properties`.

The inventory groups source modules by independently implementable behavior. It does not mirror incidental Gradle project boundaries.

## Platform Parts

| Part | Output directory | Primary source or artifact | Responsibility |
|---|---|---|---|
| Process runtime | `platform/process-runtime/` | SonarQube tag `26.8.0.126808`: `sonar-application`, `server/sonar-main`, `server/sonar-process`, `sonar-shutdowner` | Installation configuration, process startup ordering, readiness, process IPC, restart, shutdown, logging, and operator launch behavior. |
| Persistence | `platform/persistence/` | Same tag: `server/sonar-db-dao`, `server/sonar-db-migration`, `server/sonar-db-profiling` | Database compatibility, schema, transactions, persistence aggregates, migrations, and profiling. |
| Plugin and extension runtime | `platform/plugin-extension-runtime/` | Same tag: `sonar-core`, `sonar-plugin-api-impl`, server extension/plugin packages; plugin API `13.8.0.4399` | Extension discovery, plugin loading and isolation, compatibility checks, lifecycle, settings bridges, and installation state. |
| Scanner gateway | `platform/scanner-gateway/` | Same tag: `sonar-ws`, `sonar-sarif`, scanner-facing web APIs and CE report storage | Scanner bootstrap, active-rule and plugin metadata, report upload, report parts, scanner cache, SARIF, protobuf and HTTP compatibility. |
| Compute engine | `platform/compute-engine/` | Same tag: `server/sonar-ce*`, `sonar-duplications` | Durable task queue, worker lifecycle, report processing, component validation, measures, issue tracking, duplication, quality-gate evaluation, persistence, indexing, events, and task results. |
| Search and indexing | `platform/search-indexing/` | Same tag: `server/sonar-webserver-es` and index packages | Index lifecycle, mappings, documents, synchronization, permissions, filtered search, facets, and statistics. |
| Identity and access | `platform/identity-access/` | Same tag: authentication, user, group, session, permission, and security packages | Authentication dispatch, tokens, cookies, sessions, CSRF, users, groups, roles, permission templates, visibility, and authorization precedence. |
| Project configuration | `platform/project-configuration/` | Same tag: project, component, rule, profile, gate, metric, settings, new-code and permission packages | Project lifecycle, stable identifiers, rule repositories, profiles, active rules, metrics, quality gates, settings, new-code periods, and administration. |
| Analysis results | `platform/analysis-results/` | Same tag: state machine, issue, hotspot, measure, source, duplication, and history packages | Issue and hotspot workflows, measures, source presentation, duplications, analysis history, comments, assignments, transitions, badges, and result visibility. |
| HTTP API | `platform/http-api/` | Same tag: embedded webserver and Web API modules | HTTP startup modes, routing, legacy and versioned APIs, validation, serialization, errors, pagination, filters, headers, health endpoints, and endpoint registration. |
| Events and notifications | `platform/events-notifications/` | Same tag: events, push API, notification, email, and webhook packages | Cross-process events, notification selection, email, webhooks, IDE push connections, polling, delivery state, and purge. |
| Telemetry and monitoring | `platform/telemetry-monitoring/` | Same tag: telemetry and monitoring modules | Telemetry opt-out and upload lifecycle, metric vocabulary, health aggregation, system information, uptime, and operational monitoring. |
| Web UI | `platform/web-ui/` | `org.sonarsource.sonarqube:webapp-assets:2026.5.0.65571`; repository `SonarSource/sonarqube-webapp` | Browser routes and interactions for authentication, administration, projects, results, issues, hotspots, profiles, gates, monitoring, and integrations. Exact Git commit is not published; immutable released artifact is authoritative. |
| Clean as You Code statistics | `platform/clean-as-you-code-statistics/` | `org.sonarsource.plugins.cayc:sonar-cayc-plugin:2.6.0.3665`; `SonarSource/sonar-cayc-stats-plugin`, tag `2.6.0.3665`, commit `55c5ecf4a75806328950c2526ed2660a69e5376b` | Historical issue statistics page. It does not own new-code or quality-gate policy. |

## Bundled Analyzer Parts

| Part | Output directory | Bundled artifact and version | Source provenance | Language or format ownership |
|---|---|---|---|---|
| .NET | `analyzers/dotnet/` | C# and VB.NET plugins `10.31.0.145097` | `SonarSource/sonar-dotnet`, tag `10.31.0.145097`, commit `64d936d2b2e0bf75e82bba15a8ed54881e8749c3` | C#, VB.NET, shared Roslyn engine, rules, metrics, coverage and external-report imports. |
| Flex | `analyzers/flex/` | Flex plugin `2.18.0.6281` | `SonarSource/sonar-flex`, matching tag, commit `84cf021e37206d01e7f04ffe7172c40d0ee8ad85` | ActionScript `.as`; MXML is skipped. |
| Go | `analyzers/go/` | Go plugin `1.40.0.6765` | `SonarSource/sonar-go`; exact Maven source artifact. Candidate release-boundary commit `ba90d496cc57d793b867a82ff656a51fc7993735`; no matching public tag. | Go parsing, semantic/import behavior, rules, metrics, CPD, native parser binaries, and external-rule mapping. |
| HTML | `analyzers/html/` | HTML plugin `3.30.0.8241` | `SonarSource/sonar-html`, matching tag, commit `bea5cf6e3c328ae7ab55de591c8b02df0c2ad491` | HTML, JSP and listed HTML-bearing template suffixes; rules, accessibility, measures, highlighting and CPD. |
| Java | `analyzers/java/` | Java plugin `8.37.0.45887` | `SonarSource/sonar-java`, matching tag, commit `53f70bdf0f34a64bfe97b71f1bfee07e6d14baa6` | Java parsing, bytecode/classpath semantics, rules, profiles, metrics, highlighting, CPD, test reports and external issue reports. |
| Inactive JSP-to-Java adapter | `analyzers/jsp-java-embedding/` | Inseparable Java plugin content | Same Java provenance | JSP transpilation contract and explicit Community Build inactivity. No independent rules or metrics. |
| Java symbolic execution | `analyzers/java-symbolic-execution/` | Symbolic execution plugin `8.16.4.1912` | `SonarSource/sonar-java-symbolic-execution`, matching tag, commit `8d1b73d26c83a998d7af4e4a8f10587654f2e12c` | Path-sensitive Java execution engine and its 23 registered rules. |
| JavaScript | `analyzers/javascript/` | JavaScript multi plugin `13.4.0.43982` | `SonarSource/SonarJS`, matching tag, commit `d02b514f8007f18a798876fc9361b9c233ab2f02` | JavaScript, JSX, module variants and Vue script content; rules, quick fixes, metrics, LCOV and ESLint import. |
| TypeScript | `analyzers/typescript/` | Same JavaScript multi plugin | Same SonarJS provenance | TypeScript and TSX variants, project configuration and type information, shared rules and metrics. |
| CSS | `analyzers/css/` | Same JavaScript multi plugin | Same SonarJS provenance | CSS, Less, SCSS and Sass, including embedded style content; CSS rules, parse errors, highlighting and Stylelint import. |
| Embedded Web and YAML | `analyzers/embedded-web-yaml/` | Same JavaScript multi plugin | Same SonarJS provenance | Extraction and issue projection for embedded JavaScript/CSS in HTML, Vue and selected YAML templates; no host metrics. |
| PHP | `analyzers/php/` | PHP plugin `3.60.0.16641` | `SonarSource/sonar-php`, matching tag, commit `1edd16ff3f12c7a39d28eb61ee8b1b3ea4c3e875` | PHP through 8.4, syntax and semantic model, rules, metrics, reports and custom-rule API. |
| Python | `analyzers/python/` | Python plugin `5.27.0.35548` | `SonarSource/sonar-python`; exact Maven source artifact. Candidate release-boundary commit `2c3590318c644163418f82b57341a21ac1b5cb99`; no matching public tag. | Python and Jupyter notebooks, parsing, semantics, rules, metrics, reports and indexing. |
| Kotlin | `analyzers/kotlin/` | Kotlin plugin `3.7.0.9514` | `SonarSource/sonar-kotlin`, matching tag, commit `facf0e04ee5be1b19967968ed1f98734e6d773ff` | Kotlin and Kotlin Gradle DSL behavior, compiler-backed semantics, rules, metrics, reports and external linters. |
| Ruby | `analyzers/ruby/` | Ruby plugin `1.24.0.2550` | `SonarSource/sonar-ruby`, matching tag, commit `406444ea31e5724951252db4bb87a74a69893dae` | Ruby, SLang conversion, rules, metrics, test exclusions, SimpleCov and RuboCop import. |
| Rust | `analyzers/rust/` | Rust plugin `1.8.0.3284` | `SonarSource/sonar-rust`, matching tag, commit `2cd44039c36a7f0f17bddc9fce6359876bd1bdc1` | Rust, native parser, rules, metrics, Cargo discovery, Clippy and coverage imports. |
| Scala | `analyzers/scala/` | Scala plugin `1.24.0.2554` | `SonarSource/sonar-scala`, matching tag, commit `f8e0a83baf34dbe3fb8313eca792f0abd6e47ff5` | Scala, SLang conversion, rules, metrics, tests, Scoverage, Scalastyle and Scapegoat import. |
| XML | `analyzers/xml/` | XML plugin `2.18.0.7959` | `SonarSource/sonar-xml`, matching tag, commit `793fbcea0c1e65caa6afe5b3a4b5dd04c0c4d945` | XML, XSD, XSL and configuration XML; rules, parse errors, measures and highlighting. |
| Infrastructure as Code | `analyzers/infrastructure-as-code/` | IaC plugin `2.13.0.21933` | `SonarSource/sonar-iac`; exact Maven source archive SHA-256 `310503bc261339a90c283c5c6e4fe218d017ab948e12a3b4221630b62d5f0b7e`; no matching public tag. | ARM JSON/Bicep, CloudFormation JSON/YAML, Dockerfile, Kubernetes/Helm, Terraform HCL, and JVM framework configuration. |
| Text and secrets | `analyzers/text-and-secrets/` | Text plugin `2.47.0.11983` | `SonarSource/sonar-text`; exact Maven source archive SHA-256 `de760fdca4ec1d30cb5195e5fd90c51ed364c8dcc0f64fe826099dfafd2f8d46`; no matching public tag. | Unicode-security and public secret/token detection over indexed textual files. |

## Bundled and Embedded Integrations

| Part | Output directory | Source | Responsibility |
|---|---|---|---|
| Scanner engine | `integrations/scanner-engine/` | `sonar-scanner-engine-community:13.5.0.4089`; `SonarSource/sonar-scanner-engine`; exact source artifact SHA-256 `e29ebcc0e7102825dfa0990dbb0cb403031570913966c058d6f6253f7c8c9564` | Server-directed checkout analysis, plugin execution, configuration, cache interaction, report construction and upload. Standalone launcher products are not bundled. |
| JaCoCo importer | `integrations/jacoco/` | `SonarSource/sonar-jacoco`, tag `1.6.0.5741`, commit `d7ac50ea711e3321dabc2e4fbb7edf757507f892` | Ordinary and aggregate JaCoCo XML import for JVM languages; source mapping and line/branch coverage observations. |
| GitHub | `integrations/github/` | Pinned SonarQube source | OAuth, GitHub App credentials and tokens, organization/team/repository access, provisioning, import and metrics. |
| GitLab | `integrations/gitlab/` | Pinned SonarQube source | OAuth, REST/GraphQL identity and membership, project import, validation and metrics. |
| Bitbucket | `integrations/bitbucket/` | Pinned SonarQube source | Bitbucket Cloud and Server authentication, workspaces/projects/repositories, import, validation and metrics. |
| Azure DevOps | `integrations/azure-devops/` | Pinned SonarQube source | Credential validation, project/repository enumeration and import, and provider metrics. |
| LDAP | `integrations/ldap-authentication/` | Pinned SonarQube source | LDAP/Active Directory connections, bind authentication, searches, user details, groups and Kerberos configuration. |
| SAML | `integrations/saml-authentication/` | Pinned SonarQube source | Relying-party configuration, signing/encryption material, requests, responses, replay handling, identity mapping and redirects. |

## Explicit Exclusions

- Commercial and private artifacts under `com.sonarsource.*` are not bundled by Community Build's `bundled_plugins.gradle` and are excluded.
- Example, education and test-only plugins are excluded as products; tests remain valid evidence for observable contracts.
- Test harnesses, build logic, CI, formatting, packaging mechanics and code generators are excluded except where they establish a public wire contract.
- Third-party implementations such as Elasticsearch, JREs, JDBC drivers, WinSW and JaCoCo itself are not re-specified. Sonar-facing configuration and interoperability remain in scope.
- Standalone Scanner CLI, Maven, Gradle, .NET and NPM launchers are not bundled in this distribution. Only the embedded Community scanner engine is in scope.
- Commercial extensions for IaC, Text, Python, Go and other analyzers must not expand Community Build capability claims.
