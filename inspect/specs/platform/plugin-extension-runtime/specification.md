# Plugin and Extension Runtime Specification

## 1. Identity and authority

This specification describes the plugin and extension runtime shipped with SonarQube Community Build 26.8.0.126808, tag `26.8.0.126808`, commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`. Its public plugin contract is pinned to `org.sonarsource.api.plugin:sonar-plugin-api:13.8.0.4399`. The inspected source artifact for that API has SHA-256 `29a5fe919de4c4558b5640126f6d2cba7b750988919c74feb9f1dd6f46df2819`.

SonarQube production source and plugin API are licensed under `LGPL-3.0-or-later`. This is a clean-room behavioral specification, not legal advice. No commercial extension behavior is included.

Normative evidence is the pinned platform tree and plugin API 13.8.0.4399 source artifact. Where this document distinguishes a compatibility requirement from an incidental implementation choice, the observable behavior of the pinned release is authoritative.

## 2. Purpose, scope, and ownership

The runtime owns these contracts:

- discovery and classification of bundled and externally installed plugin JARs;
- manifest descriptor parsing, identity, compatibility, and dependency checks;
- plugin archive deployment, embedded-library discovery, class loading, class visibility, and unloading;
- instantiation of plugin entry points and registration of process-specific extensions;
- dependency injection and `Startable` lifecycle callbacks;
- plugin-defined setting metadata and the configuration views exposed to extensions;
- persisted installation identity and restart-bound install, update, and uninstall state;
- discovery and lifecycle of trusted core extensions.

The runtime does not own analyzer rule behavior, scanner-engine execution, compute-task processing, project-setting policy, generic HTTP routing, or UI presentation. Those contracts belong to their corresponding specifications. Plugin administration Web API transport uses the HTTP API contract; only plugin state transitions and metadata are specified here.

Dependencies are the process runtime for process startup and shutdown, persistence for plugin and setting records, project configuration for persisted setting and rule semantics, scanner gateway for scanner-visible plugin artifacts, and the web and compute extension containers. Every analyzer and integration plugin consumes this runtime.

## 3. Plugin artifact and descriptor contract

### 3.1 Discovery locations and classification

At web-server startup, the runtime discovers non-recursive files with a `.jar` extension from the installed bundled-plugin directory and the installed external-plugin directory. It also examines the download-staging directory. The server filesystem exposes separate locations for bundled, external, downloaded, uninstall-staged, and deployed scanner/plugin files. Files of other extensions and nested JARs in these installation directories are not discovered as plugins.

Bundled artifacts are classified `BUNDLED`; user-installed artifacts are classified `EXTERNAL`. A downloaded artifact is moved into the external-plugin directory during the next startup. If its key already identifies an external plugin, the old external JAR is deleted and the downloaded JAR becomes the installed version. A download cannot replace a bundled plugin.

Only the main section of `META-INF/MANIFEST.MF` supplies descriptor values. The following manifest names are compatibility identifiers:

| Manifest name | Runtime contract |
|---|---|
| `Plugin-Key` | Plugin identity. The manifest parser normalizes artifact-style values by removing a leading `sonar-` plus trailing `-plugin`, or a trailing `-sonar-plugin`, then removes every non-letter and non-digit. A missing or blank resulting key makes the file invalid as a plugin. |
| `Plugin-Class` | Fully qualified entry-point class. It may be absent only for a plugin that contributes files to a declared `Plugin-Base`; an artifact with neither an entry point nor a base plugin is ignored. |
| `Plugin-Name` | Display name. Missing value defaults to normalized plugin key. |
| `Plugin-Version` | Plugin version used for identity, dependency comparison, display fallback, and logging. |
| `Plugin-Display-Version` | Optional display override. When nonblank, public metadata uses it instead of `Plugin-Version`. |
| `Sonar-Version` | Minimum required Sonar Plugin API version. Absence means no minimum constraint. |
| `Plugin-Description` | Optional public description. |
| `Plugin-Organization` and `Plugin-OrganizationUrl` | Optional publisher identity and URL. |
| `Plugin-License` | Optional displayed license text. |
| `Plugin-Homepage` and `Plugin-IssueTrackerUrl` | Optional public links. |
| `Plugin-ChildFirstClassLoader` | Case-insensitive `true` selects self-first loading for the base plugin's classloader. Every other value and absence select parent-first. Child-first is supported for compatibility but emits a deprecation warning. |
| `Plugin-Base` | Optional base-plugin key. The plugin joins the root base plugin's classloader. Historical value `l10nen` is ignored and logged as obsolete. |
| `Plugin-RequirePlugins` | Optional comma-separated dependency entries. Each entry must start with a word-character key, a colon, and a nonempty suffix. The parser splits on every colon but uses only fields 0 and 1, so `dep:1.2:ignored` is accepted as dependency `dep` with minimum `1.2`; an absent colon or an empty suffix is rejected. Minimum-version qualifiers are removed before comparison. A requirement whose key is `license` is ignored. |
| `Plugin-RequiredForLanguages` | Optional comma-separated language keys exposed in installed-plugin metadata. Absence yields an empty set. |
| `SonarLint-Supported` | Case-insensitive boolean metadata; default is false. |
| `Implementation-Build` | Optional build identifier exposed in metadata and logs. |
| `Plugin-Dependencies`, `Plugin-TermsConditionsUrl`, `Plugin-BuildDate`, `Plugin-SourcesUrl`, and `Plugin-Developers` | Recognized by the manifest model but not retained as loading decisions by this pinned runtime. They must not alter loading behavior. |

If the JAR contains the exact entry `static/documentation.md`, installed-plugin metadata records that path. Failure to inspect this optional entry logs a warning and leaves the documentation path absent; it does not alone reject the plugin.

### 3.2 Identity collisions and forbidden plugins

Plugin keys are unique across the running instance.

- Two bundled JARs with one key fail startup.
- An external JAR whose key collides with a bundled plugin fails startup.
- Two external JARs with one key fail startup.
- A staged download whose key collides with a bundled plugin fails startup.

Keys `scmactivity`, `issuesreport`, and `genericcoverage` are blacklisted: discovered JARs are deleted and not loaded. Keys `sqale`, `report`, `views`, `authgithub`, `authgitlab`, `authbitbucket`, `authsaml`, `ldap`, `scmgit`, and `scmsvn` are forbidden incompatible plugins: their presence causes startup failure rather than silent removal.

### 3.3 API-version and plugin-dependency compatibility

The runtime API version is `13.8.0.4399`. A plugin with `Sonar-Version` is compatible only when the runtime API version, with qualifiers removed, is greater than or equal to the declared minimum with qualifiers removed. Snapshot-runtime comparison retains the pinned behavior of reducing the required version comparison to the minimum's major and minor fields. An incompatible API minimum fails startup with the required and current versions identified.

Dependency validation is iterative until stable:

- a plugin whose `Plugin-Base` is absent is ignored;
- a plugin whose required plugin is absent is ignored;
- a plugin whose installed dependency version is lower than the declared minimum is ignored;
- removal of one incompatible plugin can cause any depth of dependents and base-plugin descendants to be ignored in later passes.

An installed dependency with no version does not fail a minimum-version check. Dependency failure is a logged exclusion, not a whole-server failure. Malformed `Plugin-RequirePlugins` syntax fails descriptor loading.

## 4. Loading and isolation

### 4.1 Deployment and embedded libraries

Before loading, each accepted server plugin is copied to a clean deployed directory named by plugin key. The original external JAR is therefore not held open by the classloader and can be moved for uninstall. The deployment directory is cleaned on each explosion. Only entries below `META-INF/lib` are extracted as embedded libraries; direct files in the resulting `META-INF/lib` directory join the plugin classpath. Archive entries that normalize outside the target directory are rejected.

A deployment or extraction failure fails startup and identifies plugin key, source JAR, and target directory.

### 4.2 Classloader graph

The default is one isolated classloader per plugin. A base plugin and every transitive plugin naming it through `Plugin-Base` share the root base plugin's classloader, main JARs, and embedded libraries. Descendants cannot change that shared classloader's loading order or compatibility mode; the root base plugin controls those attributes.

Every plugin classloader has a masked API parent. Parent-visible resources are limited to these package/resource families:

- `org/sonar/api/`, excluding `org/sonar/api/internal/`;
- `org/sonar/check/`;
- `org/codehaus/stax2/`, `org/codehaus/staxmate/`, and `com/ctc/wstx/`;
- `org/slf4j/` plus the logging bridge families `org/apache/commons/logging/`, `org/apache/log4j/`, and `ch/qos/logback/`;
- `javax/servlet/`;
- `org/sonar/server/platform/`;
- `com/sonarsource/plugins/license/api/`.

Other platform internals are not parent-visible. Each plugin exports its conventional API resources under `org/sonar/plugins/<pluginKey>/api/`, `com/sonar/plugins/<pluginKey>/api/`, and `com/sonarsource/plugins/<pluginKey>/api/` to sibling plugin classloaders. No other plugin package is a supported cross-plugin linkage surface.

Parent-first loading is the default. `Plugin-ChildFirstClassLoader: true` selects self-first for the root classloader tree. The option does not create a security boundary and is deprecated.

### 4.3 Entry-point creation

Each nonempty `Plugin-Class` is loaded by its assigned plugin classloader, must implement `org.sonar.api.Plugin`, and must have an accessible no-argument constructor. One entry-point instance is created per process-side plugin load. An unsupported bytecode level reports that the plugin does not support the running Java version. A missing class, linkage error, constructor error, wrong type, or other throwable fails plugin loading and therefore process startup.

Plugin iteration order is unspecified. Plugins must express compatibility through descriptor dependencies and injected component dependencies, not depend on entry-point invocation order.

## 5. Extension registration contract

### 5.1 Plugin context

For each loaded plugin, the process installs the entry-point instance, creates a fresh `Plugin.Context`, and invokes `define` once for that process startup. The context exposes:

- the runtime product, API version, and current side through `SonarRuntime`;
- boot configuration as defined in section 7;
- an ordered collection of extension classes or extension instances.

A null extension is invalid. A plugin must not register the same extension class more than once, whether as two classes, two instances, or a class plus instance.

An extension class is container-created once for its applicable container, with constructor parameters resolved by dependency injection. An extension instance is used as supplied. Runtime-retained side markers decide applicability:

- `org.sonar.api.server.ServerSide` for web-server extensions;
- `org.sonar.api.ce.ComputeEngineSide` for compute-engine extensions;
- `org.sonar.api.scanner.ScannerSide` for scanner project-container extensions;
- deprecated `org.sonar.api.batch.ScannerSide` only for legacy scanner compatibility.

A class can carry more than one applicable marker. On server and compute sides, an extension lacking the side's supported marker is not instantiated as a component, but its property metadata is still declared. This permits one plugin definition to expose setting definitions on every side while activating behavior only where marked.

Component identity includes classloader and fully qualified class name, preventing same-named classes from unrelated plugin classloaders from colliding. Bean-definition replacement is disabled. Container lookup failure, ambiguous dependency injection, duplicate identity, or an exception from `define` fails the relevant process startup with plugin name and key.

### 5.2 Trusted core extensions

Trusted platform core extensions are separate from external plugins. They are discovered with the platform classloader through the service-provider mechanism, identified by `CoreExtension.getName()`, and run without plugin classloader isolation. Duplicate core-extension names fail loading. A core extension receives runtime and boot configuration, may declare side-filtered components and Web API v2 configuration classes, and may provide extension property defaults. A failure while loading one fails core-extension installation. Core extensions are an internal platform contract and must not be presented as user-installable plugins.

## 6. Lifecycle, state, and concurrency

Plugin loading is startup-bound. The observable state sequence is:

1. discover bundled, external, and staged JARs;
2. parse descriptors and reject collisions or forbidden artifacts;
3. apply staged install/update moves;
4. remove blacklisted artifacts and iteratively exclude incompatible dependencies;
5. copy and extract accepted artifacts into deployment directories;
6. build classloaders and instantiate entry points;
7. register loaded plugins in the process repository;
8. invoke each entry point and register applicable extensions;
9. instantiate dependency graphs and call lifecycle starts;
10. on shutdown, stop components, close plugin classloaders, and release deployed JARs.

A component implementing `org.sonar.api.Startable` receives `start()` at the beginning of its container lifecycle and `stop()` before destruction. `start()` cannot be called a second time without an intervening `stop()`. In the web server, start occurs once after any required database migration; in the compute engine, once at process startup. Any `start()` exception fails process startup. `stop()` exceptions are logged as disposal warnings and do not prevent remaining shutdown work. Scanner component lifetime depends on scanner container and instantiation strategy and is owned by the scanner-engine specification.

Startup registration is single-threaded from the runtime's perspective. Once containers are active, extension thread safety is the extension's responsibility. Plugin entry points and extension lists are not hot-reloaded while a process is running.

On manager shutdown, each distinct closeable plugin classloader is closed. Close failure is logged and shutdown continues. The base platform classloader is never closed.

## 7. Plugin configuration contract

### 7.1 Property declarations

A plugin may register `PropertyDefinition` objects or deprecated `@Property` and `@Properties` annotations. Keys are global across all plugins and should use a `sonar.<plugin>` prefix. The first registered definition for a key is retained; later definitions with that key do not replace it.

`PropertyDefinition` defaults are:

- empty name, description, default value, category, subcategory, and deprecated key;
- type `STRING`;
- global visibility enabled and no project/application/view scope;
- not hidden;
- not multi-valued;
- no options or fields;
- display index `999`.

Supported types are `STRING`, `TEXT`, `PASSWORD`, `BOOLEAN`, `INTEGER`, `FLOAT`, `SINGLE_SELECT_LIST`, `REGULAR_EXPRESSION`, `PROPERTY_SET`, `USER_LOGIN`, `JSON`, `FORMATTED_TEXT`, and `EMAIL`. A key ending in `.password.secured` and otherwise declared as `STRING` is treated as `PASSWORD`. A key ending in `.secured` requires administration permission to access its value. Hidden definitions are not discoverable in normal settings pages but remain configurable by API and retain type/default behavior.

Definitions can be available globally plus selected `PROJECT`, `APP`, `VIEW`, or `SUB_VIEW` scopes, or only in those scopes. Deprecated module scope exists only for compatibility. Global is the default. A definition cannot combine both scope modes. Supplying fields converts the type to `PROPERTY_SET`. `JSON` cannot be multi-valued. Empty key is invalid. Property-set fields require nonempty keys and names and default to `STRING`.

Validation treats blank values as valid. Nonblank values are checked as follows: booleans accept case-insensitive `true` or `false`; integers contain digits only in definition validation; floats must parse as a double; regular expressions must compile; email uses the API email validator; single-select values must equal one declared option. Other types receive no generic value validation from this layer.

### 7.2 Effective values and precedence

`Configuration` returns an optional effective string, reports whether a non-default value exists, parses multi-values, and provides typed boolean, integer, long, float, and double access. Missing value plus missing default returns empty. Typed numeric conversion failure raises an `IllegalStateException`. Boolean conversion trims the value and returns true only for case-insensitive Java boolean text equivalent to `true`; any other nonempty text is false.

Multi-valued scanner text uses CSV: commas delimit fields, unquoted fields are trimmed, empty unquoted fields are discarded, and quotes preserve commas, empty strings, and surrounding spaces.

For normal web-server and compute-engine global configuration, effective precedence is system configuration, environment override, persisted global value, then plugin default. An environment override name is the property key uppercased with `.` and `-` replaced by `_`. A deprecated key resolves to its current key. Encrypted persisted values are decrypted before return; decryption failure is fatal to that read.

Project configuration and its full persistence/authorization rules belong to `platform/project-configuration/`. Scanner `Configuration` is the immutable effective project configuration assembled for that analysis. Web-server and compute-engine `Configuration` exposes global values only and must not expose project overrides.

### 7.3 Boot configuration

Boot configuration is intentionally narrower than normal effective configuration:

- on web-server and compute-engine sides it contains only values needed to bootstrap the process, including installation configuration and persisted properties; plugin-defined default values are ignored;
- on scanner side it contains command-line analysis properties; plugin defaults and server-persisted properties are ignored.

A plugin must not assume its declared default is available while `Plugin.define` is running. Defaults become available after property definitions have joined the normal configuration registry.

## 8. Installation persistence and restart transitions

Install, update, and uninstall changes become effective only after restart.

- Downloaded plugins are written through a temporary file and copied to a final staged JAR; stale temporary download files are removed on startup. Cancelling pending downloads clears the download directory.
- Uninstall applies only to `EXTERNAL` plugins. For an acyclic `Plugin-RequirePlugins` graph, it moves the installed JAR to the uninstall-staging directory and recursively stages every plugin that declares it as required. Bundled plugins cannot be uninstalled through this transition. Cancelling restores staged JARs without overwriting an existing installed file. Required-plugin cycles are accepted during compatibility validation but are not safe to uninstall: dependent traversal recurses even when a key is already accumulated, ends in `StackOverflowError`, and reaches no JAR move loop, so no member of that uninstall request is staged.
- Base-plugin descendants are excluded on the next startup if their base disappears, even though uninstall dependency traversal is based on explicit required-plugin relationships.

The persisted plugin record contains stable UUID, key, optional base-plugin key, MD5 of the loaded JAR, type, removed flag, and creation/update times. A new key inserts a record. A changed JAR hash or type updates it. A previously removed key is reactivated. Missing keys are retained with `removed=true` because historical rules and active rules may still reference them.

Plugin-change detection compares the active persisted key set, JAR MD5 values, and types with loaded artifacts. Internal key `plugin.refresh.forced=true` forces one refresh and is deleted after it is consumed. MD5 is a change/cache identifier, not a cryptographic authenticity proof.

## 9. Failure, partial result, and recovery

Startup fails without a partially active plugin set for invalid plugin files, key collisions, forbidden incompatible plugins, API-version mismatch, archive deployment failure, classloader construction failure, entry-point failure, `define` failure, dependency-injection failure, or extension `start()` failure. The operator recovers by correcting or removing the offending JAR or configuration and restarting.

Missing base or required plugins and insufficient required-plugin versions produce logged exclusions. Exclusion propagates through dependency chains. Other compatible plugins continue loading.

A blacklisted plugin is deleted and startup continues. A plugin with no entry point and no base is ignored and startup continues. Optional documentation inspection failure leaves metadata incomplete and startup continues.

Download, move, staging-directory, or cancel failure reports an illegal state; it must not be represented as an effective install/uninstall. Shutdown disposal and classloader-close failures are logged while remaining cleanup continues.

Recovery from cyclic-uninstall failure requires leaving the running installation unchanged, breaking the required-plugin cycle in the installed descriptors, restarting so the corrected graph loads, and retrying uninstall. The runtime must not report the failed recursive traversal as a pending uninstall.

## 10. Security and trust boundaries

Classloader masking prevents accidental linkage to most platform internals; it is not a sandbox. Plugin code executes in the web, compute, or scanner process with access to injected services and the process's ambient privileges. The pinned tree contains policy-rule types, but no production wiring was found that would make them a complete plugin sandbox. Operators must treat every external plugin as trusted executable code.

Archive extraction rejects paths outside the deployment directory. Duplicate keys cannot override bundled code. The runtime does not establish JAR signature verification; MD5 fields support identity and cache coherence only.

When any `EXTERNAL` plugin is loaded and hidden setting `sonar.plugins.risk.consent` is `NOT_ACCEPTED` or absent, startup records `REQUIRED` and logs an explicit risk warning. Values are `NOT_ACCEPTED`, `REQUIRED`, and `ACCEPTED`; default is `NOT_ACCEPTED`. A logged-in system administrator in `REQUIRED` state is redirected to `/admin/plugin_risk_consent` for ordinary UI routes. Static resources, reset/change-password routes, `/batch/*`, `/api/*`, and `/api/v2/*` are excluded from that redirect. Removing all external plugins clears a stale `REQUIRED` value; an already `ACCEPTED` value is retained.

Secret setting values must not be logged or exposed through plugin metadata. Generic authentication, CSRF, and API authorization remain owned by identity-access and HTTP API specifications.

## 11. Compatibility limits

- Plugin API compatibility is pinned to 13.8.0.4399, not the product version string.
- Only JAR descriptors and class/resource contracts described here are supported. Native binaries or subprocesses started by plugins are plugin-owned behavior.
- `Plugin-ChildFirstClassLoader`, deprecated scanner-side annotations, module setting scope, annotation-based property definitions, and historical descriptor fields exist only for compatibility and must not be expanded into new behavior.
- A plugin built against platform internals outside the parent mask is incompatible even if it happens to compile elsewhere.
- The runtime makes no promise of plugin invocation order, hot reload, process isolation, or cryptographic plugin verification.

## 12. Acceptance scenarios

### 12.1 Valid isolated plugin

Given an external JAR with a unique key, compatible `Sonar-Version`, valid entry point, and one `ServerSide` extension, when the server restarts, the runtime copies and extracts it, creates an isolated parent-first classloader, invokes `define`, injects the extension, calls its `start()`, records type `EXTERNAL` and its JAR MD5, and changes risk consent to `REQUIRED` unless already accepted.

### 12.2 Bundled-key collision

Given an external JAR whose normalized `Plugin-Key` equals a bundled plugin key, when discovery runs, startup fails with both identities and instructs removal of the external artifact. Bundled code is never replaced.

### 12.3 API incompatibility

Given a plugin requiring an API version greater than 13.8.0.4399, when compatibility is checked, startup fails before entry-point instantiation and reports required and current API versions.

### 12.4 Transitive dependency exclusion

Given plugin B requiring absent plugin A and plugin C based on B, when dependency validation reaches stability, B is ignored first and C is subsequently ignored. Unrelated compatible plugins still load.

### 12.5 Base-plugin class sharing

Given plugin B naming plugin A as `Plugin-Base`, when both load, their main JARs and `META-INF/lib` files use A's classloader. B cannot change A's loading order. Removing A causes B to be excluded at the next startup.

### 12.6 Internal-class access

Given a plugin that links to `org.sonar.api.internal` or an unexposed server package, when the JVM resolves that reference, class loading fails and process startup fails. The runtime does not widen the API mask to accommodate it.

### 12.7 Side filtering and property declaration

Given one extension marked only `ComputeEngineSide` that also declares a property, when the web-server container installs the plugin, it does not instantiate the extension as behavior but does register its property definition. The compute-engine container instantiates and starts it.

### 12.8 Boot default exclusion

Given a plugin declaring a property default but no explicit value, when `Plugin.define` reads boot configuration, the value is absent. After normal configuration is assembled, the extension reads the declared default.

### 12.9 Start and stop failure

Given an extension whose `start()` throws, process startup fails. Given an extension whose `stop()` throws during shutdown, the failure is logged and the runtime continues stopping other components and closing plugin classloaders.

### 12.10 Restart-bound update

Given a running external plugin and a newly downloaded compatible version, when the download completes, the current process continues using the old instance. On restart, the old JAR is replaced, the new hash is persisted, and new entry-point and extensions become active.

### 12.11 Uninstall with dependents

Given external plugin A and external plugin B declaring A in `Plugin-RequirePlugins`, when A is uninstalled, both JARs are staged for removal. Neither disappears from the already running process. After restart, neither loads and both historical records remain marked removed.

### 12.12 Cyclic dependency uninstall failure

Given external plugin A requiring B and B requiring A, when compatibility validation runs, both may load because each required key and version is present. When uninstall of either is requested, recursive dependent discovery ends in `StackOverflowError` before staging begins. Both installed JARs remain in place; recovery requires breaking the cycle, restarting, and retrying.

### 12.13 Archive traversal attempt

Given a plugin JAR whose selected embedded-library entry normalizes outside its deployment directory, when extraction runs, startup fails and no outside file is created.

## 13. Provenance index

- Release identity and plugin API pin: `manifest/release-baseline.md`; `manifest/component-inventory.md`; `gradle.properties`; root `build.gradle` in the pinned SonarQube tree.
- License: `manifest/license-map.md`; pinned root `LICENSE.txt`; published plugin API POM/source artifact.
- Manifest names and parsing: `sonar-update-center-common-1.36.0.4317/org/sonar/updatecenter/common/PluginManifest.java`; `PluginKeyUtils.java`.
- Descriptor validation and compatibility: `sonar-core/src/main/java/org/sonar/core/platform/PluginInfo.java`.
- Discovery, collisions, blacklist, staging, and API check: `server/sonar-webserver-api/src/main/java/org/sonar/server/plugins/PluginJarLoader.java`.
- Dependency exclusion: `server/sonar-server-common/src/main/java/org/sonar/server/plugins/PluginRequirementsValidator.java`.
- Deployment and embedded libraries: `sonar-core/src/main/java/org/sonar/core/platform/PluginJarExploder.java`; `server/sonar-webserver-api/src/main/java/org/sonar/server/plugins/ServerPluginJarExploder.java`.
- Archive traversal protection: plugin API 13.8.0.4399, `org/sonar/api/utils/ZipUtils.java`.
- Classloader graph and masks: `sonar-core/src/main/java/org/sonar/core/platform/PluginClassLoader.java`; `PluginClassLoaderDef.java`; `PluginClassloaderFactory.java`.
- Plugin context: plugin API 13.8.0.4399, `org/sonar/api/Plugin.java`; pinned `sonar-plugin-api-impl/src/main/java/org/sonar/api/internal/PluginContextImpl.java`.
- Server and compute side installation: `server/sonar-server-common/src/main/java/org/sonar/server/plugins/ServerExtensionInstaller.java`; `server/sonar-webserver-api/src/main/java/org/sonar/server/plugins/WebServerExtensionInstaller.java`; `server/sonar-ce/src/main/java/org/sonar/ce/platform/ComputeEngineExtensionInstaller.java`.
- Component and `Startable` lifecycle: plugin API 13.8.0.4399, `org/sonar/api/Startable.java`; `sonar-core/src/main/java/org/sonar/core/platform/SpringComponentContainer.java`; `StartableBeanPostProcessor.java`.
- Configuration and definitions: plugin API 13.8.0.4399, `org/sonar/api/config/Configuration.java`; `PropertyDefinition.java`; `PropertyDefinitions.java`; `PropertyFieldDefinition.java`; `org/sonar/api/Property.java`; `PropertyType.java`; pinned `server/sonar-server-common/src/main/java/org/sonar/server/setting/ThreadLocalSettings.java`; `sonar-plugin-api-impl/src/main/java/org/sonar/api/config/internal/Settings.java`.
- Install/uninstall state: `server/sonar-webserver-api/src/main/java/org/sonar/server/plugins/PluginDownloader.java`; `PluginUninstaller.java`; `ServerPluginManager.java`.
- Persistence and change detection: `server/sonar-webserver-core/src/main/java/org/sonar/server/startup/RegisterPlugins.java`; `server/sonar-webserver-api/src/main/java/org/sonar/server/plugins/DetectPluginChange.java`; `PluginFilesAndMd5.java`.
- Risk consent: `sonar-core/src/main/java/org/sonar/core/config/CorePropertyDefinitions.java`; `sonar-core/src/main/java/org/sonar/core/extension/PluginRiskConsent.java`; `server/sonar-webserver-api/src/main/java/org/sonar/server/plugins/PluginConsentVerifier.java`; `server/sonar-webserver-core/src/main/java/org/sonar/server/plugins/PluginsRiskConsentFilter.java`.
- Core extensions: `sonar-core/src/main/java/org/sonar/core/extension/CoreExtension.java`; `CoreExtensionsLoader.java`; `CoreExtensionsInstaller.java`; `server/sonar-server-common/src/main/java/org/sonar/server/extension/CoreExtensionStopper.java`.
