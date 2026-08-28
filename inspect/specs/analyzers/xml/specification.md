# XML analyzer specification

## 1. Identity and conformance baseline

This specification defines the XML analyzer bundled with SonarQube Community Build `26.8.0.126808`. The bundled artifact is `org.sonarsource.xml:sonar-xml-plugin:2.18.0.7959`. Its authoritative source is `SonarSource/sonar-xml`, tag `2.18.0.7959`, commit `793fbcea0c1e65caa6afe5b3a4b5dd04c0c4d945`. Analyzer-owned source is licensed under Sonar Source-Available License v1.0, recorded as `LicenseRef-SSAL-1.0`; this document is a full clean-room specification. [X1][X2][X3]

The language and rule-repository key are `xml`; the displayed language name is `XML`, and the repository name is `SonarAnalyzer`. The packaged plugin declares Java 17, SonarLint support, required language `xml`, and minimum plugin API `9.14.9.375`. [X4][X5]

## 2. Purpose, scope, and exclusions

The analyzer recognizes XML and selected XML-oriented/configuration suffixes, builds a DOM with source locations, applies general XML and configuration-specific rules, emits XML line measures and highlighting, and reports parse failures. It includes rules for Maven POMs, Android manifests, Java/.NET web configuration, Struts, EJB, Hibernate and Spring XML when their identifying structure or filename is present. [X5][X6][X7]

Only scanner-indexed main files classified as `xml` are candidates. Test files are excluded. Every path matching `**/*.cls-meta.xml` is excluded after language classification; no parser, rule, metric, highlighting or parse-error output may be produced for such a file. This exclusion is mandatory even when a suffix override explicitly classifies the file as XML. [X6]

The analyzer has no CPD token producer, symbol/reference index, coverage importer, test-execution importer, external-issue importer, schema-validation service, XSLT execution engine or network-resource resolver owned by this plugin. Aggregate metrics, persistence, profiles, issue lifecycle, quality gates and scanner transport are platform contracts.

## 3. Dependencies and owned contracts

The plugin consumes analyzer commons and `sonar-xml-parsing` `2.20.0.4607`, plugin API `13.2.0.3137`, and scanner APIs. The packaged parser includes the XML parsing dependency and selected XML implementation payloads; those libraries remain dependencies rather than separately specified products. [X4][X5]

This component owns language recognition, rule repository `xml`, cataloged rule behavior and parameters, XML source locations, line measures, highlighting, parse-error conversion and the special `.config`/`.cls-meta.xml` policies. It consumes active-rule selection, generic exclusions, issue/measure storage and report serialization.

## 4. Recognition, configuration, and precedence

`sonar.xml.file.suffixes` is a project-scoped multi-value property. Its declared default is exactly `.xml,.xsd,.xsl,.config`. Returned values are trimmed and blank entries removed. If configuration yields no nonblank suffixes, the language implementation falls back to `.xml` only, not to the four-value declared default. [X5][X8]

The scanner performs language classification from that suffix set. The sensor then requires `MAIN`, language `xml`, and a path not matching `**/*.cls-meta.xml`. No content sniffing adds files that were not classified as XML. [X6]

A filename is treated as a generic configuration file for parse-failure tolerance only when it ends case-sensitively in `.config`. A .NET application configuration file is recognized case-insensitively only when its basename is exactly `web.config` or `machine.config`. [X8]

Rules `S6358` and `S5332` additionally consume integer configuration key `sonar.android.minsdkversion.min`. `S6358` treats an explicitly configured value below 23 as the legacy backup-policy case; absent values follow the modern case. `S5332` defaults an absent value to `27` and applies pre-28 implicit cleartext behavior. [X9]

## 5. Parser and data model

For each eligible file, `XmlFile.create` reads the scanner input and builds a namespace-aware DOM plus source ranges for the document, prolog, elements, attributes, text, CDATA, comments and doctype. Rules can also evaluate a namespace-unaware document view for configuration formats whose namespaces should not affect structural matching. [X6][X10]

The parser requires well-formed XML; it is not a schema or DTD validator. The plugin itself does not fetch or execute referenced schemas, stylesheets or application code. Parser implementation and hardening are supplied by pinned `sonar-xml-parsing`; the analyzer's tests exercise documents containing external-entity and remote-doctype declarations without treating external content as rule input. [X4][X10][X11]

A successfully parsed file proceeds first to measures and highlighting outside SonarLint, then to active checks. Each check receives the parsed document and scanner context.

## 6. Lifecycle, concurrency, and state transitions

The sensor collects all eligible files and returns immediately if none exist. It starts a progress report, checks cancellation before each file, and either stops normally or marks progress cancelled. A cancelled scan does not start later files. [X6]

For a valid file, measure/highlighting work occurs before rule work. Every active rule runs in its own exception boundary: a rule exception is logged with rule key and file URI, then remaining active rules continue. Such a failure does not create a parser issue or analysis error. [X6]

Outside SonarLint, measures and highlighting are emitted. In SonarLint, parsing and rules still run but these two output stages are skipped. On SonarQube runtime API 9.3 or newer, the descriptor advertises independent-file processing; reflective advertisement failure is logged and analysis continues. No analyzer-owned durable state exists. [X6]

### 6.1 Parse-failure transition

Any exception escaping parse/measure/highlighting enters the file failure handler. When the exception is specifically an XML `ParseException` and the filename ends in lowercase `.config`, the file is silently skipped: no analysis error, parsing issue, measures, highlighting or rules. This accommodates non-XML files conventionally named `.config`. [X6][X8]

For every other such failure, the analyzer saves an analysis error with the exception message, logs the failure, and, only if `xml:S2260` is active, creates a file-level parsing issue whose message includes the parse failure. The sensor then proceeds to the next file. [X6][X12]

## 7. Outputs

### 7.1 Measures

Outside SonarLint, a valid file emits `ncloc`, `comment_lines`, and line-level `ncloc_data`. Code lines include element start/end ranges (including attribute lines), nonblank text and CDATA lines, doctype lines and XML-prolog lines. Comment lines include nonblank comment content lines. A physical line may be in both sets when code and comment content share it; set semantics prevent double counting within one metric. [X13]

No complexity, class, function, statement, executable-line or symbol measures are emitted.

### 7.2 Highlighting

Outside SonarLint, prolog delimiters and element delimiters/names are keywords; attribute names are constants; attribute values are strings; CDATA delimiters are keywords; comments and doctypes are structured comments. Self-closing and ordinary closing delimiters receive their exact source ranges. [X14]

The analyzer emits no CPD tokens. It emits no coverage, test or external report observations.

### 7.3 Issues

Issues use repository `xml`. Most checks report an exact node, attribute, element-name or text range. Some include secondary locations, notably duplicate declarations, ordering problems, shared Android permissions and grouped tabs. `S2260` is file-level. Quick fixes are not emitted. [X6][X15]

### 7.4 Built-in profile and legacy mappings

Built-in `Sonar way` activates: `S125`, `S1134`, `S1135`, `S1778`, `S2068`, `S3281`, `S3330`, `S3355`, `S3374`, `S3421`, `S3422`, `S3438`, `S3439`, `S3822`, `S4507`, `S5122`, `S5322`, `S5332`, `S5344`, `S5734`, `S6358`, `S6359`, `S6361`, and `S7207`. All other cataloged rules are available to custom profiles. [X16]

Compatibility metadata maps old `xml:IndentCheck`, `xml:NewlineCheck`, and `xml:IllegalTabCheck` to `S1120`, `S2321`, and `S105`. Rules `S3281`, `S3282`, `S3822`, `S3417`, `S3419`, `S3420`, `S3421`, `S3422`, `S3423`, `S3355`, `S3438`, `S3439`, `S3373`, and `S3374` also declare their same-key former repository mapping from `java`. New issues use repository `xml`. [X17]

## 8. Complete rule catalog

Catalog membership is the exact 39-class registry at the pinned revision. Unless a row says otherwise, a rule has no parameters, requires a successfully parsed main XML file, accepts documents that do not meet its named bad condition, and locates the issue on the offending node or attribute. Filename/root gates and special exclusions are stated per row. [X7][X15][X18]

| Rule key | Detection semantics, exclusions, and primary location | Parameters and defaults | Type; default severity |
|---|---|---|---|
| `S3420` | On a basename equal case-insensitively to `pom.xml`, reports the sole project `artifactId` when its full text fails the configured regular expression. Missing or multiple project-level IDs are not reported. | `regex` = `[a-z][a-z-0-9]+` | Code smell; Minor |
| `S3422` | In `pom.xml`, reports a dependency with scope `system`; when `systemPath` is present it is a secondary location. Other scopes and non-POM files are excluded. | None | Bug; Critical |
| `S3421` | In `pom.xml`, reports deprecated `${pom.*}` property references in text and directs use of the corresponding `${project.*}` form. Non-POM files are excluded. | None | Code smell; Minor |
| `S3374` | In a Struts `form-validation` document, reports a later form that duplicates a form name within the applicable form-set scope and links the original. | None | Vulnerability; Blocker |
| `S3423` | In `pom.xml`, reports a project whose present top-level elements violate the standard order from `modelVersion`, `parent`, coordinates and descriptive metadata through modules, SCM/management, properties, dependencies/repositories, build/reporting and profiles. The project start is primary and misplaced elements are secondary. | None | Code smell; Minor |
| `S3438` | Reports a Spring bean whose class is exactly `org.springframework.jms.connection.SingleConnectionFactory` unless reconnection is recognized as exact text `true` in either a bean attribute whose name ends with `p:reconnectOnException`, or a direct `property` named `reconnectOnException` whose value is supplied by an attribute name ending in `value` or a nested `value` element. Constructor arguments and other forms are not inspected. Location is the bean. | None | Bug; Major |
| `S3373` | In a Struts configuration, reports an action with more direct `forward` mappings than the threshold; the action is the location. | `threshold` = `4` | Code smell; Minor |
| `S5332` | In `AndroidManifest.xml`, reports an application explicitly allowing cleartext traffic. It also reports omission of `usesCleartextTraffic` when `sonar.android.minsdkversion.min` is below 28, defaulting absent configuration to 27. | None; external key `sonar.android.minsdkversion.min` default `27` for this rule | Vulnerability; Minor |
| `S6359` | In `AndroidManifest.xml`, reports custom permission names beginning with reserved `android.permission`; standard uses of platform permissions are not custom definitions. Location is the name attribute. | None | Vulnerability; Minor |
| `S6358` | In `AndroidManifest.xml`, reports an application whose backup remains enabled without a backup agent and, for modern SDK handling, without a resource-based full-backup policy. Explicit `allowBackup=false` is excluded. When configured minimum SDK is below 23, the full-backup policy does not satisfy the rule. | None; consumes `sonar.android.minsdkversion.min` | Vulnerability; Major |
| `S7207` | In `AndroidManifest.xml`, reports an `activity`, `activity-alias`, `provider`, `receiver`, or `service` that contains an `intent-filter` but has no `android:exported` attribute. Location is the component name; any present attribute value satisfies this rule's presence requirement. | None | Vulnerability; Major |
| `S5594` | In `AndroidManifest.xml`, targets only `provider`, `activity`, `activity-alias`, and `service`, never `receiver`. It reports the component name when the component is not explicitly `exported=false`; it is explicitly `exported=true` with no intent filter, or has an `intent-filter/action`; it has neither a component `permission` nor both `readPermission` and `writePermission`; and no action name is `android.intent.action.MAIN`, `android.intent.action.SEND`, `android.intent.action.SENDTO`, or `android.intent.action.SEND_MULTIPLE`. | None | Vulnerability; Major |
| `S5604` | In `AndroidManifest.xml`, reports the `android:name` of each `uses-permission` whose case-sensitive value is in this exact non-configurable set: `android.permission.ACCEPT_HANDOVER`, `android.permission.ACCESS_BACKGROUND_LOCATION`, `android.permission.ACCESS_COARSE_LOCATION`, `android.permission.ACCESS_FINE_LOCATION`, `android.permission.ACCESS_MEDIA_LOCATION`, `android.permission.ACTIVITY_RECOGNITION`, `com.android.voicemail.permission.ADD_VOICEMAIL`, `android.permission.ANSWER_PHONE_CALLS`, `android.permission.BODY_SENSORS`, `android.permission.CALL_PHONE`, `android.permission.CAMERA`, `android.permission.GET_ACCOUNTS`, `android.permission.PROCESS_OUTGOING_CALLS`, `android.permission.READ_CALENDAR`, `android.permission.READ_CALL_LOG`, `android.permission.READ_CONTACTS`, `android.permission.READ_EXTERNAL_STORAGE`, `android.permission.READ_PHONE_NUMBERS`, `android.permission.READ_PHONE_STATE`, `android.permission.READ_SMS`, `android.permission.RECEIVE_MMS`, `android.permission.RECEIVE_SMS`, `android.permission.RECEIVE_WAP_PUSH`, `android.permission.RECORD_AUDIO`, `android.permission.SEND_SMS`, `android.permission.USE_SIP`, `android.permission.WRITE_CALENDAR`, `android.permission.WRITE_CALL_LOG`, `android.permission.WRITE_CONTACTS`, `android.permission.WRITE_EXTERNAL_STORAGE`, `android.permission.ACCESS_CHECKIN_PROPERTIES`, `android.permission.ACCOUNT_MANAGER`, `android.permission.BIND_APPWIDGET`, `android.permission.BLUETOOTH_PRIVILEGED`, `android.permission.BROADCAST_PACKAGE_REMOVED`, `android.permission.BROADCAST_SMS`, `android.permission.BROADCAST_WAP_PUSH`, `android.permission.CALL_PRIVILEGED`, `android.permission.CAPTURE_AUDIO_OUTPUT`, `android.permission.CHANGE_COMPONENT_ENABLED_STATE`, `android.permission.CONTROL_LOCATION_UPDATES`, `android.permission.DELETE_PACKAGES`, `android.permission.DIAGNOSTIC`, `android.permission.DUMP`, `android.permission.FACTORY_TEST`, `android.permission.INSTALL_LOCATION_PROVIDER`, `android.permission.INSTALL_PACKAGES`, `android.permission.LOCATION_HARDWARE`, `android.permission.MASTER_CLEAR`, `android.permission.MODIFY_PHONE_STATE`, `android.permission.MOUNT_FORMAT_FILESYSTEMS`, `android.permission.MOUNT_UNMOUNT_FILESYSTEMS`, `android.permission.READ_INPUT_STATE`, `android.permission.REBOOT`, `android.permission.SEND_RESPOND_VIA_MESSAGE`, `android.permission.SET_ALWAYS_FINISH`, `android.permission.SET_ANIMATION_SCALE`, `android.permission.SET_DEBUG_APP`, `android.permission.SET_PROCESS_LIMIT`, `android.permission.SET_TIME`, `android.permission.SET_TIME_ZONE`, `android.permission.SIGNAL_PERSISTENT_PROCESSES`, `android.permission.STATUS_BAR`, `android.permission.UPDATE_DEVICE_STATS`, `android.permission.WRITE_APN_SETTINGS`, `android.permission.WRITE_GSERVICES`, `android.permission.WRITE_SECURE_SETTINGS`. Any `uses-permission` carrying exact `tools:node="removeAll"` suppresses the entire rule scan; exact `tools:node="remove"` suppresses only that entry. | None | Vulnerability; Major |
| `S6361` | In `AndroidManifest.xml`, reports a provider using the same single permission for read and write rather than distinct `readPermission` and `writePermission`; both related values may be linked. | None | Vulnerability; Major |
| `S5322` | In `AndroidManifest.xml`, reports a `receiver` with no `android:permission` when it is not explicitly `exported=false` and either is explicitly `exported=true` or contains an `intent-filter`. A receiver with `exported=false` is excluded even when it has a filter. Location is the receiver name. | None | Vulnerability; Critical |
| `S1778` | Reports non-whitespace characters before an XML prolog; documents without a prolog are excluded. Location covers the leading characters. | None | Bug; Critical |
| `S5122` | In case-insensitive `web.xml`, reports a Tomcat CORS filter whose `cors.allowed.origins` value contains `*` as a complete comma-separated entry. Narrow origin lists and .NET configuration are excluded. | None | Vulnerability; Major |
| `S3822` | Reports a Hibernate `hibernate.hbm2ddl.auto` property set to schema-changing modes such as create, create-drop or update; `validate` and absence are accepted. | None | Bug; Critical |
| `S3281` | Reports a default EJB interceptor declaration found outside a basename equal case-insensitively to `ejb-jar.xml`; declarations already in `ejb-jar.xml` are excluded. | None | Vulnerability; Blocker |
| `S3439` | Reports a Spring bean whose class is exactly `org.springframework.jms.listener.DefaultMessageListenerContainer` only when `acceptMessagesWhileStopping` is not recognized as exact `true` and `sessionTransacted` is also not recognized as exact `true`. Each value may be supplied by a bean attribute whose name ends with the property name, or by a direct matching `property` with an attribute name ending in `value` or a nested `value` element; all accepted values are exact lowercase `true`. Location is the bean. | None | Bug; Major |
| `S4507` | Reports `android:debuggable=true` in `AndroidManifest.xml`, and `customErrors mode=Off` in case-insensitive .NET `web.config` or `machine.config`. Other XML files are excluded. | None | Vulnerability; Minor |
| `S3419` | On `pom.xml`, reports the sole project `groupId` when its full text fails the configured regular expression. Missing or multiple project-level IDs are not reported. | `regex` = <code>(com&#124;org)(\.[a-z][a-z-0-9]*)+</code> | Code smell; Minor |
| `S105` | Reports all tab characters as one issue. It retains the first 21 contiguous tab ranges: the first is primary and up to 20 are secondary. After that range cap, it counts individual tab characters, not ranges, and appends the overflow count to the final secondary message. | None | Code smell; Minor |
| `S2068` | Reports nonempty literal credential values where element/attribute names match configured credential words, plus recognized product/config special cases. Placeholder forms beginning with `${`, `#{` or `{{` are excluded; .NET wrapped placeholder values are also excluded. `android:password` declaration metadata is excluded. | `credentialWords` = `password,passwd,pwd,passphrase` | Vulnerability; Major |
| `S3282` | Reports EJB XML exclusions of default or class interceptors on non-default bindings because those exclusions should be annotations. Location is the exclusion element. | None | Code smell; Blocker |
| `S2260` | On a non-tolerated parse failure, reports a file-level issue containing the parser message. It runs only through the sensor failure path and only when active. Lowercase `.config` parse failures are excluded. | None | Code smell; Major |
| `S2321` | Reports adjacent element markup that should begin on a separate line according to the XML formatting rule. Text-only inline content and structurally separate lines are excluded. | None | Code smell; Major |
| `S1120` | Reports element start or closing tags whose leading indentation differs from nesting depth multiplied by `indentSize`. Tabs contribute `tabSize` spaces. Location is the element delimiter range. | `indentSize` = `2`; `tabSize` = `2` | Code smell; Minor |
| `XPathCheck` | Evaluates a configured XPath against files matching the optional Ant-style pattern. Node-set results report each selected node; when node-set evaluation is unsuitable, a Boolean `true` result creates a file-level issue. Evaluation failure yields no issue and is debug-logged. | `expression` and `filePattern` have no declared defaults; `message` = `The XPath expression matches this piece of code` | Code smell; Major |
| `S103` | Reports every physical line longer than the configured character limit. Location is the overflowing line range. | `maximumLineLength` = `120` | Code smell; Major |
| `S1135` | Reports the first standalone, case-insensitive `TODO` marker in each XML comment. Letter-embedded occurrences are excluded. | None | Code smell; Info |
| `S3330` | In namespaced Java `web.xml`, reports a session cookie configuration with missing or non-`true` `http-only`. In .NET Framework `web.config`/`machine.config`, reports a recognized `system.web` application with missing global `httpCookies` or `httpOnlyCookies` not set to `true`; ASP.NET Core-only configuration is excluded. | None | Vulnerability; Minor |
| `S2647` | In namespaced Java `web.xml`, reports `BASIC` authentication when no recognized `CONFIDENTIAL` transport guarantee is present. A confidential transport guarantee suppresses the finding; .NET config is not checked by this rule. | None | Vulnerability; Critical |
| `S1134` | Reports the first standalone, case-insensitive `FIXME` marker in each XML comment. Letter-embedded occurrences are excluded. | None | Code smell; Major |
| `S3355` | In `web.xml`, reports each filter declaration whose filter name has no matching filter-mapping entry. Location is the filter name. | None | Vulnerability; Critical |
| `S3417` | In `pom.xml`, reports dependencies matching the configured group/artifact pattern and optional version pattern or range. A version consisting solely of one POM property reference is resolved from top-level properties. Empty/invalid matching configuration produces no finding; invalid configuration is logged. | `dependencyName` = empty; `version` = empty | Code smell; Major |
| `S125` | Groups consecutive XML comments and reports the first group whose combined content is parseable as XML, indicating commented-out markup. Ordinary prose comments are excluded. Location spans the group. | None | Code smell; Major |
| `S5734` | In .NET `web.config`/`machine.config`, reports absence of a custom `X-Content-Type-Options` header whose value is `nosniff`, attaching to the deepest existing configuration node. Java `web.xml` is excluded. | None | Vulnerability; Minor |
| `S5344` | In case-insensitive .NET `web.config` or `machine.config`, reports a `credentials` element whose `passwordFormat` is `Clear`. Other formats and other filenames are excluded. Location is the format attribute. | None | Vulnerability; Critical |

## 9. Failure, partial results, and recovery

Parse/measure/highlighting failures follow section 6.1 and are isolated to a file. Because measures and highlighting precede rules, a later rule failure does not erase those outputs. Rule exceptions are isolated per active rule and do not prevent other rules on the same file. [X6]

A `.config` file that is not well-formed XML is intentionally silent; a well-formed `.config` file is fully analyzed. The exemption is not applied to `.xml`, `.xsd`, `.xsl`, uppercase `.CONFIG`, or arbitrary read/runtime failures. [X6][X8]

Cancellation stops before the next file and cancels progress. There is no durable checkpoint, retry queue or rollback transaction. A later scan starts from current source and active configuration.

## 10. Security and trust boundaries

XML source, rule parameters and Android SDK configuration are untrusted project inputs. The analyzer builds in-memory documents and evaluates analyzer-defined or operator-configured XPath; it never executes application code, XSLT or referenced schemas. Invalid regular expressions, match patterns and XPath must not yield invented issues. Rule isolation logs failures and preserves other rules. [X6][X15]

Source paths and charsets come from scanner indexing. The analyzer reads one file at a time but retains its DOM during file analysis. No public file-size, depth or node-count limit is declared; practical limits follow scanner memory and parser safeguards. Output crosses into persistence only through platform APIs.

## 11. Compatibility and limits

A conforming implementation preserves `xml`, repository/key pairs, suffix defaults and empty-list fallback, `.cls-meta.xml` exclusion, lowercase `.config` parse tolerance, exact .NET basename checks, rule parameters and defaults, legacy rule mappings, metric keys and issue locations. [X5][X6][X8][X17]

This is well-formedness and rule analysis, not schema validation. Configuration-specific rules activate by exact filename or recognizable XML structure as listed; they do not infer build systems or frameworks from project dependencies. The absence of CPD, symbols, coverage, test and external-report outputs is part of the contract.

## 12. Acceptance scenarios

1. **Default recognition.** With no override, main files ending `.xml`, `.xsd`, `.xsl`, or `.config` are published for XML classification. A test file is not analyzed.
2. **Blank override.** If `sonar.xml.file.suffixes` contains only blanks, recognition falls back to `.xml` only.
3. **Metadata exclusion.** A main XML-classified path ending `.cls-meta.xml` produces no parser work, issue, analysis error, measure or highlighting.
4. **Valid XML output.** A valid owned XML file outside SonarLint emits `ncloc`, `comment_lines`, line NCLOC and syntax highlighting, then all active rules run. It emits no CPD tokens.
5. **Ordinary parse error.** A malformed `.xml` file creates an analysis error and, when `S2260` is active, one file-level parsing issue; later files continue.
6. **Configuration tolerance.** A malformed lowercase `.config` file is silently skipped. The same malformed content in `.xml` or uppercase `.CONFIG` follows ordinary parse-error behavior.
7. **Rule isolation.** An invalid configured XPath causes that rule to fail/log for the file without stopping other active rules or deleting already produced measures/highlighting.
8. **Android minimum SDK.** An Android manifest without `usesCleartextTraffic` is reported by `S5332` when minimum SDK resolves below 28 and is not reported for that omission when it resolves to 28 or newer; explicit `true` remains reportable.
9. **Foreign report absence.** Coverage, test and external-issue report settings create no XML-analyzer observations because no importer exists.
10. **SonarLint mode.** A valid file still receives active XML rule analysis in SonarLint, but this analyzer does not emit measures or highlighting there.

## 13. Provenance index

- **[X1]** `manifest/component-inventory.md`, XML row; `manifest/release-baseline.md`.
- **[X2]** `manifest/license-map.md`, `SonarSource/sonar-xml` row.
- **[X3]** `sonar-xml` tag `2.18.0.7959`, commit `793fbcea0c1e65caa6afe5b3a4b5dd04c0c4d945`: `LICENSE.txt`, root `pom.xml`.
- **[X4]** Same revision: root `pom.xml`; `sonar-xml-plugin/pom.xml`.
- **[X5]** Same revision: `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/XmlPlugin.java`; `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/Xml.java`; `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/XmlRulesDefinition.java`.
- **[X6]** Same revision: `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/XmlSensor.java`.
- **[X7]** Same revision: `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/checks/CheckList.java`.
- **[X8]** Same revision: `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/Xml.java`.
- **[X9]** Same revision: `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/checks/security/android/AndroidApplicationBackupCheck.java`; `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/checks/security/android/AndroidClearTextCheck.java`.
- **[X10]** Same revision: usages of `org.sonarsource.analyzer.commons.xml.XmlFile` and `XPathBuilder` throughout `sonar-xml-plugin/src/main/java/`; pinned dependency in root `pom.xml`.
- **[X11]** Same revision: `sonar-xml-plugin/src/test/resources/checks/xPathFailure.xml`; `sonar-xml-plugin/src/test/java/org/sonar/plugins/xml/checks/XPathCheckTest.java`; remote-doctype rule fixtures under `sonar-xml-plugin/src/test/resources/checks/`.
- **[X12]** Same revision: `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/checks/ParsingErrorCheck.java`.
- **[X13]** Same revision: `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/LineCounter.java`.
- **[X14]** Same revision: `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/XmlHighlighting.java`.
- **[X15]** Same revision: all registered rule classes under `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/checks/`.
- **[X16]** Same revision: `sonar-xml-plugin/src/main/resources/org/sonar/l10n/xml/rules/xml/Sonar_way_profile.json`; `sonar-xml-plugin/src/main/java/org/sonar/plugins/xml/XmlSonarWayProfile.java`.
- **[X17]** Same revision: `DeprecatedRuleKey` annotations on the cataloged classes.
- **[X18]** Same revision: matching metadata under `sonar-xml-plugin/src/main/resources/org/sonar/l10n/xml/rules/xml/`.
