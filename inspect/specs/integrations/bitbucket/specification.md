# Bitbucket Integration Specification

## 1. Identity and provenance

This specification defines the Bitbucket integration bundled with SonarQube Community Build `26.8.0.126808`. The authoritative source is `SonarSource/sonarqube`, tag `26.8.0.126808`, commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The relevant production source is licensed under `LGPL-3.0-or-later`; this is a full clean-room specification, not a copy marker. [B1]

The integration has two distinct ALM modes:

- **Bitbucket Cloud**, identified internally as `BITBUCKET_CLOUD` and publicly as `bitbucketcloud`;
- **Bitbucket Server**, identified internally as `BITBUCKET` and publicly as `bitbucket`. The client requires the Bitbucket Server REST API 1.0 shape and is also suitable for a compatible Bitbucket Data Center deployment. It does not negotiate or enforce a product version. [B2][B3][B4]

Bitbucket Cloud also supplies a separate OAuth 2.0 login provider named `Bitbucket`, with provider key `bitbucket`. Login configuration is independent of ALM settings and import credentials. The pinned release contains no corresponding Bitbucket Server login provider. [B5][B6]

## 2. Purpose, scope, and exclusions

The integration shall:

- let a system administrator create, update, list, validate, and delete one Community Build Bitbucket ALM setting;
- validate a Bitbucket Cloud OAuth consumer or a Bitbucket Server global personal access token;
- store one import credential per SonarQube user and ALM setting;
- validate the current user's stored import credential;
- discover Cloud repositories in one configured workspace;
- discover Server projects and repositories;
- import a repository as a SonarQube project and persist its ALM binding;
- expose binding status in discovery responses;
- expose a health gauge derived from configuration validation;
- authenticate users through the separate Bitbucket Cloud OAuth login provider when that provider is enabled. [B2][B3][B5][B7][B8]

The integration does not own local session creation, authorization, project visibility, project-key validation, new-code policy, project indexing, generic HTTP error serialization, or pull-request decoration execution. Those contracts belong to `platform/identity-access/`, `platform/project-configuration/`, `platform/http-api/`, `platform/persistence/`, and `platform/telemetry-monitoring/`. Import persists the binding used by downstream decoration features, but this specification does not infer commercial decoration behavior. [B9][B10]

Cloud import is limited to the workspace recorded in the selected setting. There is no Cloud workspace-list endpoint and no separate Cloud project-list endpoint; Cloud repository results carry their Bitbucket project key. Server mode has a project-list endpoint. [B11][B12]

## 3. Dependencies and owned contracts

The integration owns:

- Bitbucket Cloud OAuth client-credential validation and API-token transport;
- Bitbucket Server bearer-token transport and REST API 1.0 resource mapping;
- provider-specific project and repository discovery;
- provider-specific repository metadata acquisition during import;
- provider-specific binding fields;
- Bitbucket Cloud OAuth login requests, workspace restriction, and external identity mapping;
- the Bitbucket provider health result. [B2][B3][B5][B13]

It depends on:

- the identity and access contract for `Administer System`, `Create Projects`, project `Administer`, project `Browse`, user sessions, account linking, and CSRF-state storage;
- the project configuration contract for project creation, unique project keys, main branches, new-code definitions, bindings, and visibility;
- the persistence contract for ALM settings, user credentials, audit records, and transactions;
- the HTTP API contract for authentication, request validation, content negotiation, protobuf/JSON rendering, and standard status mapping;
- the telemetry and monitoring contract for scheduling and exporting gauges;
- the shared outbound HTTP client, proxy, TLS trust, and ALM timeout configuration. [B9][B10][B14]

## 4. Configuration and credential modes

### 4.1 Community Build cardinality

Community Build does not enable the multiple-ALM-setting feature. It shall permit at most one Bitbucket setting across both modes: an existing Cloud setting prevents creation of a Server setting, and an existing Server setting prevents creation of a Cloud setting. A setting key is globally unique across every DevOps platform setting. [B15][B16]

This limit does not apply to the separate Bitbucket login-provider properties.

### 4.2 Bitbucket Cloud ALM setting

`POST /api/alm_settings/create_bitbucketcloud` requires `Administer System` and returns no content on success. Its accepted fields are:

| Field | Requirement | Contract |
|---|---:|---|
| `key` | required | Unique setting key; maximum 200 characters. |
| `workspace` | required | Bitbucket Cloud workspace ID. It shall contain only lowercase ASCII letters, digits, hyphens, and underscores. |
| `clientId` | required | OAuth consumer key; maximum 2,000 characters on create. |
| `clientSecret` | required | OAuth consumer secret; maximum 2,000 characters on create. |

The setting stores the workspace as its application identifier. Creating the setting does not contact Bitbucket; validation is a separate operation. [B16]

`POST /api/alm_settings/update_bitbucketcloud` requires `Administer System`. `key`, `workspace`, and `clientId` are required. `newKey` is optional. Update limits are 200 characters for keys, 80 for `workspace` and `clientId`, and 160 for an optional `clientSecret`. A nonblank `newKey` renames the setting after uniqueness validation. A nonblank `clientSecret` replaces the old secret; omission or a blank value retains the old secret. Workspace format validation is repeated. [B17]

### 4.3 Bitbucket Server ALM setting

`POST /api/alm_settings/create_bitbucket` requires `Administer System` and returns no content on success. Its fields are:

| Field | Requirement | Contract |
|---|---:|---|
| `key` | required | Unique setting key; maximum 200 characters. |
| `url` | required | Bitbucket Server base/API URL; maximum 2,000 characters. |
| `personalAccessToken` | required | Global validation token; maximum 2,000 characters. |

The URL is accepted at creation without a network call. Provider calls later require it to begin with `http://` or `https://`, remove one trailing slash, and append REST paths. [B18][B3]

`POST /api/alm_settings/update_bitbucket` requires `key` and `url`; `newKey` and `personalAccessToken` are optional. The same key and credential maximums apply. A nonblank token replaces the old token. If the URL changes, a new token is mandatory; otherwise update fails with `Please provide the Personal Access Token to update the URL.` A nonblank distinct `newKey` must be unique. [B19]

### 4.4 Global validation credentials versus user import credentials

Global setting credentials and per-user import credentials have different purposes:

- Cloud global `clientId` and `clientSecret` validate a private OAuth consumer and its `pullrequest` scope for the configured workspace.
- Server global `personalAccessToken` validates the URL, authentication, and repository-read access. It is also used by periodic health validation.
- Repository discovery and import use the current SonarQube user's credential stored for the selected setting, not the global credential.
- Cloud user credentials are a Bitbucket account email address plus API token. Server user credentials are a bearer personal access token. [B2][B3][B7][B20]

`POST /api/alm_integrations/set_pat` requires a logged-in user with `Create Projects`. It accepts `pat` (required, maximum 2,000), `username` (optional generally, maximum 2,000), and `almSetting` (optional only when exactly one DevOps platform setting exists). For Cloud, the public field remains named `username`, but its value must be the Bitbucket account email address and must be nonempty; Server ignores it. Cloud storage transforms the email and token into Base64 of the UTF-8 `email:pat` credential required for HTTP Basic authentication. Server stores the supplied token unchanged. Saving inserts or replaces the credential for the current user and setting and does not validate it. [B7][B20]

When `almSetting` is omitted, zero settings produce a not-found error, exactly one setting is selected, and multiple settings require the parameter. User credentials are scoped by both user UUID and immutable setting UUID. [B7]

`GET /api/alm_integrations/check_pat` is internal, requires `Create Projects`, requires `almSetting`, and returns no content on success. Cloud checks the stored Basic credential against the configured workspace repository endpoint. Server makes an authenticated request for recent repositories. A missing setting, missing current-user credential, incomplete URL/workspace, or provider failure fails the request. [B21]

### 4.5 Secret presentation and deletion

`GET /api/alm_settings/list_definitions` requires `Administer System`. Cloud definitions expose `key`, `workspace`, and `clientId`; Server definitions expose `key` and `url`. Global tokens, client secrets, and user credentials shall not be populated in the response, even though legacy protobuf fields still exist. Definitions are grouped by provider and sorted by creation time within each provider. [B22][B23]

`GET /api/alm_settings/list` requires `Create Projects`, or project `Administer` when `project` is supplied. Results are sorted by setting key. Cloud exposes a synthesized URL of `https://bitbucket.org/{workspace}/`; Server exposes the configured URL. [B24]

`POST /api/alm_settings/delete` requires `Administer System`. It deletes project-binding rows and all users' credentials for the setting before deleting the setting itself, in one database session, and returns no content. Existing SonarQube projects remain. [B25]

## 5. Global setting validation

`GET /api/alm_settings/validate?key=…` requires `Administer System` and returns no content when validation succeeds. Validation is observational; it does not persist a durable validated state and it is not automatically run during create or update. [B26]

### 5.1 Cloud validation sequence

The validator decrypts the configured client secret when necessary, then:

1. Sends a form-encoded `POST` to `https://bitbucket.org/site/oauth2/access_token` with `grant_type=client_credentials` and HTTP Basic authentication from the OAuth consumer key and secret.
2. Requires a successful token response.
3. Requires the returned scope string to contain `pullrequest`. A missing scope or a scope without that text fails with the public explanation that the OAuth consumer lacks permission to read pull requests.
4. Sends a bearer-authenticated `GET` to `https://api.bitbucket.org/2.0/repositories/{workspace}`. A successful response confirms workspace access. [B2][B27]

An OAuth error body of `invalid_grant` is reported as a need to configure a private consumer. `unauthorized_client` asks the administrator to check credentials. A parsed Bitbucket error description is prefixed with `Error returned by Bitbucket Cloud`; absent or unusable error data becomes `Unable to contact Bitbucket Cloud servers`. I/O failure has the same contact-failure category. [B2]

### 5.2 Server validation sequence

The validator requires both URL and global token, then performs three ordered `GET` requests:

1. `{url}/status` without bearer credentials, requiring a JSON status response;
2. `{url}/rest/api/1.0/users` with the global bearer token;
3. `{url}/rest/api/1.0/repos` with the same token, establishing repository-read access. [B3][B28]

A URL without an HTTP or HTTPS scheme fails with `url must start with http:// or https://`. HTTP 401 becomes `Invalid personal access token`; HTTP 404 becomes `Error 404. The requested Bitbucket server is unreachable.` Other unsuccessful statuses become `Unable to contact Bitbucket server`. Successful non-JSON or malformed JSON responses fail as unexpected provider responses. [B3]

## 6. Bitbucket Cloud repository discovery

`GET /api/alm_integrations/search_bitbucketcloud_repos` requires a logged-in user with `Create Projects` and these parameters:

| Parameter | Requirement | Contract |
|---|---:|---|
| `almSetting` | required | Setting key; maximum 200 characters. |
| `repositoryName` | optional | Name substring filter sent to Bitbucket; maximum 200 characters. |
| `p` | framework paging parameter | Page index; default is the shared API paging default, beginning at page 1. |
| `ps` | framework paging parameter | Default 20; maximum 100. |

The action loads the configured workspace and current user's stored Cloud credential. It issues `GET https://api.bitbucket.org/2.0/repositories/{workspace}` with `q=name~"{repositoryName-or-empty}"`, `page`, and `pagelen`. The credential is transported as `Authorization: Basic {stored-Base64-credential}`. [B2][B11]

Each result exposes `slug`, `uuid`, `name`, configured `workspace`, and the repository's Bitbucket `projectKey`. If a SonarQube binding already exists for that repository slug under the setting, `sqProjectKey` is added. If duplicate local bindings exist, the lexicographically smallest SonarQube project key is exposed. [B11][B29]

The response includes requested page index and size, plus `isLastPage`. It is the last page exactly when Bitbucket omits its `next` link. No total count is synthesized and the client does not follow `next` automatically. [B11][B30]

Cloud mode does not enumerate workspaces. The configured workspace is the sole discovery boundary. It also does not expose a standalone project list; project identity is metadata on repositories. [B11]

## 7. Bitbucket Server project and repository discovery

### 7.1 Project listing

`GET /api/alm_integrations/list_bitbucketserver_projects` requires `Create Projects`. `almSetting` is required and limited to 200 characters. `start` is an optional inclusive provider offset. `pageSize` defaults to 25, has maximum 100, and a nonpositive value falls back to 25. [B12]

The integration sends `GET {url}/rest/api/1.0/projects?start={start-or-empty}&limit={pageSize}` with the current user's bearer token. Results expose project `key` and `name`, `isLastPage`, `nextPageStart`, and a paging `pageSize` equal to the number reported in the provider response. [B3][B12][B29]

### 7.2 Repository search

`GET /api/alm_integrations/search_bitbucketserver_repos` has the same authorization and cursor paging. It additionally accepts optional `projectName` and `repositoryName`, each limited to 200 characters. It sends one request to `{url}/rest/api/1.0/repos` with URL-encoded `projectname`, `name`, `start`, and `limit` query values. The endpoint is expected to return repositories for which the token has `REPO_ADMIN` access. [B3][B31]

Each repository result exposes `slug`, numeric `id`, `name`, owning `projectKey`, and owning `projectName`. If a binding exists for the exact project-key/repository-slug pair, `sqProjectKey` is added; if duplicate local bindings exist, the lexicographically smallest SonarQube project key wins. The response passes through `isLastPage`, `nextPageStart`, and provider-reported page size. It makes one provider request and does not follow later pages. [B31][B29]

## 8. Import and binding

### 8.1 Preferred API v2

The preferred interface is `POST /api/v2/dop-translation/bound-projects`. It requires authentication and `Create Projects`, and returns HTTP 201. Its JSON body has these provider-relevant fields:

| Field | Requirement | Bitbucket Cloud | Bitbucket Server |
|---|---:|---|---|
| `projectKey` | nonempty | Requested SonarQube key. | Requested SonarQube key. |
| `projectName` | nonempty | Requested SonarQube name. | Requested SonarQube name. |
| `devOpsPlatformSettingId` | nonempty | Immutable UUID from `GET /api/v2/dop-translation/dop-settings`. | Same. |
| `repositoryIdentifier` | nonempty | Repository slug. | Repository slug. |
| `projectIdentifier` | optional in schema | Ignored by Cloud import. | Mandatory in behavior; Bitbucket project key. |
| `newCodeDefinitionType` | optional | Shared project-creation contract. | Shared project-creation contract. |
| `newCodeDefinitionValue` | optional | Shared project-creation contract. | Shared project-creation contract. |
| `monorepo` | required Boolean | Stored on binding. | Stored on binding. |

The response contains `projectId`, `bindingId`, and `newProjectCreated`. [B32][B33]

`PUT /api/v2/dop-translation/bound-projects` accepts the same body and returns HTTP 200. It allows an existing project with the requested key and updates its binding; updating additionally requires project `Administer`. POST does not allow an existing project. [B32][B34]

`GET /api/v2/dop-translation/dop-settings` requires `Create Projects` and returns all settings without client-driven pagination. Relevant public types are `bitbucketcloud` and `bitbucket`; each resource includes `id`, `type`, `key`, nullable `url`, and nullable `appId`, plus a page object fixed to index 1 with size and total equal to the returned count. Cloud's `appId` is its workspace; Server's `url` is its base URL. [B4][B35]

### 8.2 Deprecated legacy import APIs

The following public endpoints remain compatible but have been deprecated since 10.5 in favor of API v2:

- `POST /api/alm_integrations/import_bitbucketcloud_repo`, with required `repositorySlug` and optional `almSetting`;
- `POST /api/alm_integrations/import_bitbucketserver_project`, with required `projectKey` (the Bitbucket project key), required `repositorySlug`, and optional `almSetting`.

Each identifier and setting key has a 200-character maximum. `almSetting` may be omitted only when exactly one setting of the requested Bitbucket mode exists. Both accept optional shared `newCodeDefinitionType` and `newCodeDefinitionValue`, require `Create Projects`, return the legacy project-create response, and set `monorepo` and allow-existing to false. [B36][B37]

Legacy import does not accept a SonarQube key or name. It uses the provider repository name as the SonarQube name and generates a sanitized unique key from workspace plus repository slug for Cloud, or Bitbucket project key plus repository slug for Server, with an appended UUID and a 250-character final limit. [B8][B38]

### 8.3 Provider fetch and local binding

Cloud import:

1. Requires the current user's stored Cloud credential and the setting workspace.
2. Fetches `GET /2.0/repositories/{workspace}/{repositorySlug}` with Basic authentication.
3. Uses the repository name and `mainbranch.name` unless API v2 supplied an explicit SonarQube name.
4. Creates or reuses the local project as allowed by the selected endpoint.
5. Stores setting UUID, repository slug, project UUID, and monorepo flag. [B8]

Server import:

1. Requires the current user's stored bearer token, setting URL, repository slug, and Bitbucket project key.
2. Fetches `/rest/api/1.0/projects/{projectKey}/repos/{repositorySlug}`.
3. Fetches `/rest/api/1.0/projects/{projectKey}/repos/{repositorySlug}/branches` and selects the branch marked as default; absence of such a branch leaves the local default-branch value unset.
4. Uses the repository name unless API v2 supplied an explicit SonarQube name.
5. Stores setting UUID, Bitbucket project key as the binding repository field, repository slug as the binding slug, project UUID, and monorepo flag. [B3][B39]

Provider operations during import are reads. SonarQube validates the optional new-code definition, resolves the setting by immutable UUID, fetches provider metadata before local creation, creates or updates the binding, optionally creates the new-code definition, commits and indexes the project, and returns the project and binding identifiers. [B10]

`GET /api/alm_settings/get_binding?project=…` requires project `Browse`. Cloud bindings expose provider `bitbucketcloud`, setting key, repository slug, and optional monorepo. Server bindings expose provider `bitbucket`, setting key, configured URL, Bitbucket project key in `repository`, repository slug in `slug`, and optional monorepo. The endpoint does not synthesize a repository web URL for either Bitbucket mode in this release. [B23][B40]

## 9. Bitbucket Cloud OAuth login

### 9.1 Properties and defaults

The separate login provider recognizes:

| Property | Default | Meaning |
|---|---:|---|
| `sonar.auth.bitbucket.enabled` | `false` | Requests provider activation. Activation is effective only when both consumer credentials exist. |
| `sonar.auth.bitbucket.clientId.secured` | none | Bitbucket OAuth consumer key. |
| `sonar.auth.bitbucket.clientSecret.secured` | none | Bitbucket OAuth consumer secret. |
| `sonar.auth.bitbucket.allowUsersToSignUp` | `true` | Allows creation of local accounts; when false, only existing users may authenticate. |
| `sonar.auth.bitbucket.workspaces` | empty | Multi-valued allowed workspace names or slugs. Empty means no workspace restriction. |

The provider uses fixed web root `https://bitbucket.org/` and API root `https://api.bitbucket.org/`; these properties cannot redirect login to Bitbucket Server. [B6]

### 9.2 OAuth flow and identity mapping

Login initiation requires the provider to be enabled, generates CSRF state, requests OAuth scope `account`, and redirects to `https://bitbucket.org/site/oauth2/authorize`. Callback verifies CSRF state before exchanging `code` by POST at `https://bitbucket.org/site/oauth2/access_token`. [B5][B41]

The callback then requests `/2.0/user` and `/2.0/user/emails`. A profile failure is fatal and includes provider HTTP status and response in the internal error. A non-successful email response is nonfatal and yields an identity without email; a successful response must still contain parseable email data. The identity maps Bitbucket UUID to provider ID, username to provider login, display name to local display name with username fallback, and the primary email when present. Local account matching, signup enforcement, and session issuance remain identity-access responsibilities. [B5][B42]

When the allowed-workspace list is nonempty, the provider requests `/2.0/user/workspaces`. It first matches configured values against unique workspace slugs. If no slug matches, it fetches `/2.0/workspaces/{slug}` for each returned slug and matches configured values against workspace names. Failure to retrieve memberships, null membership data, or no slug/name match denies authentication. A non-successful workspace-detail response is logged and ignored for that workspace; successful responses must be parseable. The implementation does not follow workspace pagination, so only memberships returned in the first response participate. [B5]

No Bitbucket groups or repository permissions are mapped into local groups or project permissions by this login provider. The OAuth access token is used to obtain identity and workspace information; the resulting local authorization is owned by the identity-access contract. [B5][B42]

## 10. Transport, timeouts, and security boundaries

Cloud ALM requests target only the two fixed HTTPS origins. Cloud API-token requests use HTTP Basic; Cloud global validation uses OAuth client Basic authentication followed by bearer authentication. Server requests use a configurable HTTP or HTTPS origin, `Authorization: Bearer`, `Accept: application/json`, and `x-atlassian-token: no-check`. [B2][B3]

All ALM clients inherit the shared outbound HTTP client and apply `sonar.alm.timeout.connect` and `sonar.alm.timeout.read`, each interpreted as milliseconds with a 30,000 ms default. An unparsable value is logged and falls back to the default. Automatic HTTP redirects and HTTP-to-HTTPS redirects are disabled. No automatic retry or backoff is performed. [B14][B43]

Only system administrators may create or change the configurable Server origin, which is an outbound-network trust boundary. Deployments should use HTTPS and restrict egress because the implementation accepts plain HTTP. Cloud workspace and repository identifiers become URL path/query data through the HTTP URL builder; Server filter values are UTF-8 URL encoded. [B2][B3][B16]

Global secrets and user credentials are sensitive persistence data. Listing APIs intentionally omit their values. Per-user credentials are retrievable only by server-side code using the authenticated user's UUID and selected setting. Implementations must preserve this non-disclosure and must not log authorization headers or credential values. Generic database protection and encryption-at-rest policy belong to the persistence contract; this source accepts both encrypted and legacy unencrypted global secret representations when reading. [B7][B22][B27]

OAuth login shall verify CSRF state before token exchange. An empty allowed-workspace list deliberately permits any Bitbucket account, so administrators who need tenant restriction must configure at least one exact slug or name. [B5][B6]

## 11. Failure, partial-result, and recovery behavior

- Missing authentication or permissions fail before provider access under the shared 401/403 contract. Unknown settings produce not-found errors; missing current-user credentials produce bad-request errors. [B11][B12][B21]
- Discovery makes one provider request per API call. Provider or parse failure fails the whole call; no partial repository or project list is returned. Callers recover by correcting the setting or credential and retrying. [B2][B3]
- Import requires successful provider metadata retrieval before project creation. Missing project identifiers, credentials, main-branch metadata required by a provider object, provider errors, or invalid new-code parameters fail the operation; no provider-side state needs rollback because all provider calls are reads. [B8][B10][B39]
- API v2 documents 400 for bad requests such as a missing user credential, 401 for authentication, 403 for missing `Create Projects`, and 500 for provider repository fetch failures. PUT may return 404 when an existing project is hidden because the caller lacks project administration. [B32]
- Cloud errors preserve parsed provider messages and HTTP codes when available. Server deliberately normalizes most non-401/non-404 provider failures to `Unable to contact Bitbucket server`. [B2][B3]
- Settings create, update, per-user credential replacement, and deletion commit explicitly. A failed request before commit leaves the prior persisted state available for correction. Deleting a setting removes its bindings and credentials, so recovery requires recreating the setting, re-entering user credentials, and reimporting or rebinding as appropriate. [B7][B16][B17][B18][B19][B25]

## 12. Lifecycle, concurrency, and monitoring

The operational lifecycle is: absent setting; created but unvalidated; optionally validated; user credential stored; optionally credential-checked; resources discovered; project imported and bound; setting updated or deleted. Validation success is not stored as a state transition. All request handlers are stateless across requests and open their own database sessions. Database uniqueness and project-creation contracts resolve concurrent attempts; this integration adds no provider cache or distributed lock. [B7][B10][B16][B18][B26]

Monitoring starts after `sonar.server.monitoring.devops.initial.delay`, default 10,000 ms, and repeats every `sonar.server.monitoring.devops.period`, default 300,000 ms. `sonarqube_health_integration_bitbucket_status` is 1 only when at least one Cloud or Server setting exists and every configured Bitbucket setting passes its global validation sequence. It is 0 when none exists or any validation throws. The single gauge intentionally combines both modes. [B13][B44]

## 13. Compatibility and limits

- Cloud origins and API version `2.0` are fixed. Self-hosted Bitbucket is supported only through Server mode. [B2][B6]
- Server mode requires REST API 1.0 response fields documented in this specification. Redirect responses are not followed. [B3]
- Community Build permits one combined Cloud-or-Server setting. [B15][B16][B18]
- Cloud repository paging is page-index based; Server paging is opaque inclusive `start` cursor based. These models are not interchangeable. [B11][B12][B31]
- Cloud workspace login restriction and Cloud repository search do not automatically traverse provider pagination beyond the requested/first page. [B5][B11]
- Import needs a current-user credential even when the global setting validates successfully. [B8][B39]
- API v2 is preferred; legacy import endpoints remain observable but deprecated. [B32][B36][B37]
- No Bitbucket Server OAuth login, group synchronization, workspace enumeration API, or provider-side write is present in this release. [B5][B11][B39]

## 14. Acceptance scenarios

1. **Community cardinality.** Given an existing Cloud setting, when a system administrator attempts to create a Server setting, the request is rejected because Community Build treats both as one Bitbucket family. The existing setting remains unchanged.
2. **Cloud workspace validation.** Given workspace `Team/One`, create fails with an incorrect-format error. Given `team-one_2`, create succeeds without contacting Bitbucket.
3. **Cloud global validation.** Given a private OAuth consumer whose token scope contains `pullrequest` and which can read the configured workspace repositories, validation returns no content. If the scope lacks that value, validation fails with the pull-request-read permission explanation.
4. **Server global validation.** Given an HTTPS Server URL and a token accepted by `/users` and `/repos`, validation returns no content after all three requests. A 401 from either authenticated request is reported as an invalid personal access token.
5. **Per-user Cloud credential.** Given a Cloud setting, a user with `Create Projects` cannot save only an API token; the public `username` field is required and contains the Bitbucket account email address. With email and token, saving succeeds and later requests use their `email:pat` Basic credential.
6. **Per-user isolation.** Given two SonarQube users and one setting, saving a credential for the first user does not satisfy discovery for the second. The second receives a missing-credential error until saving their own token.
7. **Cloud paging.** Given more than 20 matching repositories, a search without an explicit page size requests 20. A nonnull provider `next` marks `isLastPage` false. The action does not fetch the next page until the caller requests it.
8. **Server cursor paging.** Given a Server response with `isLastPage=false`, `nextPageStart=25`, and size 25, project or repository discovery exposes those values. A subsequent request using `start=25` fetches the next provider page.
9. **Binding annotation.** Given an imported repository among discovery results, the result includes its SonarQube project key. Given duplicate bindings, the lexicographically smallest local key is reported deterministically.
10. **Cloud API v2 import.** Given a valid setting UUID, user credential, repository slug, explicit local key/name, and `monorepo=false`, POST fetches repository metadata, creates the project with the Cloud main branch, stores a slug binding, and returns 201 with project and binding IDs and `newProjectCreated=true`.
11. **Server import default branch.** Given a repository and branch list with one branch marked default, import uses that branch name and stores the Bitbucket project key plus repository slug. If no branch is marked default, import proceeds with an unset provider-derived default branch subject to the shared project-creation contract.
12. **Idempotent rebinding.** Given an existing project and caller with both `Create Projects` and project `Administer`, PUT API v2 updates the binding and returns 200 with `newProjectCreated=false`. Without project administration, it does not reveal or update the project.
13. **Provider outage.** Given a timeout or malformed provider response during discovery, the endpoint returns an error and no partial list. Retrying after provider recovery succeeds without cleanup.
14. **Setting deletion.** Given a setting with user credentials and bound projects, deletion removes the setting, all associated credentials, and binding rows, but not the projects. Later discovery fails until configuration and credentials are recreated.
15. **OAuth login without restriction.** Given login enabled with consumer credentials and an empty workspace list, any Bitbucket account that completes CSRF-checked OAuth and returns a valid profile can authenticate subject to local signup policy.
16. **OAuth workspace restriction.** Given allowed value `engineering` and a user whose workspace slug or resolved name equals `engineering`, authentication succeeds. If membership retrieval fails or no returned membership matches, authentication is denied.
17. **Health gauge.** Given no Bitbucket setting, the gauge is 0. Given one setting that validates, it becomes 1 at the next monitoring run. A later credential or connectivity failure returns it to 0.

## 15. Provenance index

- **[B1]** `manifest/release-baseline.md`; `manifest/license-map.md`; upstream `LICENSE.txt`, pinned commit.
- **[B2]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/bitbucket/bitbucketcloud/BitbucketCloudRestClient.java`.
- **[B3]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/bitbucketserver/BitbucketServerRestClient.java`.
- **[B4]** `server/sonar-webserver-common/src/main/java/org/sonar/server/common/AlmSettingMapper.java`; `server/sonar-webserver-webapi-v2/src/test/java/org/sonar/server/v2/api/dop/controller/DefaultDopSettingsControllerTest.java`.
- **[B5]** `server/sonar-auth-bitbucket/src/main/java/org/sonar/auth/bitbucket/BitbucketIdentityProvider.java`.
- **[B6]** `server/sonar-auth-bitbucket/src/main/java/org/sonar/auth/bitbucket/BitbucketSettings.java`.
- **[B7]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/SetPatAction.java`.
- **[B8]** `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/bitbucketcloud/BitbucketCloudProjectCreator.java`.
- **[B9]** `manifest/dependency-map.md`.
- **[B10]** `server/sonar-webserver-common/src/main/java/org/sonar/server/common/project/ImportProjectService.java`.
- **[B11]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/bitbucketcloud/SearchBitbucketCloudReposAction.java`.
- **[B12]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/bitbucketserver/ListBitbucketServerProjectsAction.java`.
- **[B13]** `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/BitbucketMetricsTask.java`.
- **[B14]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/TimeoutConfigurationImpl.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/bitbucket/bitbucketcloud/BitbucketCloudRestClientConfiguration.java`.
- **[B15]** `server/sonar-server-common/src/main/java/org/sonar/server/almsettings/MultipleAlmFeature.java`.
- **[B16]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateBitbucketCloudAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsSupport.java`.
- **[B17]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/UpdateBitbucketCloudAction.java`.
- **[B18]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateBitBucketAction.java`.
- **[B19]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/UpdateBitbucketAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsSupport.java`.
- **[B20]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/CredentialsEncoderHelper.java`.
- **[B21]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/CheckPatAction.java`.
- **[B22]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/ListDefinitionsAction.java`.
- **[B23]** `sonar-ws/src/main/protobuf/ws-alm_settings.proto`.
- **[B24]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/ListAction.java`.
- **[B25]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/DeleteAction.java`.
- **[B26]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/ValidateAction.java`.
- **[B27]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/bitbucket/bitbucketcloud/BitbucketCloudValidator.java`.
- **[B28]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/bitbucketserver/BitbucketServerSettingsValidator.java`.
- **[B29]** `sonar-ws/src/main/protobuf/ws-alm_integrations.proto`.
- **[B30]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/bitbucket/bitbucketcloud/RepositoryList.java`.
- **[B31]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/bitbucketserver/SearchBitbucketServerReposAction.java`.
- **[B32]** `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/BoundProjectsController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/request/BoundProjectCreateRestRequest.java`.
- **[B33]** `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/response/BoundProjectCreateRestResponse.java`.
- **[B34]** `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/DefaultBoundProjectsController.java`.
- **[B35]** `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/dop/controller/DefaultDopSettingsController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/dop/response/DopSettingsResource.java`.
- **[B36]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/bitbucketcloud/ImportBitbucketCloudRepoAction.java`.
- **[B37]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/bitbucketserver/ImportBitbucketServerProjectAction.java`.
- **[B38]** `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almintegration/ProjectKeyGenerator.java`.
- **[B39]** `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/bitbucketserver/BitbucketServerProjectCreator.java`.
- **[B40]** `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GetBindingAction.java`.
- **[B41]** `server/sonar-auth-bitbucket/src/main/java/org/sonar/auth/bitbucket/BitbucketScribeApi.java`.
- **[B42]** `server/sonar-auth-bitbucket/src/main/java/org/sonar/auth/bitbucket/UserIdentityFactory.java`; `server/sonar-auth-bitbucket/src/main/java/org/sonar/auth/bitbucket/GsonEmails.java`.
- **[B43]** `server/sonar-alm-client/src/main/java/org/sonar/alm/client/TimeoutConfigurationImpl.java`.
- **[B44]** `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ServerMonitoringMetrics.java`; `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/DevOpsMetricsTask.java`.
