# Java Symbolic Execution Analyzer Specification

## 1. Identity, release pin, and license

This specification covers bundled artifact `org.sonarsource.java:sonar-java-symbolic-execution-plugin:8.16.4.1912`, source repository `https://github.com/SonarSource/sonar-java-symbolic-execution`, tag `8.16.4.1912`, commit `8d1b73d26c83a998d7af4e4a8f10587654f2e12c`. Analyzer-owned source is `LicenseRef-SSAL-1.0`, so this is a full clean-room specification. [Source: `manifest/component-inventory.md`; `manifest/license-map.md`; root `pom.xml`; `java-symbolic-execution/java-symbolic-execution-plugin/pom.xml`; `LICENSE.txt`.]

The plugin artifact name is `sonar-java-symbolic-execution-plugin`. It creates no independent language or rule repository: all 23 rules are added to existing repository key `java`. Packaging requires Java plugin version at least `8.15.0.39343`, declares required languages `java,jsp`, and declares minimum plugin API `9.14.0.375`; the bundled Java analyzer `8.37.0.45887` satisfies that dependency. [Source: `java-symbolic-execution/java-symbolic-execution-plugin/pom.xml`; `manifest/component-inventory.md`.]

## 2. Purpose, scope, and exclusions

The plugin adds path-sensitive, method-local Java analysis. It consumes the Java frontend's syntax tree, semantic model, and complete control-flow graph; explores feasible symbolic states; models selected library/method behavior; and reports active rule violations with path flows. [Source: `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/SymbolicExecutionVisitor.java`; `ExplodedGraphWalker.java`; `ProgramState.java`.]

The following are outside this part:

- Java parsing, classpaths, bytecode/type resolution, syntax/semantic APIs, ordinary Java rules, measures, highlighting, symbols, test/external reports, and caching are owned by `analyzers/java/specification.md`. [Source: `manifest/dependency-map.md`; symbolic plugin POM dependency and registrar API.]
- JSP translation is owned by `analyzers/jsp-java-embedding/specification.md` and is inactive in Community Build. The symbolic plugin's packaging language declaration does not activate JSP generation or give these checks JSP input. [Source: Java `JavaPlugin.supportJspTranspilation`; symbolic plugin POM.]
- JaCoCo coverage is owned by `integrations/jacoco/`; symbolic execution emits no coverage observations. [Source: `manifest/dependency-map.md`.]
- Commercial Java security/dataflow plugins and their repositories are not part of this engine or catalog. [Source: `manifest/component-inventory.md`; `manifest/dependency-map.md`.]

## 3. Dependencies and activation boundaries

`JavaSEPlugin` registers only a profile registrar and a check registrar. The check registrar extends the Java repository metadata, creates active `SECheck` instances through the Java check factory, and installs one shared `SymbolicExecutionVisitor` when at least one of their rule keys is active. Each active check also receives a later file callback that flushes issues accumulated by the shared walk. [Source: `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/plugin/JavaSEPlugin.java`; `JavaSECheckRegistrar.java`; Java analyzer `SonarComponents.registerMainSharedCheck` and `registerMainChecks`; symbolic `SECheck.java`.]

All registration is **main-source only**: the registrar calls `registerMainSharedCheck` and `registerMainChecks`, never the test equivalents. Therefore the pinned engine does not symbolically execute files classified as test input, even when a rule's legacy metadata scope is `All`. The catalog preserves metadata scope for compatibility but runtime registration remains authoritative. [Source: `JavaSECheckRegistrar.java`.]

The engine runs only when Java parsing produces a method body with a control-flow graph whose semantic information is complete. Methods without bodies and methods with incomplete semantic CFGs are skipped without inventing states. [Source: `ExplodedGraphWalker.visitMethod` and `execute`.]

Rule activation follows the platform's active Java profile. The plugin contributes 21 rules to both built-in profiles `Sonar way` and `Sonar agentic AI`. `S3546` is a template and `S6374` is deprecated; neither is in those built-in sets. The Java analyzer merges registrar contributions into matching profile names. [Source: `plugin/RulesList.java`; `JavaSEProfileRegistrar.java`; resources `Sonar_way_profile.json` and `Sonar_agentic_AI_profile.json`; Java analyzer `BuiltInJavaQualityProfile.java`.]

## 4. Inputs and outputs

### 4.1 Accepted inputs

The engine accepts active main-file Java checks, a parsed compilation unit, method declarations, complete Java control-flow graphs, semantic symbols/types/nullability metadata, configured rule parameters, and selected dependency behavior models. It has no source suffix or classpath setting of its own and inherits `sonar.java.source`, Java semantics, and main/test classification from the Java analyzer. [Source: `JavaSECheckRegistrar.java`; `SymbolicExecutionVisitor.java`; `ExplodedGraphWalker.java`; `checks/SECheck.java`.]

Bundled cross-procedure models cover selected signatures from `java.lang`, `java.util`, Guava base, Apache Commons Collections/Lang/Lang3, Log4j core utilities, Eclipse runtime, Spring utilities, JUnit 4, and JUnit Jupiter. Models are trusted plugin resources, not inferred from executing dependencies. [Source: `se/xproc/BehaviorCache.java`; resources under `src/main/resources/org/sonar/java/se/xproc/`.]

### 4.2 Emitted outputs

The only analysis outputs are native issues under repository `java`, with primary syntax locations and optional ordered flows/secondary locations. Findings at the same syntax tree within one check are deduplicated and their flows merged. When both exceptional and non-exceptional flows exist, issue publication keeps non-exceptional flows; exceptional flows are used only when no normal flow exists. [Source: `checks/SECheck.java`; `Flow.java`; Java frontend issue reporting contract.]

This plugin owns no metrics, highlighting, symbols, CPD tokens, source indexing, test reports, external reports, cache entries, or coverage import. It relies on Java frontend outputs and platform issue persistence. [Source: plugin source tree and extension list; `manifest/dependency-map.md`.]

## 5. Symbolic state and processing model

### 5.1 Per-file and per-method lifecycle

At the start of each file, source-derived behavior summaries are cleared and the current Java file context is installed. Methods are visited from the Java syntax tree. A fresh exploded-graph walker is created per method, while all active rule-check instances participate in that walk. [Source: `SymbolicExecutionVisitor.scanFile`, `visitMethod`, and `getWalker`; `BehaviorCache.cleanup`.]

For a method that cannot be overridden—non-native and concrete, with a private, final, or static declaration or a final owner—the engine may compute and cache a method behavior summary and recursively analyze its source declaration when a caller needs it. Overridable or native methods do not receive such source-derived certainty. If no source summary exists, bundled hardcoded behavior models may supply yields for recognized signatures. [Source: `SymbolicExecutionVisitor.methodCanNotBeOverridden`; `BehaviorCache.get`; `MethodBehavior.java`.]

At file end, each active `SECheck` publishes and clears its accumulated issues. Source-derived behavior summaries are file scoped; hardcoded model resources are loaded lazily once and remain immutable. No symbolic state persists to a later scanner analysis. [Source: `SECheck.scanFile`; `BehaviorCache`.]

### 5.2 Starting states and path exploration

Each method starts with symbolic values for parameters. Primitive parameters get one initial state. Parameters considered nullable—and the argument of an `equals` method—split into null and non-null starting states. Parameters with effective non-null metadata get a non-null constraint. Record compact-constructor components are treated as parameters. [Source: `ExplodedGraphWalker.startingStates`; `methodOrRecordConstructorParameters`.]

The engine builds live-variable information, then explores a LIFO worklist over control-flow program points. A program state contains symbol/value bindings, operand stack, relations, constraints, visit counts, return/exception values, and reference information. Supported domains include boolean/nullness, numeric zero/range relations, open resources, locks, streams, and XML configuration states contributed by checks. Dead symbols and disposable constraints are removed after block exits while behavior-summary parameters and resource-like constraints are retained. [Source: `ExplodedGraphWalker.java`; `ProgramState.java`; `constraint/`; `symbolicvalues/`; rule check sources.]

Before and after relevant statements, the dispatcher invokes active check callbacks; completed normal and exceptional paths invoke end-of-path callbacks; completed methods invoke end-of-execution callbacks. Method yields carry constraints and exceptional outcomes to modeled callers. [Source: `CheckerDispatcher.java`; `CheckerContext.java`; `ExplodedGraphWalker.execute`; `se/xproc/MethodYield.java`.]

Equivalent graph nodes reuse the same program-point/state node and collect additional parents rather than being explored as unrelated states. Flow computation traces parent nodes, relations, and constraint origins to produce secondary locations. [Source: `ExplodedGraph.java`; `ExplodedGraphWalker.enqueue`; `FlowComputation.java`.]

### 5.3 Hard limits and partial completion

| Limit | Pinned value and effect |
|---|---|
| Maximum method steps | 16,000; exceeding it interrupts that method's symbolic execution. |
| Maximum branched boolean states | 10,000; exceeding it interrupts that method. |
| Maximum starting states | 1,024; more nullable-parameter combinations skip completion of that method. |
| Program-point revisits | A state can be enqueued through a point up to the built-in revisit bound; excess paths are dropped, with a special loop-exit treatment for enhanced-for restarts. |
| Constraint-size guard | After exploration pressure exceeds half the step budget, a state with more than 75 constraints interrupts the method. |

[Source: `ExplodedGraphWalker.java`, constants `MAX_STEPS`, `MAX_NESTED_BOOLEAN_STATES`, `MAX_STARTING_STATES`, `MAX_EXEC_PROGRAM_POINT`, and `checkExplodedGraphTooBig`.]

A limit exception is caught at method scope, logged at debug level, optionally traced, and does not abort file analysis. Any in-progress method behavior is marked visited so the engine does not repeatedly retry the same incomplete summary. Checks receive interrupted-execution callbacks, allowing rules that require complete exploration to discard partial conclusions. [Source: `SymbolicExecutionVisitor.execute`; `ExplodedGraphWalker.interrupted`; `CheckerDispatcher.interruptedExecution`; `InvariantReturnCheck.interruptedExecution`.]

## 6. Configuration and precedence

The engine defines no global scanner property. Java language/source/classpath settings and platform active-rule precedence apply first. If no symbolic rule is active, the shared visitor is not registered and no symbolic exploration occurs. [Source: `JavaSECheckRegistrar.java`; Java analyzer `SonarComponents.hasAtLeastOneActiveRule`.]

Only two catalog entries expose public rule configuration:

- `S2095`: `excludedResourceTypes`, default empty, accepts comma-separated fully qualified resource types ignored by the built-in resource rule. [Source: `checks/UnclosedResourcesCheck.java`.]
- Template `S3546`: `constructor`, `factoryMethod`, `openingMethod`, and `closingMethod`, each default empty. Values are fully qualified constructor or method specifications, optionally including parameter signatures. Empty opening specifications match nothing. [Source: `checks/CustomUnclosedResourcesCheck.java`; `JavaSECheckRegistrar.RULE_TEMPLATES_KEY`.]

Rule parameter parsing errors are handled by the Java frontend as bad rule configuration and abort rather than silently changing symbolic behavior. [Source: Java analyzer `VisitorsBridge.runScanner`.]

## 7. Exact 23-rule catalog

Catalog metadata contains 23 and only 23 keys. `W/A` marks membership in both bundled profiles. Metadata scope is shown verbatim; Section 3's main-only runtime boundary still applies. Detection, exclusions, and issue locations below are the clean-room observable contracts. Every row is grounded in the exact implementation path shown and same-key metadata/description files under `java-symbolic-execution/java-symbolic-execution-plugin/src/main/resources/org/sonar/l10n/java/rules/javase/`.

| Key | Metadata scope | Type / severity | Activation | Detection semantics | Primary and secondary location | Parameters/defaults | Exclusions and limits | Exact implementation provenance |
|---|---|---|---|---|---|---|---|---|
| `S2095` | All | BUG / Blocker | W/A | Reports an opened closeable resource that can reach a normal method exit without guaranteed closure. | Resource creation/opening expression. | excludedResourceTypes=empty (comma-separated fully qualified types). | Excludes try-with-resources, configured types, and subtypes of `java.io.ByteArrayOutputStream`, `java.io.ByteArrayInputStream`, `java.io.CharArrayReader`, `java.io.CharArrayWriter`, `java.io.StringReader`, `java.io.StringWriter`, `org.apache.commons.io.output.ByteArrayOutputStream`, `org.apache.commons.io.output.UnsynchronizedByteArrayOutputStream`, `com.sun.org.apache.xml.internal.security.utils.UnsyncByteArrayOutputStream`, or `org.springframework.context.ConfigurableApplicationContext`. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/UnclosedResourcesCheck.java` |
| `S2189` | Main | BUG / Blocker | W/A | Reports loops whose control-flow graph has no reachable exit or whose end condition cannot be reached. | Loop statement, or its unreachable end condition. | — | Excludes endless loops inside `Thread.run()` implementations. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/NoWayOutLoopCheck.java` |
| `S2222` | All | BUG / Critical | W/A | Reports `Lock.lock()` or successful `tryLock()` acquisitions not followed by `unlock()` on every method path. | The acquisition invocation. | — | No explicit exception; only `java.util.concurrent.locks.Lock` state modeled by recognized methods is covered. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/LocksNotUnlockedCheck.java` |
| `S2259` | Main | BUG / Major | W/A | Reports dereference, unboxing, or modeled call use of a value proven null on a feasible path. | The dereference or value-use expression, with origin flow where available. | — | Uses nullability contracts; an `equals` parameter is still considered nullable despite non-null annotation. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/NullDereferenceCheck.java` |
| `S2583` | All | BUG / Major | W/A | Reports a control-flow condition proven constant when that makes a branch unreachable. | The constant condition, with constraint flow. | — | Excludes literal boolean conditions and conditions consisting only of one final boolean symbol. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/ConditionalUnreachableCodeCheck.java` |
| `S2589` | All | CODE_SMELL / Major | W/A | Reports a boolean subexpression proven gratuitously constant within an otherwise evaluated condition. | The redundant boolean subexpression, with constraint flow. | — | No explicit documented exception. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/BooleanGratuitousExpressionsCheck.java` |
| `S2637` | Main | BUG / Minor | W/A | Reports non-null fields, parameters, arguments, or return contracts that can receive null or remain uninitialized. | Affected declaration name, assignment, call/constructor, or return expression. | — | Only recognized non-null annotation contracts and supported constructor/return flows are evaluated. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/NonNullSetToNullCheck.java` |
| `S2689` | Main | BUG / Blocker | W/A | Reports an `ObjectOutputStream` constructed over a file output stream proven to use append mode. | The output-stream argument of the `ObjectOutputStream` construction. | — | No explicit documented exception. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/ObjectOutputStreamCheck.java` |
| `S2755` | Main | VULNERABILITY / Blocker | W/A | Reports supported XML parser objects that reach parsing with external-entity protections not established on the path. | Parser initialization or insecure use, with configuration flow. | — | Field-held parser state is not reported by this path-local model; recognized secure property combinations suppress the issue. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/XxeProcessingCheck.java` |
| `S3065` | Main | BUG / Major | W/A | Reports nested `Math.min` and `Math.max` range logic whose bounds make the result invariant. | The outer min/max invocation, with bound-flow evidence. | — | Only recognized two-argument `Math.min`/`Math.max` calls with comparable tracked values are modeled. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/MinMaxRangeCheck.java` |
| `S3516` | Main | CODE_SMELL / Blocker | W/A | Reports a method with multiple reachable returns that all produce the same precise value or constraint. | Method name; every return participates as a secondary flow location. | — | Excludes constructors, `void`/`Void`, single-return methods, nested-class/lambda returns, imprecise values, and interrupted execution. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/InvariantReturnCheck.java` |
| `S3518` | All | BUG / Critical | W/A | Reports division or remainder whose denominator can be zero, including modeled `BigInteger` and `BigDecimal` operations. | Denominator expression, with value-origin flow. | — | No issue when the tracked denominator is proven nonzero; unsupported numeric behavior remains unknown. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/DivisionByZeroCheck.java` |
| `S3546` | Main | BUG / Blocker | template | Reports a configured custom resource that remains open at a normal method exit. | Configured constructor, factory, or opening invocation. | constructor=empty; factoryMethod=empty; openingMethod=empty; closingMethod=empty. | Template only; empty opening specifications match nothing, and exceptional exits are excluded. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/CustomUnclosedResourcesCheck.java` |
| `S3655` | All | BUG / Major | W/A | Reports `Optional.get()` on an instance not proven present on the current path. | Optional receiver at the unsafe access. | — | A check on a separate method-call result does not prove this instance present; recognized `isPresent`/`isEmpty` and constructors update state. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/OptionalGetBeforeIsPresentCheck.java` |
| `S3824` | All | CODE_SMELL / Major | W/A | Reports `Map.get`/null or `containsKey` tests followed by a compatible put pattern replaceable by compute methods. | The map value-test invocation, with related put flow. | — | Requires Java 8 compatibility and excludes patterns intended to insert null because `computeIfAbsent` would not do so. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/MapComputeIfAbsentOrPresentCheck.java` |
| `S3958` | All | BUG / Major | W/A | Reports a lazy intermediate stream pipeline that reaches statement completion without a terminal use or retained result. | The last unused intermediate stream operation. | — | Only recognized Java stream pipeline operations are modeled. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/StreamNotConsumedCheck.java` |
| `S3959` | All | BUG / Major | W/A | Reports a Java stream pipeline reused after a recognized terminal operation consumed it. | The reuse invocation or method reference, with the consumption flow. | — | Only recognized stream/base-stream intermediate and terminal operations are modeled. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/StreamConsumedCheck.java` |
| `S4165` | All | CODE_SMELL / Major | W/A | Reports an assignment when the target already holds the assigned symbolic value on every feasible path. | The redundant assignment, with earlier assignment flows. | — | Excludes stream self-reassignment patterns where intermediate operations return a new pipeline. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/RedundantAssignmentsCheck.java` |
| `S4449` | Main | CODE_SMELL / Major | W/A | Reports a definitely null argument passed to a parameter indirectly non-null by package/default contract. | Invoked method or constructor name; argument and declaration are secondary locations. | — | Excludes `equals` methods and Guava `Preconditions.checkNotNull`; explicit variable-level contracts are handled by other rules. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/ParameterNullnessCheck.java` |
| `S6373` | Main | VULNERABILITY / Blocker | W/A | Reports supported XML parser configuration that enables XInclude or equivalent arbitrary file inclusion. | The parser construction or enabling configuration call. | — | Only recognized JAXP, dom4j, and JDOM parser APIs and feature identifiers are modeled. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/AllowXMLInclusionCheck.java` |
| `S6374` | Main | VULNERABILITY / Major | deprecated | Reports supported XML processors configured to load external schemas or DTDs. | The parser/factory construction or enabling configuration call. | — | Deprecated in favor of `S2755`; excludes flows that install an entity resolver. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/XmlParserLoadsExternalSchemasCheck.java` |
| `S6376` | Main | VULNERABILITY / Major | W/A | Reports supported XML processors with secure-processing protection proven disabled. | The insecure parser configuration call or object use. | — | Only recognized JAXP, dom4j, and JDOM secure-processing properties are modeled. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/DenialOfServiceXMLCheck.java` |
| `S6377` | Main | VULNERABILITY / Major | W/A | Reports XML signature validation performed without proving secure-validation property true on its `DOMValidateContext`. | Signature validation call or associated validation context. | — | No issue when `org.jcp.xml.dsig.secureValidation` is proven true before validation. | `java-symbolic-execution/java-symbolic-execution-plugin/src/main/java/org/sonar/java/se/checks/XmlValidatedSignatureCheck.java` |

## 8. Failure, partial-result, and recovery behavior

- Incomplete semantic control-flow information causes that method to be skipped; other methods and ordinary Java checks continue. [Source: `ExplodedGraphWalker.execute`.]
- Exploration limits interrupt only the current method as described in Section 5.3. Rules dependent on complete execution can discard their pending method state; already sound path findings from other checks may still be flushed. [Source: `SymbolicExecutionVisitor.execute`; `CheckerDispatcher`; `SECheck.scanFile`.]
- If any bundled hardcoded model resource is missing or malformed, model loading returns an empty hardcoded model set. Missing models reduce precision but do not fabricate yields. [Source: `BehaviorCache.HardcodedMethodBehaviors`.]
- An unexpected engine exception not covered by method limits flows through the Java check runner. Default Java behavior logs that shared-check failure and continues when possible; Java fail-fast configuration can abort analysis. [Source: `SymbolicExecutionVisitor.java`; Java analyzer `VisitorsBridge.runScanner`.]
- Analysis cancellation and interruption are inherited from the Java frontend and must not be converted into ordinary rule failures. [Source: Java analyzer `VisitorsBridge`; `JavaAstScanner`.]
- Duplicate findings from the same check/tree are merged. Flow publication prefers normal paths over exceptional-only paths, limiting confusing duplicate evidence. [Source: `SECheck.java`.]

## 9. Security and trust boundaries

The engine statically interprets Java syntax, semantic bindings, control flow, and bundled method summaries. It does not execute project bytecode, invoke project methods, open XML documents, acquire locks, consume streams, or enforce runtime security settings. Security-rule results are warnings about modeled source paths, not runtime mitigation. [Source: `ExplodedGraphWalker.java`; `BehaviorCache.java`; XML check classes.]

Classpath/type integrity is inherited from the Java analyzer. Missing or ambiguous types can make a CFG incomplete or prevent a method matcher from recognizing an API; the safe outcome is fewer modeled findings, not guessed symbols. [Source: `ExplodedGraphWalker.execute`; Java analyzer semantic/classpath contract.]

Bundled hardcoded JSON behaviors are trusted plugin data. Project inputs cannot replace those classpath resources through rule configuration. Source-derived summaries are limited to non-overridable methods to avoid assuming a dynamically dispatched implementation. [Source: `BehaviorCache.java`; `SymbolicExecutionVisitor.methodCanNotBeOverridden`.]

XML security rules model only named APIs and properties. They neither parse untrusted XML nor claim that every XML implementation is covered. Deprecated `S6374` remains available but `S2755` is the current built-in-profile rule. [Source: `checks/AbstractXMLProcessing.java`; `XxeProcessingCheck.java`; `XmlParserLoadsExternalSchemasCheck.java`; rule metadata/profile resources.]

## 10. Compatibility and observable limits

- Compatible operation requires Java analyzer APIs present in Java plugin `8.15.0.39343` or later; the pinned Java plugin is `8.37.0.45887`. [Source: symbolic plugin POM; component inventory.]
- Symbolic execution consumes the Java frontend's source level and semantic model. `S3824` requires Java 8 compatibility; `S3655` recognizes Java 11 `Optional.isEmpty` when source level is at least 11. [Source: `MapComputeIfAbsentOrPresentCheck.isCompatibleWithJavaVersion`; `OptionalGetBeforeIsPresentCheck.java`.]
- Rules are main-only in this plugin registration. No test-file symbolic findings are promised. [Source: `JavaSECheckRegistrar.java`.]
- `S3546` is a rule template, not an active rule without a configured instance. `S6374` is deprecated and absent from built-in profiles. [Source: `JavaSECheckRegistrar.setTemplates`; metadata/profile resources.]
- Path exploration is intentionally bounded and intra-file summaries are cleared per file. Inter-file or arbitrary dynamic-dispatch completeness is not promised. [Source: `SymbolicExecutionVisitor`; `BehaviorCache`; `ExplodedGraphWalker`.]
- Community-inactive JSP translation means required-language metadata for `jsp` does not produce JSP symbolic findings in Community Build. [Source: symbolic plugin POM; Java `JavaPlugin.java`.]

## 11. Acceptance scenarios

1. **Dependency registration.** Given Java plugin `8.37.0.45887` and symbolic plugin `8.16.4.1912`, the existing `java` repository gains exactly the 23 keys listed in Section 7; no second repository is created.
2. **No active symbolic rule.** Given a profile with none of the 23 keys active, no shared symbolic visitor is registered and no method path exploration occurs.
3. **Main/test boundary.** Given equivalent main and test Java files with `S2259` active, only the main file is sent through this engine and can receive its symbolic null-dereference issue.
4. **Incomplete semantics.** Given a method whose CFG lacks complete semantic information, that method yields no symbolic finding while another complete method in the file remains eligible.
5. **Null path.** Given a feasible main-source path on which a value is null before dereference and `S2259` is active, an issue appears on the dereference with a null-origin flow when available.
6. **Infeasible null path.** Given every feasible path proves the value non-null before dereference, `S2259` emits no issue.
7. **Resource parameter.** Given `S2095` active and a leaked resource type listed in `excludedResourceTypes`, no `S2095` issue is emitted for that type; removing it restores normal detection.
8. **Custom template.** Given a configured `S3546` instance naming opening and closing operations, a normal exit with the resource still open reports at its opening. With all template parameters empty, it matches no resource.
9. **Profile membership.** Given fresh built-in profiles, the 21 `W/A` rules are merged into both `Sonar way` and `Sonar agentic AI`; `S3546` and `S6374` are not activated by that merge.
10. **Java-version gate.** Given source compatibility below Java 8, `S3824` does not execute. Given Java 8-compatible source and a recognized map test/put path, it reports at the value test unless the null-insertion exclusion applies.
11. **Complete-method rule interruption.** Given `S3516` and a method exceeding an exploration bound, interrupted execution emits no invariant-return conclusion for that incomplete method.
12. **Step limit isolation.** Given one method exceeds 16,000 steps and another is small, the first logs a debug interruption while the second is still analyzed; the file analysis does not fail solely for the bound.
13. **Starting-state limit.** Given enough nullable parameters to exceed 1,024 combinations, that method is abandoned at the starting-state guard without aborting later methods.
14. **Hardcoded model failure.** Given bundled behavior resources cannot be loaded, the engine uses no hardcoded models and continues with source/local semantics; it does not manufacture model results.
15. **Flow preference.** Given the same rule/tree is reached through both normal and exceptional flows, the published issue retains normal flow evidence and omits exceptional alternatives.
16. **JSP Community boundary.** Given Community Build and indexed JSP files, no generated JSP Java reaches the symbolic visitor, despite the plugin descriptor listing `jsp` as a required language.
17. **Coverage boundary.** Given JaCoCo XML input, this plugin emits no coverage measure; only the separate JaCoCo integration may import it.

## 12. Provenance index

- Identity, packaging, compatibility, and license: root `pom.xml`; `java-symbolic-execution/pom.xml`; `java-symbolic-execution/java-symbolic-execution-plugin/pom.xml`; `LICENSE.txt`; manifests.
- Plugin and profile registration: `src/main/java/org/sonar/java/se/plugin/JavaSEPlugin.java`; `JavaSECheckRegistrar.java`; `JavaSEProfileRegistrar.java`; `RulesList.java`; `JavaSECheckList.java`.
- Engine lifecycle/state: `src/main/java/org/sonar/java/se/SymbolicExecutionVisitor.java`; `ExplodedGraphWalker.java`; `ExplodedGraph.java`; `ProgramState.java`; `CheckerDispatcher.java`; `FlowComputation.java`.
- Cross-procedure behavior: `src/main/java/org/sonar/java/se/xproc/`; resources under `src/main/resources/org/sonar/java/se/xproc/`.
- Rules: exact implementation paths in Section 7; corresponding metadata and descriptions under `src/main/resources/org/sonar/l10n/java/rules/javase/`.
- Java dependency boundary: pinned Java analyzer `SonarComponents.java`, `VisitorsBridge.java`, and `BuiltInJavaQualityProfile.java`; `manifest/dependency-map.md`.
