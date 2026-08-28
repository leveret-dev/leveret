# Web UI Specification

## 1. Identity and release boundary

This specification covers the browser application bundled with SonarQube Community Build `26.8.0.126808`. The authoritative UI payload is Maven artifact `org.sonarsource.sonarqube:webapp-assets:2026.5.0.65571`, published SHA-256 `212b2e688b7f9377b11debab3b13f67f972742dd8a80220ba92674123ff7cc92`. The product build pins this exact version through `webappVersion`. The artifact describes itself as the SonarQube Community Build Web App and contains the HTML entry point, JavaScript and CSS bundles, fonts, images, and servlet metadata. [Provenance: `SonarSource/sonarqube` commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`, `gradle.properties` and `build.gradle`; Maven Central artifact and POM at `https://repo1.maven.org/maven2/org/sonarsource/sonarqube/webapp-assets/2026.5.0.65571/`]

The artifact POM and packaged `package.json` identify LGPL v3 / `LGPL-3.0`. Repository source headers and `SonarSource/sonarqube-webapp/LICENSE.txt` use LGPL terms. This is a weak-copyleft clean-room specification, not a strong-copyleft copy marker. [Provenance: artifact `META-INF` publication metadata, packaged `package.json`, and `https://github.com/SonarSource/sonarqube-webapp/blob/sqcb-26.8.0/LICENSE.txt`]

### Unresolved Git commit limitation

The published POM names `SonarSource/sonarqube-webapp` but sets its SCM tag to `HEAD`; it does not identify an immutable source commit. Repository tag `sqcb-26.8.0` resolves to commit `4fd451f8274726c768ac636ce40c34d68392fa7a`, and its `apps/sq-server/package.json` has the same application name, version `2026.5.0`, browser targets, and scripts as the released artifact. No published cryptographic or SCM record proves that this commit produced artifact build `65571`. Therefore the artifact is authoritative. Tagged repository paths below are interpretive evidence only when the relevant route, asset, API identifier, visible text, or bundle is also present in the released artifact or confirmed by official Community Build documentation. No branch-head-only behavior is a released requirement. [Provenance: artifact POM `scm/tag`; artifact `package.json`; Git tag `sqcb-26.8.0`; `https://github.com/SonarSource/sonarqube-webapp/tree/sqcb-26.8.0`]

## 2. Purpose, scope, and exclusions

The Web UI provides the human-facing, browser-based view and control surface for Community Build. It owns client-side route interpretation, navigation, presentation, forms, filtering controls, browser interaction, accessibility-visible labels and states, lazy page loading, and translation use. It consumes server contracts; it does not own authentication decisions, authorization, issue or hotspot state, measures, quality-gate calculation, quality-profile semantics, project configuration precedence, compute tasks, search indexes, persistence, plugin lifecycle, or HTTP wire rules. Those contracts remain with `platform/identity-access/`, `platform/http-api/`, `platform/project-configuration/`, `platform/analysis-results/`, `platform/compute-engine/`, `platform/search-indexing/`, `platform/events-notifications/`, and `platform/plugin-extension-runtime/`. [Provenance: `manifest/dependency-map.md`; tagged source `apps/sq-server/src/main/js/app/utils/startReactApp.tsx`; artifact bundles]

The released asset is a unified browser payload and contains names or dormant chunks associated with commercial add-ons. Their presence is not evidence that Community Build exposes them. Applications, portfolios, commercial reports, branch and pull-request capabilities, software-composition analysis, AI fix services, remediation agents, architecture features, license administration, and audit capabilities are excluded unless the Community Build server advertises the corresponding feature and official Community Build documentation confirms it. This specification does not infer such behavior. [Provenance: artifact bundle inventory; tagged source feature gates in `apps/sq-server/src/main/js/app/utils/startReactApp.tsx`; `https://docs.sonarsource.com/sonarqube-community-build/feature-comparison-table.md`]

## 3. Owned browser contract and dependencies

### 3.1 Entry document and base path

The server supplies an HTML document with a `content` mount point. It substitutes the web context, instance name, official-build flag, and server status into the document. Before the application mounts, the page displays `Loading...` in an `aria-live="polite"` region. All asset and browser-route URLs are based beneath the configured web context rather than assuming deployment at `/`. The document title is the configured instance name. [Provenance: artifact `index.html`; artifact `WEB-INF/web.xml`; tagged source `apps/sq-server/src/main/js/app/index.ts`]

The accepted browser inputs are a path beneath that base URL, query parameters, fragment identifiers retained for backward compatibility, authenticated session cookies managed by the server, keyboard and pointer input, form values, and JSON or download responses from same-origin APIs. Outputs are rendered HTML/SVG, accessible names and live messages, browser-history changes, downloads, full-page authentication redirects, and same-origin API requests. The browser application has no direct database, search-engine, filesystem, scanner-report, or email access.

### 3.2 Startup lifecycle

For a normal route while server status is `UP`, startup obtains global navigation state, localization, current-user state, and the advertised feature list. Global-navigation failure is logged and tolerated as an absent application-state value; failure of localization, current user, or feature discovery prevents the browser application from mounting. Session, maintenance, setup, and formatting-help routes skip normal global bootstrap. After bootstrap, the client mounts a browser router under the configured base URL and loads page bundles on demand. [Provenance: tagged source `apps/sq-server/src/main/js/app/index.ts`; exact artifact `js/main-DfIfKlXm.js` and `js/startReactApp-BR0BPnv_.js`]

Server navigation and feature responses take precedence over compiled route availability. Next come current-user and project permissions. Route/query state selects the current resource and filters. Page-local selections and browser preferences affect presentation only. The client must never treat a hidden menu item or a compiled route as authorization; the server remains authoritative for every read and mutation.

### 3.3 State and persistence

URL paths and query parameters preserve navigable page, selected component, open issue or rule, filters, metrics, and compatible branch-like context. Browser history supports backward and forward navigation. In-memory request caches may be reused during one loaded application. Browser storage retains non-authoritative preferences such as recent navigation, project-list choice, and keyboard-shortcut enablement. Account home-page choice, favorites, notification subscriptions, tokens, issue changes, profile/gate changes, and administration changes persist only through their owning server APIs. Logout clears browser recent history after successful server logout. [Provenance: tagged source `apps/sq-server/src/main/js/apps/projects/routes.tsx`, `apps/sq-server/src/main/js/app/components/KeyboardShortcutsModal.tsx`, `apps/sq-server/src/main/js/apps/sessions/components/Logout.tsx`; artifact API identifiers]

## 4. Browser route catalog

Every route below is relative to the configured web context. A `:name` segment is a path parameter. Most component pages identify the project with query parameter `id`; compatible pages may also receive `branch` or `pullRequest`. The server-generated navigation determines whether a route is offered to a user.

### 4.1 Shell, session, and account routes

- `/` selects the user-appropriate landing page. `/dashboard` displays a component overview when supplied a visible component identity.
- `/sessions/new` presents login. `/sessions/logout` performs logout. `/sessions/unauthorized` displays the denial and any server-provided authentication reason. `/account/reset_password` handles forced password reset without normal menus.
- `/auth` creates an external-product connection token; `/sonarlint/auth` is its backward-compatible route for older SonarQube for IDE clients.
- `/account` shows profile and group/SCM-account information. `/account/security` manages local password and authentication tokens. `/account/projects` lists administered projects. `/account/notifications` manages subscriptions.
- `/maintenance` and `/setup` present server maintenance or database-setup states. `/formatting/help` presents supported formatting help. `/documentation/*` redirects version-aware documentation links. Unknown paths, `/not_found`, and unsupported resources show a not-found surface.

[Provenance: exact artifact path identifiers and chunks; tagged source `apps/sq-server/src/main/js/apps/sessions/routes.tsx`, `apps/account/routes.tsx`, `apps/maintenance/routes.tsx`, and `app/utils/startReactApp.tsx`; `https://docs.sonarsource.com/sonarqube-community-build/user-guide/managing-your-account/introduction.md`]

### 4.2 Global discovery and standards routes

- `/projects` shows retrievable projects, subject to public visibility or Browse permission. `/projects/favorite` restricts the list to favorites. `/projects/all` is a compatibility route that selects the all-project filter and redirects to `/projects`. `/projects/create` opens project creation; available choices include local creation and imports from configured DevOps platforms when the user has Create Projects and provider access.
- `/issues` opens the cross-project issue search and detail workspace.
- `/coding_rules` opens rule search and detail. Legacy hash filters are normalized into URL query parameters. `/profiles`, `/profiles/show`, `/profiles/changelog`, and `/profiles/compare` provide quality-profile overview, detail, change history, and comparison.
- `/quality_gates` and `/quality_gates/show/:name` provide gate list and selected-gate detail.
- `/web_api` and nested `/web_api/*` provide the legacy API browser. `/web_api_v2` provides the versioned API browser.
- `/extension/:pluginKey/:extensionKey` hosts a server-registered global plugin page. The CAYC page specified separately is reached through `/extension/cayc/stats` when that bundled extension is registered.

[Provenance: exact artifact route and API strings; tagged source route files under `apps/sq-server/src/main/js/apps/`; official docs `https://docs.sonarsource.com/sonarqube-community-build/project-administration/creating-project/creating-manually.md`, `https://docs.sonarsource.com/sonarqube-community-build/project-administration/creating-project/importing-repo.md`, and quality-profile/gate pages cited in the provenance index]

### 4.3 Project result routes

- `/dashboard` presents quality-gate status, project measures, and recent activity. Failed gate conditions expose current values that drill into supporting details.
- `/code` presents project directories and files, allows drill-down to source, and offers project-local file/directory search. Private source requires both Browse and See Source Code.
- `/component_measures` presents measure domains, component lists/trees, and suitable treemaps. Compatibility paths `/component_measures/domain/:domainName` and `/component_measures/metric/:metricKey` with optional `/:view` normalize to query-driven measures or project activity.
- `/project/activity` presents analysis history, event filtering, predefined measure graphs, and custom graphs of up to three measures.
- `/project/issues` presents issues scoped to the selected project. A legacy `types=SECURITY_HOTSPOT` selection redirects to `/security_hotspots`; mixed legacy type filters remove the hotspot type from issue search.
- `/security_hotspots` presents hotspot search, review guidance, source, status, assignment, comments, and activity.
- `/quality_gate_history` is a project-only, main-branch-only history route in the released payload. Non-project components return not found; branch-like query parameters are removed before display.
- `/project/quality_gate`, `/project/quality_profiles`, and `/project/information` present the project's assigned standards and identifying/configuration information. `/tutorials` presents analysis setup guidance.
- `/project/extension/:pluginKey/:extensionKey` hosts a server-registered project page.

[Provenance: exact artifact chunks `CodeApp-B8kVf8aI.js`, `ComponentMeasuresApp-Dn8w8g1O.js`, `IssuesApp-O5NbpXbo.js`, `SecurityHotspotsApp-xgg2Q4fR.js`, `ProjectActivityApp-BzWRYoN_.js`, and `QualityGateHistoryApp-Ct_gQN8E.js`; tagged source route files and `libs/feature-quality-gate-history/src/components/QualityGateHistoryGuard.tsx`; official docs for project overview, activity, structure, information, issues, and hotspots]

### 4.4 Project administration routes

Authorized project administrators use `/project/background_tasks`, `/project/deletion`, `/project/import_export`, `/project/key`, `/project/links`, `/project/baseline`, `/project/settings`, `/project/settings/encryption`, `/project/webhooks`, and `/project_roles`. These pages respectively expose task history and failure details, deletion, Community project-export initiation and status, key changes, project links, new-code definition, project-scoped settings, secret-value encryption, webhooks, and user/group permissions. Project import on `/project/import_export` remains unavailable unless the server advertises its separate import feature; it is not a Community Build capability. `/project/admin/extension/:pluginKey/:extensionKey` hosts a registered project-administration extension. [Provenance: exact artifact route/API identifiers; SonarQube `server/sonar-webserver/src/main/java/org/sonar/server/platform/platformlevel/PlatformLevel4.java` and `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/projectdump/ProjectExportWsModule.java`; tagged Web UI `apps/sq-server/src/main/js/apps/projectDump/ProjectDumpApp.tsx`; official project administration and background-task documentation]

### 4.5 Instance administration routes

Authorized system administrators use `/admin/background_tasks`, `/admin/permissions`, `/admin/groups`, `/admin/marketplace`, `/admin/permission_templates`, `/admin/projects_management`, `/admin/settings`, `/admin/settings/encryption`, `/admin/system`, `/admin/users`, and `/admin/webhooks`. These surfaces expose the server-supported task queue, global permissions, groups, plugin marketplace, permission templates, bulk project management and default visibility, settings, secret encryption, system information/log controls, user management, and instance webhooks. `/admin/extension/:pluginKey/:extensionKey` hosts a registered global administration extension. `/admin/change_admin_password` and `/admin/plugin_risk_consent` are dedicated menu-free administration flows. [Provenance: exact artifact route/API identifiers; tagged source `renderAdminRoutes` and administration route files; `https://docs.sonarsource.com/sonarqube-community-build/instance-administration.md` and `https://docs.sonarsource.com/sonarqube-community-build/instance-administration/user-management/user-permissions.md`]

The unified asset also contains `/admin/audit` and add-on route hooks. They are not asserted as Community Build capabilities because the released Community server/navigation evidence does not establish their availability. Unsupported or unadvertised add-on routes need not be usable.

## 5. Externally visible interactions

### 5.1 Authentication and navigation

The login page first discovers configured identity providers. When providers exist, provider buttons are shown and the local credential form begins collapsed behind a “more options” control. Expanding it focuses the required username field. Username accepts at most 255 characters; password is required and has an accessible show/hide control. A failed local login displays an alert and clears that error as either field changes. Successful local login performs a full-page replacement to the validated return destination. Selecting an identity provider performs a full-page transition to `/sessions/init/:providerKey` with an encoded `return_to`. Logout displays a progress message, calls the logout API, clears recent client history on success, and returns to the base URL; failure displays a global error and does not claim successful logout. [Provenance: exact artifact session paths, API strings, and login bundle content; tagged source `apps/sq-server/src/main/js/apps/sessions/components/`; identity/access remains owned by `platform/identity-access/`]

Global navigation presents only server-advertised pages. Global search covers visible instance content; project Code search is limited to the current project's files and directories. Project retrieval permits every public project and private projects for which the user has Browse. Favorite controls update the user's favorite set. [Provenance: `https://docs.sonarsource.com/sonarqube-community-build/user-guide/viewing-projects/retrieving-projects.md` and `viewing-project-structure.md`; exact artifact component/favorite API identifiers]

### 5.2 Projects, measures, code, and activity

Selecting a project opens Overview. The quality-gate banner distinguishes pass from fail, and failed conditions provide drill-down. Measure selections open component detail, list/tree views, or percentage/rating treemaps. Code navigation drills from directories to files and source. Activity lists retained analyses and events, filters by event type, and graphs selected measures. A pending analysis is visible before new results become current; failed tasks expose error details to authorized users, while pending tasks can be canceled but running tasks cannot. [Provenance: official project overview, activity, structure, and background-task documentation URLs in the provenance index; exact artifact project and CE API identifiers]

Project creation accepts either a local-project flow or a configured DevOps repository import. Provider options, organizations/workspaces/projects, and repositories are supplied by server ALM APIs. Project configuration pages edit links, visibility and permissions, quality gate/profile assignments, settings, webhooks, key, and new-code definition only when the server grants the corresponding permission. Specific-analysis new-code selection remains API-only and is not offered by the UI. [Provenance: official project creation, permissions, and new-code documentation; exact artifact ALM, permission, quality, settings, and new-code API identifiers]

### 5.3 Issues and Security Hotspots

Issue search exposes a filter panel and result panel. It supports new-code-only, assigned-to-me, unassigned, project, rule, quality/type, severity, status, assignee, tag, date, language, and other server-supplied facets. An issue card exposes project/file, rule, affected quality or type, status, assignee, coding attribute, tags, line, effort, and age when those fields exist. Opening an issue retains the result list alongside detail, shows source and message, “Why is this an issue?”, secondary locations or flows, and activity/comments. A link control copies the issue URL. [Provenance: `https://docs.sonarsource.com/sonarqube-community-build/user-guide/issues/retrieving.md` and `reviewing.md`; exact artifact issue APIs and `IssuesApp-O5NbpXbo.js`]

Permitted issue mutations include assignment/unassignment, status transition to Accepted or False positive and reopening to Open, custom severity, tags, comments, comment edit/delete, and bulk assignment/tag/status changes. Server permissions decide which controls are enabled. External issues can be edited locally, but this does not update their originating external tool. [Provenance: `https://docs.sonarsource.com/sonarqube-community-build/user-guide/issues/managing.md`; exact artifact `/api/issues/*` identifiers]

Hotspot review orders findings by review priority and exposes statuses To review, Acknowledged, Fixed, and Safe. Detail presents “What’s the risk?”, “Assess the risk”, “How can I fix it?”, source, assignee, comments, and Activity. Authorized users can assign, comment, and change status. Authenticated users may receive “Open in IDE”; the linked IDE remains responsible for locating the matching local revision. [Provenance: `https://docs.sonarsource.com/sonarqube-community-build/user-guide/security-hotspots.md`; exact artifact `/api/hotspots/*` identifiers]

### 5.4 Rules, profiles, and gates

Rules can be searched, filtered, opened, and related to quality profiles. Quality-profile pages list language profiles and active-rule breakdown, display detail, inheritance, changelog, and comparison, and allow authorized administrators to create/copy/rename/delete/restore profiles, select defaults or parents, associate projects/users/groups, and activate/deactivate/configure rules. Built-in profiles remain non-editable except through supported copy/derivation flows. [Provenance: official quality-profile introduction and editing documentation; exact artifact `/api/rules/*` and `/api/qualityprofiles/*` identifiers]

Quality-gate pages list and select gates, display conditions and assigned projects, and permit authorized administrators to create, copy, rename, delete, select a default, associate projects and administrators, and add/update/remove conditions. The built-in Sonar way gate is read-only. Project Overview displays evaluated status; the UI does not calculate the authoritative result. [Provenance: `https://docs.sonarsource.com/sonarqube-community-build/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates.md`; exact artifact `/api/qualitygates/*` identifiers]

### 5.5 Accounts and administration

My Account exposes profile/group/SCM information, keyboard-shortcut preference, administered projects, notification subscriptions, password change when local authentication permits it, and token lifecycle. A newly generated token value is shown once and must be copied before dismissal; later lists do not reveal it. Revocation and expiry are server-owned. [Provenance: official account introduction and token documentation; exact artifact account and token API identifiers]

Administration forms operate only through server APIs. Users and groups can be searched and managed according to provisioning mode. Permission grids change global or project permissions and templates. Automatically synchronized permissions are not editable through the manual project grid. Settings are grouped by server definitions; sensitive values use the server encryption/check APIs. Background Tasks exposes queue state, task context, failure detail, permitted cancellation, current worker count, and worker-count help. In Community Build the worker response has `canSetWorkerCount=false`, so the page shows help and no worker-count edit control. System pages expose information, logs, log-level, and migration controls returned and authorized by the server. [Provenance: official instance/project permission and background-task docs; exact artifact administration API identifiers; SonarQube `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ce/ws/WorkerCountAction.java`; tagged Web UI `apps/sq-server/src/main/js/apps/background-tasks/components/Workers.tsx`]

## 6. API dependency catalog

The Web UI consumes, but does not redefine, the following Community Build API groups. HTTP methods, validation, pagination, authorization, media types, and error envelopes belong to `platform/http-api/` and the relevant state owner.

- Bootstrap and navigation: `/api/navigation/global`, `/api/navigation/component`, `/api/navigation/settings`, `/api/navigation/marketplace`, `/api/users/current`, `/api/features/list`, and `/api/l10n/index`.
- Authentication and account: `/api/authentication/login`, `/api/authentication/logout`, `/api/users/identity_providers`, `/api/users/change_password`, `/api/users/set_homepage`, `/api/users/dismiss_notice`, `/api/user_tokens/search`, `/api/user_tokens/generate`, `/api/user_tokens/revoke`, `/api/notifications/list`, `/api/notifications/add`, and `/api/notifications/remove`.
- Projects and discovery: `/api/components/search_projects`, `/api/components/show`, `/api/components/suggestions`, `/api/components/tree`, `/api/projects/search`, `/api/projects/search_my_projects`, `/api/projects/create`, `/api/projects/delete`, `/api/projects/bulk_delete`, `/api/projects/update_key`, `/api/projects/update_visibility`, `/api/favorites/add`, `/api/favorites/remove`, `/api/project_tags/search`, and `/api/project_tags/set`.
- DevOps imports and bindings: the released client contains `/api/v2/dop-translation/dop-settings` and `/api/v2/dop-translation/bound-projects`, plus `/api/alm_integrations/list_github_organizations`, `/api/alm_integrations/list_github_repositories`, `/api/alm_integrations/search_gitlab_repos`, `/api/alm_integrations/search_azure_repos`, `/api/alm_integrations/list_azure_projects`, `/api/alm_integrations/search_bitbucketcloud_repos`, `/api/alm_integrations/search_bitbucketserver_repos`, `/api/alm_integrations/list_bitbucketserver_projects`, the corresponding `import_*` endpoints, and `/api/alm_settings/*` list, validation, binding, create, update, and delete operations. Provider-specific behavior belongs to the integration specifications.
- Results and history: `/api/measures/component`, `/api/measures/component_tree`, `/api/measures/search`, `/api/measures/search_history`, `/api/metrics/search`, `/api/sources/lines`, `/api/sources/raw`, `/api/sources/issue_snippets`, `/api/duplications/show`, `/api/project_analyses/search`, `/api/project_analyses/create_event`, `/api/project_analyses/update_event`, `/api/project_analyses/delete_event`, `/api/project_analyses/delete`, and `/api/qualitygates/project_status`.
- Issues and hotspots: `/api/issues/search`, `/api/issues/list`, `/api/issues/changelog`, `/api/issues/authors`, `/api/issues/tags`, `/api/issues/assign`, `/api/issues/do_transition`, `/api/issues/set_severity`, `/api/issues/set_tags`, `/api/issues/add_comment`, `/api/issues/edit_comment`, `/api/issues/delete_comment`, `/api/issues/bulk_change`, `/api/hotspots/search`, `/api/hotspots/list`, `/api/hotspots/show`, `/api/hotspots/assign`, `/api/hotspots/change_status`, `/api/hotspots/add_comment`, `/api/hotspots/edit_comment`, and `/api/hotspots/delete_comment`.
- Rules and standards: `/api/rules/search`, `/api/rules/show`, `/api/rules/repositories`, `/api/rules/tags`, `/api/rules/update`, `/api/qualityprofiles/search`, `/api/qualityprofiles/show`, `/api/qualityprofiles/create`, `/api/qualityprofiles/copy`, `/api/qualityprofiles/rename`, `/api/qualityprofiles/delete`, `/api/qualityprofiles/restore`, `/api/qualityprofiles/changelog`, `/api/qualityprofiles/compare`, `/api/qualityprofiles/inheritance`, `/api/qualityprofiles/change_parent`, `/api/qualityprofiles/activate_rule`, `/api/qualityprofiles/activate_rules`, `/api/qualityprofiles/deactivate_rule`, `/api/qualityprofiles/deactivate_rules`, profile project/user/group association endpoints, and profile import/export/backup endpoints.
- Quality gates and new code: `/api/qualitygates/list`, `/api/qualitygates/show`, `/api/qualitygates/search`, `/api/qualitygates/create`, `/api/qualitygates/copy`, `/api/qualitygates/rename`, `/api/qualitygates/destroy`, `/api/qualitygates/set_as_default`, `/api/qualitygates/select`, `/api/qualitygates/deselect`, condition create/update/delete endpoints, gate user/group administration endpoints, `/api/new_code_periods/list`, `/api/new_code_periods/show`, `/api/new_code_periods/set`, and `/api/new_code_periods/unset`.
- Project and instance administration: `/api/settings/list_definitions`, `/api/settings/values`, `/api/settings/set`, `/api/settings/reset`, `/api/settings/check_secret_key`, `/api/settings/generate_secret_key`, `/api/settings/encrypt`, `/api/permissions/*` user/group/template operations, `/api/v2/authorizations/groups`, `/api/v2/authorizations/group-memberships`, `/api/v2/users-management/users`, `/api/project_links/search`, `/api/project_links/create`, `/api/project_links/delete`, `/api/project_dump/status`, `/api/project_dump/export`, `/api/webhooks/list`, `/api/webhooks/create`, `/api/webhooks/update`, `/api/webhooks/delete`, `/api/webhooks/deliveries`, and `/api/webhooks/delivery`.
- Compute, plugins, and system: `/api/ce/activity`, `/api/ce/activity_status`, `/api/ce/component`, `/api/ce/task`, `/api/ce/cancel`, `/api/ce/cancel_all`, `/api/ce/analysis_status`, `/api/ce/indexation_status`, `/api/ce/worker_count`, `/api/plugins/available`, `/api/plugins/installed`, `/api/plugins/pending`, plugin install/update/uninstall operations, `/api/system/status`, `/api/system/info`, `/api/system/logs`, `/api/system/change_log_level`, `/api/system/upgrades`, `/api/system/migrate_db`, `/api/support/info`, and email configuration/test operations advertised by the server.
- API browser: `/api/webservices/list`, `/api/webservices/response_example`, `/api/v2/api-docs`, and `/api/v3` discovery where advertised.

The exact artifact contains additional commercial or feature-gated endpoint identifiers, including branch, pull-request, project-import, and worker-scaling mutation operations. Their presence alone does not make them dependencies of Community Build, and they are intentionally not promoted to required behavior here. Community project export/status and read-only worker-count display remain in scope as specified above. [Provenance: exact artifact JavaScript string catalog; pinned SonarQube server modules; tagged API adapters only as cross-reference]

## 7. Accessibility-visible behavior and keyboard interaction

The initial loading text is a polite live region. Normal application startup installs an accessibility provider and renders ordered skip links for mounted skip targets; the default target label is “Skip to content.” Forms use labels and required/invalid states, destructive actions require explicit controls, modal dialogs have headings and close actions, and authentication failure is exposed in an alert region. Dynamic page components must preserve the accessible names present in the released UI rather than relying only on color or icons. [Provenance: artifact `index.html`; tagged source `libs/shared/src/components/a11y/`, `libs/sq-server-commons/src/sonar-aligned/components/a11y/A11ySkipLinks.tsx`, and session components; matching identifiers in exact bundles]

When keyboard shortcuts are enabled and focus is not in an input, `?` toggles the shortcuts dialog and `s` opens global search. `Alt+t` focuses toast messages. Code and Measures use Up/Down to select files, Right to open, and Left to return. Issues use Up/Down between issues, Right to open, Left to return, `Alt+Up/Down` between issue locations, `Alt+Left/Right` between flows, `f` for transition, `a` for assignment, `m` for assignment to the current user, `i` for severity, `t` for tags, and `Ctrl+Enter` to submit a comment. Rules use Up/Down between rules, Right to open, and Left to return. The account profile can disable shortcuts. Current official docs also list `c` for comment, but that shortcut is not established by the exact artifact/tag evidence and is not a requirement for this release. [Provenance: exact artifact keyboard strings and issue bundle; tagged source `app/components/KeyboardShortcutsModal.tsx` and `libs/sq-server-commons/src/components/issue/Issue.tsx`; `https://docs.sonarsource.com/sonarqube-community-build/user-guide/keyboard-shortcuts.md`]

## 8. Failure, partial-result, and recovery behavior

- While the server is not in normal `UP` state, maintenance or setup surfaces replace the ordinary application. They do not present stale analysis pages as current.
- Failure of current-user, localization, or feature bootstrap leaves the application unmounted after logging a startup error; a reload after server recovery retries bootstrap. Global-navigation failure is tolerated, but navigation and edition-dependent decoration may be incomplete.
- A missing route, unavailable component, wrong qualifier, or unsupported feature shows not found or a server denial. A route's presence in JavaScript must not bypass server authorization.
- Page reads show page-specific loading, empty, error callout, or global error states. Independent sections may render when their own requests succeed; a failed section must not fabricate data. Retrying, changing filters, navigating away and back, or reloading reissues the relevant reads according to that page's cache policy.
- Failed login remains on login and exposes an alert. Failed logout exposes a global error and does not clear recent history or redirect as though logout succeeded.
- Failed mutations expose a page or global error and leave server state authoritative. Controls must not report durable success until the owning API accepts the change.
- Pending analyses do not appear as completed results. A failed compute task is visible on project/task surfaces with diagnostic detail to authorized users. Cancel applies only before processing starts.
- If a lazy JavaScript/CSS asset cannot load, the corresponding page cannot become interactive; reloading after asset/network recovery is the recovery path. There is no offline operating mode.

[Provenance: tagged startup, session, not-found, and task UI paths cross-checked to exact artifact; official background-task documentation]

## 9. Security and trust boundaries

All feature and permission decisions come from the same-origin server. Client-side route guards, disabled buttons, hidden menus, and cached navigation are usability controls, not security boundaries. Every API read and mutation must be reauthorized by its contract owner. Private-project Browse and See Source Code restrictions apply even if a user constructs a direct URL. Untrusted issue text, source, comments, project names, provider names/help, and settings originate outside the UI trust boundary and must remain safely rendered through the released text/formatting components; the UI must not convert them into executable markup.

Credentials are submitted only to the authentication contract. Provider login leaves the SPA for the server-owned initialization route. Tokens are displayed once after generation and are not recoverable from later UI reads. Base URL and return destination handling must respect the server's deployment context and redirect validation. CSRF, session-cookie attributes, Content Security Policy, cache headers, request identifiers, and endpoint validation are owned by `platform/identity-access/` and `platform/http-api/`; the packaged servlet descriptor confirms these server filters surround the static application. [Provenance: artifact `WEB-INF/web.xml`; tagged login/account components; official token and permissions documentation]

## 10. Compatibility and limits

The artifact declares `defaults and supports es6-module`, Chrome 66 or newer, Edge 88 or newer, Firefox 78 or newer, and Safari 12 or newer. The entry document uses JavaScript modules and module preload. Older or non-module browsers are outside the declared target. [Provenance: exact artifact `package.json` and `index.html`]

The UI requires the API vocabulary and navigation responses of Community Build `26.8.0.126808`; pairing it with an arbitrary server version is unsupported. It is context-path aware, requires JavaScript, has no offline mode, and cannot restore data removed by server housekeeping. Page lists, facets, and downloads inherit server pagination, size, retention, and permission limits. Commercial names in the unified payload do not expand Community Build scope.

## 11. Acceptance scenarios

1. **Context-path startup.** Given an `UP` Community Build instance mounted below a non-root context, opening the context URL first exposes polite “Loading...” text, loads assets beneath that context, fetches localization/current-user/navigation/features, replaces the placeholder with the landing page, and keeps all route links beneath the same context.
2. **Private project authorization.** Given a private project for which a user lacks Browse, directly opening `/dashboard?id=<project>` does not reveal overview, measures, issues, or source. Granting Browse permits overview; source remains unavailable until See Source Code is also granted.
3. **Login failure and success.** Given local login, empty credentials cannot be submitted after the form is expanded. Wrong credentials produce an accessible authentication-failed alert without navigation. Valid credentials replace the page with the validated return destination.
4. **Identity-provider login.** Given one advertised provider, login displays a provider-named button and initially collapses local credentials. Selecting the provider leaves the SPA for `/sessions/init/:providerKey` with the return destination encoded.
5. **Project discovery and creation.** Given Create Projects permission and one configured DevOps platform, Projects offers Local Project and that provider's import flow. A user without Create Projects may browse allowed projects but does not gain a successful create mutation by opening `/projects/create` directly.
6. **Overview drill-down.** Given a completed analysis that fails one gate condition, Overview shows failed status, current and required condition values, and a current-value control that opens the supporting issue or measure view. A passing analysis shows the pass state without invented failure detail.
7. **Issue workflow.** Given visible issues, filter controls narrow URL-backed results. Opening an issue preserves the result list and displays source/message/rule explanation. An authorized transition or assignment calls the issue API and updates displayed state; a rejected mutation shows an error and leaves server state unchanged.
8. **Hotspot review.** Given a To review hotspot and Administer Security Hotspots permission, the page displays risk-assessment/fix guidance and permits Acknowledged, Fixed, or Safe. A user without that permission can review visible information but cannot make a successful status change.
9. **Quality profile protection.** Given a built-in profile, its rules and inheritance are viewable but edit controls do not successfully mutate it. Given an authorized custom profile, activation, deactivation, parameter change, comparison, and changelog interactions use the profile APIs and refresh the affected breakdown.
10. **Quality gate ownership.** Given a gate and project, the page displays server-supplied conditions and project assignment. Editing a permitted custom gate changes server configuration; Overview status changes only after the analysis-results/quality-gate contracts provide a new evaluated result. The UI never recalculates authoritative status locally.
11. **Background-task partial state.** Given a pending report, project header/task pages show Pending and do not present it as the latest completed result. An administrator may cancel while pending. Once processing begins, cancel is unavailable. A failed task exposes error detail without partial analysis becoming current. Background Tasks shows the Community worker count and help; because `canSetWorkerCount=false`, it shows no worker-count edit control.
12. **Keyboard and skip navigation.** Given shortcuts enabled and focus outside an input, `?` opens a titled shortcuts modal; Code, Issues, Measures, and Rules honor their documented navigation keys. Given focus inside a login or filter field, `?` remains input rather than opening the modal. Keyboard focus can reach the mounted “Skip to content” link and its target.
13. **Unsupported unified feature.** Given Community Build does not advertise a commercial feature, its name or chunk in `webapp-assets` does not create navigation or a usable authorized page. Direct navigation yields not found, denial, or unavailable data rather than commercial behavior.
14. **Recovery after API outage.** Given a page read fails, the page exposes its error state without fabricated values. After service recovery, a supported retry, navigation round trip, or reload fetches fresh state. A full startup dependency failure recovers on reload after the dependency is available.
15. **Community project export.** Given an authorized project administrator opens `/project/import_export`, the page can request project export and poll `/api/project_dump/status`. It does not offer a successful import action unless the separate project-import feature is advertised; Community Build does not advertise that feature.

## 12. Provenance index

### Immutable release evidence

- SonarQube Community Build source tag `26.8.0.126808`, commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`: `gradle.properties`, `build.gradle`, and distribution assembly.
- Maven artifact and metadata: `https://repo1.maven.org/maven2/org/sonarsource/sonarqube/webapp-assets/2026.5.0.65571/`.
- Exact artifact members: `index.html`, `package.json`, `WEB-INF/web.xml`, CSS, image/font assets, and JavaScript bundles including `main-DfIfKlXm.js`, `startReactApp-BR0BPnv_.js`, `IssuesApp-O5NbpXbo.js`, `SecurityHotspotsApp-xgg2Q4fR.js`, `QualityGateHistoryApp-Ct_gQN8E.js`, `QualityGatesApp-DkZxk9ML.js`, `SettingsApp-CiBMHEYC.js`, and administration/project chunks named in this specification.

### Source cross-reference with unresolved artifact binding

- `SonarSource/sonarqube-webapp` tag `sqcb-26.8.0`, commit `4fd451f8274726c768ac636ce40c34d68392fa7a`.
- Route and startup cross-reference: `apps/sq-server/src/main/js/app/index.ts`, `app/utils/startReactApp.tsx`, and `apps/*/routes.tsx`.
- Interaction cross-reference: `apps/sq-server/src/main/js/apps/sessions/components/`, issue/hotspot/project/profile/gate components, `app/components/KeyboardShortcutsModal.tsx`, `libs/shared/src/components/a11y/`, and `libs/feature-quality-gate-history/`.
- This source cross-reference is never sufficient by itself to assert release behavior; exact artifact identifiers or official Community Build documentation must corroborate each requirement.

### Official Community Build documentation

- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/viewing-projects/retrieving-projects.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/viewing-projects/project-overview.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/viewing-projects/activity-and-history.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/viewing-projects/viewing-project-structure.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/viewing-projects/viewing-project-information.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/issues/retrieving.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/issues/reviewing.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/issues/managing.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/security-hotspots.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/keyboard-shortcuts.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/managing-your-account/introduction.md`
- `https://docs.sonarsource.com/sonarqube-community-build/user-guide/managing-tokens.md`
- `https://docs.sonarsource.com/sonarqube-community-build/quality-standards-administration/managing-quality-profiles/introduction.md`
- `https://docs.sonarsource.com/sonarqube-community-build/quality-standards-administration/managing-quality-profiles/editing-a-custom-quality-profile.md`
- `https://docs.sonarsource.com/sonarqube-community-build/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates.md`
- `https://docs.sonarsource.com/sonarqube-community-build/project-administration/creating-project/creating-manually.md`
- `https://docs.sonarsource.com/sonarqube-community-build/project-administration/creating-project/importing-repo.md`
- `https://docs.sonarsource.com/sonarqube-community-build/project-administration/setting-project-permissions.md`
- `https://docs.sonarsource.com/sonarqube-community-build/project-administration/adjusting-analysis/configuring-new-code-calculation.md`
- `https://docs.sonarsource.com/sonarqube-community-build/analyzing-source-code/background-tasks.md`
- `https://docs.sonarsource.com/sonarqube-community-build/instance-administration.md`
- `https://docs.sonarsource.com/sonarqube-community-build/instance-administration/user-management/user-permissions.md`
