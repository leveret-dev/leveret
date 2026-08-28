# Events and Notifications Specification

## 1. Identity and provenance

This specification describes the events-and-notifications part bundled with SonarQube Community Build `26.8.0.126808`, published 2026-08-05 from Git tag `26.8.0.126808` and commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. The authoritative platform source is `SonarSource/sonarqube` at that commit. The cross-process event API and server implementation are the pinned Maven artifacts `org.sonarsource.sonarqube:sonar-events-api:1.16.0.5078` and `org.sonarsource.sonarqube:sonar-events-server:1.16.0.5078`. [Provenance: `manifest/release-baseline.md`; `gradle.properties`; `build.gradle`; `server/sonar-events/build.gradle`; https://repo1.maven.org/maven2/org/sonarsource/sonarqube/sonar-events-server/1.16.0.5078/sonar-events-server-1.16.0.5078.pom]

The SonarQube production source and both event artifacts are licensed under `LGPL-3.0-or-later`; they do not qualify for a GPL/AGPL copy marker. This is a behavioral clean-room specification, not legal advice. [Provenance: `LICENSE.txt`; `manifest/license-map.md`; artifact POM above]

## 2. Purpose, scope, and exclusions

This part owns four delivery contracts:

1. in-process and Web-to-Compute-Engine event dispatch;
2. selection and asynchronous email delivery of human notifications;
3. project-analysis webhooks and their durable delivery records; and
4. authenticated server-sent events delivered to connected SonarLint/IDE clients.

It owns the envelopes, selection rules, transport behavior, delivery state, polling, and purging associated with those contracts. It consumes, but does not redefine, project and issue state, quality-gate calculation, Compute Engine queue semantics, authentication, authorization, relational transactions, HTTP error conventions, or project visibility. Those are owned by `platform/analysis-results/`, `platform/compute-engine/`, `platform/identity-access/`, `platform/persistence/`, and `platform/http-api/`. [Provenance: `manifest/dependency-map.md`; `server/sonar-events`; `server/sonar-server-common/src/main/java/org/sonar/server/notification`; `server/sonar-server-common/src/main/java/org/sonar/server/webhook`; `server/sonar-webserver-pushapi`]

User-visible delivery is distinct from observability. Emails, webhook calls, and IDE stream events can change what a person or external consumer sees. Logs, webhook history, queue counts, connected-client counts, and Prometheus metrics only describe delivery or runtime condition; they are not proof that a recipient read or acted on a message. Telemetry upload and operational monitoring belong to `platform/telemetry-monitoring/` and must not be treated as notification channels.

Commercial-only notification or webhook extensions are excluded. Cluster-wide scheduling statements below are limited to coordination mechanisms visible in Community Build source; this specification does not infer an entitlement to commercial cluster deployment.

## 3. Dependencies and owned contracts

The implementation depends on the relational persistence contract for notification queue rows, notification subscription properties, webhook configuration and delivery rows, and push-event rows. It depends on the Compute Engine queue for Web-to-CE event forwarding. It depends on identity and access for subscriber permission rechecks, webhook administration, and IDE connection authorization. SMTP servers, webhook receivers, HTTP client internals, mail libraries, IDE implementations, and the Compute Engine queue implementation are external dependencies rather than reimplemented parts. [Provenance: `server/sonar-db-dao/src/main/java/org/sonar/db/notification`; `server/sonar-db-dao/src/main/java/org/sonar/db/webhook`; `server/sonar-db-dao/src/main/java/org/sonar/db/pushevent`; `server/sonar-events/src/main/java/org/sonar/server/events/CeQueueEventForwarder.java`]

This part owns these stable public identifiers:

- event metadata fields `eventId`, `source`, `eventType`, `eventTimestamp`, and `eventVersion`;
- event-source fields `domain`, `service`, `envName`, `envType`, and `region`;
- CE event characteristics `eventPayloadJson` and `eventMetadataJson`;
- notification subscription keys of the form `notification.<type>.<channel>`;
- the `api/notifications`, `api/webhooks`, `api/emails`, and `api/push` routes described below;
- webhook headers `X-SonarQube-Project` and `X-Sonar-Webhook-HMAC-SHA256`; and
- IDE event names `RuleSetChanged`, `IssueChanged`, and `SecurityHotspotChanged`.

[Provenance: pinned `sonar-events-api` source artifact; `server/sonar-events/src/main/java/org/sonar/server/events/CeQueueEventForwarder.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/notification/ws/NotificationUpdater.java`; `server/sonar-server-common/src/main/java/org/sonar/server/webhook/WebhookCallerImpl.java`; `server/sonar-webserver-pushapi/src/main/java/org/sonar/server/pushapi`]

## 4. Unified event dispatch

### 4.1 Envelope and publication

An event consists of typed business payload data and metadata. Metadata carries a caller-supplied event type and schema version, a source, a unique event ID, and an epoch-millisecond timestamp. The convenience construction path generates a random UUID string for `eventId` and the current instant for `eventTimestamp`. A server event source contains the supplied business `domain` and `service`; `envName`, `envType`, and `region` are null because those cloud-location fields do not apply to the server product. [Provenance: pinned `sonar-events-api:1.16.0.5078` source files `Event.java`, `EventMetadata.java`, and `EventSource.java`; pinned `sonar-events-server:1.16.0.5078` source file `ServerEventSourceBuilder.java`]

The asynchronous client exposes single-event and collection publication, each in “internal” and “cross-domain” forms. In this server release, both forms use the same dispatcher. Publication runs dispatch synchronously before returning an already-completed future. Collection publication preserves input iteration, attempts every event, and, if an uncaught runtime failure escapes dispatch, returns a failed future carrying the first failure and subsequent failures as suppressed failures. [Provenance: pinned `sonar-events-server:1.16.0.5078` source file `ServerEventAsyncClient.java`]

### 4.2 Local routing and failure isolation

Each task handler declares one handled event name, payload class, task, and target process. The default target is the Web/server process, and the default event-name match is exact equality. A handler may broaden same-process matching, but broadened matching does not qualify an event for Web-to-CE forwarding. Local dispatch invokes every matching handler whose declared process equals the current process. A failure while asking one handler whether it matches, or while running that handler, is logged and does not prevent other handlers from running. [Provenance: pinned `sonar-events-api:1.16.0.5078` source file `TaskHandler.java`; pinned `sonar-events-server:1.16.0.5078` source file `EventDispatcher.java`]

The pinned Community Build source registers no product task-handler implementation beyond test fixtures. The concrete built-in publisher is the Web-start event `Analytics.Server.Started`, version `1.0`, with source domain `Server`, source service `ServerStartupEventPublisher`, and payload fields `serverId` and `version`. It publishes once when the Web platform level starts. A runtime publication failure is logged at debug level and must not prevent server startup. [Provenance: production-handler search in pinned source; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/telemetry/ServerStartupEventPublisher.java`; `server/sonar-webserver/src/main/java/org/sonar/server/platform/platformlevel/PlatformLevel4.java`]

### 4.3 Web-to-Compute-Engine forwarding

While dispatching in the Web process, the dispatcher forwards an event at most once when at least one handler declares the Compute Engine process and its handled event name exactly equals `eventType`. The dispatcher still attempts local matching first. A missing forwarder is a warning; a forwarder failure is logged and isolated from other listeners. No same-process or cross-domain distinction changes this behavior. [Provenance: pinned `sonar-events-server:1.16.0.5078` source file `EventDispatcher.java`]

The forwarder serializes payload and metadata separately as JSON, submits one CE task whose task type is the event type, and stores the two JSON values in CE task characteristics `eventPayloadJson` and `eventMetadataJson`. Serialization uses a plain JSON object mapper. Serialization failure raises event-processing failure to the dispatcher; the dispatcher logs it rather than inventing a retry. The CE queue owns durable task state and any queue-level recovery behavior. [Provenance: `server/sonar-events/src/main/java/org/sonar/server/events/CeQueueEventForwarder.java`; `server/sonar-events/src/main/java/org/sonar/server/events/EventsObjectMapper.java`; `manifest/dependency-map.md`]

On the CE side, the processor builds a task-type-to-payload-class map from CE-targeted handlers. Multiple handlers may share a type only when they declare the same payload class; conflicting classes fail component construction. For a received task it requires both characteristics and a registered payload class, reconstructs metadata and payload, and dispatches locally without forwarding again. Missing characteristics or type mapping, or invalid JSON, fails that CE task. A successfully dispatched event has no separate CE task result body. [Provenance: `server/sonar-events/src/main/java/org/sonar/server/events/CeEventTaskProcessor.java`]

## 5. Notification subscriptions and recipient selection

### 5.1 Subscription type catalog

The shipped user-selectable dispatcher keys are:

| Type key | Global subscription | Per-project subscription | Selection semantics |
|---|---:|---:|---|
| `NewIssues` | No | Yes | Every currently authorized email subscriber to the project receives each new-issues notification for that project. |
| `SQ-MyNewIssues` | Yes | Yes | Only the assigned user is eligible; the user must remain subscribed and authorized for the project. |
| `ChangesOnMyIssue` | Yes | Yes | Eligible assignees receive peer-made changes to their issues; authors are not notified of their own changes. |
| `NewFalsePositiveIssue` | No | Yes | Subscribers receive issue transitions into `FALSE_POSITIVE` or `ACCEPTED`; the change author is excluded. |
| `NewAlerts` | Yes | Yes | Authorized subscribers receive quality-gate status change notifications for the project. |
| `CeReportTaskFailure` | Yes | Yes | Project subscriptions require Browse; global subscriptions require project administration, and notifications describe failed report-analysis tasks. |
| `QualityGateConditionsMismatch` | Yes | No | Enabled by default for users with the global quality-gate administration permission; an explicit false property opts a user out. |

All ordinary project selections require the recipient to have a usable email address and the required current permission. With the exception stated for `CeReportTaskFailure`, global and project subscriptions listed above require Browse on the affected project at delivery selection time. Duplicate recipient/channel pairs collapse before legacy channel delivery. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/issue/notification/*NotificationHandler.java`; `server/sonar-server-common/src/main/java/org/sonar/server/qualitygate/notification/QGChangeNotificationHandler.java`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/notification/ReportAnalysisFailureNotificationHandler.java`; `server/sonar-server-common/src/main/java/org/sonar/server/notification/DefaultNotificationManager.java`]

System-generated email categories without a subscription key are not exposed in the subscription API. They include warnings about unchanged default administrator credentials to global administrators, built-in quality-profile changes to quality-profile administrators, coexistence of MQR and Standard modes to global administrators, and user-token expiry notices to the token owner. Token notices select tokens expiring in seven days and tokens expiring on the current day. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/authentication/DefaultAdminCredentialsVerifierNotificationHandler.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/qualityprofile/builtin/BuiltInQPChangeNotificationHandler.java`; `server/sonar-server-common/src/main/java/org/sonar/server/issue/notification/MQRAndStandardModesExistNotificationHandler.java`; `server/sonar-webserver-auth/src/main/java/org/sonar/server/usertoken/notification/TokenExpirationNotificationSender.java`]

### 5.2 Subscription API and persistence

`POST api/notifications/add` and `POST api/notifications/remove` accept `type`, `channel`, optional `project`, and optional `login`. `channel` defaults to `EmailNotificationChannel`; `type` is mandatory and must belong to the global or per-project catalog appropriate to the presence of `project`. Without `login`, the caller modifies the authenticated caller’s subscription. With `login`, a system administrator modifies that user. A project-scoped modification also requires Browse on the project. Successful modification returns no content. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/notification/ws/NotificationsWsParameters.java`; `AddAction.java`; `RemoveAction.java`]

A subscription is a user property named `notification.<type>.<channel>`, optionally scoped to the project UUID. Value `true` means enabled. Adding an already-enabled subscription is rejected. Removing a normal subscription deletes it and rejects removal when it was not enabled. Removing an enabled-by-default type persists value `false` instead, because absence means enabled for an eligible user. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/notification/ws/NotificationUpdater.java`]

`GET api/notifications/list` accepts optional `login` with the same self-versus-system-administrator rule. It returns sorted channel names, permitted global and per-project type lists, and active subscriptions with `type`, `channel`, and, where applicable, `project` and `projectName`. Deleted projects, unknown channels/types, inaccessible projects, and permission-restricted types the user cannot administer are omitted. Enabled-by-default entries are synthesized unless an explicit false property disables them. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/notification/ws/ListAction.java`; `DispatchersImpl.java`]

## 6. Notification queue and email delivery state

Scheduling a notification serializes it into a durable notification-queue row. The delivery daemon starts one minimum-priority worker and polls immediately, then with fixed delay controlled by `sonar.notifications.delay`, whose observed default is 60 seconds. Long-running backlog progress is logged after `sonar.notifications.runningDelayBeforeReportingStatus`, whose observed default is 600 seconds. Shutdown stops fetching new work, waits up to five seconds for the worker, and interrupts only the waiting thread if that wait is interrupted. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/notification/DefaultNotificationManager.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/notification/NotificationDaemon.java`]

The queue’s externally significant transition is `queued` to `removed-for-attempt`. Each poll selects the single oldest row and deletes it before deserialization, recipient selection, template rendering, or transport. Consequently, this layer has no durable `sent`, `failed`, or retry state for email. A transport failure, missing recipient email, absent template, disabled SMTP configuration, or downstream handler failure does not put the row back. An incompatible serialized class left by an upgrade is discarded; the incompatibility warning is emitted once per process. Other deserialization failures stop that polling invocation, are logged by the daemon, and allow a later scheduled invocation to continue with remaining rows. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/notification/DefaultNotificationManager.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/notification/NotificationDaemon.java`]

For each dequeued object, exact-class email handlers run first and legacy dispatchers/channels run second. A handler failure propagates to the daemon and therefore prevents the legacy path for that object. Within the legacy path, each dispatcher failure is isolated, and each recipient/channel failure is isolated, so other dispatchers and destinations remain eligible. The reported “sent” count counts channel calls that return success; it is operational logging, not a read receipt. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/notification/NotificationService.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/notification/NotificationDaemon.java`]

Token-expiration email is a separate direct path rather than a notification-queue row. It runs at the next UTC midnight and every 24 hours thereafter, guarded by the `token-notif` global lock with an observed 23-hour lease. Scheduler failures are logged. No direct-email retry loop is present. [Provenance: `server/sonar-webserver-auth/src/main/java/org/sonar/server/usertoken/notification/TokenExpirationNotificationSchedulerImpl.java`; `TokenExpirationNotificationSender.java`]

## 7. SMTP and email configuration

### 7.1 Configuration surface

Community Build supports one database-backed email configuration with fixed ID `email-configuration`. The internal configuration keys and observed fallback values are:

| Key | Observed fallback |
|---|---|
| `email.smtp_host.secured` | empty; an empty host disables the email channel |
| `email.smtp_port.secured` | `25` |
| `email.smtp_secure_connection.secured` | empty for raw fallback; configurations created through the API store `NONE`, `SSLTLS`, or `STARTTLS` |
| `email.from` | `noreply@nowhere` |
| `email.fromName` | `SonarQube` |
| `email.prefix` | `[SONARQUBE]` |
| `email.smtp.auth.method` | `BASIC`; supported values are `BASIC` and `OAUTH` |
| `email.smtp_username.secured` | empty |
| `email.smtp_password.secured` | empty |
| `email.smtp.oauth.host` | `https://login.microsoftonline.com` |
| `email.smtp.oauth.scope` | `https://outlook.office365.com/.default` |
| `email.smtp.oauth.grant` | `client_credentials` |
| `email.smtp.oauth.clientId`, `email.smtp.oauth.clientSecret`, `email.smtp.oauth.tenant` | empty |

Encrypted stored values are decrypted using the configured secret-key facility. A decryption failure is fatal to that configuration read. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/email/EmailSmtpConfiguration.java`]

System administrators manage this single resource through `POST`, `GET`, `PATCH`, and `DELETE /api/v2/system/email-configurations`, with `/{id}` for single-resource operations. Search returns zero or one resource. Responses expose booleans indicating whether basic password, OAuth client ID, and OAuth client secret are configured rather than returning those secrets. A second create is rejected. Basic creation requires a password; OAuth creation requires authentication host, client ID, client secret, and tenant. Updating an SMTP or OAuth URL requires resubmitting the relevant secret. Merge-patch leaves omitted fields unchanged. Deleting the resource removes all owned internal properties. [Provenance: `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/email/config/controller/EmailConfigurationController.java`; `DefaultEmailConfigurationController.java`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/email/config/EmailConfigurationService.java`]

`POST api/emails/send` is an internal system-administrator test action with mandatory `to` and `message` and optional `subject`. Success returns no content. SMTP failure becomes a bad-request response advising that host, port, login, and password be checked. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/email/ws/SendAction.java`]

### 7.2 Transport and content

The email channel is active only when the SMTP host is nonblank. It chooses the first registered template that accepts the notification; absence of a template logs a warning and produces no send. It supports plain-text and HTML messages, prefixes the subject, uses configured sender identity, and adds list/threading headers when a valid public server host is available. Recipient addresses containing carriage return or line feed are rejected to prevent SMTP header injection. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/notification/email/EmailNotificationChannel.java`]

SMTP connection and socket timeouts are each 30 seconds. `SSLTLS` enables TLS on connect with server-identity checking; `STARTTLS` requires upgrade and identity checking; `NONE` uses the configured port without transport security. Basic credentials are used when either username or password is nonblank. OAuth obtains a Microsoft-compatible client-credentials access token and restricts mail authentication to XOAUTH2. Unknown secure-connection values fail the send. Mail-library delivery exceptions are logged and reported as unsuccessful, with no queue retry. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/notification/email/EmailNotificationChannel.java`; `server/sonar-server-common/src/main/java/org/sonar/server/email/EmailSender.java`]

## 8. Webhooks

### 8.1 Configuration and administration

`api/webhooks` provides `create`, `update`, `delete`, `list`, `deliveries`, and `delivery`. A webhook has an opaque key, name, URL, optional secret, and optional owning project; absence of a project makes it global. The observed limits are 10 global hooks and 10 hooks per project, name length 100, URL length 512, project-key length 400, webhook-key length 40, and secret length 16 through 200 when nonblank. List reports `hasSecret`, not the secret. System administration is required for global hooks; project administration is required for project hooks and their delivery records. [Provenance: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/webhook/ws/CreateAction.java`; `UpdateAction.java`; `DeleteAction.java`; `ListAction.java`; `WebhooksWsParameters.java`; `WebhookSupport.java`]

URL parsing is required at configuration and again at delivery. `sonar.validateWebhooks` defaults to `true`. When it resolves true, loopback, wildcard, and addresses assigned to a local interface are rejected both when configured and through delivery-time DNS resolution, limiting DNS-rebinding and SSRF exposure. An unresolvable public hostname may be stored and will fail at delivery. [Provenance: exact `org.sonarsource.sonarqube:sonar-plugin-api:13.8.0.4399` source artifact, `org/sonar/api/CoreProperties.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/webhook/ws/WebhookSupport.java`; `server/sonar-server-common/src/main/java/org/sonar/server/webhook/WebhookCustomDns.java`; `sonar-core/src/main/java/org/sonar/core/config/SecurityProperties.java`]

### 8.2 Trigger, payload, and HTTP request

At the end of every project-analysis post-task, all project hooks followed by all global hooks are selected. Hooks are also triggered after issue changes when those changes alter the quality-gate status. Payload generation is lazy and skipped when no hook exists. Each hook call is submitted independently to the shared asynchronous execution queue, followed by a purge job. [Provenance: `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/webhook/WebhookPostTask.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/webhook/WebhookQGChangeEventListener.java`; `server/sonar-server-common/src/main/java/org/sonar/server/webhook/WebHooksImpl.java`]

The JSON payload exposes `serverUrl`, optional `taskId`, `status`, optional `analysedAt` and `revision`, `changedAt`, `project` with `key`, `name`, and dashboard `url`, optional `branch` with `name`, `type`, `isMain`, and branch URL, optional `qualityGate` with `name`, `status`, and condition objects containing `metric`, `operator`, optional `value`, `status`, and `errorThreshold`, and `properties`. Only analysis properties whose keys begin with the public analysis-property prefix are copied. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/webhook/WebhookPayloadFactoryImpl.java`]

Delivery is one HTTP POST with JSON media type and `X-SonarQube-Project`. URL-embedded credentials produce an HTTP Basic Authorization header and are obfuscated in stored effective URLs. A configured secret produces a lowercase HMAC-SHA256 of the exact JSON in `X-Sonar-Webhook-HMAC-SHA256`. Redirects are disabled in the underlying client; one observed 301, 302, 307, or 308 response is manually followed while preserving POST and body. Missing or unsupported redirect locations become delivery errors. There is no application-level retry loop. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/webhook/WebhookCallerImpl.java`; `HttpUrlHelper.java`]

### 8.3 Delivery state and retention

Every attempted call produces one durable delivery row with a fresh ID, webhook/project/task/analysis linkage when available, name, effective URL, `success`, optional `httpStatus`, optional `durationMs`, optional error stack trace, exact payload JSON, and attempt time. Only HTTP status 200 through 299 is successful. Connectivity, parsing, redirect, and runtime failures carry an error and no HTTP status. Non-2xx HTTP responses are completed but unsuccessful attempts. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/webhook/WebhookDelivery.java`; `WebhookDeliveryStorage.java`]

Delivery history is retained for 30 days and is purged after webhook scheduling. `api/webhooks/deliveries` accepts exactly one of `webhook`, deprecated `ceTaskId`, or deprecated `componentKey`, plus paging whose observed default size is 10; it returns summary fields `id`, `at`, `name`, `url`, `success`, `componentKey`, and optional `ceTaskId`, `httpStatus`, and `durationMs`. `api/webhooks/delivery?id=…` adds `payload` and optional `errorStacktrace`. Access requires current project administration. No retry count or resend state exists. [Provenance: `server/sonar-server-common/src/main/java/org/sonar/server/webhook/WebhookDeliveryStorage.java`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/webhook/ws/WebhookDeliveriesAction.java`; `WebhookDeliveryAction.java`; `WebhookWsSupport.java`]

A failure to persist a delivery or run purge occurs in asynchronous work and does not change analysis state. A delivery record proves only an HTTP attempt and response classification; it does not prove that the receiver processed the payload.

## 9. IDE server push

### 9.1 Connection contract

`GET api/push/sonarlint_events` is an internal authenticated server-sent-events endpoint. Mandatory comma-separated parameters are `projectKeys` and `languages`. Every project must exist, the list must be nonempty, and the current active user must have Browse permission on each project. The request must advertise an `Accept` value containing `text/event-stream`; otherwise the response is 406. A successful connection returns status 200, UTF-8 `text/event-stream`, sets `Connection: close`, enters asynchronous mode with no servlet timeout, and registers an in-memory client containing user UUID, project UUIDs, and language keys. [Provenance: `server/sonar-webserver-pushapi/src/main/java/org/sonar/server/pushapi/ServerPushWs.java`; `ServerPushAction.java`; `sonarlint/SonarLintPushAction.java`; `SonarLintClientPermissionsValidator.java`]

The server sends a blank-line heartbeat every 20 seconds. Completion, timeout, stream error, write failure, deleted/deactivated user, or loss of project permission unregisters and closes the client. Permission is rechecked immediately before each relevant event is written. Connections are process-local and are not restored after restart; the IDE must reconnect. [Provenance: `server/sonar-webserver-pushapi/src/main/java/org/sonar/server/pushapi/ServerPushClient.java`; `HeartbeatTask.java`; `sonarlint/SonarLintClientsRegistry.java`]

### 9.2 Event production and filtering

Push-event rows carry event name, project UUID, optional language, opaque UTF-8 JSON payload, creation timestamp, and UUID. Shipped producers emit:

- `RuleSetChanged` when relevant quality-profile association, activation, deactivation, severity, impact, parameter, or template-derived rule data changes. Its payload identifies the project and activated/updated and deactivated rule sets. It is delivered only to clients that selected both the project and event language.
- `IssueChanged` when eligible main-branch issue changes affect resolution, severity, impact severity, or type. Its payload identifies project, branch, affected issue keys, and changed classification data. Language filtering does not apply.
- `SecurityHotspotChanged` for a changed security hotspot in the selected project. Language filtering does not apply.

[Provenance: `server/sonar-webserver-pushapi/src/main/java/org/sonar/server/pushapi/qualityprofile/QualityProfileChangeEventServiceImpl.java`; `issues/IssueChangeEventServiceImpl.java`; `hotspots/HotspotChangeEventServiceImpl.java`; `sonarlint/SonarLintClientsRegistry.java`]

Each SSE message has `event: <name>`, then one `data:` value containing the stored JSON, and ends with a blank line. There is no SSE `id` or `retry` field. [Provenance: `server/sonar-webserver-pushapi/src/main/java/org/sonar/server/pushapi/sonarlint/SonarLintPushEvent.java`; `ServerPushClient.java`]

### 9.3 Polling, cursor state, and purge

A single daemon poller starts after `sonar.pushevents.polling.initial.delay`, observed default 120 seconds, and runs at fixed rate `sonar.pushevents.polling.period`, observed default 40 seconds. With no connected clients it clears its in-memory cursor and does not query. When clients first exist, the default cursor timestamp is the current time unless overridden by `sonar.pushevents.polling.last.timestamp`; therefore older stored events are not replayed by default. Queries are restricted to projects selected by connected clients and use timestamp plus last-seen UUID as the cursor, in chunks controlled by `sonar.pushevents.polling.page.size`, observed default 20. The cursor advances to the last selected row after broadcast attempts. Poll exceptions are logged and isolated from future fixed-rate invocations. [Provenance: `server/sonar-webserver-pushapi/src/main/java/org/sonar/server/pushapi/scheduler/polling/PushEventPollScheduler.java`; `PushEventPollExecutorServiceImpl.java`]

Push delivery has no per-client acknowledgement and no durable delivered/failed marker. A stream write failure unregisters that client, but the poll cursor still advances after processing the fetched chunk, so the event is not retried for that connection. A client connected to another Web process receives the same database-backed row through that process’s independent poller, subject to its cursor.

Expired rows are rows older than one hour. Purge begins after `sonar.push.events.purge.initial.delay`, observed default one hour, repeats at `sonar.push.events.purge.enqueue.delay`, observed default one hour, and uses global lock `PushPurgeCheck` with an observed 60-second lease. Scheduler and purge failures are logged; a later run can recover. [Provenance: `server/sonar-webserver-pushapi/src/main/java/org/sonar/server/pushapi/scheduler/purge/PushEventsPurgeScheduler.java`]

## 10. Security, trust boundaries, and compatibility

Notification subscriptions never bypass current project authorization. IDE subscriptions and each push write recheck user/project authorization. Webhook configuration and delivery history require administration. SMTP, webhook URLs, and telemetry-independent event handlers cross trust boundaries and must be treated as untrusted endpoints or extensions. Secrets must not appear in webhook-list or email-configuration responses; webhook credentials embedded in URLs must be obfuscated in stored delivery URLs. [Provenance: cited authorization, webhook, and email sources]

Webhook payloads include project identity, analysis properties, quality-gate conditions, and potentially sensitive failure stack traces in administrator-only delivery details. IDE event payloads include issue/rule identifiers and are available only for browsable projects. Email trace logging sanitizes line breaks in message content, and recipient addresses reject CR/LF injection. [Provenance: `WebhookPayloadFactoryImpl.java`; `WebhookWsSupport.java`; `SonarLintClientPermissionsValidator.java`; `EmailNotificationChannel.java`]

Compatibility requires preserving event-type strings, notification dispatcher keys, subscription-property form, API parameters and fields, webhook headers and success definition, SSE event names and formatting, and the observed delete-before-attempt email queue behavior. Event payload classes sent to CE must remain JSON-compatible with the registered payload class. Old serialized notification rows may become unreadable across upgrades and are intentionally discarded rather than migrated. [Provenance: `CeEventTaskProcessor.java`; `DefaultNotificationManager.java`; public route sources above]

## 11. Acceptance scenarios

1. **Local event failure isolation.** Given two matching Web handlers and the first throws, when an event is published, the second handler still runs, the first failure is logged, and no user notification is implied.
2. **CE forwarding.** Given an exact-name CE handler, when the Web process publishes its event, one CE task is submitted with task type equal to `eventType` and both JSON characteristics. A handler that matches only by a broadened predicate does not cause CE forwarding.
3. **Missing CE characteristic.** Given a CE event task missing payload or metadata JSON, processing fails that task and does not redispatch a partial event.
4. **Project subscription authorization.** Given a user subscribed to `NewIssues` who has since lost Browse permission, when a project notification is selected, no email request is produced for that user.
5. **Enabled-by-default opt-out.** Given a quality-gate administrator with no property, listing notifications includes `QualityGateConditionsMismatch`. After removal, an explicit false property is stored and the list omits it.
6. **No email retry.** Given one queued notification and an SMTP failure, the queue row was already deleted, the failure is logged, and no retry row or failed-delivery record is created.
7. **Webhook success classification.** Given a webhook receiver returns 204, the delivery is persisted as successful with status and duration. Given 500, it is persisted as unsuccessful without an application retry.
8. **Webhook signing.** Given a configured secret, the outgoing request contains the lowercase HMAC-SHA256 of the exact payload under `X-Sonar-Webhook-HMAC-SHA256`; list responses reveal only that a secret exists.
9. **Webhook SSRF guard.** Given local-address validation is enabled and a hostname resolves to loopback or a local interface, create or delivery is rejected as applicable.
10. **IDE stream negotiation.** Given a logged-in user with Browse permission but no `text/event-stream` accept value, the endpoint returns 406 and registers no client.
11. **IDE permission revocation.** Given a connected client loses Browse permission before a relevant event, the event is not written and the connection is unregistered.
12. **Push cursor and purge.** Given no client is connected, polling clears its cursor. When a client later connects, default polling begins at current time; rows older than one hour are eligible for hourly purge and are not a replay guarantee.
13. **Observability distinction.** Given a webhook delivery row says success or an email sent counter increments, the system may report an attempted successful transport but must not represent that state as human acknowledgement or downstream processing.

## 12. Provenance index

- Release and license: `manifest/release-baseline.md`, `manifest/license-map.md`, root `LICENSE.txt`, `gradle.properties`, and `build.gradle`.
- Unified events: exact Maven source artifacts `sonar-events-api:1.16.0.5078` and `sonar-events-server:1.16.0.5078`; `server/sonar-events/src/main/java/org/sonar/server/events/`.
- Concrete startup event: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/telemetry/ServerStartupEventPublisher.java`.
- Subscription API and selection: `server/sonar-webserver-webapi/src/main/java/org/sonar/server/notification/ws/`; `server/sonar-server-common/src/main/java/org/sonar/server/notification/`; notification handlers under `server/sonar-server-common`, `server/sonar-webserver-auth`, `server/sonar-webserver-webapi`, and `server/sonar-ce-task-projectanalysis`.
- Email: `server/sonar-server-common/src/main/java/org/sonar/server/email/`; `server/sonar-server-common/src/main/java/org/sonar/server/notification/email/`; `server/sonar-webserver-common/src/main/java/org/sonar/server/common/email/config/`; `server/sonar-webserver-webapi-v2/src/main/java/org/sonar/server/v2/api/email/config/`.
- Webhooks: `server/sonar-server-common/src/main/java/org/sonar/server/webhook/`; `server/sonar-webserver-webapi/src/main/java/org/sonar/server/webhook/ws/`; `server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/webhook/`; `server/sonar-db-dao/src/main/java/org/sonar/db/webhook/`.
- IDE push: `server/sonar-webserver-pushapi/src/main/java/org/sonar/server/pushapi/`; `server/sonar-db-dao/src/main/java/org/sonar/db/pushevent/`.
