# HTTP API Specification

## 1. Identity, baseline, and license

This specification defines the HTTP API part of SonarQube Community Build `26.8.0.126808`, published 2026-08-05. The authoritative source is the `SonarSource/sonarqube` tag `26.8.0.126808` at commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The official distribution is `sonarqube-26.8.0.126808.zip`, SHA-256 `ea1c5c1932f9c25350eafc4cdb1a839527c117e5d98b5fcf222a715b6b50a1f2`. Production source is licensed `LGPL-3.0-or-later`. [Provenance: `manifest/release-baseline.md`; `manifest/license-map.md`; pinned source root `LICENSE.txt`]

The externally visible transport has two API families: the metadata-driven legacy Web API beneath `/api`, and the Spring MVC REST API beneath `/api/v2`. The v2 stack consumes the build-pinned `org.sonarsource.sonarqube:sonar-spring` dependency; endpoint models may also come from other exactly pinned platform artifacts. [Provenance: `server/sonar-webserver-webapi-v2/build.gradle`; root `build.gradle`]

## 2. Purpose, ownership, and exclusions

This part owns the embedded HTTP connector behavior, web-context mounting, startup and safe-mode dispatch, route selection, legacy and v2 endpoint registration, request parsing and validation conventions, response serialization and media types, common error envelopes, paging conventions, servlet/filter behavior, common headers, API discovery, and the transport exposure of system status, health, liveness, and migration status.

Feature owners define the meaning of their resources, permissions, state machines, and payload fields. Identity and access owns credential, cookie, token, session, CSRF, and authorization semantics. Process runtime owns process start/restart/shutdown. Persistence owns migration execution. Telemetry and monitoring owns health composition and monitoring metric vocabulary. Project configuration, analysis results, scanner gateway, integrations, and other feature parts own their endpoint semantics while consuming this transport contract. [Provenance: `manifest/dependency-map.md`]

This specification does not define browser page behavior, analyzer/scanner protocols, MCP method semantics, static asset content, reverse-proxy configuration, or TLS termination. It does define how those surfaces are mounted or filtered when they share the embedded server.

## 3. Embedded connector and web context

The server uses one embedded Tomcat HTTP/1.1 connector. It binds `sonar.web.host`, default `0.0.0.0`, and `sonar.web.port`, default `9000`; a negative port fails startup. The connector itself must remain HTTP, not HTTPS. Deployments requiring TLS terminate it outside this connector. URI encoding is UTF-8. Encoded slash and backslash delimiters are accepted, and the relaxed query-character set includes double quote, angle brackets, square brackets, backslash, caret, backtick, braces, vertical bar. The maximum HTTP header size is 48 KiB. The connector does not impose a POST-body size limit. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/app/EmbeddedTomcat.java`; `TomcatHttpConnectorFactory.java`]

Thread-pool settings are `sonar.web.http.minThreads`, default 5; `sonar.web.http.maxThreads`, default 50; `sonar.web.http.acceptCount`, default 25; and `sonar.web.http.keepAliveTimeout`, default 60,000 milliseconds. Socket address reuse is enabled. Compression is enabled for responses of at least 1,024 bytes for HTML, XML, plain text, CSS, JSON, and JavaScript media types. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/app/TomcatHttpConnectorFactory.java`]

`sonar.web.context` is the common URL prefix. Empty or `/` mounts the application at root; a nonempty value must start with `/` or startup fails. When a nonroot context is used, requests outside it are handled by a root context that directs the client toward the configured context. `/deploy` is a separate static context rooted at the analyzer-deployment directory. The main context disables JSP and container WebSocket initialization, disables container naming and reload, uses HTTP-only behavior for container-managed session cookies, permits casual multipart parsing, and delegates class loading to the application. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/app/TomcatContexts.java`]

Tomcat startup failure is fatal. Error reports suppress server-identifying information and stack/report detail. Shutdown stops and destroys the container and removes its temporary base directory; an internal latch allows the process to await termination without relying on Tomcat's potentially unbounded await operation. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/app/EmbeddedTomcat.java`; `TomcatErrorHandling.java`]

## 4. HTTP startup-mode state machine

### 4.1 Platform states

The HTTP platform has observable states `BOOTING`, safe mode, asynchronous `STARTING`, and `UP`. Before a safe-mode API container is available, the v2 servlet has no dispatcher and returns 404. On initial platform start, the system determines whether the database needs migration, starts the safe-mode component container, registers `/api/v2/*`, initializes a safe-mode v2 dispatcher, and exposes the safe-mode legacy API registry. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/PlatformImpl.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/ApiV2Servlet.java`]

If migration is still required, the platform remains in safe mode. If no migration is required, or automatic migration finishes, an asynchronous starter creates the full level-three and level-four containers, initializes the full v2 dispatcher, runs startup tasks, and changes the current container to level four only after all required initialization has completed. It then destroys the safe-mode dispatcher/container. This ordering prevents requests from observing a partially initialized full container. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/PlatformImpl.java:95-137`; `ApiV2Servlet.java`]

While the full dispatcher is being installed, the safe-mode dispatcher remains authoritative. The v2 servlet waits for both servlet initialization and safe-dispatcher initialization before destroying that dispatcher; once removed, it sends new requests to the full dispatcher. Servlet destruction tears down either dispatcher still present. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/ApiV2Servlet.java`]

A repeated start request is ignored when already started outside safe mode. Restart after migration may re-enter the safe/full transition. Process stop/restart details belong to process runtime; this part guarantees only the HTTP dispatcher cutover and observable status mapping.

### 4.2 Safe-mode route set

The safe-mode legacy registry contains `api/system` status, database migration start/status, health, liveness, and safe monitoring metrics; `api/l10n/index`; and `api/webservices` discovery. It uses a safe-mode user session, legacy engine, and no-cache filter. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/platformlevel/PlatformLevelSafeMode.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/SafemodeSystemWsModule.java`]

The safe-mode v2 registry contains `/api/v2/system/health`, `/api/v2/system/liveness`, and `/api/v2/system/migrations-status`. It does not register ordinary product controllers. Spring Security delegation is a pass-through in safe mode because the full application context is not initialized; the system endpoints still perform their own passcode checks. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/config/SafeModeWebConfig.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/ConditionalSpringSecurityFilter.java`]

### 4.3 Full route set

The full level-four registry replaces the safe route registry with all platform and plugin `WebService` definitions, servlet-filter handlers, and full v2 controllers/configuration classes. The v2 dispatcher registers its built-in controllers plus every configuration class contributed through the platform container. Duplicate Spring bean names are not allowed, and fully qualified annotation bean names reduce accidental collisions. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/platformlevel/PlatformLevel4.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/ApiV2Servlet.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/config/PlatformLevel4WebConfig.java`]

## 5. Route spaces and dispatch

### 5.1 Top-level spaces

After applying `sonar.web.context`, the principal spaces are:

- `/api/*`: legacy Web API, except `/api/v2/*` and handlers explicitly implemented as servlet filters.
- `/api/v2/*`: v2 Spring MVC REST API.
- `/mcp` and `/mcp/*`: MCP proxy servlet, whose feature semantics are owned elsewhere.
- `/deploy/*`: analyzer/plugin deployment files from the data directory.
- Browser/static routes: static-resource and web-page handlers owned by the Web UI part.

The `/api/v2/*` servlet is registered at load priority 1. MCP is registered at priority 2; failure to register it is logged and leaves `/mcp` unhandled without preventing the rest of HTTP startup. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/PlatformImpl.java:141-184`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/WebServiceFilter.java`; `server/sonar-webserver/src/main/java/org/sonar/server/app/TomcatContexts.java`]

### 5.2 Legacy path resolution

Every legacy controller has a path such as `api/issues`; every action has a key such as `search`. The request path resolves as controller path plus final action segment. An optional final suffix is interpreted as a representation request. Supported suffixes are `.json`, `.protobuf`, and `.text`; an unknown suffix returns 400. A missing controller/action returns 404. A path ending without an action is invalid. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/WebServiceEngine.java`; `ServletRequest.java`]

The legacy filter includes all `/api/*` paths and every explicitly registered action path. It excludes `/api/v2/*`, moved routes handled by the rerouter, and actions whose handlers are servlet filters. `/api/components/update_key` and `/api/components/bulk_update_key` are internally rerouted to the corresponding `/api/projects` actions while retaining request parameters and response conventions; this is execution rerouting, not an HTTP redirect. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/WebServiceFilter.java`; `WebServiceReroutingFilter.java`]

Legacy actions accept only GET or POST. An action marked post rejects GET with 405 and a message that POST is required; a read action rejects POST similarly; all other methods return 405. The global servlet security filter nevertheless permits the broader set `DELETE`, `GET`, `HEAD`, `POST`, `PUT`, and `PATCH` so v2 REST controllers can use them. `OPTIONS`, `TRACE`, and every other verb are rejected globally with 405 before dispatch. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/RequestVerifier.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/SecurityServletFilter.java`]

### 5.3 V2 path resolution

The v2 `DispatcherServlet` sees paths relative to `/api/v2`. Controllers define REST mappings with Spring annotations and may use GET, POST, PUT, PATCH, or DELETE as declared. A trailing-slash filter applies to `/api/v2/**` and wraps the request so route matching is consistent without defining duplicate controller mappings. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/PlatformImpl.java:174-184`; v2 controller interfaces under `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/`]

V2 public endpoint constants include `/system`, `/users-management`, `/authorizations`, `/clean-code-policy`, `/dop-translation`, `/analysis`, `/history`, `/sca`, and `/marketplace/azure`; availability depends on which Community Build configuration classes are registered. Constants or interfaces from unregistered commercial extensions must not be treated as Community Build routes. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/WebApiEndpoints.java`; `config/PlatformLevel4WebConfig.java`; `manifest/component-inventory.md`]

## 6. API registration and discovery

### 6.1 Legacy registration

At engine start, every injected `WebService` defines controllers, actions, and parameters in a shared immutable-for-serving context. Actions carry public metadata: description, introduction/deprecation versions, internal marker, GET/POST classification, changelog, response example, content type, handler, and parameter definitions. The engine is not callable until registration completes. Action interceptors run in declared order before a handler and after it; post-interceptors still run when handler processing throws, provided a route was resolved. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/WebServiceEngine.java`]

`GET api/webservices/list` exposes this live registry. `include_internals` defaults false; when true, internal controllers, actions, and parameters are included with an explicit warning that their forward compatibility is not assured. Controllers and actions are sorted by path/key. Parameter metadata includes key, description, version, required/internal flags, default/example, deprecation/renamed-key information, allowed values, maximum count, length bounds, and maximum numeric value. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ws/ws/ListAction.java`]

`GET api/webservices/response_example` accepts controller and action. Unknown names return 400. An action without an example returns 204; otherwise the route returns the example's declared format and textual example. Examples are documentation, not generated live results. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ws/ws/ResponseExampleAction.java`]

### 6.2 V2 registration and OpenAPI

The full v2 configuration imports built-in controllers, common MVC behavior, security, history configuration, response converters, argument defaults, and interceptors. Container-contributed v2 configuration classes are registered only in full mode. A default-value argument resolver is placed before standard Spring resolvers, and request-body advice supplies declared defaults before controller invocation. Deprecated-route and metrics interceptors observe full-mode requests but do not redefine feature payloads. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/config/PlatformLevel4WebConfig.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/ApiV2Servlet.java`]

OpenAPI metadata identifies the service as “SonarQube Web API v2” and publishes the running SonarQube version. Springdoc's API-document path is `/api-docs` relative to the v2 servlet, yielding `/api/v2/api-docs` after the web context. Default documented response media type is JSON. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/config/ServerWebConfig.java`; `server/sonar-webserver-webapi-v2/src/main/resources/springdoc.properties`]

## 7. Request inputs, validation, defaults, and precedence

### 7.1 Legacy parameters

Legacy handlers read servlet parameters, so query parameters and form parameters follow the servlet container's combined parameter model. Multipart uploads are accepted only when the request content type begins with `multipart`; an absent or zero-length part is treated as absent. Failures while reading a part are logged and the part is treated as absent. Request headers are exposed case-insensitively through the servlet API. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/ServletRequest.java`]

A scalar parameter is read by its declared key. If a deprecated key is declared and supplied, it takes precedence over the replacement key; otherwise the current key is used. A default applies only after no raw value is found. Values are trimmed of Unicode whitespace at their ends. A raw NUL is rejected on the scalar access path, including comma-list access built on that path; generic repeated-parameter access does not apply this NUL check. Required validation checks whether the raw value was present, not whether a default happened to exist. [Provenance: `sonar-plugin-api-impl/src/main/java/org/sonar/api/impl/ws/ValidatingRequest.java`]

Comma-list parsing splits on commas, trims each item, and removes empty items. Repeated-parameter parsing preserves each servlet value; if the current key has no values, the deprecated key is considered, then a single default value. Definitions enforce allowed-value sets and maximum value counts. Scalar definitions may enforce minimum/maximum character length and maximum integer value. Typed accessors additionally validate integer, long, boolean, date, datetime, and enum parsing through their public request contract. A violation raises 400 with the validation message. [Provenance: `sonar-plugin-api-impl/src/main/java/org/sonar/api/impl/ws/ValidatingRequest.java`; endpoint parameter definitions]

Undeclared parameters may be present at the servlet layer but handlers cannot use the validating accessor for an undefined key. Endpoint-specific cross-field validation runs after generic parsing and takes precedence over feature execution; a failed cross-field check must not mutate state.

### 7.2 V2 inputs

V2 query, path, header, and body inputs use Spring MVC conversion. Jakarta Bean Validation is configured with a parameter-based message interpolator. Constraint violations, malformed bodies, enum/conversion failures, and controller-raised bad requests are normalized by the shared v2 exception handler. API request records may apply defaults through the leading defaults resolver/body advice before validation and controller execution. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/config/CommonWebConfig.java`; `PlatformLevel4WebConfig.java`; request records under `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/`]

V2 PATCH resources may declare `application/merge-patch+json`; the public constant is `JSON_MERGE_PATCH_CONTENT_TYPE`. Ordinary JSON bodies use `application/json`. Feature controllers own which fields are nullable, omitted, defaulted, replaceable, or immutable. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/WebApiEndpoints.java`; v2 controller interfaces]

## 8. Serialization and media types

### 8.1 Legacy representation selection

For legacy requests, a recognized URL suffix has highest priority. Without one, the raw `Accept` header is used; without either, the media type defaults to `application/octet-stream`. A handler using the common protobuf writer emits binary protobuf only when the selected media type equals `application/x-protobuf`; every other selection is serialized as JSON with `application/json`. Thus `.protobuf` is the deterministic binary selector and `.json` is the deterministic JSON selector. `.text` selects `text/plain` only for handlers that honor textual streaming. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/ServletRequest.java`; `WsUtils.java`; `sonar-ws/src/main/java/org/sonarqube/ws/MediaTypes.java`]

The public media-type vocabulary includes `application/json`, `application/x-protobuf`, `application/octet-stream`, `text/plain`, `text/csv`, `text/html`, `application/xml`, `image/svg+xml`, `application/zip`, and the static-resource types listed by `MediaTypes`. Feature handlers may set a more specific type, such as SVG badges, plain-text logs/source, OpenMetrics text, or binary archives. [Provenance: `sonar-ws/src/main/java/org/sonarqube/ws/MediaTypes.java`; endpoint handlers]

The protobuf-to-JSON adapter omits absent scalar/message fields, emits present empty strings distinctly, always emits ordinary repeated fields as arrays (including empty arrays), renders maps as JSON objects, renders enums by public string name, and inlines the special single-repeated-field wrapper used to distinguish an absent collection from a present empty collection. Binary protobuf field numbering and reserved fields remain compatibility contracts for `.protobuf`. [Provenance: `sonar-core/src/main/java/org/sonar/core/util/ProtobufJsonFormat.java`; schemas under `sonar-ws/src/main/protobuf/`]

Custom legacy JSON writers use UTF-8, suppress nulls according to the writer calls made by each handler, and may return shapes not backed by protobuf. `Response.noContent()` sets 204. A newly adapted legacy response starts at 200 and sets `Cache-Control: no-cache, no-store, must-revalidate`. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/ServletResponse.java`]

### 8.2 V2 serialization

V2 defaults content negotiation to `application/json`, with `*/*` as an accepted fallback. Spring/Jackson serializes public API records with their declared property names. Null inclusion is model/configuration dependent and is observable per response model; feature specifications must define fields whose presence is semantically important. Binary endpoints explicitly return `application/octet-stream`; empty successful deletions commonly return 204. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/config/CommonWebConfig.java`; controller tests under `server/sonar-webserver-webapi-v2/src/test/java`]

## 9. Common error contracts

### 9.1 Legacy errors

Legacy dispatch maps `IllegalArgumentException`, bad configuration, and bad request exceptions to 400. A `ServerException` supplies its own HTTP code, covering not found, forbidden, unauthorized, conflict, service unavailable, and other feature errors. Unhandled exceptions return 500 with the generic client message `An error has occurred. Please contact your administrator`; the exception detail is logged but never copied into the response. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/WebServiceEngine.java`]

The JSON error body may contain optional `scope` and an `errors` array; each array item has `msg`. A successfully resolved route that fails still runs post-action interceptors. If failure occurs after a streaming response is committed, status/body cannot be replaced and the failure is only logged. If the client aborts, the server avoids error-level logging; if no bytes were committed it uses status 299 for access-log visibility. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/WebServiceEngine.java`]

Before writing an uncommitted error, the servlet response is reset so stale content and headers from a partially prepared response are removed. The error type is `application/json`. Container-level error pages must not reveal server version, report text, or stack traces. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/WebServiceEngine.java`; `server/sonar-webserver/src/main/java/org/sonar/server/app/TomcatErrorHandling.java`]

### 9.2 V2 errors

V2 errors use a JSON object with a public `message` string. Shared handling maps invalid arguments and validation failures to 400, authentication required/failed to 401, insufficient privileges to 403, missing resources to 404, conflicts to 409 where declared, unsupported operations to their declared code, and unexpected failures to 500 without exposing sensitive internals. Validation messages identify the rejected field and constraint. [Provenance: v2 controller tests under `server/sonar-webserver-webapi-v2/src/test/java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/common/ServerRestResponseEntityExceptionHandler.java`; `config/CommonWebConfig.java`]

An authentication subsystem exception is logged using only its public message and returns 401 with the stable authentication-failed message. Controllers may use Spring `ResponseStatusException` to return a public 400 reason, as the history controllers do. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/common/ServerRestResponseEntityExceptionHandler.java`; history controller classes]

## 10. Pagination, sorting, and feature filters

Legacy paged actions conventionally use `p` as a one-based page index and `ps` as page size. Each action declares its own default and maximum. Protobuf-backed JSON exposes a `paging` object with `pageIndex`, `pageSize`, and `total`; older routes may retain deprecated top-level total/page fields. A client must not assume a universal maximum: examples in this release include 500 for component-tree and project-analysis pages and 1,000 for measure-history pages. [Provenance: `sonar-ws/src/main/protobuf/ws-commons.proto`; action calls to `addPagingParams`]

V2 searchable resources conventionally expose `pageIndex` and `pageSize`, with the endpoint interface/default resolver providing defaults, and return a page object with `pageIndex`, `pageSize`, and `total`. History collection routes also accept ordered `sort` values. Feature owners define supported fields, null ordering, tie breakers, and hard maximums. [Provenance: v2 search controllers and tests; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/config/PlatformLevel4WebConfig.java`]

Generic transport rules do not silently ignore a declared invalid enum, too many values, a too-short query, or a cross-field conflict; these return 400. Unknown extra query parameters may be ignored by Spring or the servlet container when no controller reads them, but clients must not rely on such parameters having any effect. Filtering by permissions occurs in the feature layer and must happen before sensitive result details are serialized. Search-index availability and partial-result policy are also feature contracts, not generic HTTP fallbacks.

## 11. Filter chain and request lifecycle

The embedded application has outer servlet filters for endpoint logging context, request ID context, security headers/method blocking, per-request settings/database/session lifecycle, and a master chain of registered `HttpFilter` extensions. The master selects filters whose include/exclude patterns match the context-relative request path and preserves registration order, except SCIM filters are deliberately placed before the generic legacy Web Service filter. A filter that handles a request may stop the chain; otherwise it forwards the same request/response. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/MasterServletFilter.java`; `EndpointPathFilter.java`; `RequestIdFilter.java`; `SecurityServletFilter.java`; `UserSessionFilter.java`]

Each request enables database-session caching, loads thread-local settings, initializes the identity-owned user session when the full initializer exists, invokes the remainder of the chain only if initialization allows it, then removes the user session, unloads settings, and disables caching in nested `finally` blocks. This cleanup is required after success, rejection, exception, and client abort to prevent identity or settings leakage across pooled connector threads. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/UserSessionFilter.java`]

A generated request ID is stored in request attribute `ID` and logging MDC for the duration of the request, then removed. This source does not define a response request-ID header, so clients must not require one. The endpoint path is likewise placed in logging MDC only for request duration. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/RequestIdFilter.java`; `EndpointPathFilter.java`]

API v2 requests pass through the existing identity session initializer before Spring Security. In full mode, a bridge creates an authenticated or anonymous Spring security context. The Spring chain is stateless and disables Spring form login, HTTP Basic, logout, CSRF, and server-side session creation; its default authorization rule is permit-all because controllers must declare `@RequireAuthentication`, Spring method security, or perform `UserSession` permission checks. Public v2 routes must also be allowed by the identity initializer's skipped-route policy. Identity semantics remain owned by `platform/identity-access/`. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/security/WebSecurityConfig.java`; `UserSessionAuthenticationFilter.java`]

## 12. Response headers, caching, and browser security

Every response passing the global security filter receives `X-XSS-Protection: 0` and `X-Content-Type-Options: nosniff`. It also receives `X-Frame-Options: SAMEORIGIN`, except paths below `/integration/`, which intentionally permit external embedding. If and only if request header `x-forwarded-proto` is exactly `https`, the response receives `Strict-Transport-Security: max-age=31536000; includeSubDomains;`. The reverse proxy is therefore responsible for setting the forwarding header truthfully. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/SecurityServletFilter.java`]

Legacy API responses set `Cache-Control: no-cache, no-store, must-revalidate` when their servlet response adapter is created. V2 routes receive the same value from `NoCacheFilter`. Feature routes may deliberately replace this, for example badge SVG responses use `Cache-Control: no-cache`, wildcard CORS, and ETag. Static deployment/resources may instead use action-specific max-age caching. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/ServletResponse.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/NoCacheFilter.java`; `CacheControlFilter.java`; analysis-results badge specification]

The browser page filter, not ordinary API JSON, adds a Content Security Policy composed from the configured web context and shipped asset bootstrap hash. It restricts default/script/object/base sources while allowing the explicit connection, image, font, style, frame, and worker sources needed by the Web UI. Browser-page CSP content belongs to the Web UI surface, but APIs must not overwrite these global security headers accidentally. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/CspFilter.java`]

No general permissive CORS header is added to API responses. Cross-origin access is opt-in at a feature endpoint, such as project badges. Cookies are disabled at the Tomcat context level for container sessions; identity-owned application cookies and headers are handled outside container session management.

## 13. System, health, and discovery surfaces

### 13.1 Legacy system routes

The full `api/system` controller registers:

| Route | Method | Transport contract |
|---|---|---|
| `api/system/status` | GET | Public state read; JSON or protobuf with optional server `id`, `version`, and `status`. |
| `api/system/db_migration_status` | GET | Database migration status read. |
| `api/system/health` | GET | JSON/protobuf health read; system administrator or `X-Sonar-Passcode`. In safe mode only the passcode is accepted. |
| `api/system/liveness` | GET, internal | 204 when alive, 503 when not; system administrator or passcode, safe mode passcode only. |
| `api/system/info` | GET | Detailed system information; system administration required. |
| `api/system/logs` | GET | Plain-text selected system log; system administration required. |
| `api/system/ping` | GET | Plain-text `pong`. |
| `api/system/upgrades` | GET | Upgrade compatibility read model. |
| `api/system/migrate_db` | POST | Starts database migration according to persistence/process rules. |
| `api/system/restart` | POST | Requests the process-runtime restart sequence; system administration required. |
| `api/system/change_log_level` | POST | Temporarily changes log level until restart; system administration required. |

Safe mode registers only the status/migration/health/liveness subset plus monitoring metrics. Feature semantics of migration, restart, logs, upgrades, and health aggregation remain with their owners. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/SystemWsModule.java`; `SafemodeSystemWsModule.java`; individual action definitions]

`api/system/status` returns one of `STARTING`, `UP`, `DOWN`, `RESTARTING`, `DB_MIGRATION_NEEDED`, or `DB_MIGRATION_RUNNING`. Full `UP` plus a restart flag maps to `RESTARTING`. Safe mode with no migration run maps to `DB_MIGRATION_NEEDED`; a running migration maps to `DB_MIGRATION_RUNNING`; failed migration maps to `DOWN`; successful migration before full initialization maps to `STARTING`. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/StatusAction.java`; `sonar-ws/src/main/protobuf/ws-system.proto`]

Legacy health returns global `GREEN`, `YELLOW`, or `RED`, causes, and optional node details containing name, application/search type, host, port, start time, health, and causes. This part specifies the health transport shape, not the rules that choose a global health color. The liveness predicate is shared by v1 and v2: in full Community mode, database-connection, Web Server, and Compute Engine checks must each be `GREEN`, while Elasticsearch may be `GREEN` or `YELLOW` but not `RED`; in safe mode, only a `GREEN` database-connection check is required. [Provenance: `sonar-ws/src/main/protobuf/ws-system.proto`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/HealthActionSupport.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/platform/LivenessCheckerImpl.java`; `SafeModeLivenessCheckerImpl.java`]

`X-Sonar-Passcode` is enabled only when nonblank `sonar.web.systemPasscode` is configured. Comparison is constant-time. Missing configuration, missing header, or mismatch is invalid. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/user/SystemPasscodeImpl.java`]

`GET api/server/version` returns the SonarQube version as plain text. `GET api/webservices/list` and `response_example` expose legacy discovery as specified above. `GET api/l10n/index` remains available in safe mode for localization bootstrap. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/ServerWs.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ws/ws/`; `PlatformLevelSafeMode.java`]

### 13.2 V2 system routes

`GET /api/v2/system/health` accepts optional `X-Sonar-Passcode`; a system administrator may use the ordinary authenticated session in full mode. Invalid authorization returns 403. Standalone mode returns the node health JSON model; cluster mode returns 501 in this release. In safe mode no user session is supplied, so the passcode is required. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/system/controller/HealthController.java`; `config/SafeModeWebConfig.java`]

`GET /api/v2/system/liveness` accepts the same optional passcode and permits a system administrator in full mode. A successful shared liveness check returns 204 with no body. Invalid authorization returns 403. In safe mode the passcode is mandatory. A failed v2 liveness check raises an internal failure in the pinned controller; clients must treat any non-204 as not alive. [Provenance: `server/sonar-webserver-common/src/main/java/org/sonar/server/common/platform/LivenessCheckerImpl.java`; `SafeModeLivenessCheckerImpl.java`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/system/controller/LivenessController.java`; `DefaultLivenessController.java`; `config/SafeModeWebConfig.java`]

`GET /api/v2/system/migrations-status` returns JSON fields `status`, and nullable `completedSteps`, `totalSteps`, `startedAt`, `message`, and `expectedFinishTimestamp`. Dates are UTC ISO date-time strings. Up-to-date or downgrade-required databases report the current migration-state object; unsupported migration dialects report not-supported; an out-of-date database with no active state reports migration-required; running, failed, and succeeded states preserve progress/error information. No database connection fails the request. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/system/controller/DatabaseMigrationsController.java`]

## 14. Persistence, concurrency, and recovery

Route registries are built once per safe/full container generation and are read concurrently after publication. Full-container publication happens only after startup tasks. The legacy engine's context is required before any call; the v2 servlet chooses a dispatcher using current volatile references and never intentionally serves both for one request. Per-request identity/settings/database caches are thread-local and cleaned deterministically. [Provenance: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/WebServiceEngine.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/PlatformImpl.java`; `ApiV2Servlet.java`; `UserSessionFilter.java`]

HTTP handlers own transaction boundaries. The transport layer must not retry non-idempotent feature mutations. Client disconnects during a committed mutation do not roll the feature transaction back merely because the response could not be delivered. Streaming errors after commitment cannot change status or body. Safe-to-full dispatcher cutover does not preserve in-memory handler state from safe mode; durable migration state is held below that container level. [Provenance: `WebServiceEngine.java`; `PlatformLevel2.java`; feature persistence contracts]

A startup failure logs the public startup error, attempts platform stop, and aborts Tomcat initialization for unexpected failures. If v2 or MCP servlet registration fails because the context is already initialized or a name is occupied, the specified surface remains unavailable; MCP failure is nonfatal and logged, while v2 initialization failure prevents the promised API cutover. [Provenance: `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/PlatformServletContextListener.java`; `PlatformImpl.java`; `ApiV2Servlet.java`]

## 15. Security and trust boundaries

The connector trusts the reverse proxy only for explicitly consumed forwarding data. Incorrect `x-forwarded-proto` can suppress or add HSTS; deployments must strip untrusted client values. The 48 KiB header allowance exists for negotiated authentication tokens and increases the importance of proxy/header-size controls. Unlimited connector POST size does not remove endpoint-level upload limits or scanner-gateway validation. [Provenance: `TomcatHttpConnectorFactory.java`; `SecurityServletFilter.java`]

The global method allow-list, no-sniff header, frame restriction, generic 500 messages, hidden Tomcat reports, NUL rejection, validation bounds, stateless v2 Spring chain, and per-request thread-local cleanup are mandatory security behavior. Feature handlers must authorize before serializing sensitive records and must not rely on the v2 chain's permit-all default as authorization. Public route exemptions must be registered with the identity initializer as well as mapped by Spring. [Provenance: security/filter/request/error classes cited above; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/security/WebSecurityConfig.java`]

Internal-route metadata is not an authentication boundary. An internal action that is HTTP reachable must still perform its documented authorization. Likewise, `include_internals=true` discloses route metadata but grants no permission to invoke an action. The system passcode is a shared secret and must be accepted only through its defined header or bearer contract on routes that explicitly support it.

## 16. Compatibility and limits

Legacy controller/action paths, parameter keys, deprecated-key precedence, GET/POST classification, suffix media types, protobuf schemas, JSON field omission rules, error envelope, paging names, status codes, and common headers are compatibility requirements. Internal legacy routes are present for same-version clients but have no forward-compatibility guarantee. V2 paths, JSON property names, HTTP methods, declared validation/defaults, response codes, merge-patch media type, and OpenAPI document are the stable v2 surface of this release.

The server must preserve the configured web-context prefix on generated routes and static/error redirects. It must not expose a route merely because an endpoint constant or commercial interface is present in a dependency; actual safe/full configuration registration is authoritative. Encoded slash support, relaxed query characters, UTF-8 URI handling, 48 KiB header maximum, connector defaults, and compression threshold are observable deployment compatibility points.

## 17. Acceptance scenarios

1. **Cold start requiring migration.** Given an out-of-date database, when Tomcat starts, the safe legacy and v2 system routes become available, ordinary feature APIs remain absent, `/api/system/status` reports `DB_MIGRATION_NEEDED`, and safe health/liveness accepts only a valid `X-Sonar-Passcode`.

2. **Safe-to-full cutover.** Given migration success, when asynchronous full initialization runs, requests continue using the safe dispatcher until the full dispatcher and startup tasks are complete. After cutover, ordinary v1/v2 routes are available, status advances through `STARTING` to `UP`, and no request observes a partially registered full route set.

3. **Legacy method enforcement.** Given a legacy read action, POST returns 405 stating GET is required. Given a legacy mutation action, GET returns 405 stating POST is required. Given TRACE or OPTIONS anywhere, the outer filter returns 405 before feature execution.

4. **V2 REST verbs.** Given a registered v2 PATCH or DELETE route, the global filter allows the verb and Spring dispatches it. The same verb sent to a legacy route still returns the legacy 405 contract.

5. **Representation precedence.** Given a protobuf-backed route and URL suffix `.protobuf`, the server returns `application/x-protobuf` regardless of a different `Accept` header. Given `.json`, it returns JSON. Given no suffix and an exact protobuf Accept value, it returns binary; otherwise the common writer returns JSON. An unknown suffix returns 400.

6. **Legacy validation.** Given a required parameter omitted, a scalar or comma-list parameter containing NUL, an unsupported enum, too many comma-list values, a length violation, or an integer above its declared maximum, the action returns 400 with `errors[].msg` and performs no feature mutation. A generic repeated parameter is not promised this NUL rejection. Given both a deprecated key and replacement key, the deprecated key wins.

7. **V2 validation.** Given a malformed or constraint-violating JSON body, the route returns 400 with a JSON `message` identifying the rejected field/constraint. Given a route marked authenticated without credentials, it returns 401; insufficient feature permission returns 403.

8. **Secure unexpected failure.** Given an unhandled legacy exception before response commitment, the client receives 500, JSON media type, and only the generic administrator-contact message; the implementation detail appears only in server logs. Tomcat's fallback page likewise omits server information and report detail.

9. **Streaming failure.** Given a handler that has already committed bytes and then fails, the transport does not attempt to replace them with a contradictory JSON error or status. It logs the failure. A client abort is logged at debug level and may use 299 only when the response was not committed.

10. **Thread reuse.** Given two requests served sequentially by the same connector thread under different users/settings, the second request cannot observe the first request's user session, settings, database cache, request ID, or endpoint MDC.

11. **Security headers.** Given an ordinary API request, the response contains `X-Frame-Options: SAMEORIGIN`, `X-XSS-Protection: 0`, and `X-Content-Type-Options: nosniff`. Given `/integration/...`, the frame header is omitted. HSTS appears only when trusted forwarding data says `https` exactly.

12. **Cache contract.** Given a normal v1 or v2 API response, it carries `Cache-Control: no-cache, no-store, must-revalidate`. Given an endpoint with an explicit caching contract, such as a badge, the feature-specific headers replace the generic behavior as documented.

13. **System liveness.** Given valid passcode or a full-mode system administrator, v1 and v2 liveness return 204 only when database, Web Server, and Compute Engine checks are `GREEN` and Elasticsearch is not `RED`; Elasticsearch `YELLOW` remains alive. In safe mode, 204 requires only a `GREEN` database-connection check and valid passcode. Given an invalid secret, the routes return 403. Given a failed check, v1 returns 503 and v2 returns a non-204 failure; an orchestrator reschedules on any non-204.

14. **API discovery.** Given `api/webservices/list` without `include_internals`, internal actions and parameters are absent. With it, they are present and labeled internal. The result is sorted and includes declared defaults, limits, allowed values, deprecations, and changelog. This disclosure does not bypass invocation permissions.

15. **V2 OpenAPI.** Given full mode, `/api/v2/api-docs` returns the registered Community Build v2 contract and running version. Safe mode does not claim unregistered full feature endpoints.

16. **Context path.** Given `sonar.web.context=/sonar`, API v1, API v2, MCP, UI, and deploy routes are rooted beneath `/sonar`; a request outside that context is handled by the root redirect context. A context value without a leading slash fails startup.

17. **Connector bounds.** Given a negative HTTP port, startup fails. Given headers beyond 48 KiB, the connector rejects them. Given a compressible JSON response at least 1,024 bytes, connector compression is eligible; a smaller response is not compressed by this rule.

## 18. Provenance index

- Release, ownership, license: `manifest/release-baseline.md`; `manifest/component-inventory.md`; `manifest/dependency-map.md`; `manifest/license-map.md`; pinned source `LICENSE.txt`.
- Embedded connector and contexts: `server/sonar-webserver/src/main/java/org/sonar/server/app/EmbeddedTomcat.java`; `TomcatHttpConnectorFactory.java`; `TomcatContexts.java`; `TomcatErrorHandling.java`.
- Startup modes and dispatcher cutover: `server/sonar-webserver/src/main/java/org/sonar/server/platform/PlatformImpl.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/ApiV2Servlet.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/platformlevel/PlatformLevelSafeMode.java`; `PlatformLevel4.java`.
- Legacy route engine, request, response, errors: `server/sonar-webserver-ws/src/main/java/org/sonar/server/ws/WebServiceEngine.java`; `ServletRequest.java`; `ServletResponse.java`; `RequestVerifier.java`; `WsUtils.java`.
- Legacy validation: `sonar-plugin-api-impl/src/main/java/org/sonar/api/impl/ws/ValidatingRequest.java`.
- Legacy registration/discovery: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/ws/ws/ListAction.java`; `ResponseExampleAction.java`; controller/action definitions throughout `server/sonar-webserver-webapi`.
- Legacy JSON/protobuf/media: `sonar-core/src/main/java/org/sonar/core/util/ProtobufJsonFormat.java`; `sonar-ws/src/main/java/org/sonarqube/ws/MediaTypes.java`; `sonar-ws/src/main/protobuf/`.
- V2 registration, validation, OpenAPI, security, and errors: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/config/`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/security/`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/common/`; `server/sonar-webserver-webapi-v2/src/main/resources/springdoc.properties`.
- Servlet filters and headers: `server/sonar-webserver/src/main/java/org/sonar/server/platform/web/MasterServletFilter.java`; `SecurityServletFilter.java`; `UserSessionFilter.java`; `RequestIdFilter.java`; `EndpointPathFilter.java`; `NoCacheFilter.java`; `CspFilter.java`; `WebServiceFilter.java`; `WebServiceReroutingFilter.java`.
- System surfaces: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/platform/ws/`; `sonar-ws/src/main/protobuf/ws-system.proto`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/system/controller/`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/user/SystemPasscodeImpl.java`.
