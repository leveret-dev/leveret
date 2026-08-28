# Project Configuration Specification

## 1. Pinned identity and license

This specification describes project configuration in SonarQube Community Build `26.8.0.126808`, published 2026-08-05 from `SonarSource/sonarqube` tag `26.8.0.126808` at commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The platform production source is licensed `LGPL-3.0-or-later` under the pinned tree's `LICENSE.txt` and `HEADER.spotless`. The exact public metric definitions consumed by this release come from LGPL-licensed `org.sonarsource.api.plugin:sonar-plugin-api:13.8.0.4399`.

## 2. Purpose, scope, and ownership

This part owns project and component identity, project lifecycle and visibility configuration, registered rule repositories and rules, quality profiles, active rules, metric registration, quality gates, settings, new-code periods, and the precedence rules that select the effective configuration for an analysis.

It does not own language-specific rule detection, analyzer-produced measures, scanner transport, compute task execution, issue lifecycle, or generic HTTP routing. Analyzer specifications own their rule catalogs and analyzer-specific metrics; this part owns how those definitions are registered, selected, activated, parameterized, and exposed. `platform/identity-access/` owns the permission decision used by every operation. `platform/compute-engine/` owns application of the selected configuration to a submitted report. `platform/persistence/`, `platform/search-indexing/`, and `platform/http-api/` own storage, indexes, and transport conventions respectively. [Provenance: `manifest/dependency-map.md`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/`; `server/sonar-server-common/src/main/java/org/sonar/server/`]

## 3. Stable identifiers and component model

### 3.1 Projects and components

Every project has an immutable internal UUID and a mutable public key. A key may be at most 400 characters and may contain alphanumeric characters, `-`, `_`, `.`, and `:`, with at least one non-digit. A project name is limited to 500 characters; the legacy create API abbreviates a longer requested name to this limit. Project visibility is `public` or `private`. A project owns a main branch and may own additional branch component trees where supported by the submitted analysis contract. Changing a public key must preserve UUID-based associations and update descendant public component keys.

Component qualifier identifiers are `TRK` for project, deprecated `BRC` for module, `DIR` for directory, `FIL` for ordinary file, and `UTS` for unit-test file. Shared source also defines `APP`, `VW`, and `SVW`; this Community specification does not infer commercial application or portfolio creation behavior from those constants. Component scope identifiers are `PRJ`, `DIR`, and `FIL`. A branch component has its own UUID, while permission, profile, gate, setting, and project identity resolve through the owning project UUID. [Provenance: `sonar-core/src/main/java/org/sonar/core/component/ComponentKeys.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/component/ComponentValidator.java`; `ComponentQualifiers.java`; `ComponentScopes.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/component/ComponentFinder.java`]

### 3.2 Rules, profiles, metrics, gates, and settings

- A rule's compatibility key is `repositoryKey:ruleKey`. Rules also have immutable internal UUIDs and may retain deprecated key aliases after a rename.
- A quality profile has an internal UUID/key, name, language key, built-in flag, optional parent profile, and timestamps. Name plus language identifies the user-facing profile choice.
- An active rule has its own UUID and binds exactly one rule to one quality profile, with effective legacy severity, impacts, prioritized flag, and parameter values.
- A metric has an internal UUID and public key, value type, direction, qualitative/hidden flags, optional best/worst values, and domain.
- A quality gate has an internal UUID and name. A condition has an internal UUID, metric UUID/key, operator, and error threshold.
- A setting is identified by its public key and optional project UUID. Definitions may declare defaults, scope, qualifiers, data type, multiple values, property-set fields, options, visibility, and secrecy.
- A new-code record is identified by level: global, project, or project branch. It contains a type, optional value, update time, and optional prior noncompliant value.

[Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/rule/RuleDto.java`; `qualityprofile/QProfileDto.java`; `metric/MetricDto.java`; `qualitygate/QualityGateDto.java`; `QualityGateConditionDto.java`; `newcodeperiod/NewCodePeriodDto.java`]

## 4. Project and component lifecycle

### 4.1 Creation

`POST api/projects/create` requires global `provisioning`. Inputs are required project key and name, with optional `mainBranch`, `visibility`, `newCodeDefinitionType`, and `newCodeDefinitionValue`. When no main branch is supplied, the configured effective default branch name is used. When no visibility is supplied, the global default project visibility is used. That default is the internal database property `projects.default.visibility`, initialized to `public`; it is not a `sonar.properties`/ordinary settings key. A system administrator changes it with internal `POST api/projects/update_default_visibility` and required `projectVisibility` value. `sonar.projectCreation.mainBranchName` supplies the main-branch default, which is `main` when unchanged.

Creation allocates project and main-branch identities, applies the matching/default permission template, optionally persists a new-code definition, commits the relational aggregate, and indexes the new entity. A project key collision, invalid key, conflicting permission-template patterns, invalid visibility, or invalid new-code pair aborts the creation rather than leaving a partially configured project. Projects hosted on a DevOps platform are expected to use the owning integration's import endpoint so provider binding is created consistently; provider protocol behavior is out of scope here. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/project/ws/CreateAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/project/ws/UpdateDefaultVisibilityAction.java`; `server/sonar-webserver-api/src/main/java/org/sonar/server/project/ProjectDefaultVisibility.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/PopulateInitialSchema.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/component/ComponentUpdater.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/permission/PermissionTemplateService.java`; `server/sonar-server-common/src/main/java/org/sonar/server/project/DefaultBranchNameResolver.java`]

### 4.2 Rename, visibility, and deletion

`POST api/projects/update_key` requires project `admin`, changes the public project key, and changes all descendant component keys while preserving internal UUIDs and UUID-based associations. Key update fails on invalid or colliding target keys.

`POST api/projects/update_visibility` requires administration and changes project, branch, and component visibility together. It is rejected while ordinary background tasks for the project are pending or running and when the project is externally managed. Public-to-private and private-to-public permission effects are defined by `platform/identity-access/`. The relational change and `es_queue` recovery rows commit together; indexing occurs afterward and may be temporarily stale if Elasticsearch fails, until queued recovery succeeds.

`POST api/projects/delete` and `bulk_delete` require the applicable administrative permission and remove the project aggregate through the component-cleaning service, including project-scoped configuration and search documents. Missing project or insufficient permission fails without deleting an unrelated project. Externally managed status does not itself block deletion or key update in the pinned actions. Analysis task/report lifecycle during deletion is owned by the compute-engine and scanner-gateway specifications. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/project/ws/UpdateKeyAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/project/ws/UpdateVisibilityAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/project/ws/DeleteAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/project/ws/BulkDeleteAction.java`; `server/sonar-server-common/src/main/java/org/sonar/server/project/VisibilityService.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/component/ComponentCleanerService.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/IndexersImpl.java`]

### 4.3 Discovery APIs

The pinned production registry exposes exactly nine `api/projects` actions: `bulk_delete`, `create`, `delete`, `search`, `search_my_projects`, `search_my_scannable_projects`, `update_default_visibility`, `update_key`, and `update_visibility`. `search_my_projects`, `search_my_scannable_projects`, and `update_default_visibility` are internal actions. The other actions are public unless their own current metadata says otherwise; parameter-level internal flags do not make the whole action internal. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/project/ws/ProjectsWsModule.java`; the nine registered action classes in the same directory]

The component controller `api/components` exposes `app`, `search`, `search_projects`, `show`, `suggestions`, and `tree`. These APIs return only components allowed by identity-access visibility. Tree navigation accepts a base component and ancestor/descendant strategy, qualifiers, and paging as declared by its action metadata. Component lookup must distinguish immutable UUID from mutable key and must not leak the existence of a private project to an unauthorized caller. [Provenance: `sonar-ws-generator/src/main/resources/snapshot-of-api.json`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/project/ws/`; `component/ws/`]

## 5. Rule registration and rule state

### 5.1 Public rule vocabulary

Rule status identifiers are `BETA`, `DEPRECATED`, `READY`, and `REMOVED`. Legacy rule types are `CODE_SMELL`, `BUG`, `VULNERABILITY`, and `SECURITY_HOTSPOT`. Legacy severities are `INFO`, `MINOR`, `MAJOR`, `CRITICAL`, and `BLOCKER`. Multi-quality impacts use software qualities `MAINTAINABILITY`, `RELIABILITY`, and `SECURITY`, with severities `INFO`, `LOW`, `MEDIUM`, `HIGH`, and `BLOCKER` where the corresponding public model permits them.

Clean-code attributes are `CONVENTIONAL`, `FORMATTED`, `IDENTIFIABLE`, `CLEAR`, `LOGICAL`, `COMPLETE`, `EFFICIENT`, `FOCUSED`, `DISTINCT`, `MODULAR`, `TESTED`, `LAWFUL`, `TRUSTWORTHY`, and `RESPECTFUL`. Their public categories are `CONSISTENT`, `INTENTIONAL`, `ADAPTABLE`, and `RESPONSIBLE`. A rule can carry system tags from its analyzer and mutable user tags. Rule parameters have a name, description/type metadata, optional default, and active-rule override. [Provenance: `sonar-core/src/main/java/org/sonar/core/rule/RuleType.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/rule/enums/`; pinned Plugin API rule-model enums at tag `13.8.0.4399`]

### 5.2 Startup registration

At web-server startup, every loaded analyzer rule repository is read. Repository language is mandatory. Rule keys and deprecated aliases are checked for consistency before mutation. New definitions are inserted; existing definitions are updated; key renames preserve the internal rule identity and deprecated-key mapping. Repository metadata is inserted/updated and repositories no longer present are removed from the repository catalog.

A non-ad-hoc analyzer rule that is no longer declared is marked `REMOVED` and loses its system tags. If its repository still exists, its active-rule bindings are deleted and profile change history is recorded; when the entire repository is absent, active rules are retained for compatibility rather than being silently rewritten. Custom rules follow their template's language, configuration key, plugin, remediation defaults, status, severity, and repository. If the template disappears or is removed, the custom rule is also removed. External-rule repositories are registered for search/report mapping but do not participate in quality profiles. Database changes precede rule and active-rule index updates; index initialization is marked only after reconciliation. [Provenance: `server/sonar-webserver-core/src/main/java/org/sonar/server/rule/registration/RulesRegistrant.java`; `StartupRuleUpdater.java`; `RulesKeyVerifier.java`]

### 5.3 Rule APIs and custom rules

`api/rules` exposes `app`, `create`, `delete`, `list`, `repositories`, `search`, `show`, `tags`, and `update`. Search/show expose rule key, repository, language, status, name, descriptions, parameters, tags, clean-code attribute, impacts, legacy type/severity, template/custom relationship, and activation facets subject to action metadata.

`POST api/v2/clean-code-policy/rules` creates a custom rule and requires `profileadmin`. It accepts a custom `key` including repository, `templateKey`, name, Markdown description, optional status (default `READY`), parameters, optional clean-code attribute, required impacts, and optional legacy severity/type. Key, template key, and name are limited to 200 characters. A custom rule must use a valid rule template; duplicate keys, missing templates, invalid parameters/impacts, and non-template parents fail without partial registration. Legacy create/update/delete remain observable for compatibility. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/rule/ws/`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/rule/controller/RuleController.java`; `request/RuleCreateRestRequest.java`]

## 6. Quality profiles and active rules

### 6.1 Profile lifecycle

There is at most one effective profile per language for a project. Each installed language has a default profile. A project-language association overrides that language's default; languages without a project association continue to use their defaults. Removing an association restores default inheritance. Built-in profiles are synchronized from analyzer definitions and are read-only. A non-built-in profile may optionally inherit from a parent of the same language.

Global `profileadmin` may create, copy, import/restore, rename, delete non-default custom profiles, set defaults, and delegate edit rights. A user may edit a non-built-in profile when the user has `profileadmin`, a direct profile edit grant, or membership in a granted edit group. Built-in profiles cannot be mutated even by an administrator. Associating a profile to a project is allowed to a profile administrator or an administrator of that project. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualityprofile/ws/QProfileWsSupport.java`; `AddProjectAction.java`; `RemoveProjectAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualityprofile/builtin/`]

Profile states and transitions include create, copy, rename, set/unset parent, set default, associate/disassociate project, delegate/revoke user or group editor, backup/export, restore/import, reset to backup, and delete. Deleting a default or built-in profile is forbidden. Parent changes and rule changes propagate effective active-rule changes to descendants and are recorded in profile changelog with timestamps and actor/system attribution. Backup/restore is a configuration interchange contract, not an analyzer implementation contract.

### 6.2 Active-rule resolution

For an analysis request without a project, active-rule metadata is built from every language's default profile. For a project, the project-associated profile replaces the default for the same language; other language defaults remain. Active rules are loaded for the resulting profile UUID set. Each emitted active rule includes current rule key, deprecated keys, name, effective legacy severity, creation/update time, internal analyzer configuration key, profile key, language, optional template key, effective parameter values, and impacts.

An active-rule parameter override wins over the rule parameter default; when no override exists, the rule default wins; absent defaults are represented as empty values in the scanner-facing active-rule model. Profile inheritance determines whether an activation is inherited, overridden, or local. A child may override inherited severity/parameters where allowed; deactivation and reactivation update descendants consistently. External rules are excluded from profile activation. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/rule/ActiveRuleService.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualityprofile/QProfileRulesImpl.java`; `builtin/RuleActivator.java`]

### 6.3 Profile APIs

`api/qualityprofiles` exposes:

`activate_rule`, `activate_rules`, `add_group`, `add_project`, `add_user`, `backup`, `change_parent`, `changelog`, `compare`, `copy`, `create`, `deactivate_rule`, `deactivate_rules`, `delete`, `export`, `exporters`, `importers`, `inheritance`, `projects`, `remove_group`, `remove_project`, `remove_user`, `rename`, `restore`, `restore_built_in`, `search`, `search_groups`, `search_users`, `set_default`, and `show`.

Single-rule actions target a profile and rule key and may set severity, prioritized status, impacts, and parameter values as declared. Bulk actions filter rules using the action's query and report successes and failures rather than inventing activations for unknown keys. Search responses expose action flags computed from built-in/default status and the caller's grants. [Provenance: `sonar-ws-generator/src/main/resources/snapshot-of-api.json`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualityprofile/ws/`]

## 7. Metrics

### 7.1 Registration contract

On startup the server combines the pinned Core Metrics with every loaded `Metrics` extension. Duplicate plugin keys against a core key or another repository are fatal registration errors. A new metric receives a UUID; an existing key retains its UUID while metadata is updated. Previously persisted metrics absent from the current combined catalog are disabled. Quality-gate conditions referring to invalid metrics are deleted during registration. Registration is transactional before service use. [Provenance: `server/sonar-webserver-core/src/main/java/org/sonar/server/startup/RegisterMetrics.java`]

Public metric value types include `BOOL`, `INT`, `FLOAT`, `PERCENT`, `MILLISEC`, `WORK_DUR`, `STRING`, `DATA`, `LEVEL`, `DISTRIB`, and `RATING`. Hidden metrics remain persistent/public identifiers for internal compatibility but are omitted from ordinary metric search unless the endpoint explicitly includes them. Deprecated metrics remain listed below because they are still registered by the pinned release. Analyzer-defined metrics are additional and are cataloged by their owning analyzer specifications.

### 7.2 Complete Community platform metric-key catalog

The 120 pinned Core Metric keys are:

- Size, complexity, and tests: `lines`, `generated_lines`, `ncloc`, `new_lines`, `ncloc_language_distribution`, `generated_ncloc`, `classes`, `files`, `functions`, `statements`, `public_api`, `projects`, `comment_lines`, `comment_lines_density`, `public_documented_api_density`, `public_undocumented_api`, `complexity`, `cognitive_complexity`, `tests`, `test_execution_time`, `test_errors`, `skipped_tests`, `test_failures`, `test_success_density`.
- Coverage: `coverage`, `new_coverage`, `lines_to_cover`, `new_lines_to_cover`, `uncovered_lines`, `new_uncovered_lines`, `line_coverage`, `new_line_coverage`, `conditions_to_cover`, `new_conditions_to_cover`, `uncovered_conditions`, `new_uncovered_conditions`, `branch_coverage`, `new_branch_coverage`.
- Duplication: `duplicated_lines`, `new_duplicated_lines`, `duplicated_blocks`, `new_duplicated_blocks`, `duplicated_files`, `duplicated_lines_density`, `new_duplicated_lines_density`, `duplications_data`.
- Issue counts and legacy severities: `violations`, `blocker_violations`, `critical_violations`, `major_violations`, `minor_violations`, `info_violations`, `new_violations`, `new_blocker_violations`, `new_critical_violations`, `new_major_violations`, `new_minor_violations`, `new_info_violations`, `false_positive_issues`, `wont_fix_issues`, `accepted_issues`, `new_accepted_issues`, `high_impact_accepted_issues`, `maintainability_issues`, `new_maintainability_issues`, `reliability_issues`, `new_reliability_issues`, `security_issues`, `new_security_issues`, `new_reliability_issue_severity`, `new_security_issue_severity`, `new_maintainability_issue_severity`, `open_issues`, `reopened_issues`, `confirmed_issues`, `code_smells`, `new_code_smells`, `new_code_smells_severity`, `bugs`, `new_bugs`, `new_bugs_severity`, `vulnerabilities`, `new_vulnerabilities`, `new_vulnerabilities_severity`, `security_hotspots`, `new_security_hotspots`.
- Maintainability, reliability, security, and review: `sqale_index`, `new_technical_debt`, `sqale_rating`, `new_maintainability_rating`, `development_cost`, `new_development_cost`, `sqale_debt_ratio`, `new_sqale_debt_ratio`, `effort_to_reach_maintainability_rating_a`, `reliability_remediation_effort`, `new_reliability_remediation_effort`, `reliability_rating`, `new_reliability_rating`, `security_remediation_effort`, `new_security_remediation_effort`, `security_rating`, `new_security_rating`, `security_review_rating`, `new_security_review_rating`, `security_hotspots_reviewed`, `new_security_hotspots_reviewed`, `security_hotspots_reviewed_status`, `security_hotspots_to_review_status`, `new_security_hotspots_reviewed_status`, `new_security_hotspots_to_review_status`.
- Internal data and release state: `ncloc_data`, `comment_lines_data`, `executable_lines_data`, `alert_status`, `quality_gate_details`, `quality_profiles`, `last_commit_date`, `analysis_from_sonarqube_9_4`, `pull_request_fixed_issues`.

The 31 platform multi-quality-mode keys are:

`software_quality_maintainability_issues`, `new_software_quality_maintainability_issues`, `software_quality_maintainability_rating`, `new_software_quality_maintainability_rating`, `software_quality_reliability_issues`, `new_software_quality_reliability_issues`, `software_quality_reliability_rating`, `new_software_quality_reliability_rating`, `software_quality_security_issues`, `new_software_quality_security_issues`, `software_quality_security_rating`, `new_software_quality_security_rating`, `effort_to_reach_software_quality_maintainability_rating_a`, `software_quality_maintainability_remediation_effort`, `new_software_quality_maintainability_remediation_effort`, `software_quality_security_remediation_effort`, `new_software_quality_security_remediation_effort`, `software_quality_reliability_remediation_effort`, `new_software_quality_reliability_remediation_effort`, `software_quality_maintainability_debt_ratio`, `new_software_quality_maintainability_debt_ratio`, `software_quality_blocker_issues`, `new_software_quality_blocker_issues`, `software_quality_high_issues`, `new_software_quality_high_issues`, `software_quality_medium_issues`, `new_software_quality_medium_issues`, `software_quality_low_issues`, `new_software_quality_low_issues`, `software_quality_info_issues`, `new_software_quality_info_issues`.

Five further Community platform keys are `prioritized_rule_issues`, `issues_in_sandbox`, `new_issues_in_sandbox`, `unanalyzed_c`, and `unanalyzed_cpp`. The sandbox and unanalyzed-language keys are hidden. [Provenance: pinned Plugin API `CoreMetrics.java` at tag `13.8.0.4399`; `sonar-core/src/main/java/org/sonar/core/metric/SoftwareQualitiesMetrics.java`; `server/sonar-server-common/src/main/java/org/sonar/server/metric/IssueCountMetrics.java`; `UnanalyzedLanguageMetrics.java`; registration in `server/sonar-webserver/src/main/java/org/sonar/server/platform/platformlevel/PlatformLevel4.java`]

### 7.3 Metric APIs

`api/metrics/search` returns enabled automatic metric definitions with paging and filtering as declared by the action. `api/metrics/types` returns supported public metric types. Metrics are definitions, not current project measures; measure retrieval and history belong to analysis-results and history APIs. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/metric/ws/`]

## 8. Quality gates

### 8.1 Gate selection and lifecycle

A project may be explicitly associated with one quality gate. That gate wins. If no association exists, the installation's default gate wins. Absence of a default gate is an invalid server state and quality-gate resolution fails rather than choosing an arbitrary gate. A gate can be created, copied, renamed, destroyed, made default, associated/dissociated with projects, and edited through conditions. Built-in status is preserved; the built-in `Sonar way` gate is synchronized at startup.

The pinned `Sonar way` conditions are all on new code:

- `new_violations` `GT` `0`;
- `new_coverage` `LT` `80`;
- `new_duplicated_lines_density` `GT` `3`;
- `new_security_hotspots_reviewed` `LT` `100`.

The built-in gate does not declare AI-code support in Community source. [Provenance: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/qualitygate/QualityGateServiceImpl.java`; `server/sonar-server-common/src/main/java/org/sonar/server/qualitygate/QualityGateFinder.java`; `qualitygate/builtin/SonarWayQualityGate.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualitygate/RegisterQualityGates.java`]

### 8.2 Conditions and evaluation contract

Condition operator identifiers are `GT` (measure is greater than threshold) and `LT` (measure is lower than threshold). Only enabled, non-hidden metrics of type `INT`, `FLOAT`, `PERCENT`, `MILLISEC`, `LEVEL`, `RATING`, or `WORK_DUR` may be used. `alert_status`, `security_hotspots`, and `new_security_hotspots` are forbidden. Metric direction restricts the operator: better-direction metrics use `LT`; worse-direction metrics use `GT`; direction-neutral metrics allow either. A gate may not contain two conditions on the same metric or on a standard/multi-quality equivalent pair.

Threshold length is at most 64. Numeric types require a parseable numeric threshold. Rating thresholds are integer ratings A–E represented by 1–5, only approved rating metric keys are allowed, and E cannot be used as a worse-than threshold because no worse rating exists. Condition result identifiers are `NO_VALUE`, `OK`, and `ERROR`; gate result identifiers are `OK` and `ERROR`. A missing measure yields `NO_VALUE` for that condition and does not manufacture a failing numeric value. Metrics whose keys begin `new_` are evaluated as new-code variations. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualitygate/QualityGateConditionsUpdater.java`; `qualitygate/ws/QualityGatesWs.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/qualitygate/Condition.java`; `ConditionEvaluator.java`; `ConditionStatus.java`]

Global `gateadmin` or system administration may administer gates. Delegated gate edit users/groups may edit a non-built-in gate where the gate support permits it. Project `admin` selects/deselects a gate for that project; global default changes require gate administration. Built-in/read-only restrictions take precedence over edit grants.

### 8.3 Gate APIs

`api/qualitygates` exposes `add_group`, `add_user`, `copy`, `create`, `create_condition`, `delete_condition`, `deselect`, `destroy`, `get_by_project`, `list`, `project_status`, `remove_group`, `remove_user`, `rename`, `search`, `search_groups`, `search_users`, `select`, `set_as_default`, `show`, and `update_condition`. `add_group`/`remove_group` take required `gateName` and `groupName`; `add_user`/`remove_user` take required `gateName` and user `login`. They add or remove edit delegation idempotently and require either `gateadmin` or an existing edit right on that non-built-in gate. Built-in gates remain read-only even to delegates. `search_groups` and `search_users` require `gateName`, accept the standard text query, selected-membership mode, and paging, and return candidate principals with whether each is selected; they apply the same limited-edit authorization. `project_status` reports the evaluated result owned by compute/analysis results; configuration actions here must not reevaluate an old analysis as if it were newly computed. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualitygate/ws/QualityGateWsModule.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualitygate/ws/AbstractGroupAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualitygate/ws/AbstractUserAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualitygate/ws/SearchGroupsAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualitygate/ws/SearchUsersAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualitygate/ws/QualityGatesWsSupport.java`]

## 9. Settings

### 9.1 Definitions, values, and precedence

Setting definitions are registered by the platform and plugins. Effective server-runtime precedence for a key is:

1. startup/system properties supplied to the server process, including `sonar.properties`;
2. the environment-variable mapping declared by the property definition;
3. the database global value;
4. the definition's default when the settings abstraction requests a value and no higher source is present.

For project-configurable settings, the effective project value is the project database value over the database global value over the definition default. The values API deliberately excludes `sonar.properties` values and presents entries in default, global, then component order so later scopes override earlier ones. Scanner-command properties and analyzer-specific precedence after server delivery belong to the scanner-engine/analyzer specifications.

Startup/system and environment values override database values and cannot be changed through `api/settings`. Database reads use a request/thread cache; when a database read fails, the last successfully loaded database cache is used where available. A committed global database mutation updates the in-memory delegate and notifies global property listeners. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/setting/ThreadLocalSettings.java`; `DatabaseSettingLoader.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/platform/PersistentSettings.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/setting/ws/ValuesAction.java`]

### 9.2 Mutation and secrecy

`api/settings/set` accepts exactly the value representation compatible with the definition: scalar `value`, repeated `values`, or repeated JSON field values for a property set. It validates key aliases, definition scope, target qualifier, type, issue-resolution constraints, and custom validators before commit. A project target must be a supported top-level entity and requires project `admin`; global mutation requires system administration. Process-only keys are rejected. Selected sensitive keys require API v2 rather than the legacy setter.

`api/settings/reset` deletes the database value at the selected scope, revealing the next value in precedence. It cannot remove or overwrite `sonar.properties`. Keys ending `.secured` and other admin-only settings are visible only to an appropriate administrator or analysis principal. Secured values are never returned by `values`; only their keys appear in `setSecuredSettings` when set. Encryption helpers require system administration and depend on the configured secret-key file; ciphertext is not a substitute for access control. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/setting/ws/SetAction.java`; `ResetAction.java`; `ValuesAction.java`; `SettingsWsSupport.java`; `SettingValidations.java`]

### 9.3 Settings APIs

`api/settings` exposes `check_secret_key`, `encrypt`, `generate_secret_key`, `list_definitions`, `login_message`, `reset`, `set`, and `values`. `login_message` is internal and readable before login. `list_definitions` returns definition metadata subject to visibility and project browse rules. `values` requires project `user` or scan permission for a project target; it never returns a secured value. Generic JSON/protobuf representation belongs to the HTTP API specification. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/setting/ws/`]

## 10. New-code periods

### 10.1 Types and validation

Public type identifiers are:

- `PREVIOUS_VERSION`: no value; valid globally and at branch level.
- `NUMBER_OF_DAYS`: integer string from 1 through 90; valid globally and at branch level.
- `SPECIFIC_ANALYSIS`: UUID of an analysis belonging to the selected project branch; branch-only.
- `REFERENCE_BRANCH`: existing/reference branch name; project/branch-capable in shared source.

Community Build stores a project-level request against the main branch, so its effective branch rules apply. Global configuration accepts only `PREVIOUS_VERSION` and `NUMBER_OF_DAYS`. A supplied branch requires a project. A specific analysis must exist and belong to that exact branch. `PREVIOUS_VERSION` rejects a value; every other type requires one. Number-of-days outside 1–90 is not Clean-as-You-Code compliant and is rejected. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/newcodeperiod/NewCodePeriodType.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/newcodeperiod/ws/SetAction.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/newcodeperiod/CaycUtils.java`]

### 10.2 Precedence and transitions

Effective precedence is branch record, then project record, then global record, then built-in default `PREVIOUS_VERSION`. In Community Build, the project setting is represented on the main branch; `show` reports whether the returned value is inherited. A requested unknown project or branch in `show` falls back to the inherited level and marks the response inherited, while an invalid branch-without-project request fails.

`set` upserts at the requested level. Global mutation requires system administration; project/main-branch mutation requires project `admin`. `unset` deletes the selected record and exposes the next inherited level, but refuses an inherited result that violates the pinned Clean-as-You-Code compatibility rule. `show` with a project requires project `admin`, project `scan`, or global `scan`. `list` requires project browse and returns branch definitions for the project. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/newcodeperiod/ws/ShowAction.java`; `SetAction.java`; `UnsetAction.java`; `ListAction.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/newcodeperiod/NewCodePeriodDto.java`]

The controller `api/new_code_periods` exposes `list`, `set`, `show`, and `unset`.

## 11. Configuration precedence summary

For an analysis of project P and language L, the observable selection order is:

1. Resolve P by stable UUID after accepting its current public key.
2. Resolve authorization and visibility through identity-access.
3. Select P's explicitly associated profile for L, otherwise the default profile for L.
4. Resolve active rules through profile inheritance; active-rule parameter overrides beat rule defaults.
5. Resolve project settings over global database settings over definition defaults, while immutable startup/environment sources retain their higher server-runtime precedence.
6. Select P's explicit quality gate, otherwise the global default gate.
7. Select branch new-code definition, then project/main-branch definition, then global definition, then `PREVIOUS_VERSION`.
8. Deliver the resulting configuration through scanner gateway; compute engine evaluates the submitted results against the selected gate and new-code period.

No later stage may silently substitute a different profile, gate, or new-code policy after the analysis metadata has been accepted. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/rule/ActiveRuleService.java`; `server/sonar-server-common/src/main/java/org/sonar/server/qualitygate/QualityGateFinder.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/newcodeperiod/ws/ShowAction.java`; settings sources above]

## 12. Persistence, concurrency, lifecycle, and recovery

Projects, associations, active rules, gates, settings, and new-code records are relational durable state. Mutations use explicit database sessions and commit before indexing/notification. Rule, profile, metric, and built-in gate registration run at server startup and reconcile persisted state with installed definitions. Search indexes are derived and recoverable; the database is authoritative.

Concurrent edits are subject to database uniqueness and service validation. A duplicate project/rule/profile/gate/group-visible name or duplicate gate condition fails; it must not overwrite an unrelated object. Request/thread setting and authorization caches may preserve the value observed at request start. A subsequent request observes the committed state. Bulk profile and template operations may report per-item failures where the API contract provides a partial-result summary; a single-object transactional mutation must not return success before commit.

If indexing fails after a relational commit, recovery is index resynchronization rather than rollback of valid configuration. If a plugin disappears, startup rule/metric reconciliation follows the explicit removed/disabled behaviors above. If a default gate or required default profile/template is missing, startup/resolution fails loudly rather than manufacturing an arbitrary replacement, except for the documented first-install default-template and built-in-default creation paths. [Provenance: registration and service paths indexed below]

## 13. Failure and security boundaries

- Authentication failure, forbidden permission, not found, bad input, and conflict must remain distinguishable through the generic HTTP API error contract.
- Private project lookup and search must be permission-filtered and should use not-found behavior where an existence leak would violate the endpoint contract.
- Rule Markdown and setting text are untrusted content and must be rendered/serialized through the platform's sanitization/HTTP contracts; they are not executable configuration.
- Secured settings and encryption keys must not appear in list responses, logs, profile backups, gate definitions, or scanner metadata unless the owning contract explicitly requires a protected delivery path.
- A scanner report may reference only registered metric and rule keys; unknown definitions are rejected/ignored according to scanner/compute contracts and must not create server definitions implicitly.
- Project, profile, gate, or setting administration must always recheck identity-access permissions. UI visibility of an action is not authorization.
- Managed-project restrictions are operation-specific, not blanket. Visibility changes reject any managed project. Adding a group grant rejects a managed target; adding a user grant applies the managed-project guard for non-system administrators. Removing a group or user grant rejects the managed user/group-and-project combinations checked by the corresponding action. Applying one permission template rejects a managed project, and bulk template application skips managed projects. Otherwise-authorized `delete` and `update_key` remain available because those actions have no managed-project guard. Externally managed user/group identity fields remain governed by `platform/identity-access/`.
- Community behavior must not be expanded from shared commercial constants such as application/portfolio qualifiers or creator permissions.

## 14. Compatibility and limits

Legacy Web APIs and newer v2 endpoints coexist. Public route/action names, rule keys and deprecated aliases, metric keys, profile/gate identifiers, condition operators, setting keys, qualifier/scope codes, and new-code types are compatibility identifiers. A clean implementation must preserve them even when an action is marked deprecated or internal in metadata. Generic pagination maximums and wire formats are owned by `platform/http-api/`.

Project keys are at most 400 characters; names 500; custom-rule key/template/name fields 200; gate thresholds 64; number-of-days new code 1–90. Metric extensions may add keys only when they do not collide with any registered key. Built-in profiles are immutable; default profiles and gates cannot be deleted while default; a quality gate allows one condition per metric/equivalent pair.

## 15. Acceptance scenarios

1. **Project creation defaults.** Given a caller with `provisioning`, no visibility, no main branch, and no new-code pair, creating a valid unique key creates one project with immutable UUID, default visibility, effective default main branch, matching/default permissions, inherited new-code policy, default language profiles, and default gate.
2. **Atomic creation failure.** Given two permission-template regexes matching the key, create fails and no searchable or relational project is left behind.
3. **Key rename.** Given an administered project with descendants and associations, updating its key changes public project/descendant keys but preserves UUIDs, profile association, gate association, settings, permissions, and analysis history.
4. **Profile precedence.** Given default Java profile A and project-associated Java profile B, scanner configuration for the project contains B's active rules; another language without an association still uses its default.
5. **Active parameter precedence.** Given a rule parameter default and an active-rule override, scanner metadata exposes the override. Removing the override reveals the rule default.
6. **Built-in immutability.** Given `profileadmin`, attempting to activate, deactivate, rename, parent, or delete a built-in profile fails; copying it to a custom profile succeeds when its requested name is valid.
7. **Removed analyzer rule.** Given a rule removed from an analyzer whose repository remains installed, startup marks it removed and deletes its active-rule bindings. Given the whole repository is absent, bindings are retained for compatibility.
8. **Metric collision.** Given a plugin metric with a core key or another plugin's key, startup metric registration fails rather than changing the existing definition's ownership.
9. **Gate precedence.** Given project-specific gate X and global default Y, project analysis uses X. After deselection, the next analysis uses Y.
10. **Gate condition validation.** Creating a second condition on the same or equivalent metric, a condition on `alert_status`, an operator contrary to metric direction, or an unparseable threshold fails without altering the gate.
11. **Sonar way.** A project using the pinned built-in gate fails when new issues exceed zero, new coverage is below 80, new duplicated-line density exceeds 3, or reviewed new hotspots is below 100; a missing condition measure is `NO_VALUE`, not a fabricated number.
12. **Setting precedence.** Given a definition default, global database value, and project database value, a project reads the project value. Resetting it reveals global; resetting global reveals default. A startup/system value still wins in server runtime and cannot be changed by the settings API.
13. **Secured setting.** Given a `.secured` key with a value, `api/settings/values` returns its presence key but never plaintext; an unauthorized caller cannot see even protected metadata.
14. **New-code inheritance.** Given no branch record, a project/main-branch definition, and a global definition, `show` returns the project value with inherited status for the branch. Unsetting it reveals global; with no record anywhere it returns `PREVIOUS_VERSION`.
15. **Specific analysis validation.** Setting `SPECIFIC_ANALYSIS` without a project branch, or with an analysis UUID from another branch, fails without updating the existing new-code record.
16. **Visibility safety.** Changing a public project to private while an ordinary background task is pending fails. With no such task, the change propagates to branches/components and applies identity-access permission migration.

## 16. Provenance index

- Release and license: `manifest/release-baseline.md`, `manifest/license-map.md`, root `LICENSE.txt`.
- Projects/components: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/project/ws/`, `component/ws/`, `server/sonar-webserver-common/src/main/java/org/sonar/server/common/component/`, `server/sonar-db-dao/src/main/java/org/sonar/db/component/`, `sonar-core/src/main/java/org/sonar/core/component/ComponentKeys.java`.
- Visibility and permissions dependency: `server/sonar-server-common/src/main/java/org/sonar/server/project/VisibilityService.java`; `platform/identity-access/specification.md`.
- Rule registration and APIs: `server/sonar-webserver-core/src/main/java/org/sonar/server/rule/registration/`, `server/sonar-webserver-webapi/src/main/java/org/sonar/server/rule/ws/`, `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/rule/`.
- Profiles and active rules: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualityprofile/`, `qualityprofile/ws/`, `qualityprofile/builtin/`, `server/sonar-server-common/src/main/java/org/sonar/server/rule/ActiveRuleService.java`, `server/sonar-db-dao/src/main/java/org/sonar/db/qualityprofile/`.
- Metrics: `server/sonar-webserver-core/src/main/java/org/sonar/server/startup/RegisterMetrics.java`, `sonar-core/src/main/java/org/sonar/core/metric/SoftwareQualitiesMetrics.java`, `server/sonar-server-common/src/main/java/org/sonar/server/metric/IssueCountMetrics.java`, `UnanalyzedLanguageMetrics.java`, `server/sonar-webserver-webapi/src/main/java/org/sonar/server/metric/ws/`.
- Pinned Core Metrics: https://github.com/SonarSource/sonar-plugin-api/blob/13.8.0.4399/plugin-api/src/main/java/org/sonar/api/measures/CoreMetrics.java.
- Quality gates: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualitygate/`, `qualitygate/ws/`, `server/sonar-server-common/src/main/java/org/sonar/server/qualitygate/`, `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/qualitygate/`.
- Settings: `server/sonar-server-common/src/main/java/org/sonar/server/setting/`, `server/sonar-webserver-core/src/main/java/org/sonar/server/platform/PersistentSettings.java`, `server/sonar-webserver-webapi/src/main/java/org/sonar/server/setting/ws/`.
- New code: `server/sonar-db-dao/src/main/java/org/sonar/db/newcodeperiod/`, `server/sonar-webserver-webapi/src/main/java/org/sonar/server/newcodeperiod/ws/`, `server/sonar-webserver-common/src/main/java/org/sonar/server/common/newcodeperiod/`.
- Legacy API catalog: `sonar-ws-generator/src/main/resources/snapshot-of-api.json` plus the current action registries under the cited `ws/` packages.
