# Azure DevOps Integration Specification

## 1. Identity and provenance

This specification defines the Azure DevOps integration bundled with SonarQube Community Build `26.8.0.126808`. The authoritative source is `SonarSource/sonarqube`, tag `26.8.0.126808`, commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The relevant production source is licensed under `LGPL-3.0-or-later`; this is a full clean-room specification. [A1]

The ALM mode is identified internally as `AZURE_DEVOPS` and publicly as `azure`. It supports credential validation, Azure DevOps project and Git-repository discovery, project import, binding lookup, and provider health monitoring. [A2][A3]

This release does **not** register an Azure DevOps identity provider. It defines no Azure OAuth login, user provisioning, group synchronization, or identity-to-permission mapping. Those behaviors must not be inferred from Azure ALM credentials. [A4]

## 2. Purpose, scope, and exclusions

The integration shall:

- let a system administrator create, update, list, validate, and delete one Community Build Azure DevOps setting;
- validate the setting's global personal access token;
- store and validate a separate personal access token for each SonarQube user and setting;
- list accessible Azure DevOps projects;
- list and locally filter accessible Git repositories, optionally within one project;
- import a repository as a SonarQube project and persist its Azure binding;
- resolve an Azure repository web URL for binding presentation when global credentials allow it;
- export an Azure integration health gauge. [A2][A5][A6][A7][A8]

The integration does not own local authentication or sessions, project visibility, project-key syntax, new-code policy, generic HTTP serialization, database protection, indexing, or pull-request decoration execution. These contracts belong to `platform/identity-access/`, `platform/project-configuration/`, `platform/http-api/`, `platform/persistence/`, and `platform/telemetry-monitoring/`. Import stores a binding and enables inline-annotation metadata, but no commercial decoration behavior is inferred. [A4][A9][A10]

## 3. Dependencies and owned contracts

The integration owns:

- Azure DevOps REST URL construction for API version `3.0`;
- Azure PAT transport;
- Azure project and repository response mapping;
- local repository filtering and ordering;
- provider metadata acquisition during import;
- Azure-specific binding fields and best-effort repository URL resolution;
- the Azure provider health result. [A2][A5][A6][A7]

It depends on:

- identity and access for `Administer System`, `Create Projects`, project `Administer`, project `Browse`, and user-session identity;
- project configuration for project creation, keys, names, default branches, new-code definitions, visibility, and bindings;
- persistence for ALM settings, per-user credentials, audit records, and transactions;
- HTTP API for request validation, authentication, standard status mapping, and protobuf/JSON rendering;
- telemetry and monitoring for task scheduling and gauge export;
- the shared outbound HTTP client, proxy and TLS configuration, and ALM timeouts. [A4][A9][A10][A11]

## 4. Configuration and credential modes

### 4.1 Community Build cardinality

Community Build does not enable multiple settings for one ALM. It shall permit at most one Azure DevOps setting. The setting key must also be unique across every DevOps platform setting. [A12][A13]

### 4.2 Global Azure DevOps setting

`POST /api/alm_settings/create_azure` requires `Administer System` and returns no content on success. It accepts:

| Field | Requirement | Contract |
|---|---:|---|
| `key` | required | Globally unique DevOps setting key; maximum 200 characters. |
| `url` | required | Azure DevOps base URL, including any organization/collection path; maximum 2,000 characters. |
| `personalAccessToken` | required | Global PAT used for administrator validation, health checks, and best-effort binding URL resolution; maximum 2,000 characters. |

Create persists these values but does not contact Azure DevOps. [A13]

`POST /api/alm_settings/update_azure` requires `Administer System`, existing `key`, and `url`. Optional `newKey` renames the setting and must be unique when nonblank and different. Optional `personalAccessToken` replaces the old global token when nonblank. Key maximum is 200; URL and token maxima are 2,000. If the URL changes, a new PAT is mandatory; otherwise update fails with `Please provide the Personal Access Token to update the URL.` Omission of the token while retaining the URL preserves the previous token. [A14][A15]

The setting URL is not normalized or contacted during create/update. Outbound use later requires the shared HTTP URL parser to accept it; invalid URLs fail validation or the consuming operation. [A2][A13][A14]

### 4.3 Global versus per-user PATs

The global setting PAT and current-user PAT are separate records:

- `/api/alm_settings/validate`, periodic monitoring, and Azure repository URL augmentation use the global setting PAT;
- `/api/alm_integrations/check_pat`, project/repository discovery, and import use the current SonarQube user's PAT for that setting. A successful global validation does not satisfy the user-credential requirement. [A3][A5][A6][A7][A8][A16]

`POST /api/alm_integrations/set_pat` requires a logged-in user with `Create Projects`. It accepts required `pat` with maximum 2,000 characters, optional `username`, and optional `almSetting`. Azure ignores `username` and stores the PAT unchanged. Saving inserts or replaces the credential keyed by current user UUID and immutable setting UUID, commits it, and does not contact Azure DevOps. [A16][A17]

`almSetting` may be omitted only when exactly one DevOps platform setting exists across all providers. Zero settings produce a not-found error; multiple settings require an explicit key. [A16]

`GET /api/alm_integrations/check_pat` is internal, requires `Create Projects`, requires `almSetting`, and returns no content on success. It loads the current user's saved PAT and calls the setting URL's project-list endpoint. Missing setting, missing user PAT, missing URL, or provider failure fails the request. [A18]

### 4.4 Listing, non-disclosure, and deletion

`GET /api/alm_settings/list_definitions` requires `Administer System`. Azure definitions are sorted by creation time and expose only `key` and nullable `url`; the global PAT is not populated in the response even though a legacy protobuf field exists. [A19][A20]

`GET /api/alm_settings/list` requires `Create Projects`, or project `Administer` if `project` is supplied. It returns settings sorted by key and exposes Azure type, key, and URL. [A21]

`POST /api/alm_settings/delete` requires `Administer System`. It deletes every project binding and per-user PAT associated with the setting, then deletes the setting and commits. Existing SonarQube projects are not deleted. [A22]

## 5. Credential validation

### 5.1 Administrator validation

`GET /api/alm_settings/validate?key=…` requires `Administer System` and returns no content when successful. It loads the setting by key, obtains the decrypted global PAT representation when necessary, and performs the same project-list check used by PAT validation. Validation does not persist a durable status and is not a prerequisite automatically enforced by create or update. [A3][A23]

After URL construction, administrator validation translates authentication, transport, and unsuccessful provider-response failures into `Invalid Azure URL or Personal Access Token`. A URL rejected before any request is issued retains the `Invalid Azure DevOps server URL` category. [A2][A3]

### 5.2 Azure request used for validation

Validation sends one `GET` request to:

`{baseUrl}/_apis/projects?api-version=3.0`

The authorization value is `BASIC` followed by Base64 of the UTF-8 text `accessToken:{pat}`. The literal username portion is `accessToken`; this is not a user-configurable Azure identity. [A2]

HTTP 401 becomes `Invalid personal access token`. HTTP 404 becomes `Invalid Azure URL`. Other unsuccessful responses attempt to parse Azure's `message` field and return `Unable to contact Azure DevOps server : {message}`; without a usable message they return `Unable to contact Azure DevOps server`. I/O failure includes the request URL and I/O message. [A2]

Global setting validation and `check_pat` inspect only HTTP success status; they do not read or parse a successful response body. An empty or malformed body is therefore accepted when the status is successful. [A2][A18]

Metadata operations that list or fetch projects and repositories do parse successful bodies. For those operations, malformed JSON becomes `Response from Azure for request […] could not be parsed: […]`, and a missing response body fails with `Response body is null`. [A2]

## 6. Azure DevOps project discovery

`GET /api/alm_integrations/list_azure_projects` requires a logged-in user with `Create Projects`. It requires `almSetting`, limited to 200 characters, and accepts no paging or filter parameters. [A5]

The action loads the setting URL and current user's PAT, then sends one `GET` to `{baseUrl}/_apis/projects?api-version=3.0`. It maps the provider's `value` array to results containing:

- `name`;
- `description`, converted to an empty string when Azure omits it. [A2][A5][A24]

Results are sorted by name using case-insensitive comparison. The response has no page metadata. The client neither sends continuation-token parameters nor consumes continuation headers. If the Azure deployment paginates this resource, only the values in this one response are visible. [A2][A5]

## 7. Azure DevOps repository discovery

`GET /api/alm_integrations/search_azure_repos` requires `Create Projects` and accepts:

| Parameter | Requirement | Contract |
|---|---:|---|
| `almSetting` | required | Setting key; maximum 200 characters. |
| `projectName` | optional | Azure project name; maximum 200 characters. |
| `searchQuery` | optional | Local case-insensitive substring; maximum 200 characters. |

When `projectName` is nonblank, the provider request is `{baseUrl}/{projectName}/_apis/git/repositories?api-version=3.0`. When absent or blank, it is `{baseUrl}/_apis/git/repositories?api-version=3.0`. The query is not sent to Azure. SonarQube filters the single returned `value` array locally: an absent or empty query keeps every repository; otherwise the query must occur in either repository name or owning project name, case-insensitively. [A2][A6]

Results are sorted case-insensitively by repository name and expose:

- `name`;
- `projectName` from the embedded Azure project;
- optional `sqProjectKey` and `sqProjectName` when a local binding exists for the exact Azure project-name/repository-name pair. [A6][A20]

If duplicate local bindings exist for one pair, the SonarQube project with the lexicographically smallest key is exposed. The action returns no pagination fields, makes one provider request, and does not follow Azure continuation tokens. A provider failure fails the entire action; no partial local filter result is returned. [A6]

## 8. Import and binding

### 8.1 Preferred API v2

The preferred interface is `POST /api/v2/dop-translation/bound-projects`. It requires authentication and `Create Projects`, and returns HTTP 201. Its provider-relevant JSON fields are:

| Field | Requirement | Azure contract |
|---|---:|---|
| `projectKey` | nonempty | Requested SonarQube project key. |
| `projectName` | nonempty | Requested SonarQube project name. |
| `devOpsPlatformSettingId` | nonempty | Immutable setting UUID obtained from the DOP settings endpoint. |
| `repositoryIdentifier` | nonempty | Azure Git repository name. |
| `projectIdentifier` | nullable in schema, mandatory in Azure behavior | Azure project name. |
| `newCodeDefinitionType` | optional | Shared project-creation contract. |
| `newCodeDefinitionValue` | optional | Shared project-creation contract. |
| `monorepo` | required Boolean | Stored on the binding and determines import creation category. |

The response contains `projectId`, `bindingId`, and `newProjectCreated`. [A25][A26]

`PUT /api/v2/dop-translation/bound-projects` accepts the same body and returns HTTP 200. It may reuse a project with the requested key and update its binding; the caller needs project `Administer` in addition to `Create Projects`. POST does not allow an existing project. [A25][A27]

`GET /api/v2/dop-translation/dop-settings` requires `Create Projects` and returns all settings without client-driven pagination. Azure resources have public type `azure` and fields `id`, `type`, `key`, nullable `url`, and nullable `appId`. Its page object always reports page index 1 and uses returned count for both page size and total. [A28][A29]

### 8.2 Deprecated legacy import

`POST /api/alm_integrations/import_azure_project` remains public but has been deprecated since 10.5 in favor of API v2. It requires `Create Projects`, required `projectName`, required `repositoryName`, and optional `almSetting`; each identifier is limited to 200 characters. The setting may be omitted only when exactly one Azure setting exists. Optional `newCodeDefinitionType` and `newCodeDefinitionValue` use the shared project-creation contract. The legacy request sets `monorepo` and allow-existing to false. [A30]

Legacy import does not accept a SonarQube key or name. It uses the Azure repository name as the SonarQube name and generates a sanitized unique key from Azure project name plus repository name, with an appended UUID and a 250-character final limit. [A7][A31]

### 8.3 Provider fetch and state transition

Import requires the current user's PAT and setting URL. Azure behavior requires a nonnull `projectIdentifier`, then fetches:

`{baseUrl}/{projectIdentifier}/_apis/git/repositories/{repositoryIdentifier}?api-version=3.0`

The response must provide repository name, embedded project name, and optional `defaultBranch`. The stored branch name removes every occurrence of the literal `refs/heads/`, using case-insensitive matching, from the provider value. A null or empty provider default branch becomes null. API v2's explicit local name and key take precedence over provider-derived values. [A2][A7][A32]

SonarQube then creates or reuses the project as allowed by the endpoint, creates or updates the binding, applies an optional new-code definition, commits and indexes, and returns project/binding identity. Azure bindings store:

- setting UUID;
- repository name in the binding repository field;
- Azure project name in the binding slug field;
- SonarQube project UUID;
- `inlineAnnotationsEnabled=true`;
- requested monorepo flag. [A7][A10]

An unsuccessful Azure HTTP response while fetching the import repository is reported as `Failed to fetch AzureDevOps repository '{repository}' from project '{project}' from '{url}'`. Missing user credentials and missing Azure project identifiers fail before local creation. Provider operations are reads, so an import failure requires no Azure-side rollback. [A7]

### 8.4 Binding lookup

`GET /api/alm_settings/get_binding?project=…` requires project `Browse`. An Azure binding exposes setting key, provider `azure`, repository name in `repository`, Azure project name in `slug`, setting URL, monorepo when present, and `inlineAnnotationsEnabled`. [A20][A33]

When URL, global PAT, project name, and repository name are present, the action uses the global PAT to fetch the Azure repository and adds its `webUrl` as `repositoryUrl`. Any failure during this augmentation is logged and suppressed; the binding response remains successful without `repositoryUrl`. This is deliberate partial-result behavior confined to presentation, unlike discovery and import. [A33]

## 9. Transport, pagination, and compatibility

All Azure calls use HTTP GET and API query value `api-version=3.0`. The base URL may carry an organization or collection path; Azure resource path segments are appended to it through the HTTP URL builder. Project and repository identifiers are encoded as path segments rather than interpolated as raw slashes. [A2]

Authorization uses HTTP Basic semantics with the fixed encoded principal `accessToken` and the selected PAT. Global operations select the global PAT; user-driven discovery/import selects the current user's PAT. [A2][A5][A6][A7]

The client inherits the shared outbound HTTP client, applies `sonar.alm.timeout.connect` and `sonar.alm.timeout.read` in milliseconds, and defaults each to 30,000 ms. An unparsable property is logged and falls back to 30,000 ms. Automatic redirects, including SSL redirects, are disabled. There is no automatic retry, backoff, or provider-result cache. [A11]

Project and repository discovery are intentionally unpaged from SonarQube's perspective: one Azure response is parsed, no continuation token is requested or followed, and no page data is returned. This is a compatibility limit for deployments whose Azure endpoint paginates accessible resources. [A2][A5][A6]

The required provider shape is Azure DevOps REST API `3.0` for projects and Git repositories. The integration does not negotiate newer API versions and does not distinguish Azure DevOps Services from a self-hosted compatible Azure DevOps Server by product identity. [A2]

## 10. Security and trust boundaries

Only system administrators may create or change the Azure base URL and global PAT. The URL controls outbound server traffic and is therefore an SSRF and network-egress trust boundary. Implementations must retain administrator-only mutation, honor shared proxy/TLS policy, prefer HTTPS operationally, and keep redirects disabled. [A2][A13][A14]

Only users with `Create Projects` may store/check their import PAT, enumerate provider resources, or import. A per-user PAT must never be substituted from another user or from the global PAT. Listing APIs omit secret values. Authorization headers, PATs, and encoded credentials must not be included in logs or API responses. Generic at-rest protection is owned by the persistence specification; the source can read an encrypted global PAT representation when configured. [A3][A5][A6][A7][A16][A19]

Project and repository names originate outside the trust boundary. They are used as path segments through a URL builder and as display/binding data; local project-key and project-name validation remains mandatory under the project configuration contract. Error bodies from Azure may be surfaced as provider messages and must pass through the platform's standard safe error serialization. [A2][A7][A9]

No Azure identity provider, login callback, tenant restriction, Azure user lookup, or Azure group mapping is part of this integration. A PAT authenticates outbound API requests only and shall not create a local SonarQube session. [A4]

## 11. Failure, partial-result, and recovery behavior

- Missing authentication or permission fails before provider contact under the shared 401/403 contract. Unknown setting keys produce not-found errors; missing current-user PATs produce bad-request errors. [A5][A6][A18]
- After URL construction, administrator validation translates authentication, transport, and unsuccessful provider-response failures into `Invalid Azure URL or Personal Access Token`, preserving the underlying diagnostic cause. A URL rejected before a request is issued retains the invalid-server-URL category. [A2][A3]
- Direct user PAT checks and discovery preserve Azure client categories: invalid PAT for 401, invalid URL for 404, parsed Azure message for other errors, and request-specific transport/parse errors. [A2][A18]
- Project and repository discovery return no partial list after provider, parsing, or mapping failure. Correct the URL/PAT/provider response and retry; requests are read-only and require no cleanup. [A2][A5][A6]
- Binding lookup alone has a partial-success path: repository URL resolution failure omits `repositoryUrl` while returning persisted binding fields. A later lookup may recover automatically when connectivity or the global PAT is corrected. [A33]
- Import validates new-code parameters and setting UUID before selecting the Azure creator. It fetches provider metadata before local project creation. Missing project identifier, missing user PAT, provider error, malformed response, or local validation error fails the operation. Provider-side rollback is unnecessary because all Azure calls are GET requests. [A7][A10]
- API v2 documents 400 for bad requests such as missing PAT, 401 for authentication, 403 for missing `Create Projects`, and 500 for repository-fetch failures. PUT may return 404 when an existing project is not administrable by the caller. [A25]
- Create, update, user-PAT replacement, and deletion commit explicitly. Failure before commit preserves the prior state. After setting deletion, recovery requires recreating the setting, restoring each user's PAT, and recreating bindings through import or shared binding operations. [A13][A14][A16][A22]

## 12. Lifecycle, persistence, concurrency, and monitoring

The lifecycle is: absent setting; created but unvalidated; optionally validated; user PAT stored; optionally PAT-checked; resources discovered; project imported and bound; setting updated or deleted. Validation success is not persisted. Request handlers hold no cross-request provider state and use independent database sessions. Database setting-key uniqueness, user/setting credential identity, and project-creation rules arbitrate concurrent requests; the integration adds no lock or cache. [A10][A13][A16][A23]

Monitoring starts after `sonar.server.monitoring.devops.initial.delay`, default 10,000 ms, and repeats every `sonar.server.monitoring.devops.period`, default 300,000 ms. `sonarqube_health_integration_azuredevops_status` is 0 when no Azure setting exists. When settings exist, it is 1 only when all global setting validations succeed; any validation exception sets it to 0. [A8][A34]

Creating a setting emits the shared manual DevOps-configuration telemetry event for Azure. Event transport and retention belong to the telemetry contract. [A13]

## 13. Public identifier catalog

### 13.1 SonarQube APIs

- `/api/alm_settings/create_azure`
- `/api/alm_settings/update_azure`
- `/api/alm_settings/validate`
- `/api/alm_settings/list_definitions`
- `/api/alm_settings/list`
- `/api/alm_settings/get_binding`
- `/api/alm_settings/delete`
- `/api/alm_integrations/set_pat`
- `/api/alm_integrations/check_pat`
- `/api/alm_integrations/list_azure_projects`
- `/api/alm_integrations/search_azure_repos`
- `/api/alm_integrations/import_azure_project` (deprecated)
- `/api/v2/dop-translation/dop-settings`
- `/api/v2/dop-translation/bound-projects` [A20][A25][A29][A35]

### 13.2 Provider paths and fields

- API query: `api-version=3.0`
- project collection: `/_apis/projects`
- repository collection: `/{project?}/_apis/git/repositories`
- repository item: `/{project}/_apis/git/repositories/{repository}`
- repository fields used by observable behavior: `name`, `webUrl`, `project`, `defaultBranch`; `id` and `url` are deserialized but unused by this integration's behavior
- project fields consumed: `name`, `description`
- list wrapper field: `value`
- provider error field: `message` [A2][A24][A32]

### 13.3 Configuration and metrics

- `sonar.alm.timeout.connect`
- `sonar.alm.timeout.read`
- `sonar.server.monitoring.devops.initial.delay`
- `sonar.server.monitoring.devops.period`
- `sonarqube_health_integration_azuredevops_status` [A11][A34]

## 14. Acceptance scenarios

1. **Community cardinality.** Given one Azure setting, a system administrator's attempt to create another is rejected. The existing setting remains available.
2. **Deferred create validation.** Given a syntactically accepted but unreachable URL, `create_azure` persists the setting without network access. A later `validate` call fails with `Invalid Azure URL or Personal Access Token`.
3. **Global PAT success.** Given a URL whose `/_apis/projects?api-version=3.0` endpoint returns any successful status for the global PAT, administrator validation returns no content even when the successful response body is empty or malformed.
4. **Global PAT failure.** Given Azure returns HTTP 401, validation fails; the underlying provider category is invalid personal access token and the administrator-facing validation message is the normalized URL-or-PAT error.
5. **URL update protection.** Given an existing setting, changing `url` without `personalAccessToken` fails and preserves the prior URL and token. Supplying both allows the update.
6. **Per-user separation.** Given a globally valid setting but no PAT for the current user, project discovery fails with a missing personal-access-token error. Saving the user's PAT enables a later request without altering the global PAT.
7. **Project listing.** Given Azure returns projects with names in mixed case and one null description, the response is case-insensitively sorted and substitutes an empty description for the null value.
8. **Project listing limit.** Given Azure indicates more project pages outside the response body, SonarQube returns only the current response's `value` items and no continuation metadata.
9. **Repository project filter.** Given `projectName=Payments`, discovery calls the project-scoped repository path. Without `projectName`, it calls the organization/collection-wide path.
10. **Repository query filter.** Given `searchQuery=api`, repositories whose repository or project name contains `api` in any case are retained; all others are omitted. The filter is local and causes no second Azure request.
11. **Binding annotation.** Given an existing local binding for Azure project `Payments` and repository `ledger`, discovery adds the bound SonarQube key and name. Duplicate bindings resolve to the lexicographically smallest local key.
12. **API v2 import.** Given a valid setting UUID, current-user PAT, Azure project and repository names, explicit local key/name, and `monorepo=false`, POST fetches one repository, removes every case-insensitive `refs/heads/` occurrence from its default-branch value, creates and binds the project, enables inline-annotation metadata, and returns 201 with IDs and `newProjectCreated=true`.
13. **Mandatory Azure project identifier.** Given an API v2 request with a repository name but no `projectIdentifier`, import fails before provider fetch with an Azure project-identifier error.
14. **Idempotent rebinding.** Given an existing project and a caller with `Create Projects` plus project `Administer`, PUT updates its Azure binding and returns `newProjectCreated=false`. Without project administration, it does not update or disclose the project.
15. **Provider parse failure.** Given a successful HTTP response with malformed JSON during discovery, the request fails with the Azure parse-error category and returns no partial repositories. Retrying after correction succeeds.
16. **Best-effort binding URL.** Given a persisted binding but an expired global PAT, `get_binding` still returns setting, project, repository, and flags while omitting `repositoryUrl`. Replacing the global PAT allows a later request to include Azure `webUrl`.
17. **Setting deletion.** Given an Azure setting with user PATs and bindings, deletion removes those credentials and binding rows but leaves local projects. Subsequent discovery requires recreated configuration and a new user PAT.
18. **Health gauge.** Given no Azure setting, the gauge is 0. Given a setting that passes project-list validation, it becomes 1. Any later validation exception returns it to 0.
19. **No identity behavior.** Given a valid Azure PAT, no Azure login option, local account, group, or session is created. The PAT is usable only for the outbound ALM operations described here.

## 15. Provenance index

- **[A1]** `manifest/release-baseline.md`; `manifest/license-map.md`; upstream `LICENSE.txt`, pinned commit.
- **[A2]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/azure/AzureDevOpsHttpClient.java`.
- **[A3]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/azure/AzureDevOpsValidator.java`.
- **[A4]** `manifest/dependency-map.md`; `manifest/component-inventory.md`.
- **[A5]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/azure/ListAzureProjectsAction.java`.
- **[A6]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/azure/SearchAzureReposAction.java`.
- **[A7]** `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/azuredevops/AzureDevOpsProjectCreator.java`.
- **[A8]** `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/AzureMetricsTask.java`.
- **[A9]** `manifest/dependency-map.md`.
- **[A10]** `server/sonar-webserver-common/src/main/java/org/sonar/server/common/project/ImportProjectService.java`.
- **[A11]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/TimeoutConfigurationImpl.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/azure/AzureDevOpsHttpClient.java`.
- **[A12]** `server/sonar-server-common/src/main/java/org/sonar/server/almsettings/MultipleAlmFeature.java`.
- **[A13]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateAzureAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsSupport.java`.
- **[A14]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/UpdateAzureAction.java`.
- **[A15]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsSupport.java`.
- **[A16]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/SetPatAction.java`.
- **[A17]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/CredentialsEncoderHelper.java`.
- **[A18]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/CheckPatAction.java`.
- **[A19]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/ListDefinitionsAction.java`.
- **[A20]** `sonar-ws/src/main/protobuf/ws-alm_settings.proto`; `sonar-ws/src/main/protobuf/ws-alm_integrations.proto`.
- **[A21]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/ListAction.java`.
- **[A22]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/DeleteAction.java`.
- **[A23]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/ValidateAction.java`.
- **[A24]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/azure/GsonAzureProject.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/azure/GsonAzureProjectList.java`.
- **[A25]** `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/BoundProjectsController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/request/BoundProjectCreateRestRequest.java`.
- **[A26]** `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/response/BoundProjectCreateRestResponse.java`.
- **[A27]** `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/DefaultBoundProjectsController.java`.
- **[A28]** `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/dop/response/DopSettingsResource.java`.
- **[A29]** `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/dop/controller/DefaultDopSettingsController.java`.
- **[A30]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/azure/ImportAzureProjectAction.java`.
- **[A31]** `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almintegration/ProjectKeyGenerator.java`.
- **[A32]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/azure/GsonAzureRepo.java`.
- **[A33]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GetBindingAction.java`.
- **[A34]** `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ServerMonitoringMetrics.java`; `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/DevOpsMetricsTask.java`.
- **[A35]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsWs.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/AlmIntegrationsWs.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/WebApiEndpoints.java`.
