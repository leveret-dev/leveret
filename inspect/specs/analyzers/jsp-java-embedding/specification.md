# Community-Inactive JSP-to-Java Adapter Specification

## 1. Identity, release pin, and license

This specification covers the JSP embedding content packaged inside Java analyzer `org.sonarsource.java:sonar-java-plugin:8.37.0.45887`, repository `https://github.com/SonarSource/sonar-java`, tag `8.37.0.45887`, commit `53f70bdf0f34a64bfe97b71f1bfee07e6d14baa6`. Relevant source modules are `java-jsp`, Java plugin registration, and generated-file interfaces in `java-frontend`. Analyzer-owned source is licensed under `LicenseRef-SSAL-1.0`; this is a full clean-room specification rather than a copy marker. [Source: `manifest/component-inventory.md`; `manifest/license-map.md`; root `pom.xml`; `java-jsp/pom.xml`; `LICENSE.txt`.]

The content has no independent Community distribution artifact, plugin key, rule repository, metric repository, quality profile, configuration namespace, or version. It is inseparable packaged content of the pinned Java plugin. [Source: `manifest/component-inventory.md`; `sonar-java-plugin/pom.xml`; `java-jsp/pom.xml`.]

The packaged source uses public language identifier `jsp`, while its dormant generated-file type identifies generated content as `java`. These identifiers establish dependency boundaries only; they do not activate Community analysis. [Source: `java-jsp/src/main/java/org/sonar/java/jsp/Jasper.java`; `java-frontend/src/main/java/org/sonar/java/model/GeneratedFile.java`.]

## 2. Community Build purpose and observable contract

For SonarQube Community Build `26.8.0.126808`, this part is an explicitly inactive adapter. Its complete observable contract is negative: Community plugin registration must not install the JSP transpilation extension, and Java sensor execution must receive no adapter instance or adapter-produced files. [Source: `sonar-java-plugin/src/main/java/org/sonar/plugins/java/JavaPlugin.java`; `JavaSensor.java`.]

The Java plugin registration predicate requires product SonarQube and an edition other than Community before adding `Jasper`. A Community runtime fails that predicate. Presence of adapter classes or packaged dependencies in the Java artifact must not be interpreted as an enabled Community capability. [Source: `JavaPlugin.supportJspTranspilation`; `java-jsp/pom.xml`.]

The Java sensor descriptor declares interest in language keys `java` and `jsp`, but descriptor interest is not activation. With no registered `Jasper` extension, the sensor's generated-file collection is empty. Indexed JSP files therefore do not enter Java frontend parsing through this adapter. [Source: `sonar-java-plugin/src/main/java/org/sonar/plugins/java/JavaSensor.java`.]

## 3. Scope and exclusions

This specification includes only:

- exact packaged identity and license;
- the Community-edition registration gate;
- the absence of a Community adapter instance;
- zero Community outputs and side effects;
- dependency and ownership boundaries;
- negative acceptance conditions proving inactivity.

[Source: `manifest/component-inventory.md`; `manifest/dependency-map.md`; `JavaPlugin.java`; `JavaSensor.java`.]

Translation behavior, generated-source behavior, source-map behavior, classloader behavior, configuration precedence inside an active adapter, and lifecycle or failure behavior in any non-Community edition are outside scope. No commercial behavior may be inferred from dormant source. [Source: `manifest/component-inventory.md`, explicit commercial exclusions and adapter classification.]

JSP/HTML recognition, source analysis, rules, metrics, highlighting, and CPD are owned by `analyzers/html/`. Java parsing, bytecode/classpath semantics, ordinary Java rules, metrics, reports, symbols, and highlighting are owned by `analyzers/java/`. Java symbolic execution is owned by `analyzers/java-symbolic-execution/`. Generic issue persistence and result lifecycle remain platform contracts. [Source: `manifest/component-inventory.md`; `manifest/dependency-map.md`.]

JaCoCo import is owned solely by `integrations/jacoco/`. This inactive adapter imports no coverage and defines no JSP-to-Java coverage projection. [Source: `manifest/dependency-map.md`.]

## 4. Dependencies and owned boundary

The packaged module references Java frontend APIs, Sonar plugin/scanner APIs, and Tomcat Jasper `9.0.120`, but Community registration does not expose those dependencies as an executing adapter service. An independent Community-compatible implementation may package equivalent dormant content or omit unreachable internals, provided the observable registration and zero-output contract remains exact. [Source: `java-jsp/pom.xml`; `sonar-java-plugin/src/main/java/org/sonar/plugins/java/JavaPlugin.java`.]

The plugin and extension runtime owns product/edition identity and extension registration. The Java sensor owns its optional adapter dependency and must treat absence as an empty generated-file source. The HTML analyzer owns whether files are indexed with language key `jsp`; such indexing must not bypass the Java plugin's Community gate. [Source: `manifest/dependency-map.md`; `JavaPlugin.java`; `JavaSensor.java`.]

The symbolic-execution plugin declares required languages `java,jsp`, but that packaging metadata neither registers this adapter nor supplies generated JSP Java. Community symbolic execution remains limited by its own main-Java input boundary. [Source: symbolic-execution `java-symbolic-execution/java-symbolic-execution-plugin/pom.xml`; `analyzers/java-symbolic-execution/specification.md`; Java `JavaPlugin.java`.]

## 5. Inputs, configuration, and precedence

This Community part accepts no analysis input. Indexed JSP files, web roots, tag libraries, Java classpaths, and scanner work paths are not consumed by the adapter because no adapter extension exists. [Source: `JavaPlugin.java`; `JavaSensor.runJasper`.]

It defines no Community setting. Neither `sonar.exclusions` nor any Java, JSP, scanner, cache, or internal property may enable the adapter in Community Build. Product/edition registration is evaluated before sensor dependency injection and has unconditional precedence over analysis settings. [Source: `JavaPlugin.define`; `JavaPlugin.supportJspTranspilation`.]

The only relevant state transition is plugin registration:

1. Runtime product and edition are inspected.
2. Community edition fails the adapter predicate.
3. `Jasper` is absent from registered extensions.
4. Java sensor construction uses its no-adapter path.
5. Sensor execution supplies an empty generated-file collection to the Java frontend.

[Source: `JavaPlugin.java`; `JavaSensor` constructors and `runJasper`.]

No adapter-specific concurrency, persistence, cache, work-directory, or recovery state exists in Community execution. [Source: absence of `Jasper` registration in `JavaPlugin.java`; empty result in `JavaSensor.runJasper`.]

## 6. Externally visible capabilities and outputs

Community Build must expose all of the following zero capabilities for this part:

- zero JSP-to-Java translations;
- zero generated Java files;
- zero JSP source maps;
- zero adapter-produced issues or security findings;
- zero adapter-owned rules, profiles, parameters, metrics, highlighting, symbols, CPD tokens, test reports, external reports, or coverage observations;
- zero adapter-specific scanner-work output;
- zero adapter-specific warnings or failures during ordinary Community analysis.

[Source: `JavaPlugin.java`; `JavaSensor.java`; `manifest/component-inventory.md`; `manifest/dependency-map.md`.]

No native Java check in the pinned Community Java analyzer implements the experimental `JspCodeVisitor` marker. Even if such a marker type remains packaged, Community supplies no generated input on which it could operate. [Source: pinned `java-checks`, `java-checks-common`, and `java-checks-aws` trees; `java-frontend/src/main/java/org/sonar/plugins/java/api/JspCodeVisitor.java`; `JavaPlugin.java`.]

## 7. Failure, partial-result, and recovery behavior

Because Community Build does not instantiate or invoke the adapter, adapter translation failures, partial translation results, generated-source errors, and source-map errors are unreachable and are not Community contracts. [Source: `JavaPlugin.supportJspTranspilation`; `JavaSensor.runJasper`.]

Ordinary Java or HTML analyzer failures remain owned by their specifications. A Community analysis must not emit an adapter failure message. If a purported Community runtime contains a registered `Jasper` extension or adapter-produced output, that runtime violates this specification rather than entering a supported recovery state. [Source: `JavaPlugin.java`; ownership map in `manifest/dependency-map.md`.]

## 8. Security and trust boundary

The Community registration gate is a security and product boundary. JSP content must not be passed to dormant transpilation code, and adapter classes must not load JSP resources, tag libraries, project dependencies, or generated source during Community analysis. [Source: `JavaPlugin.java`; `JavaSensor.java`.]

No hidden fallback, reflective activation, configuration override, or symbolic-execution packaging declaration may weaken this boundary. The specification makes no claim about behavior outside Community Build. [Source: `manifest/component-inventory.md`; `JavaPlugin.java`; symbolic plugin POM.]

## 9. Compatibility and limits

- Product baseline is exactly SonarQube Community Build `26.8.0.126808` with Java plugin `8.37.0.45887`. [Source: `manifest/release-baseline.md`; `manifest/component-inventory.md`.]
- Community inactivity is edition-sensitive and mandatory; class presence is not capability presence. [Source: `JavaPlugin.supportJspTranspilation`.]
- Language key `jsp` may still be indexed and analyzed by the HTML analyzer. It must not be converted into Java by this part. [Source: `manifest/component-inventory.md`; `JavaSensor.java`.]
- This part has no rule catalog. Complete count is zero. [Source: `manifest/component-inventory.md`; absence of adapter rule registration in `JavaPlugin.java`.]
- This part has no Community configuration, output format, persistent state, or extension point. [Source: `JavaPlugin.java`; `JavaSensor.java`.]

## 10. Community acceptance scenarios

1. **Extension registration.** Given SonarQube Community Build `26.8.0.126808`, plugin extension registration does not contain `Jasper`.
2. **Indexed JSP input.** Given one or more files indexed with language key `jsp`, Java sensor execution returns no generated files from this adapter and does not parse those files as generated Java.
3. **Descriptor boundary.** Given the Java sensor descriptor lists both `java` and `jsp`, absence of the adapter still yields zero JSP-derived Java input; descriptor language interest alone has no effect.
4. **Configuration cannot enable.** Given arbitrary project or scanner properties, including Java and exclusion settings, Community registration remains unchanged and the adapter stays absent.
5. **No side effects.** Given ordinary Community analysis with JSP files, no adapter-specific work directory, generated source, source map, warning, or failure is produced.
6. **Zero result catalog.** Given project configuration or profile enumeration, this part contributes no rules, parameters, profiles, metrics, issues, highlighting, symbols, CPD, reports, or coverage.
7. **HTML ownership.** Given a JSP file that the HTML analyzer recognizes, any HTML/JSP findings or measures come from the HTML analyzer, never from generated Java produced by this part.
8. **Java isolation.** Given Java and JSP files in the same project, ordinary Java files remain eligible for Java frontend and active Java rules; JSP files add no generated Java workload.
9. **Symbolic-execution isolation.** Given the bundled symbolic-execution plugin and JSP files, its `jsp` packaging metadata does not activate translation and produces no JSP-derived symbolic finding.
10. **JaCoCo boundary.** Given JaCoCo XML, this part imports nothing; only the separately owned JaCoCo integration may produce coverage observations.
11. **Packaging is not activation.** Given inspection confirms `java-jsp` classes and Jasper dependency inside the pinned source/package, Community observable behavior remains zero.
12. **Conformance violation.** Given a runtime claiming to be this Community baseline but registering `Jasper` or producing adapter output, the expected result is a failed compatibility check against this specification, not acceptance as optional behavior.

## 11. Provenance index

- Release and artifact identity: `manifest/release-baseline.md`; `manifest/component-inventory.md`; root `pom.xml`; `sonar-java-plugin/pom.xml`; `java-jsp/pom.xml`.
- License: `manifest/license-map.md`; root `LICENSE.txt`.
- Community registration gate: `sonar-java-plugin/src/main/java/org/sonar/plugins/java/JavaPlugin.java`, especially `define` and `supportJspTranspilation`.
- Empty Community handoff: `sonar-java-plugin/src/main/java/org/sonar/plugins/java/JavaSensor.java`, constructors and `runJasper`.
- Packaged identifiers only: `java-jsp/src/main/java/org/sonar/java/jsp/Jasper.java`; `java-frontend/src/main/java/org/sonar/java/model/GeneratedFile.java`; `java-frontend/src/main/java/org/sonar/plugins/java/api/JspCodeVisitor.java`.
- Ownership and non-ownership: `manifest/dependency-map.md`; `manifest/component-inventory.md`.
