# Community Build Specification Coverage Index

## Baseline

All entries target SonarQube Community Build `26.8.0.126808`, tag and commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. License and provenance details are in `release-baseline.md` and `license-map.md`.

## Coverage Summary

- Platform specifications: 14
- Analyzer specifications: 20
- Integration specifications: 8
- Total independently implementable specifications: 42
- Strong-copyleft copy markers: 0
- Unmapped bundled plugin artifacts: 0
- Component review status: all approved after source-focused correction loops; evidence is recorded in `review-report.md`.

## Platform Coverage

| Part | Specification | Covered source or artifact | Review |
|---|---|---|---|
| Process runtime | `platform/process-runtime/specification.md` | Pinned application, scheduler, process and shutdown source | Approved |
| Persistence | `platform/persistence/specification.md` | Pinned database DAO, schema, migration and profiling source | Approved |
| Plugin and extension runtime | `platform/plugin-extension-runtime/specification.md` | Pinned core/plugin runtime plus plugin API `13.8.0.4399` | Approved |
| Scanner gateway | `platform/scanner-gateway/specification.md` | Pinned scanner-facing APIs, report storage, protobuf and SARIF source | Approved |
| Compute engine | `platform/compute-engine/specification.md` | Pinned CE queue, task and project-analysis source | Approved |
| Search and indexing | `platform/search-indexing/specification.md` | Pinned Elasticsearch integration and index source | Approved |
| Identity and access | `platform/identity-access/specification.md` | Pinned authentication, session, user, group and permission source | Approved |
| Project configuration | `platform/project-configuration/specification.md` | Pinned project, rule, profile, gate, metric, settings and new-code source | Approved |
| Analysis results | `platform/analysis-results/specification.md` | Pinned issue, hotspot, measure, source, duplication and history source | Approved |
| HTTP API | `platform/http-api/specification.md` | Pinned webserver, legacy API and versioned API source | Approved |
| Events and notifications | `platform/events-notifications/specification.md` | Pinned event, notification, email, webhook and IDE push source | Approved |
| Telemetry and monitoring | `platform/telemetry-monitoring/specification.md` | Pinned telemetry, health, system-information and monitoring source | Approved |
| Web UI | `platform/web-ui/specification.md` | Exact `webapp-assets:2026.5.0.65571` released artifact and corroborating public source | Approved |
| Clean as You Code statistics | `platform/clean-as-you-code-statistics/specification.md` | CAYC statistics plugin `2.6.0.3665`, commit `55c5ecf4a75806328950c2526ed2660a69e5376b` | Approved |

## Analyzer Coverage

| Bundled artifact or exposed analyzer | Specification | Exact release basis | Review |
|---|---|---|---|
| C# and VB.NET `10.31.0.145097` | `analyzers/dotnet/specification.md` | Tagged `SonarSource/sonar-dotnet` source | Approved |
| Flex `2.18.0.6281` | `analyzers/flex/specification.md` | Tagged `SonarSource/sonar-flex` source | Approved |
| Go `1.40.0.6765` | `analyzers/go/specification.md` | Immutable Maven source artifact; release-boundary commit corroboration | Approved |
| HTML `3.30.0.8241` | `analyzers/html/specification.md` | Tagged `SonarSource/sonar-html` source | Approved |
| Java `8.37.0.45887` | `analyzers/java/specification.md` | Tagged `SonarSource/sonar-java` source | Approved |
| Community-inactive JSP Java adapter | `analyzers/jsp-java-embedding/specification.md` | Same exact Java artifact and source | Approved |
| Java symbolic execution `8.16.4.1912` | `analyzers/java-symbolic-execution/specification.md` | Tagged symbolic-execution source | Approved |
| JavaScript exposed by multi plugin `13.4.0.43982` | `analyzers/javascript/specification.md` | Tagged `SonarSource/SonarJS` source | Approved |
| TypeScript exposed by same multi plugin | `analyzers/typescript/specification.md` | Same exact SonarJS source | Approved |
| CSS, Less, SCSS and Sass exposed by same multi plugin | `analyzers/css/specification.md` | Same exact SonarJS source | Approved |
| Embedded Web and YAML extraction from same multi plugin | `analyzers/embedded-web-yaml/specification.md` | Same exact SonarJS source | Approved |
| PHP `3.60.0.16641` | `analyzers/php/specification.md` | Tagged `SonarSource/sonar-php` source | Approved |
| Python and Jupyter `5.27.0.35548` | `analyzers/python/specification.md` | Immutable Maven source artifacts; release-boundary commit corroboration | Approved |
| Kotlin `3.7.0.9514` | `analyzers/kotlin/specification.md` | Tagged `SonarSource/sonar-kotlin` source | Approved |
| Ruby `1.24.0.2550` | `analyzers/ruby/specification.md` | Tagged Ruby source plus exact SLang artifacts | Approved |
| Rust `1.8.0.3284` | `analyzers/rust/specification.md` | Tagged Rust source | Approved |
| Scala `1.24.0.2554` | `analyzers/scala/specification.md` | Tagged Scala source plus exact SLang artifacts | Approved |
| XML `2.18.0.7959` | `analyzers/xml/specification.md` | Tagged XML source | Approved |
| Infrastructure as Code `2.13.0.21933` | `analyzers/infrastructure-as-code/specification.md` | Immutable Maven source artifact | Approved |
| Text and secrets `2.47.0.11983` | `analyzers/text-and-secrets/specification.md` | Immutable Maven source artifact | Approved |

## Integration Coverage

| Integration | Specification | Exact release basis | Review |
|---|---|---|---|
| Community scanner engine `13.5.0.4089` | `integrations/scanner-engine/specification.md` | Immutable Maven source artifact; POM-declared unavailable SCM URL recorded | Approved |
| JaCoCo XML importer `1.6.0.5741` | `integrations/jacoco/specification.md` | Tagged JaCoCo plugin source | Approved |
| GitHub | `integrations/github/specification.md` | Pinned Community platform source | Approved |
| GitLab | `integrations/gitlab/specification.md` | Pinned Community platform source | Approved |
| Bitbucket Cloud and Server | `integrations/bitbucket/specification.md` | Pinned Community platform source | Approved |
| Azure DevOps | `integrations/azure-devops/specification.md` | Pinned Community platform source | Approved |
| LDAP and Active Directory | `integrations/ldap-authentication/specification.md` | Pinned Community platform source | Approved |
| SAML | `integrations/saml-authentication/specification.md` | Pinned platform source and exact Spring Security/OpenSAML dependencies | Approved |

## Bundled Artifact Reconciliation

The 19 entries in `sonar-application/bundled_plugins.gradle` map as follows:

- C# and VB.NET map jointly to the .NET specification.
- Flex, Go, HTML, PHP, Python, Kotlin, Ruby, Rust, Scala, XML, IaC and Text each map to their named analyzer specification.
- Java core, Java symbolic execution and JaCoCo map to separate Java, symbolic-execution and JaCoCo specifications.
- JavaScript multi maps to JavaScript, TypeScript, CSS and embedded Web/YAML specifications because one artifact exposes four independently visible contracts.
- CAYC maps to the Clean as You Code statistics platform specification; it is not an analyzer.

No bundled plugin is omitted or multiply owned. Multiple specifications for one multi-language artifact divide externally visible contracts and reference one shared runtime owner rather than claiming duplicate artifact ownership.

## Excluded Distribution Material

Commercial `com.sonarsource.*` artifacts, example/test plugins, test harnesses, build machinery, CI, packaged third-party implementations and standalone scanner launchers are excluded for reasons recorded in `component-inventory.md`. Sonar-facing compatibility behavior remains covered by the consuming part.
