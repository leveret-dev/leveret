# GitHub Integration Specification

## 1. Identity and baseline

This specification defines the GitHub integration bundled in SonarQube Community Build `26.8.0.126808`. Its authoritative source is the `SonarSource/sonarqube` tag `26.8.0.126808`, commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The production source is licensed under `LGPL-3.0-or-later`. No GPL or AGPL copy shortcut applies. The released distribution has SHA-256 `ea1c5c1932f9c25350eafc4cdb1a839527c117e5d98b5fcf222a715b6b50a1f2`. [Provenance: `manifest/release-baseline.md`; `manifest/license-map.md`; upstream `LICENSE.txt`]

The integration identity-provider key is `github`, its display name is `GitHub`, and its authentication display uses `/images/alm/github.svg` on color `#444444`. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubIdentityProvider.java`]

## 2. Purpose, scope, and ownership

The integration owns these provider-specific contracts:

- GitHub OAuth authorization, access-token exchange, identity retrieval, organization admission, and optional team discovery;
- GitHub App configuration, manifest registration, app JWTs, installation tokens, installation and repository discovery, permission validation, and webhook signature authentication;
- GitHub organization and repository listing used by project import;
- translation of GitHub repository roles and permission flags into SonarQube project permissions;
- provider-specific import metadata, repository access checks, automatic-provisioning controls, and GitHub integration health measurement.

It depends on `platform/identity-access/` for local accounts, signup policy enforcement, sessions, CSRF state storage and verification, local group membership application, and authorization decisions. It depends on `platform/project-configuration/` for project creation, binding persistence, new-code definitions, project visibility, and permission storage; on `platform/http-api/` for generic routing, serialization, errors, and pagination conventions; on `platform/persistence/` for storage mechanics; and on `platform/telemetry-monitoring/` for metric exposition. Those shared contracts are not redefined here. [Provenance: `manifest/dependency-map.md`]

Generic login-session lifecycle, local user merge rules, local group creation, generic permission administration, pull-request decoration, scanner behavior, and commercial GitHub capabilities are excluded. GitHub code-scanning alert processing is excluded except for the webhook trust boundary described below. Standalone GitHub behavior is a dependency, not an implementation target.

## 3. Configuration model and precedence

### 3.1 Global authentication and provisioning configuration

The following settings form the single global GitHub authentication configuration. Secured values must use the platform's secured-setting handling and must never be returned through configuration read APIs. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubSettings.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/github/config/GithubConfigurationService.java`]

| Key | Meaning | Defined default and behavior |
|---|---|---|
| `sonar.auth.github.enabled` | Enables GitHub login | `false`; effective only when client ID and client secret are nonempty. |
| `sonar.auth.github.clientId.secured` | OAuth/GitHub App client ID | Empty when absent. |
| `sonar.auth.github.clientSecret.secured` | OAuth/GitHub App client secret | Empty when absent. |
| `sonar.auth.github.appId` | Numeric GitHub App ID | Empty when absent. |
| `sonar.auth.github.privateKey.secured` | GitHub App private key | Empty when absent. |
| `sonar.auth.github.allowUsersToSignUp` | Allows new local users through GitHub | Public property default `true`. Configuration objects created through API v2 store `false` when the optional field is omitted. |
| `sonar.auth.github.groupsSync` | Adds discovered GitHub teams to the external identity result | `false`. |
| `sonar.auth.github.apiUrl` | GitHub REST API base | `https://api.github.com/`; a configured value is normalized to end in `/`. |
| `sonar.auth.github.webUrl` | GitHub web and OAuth base | `https://github.com/`; a configured value is normalized to end in `/`. |
| `sonar.auth.github.organizations` | Allowed organization login names | Empty set means admission through any organization on which the configured App is installed. |
| `provisioning.github.enabled` | Selects automatic provisioning rather than JIT | Internal boolean, default `false`; effective only while GitHub authentication is effectively enabled. |
| `provisioning.github.project.visibility.enabled` | Mirrors repository visibility | Public property default `true`; an API-v2 create request that omits its optional field stores `false`. |
| `sonar.auth.github.userConsentForPermissionProvisioningRequired` | Upgrade-consent marker | Presence, not its textual boolean value, means consent is required. |

Direct property configuration is the source read by authentication and provisioning runtime. API-v2 configuration writes the same global properties and the internal provisioning flag. Separate DevOps Platform App settings, described in section 3.3, do not override these global OAuth settings; they are selected by import or project binding. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubSettings.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/github/config/GithubConfigurationService.java`]

### 3.2 API-v2 global configuration

`/api/v2/dop-translation/github-configurations` supports:

- `GET /{id}` for one configuration;
- `GET` for search;
- `POST` for creation;
- `PATCH /{id}` with `application/merge-patch+json` for partial update;
- `DELETE /{id}`, returning no content.

Every operation requires system-administrator authority. Only ID `github-configuration` is valid, and only one configuration may exist. Search always reports page index `1`, page size `1000`, and the actual count, which is zero or one. Invalid IDs and missing configurations produce not-found failures. A second creation is rejected. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/config/controller/GithubConfigurationController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/config/controller/DefaultGithubConfigurationController.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/github/config/GithubConfigurationService.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/WebApiEndpoints.java`]

Creation requires `enabled`, nonempty `clientId`, `clientSecret`, `applicationId`, `privateKey`, `apiUrl`, and `webUrl`; non-null `synchronizeGroups`, `allowedOrganizations`, and `provisioningType`; and accepts optional `allowUsersToSignUp`, `projectVisibility`, and `userConsentRequiredAfterUpgrade`. `provisioningType` is `JIT` or `AUTO_PROVISIONING`. Duplicate organizations collapse because storage is set-valued. Read responses contain `id`, `enabled`, `applicationId`, `synchronizeGroups`, `apiUrl`, `webUrl`, a sorted `allowedOrganizations` list, `provisioningType`, `allowUsersToSignUp`, `projectVisibility`, `userConsentRequiredAfterUpgrade`, and nullable `errorMessage`. Client ID, client secret, and private key are write-only and absent from responses. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/config/request/GithubConfigurationCreateRestRequest.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/config/resource/GithubConfigurationResource.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/gitlab/config/ProvisioningType.java`]

A merge-patch field that is absent preserves its stored value. Non-null fields may be replaced but not cleared with null. Updating either `apiUrl` or `webUrl` is rejected unless the same patch also supplies `privateKey`; this prevents redirecting App-authenticated traffic while silently reusing an existing private key. `allowedOrganizations` must not be null. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/config/request/GithubConfigurationUpdateRestRequest.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/config/controller/DefaultGithubConfigurationController.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/github/config/GithubConfigurationService.java`]

When enabled, response generation validates the configuration live. App ID must parse as a number; client ID and decrypted client secret must be nonblank; the API endpoint and App permissions must validate. Validation errors are returned as `errorMessage` rather than preventing reads. Disabled configurations return no validation error. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubGlobalSettingsValidator.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/github/config/GithubConfigurationService.java`]

### 3.3 DevOps Platform App settings

Project import and repository binding use separately persisted GitHub App settings identified by a user-chosen key. `POST /api/alm_settings/create_github` requires system administration and accepts `key` up to 200 characters, `url` up to 2000, `appId` and `clientId` up to 80, `clientSecret` and optional `webhookSecret` up to 160, and `privateKey` up to 2500. The key must be unique. `POST /api/alm_settings/update_github` requires the current key, URL, App ID, and client ID; it may rename the key and may replace private key, client secret, and webhook secret. Omitted or blank private key and client secret preserve existing values. Supplying the webhook field with a blank value clears it. Updating the URL requires a newly supplied private key. Stored URLs have one trailing slash removed. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsWs.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateGithubAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/UpdateGithubAction.java`]
Community Build does not expose the `multiple-alm` feature, so supported creation paths reject a second GitHub DevOps setting when one already exists. The key still identifies the one setting and remains part of wire compatibility. The multiple-setting branch in import selection applies only to pre-existing or externally migrated data, not to a second setting created through this Community API. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/almsettings/MultipleAlmFeature.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsSupport.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateGithubAction.java`]

Where an import endpoint accepts optional `almSetting`, an explicit key wins. Without a key, exactly one GitHub App setting must exist; zero produces not found and more than one requires an explicit key. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/ImportHelper.java`]

## 4. OAuth authentication and identity handoff

### 4.1 Authorization request

Authentication is enabled only when `sonar.auth.github.enabled` is true and both OAuth client fields are nonempty. Starting login while disabled fails. The integration generates and records a CSRF state through the identity-access context, then redirects to `{webUrl}login/oauth/authorize`. The callback URL comes from the platform OAuth context. Scope is `user:email`; it becomes `user:email,read:org` when team synchronization is enabled or an organization allowlist is nonempty. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubIdentityProvider.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/ScribeGitHubApi.java`]

### 4.2 Callback and identity

The callback verifies CSRF state before exchanging `code` at `{webUrl}login/oauth/access_token`. It retrieves the user from `{apiUrl}user`. If the user profile has no public email, it requests `{apiUrl}user/emails` and selects the first address marked both primary and verified; if none exists, email is null. Provider ID is GitHub's user ID, provider login is `login`, display name is profile `name` unless absent or empty, in which case login is used. The resulting external identity is handed to identity-access, which owns local-account and session behavior. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubIdentityProvider.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubRestClient.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/UserIdentityFactoryImpl.java`]

OAuth REST GETs fail on non-success status. Organization and team lists use `per_page=100` and follow case-insensitive `Link` headers with `rel="next"` until no next link remains. I/O, execution, and malformed provider-result failures abort authentication; interruption restores the thread's interrupted state. [Provenance: `server/sonar-auth-common/src/main/java/org/sonar/auth/OAuthRestClient.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubIdentityProvider.java`]

### 4.3 Organization admission precedence

The integration always retrieves the user's organizations from `{apiUrl}user/orgs` before admitting the user.

1. When `sonar.auth.github.organizations` is nonempty, membership in at least one exact configured organization name is required.
2. Otherwise, the configured App is queried for installations, personal-account installations are discarded, configured organization filtering is applied, and the user must belong to at least one remaining installation organization.

Failure is unauthorized. The allowlist failure names the accepted organizations in sorted order. The empty-allowlist failure states that the user must belong to an organization on which the SonarQube GitHub App is installed. An invalid numeric App ID in the installation-based path produces an incomplete-configuration failure. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubIdentityProvider.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`]

### 4.4 Team synchronization

When `sonar.auth.github.groupsSync` is true, `{apiUrl}user/teams` is fully paginated. Each team becomes the external group name `<organization-login>/<team-slug>`. When false, no team request is made and no group set is supplied by this integration. Identity-access determines what happens when a same-named local group exists or does not exist. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubRestClient.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubTeamConverter.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/UserIdentityFactoryImpl.java`]

## 5. GitHub App registration and validation

### 5.1 Manual App settings

A complete runtime App configuration contains numeric App ID, private key, and API endpoint. Trailing slashes are removed from the endpoint in the App configuration object. Diagnostic rendering must redact the private key and may reveal only its length. Attempting to access incomplete configuration fails. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubAppConfiguration.java`]

The accepted API endpoint must be nonblank, parse as a URI, use `http` or `https`, and match one of these shapes: host `api.github.com`; a GitHub Enterprise Server URL whose path begins with `/api/v3`, case-insensitively; or a data-residency Enterprise Cloud host beginning `api.` and ending `.ghe.com`. Other hosts and schemes are rejected. HTTP is accepted for compatibility, so operators are responsible for choosing TLS at this trust boundary. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`]

Normal App validation calls `/app` using an App JWT and requires `checks: write`, `pull_requests: write`, and `metadata: read`. Permission comparison is exact. Missing permissions produce a deterministic, sorted diagnostic. `401` or `403` is treated as authentication failure; other unexpected status, unreadable response, transport error, or missing permission payload is a configuration failure. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubAppPermissions.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubGlobalSettingsValidator.java`]

### 5.2 GitHub App Manifest flow

`POST /api/alm_settings/create_github_from_manifest` is internal and system-administrator-only. It accepts optional `key`, `organization`, and suggested `name`, each limited to 200 characters, plus `devops` defaulting to true and `auth` defaulting to false. The default suggested name is `SonarQube - <add_unique_name>`. At least one of `devops` or `auth` must be true. `key` is mandatory and must be unused when `devops` is true. A configured public SonarQube base URL is mandatory. This flow supports only `github.com`, either a personal account or an organization selected by path. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateGithubFromManifestAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubAppManifestGenerator.java`]

The response contains `githubAppUrl`, serialized `manifest`, and `state`. The manifest registers the SonarQube public URL, callback `/github/manifest/callback`, the public root as OAuth callback, a setup URL for the initiating settings page, a public App, OAuth-on-install, no default webhook events, and these requested permissions: `checks: write`, `pull_requests: write`, `metadata: read`, `contents: write`, `administration: read`, `members: read`, `organization_administration: read`, `organization_projects: read`, and `emails: read`. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubAppManifestGenerator.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubAppPermissions.java`]

State is a cryptographically random 160-bit base-32 value, stored in memory for one hour with initiating user, requested targets, key, and organization. It is single-use, purged lazily, and must be consumed by the same administrator. In a cluster the callback must return to the same web node; loss, restart, expiry, or a different node requires restarting the flow. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubManifestStateStore.java`]

The callback requires nonblank `code` and `state`, an active system-administrator session, a valid state, and the original user. It exchanges the temporary code unauthenticated at `POST https://api.github.com/app-manifests/{encoded-code}/conversions`, accepting `200` or `201`, and reads App ID, slug, client ID, client secret, webhook secret, PEM private key, and App URL. Requested authentication and DevOps settings are persisted in one SonarQube transaction. If authentication already exists, it is left unchanged while DevOps setup may continue. A successful flow redirects to App installation when a slug or App URL is available; otherwise it returns to the initiating settings page. A failed SonarQube transaction cannot delete an App already created on GitHub and may leave that App unused. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubManifestCallbackFilter.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubAppCredentials.java`]

Manifest-created authentication is enabled with group synchronization off, JIT provisioning, signup allowed, project-visibility mirroring on, no upgrade-consent marker, GitHub.com URLs, and an organization allowlist containing the selected organization or empty for personal creation. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubManifestCallbackFilter.java`]

## 6. Token behavior

### 6.1 App JWT

The App private key must decode as an RSA PKCS#8 PEM key. The integration signs an RS256 JWT with issuer equal to the decimal App ID, current issued-at time, and expiry nine minutes later. Invalid or undecodable keys fail without sending a GitHub request. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/security/GithubAppSecurityImpl.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/security/AppToken.java`]

### 6.2 Installation tokens

An App JWT is exchanged at `/app/installations/{installationId}/access_tokens`. The ordinary form covers the installation's available repositories. The least-privilege form sends one bare repository name in `repositories`, limiting the token to that repository. Missing token content, non-success, parse failure, or transport failure returns no token from the client and is converted by callers into a contextual failure. Installation-token expiry is parsed as ISO date-time. Refreshable tokens refresh lazily when absent or within one minute of provider expiry. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/ExpiringAppInstallationToken.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/AutoRefreshableAppToken.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/AppInstallationTokenGenerator.java`]

`POST /api/v2/dop-translation/github-installation-tokens?project=<projectKey>` is internal and system-administrator-only. It resolves the project, its GitHub binding, App setting, and `owner/repository` binding; validates App URL, credentials, and the stricter token-minting permission set `checks: write`, `pull_requests: write`, `metadata: read`, and `contents: write`; discovers the installation through `/repos/{owner/repository}/installation`; and mints a fresh token scoped to the bare repository name. It does not cache tokens. Network I/O occurs after the read-only database session is closed. Success returns `token` and ISO-offset `expiresAt`. Unknown, unbound, non-GitHub, repository-less, or non-installed projects result in not found. Invalid App configuration is a bad request with project context. Token-creation failure after installation discovery is an internal-server error. CR and LF are removed from project and repository values before logging. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/installationtoken/controller/GithubInstallationTokenController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/installationtoken/controller/DefaultGithubInstallationTokenController.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/github/GithubInstallationTokenProviderImpl.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubAppPermissions.java`]

### 6.3 User access tokens for import

`GET /api/alm_integrations/get_github_client_id` returns a selected App setting's client ID to a logged-in user with `Create Projects`; missing setting or client ID is not found. The browser obtains a GitHub authorization code. Supplying that code as `token` to `GET /api/alm_integrations/list_github_organizations` exchanges it at `/login/oauth/access_token` using the selected App's client ID and decrypted client secret, extracts `access_token` from the form response, and inserts or replaces the current user's token for that App setting. Omitting `token` reuses the stored token and fails if none exists. Provider non-`200`, missing token, expired code, invalid client fields, or I/O produces the documented authentication or internal failure. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/GetGithubClientIdAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/ListGithubOrganizationsAction.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`]

## 7. REST transport, organizations, teams, and repositories

App and import HTTP clients inherit configured proxy behavior, apply configured connect and read timeouts, and do not follow redirects. Authenticated GitHub requests use `Authorization` with the token's scheme and value and add `X-GitHub-Api-Version: 2022-11-28`. App and installation schemes are `Bearer`/`Token` as provided by their token types; stored user tokens use `token`. Rate-limit headers are `x-ratelimit-remaining`, `x-ratelimit-limit`, and `x-ratelimit-reset`. Absolute pagination links are accepted. A next link identical to the current request is ignored to prevent a loop. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericApplicationHttpClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubHeaders.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/security/UserAccessToken.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/ExpiringAppInstallationToken.java`]

Bulk pagination requests `per_page=100`. After each response, when complete rate-limit headers exist and at least 90 percent of quota is used, processing pauses until reset. Interruption is preserved and logged. Non-2xx during a paginated operation aborts the whole operation; already collected entries are not returned as a partial result. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericPaginatedHttpClient.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/RatioBasedRateLimitChecker.java`]

`GET /api/alm_integrations/list_github_organizations` requires login plus `Create Projects`, `almSetting`, optional authorization-code `token`, page default `1`, and page size default `100`. Page and page size must be positive and page size must not exceed 100. It calls `/user/installations` and returns paging plus organization key/name from installation account login. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/ListGithubOrganizationsAction.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`]

`GET /api/alm_integrations/list_github_repositories` requires login plus `Create Projects`, `almSetting`, organization, stored user token, optional text query, page default `1`, and page size default `100`. It searches `/search/repositories` with `fork:true` and `org:<organization>`; spaces in the optional query become plus signs. Results contain numeric `id`, full-name `key`, repository `name`, HTML `url`, and, when already bound, `sqProjectKey`. Total comes from GitHub's `total_count`. If multiple SonarQube projects are bound to the same repository, the natural-order smallest project key is reported. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/ListGithubRepositoriesAction.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubBinding.java`]

Provider-side provisioning calls additionally enumerate all App installations, repository teams at `/repos/{org}/{repo}/teams`, and direct collaborators at `/repos/{org}/{repo}/collaborators?affiliation=direct`. Installation filtering retains only organization accounts and then applies the exact configured organization allowlist; empty allowlist accepts all organization installations. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`]

## 8. Project import and binding

The preferred import contract is `POST /api/v2/dop-translation/bound-projects`; idempotent create-or-update uses `PUT` at the same path. Inputs are explicit `projectKey`, `projectName`, DevOps setting UUID, GitHub `owner/repository` as `repositoryIdentifier`, optional new-code fields, and required `monorepo`. POST returns created project UUID, binding UUID, and whether a new project was created, with HTTP `201`. PUT returns the same shape with HTTP `200`; updating an existing project also requires project administration. Both require login, `Create Projects`, and a stored per-user token for the selected setting. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/BoundProjectsController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/DefaultBoundProjectsController.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/request/BoundProjectCreateRestRequest.java`]

Deprecated `POST /api/alm_integrations/import_github_project` accepts required `repositoryKey` up to 256 characters, optional `almSetting`, and optional new-code type/value. It requires `Create Projects`, resolves the setting by the precedence in section 3.3, and returns the created project's key, name, qualifier, and visibility through the legacy protobuf/JSON media contract. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/ImportGithubProjectAction.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/ImportHelper.java`]

For either API, the GitHub adapter loads `/repos/{owner/repository}` with the current user's stored token. Provider repository `name` becomes the default project name for legacy import, `full_name` is the provider identifier and project-key source, `private` controls initial visibility, and `default_branch` becomes main-branch metadata. Failure to find the repository aborts import. Project creation and binding transactions belong to project configuration. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/github/GithubDevOpsProjectCreationContextService.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubApplicationClient.java`]

When automatic GitHub provisioning is enabled, import must also find the repository within the global authentication App's installation scope and mint an installation token. If it cannot, project creation fails rather than creating a project whose permissions cannot be checked. Scan permission is allowed when either the importing user's direct collaborator role maps to `scan`, or one of the repository's teams maps to `scan` and the user belongs to the corresponding local external group for that organization. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/github/GithubProjectCreatorFactory.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/github/GithubProjectCreator.java`]

## 9. Provisioning, mappings, and lifecycle

### 9.1 Configuration validation

`POST /api/github_provisioning/check` is internal and system-administrator-only and always returns HTTP `200` with structured JIT and automatic-provisioning statuses. Invalid/non-numeric App ID, incomplete App configuration, provider HTTP failure, no allowed installation, suspended installation, and missing permissions are expressed in the body. JIT requires App-level `emails`. Automatic provisioning additionally requires `members`, `organization_administration`, repository `administration`, and `metadata`; installation-level automatic status checks the latter common set. Every non-suspended allowed installation gets its own organization status. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/GithubProvisioningWs.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/config/CheckAction.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/config/GithubProvisioningConfigValidator.java`]

### 9.2 State transitions

Creating a global configuration with `AUTO_PROVISIONING`, or updating from JIT to automatic provisioning, queues synchronization after validating that authentication is enabled and that no different provider manages the instance. Clearing the upgrade-consent marker while remaining in automatic mode also queues a run. The task name exposed for project-permission work is `GITHUB_PROJECT_PERMISSIONS_PROVISIONING`. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/github/config/GithubConfigurationService.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubSettings.java`]

Changing from automatic provisioning to JIT deletes GitHub-owned external-group records and all GitHub organization-to-local-group mappings in the same configuration transaction. The older direct `setProvisioning(false)` path does the same. Deleting the API-v2 configuration removes global settings, internal provisioning state, and GitHub external-group records, but the observed delete path does not delete organization-to-local-group mapping rows. This distinction is compatibility behavior for this pinned release. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/github/config/GithubConfigurationService.java`; `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubSettings.java`; `server/sonar-webserver-common/src/it/java/org/sonar/server/common/github/config/GithubConfigurationServiceIT.java`]

The inspected Community Build production tree exposes the provider controls, queue handoff, client operations, and task identifier but does not contain a GitHub-specific synchronization-task executor. This specification therefore does not invent group/user reconciliation behavior beyond the observed contracts above. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/management/ManagedInstanceService.java`; repository search for `GITHUB_PROJECT_PERMISSIONS_PROVISIONING` at pinned commit]

### 9.3 Repository role precedence

Default mappings are:

| GitHub role | SonarQube project permissions |
|---|---|
| `read` | `user`, `codeviewer` |
| `triage` | `user`, `codeviewer` |
| `write` | `user`, `codeviewer`, `issueadmin`, `securityhotspotadmin`, `scan` |
| `maintain` | `user`, `codeviewer`, `issueadmin`, `securityhotspotadmin`, `scan` |
| `admin` | `user`, `codeviewer`, `issueadmin`, `securityhotspotadmin`, `scan`, `admin` |

Team permission names normalize as `pull` to `read`, `triage` to `triage`, `push` to `write`, `maintain` to `maintain`, and `admin` to `admin`. An exact configured role mapping has precedence and ignores the boolean vector. If that role has no mapping, fallback performs an exact lookup of the repository tuple in field order `(admin, maintain, push, triage, pull)`:

| Base role | Exact accepted tuple |
|---|---|
| `none` | `(false, false, false, false, false)` |
| `read` | `(false, false, false, false, true)` |
| `triage` | `(false, false, false, true, true)` |
| `write` | `(false, false, true, true, true)` |
| `maintain` | `(false, true, true, true, true)` |
| `admin` | `(true, true, true, true, true)` |

Only those six tuples select a base role. No ranking or nearest-role reduction occurs. Any other boolean combination has no fallback mapping, yields an empty SonarQube permission set, and records a warning. The canonical `none` tuple likewise yields empty unless a `none` mapping has been configured. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GsonRepositoryPermissions.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubPermissionConverter.java`; `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/PopulateInitialSchema.java`]

The bundled Java client can submit a role plus six booleans (`user`, `codeViewer`, `issueAdmin`, `securityHotspotAdmin`, `admin`, `scan`) to `POST /api/v2/dop-translation/github-permission-mappings`. No matching server controller is present in the inspected Community Build production source, so server availability of that route is not asserted here. [Provenance: `sonar-ws/src/main/java/org/sonarqube/ws/client/github/provisioning/permissions/GithubPermissionsService.java`; `sonar-ws/src/main/java/org/sonarqube/ws/client/github/provisioning/permissions/AddGithubPermissionMappingRequest.java`; `sonar-ws/src/main/java/org/sonarqube/ws/client/github/provisioning/permissions/SonarqubePermissions.java`]

## 10. Webhook trust boundary

A request without `x-github-hook-installation-target-id` is not claimed by GitHub webhook authentication. A claimed request must include `x-hub-signature-256`, a readable body, and a stored webhook secret for the App ID. The body is read as text lines and rejoined with the runtime line separator before signing. The integration computes HMAC-SHA-256 over that reconstructed text, prefixes the hexadecimal digest with `sha256=`, and compares bytes in timing-attack-resistant form. Missing signature, unreadable body, missing secret, or mismatch records an authentication failure and rejects the request. A valid signature creates the restricted GitHub-webhook authentication result; identity-access owns its authorization semantics. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/GithubWebhookAuthentication.java`]

## 11. Health metric

After initial delay configured by `sonar.server.monitoring.devops.initial.delay` or 10,000 ms, and every `sonar.server.monitoring.devops.period` or 300,000 ms, the GitHub health task validates every persisted GitHub DevOps App setting. Gauge `sonarqube_health_integration_github_status` is `1` only when at least one exists and all validate; it is `0` when none exists or any validation throws. Validation covers App ID, client fields, API URL, private key, and required App permissions. [Provenance: `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/DevOpsMetricsTask.java`; `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/GithubMetricsTask.java`; `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ServerMonitoringMetrics.java`]

## 12. Failure, recovery, security, and limits

- OAuth CSRF state must be verified before code exchange. OAuth and manifest callbacks never authenticate solely from provider-supplied identity fields. [Provenance: `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubIdentityProvider.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubManifestCallbackFilter.java`]
- Client secret, private key, webhook secret, provisioning credentials, user access tokens, App JWTs, and installation tokens cross a trust boundary. Configuration reads omit secrets. The installation-token endpoint is the intentional exception and is restricted to system administrators. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/config/resource/GithubConfigurationResource.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/installationtoken/controller/DefaultGithubInstallationTokenController.java`]
- Provider redirects are not followed by App/import clients, limiting credential forwarding to unexpected hosts. OAuth redirect behavior remains owned by the OAuth library and identity-access callback contract. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericApplicationHttpClient.java`]
- Pagination treats an absolute provider-supplied `rel="next"` URL as the next destination and sends the current credential there. The configured GitHub endpoint and GitHub response are therefore trusted to keep pagination links on an authorized host. Redirect blocking does not constrain this explicit next-link behavior. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericApplicationHttpClient.java`; `server/sonar-auth-common/src/main/java/org/sonar/auth/OAuthRestClient.java`]
- Import organization and repository enumeration returns no partial success after a later page fails. Retrying is safe for reads. Project import retry and duplicate handling follow the POST/PUT semantics in section 8. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericPaginatedHttpClient.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/controller/BoundProjectsController.java`]
- GitHub.com, Enterprise Server `/api/v3`, and Enterprise Cloud data-residency API hosts are supported for manual configuration. Manifest creation is GitHub.com-only. Page size is at most 100. Manifest state lives one hour on one web node. App JWT lifetime is nine minutes; GitHub-provided installation expiry controls installation-token lifetime. [Provenance: `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubAppManifestGenerator.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubManifestStateStore.java`; `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/security/AppToken.java`]

## 13. Acceptance scenarios

1. **Disabled or incomplete OAuth configuration.** Given `sonar.auth.github.enabled=true` but an empty client secret, when login providers are evaluated, GitHub is disabled and no OAuth redirect is offered.
2. **Organization allowlist admission.** Given allowed organizations `alpha` and `beta`, when a user belongs only to `gamma`, callback verification succeeds but authentication is rejected before local session creation.
3. **Installation-based admission.** Given an empty allowlist and App installations on `alpha` and a personal account, when the user belongs to `alpha`, authentication succeeds; membership only in the personal account does not satisfy admission.
4. **Private email fallback.** Given a user profile without public email and an email list whose primary address is unverified, when callback runs, no email is selected; a primary verified address is selected when present.
5. **Team handoff.** Given group sync enabled and membership in organization `acme`, team slug `platform`, when callback completes, the external identity contains `acme/platform`.
6. **Configuration read redaction.** Given a stored API-v2 configuration, when a system administrator reads it, application ID and non-secret options are present, client secret and private key are absent, and live validation failure appears only in `errorMessage`.
7. **Secure URL update.** Given an existing configuration, when a patch changes `apiUrl` without supplying `privateKey`, the update is rejected and no property changes commit.
8. **Manifest replay.** Given a valid manifest state already consumed once, when the callback is replayed, it redirects with an invalid-or-expired result and does not persist credentials again.
9. **Manifest partial external failure.** Given GitHub created the App but SonarQube persistence fails, when callback handles the error, no partial SonarQube configuration commits; the external App may remain unused and the administrator can restart setup.
10. **Repository enumeration.** Given page `1`, page size `100`, organization `acme`, and query `build tools`, when repositories are listed, the GitHub search includes organization, forks, and the query with spaces converted to plus signs; existing bindings include `sqProjectKey`.
11. **Role and tuple precedence.** Given team permission `push`, a configured `write` mapping, and a contradictory lower boolean vector, the exact `write` mapping wins. Given no matching role mapping and noncanonical tuple `(false, true, false, true, true)`, resolution grants no SonarQube permission and records a warning rather than ranking it as a base role.
12. **Auto-provisioned import scope failure.** Given automatic provisioning enabled but the authentication App is not installed on the selected repository, when import runs, project creation fails rather than bypassing permission checks.
13. **Least-privilege installation token.** Given an administrator requests a token for a GitHub-bound project, when the App has all token-minting permissions, the returned token is scoped to the repository's bare name and includes provider expiry; no cached token is reused.
14. **Webhook forgery.** Given an App-ID header and body with an invalid HMAC signature, when webhook authentication runs, it uses constant-time comparison, records failure, and denies authentication.
15. **Rate-limit pause.** Given a paginated response reports 90 percent of quota consumed and a future reset, when another page is needed, provisioning pauses until reset rather than immediately issuing the request.
16. **Health aggregation.** Given two GitHub App settings where one validates and one fails, when the monitoring task runs, `sonarqube_health_integration_github_status` is `0`.

## 14. Provenance index

Primary pinned source paths:

- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubSettings.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubIdentityProvider.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/ScribeGitHubApi.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GitHubRestClient.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/UserIdentityFactoryImpl.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubTeamConverter.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubAppConfiguration.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubAppCredentials.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubAppPermissions.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubApplicationClient.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GithubBinding.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/GsonRepositoryPermissions.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/AppInstallationTokenGenerator.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/AutoRefreshableAppToken.java`
- `server/sonar-auth-github/src/main/java/org/sonar/auth/github/ExpiringAppInstallationToken.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericApplicationHttpClient.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/GenericPaginatedHttpClient.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/RatioBasedRateLimitChecker.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubApplicationClientImpl.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubGlobalSettingsValidator.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/GithubPermissionConverter.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/config/GithubProvisioningConfigValidator.java`
- `server/sonar-alm-client/src/main/java/org/sonar/alm/client/github/security/GithubAppSecurityImpl.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/github/config/GithubConfigurationService.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/github/GithubDevOpsProjectCreationContextService.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/github/GithubProjectCreatorFactory.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/github/GithubProjectCreator.java`
- `server/sonar-webserver-common/src/main/java/org/sonar/server/common/almsettings/github/GithubInstallationTokenProviderImpl.java`
- `server/sonar-server-common/src/main/java/org/sonar/server/almsettings/MultipleAlmFeature.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/AlmSettingsSupport.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateGithubAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/UpdateGithubAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/CreateGithubFromManifestAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubAppManifestGenerator.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubManifestStateStore.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almsettings/ws/GithubManifestCallbackFilter.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/GetGithubClientIdAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/ListGithubOrganizationsAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/ListGithubRepositoriesAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/ImportGithubProjectAction.java`
- `server/sonar-webserver-webapi/src/main/java/org/sonar/server/almintegration/ws/github/config/CheckAction.java`
- `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/config/`
- `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/github/installationtoken/`
- `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/projects/`
- `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/GithubWebhookAuthentication.java`
- `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/devops/GithubMetricsTask.java`
- `server/sonar-webserver-monitoring/src/main/java/org/sonar/server/monitoring/ServerMonitoringMetrics.java`
- `server/sonar-db-migration/src/main/java/org/sonar/server/platform/db/migration/version/v00/PopulateInitialSchema.java`
- `sonar-ws/src/main/java/org/sonarqube/ws/client/github/provisioning/permissions/`
