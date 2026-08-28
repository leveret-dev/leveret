# GitLab Integration Specification

## 1. Identity and baseline

This specification defines the GitLab integration bundled in SonarQube Community Build `26.8.0.126808`. Its authoritative source is the `SonarSource/sonarqube` tag `26.8.0.126808`, commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The production source is licensed under `LGPL-3.0-or-later`. No GPL or AGPL copy shortcut applies. The released distribution has SHA-256 `ea1c5c1932f9c25350eafc4cdb1a839527c117e5d98b5fcf222a715b6b50a1f2`. [Provenance: `manifest/release-baseline.md`; `manifest/license-map.md`; upstream `LICENSE.txt`]

The identity-provider key is `gitlab`, its display name is `GitLab`, and its authentication display uses `/images/alm/gitlab.svg` on color `#6a4fbb`. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabIdentityProvider.java`]

## 2. Purpose, scope, and ownership

The integration owns these provider-specific contracts:

- GitLab OAuth authorization, token exchange, REST identity retrieval, optional GraphQL group discovery, group admission, and identity handoff;
- GitLab REST validation, project search, project and branch retrieval, group and member retrieval, and provider-specific failure translation;
- GraphQL group pagination and project-detail lookup;
- GitLab DevOps setting and per-user token handoff used by project import;
- provider-specific project metadata, automatic-provisioning controls, role mappings, synchronization queue handoff, and GitLab integration health measurement.

It depends on `platform/identity-access/` for local users, sessions, signup enforcement, CSRF state, local group membership, and authorization. It depends on `platform/project-configuration/` for project creation, binding, visibility, permission persistence, and new-code definitions; on `platform/http-api/` for generic routing, request validation, media types, and errors; on `platform/persistence/` for storage; and on `platform/telemetry-monitoring/` for metric exposition. Those shared contracts are not redefined here. [Provenance: `manifest/dependency-map.md`]

Generic session and local permission lifecycle, merge-request decoration, scanner behavior, GitLab's own service implementation, and commercial extensions are excluded. The production tree exposes provisioning configuration and provider clients but not a GitLab-specific reconciliation task executor; this specification does not infer unobserved reconciliation rules.

## 3. Configuration model and precedence

### 3.1 Global OAuth and provisioning settings

The following keys form the single global GitLab authentication and provisioning configuration. Secured values must use the platform's secured-setting handling and must not be returned in configuration read responses. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabSettings.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`]

| Key | Meaning | Defined default and effective behavior |
|---|---|---|
| `sonar.auth.gitlab.enabled` | Enables GitLab login | `false`; effective only when application ID and secret are non-null. |
| `sonar.auth.gitlab.url` | GitLab web base URL | `https://gitlab.com`; one trailing `/` is removed when read. REST identity base is this value plus `/api/v4`; GraphQL base is this value plus `/api/graphql`. |
| `sonar.auth.gitlab.applicationId.secured` | OAuth application ID | Null when absent. |
| `sonar.auth.gitlab.secret.secured` | OAuth application secret | Null when absent. |
| `sonar.auth.gitlab.allowUsersToSignUp` | Allows new local users through GitLab | Public property default `true`. An API-v2 create request that omits the optional field stores `false`. |
| `sonar.auth.gitlab.allowedGroups` | Allowed root group paths | Empty set when absent. A configured path also permits its subgroups. |
| `sonar.auth.gitlab.allowAllGroups` | Permits every group visible to provisioning token | `false`; effective only with automatic provisioning, and always forced false for `gitlab.com`. |
| `sonar.auth.gitlab.groupsSync` | Enables OAuth group retrieval and group handoff | `false`; deprecated alias `sonar.auth.gitlab.sync_user_groups` remains recognized by the property-definition contract. |
| `provisioning.gitlab.token.secured` | Group or personal token for automatic provisioning | Null when absent or empty. |
| `provisioning.gitlab.enabled` | Selects automatic provisioning rather than JIT | `false`; effective only when GitLab authentication is effectively enabled. |
| `sonar.auth.gitlab.userConsentForPermissionProvisioningRequired` | Upgrade-consent marker | Presence, rather than parsed value, means consent is required. |

Group-path matching is exact at the root boundary: configured `parent` permits `parent` and values beginning `parent/`, but not `parent-other`. `allowAllGroups` takes precedence over `allowedGroups` only when it is effective. GitLab.com detection trims the URL, adds `https://` for host parsing when no scheme exists, compares host case-insensitively to `gitlab.com`, and treats malformed URLs as non-cloud for this one classification step. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabSettings.java`]

Direct properties are consumed by OAuth and provisioning runtime. API-v2 configuration writes those global properties. Separate DevOps Platform settings use an API URL and personal access token for import; they do not override global OAuth configuration. Selection of a DevOps setting is explicit by key/UUID where provided, with unique-setting fallback only on APIs that document it. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/ImportHelper.java`]

### 3.2 API-v2 global configuration

`/api/v2/dop-translation/gitlab-configurations` supports:

- `GET /{id}` for one configuration;
- `GET` for search;
- `POST` for creation;
- `PATCH /{id}` with `application/merge-patch+json` for partial update;
- `DELETE /{id}`, returning no content.

Create, update, and delete require system-administrator authority. Get and search require login. System administrators receive full non-secret configuration; other users receive only `id`, `enabled`, and `provisioningType`. Only ID `gitlab-configuration` is valid, and only one configuration may exist. Search always reports page index `1`, page size `1000`, and a count of zero or one. Invalid IDs and missing configurations are not found; a second creation is rejected. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/controller/GitlabConfigurationController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/controller/DefaultGitlabConfigurationController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/converter/GitlabConfigurationResponseGenerator.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/WebApiEndpoints.java`]

Creation requires `enabled`, nonempty `applicationId`, `url`, and `secret`, non-null `synchronizeGroups`, `allowedGroups`, and `provisioningType`, and accepts optional `allowAllGroups`, `provisioningToken`, and `allowUsersToSignUp`. `provisioningType` is `JIT` or `AUTO_PROVISIONING`. Omitted optional booleans are stored false. Duplicate group paths collapse because storage is set-valued. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/request/GitlabConfigurationCreateRestRequest.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/controller/DefaultGitlabConfigurationController.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/ProvisioningType.java`]

Administrator responses contain `id`, `enabled`, `applicationId`, `url`, `synchronizeGroups`, sorted `allowedGroups`, `allowAllGroups`, `allowUsersToSignUp`, `provisioningType`, `isProvisioningTokenSet`, and nullable `errorMessage`. OAuth secret and provisioning token are never returned. Non-administrator responses intentionally omit URL, application ID, groups, signup policy, token status, and validation error. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/response/GitlabConfigurationRestResponseForAdmins.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/response/GitlabConfigurationRestResponseForLoggedInUsers.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/converter/GitlabConfigurationResponseGenerator.java`]

An absent merge-patch field preserves the current value. Non-null fields may be replaced but not cleared with null; `provisioningToken` is nullable and therefore may be replaced or cleared, but a present non-null value must have at least one character. Updating `url` requires `secret` in the same patch. `allowedGroups` may not be null. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/request/GitlabConfigurationUpdateRestRequest.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/controller/DefaultGitlabConfigurationController.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`]

These configuration invariants are mandatory on create and update:

- automatic provisioning requires at least one allowed group unless `allowAllGroups` is true;
- `allowAllGroups` is invalid with JIT;
- `allowAllGroups` is invalid when the selected URL's host is `gitlab.com`;
- when a patch changes from automatic provisioning to JIT and omits `allowAllGroups`, the stored value becomes false;
- otherwise an omitted `allowAllGroups` preserves true only while the effective provisioning type remains automatic.

[Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`]

When enabled, administrator response generation validates the configuration live. JIT performs URL validation only. Automatic provisioning additionally validates presence and usability of the provisioning token, read access, and write access. Exceptions are returned as `errorMessage`; disabled configurations return no validation error. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabGlobalSettingsValidator.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/converter/GitlabConfigurationResponseGenerator.java`]

Pinned compatibility detail: this response-validation path appends `/api/v4` and then replaces every `//` sequence with `/`. Consequently a conventional URL containing `https://` is passed to validation with one slash after the scheme. OAuth and normal runtime URL construction do not use that replacement. An implementation claiming exact observable compatibility must account for the resulting `errorMessage` behavior, while transport correction belongs to a later release rather than this baseline. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`]

### 3.3 DevOps Platform settings

Project import uses separately persisted GitLab settings identified by a user-chosen key. `POST /api/alm_settings/create_gitlab` requires system administration and accepts required `key` up to 200 characters, required API `url` and `personalAccessToken` up to 2000 each. URL surrounding whitespace is trimmed, and key uniqueness is enforced. `POST /api/alm_settings/update_gitlab` requires current key and URL, accepts an optional new key and optional token, preserves the old token when the supplied token is absent or blank, and requires a new token if the URL changes. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsWs.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateGitlabAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/UpdateGitlabAction.java`]
Community Build does not expose the `multiple-alm` feature, so supported creation rejects a second GitLab DevOps setting when one already exists. The key remains part of wire compatibility. Import's multiple-setting branch applies only to pre-existing or externally migrated data, not to a second setting created through this Community API. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/almsettings/MultipleAlmFeature.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsSupport.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateGitlabAction.java`]

These URLs are GitLab REST API bases such as a base ending `/api/v4`, unlike global OAuth `sonar.auth.gitlab.url`, which is a web base. The DevOps setting's administrator token is used for setting validation and health. Each importing user separately stores a personal token through `POST /api/alm_integrations/set_pat`; that route requires login and `Create Projects`, accepts a token up to 2000 characters, and inserts or replaces the token for the current user and selected setting. `GET /api/alm_integrations/check_pat` performs a GitLab read-permission check for the stored token and returns no content on success. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/SetPatAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/CheckPatAction.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`]

When an import endpoint accepts optional `almSetting`, an explicit key wins. Without one, exactly one GitLab setting must exist; zero produces not found and more than one requires the key. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/ImportHelper.java`]

## 4. OAuth authentication and identity handoff

### 4.1 Authorization request

GitLab authentication is enabled only when `sonar.auth.gitlab.enabled` is true and application ID and secret are present. Starting login while disabled fails. The integration generates CSRF state through the identity-access context and redirects to `{url}/oauth/authorize`. When group synchronization is false it requests scope `read_user`; when group synchronization is true it requests `api`. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabIdentityProvider.java`; `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/ScribeGitLabOauth2Api.java`]

### 4.2 Callback and identity

The callback verifies CSRF state before exchanging `code` at `{url}/oauth/token`. It retrieves the current user from `{url}/api/v4/user` using the OAuth access token. Provider ID is the decimal GitLab numeric ID; provider login is `username`; name and email are passed through as returned. The resulting external identity is handed to identity-access, which owns local-user and session behavior. Non-success OAuth REST responses and malformed or unavailable identity data abort authentication; I/O and execution failures are wrapped, and interruption restores interrupted state. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabIdentityProvider.java`; `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabRestClient.java`; `server/sonar-auth-common/src/main/java/org/sonar/auth/OAuthRestClient.java`]

### 4.3 Group retrieval, admission, and precedence

Group retrieval and allowed-group admission occur only when `sonar.auth.gitlab.groupsSync` is true. If group synchronization is false, no group query is made and `allowedGroups` does not reject the OAuth login in this pinned implementation. Signup enforcement remains owned by identity-access. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabIdentityProvider.java`]

With synchronization enabled, GraphQL group selection follows this precedence:

1. If `allowedGroups` is empty, `allowAllGroups` is effective, or any allowed path has fewer than three characters, retrieve all current-user groups with no search term.
2. Otherwise, issue one GraphQL search per allowed group path using a fixed pool of at most five concurrent requests, then combine results.
3. Convert returned nodes to their `fullPath` values and de-duplicate into a set.
4. If allowed paths are nonempty and `allowAllGroups` is not effective, require at least one returned path to equal an allowed path or be its subgroup. Otherwise reject with unauthorized.
5. Supply the complete returned path set to the external identity; identity-access applies matching local-group membership.

The all-groups fallback for short names exists because GitLab GraphQL search requires at least three characters. Failure of any parallel request aborts the callback; interruption is preserved. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabIdentityProvider.java`; `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabSettings.java`]

## 5. GraphQL contracts

### 5.1 Current-user groups

Group lookup posts JSON to `{url}/api/graphql` with `Authorization: Bearer <OAuth token>`. It requests `currentUser.groups`, optional search text, pages of 100, `fullPath`, and `pageInfo` fields `hasNextPage` and `endCursor`. The first cursor is null; each subsequent request uses the prior end cursor until `hasNextPage` is false. A missing GitLab URL fails before transport. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabGraphQlClient.java`; `server/sonar-server-common/src/main/java/org/sonar/server/common/graphql/GraphQlClient.java`]

A non-success HTTP response, unreadable or invalid JSON, absent expected data, or a GraphQL response containing errors aborts the whole operation. Results accumulated from earlier pages are not returned as partial success. The error surface distinguishes HTTP status/body, deserialization failure, and GraphQL error payload. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/common/graphql/GraphQlClient.java`; `server/sonar-server-common/src/main/java/org/sonar/server/common/graphql/GsonGraphQlAnswer.java`]

### 5.2 Project details

The integration also provides a GraphQL project-detail operation for GitLab global IDs. It accepts a list of IDs, partitions it into batches of at most 100, and for each batch pages `projects(ids: ...)` in groups of 100. Returned fields are global `id`, `name`, and `visibility`. Numeric ID conversion takes the decimal suffix following the last `/` and fails if ID is null or nonnumeric. An empty input produces an empty result without transport. No production consumer of this project-detail operation is present in the pinned Community Build tree; it remains a provider-client compatibility capability rather than an asserted import path. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabGraphQlClient.java`; `server/sonar-auth-gitlab/src/test/java/org/sonar/auth/gitlab/GitLabGraphQlClientTest.java`; repository search for `getProjectsDetails(` at pinned commit]

## 6. REST transport and authentication

### 6.1 OAuth REST

OAuth identity REST uses the OAuth library to sign a GET request with the exchanged token. Only successful responses are accepted. Generic OAuth pagination, where used, appends `per_page=100` and follows `Link` headers with `rel="next"`. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabRestClient.java`; `server/sonar-auth-common/src/main/java/org/sonar/auth/OAuthRestClient.java`]

### 6.2 Personal and provisioning tokens

DevOps setting, per-user import, and provisioning calls authenticate with GitLab's `Private-Token` or `PRIVATE-TOKEN` header. Direct validation and project calls use the exact token as the header value. Shared paginated calls use the GitLab token adapter and provider header contract. No GitLab API-version header is added. Rate-limit fields are `ratelimit-remaining`, `ratelimit-limit`, and `ratelimit-reset`. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabHeaders.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabToken.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericApplicationHttpClient.java`]

Both direct and shared GitLab clients inherit configured proxy behavior and apply configured connect and read timeouts. Direct calls disable both ordinary and SSL redirects; shared calls disable ordinary redirects. Redirect status is therefore returned and translated rather than followed with a credential. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericApplicationHttpClient.java`]

Shared pagination appends `per_page=100`, follows `Link` next URLs, and pauses until reset after at least 90 percent of the reported quota has been consumed. Missing complete rate-limit headers disables this pause. Non-2xx aborts the operation and returns no partial set. Interrupted waiting restores interrupted state. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericPaginatedHttpClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/RatioBasedRateLimitChecker.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabPaginatedHttpClient.java`]

### 6.3 Validation and failures

GitLab setting validation uses these calls:

- URL check: unauthenticated `GET {apiBase}/projects`, requiring success and a parseable project array;
- token check: authenticated `GET {apiBase}/user`, requiring a parseable ID;
- read check: authenticated `GET {apiBase}/projects`;
- write check: authenticated `POST {apiBase}/markdown` with JSON text, requiring a parseable markdown response.

JIT global validation stops after the URL check. Automatic global validation and DevOps-setting health perform all applicable checks. Encrypted tokens are decrypted before validation. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabGlobalSettingsValidator.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`]

Provider failure translation is deterministic where response evidence permits it: a `401` body reporting revocation becomes “Your GitLab token was revoked”; expiry becomes “Your GitLab token is expired”; `403` with `insufficient_scope` becomes insufficient scope; other `403` reports forbidden access and advises checking token permissions and IP restrictions; `429` reports rate limit exceeded; other `401` reports invalid personal access token; redirect reports incorrect URL; all other non-success responses use the operation-specific failure message. Non-JSON validation payloads have parse-specific errors. I/O becomes an operation-level configuration or state failure after logging the URL and provider error. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabServerException.java`]

## 7. Groups, users, projects, and membership APIs

Provisioning-facing REST client operations are:

- `/groups`, fully paginated, returning group `id`, `full_path`, and nullable `marked_for_deletion_on`;
- `/groups/{groupId}/members`, fully paginated, returning direct group members;
- `/groups/{groupId}/members/all`, fully paginated, returning inherited and direct group members;
- `/projects/{projectId}/members/all`, fully paginated, returning member numeric `id`, numeric `access_level`, and nullable custom `member_role.name`;
- `/projects/{projectId}`, returning project metadata;
- `/projects/{projectId}/repository/branches`, returning branches used to discover the default branch.

Null JSON lists from shared group/member responses become empty lists before conversion to sets. Group deletion state is observable through `marked_for_deletion_on`; the client model reports a group as marked when that value is non-null. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`; `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GsonGroup.java`; `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GsonUser.java`; `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GsonProjectMember.java`; `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GsonMemberRole.java`]

A repository-access compatibility check for merge-request decoration requests `/projects?min_access_level=20&id_after={id-1}&id_before={id+1}` and treats the first returned project as proof of Reporter-or-higher access. This path preserves support for older GitLab APIs. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`]

## 8. Project search and import

### 8.1 Search

`GET /api/alm_integrations/search_gitlab_repos` requires login plus `Create Projects`, explicit `almSetting`, a stored per-user token, optional `projectName` up to 200 characters, page parameter `p`, and page-size parameter `ps`. Default page size is 20 and maximum is 100. It calls the configured API base at `/projects` with `archived=false`, `simple=true`, `membership=true`, name ascending, optional URL-encoded search, page, and page size. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/gitlab/SearchGitlabReposAction.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`]

The response uses GitLab headers `X-Page`, `X-Per-Page`, and optional `X-Total`. Missing page or page-size headers fail; nonnumeric headers fail. Each repository result contains numeric `id`, `name`, namespace display path, slug, namespace slug path, and web URL. If already bound, it also contains SonarQube project key and name. When multiple local projects share a provider ID, the natural-order smallest project key wins. Namespace display values are derived by removing the final project name or slug segment from GitLab's namespace-qualified fields. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/gitlab/SearchGitlabReposAction.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/Project.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/ProjectList.java`]

### 8.2 Preferred API-v2 import

`POST /api/v2/dop-translation/bound-projects` creates a bound project. `PUT` at the same path creates or updates idempotently. Inputs are explicit `projectKey`, `projectName`, DevOps setting UUID, numeric GitLab project ID encoded as `repositoryIdentifier`, optional new-code fields, and required `monorepo`; `projectIdentifier` is unused for GitLab. POST returns project UUID, binding UUID, and whether a new project was created with HTTP `201`. PUT returns the same shape with HTTP `200`; updating an existing project also requires project administration. Both require login, `Create Projects`, and a stored per-user token. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/BoundProjectsController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/DefaultBoundProjectsController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/request/BoundProjectCreateRestRequest.java`]

### 8.3 Legacy import

Deprecated `POST /api/alm_integrations/import_gitlab_project` requires numeric-string `gitlabProjectId`, optional `almSetting`, and optional new-code type/value. It requires login and `Create Projects`, selects configuration using section 3.3 precedence, and returns created project key, name, qualifier, and visibility through the legacy protobuf/JSON media contract. A nonnumeric project identifier is rejected before provider access. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/gitlab/ImportGitLabProjectAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/ImportHelper.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/gitlab/GitlabDevOpsProjectCreationContextService.java`]

### 8.4 Provider metadata and state

For either import API, the adapter reads the current user's token, calls `/projects/{id}`, then lists branches and selects the first branch marked default. GitLab `name` is the provider project name; `path_with_namespace` is the provider full name and legacy key source; decimal ID is the binding repository identifier; visibility is public only when GitLab returns exactly `public`; and missing default branch is represented as null. A missing user token, invalid numeric ID, provider error, parse error, or branch error aborts import rather than creating a partial binding. Project transaction and local lifecycle belong to project configuration. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/gitlab/GitlabDevOpsProjectCreationContextService.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/Project.java`]

The GitLab project-creator factory supports explicit import but returns no creator for scanner characteristics, so GitLab settings are not auto-detected from analysis characteristics by this integration. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/gitlab/GitlabProjectCreatorFactory.java`]

## 9. Provisioning, roles, and lifecycle

### 9.1 State transitions

Creating a global configuration with `AUTO_PROVISIONING`, or patching `provisioningType` to `AUTO_PROVISIONING`, queues synchronization after requiring:

- automatic provisioning as the effective type;
- GitLab authentication enabled;
- a nonblank provisioning token;
- no different provider already managing the instance.

The GitLab update path queues whenever the patch explicitly selects automatic provisioning, even if the previous type was already automatic. A trigger failure prevents the surrounding create or update transaction from committing. Task identifier for project permission work is `GITLAB_PROJECT_PERMISSIONS_PROVISIONING`. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`; `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabSettings.java`]

Changing from automatic provisioning to JIT deletes external-group records owned by identity provider `gitlab`. Deleting the global configuration removes all configuration properties listed in section 3.1 except the separately handled upgrade-consent marker and also deletes GitLab external-group records. Provider-independent local users, sessions, groups, and permissions remain identity-access concerns. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`]

The bundled client exposes `POST /api/v2/dop-translation/gitlab-synchronization-runs` as a no-body manual trigger. No matching controller is present in the inspected Community Build production source, so server availability of that route is not asserted. The observed server-side trigger contract is the managed-instance queue handoff described above. [Provenance: `sonar-ws/src/main/java/org/sonarqube/ws/client/gitlab/synchronization/run/GitlabSynchronizationRunService.java`; `server/sonar-server-common/src/main/java/org/sonar/server/management/ManagedInstanceService.java`; repository search for `gitlab-synchronization-runs` at pinned commit]

The inspected Community Build production tree provides group/member/project retrieval, configuration, mapping persistence, and queue contracts but no GitLab-specific synchronization-task executor. It therefore does not provide source evidence for user deactivation, group creation/deletion, nested-group reconciliation order, or project-permission convergence. Those behaviors must not be inferred from commercial editions. [Provenance: repository search for `GITLAB_PROJECT_PERMISSIONS_PROVISIONING`, `getAllProjectMembers(`, and `getDirectGroupMembers(` at pinned commit]

### 9.2 Permission mappings

Default GitLab role mappings are:

| GitLab role | SonarQube project permissions |
|---|---|
| `guest` | `user` |
| `reporter` | `user`, `codeviewer` |
| `developer` | `user`, `codeviewer`, `issueadmin`, `securityhotspotadmin`, `scan` |
| `maintainer` | `user`, `codeviewer`, `issueadmin`, `securityhotspotadmin`, `scan`, `admin` |
| `owner` | `user`, `codeviewer`, `issueadmin`, `securityhotspotadmin`, `scan`, `admin` |
| `planner` | `user`, `codeviewer` |
| `security manager` | `user`, `codeviewer`, `securityhotspotadmin`, `issueadmin` |

The `planner` and `security manager` upgrade migrations add their defaults only when no mapping for that role exists, case-insensitively, and when GitLab provisioning is not already enabled. Existing custom mappings and actively provisioned instances are preserved. Provider member responses also preserve nullable custom role name beside numeric access level. [Provenance: `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/PopulateInitialSchema.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202603/AddGitlabRolePermissionMapping.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202603/AddGitlabPlannerRolePermissionMapping.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202603/AddGitlabSecurityManagerRolePermissionMapping.java`; `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GsonProjectMember.java`]

The bundled Java client can add a mapping by posting `gitlabRole` plus six booleans (`user`, `codeViewer`, `issueAdmin`, `securityHotspotAdmin`, `admin`, `scan`) to `/api/v2/dop-translation/gitlab-permission-mappings`, and can modify one with merge patch at the same path plus a lowercased role segment. No matching server controller is present in the inspected Community Build production source, so server availability of those routes is not asserted. [Provenance: `sonar-ws/src/main/java/org/sonarqube/ws/client/gitlab/provisioning/permissions/GitlabPermissionService.java`; `sonar-ws/src/main/java/org/sonarqube/ws/client/gitlab/provisioning/permissions/AddOrModifyGitlabPermissionMappingRequest.java`; `sonar-ws/src/main/java/org/sonarqube/ws/client/github/provisioning/permissions/SonarqubePermissions.java`]

## 10. Persistence, concurrency, and lifecycle

Global configuration is represented by global properties and a single stable ID. Community Build permits one separately keyed GitLab DevOps setting; compatibility branches can still read pre-existing data with multiple keys. Per-user import tokens are keyed by user and DevOps setting and are inserted or replaced transactionally. Configuration create, patch, JIT transition cleanup, and delete use database transactions; failed validation or queue handoff prevents the intended configuration commit. Thread-local settings are refreshed for changed public properties. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`; `server/sonar-server-common/src/main/java/org/sonar/server/almsettings/MultipleAlmFeature.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/alm/pat/AlmPatDao.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/SetPatAction.java`]

OAuth group searches use at most five worker threads for independent allowed-group searches and wait for every future. GraphQL page processing within one search is sequential. REST pagination is sequential. Configuration reads and provider network validation do not return a partially validated configuration: the configuration resource is returned with one error message, while list/project operations fail entirely. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabIdentityProvider.java`; `server/sonar-server-common/src/main/java/org/sonar/server/common/graphql/GraphQlClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericPaginatedHttpClient.java`]

## 11. Health metric

After initial delay configured by `sonar.server.monitoring.devops.initial.delay` or 10,000 ms, and every `sonar.server.monitoring.devops.period` or 300,000 ms, the GitLab health task validates every persisted GitLab DevOps setting. Gauge `sonarqube_health_integration_gitlab_status` is `1` only when at least one setting exists and all validate; it is `0` when none exists or any validation throws. Validation checks URL, token, read access, and write access. [Provenance: `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/DevOpsMetricsTask.java`; `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/GitlabMetricsTask.java`; `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ServerMonitoringMetrics.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabGlobalSettingsValidator.java`]

## 12. Security, recovery, compatibility, and limits

- OAuth CSRF state must be verified before code exchange. GraphQL and REST identity fields alone never establish a local session. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabIdentityProvider.java`]
- OAuth secret, provisioning token, DevOps administrator token, per-user import token, and OAuth access token are trust-boundary credentials. Configuration responses disclose neither secret nor token and disclose only `isProvisioningTokenSet` to administrators. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/response/GitlabConfigurationRestResponseForAdmins.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/converter/GitlabConfigurationResponseGenerator.java`]
- Updating a provider URL requires resubmitting the corresponding OAuth secret in global configuration and the personal access token in a DevOps setting. Redirects are not followed, reducing token forwarding to attacker-selected locations. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/UpdateGitlabAction.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`]
- Shared REST pagination treats an absolute provider-supplied `rel="next"` URL as the next destination and sends the current token there. The configured GitLab endpoint and GitLab response are therefore trusted to keep next links on an authorized host. Redirect blocking does not constrain this explicit next-link behavior. GraphQL pagination does not accept provider-supplied URLs; it reuses the configured endpoint and only consumes cursors. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericApplicationHttpClient.java`; `server/sonar-server-common/src/main/java/org/sonar/server/common/graphql/GraphQlClient.java`]
- `allowAllGroups` is intentionally blocked on GitLab.com and outside automatic provisioning because a broadly visible token could grant access to an unbounded population. Self-managed operators enabling it accept that every group visible to the token may become an admission source and that OAuth login may fetch many groups. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabSettings.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`]
- GraphQL search text and ID lists are variables rather than URL fragments. REST project-name search is URL-encoded. Group IDs and numeric project IDs enter provider paths and must originate from parsed provider records or validated numeric input. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabGraphQlClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/gitlab/GitlabDevOpsProjectCreationContextService.java`]
- OAuth group and GraphQL project pages are 100 entries. GraphQL project arguments are chunked to 100. REST search page size is at most 100. No total cap is imposed by the integration; provider pagination and quota apply. [Provenance: `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabGraphQlClient.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/gitlab/SearchGitlabReposAction.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericPaginatedHttpClient.java`]
- Failed read pagination and GraphQL traversal return no partial results. Retrying search and validation is safe. POST import may conflict with an already-created project; PUT is the idempotent create-or-update recovery path. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/common/graphql/GraphQlClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericPaginatedHttpClient.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/BoundProjectsController.java`]

## 13. Acceptance scenarios

1. **Disabled or incomplete OAuth configuration.** Given `sonar.auth.gitlab.enabled=true` but no secret, when providers are evaluated, GitLab is disabled and no OAuth redirect is offered.
2. **Scope precedence.** Given group synchronization off, when login starts, requested scope is `read_user`; with synchronization on, requested scope is `api`.
3. **CSRF rejection.** Given a callback whose state does not match the identity-access state, when callback runs, no token exchange or local authentication occurs.
4. **Identity mapping.** Given GitLab user ID `42`, username `alex`, name and email, when callback succeeds, provider ID is `42`, provider login is `alex`, and returned name/email are handed to identity-access.
5. **Allowed groups with sync on.** Given allowed root `engineering`, sync enabled, and returned membership `engineering/platform`, when callback runs, the user is admitted and that full path is included in the external group set.
6. **Allowed groups with sync off.** Given allowed root `engineering`, sync disabled, and a user outside that group, when callback runs, this integration makes no group query and does not enforce the allowlist in the pinned implementation.
7. **Short group fallback.** Given allowed group `it`, when callback retrieves groups, it uses an unfiltered all-groups GraphQL query rather than an invalid two-character search, then filters admission by exact root/subgroup semantics.
8. **Parallel search failure.** Given six allowed roots and one GraphQL request fails, when group retrieval runs with at most five concurrent requests, authentication fails without a partial group set.
9. **Allow-all guard.** Given URL `https://gitlab.com`, automatic provisioning, and `allowAllGroups=true`, when configuration is created, it is rejected before persistence.
10. **Automatic-provisioning group guard.** Given automatic provisioning, empty `allowedGroups`, and `allowAllGroups=false`, when configuration is created or patched, it is rejected.
11. **Secure URL patch.** Given an existing global configuration, when a patch changes `url` without `secret`, the patch is rejected and no settings commit.
12. **Reduced configuration read.** Given a logged-in non-administrator, when configuration is read, only ID, enabled state, and provisioning type are returned; URL, groups, token status, and error are absent.
13. **Token failure classification.** Given GitLab returns `429`, when a REST validation call runs, the failure says the GitLab API rate limit was exceeded rather than reporting a generic invalid token.
14. **Project search.** Given page `2`, size `20`, and a project-name filter, when search runs, only non-archived membership projects are requested in ascending name order, and paging comes from GitLab response headers.
15. **Missing paging metadata.** Given a successful project-search body without `X-Page`, when response is processed, the search fails rather than inventing page metadata.
16. **Import identity.** Given GitLab project ID `123`, public visibility, namespace path, and one default branch, when import succeeds, binding repository identifier is `123`, project visibility is public, full provider name is the namespace path, and default-branch metadata uses that branch.
17. **Import token absence.** Given a valid GitLab setting but no token for the current user, when project search or import runs, it fails before provider access.
18. **JIT transition cleanup.** Given automatic provisioning and GitLab-owned external-group records, when configuration changes to JIT, those external-group records are deleted in the configuration transaction.
19. **Role migration preservation.** Given a custom case-insensitive `planner` mapping already exists, when the pinned migration runs, it does not add default planner permissions.
20. **Health aggregation.** Given two GitLab DevOps settings where one validates and one has expired token, when monitoring runs, `sonarqube_health_integration_gitlab_status` is `0`.

## 14. Provenance index

Primary pinned source paths:

- `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabSettings.java`
- `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabIdentityProvider.java`
- `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/ScribeGitLabOauth2Api.java`
- `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabRestClient.java`
- `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GitLabGraphQlClient.java`
- `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GsonUser.java`
- `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GsonGroup.java`
- `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GsonProjectMember.java`
- `server/sonar-auth-gitlab/src/main/java/org/sonar/auth/gitlab/GsonMemberRole.java`
- `server/sonar-auth-common/src/main/java/org/sonar/auth/OAuthRestClient.java`
- `server/sonar-server-common/src/main/java/org/sonar/server/common/graphql/GraphQlClient.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericApplicationHttpClient.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericPaginatedHttpClient.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/RatioBasedRateLimitChecker.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationClient.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabApplicationHttpClient.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabPaginatedHttpClient.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabHeaders.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabToken.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabServerException.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/GitlabGlobalSettingsValidator.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/Project.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/gitlab/ProjectList.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfigurationService.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/GitlabConfiguration.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/ProvisioningType.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/gitlab/GitlabDevOpsProjectCreationContextService.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/gitlab/GitlabProjectCreatorFactory.java`
- `server/sonar-server-common/src/main/java/org/sonar/server/almsettings/MultipleAlmFeature.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsSupport.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateGitlabAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/UpdateGitlabAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/SetPatAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/CheckPatAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/gitlab/SearchGitlabReposAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/gitlab/ImportGitLabProjectAction.java`
- `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/gitlab/config/`
- `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/`
- `server/sonar-db-dao/src/main/java/org/sonar/db/alm/pat/AlmPatDao.java`
- `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/PopulateInitialSchema.java`
- `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202603/AddGitlabRolePermissionMapping.java`
- `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202603/AddGitlabPlannerRolePermissionMapping.java`
- `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v202603/AddGitlabSecurityManagerRolePermissionMapping.java`
- `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/GitlabMetricsTask.java`
- `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ServerMonitoringMetrics.java`
- `sonar-ws/src/main/java/org/sonarqube/ws/client/gitlab/provisioning/permissions/`
- `sonar-ws/src/main/java/org/sonarqube/ws/client/gitlab/synchronization/run/GitlabSynchronizationRunService.java`
