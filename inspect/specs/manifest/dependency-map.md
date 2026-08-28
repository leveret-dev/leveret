# Specification Dependency and Contract Map

## Contract Owners

| Contract | Owner | Main consumers |
|---|---|---|
| Process identifiers, lifecycle states, readiness, IPC, restart and shutdown | `platform/process-runtime/` | Persistence, search, HTTP API, compute engine, operators |
| Relational schema, transactions, persistence aggregates and migration state | `platform/persistence/` | All stateful platform parts |
| Plugin descriptors, extension lifecycle, compatibility and isolation | `platform/plugin-extension-runtime/` | Scanner gateway, compute engine, project configuration, every analyzer and integration plugin |
| Scanner bootstrap, cache, report/protobuf format, upload and acknowledgement | `platform/scanner-gateway/` | Scanner engine, compute engine, analyzers |
| Compute task queue, ordered report processing and task results | `platform/compute-engine/` | Scanner gateway, analysis results, search, events, telemetry |
| Search indexes, mappings, documents, synchronization and permission filtering | `platform/search-indexing/` | Project configuration, analysis results, HTTP API |
| Credentials, sessions, CSRF and authorization decisions | `platform/identity-access/` | HTTP API, project configuration, analysis results, provider integrations, web UI |
| Project, component, rule, profile, gate, metric and setting identifiers and precedence | `platform/project-configuration/` | Analyzers, compute engine, analysis results, web UI |
| Issue, hotspot, measure, source, duplication and history states | `platform/analysis-results/` | HTTP API, events, web UI, CAYC statistics |
| Routing, request validation, media types, errors and pagination | `platform/http-api/` | All API-producing platform parts and integrations, web UI |
| Event, notification, webhook and push envelopes and delivery state | `platform/events-notifications/` | Compute engine, analysis results, IDE clients, webhooks |
| Telemetry vocabulary, upload gating and health composition | `platform/telemetry-monitoring/` | Process runtime, compute engine, search, provider integrations, web UI |
| Browser routes and user interactions | `platform/web-ui/` | Human users; consumes platform API contracts |
| New-code and quality-gate policy | `platform/project-configuration/` | Compute engine, analysis results, CAYC statistics |
| Analyzer language recognition, rules, metrics and issue production | Each analyzer directory | Scanner engine, scanner gateway, compute engine, project configuration, analysis results |
| Coverage observations imported from JaCoCo XML | `integrations/jacoco/` | Scanner gateway, compute engine, project configuration metrics |

## Core Data Flow

1. Process runtime starts storage prerequisites, search, HTTP/web services and compute workers in required order.
2. Plugin runtime discovers bundled analyzers and integrations, validates compatibility, isolates classes and registers extensions.
3. Project configuration supplies project identity, settings, active quality profiles, active rules, new-code definitions and quality gates.
4. Scanner engine obtains bootstrap metadata through scanner gateway, indexes source files, invokes bundled analyzers and report importers, and constructs the version-coupled scanner report.
5. Scanner gateway authenticates the upload, stores report parts and submits a compute-engine task.
6. Compute engine extracts the report, validates components, tracks issues, calculates measures and duplications, evaluates the quality gate, persists results, updates search, emits events and publishes task status.
7. Analysis-results APIs expose issues, hotspots, measures, source, duplications and history under identity-access visibility rules and HTTP API conventions.
8. Events and notifications deliver email, webhooks and IDE push updates. Telemetry and monitoring observe platform health without redefining feature state.
9. Web UI and CAYC statistics consume APIs; they do not redefine service contracts.

## Analyzer Relationships

- Java symbolic execution requires the Java analyzer and adds a separate path-sensitive rule engine; Java owns parsing, semantic models and common metrics.
- Java's JSP adapter is bundled but inactive in Community Build. It owns no independent rule or metric catalog.
- JavaScript, TypeScript, CSS and embedded Web/YAML share one SonarJS runtime artifact. Each specification owns its externally visible language repository while referencing shared bridge and result behavior.
- Embedded Web/YAML projects issues from extracted JavaScript or CSS fragments. HTML and IaC analyzers retain host-file metrics, highlighting and general host-language rules.
- C# and VB.NET share one .NET analyzer family and Roslyn packaging/report contracts.
- Ruby and Scala have separate plugin repositories and rule catalogs but consume common SLang engine `1.21.0.8303` behavior.
- Infrastructure as Code is one artifact with ARM, CloudFormation, Dockerfile, Kubernetes/Helm, Terraform and JVM framework configuration sections. Enterprise IaC extensions are excluded.
- Text and secrets share one content-scanning artifact over indexed textual files. Commercial pattern extensions are excluded.
- JaCoCo imports coverage only; it defines no rules or metric identifiers.

## Integration Relationships

- GitHub, GitLab and Bitbucket integrations depend on identity-access for session creation and authorization, project configuration for provisioning/import, HTTP API for transport, and telemetry for provider metrics.
- Azure DevOps integration provides ALM validation and import but no identity-provider module in this release.
- LDAP and SAML own external protocol behavior; identity-access owns local users, sessions, groups and permissions created from their results.
- Scanner engine consumes plugin-extension and project-configuration metadata, executes analyzers, and produces scanner-gateway reports.
- CAYC statistics consumes project and issue search APIs; project configuration owns actual Clean as You Code policy.

## Non-Ownership Rules

- Specifications must reference these owners rather than restating shared wire formats or state machines.
- An analyzer owns only language-specific computation. Platform metric keys, persistence, profile activation and issue lifecycle remain platform contracts.
- An integration owns external protocol behavior. Generic authentication, authorization, HTTP and project lifecycle remain platform contracts.
- Third-party runtimes are dependencies, not Sonar parts. Sonar-facing configuration, compatibility and failure behavior remain in the consuming specification.
