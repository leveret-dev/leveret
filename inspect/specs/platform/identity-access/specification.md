# Identity and Access Specification

## 1. Pinned identity and license

This specification describes the identity-and-access behavior shipped in SonarQube Community Build `26.8.0.126808`, published 2026-08-05 from `SonarSource/sonarqube` tag `26.8.0.126808` at commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The authoritative platform source is the pinned Community Build tree. Production source is licensed `LGPL-3.0-or-later`; the controlling notices are `LICENSE.txt` and `HEADER.spotless` in that tree. The pinned Sonar Plugin API dependency is `org.sonarsource.api.plugin:sonar-plugin-api:13.8.0.4399`, also LGPL v3.

## 2. Purpose, scope, and ownership

This part owns local identities, authentication dispatch, browser sessions, access tokens, cookies, CSRF enforcement, users, groups, memberships, global and project permission decisions, project visibility effects on authorization, and permission templates. It provides the credential, session, CSRF, and authorization decisions consumed by the HTTP API, project configuration, analysis results, scanner gateway, provider integrations, and Web UI.

It does not own LDAP, SAML, GitHub, GitLab, Bitbucket, or Azure protocol exchanges. Those integrations may produce a verified external identity or group set; this part owns how that result is registered as a local user, turned into a session, and authorized. It also does not define HTTP serialization conventions, search-index internals, project lifecycle, or issue state transitions.

The persistence contract is consumed from `platform/persistence/`; routing and generic error representation are consumed from `platform/http-api/`; provider-specific protocols are consumed from their integration specifications. [Provenance: `manifest/dependency-map.md`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/user/`]

## 3. Public identifiers and configuration

### 3.1 Authentication and session identifiers

- Browser session cookie: `JWT-SESSION`.
- Browser CSRF cookie: `XSRF-TOKEN`.
- Browser CSRF request header: `X-XSRF-TOKEN`.
- Access-token request header: `Authorization`, accepting `Bearer <token>` and Basic credentials whose password portion is empty.
- Token-expiration response header: `SonarQube-Authentication-Token-Expiration` when the authenticated access token has an expiration date.
- System-passcode request header: `X-Sonar-Passcode`; its value is compared in constant time with `sonar.web.systemPasscode`.
- Authentication controller: `api/authentication`; actions: `login`, `logout`, `validate`.
- Access-token controller: `api/user_tokens`; actions: `generate`, `revoke`, `search`.

[Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/JwtHttpHandler.java`; `JwtCsrfVerifier.java`; `UserSessionInitializer.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/authentication/ws/AuthenticationWs.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/usertoken/ws/`]

### 3.2 Security configuration

- `sonar.forceAuthentication` defaults to `true`. An unauthenticated request to a protected route is rejected even if the target data would otherwise be public.
- `sonar.web.sessionTimeoutInMinutes` controls browser inactivity expiry. The default is 3 days; accepted values are 6 minutes through 129,600 minutes, inclusive at the upper bound.
- The absolute browser-session lifetime in Community Build is 90 days.
- `sonar.auth.jwtBase64Hs256Secret` supplies a Base64-encoded HMAC-SHA-256 signing key. When absent, a key is generated at process startup.
- Trusted reverse-proxy header authentication is enabled by `sonar.web.sso.enable`, default `false`. Header-name defaults are `X-Forwarded-Login`, `X-Forwarded-Name`, `X-Forwarded-Email`, and `X-Forwarded-Groups`; `sonar.web.sso.refreshIntervalInMinutes` defaults to `5`.
- `sonar.web.systemPasscode` is a separate operator credential sent in `X-Sonar-Passcode` and accepted only by the explicitly designated monitoring/system routes. It is not a user identity and conveys no ordinary user permissions.
- `sonar.allowPermissionManagementForProjectAdmins` defaults to `true` and controls whether a project administrator may use project-scoped permission-management operations; system administrators remain authorized.

[Provenance: `server/sonar-process/src/main/java/org/sonar/process/ProcessProperties.java`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/HardcodedActiveTimeoutProvider.java`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/HttpHeadersAuthentication.java`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/JwtSerializer.java`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/user/SystemPasscodeImpl.java`; `sonar-core/src/main/java/org/sonar/core/config/SecurityProperties.java`; pinned Plugin API `plugin-api/src/main/java/org/sonar/api/CoreProperties.java` at tag `13.8.0.4399`]

### 3.3 Permission identifiers

Global permission keys are:

- `admin`: administer the system.
- `gateadmin`: administer quality gates.
- `profileadmin`: administer quality profiles.
- `provisioning`: create/provision projects.
- `scan`: execute analysis globally.
- `applicationcreator` and `portfoliocreator` are present in the shared enum, but this Community specification assigns no commercial application or portfolio creation behavior to them.

Project permission keys are:

- `user`: browse project results.
- `admin`: administer the project.
- `codeviewer`: view source code.
- `architectureadmin`: administer architecture information where such a feature is present; no commercial behavior is inferred here.
- `issueadmin`: administer issues.
- `securityhotspotadmin`: administer security hotspots.
- `scan`: execute analysis for the project.

The virtual group name `Anyone` represents anonymous and universal grants without a persisted group record. Initial built-in groups include `sonar-users` and `sonar-administrators`; `sonar-users` is the default group for locally registered users. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/permission/GlobalPermission.java`; `ProjectPermission.java`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/usergroups/DefaultGroupFinder.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/startup/RegisterPermissionTemplates.java`]

## 4. Authentication dispatch

### 4.1 Ordinary request precedence

For each protected HTTP request, authentication is attempted in this order:

1. Trusted HTTP-header SSO, when enabled and the configured login header is present.
2. The signed `JWT-SESSION` browser cookie.
3. A SonarQube access token supplied as Bearer credentials or as the Basic username with an empty password.
4. The dedicated GitHub webhook authenticator for its narrowly recognized webhook requests.
5. Basic login/password authentication.
6. Anonymous session if no mechanism supplied a user.

The first applicable successful mechanism wins. Header SSO intentionally precedes the JWT cookie so a changed proxy identity can replace a cookie for a different user. A malformed or invalid credential may raise an authentication failure instead of falling through to a lower-priority mechanism. Provider-specific validation remains in the integration that owns that provider. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/RequestAuthenticatorImpl.java`]

`GET api/authentication/validate` has its own compatibility order: trusted headers, JWT, Basic authentication, then access-token authentication. It emits a JSON boolean field `valid`; when no credential resolves a user, `valid` is true only if forced authentication is disabled. Authentication exceptions produce `valid: false` rather than exposing the internal cause. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/authentication/ws/ValidateAction.java`]

### 4.2 Route enforcement

With forced authentication enabled, protected Web API and batch requests without a logged-in session receive HTTP 401. Web pages remain eligible for the UI login flow. Static resources and the explicitly excluded bootstrap, maintenance, setup, OAuth callback, authentication, status, public badge, identity-provider discovery, localization, and login-message routes are not subject to the ordinary session initializer. System-passcode routes form a separate allowlist and do not become general anonymous routes. Access-log and diagnostic context record the resolved login or `-`. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/UserSessionInitializer.java`]

### 4.3 Basic and local credentials

Basic authentication is recognized case-insensitively, Base64-decodes UTF-8 credentials, and splits at the first colon. A missing login or colon, or invalid Base64, is an authentication failure. A non-empty password selects login/password authentication. An empty password selects access-token authentication using the Basic username.

Local passwords are never persisted in plaintext. New hashes use PBKDF2 with HMAC-SHA-512, a 512-bit result, a fresh 20-byte random salt, and 100,000 iterations by default. The stored hash carries its iteration count. A successful login recomputes and replaces the hash when the configured iteration count changed. Invalid or unknown stored hash data fails authentication. A dummy PBKDF2 computation is performed on selected invalid-user/hash paths to reduce user-enumeration timing differences. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/BasicAuthentication.java`; `CredentialsLocalAuthentication.java`]

`POST api/authentication/login` requires non-empty `login` and `password`, creates a browser session on success, and returns 401 on authentication failure. Other HTTP methods return 400. `POST api/authentication/logout` deletes the persisted browser-session row when the cookie can be decoded and expires both browser cookies even if authentication-event recording fails. Other methods return 400. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/authentication/ws/LoginAction.java`; `LogoutAction.java`]

### 4.4 Trusted-header boundary

When trusted-header SSO is enabled, the front proxy is the authentication authority. A missing configured login header means the mechanism is not applicable. Name defaults to the login; email is optional; the groups header, when present, is parsed as trimmed comma-separated names, including an explicitly empty set. A recent matching JWT may be reused until the configured SSO refresh interval; otherwise local user/group registration is refreshed and a new JWT is emitted. Deployments must strip untrusted client-supplied versions of these headers before they reach SonarQube. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/HttpHeadersAuthentication.java`]

## 5. Browser-session and CSRF state machine

### 5.1 Creation and representation

A successful browser login creates:

- a durable session record containing a new session UUID, user UUID, and inactivity expiration;
- a signed HS256 JWT containing that session UUID, user UUID as subject, issue and expiration times, last-refresh time, and a CSRF value;
- an HttpOnly `JWT-SESSION` cookie; and
- a script-readable `XSRF-TOKEN` cookie containing the same CSRF value.

Cookie path is the server context path, or `/` at the root. Both session and CSRF cookies use `SameSite=Lax` when emitted as session cookies. `JWT-SESSION` is HttpOnly; `XSRF-TOKEN` is not. `Secure` is set only when `X-Forwarded-Proto` equals `https`, case-insensitively, so correct trusted-proxy forwarding is a security requirement. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/JwtHttpHandler.java`; `JwtCsrfVerifier.java`; `Cookies.java`; `JwtSerializer.java`]

### 5.2 Validation and refresh

A browser cookie is accepted only when its signature and required claims are valid, its JWT expiration has not passed, its durable session row exists and has not expired, the 90-day absolute lifetime has not passed, the referenced user exists and is active, and any required CSRF check succeeds. A missing, expired, unsupported, or incorrectly signed JWT does not authenticate a user. Malformed required claims produce an authentication failure.

After five minutes without refresh, a valid active request extends the inactivity expiration, rewrites the JWT and both cookies, and updates the durable expiration in one database transaction. Activity never extends the 90-day absolute lifetime measured from the original issue time. Logout or user deactivation deletes the durable session, immediately invalidating otherwise unexpired cookies. Expired durable session rows are purged every 24 hours under the cluster-wide `SessionCleaner` lock; inability to acquire the lock skips that run because another node owns it. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/JwtHttpHandler.java`; `purge/ExpiredSessionsCleaner.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/user/UserDeactivator.java`]

### 5.3 CSRF enforcement

CSRF comparison applies only while authenticating a JWT-backed browser request whose method is `POST`, `PUT`, `DELETE`, or `PATCH` and whose context-relative path begins `/api`. The request must send `X-XSRF-TOKEN` exactly equal, including case, to the CSRF value signed into the JWT. A missing signed reference or mismatch fails authentication. Read methods and non-API paths are not checked by this verifier. Bearer, Basic, and access-token sessions are not browser JWT sessions and do not use this cookie-based CSRF check. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/JwtCsrfVerifier.java`; `RequestAuthenticatorImpl.java`]

## 6. Access tokens

### 6.1 Types and scope

`USER_TOKEN` has the live permissions of its owner. `GLOBAL_ANALYSIS_TOKEN` exposes only the owner's live scalar global `scan` and `provisioning` permissions and returns false for scalar project-permission checks; it does not create project-specific grants. Its bulk entity/component filtering is intentionally different: it delegates to the owner's ordinary authorization filter, so list/search results may include public projects plus private projects on which the owner has the requested browse-level permission. `PROJECT_ANALYSIS_TOKEN` is bound to one project and grants analysis access only when the owner still has that project's `scan` permission or global `scan`; it does not inherit other global permissions. Bulk filtering for a project token is restricted to its bound project and rechecks live `user` or `scan` authorization. Thus deleting a grant constrains an otherwise unexpired token on its next request. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/user/TokenUserSession.java`; `server/sonar-webserver-auth/src/it/java/org/sonar/server/user/TokenUserSessionIT.java`]

Generated tokens have the public form `sq` plus a type identifier, `_`, and 40 lowercase hexadecimal characters derived from 20 secure-random bytes. Only a SHA-384 digest is persisted. The plaintext token is returned only by the generation response and must not be recoverable through search. Names are scoped to the owner and must be unique for that owner; maximum name length is 100. Optional expiration is an ISO `YYYY-MM-DD` date interpreted at midnight UTC. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/usertoken/TokenGeneratorImpl.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/usertoken/ws/GenerateAction.java`]

`POST api/user_tokens/generate` defaults `type` to `USER_TOKEN`; `PROJECT_ANALYSIS_TOKEN` requires `projectKey`; other type/parameter combinations are rejected. Omitting `login` targets the current user; specifying another login requires system administration. `api/user_tokens/search` returns metadata, not token secret, and its last-connection date may lag by up to one hour. `POST api/user_tokens/revoke` deletes the named token, with the same own-user versus system-administrator rule. Authentication rejects missing hashes, expired tokens, deleted or inactive owners, and returns the expiration response header for accepted expiring tokens. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/usertoken/ws/`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/usertoken/UserTokenAuthentication.java`]

## 7. Users and groups

### 7.1 User state and transitions

A user has an immutable internal UUID and mutable public/login attributes: login, name, optional email, local/external identity fields, SCM accounts, active flag, password-reset flag, last-connection dates, and optional homepage state. Legacy creation accepts login length 2–255, name up to 200, email up to 100, and zero or more unique SCM accounts without leading or trailing whitespace. A local user requires a password; a non-local user must not be assigned a local password. Login is unique among active users. Creating a login that belongs to a deactivated user reactivates that record instead of creating a second identity.

Deactivation is a durable active-to-inactive transition, not deletion. It is rejected for the last remaining system administrator and, in the v2 API, for self-deactivation. It revokes access and browser tokens, removes group memberships, direct permissions, template grants, profile/gate edit grants, user-scoped properties, dismissed-message state, and related personal access data. Optional anonymization additionally replaces identifying data. Rebinding an external identity revokes all browser sessions and access tokens so the old external principal loses access. Externally managed users cannot be locally changed in ways reserved to their authority. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/user/service/UserService.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/user/UserDeactivator.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/user/ws/CreateAction.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/user/controller/DefaultUserController.java`]

### 7.2 Group state and transitions

A group has an internal UUID, unique name, optional description, member set, default-group flag, and externally-managed flag. Local creation rejects duplicate names. The default `sonar-users` group cannot be renamed, deleted, or used for explicit membership removal. Deleting another group is rejected if it would remove the last group path to a system administrator; otherwise its direct permissions, template grants, memberships, profile/gate edit grants, and external mappings are removed with the group. Externally managed groups and memberships cannot be changed through local mutation APIs. The `Anyone` principal is virtual and cannot be managed as an ordinary membership group. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/group/service/GroupService.java`; `GroupMembershipService.java`]

### 7.3 Public user/group APIs

Legacy controllers remain observable:

- `api/users`: `anonymize`, `change_password`, `create`, `current`, `deactivate`, `dismiss_notice`, `groups`, `identity_providers`, `search`, `set_homepage`, `update`, `update_identity_provider`, and `update_login` where registered. Several actions are internal or deprecated; their flags remain part of API metadata.
- `api/user_groups`: `add_user`, `create`, `delete`, `remove_user`, `search`, `update`, `users`.

The v2 JSON APIs are rooted at `api/v2`:

- `api/v2/users-management/users`: GET collection search, POST create, GET by `{id}`, merge-patch by `{id}`, and DELETE by `{id}` with optional `anonymize=false`.
- `api/v2/authorizations/groups`: GET collection search, POST create, GET by `{id}`, merge-patch by `{id}`, and DELETE by `{id}`.
- `api/v2/authorizations/group-memberships`: GET search, POST membership creation, and DELETE by membership `{id}`.

User search is login-sorted and active-only by default. Email, external identity, groups, connection dates, and token count are returned only to the subject user or a system administrator. Group and membership v2 operations require a logged-in system administrator; mutating an externally managed instance is rejected. Generic pagination, media types, and error envelopes belong to `platform/http-api/`. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/WebApiEndpoints.java`; `api/user/controller/UserController.java`; `api/group/controller/GroupController.java`; `api/membership/controller/GroupMembershipController.java`]

## 8. Authorization and visibility precedence

### 8.1 Effective grants

Authorization is additive; there is no deny record. For a logged-in user, effective global permissions are the union of direct user grants, grants to every current group, and grants to `Anyone`. Anonymous effective global permissions are `Anyone` grants only. Project permissions use the same union at the project entity. Permission checks on files, directories, and branches resolve to their owning project's UUID.

For a public project, `user` and `codeviewer` are implicit for every principal before stored grants are added. A private project has no implicit project permissions. Global `admin` defines system-administrator status but does not automatically appear as every project permission in the core resolver; individual endpoints may explicitly accept system administration as an alternative. Permission and group results are cached for the life of the request session, so a grant changed concurrently need not affect an already-running request. [Provenance: `server/sonar-db-dao/src/main/resources/org/sonar/db/permission/AuthorizationMapper.xml`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/user/ServerUserSession.java`; `server/sonar-db-dao/src/main/java/org/sonar/db/permission/ProjectPermission.java`]

Changing a project from public to private removes `Anyone` grants and materializes `user` and `codeviewer` for each user/group that already had another direct permission, preserving their access. Changing private to public removes explicit user/group `user` and `codeviewer` because those grants become implicit. Visibility is propagated to every branch and component in the relational transaction. Indexers first enqueue recovery rows in `es_queue`, commit those rows with the visibility and permission changes, and only then attempt post-commit indexing. An indexing failure therefore leaves a recoverable queue item and may temporarily expose a stale search authorization projection until recovery succeeds; it does not roll back the authoritative relational change. A visibility change is refused while ordinary compute tasks for the entity are pending or running. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/project/VisibilityService.java`; `server/sonar-server-common/src/main/java/org/sonar/server/es/IndexersImpl.java`]

### 8.2 Permission APIs

`api/permissions` exposes direct grant and template operations:

- Direct assignments: `add_user`, `remove_user`, `add_group`, `remove_group`, `users`, `groups`. Omitting a project selects global scope; supplying project key or UUID selects project scope.
- Templates: `create_template`, `update_template`, `delete_template`, `search_templates`, `set_default_template`, `apply_template`, `bulk_apply_template`, `add_user_to_template`, `remove_user_from_template`, `add_group_to_template`, `remove_group_from_template`, `add_project_creator_to_template`, `remove_project_creator_from_template`, `template_users`, and `template_groups`.

System administration is required for global grants and template administration. Project-scoped direct grants require system administration or project administration when project-admin permission management is enabled. Applying a template replaces all existing direct user and group permissions on each target with the template grants; project-creator characteristics are ignored for existing projects. Managed projects are skipped by bulk template application. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/permission/ws/`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/permission/PermissionTemplateService.java`]

### 8.3 Template precedence and defaults

On new project creation, every template with a nonblank regular-expression key pattern is tested against the project key. Exactly one match wins. More than one match aborts creation and names the conflicting templates. With no match, the configured default project template wins. Template grants to users, groups, and optional project-creator characteristics are copied as direct project grants. For public projects, explicit `user` and `codeviewer` template grants are omitted; for private projects, `Anyone` is omitted.

On a fresh installation, `Default template` is created if no default template is recorded. It grants project `admin` and `architectureadmin` to `sonar-administrators`, and `user`, `codeviewer`, `issueadmin`, and `securityhotspotadmin` to `sonar-users`. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/permission/PermissionTemplateService.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/startup/RegisterPermissionTemplates.java`]

## 9. Failure, recovery, and concurrency

Invalid credentials produce an unauthenticated/401 outcome without revealing password or token material. Missing entities produce not-found responses; malformed parameters and illegal state transitions produce bad-request responses; insufficient grants produce forbidden responses. The generic HTTP status body is defined by `platform/http-api/`.

User, group, membership, permission, token, and template mutations commit transactionally. Search/index visibility may be refreshed after the relational update through the shared indexing contract. Concurrent requests use request-local authorization caches; later requests observe committed changes. Session refresh updates cookie and durable expiration together. If the database is unavailable, a durable JWT cannot be validated because the session row and active user are required; it must not be treated as self-sufficient authentication.

Recovery consists of correcting configuration or permissions and retrying, logging in again after session invalidation, or generating a replacement access token after expiration/revocation. Secret values and plaintext tokens must never appear in list/search responses or logs. [Provenance: identity service and DAO paths indexed below]

## 10. Security and trust boundaries

- Treat `Authorization`, passwords, plaintext generated tokens, JWT signing keys, JWT cookies, CSRF values, system passcodes, and secured settings as secrets.
- Trust forwarded SSO and `X-Forwarded-Proto` only from a proxy that removes client-controlled copies. Header SSO otherwise allows identity spoofing, and incorrect scheme forwarding omits `Secure` cookies.
- JWT signature validation is necessary but not sufficient: durable session existence, both expiration limits, active-user state, and CSRF are mandatory.
- Authorization must resolve component access through the owning project and must apply public-project implicit grants only to `user` and `codeviewer`.
- Provider integrations may assert a verified external result but may not bypass local active-user, session, token, group, or permission rules.
- Externally managed users and groups, and the specifically guarded project visibility, permission-grant/removal, and permission-template operations, must reject conflicting local mutations. Project rename and deletion remain available to otherwise authorized callers because the pinned actions do not apply a blanket managed-project guard.

## 11. Compatibility and limits

Legacy and v2 identity APIs coexist. Clients must preserve public controller/action names, permission keys, token types, cookie/header names, and response-field visibility. Internal/deprecated actions remain discoverable only as marked by API metadata. Token last-connection reporting is deliberately coarse to one-hour updates. Session refresh is five minutes; inactivity is configurable only within the stated bounds; absolute Community lifetime is 90 days. The generated JWT signing key is process-local when no stable configured key is supplied, so restart/cluster continuity requires the configured shared secret. [INFERENCE from the observed startup generation and signature-validation contract.]

## 12. Acceptance scenarios

1. **Forced authentication.** Given default configuration and no credential, when a client calls a protected `api/*` route, then the request receives 401. When `sonar.forceAuthentication=false`, the same route obtains an anonymous session and its own permission checks decide access.
2. **Dispatch precedence.** Given enabled trusted-header SSO naming user A and a valid JWT for user B, when a protected request arrives, then user A is selected and a replacement browser session may be issued.
3. **CSRF.** Given a valid JWT browser session, when a POST under `/api` omits or changes `X-XSRF-TOKEN`, then authentication fails. The same request succeeds when the header exactly matches the value signed into the JWT and exposed in `XSRF-TOKEN`.
4. **Session revocation.** Given an otherwise unexpired JWT, when its durable session row is removed by logout or user deactivation, then the next request is anonymous or rejected; the JWT alone is insufficient.
5. **Token scope.** Given a project-analysis token bound to project A and an owner who retains scan permission only on A, when it attempts analysis on B, then authorization fails. When the owner's scan grant on A is revoked, the same token also fails on A without waiting for token expiry.
6. **Public visibility.** Given an anonymous caller and a public project, `user` and `codeviewer` checks succeed, but `scan`, `admin`, `issueadmin`, and `securityhotspotadmin` do not unless separately granted through `Anyone`.
7. **Additive grants.** Given a user with no direct permission but a group grant and an `Anyone` grant, the effective permission set is their union; removing one source preserves a permission still supplied by another.
8. **Template matching.** Given two permission-template patterns matching a new project key, creation fails without partial project state. Given one match, it overrides the default template.
9. **Last administrator.** Given the sole remaining system administrator or the last group path to administration, deactivation/deletion is rejected. After another administrator exists, the operation succeeds and related grants and sessions are removed.
10. **Secret non-disclosure.** Given a generated access token, the generation response contains the plaintext once; subsequent token search returns metadata only, and persisted authentication uses its SHA-384 digest.

## 13. Provenance index

- Release and license: `manifest/release-baseline.md`, `manifest/license-map.md`, root `LICENSE.txt`.
- Authentication dispatch and route enforcement: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/RequestAuthenticatorImpl.java`, `UserSessionInitializer.java`, `BasicAuthentication.java`, `HttpHeadersAuthentication.java`.
- Password handling: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/CredentialsLocalAuthentication.java`.
- JWT, cookie, CSRF, and cleanup: `JwtSerializer.java`, `JwtHttpHandler.java`, `JwtCsrfVerifier.java`, `Cookies.java`, `purge/ExpiredSessionsCleaner.java`.
- Access tokens: `server/sonar-webserver-auth/src/main/java/org/sonar/server/usertoken/`, `server/sonar-webserver-auth/src/main/java/org/sonar/server/user/TokenUserSession.java`, `server/sonar-webserver-webapi/src/main/java/org/sonar/server/usertoken/ws/`.
- Authentication APIs: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/authentication/ws/`.
- User/group APIs and services: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/user/ws/`, `usergroups/ws/`, `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/user/`, `api/group/`, `api/membership/`, `server/sonar-webserver-common/src/main/java/org/sonar/server/common/user/`, `common/group/`.
- Permission identifiers and resolution: `server/sonar-db-dao/src/main/java/org/sonar/db/permission/GlobalPermission.java`, `ProjectPermission.java`, `server/sonar-db-dao/src/main/resources/org/sonar/db/permission/AuthorizationMapper.xml`, `server/sonar-webserver-auth/src/main/java/org/sonar/server/user/ServerUserSession.java`.
- Permission APIs/templates/visibility: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/permission/ws/`, `server/sonar-webserver-common/src/main/java/org/sonar/server/common/permission/PermissionTemplateService.java`, `server/sonar-webserver-core/src/main/java/org/sonar/server/startup/RegisterPermissionTemplates.java`, `server/sonar-server-common/src/main/java/org/sonar/server/project/VisibilityService.java`.
- Pinned public constants: https://github.com/SonarSource/sonar-plugin-api/blob/13.8.0.4399/plugin-api/src/main/java/org/sonar/api/CoreProperties.java and https://github.com/SonarSource/sonar-plugin-api/blob/13.8.0.4399/plugin-api/src/main/java/org/sonar/api/security/DefaultGroups.java.
