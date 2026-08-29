# Spike: Eclipse JDT Core as an in-process, build-free Java resolver

> **Scope status, 2026-08-29 (final):** JDT is adopted. The classpath acquisition used here is rung 2 — invoking the target's build tool, permitted inside a sandbox we own because it asks nothing of the customer, but **opportunistic**, since a private artifact registry is unreachable without credentials we will not request (`docs/specs/2026-08-29-code-graph-sourcing.md` §2, §5.3, §5.5). So the `full` column is the lucky case and the `empty` column is the floor. **The product's real fidelity is the unmeasured value between them**: a rung-1 classpath from declarations plus publicly resolvable archives, no package manager invoked. That is the first thing to measure.

**Date:** 2026-08-29
**Question:** "We have no Java yet, so measure JDT on an external Java project of moderate size: resolved binding rate with and without a classpath, wall-clock per thousand lines, and whether recovered bindings are a usable `name-only` signal."
**Verdict:** JDT resolves 99.998% of reference names and 100% of call sites with a classpath and 57.7% trustworthily without one, at ~20 ms/kLOC and 10.6 MB of embeddable jars — but `isRecovered()` is **not** a usable `name-only` signal: it is non-transitive, misses 55% of recovery-only bindings, and 56% of the flags it does raise name the wrong symbol.

## Setup

Scratch root `/Users/andre/git/leveret-spike/jdt/`; nothing in the product repository was touched but this file.
Subject: `apache/commons-lang` @ `620f4ff4b4b0934e6dc46465fe5c92fd7e1fb997` (2026-08-27), Apache-2.0,
626 files (264 main + 362 test), **203,436** physical lines — chosen for being single-module with
`maven.compiler.source=1.8` and one command to a classpath; it has **zero compile-scope dependencies**
(all 23 are test-scope), see Failures. Resolver: `org.eclipse.jdt:org.eclipse.jdt.core:3.46.0`, the
latest release on Central (`maven-metadata.xml` `lastUpdated 20260608064343`). Host: JDK 26.0.2.1
(Homebrew), Maven 3.9.16, Apple M1 Pro, default max heap 8 GiB. Probe:
`/Users/andre/git/leveret-spike/jdt/probe/src/main/java/Probe.java`, ~330 lines.

```bash
git clone --depth 1 https://github.com/apache/commons-lang.git subject     # 620f4ff…
cd subject && mvn dependency:build-classpath \
    -Dmdep.outputFile=../subject-cp.txt -Dmdep.includeScope=test           # BUILD SUCCESS, 2.801 s
javac -cp "$(cat probe/probe-cp.txt)" -d probe/out probe/src/main/java/Probe.java
java -cp "probe/out:$(cat probe/probe-cp.txt)" Probe <config> 1.8 \
    subject/src/main/java,subject/src/test/java [subject-cp.txt]
```

Every configuration uses one batch `ASTParser.createASTs(...)` over all 626 files with
`setResolveBindings(true)`, `setBindingsRecovery(true)`, `setStatementsRecovery(true)`,
`JavaCore.setComplianceOptions("1.8", options)`, and
`setEnvironment(classpath, sourcepath, null, includeRunningVMBootclasspath)`.
**No build of the subject was run.** `dependency:build-classpath` resolves the POM; it does not compile.

## Measurements

`full` = JDK + 23 dependency jars + 2 sourcepath entries. `full−junit` = JUnit/opentest4j/apiguardian
removed (13 jars) — the realistic "one dependency failed to resolve" case. `jdk-only` = running VM
bootclasspath only, no jars, no sourcepath. `empty` = `setEnvironment(new String[0], new String[0], null, false)`.

| Metric | `full` | `full−junit` | `jdk-only` | `empty` |
|---|---:|---:|---:|---:|
| Classpath entries | 23 | 13 | 0 | 0 |
| VM bootclasspath | yes | yes | yes | **no** |
| Syntax errors | 0 | 0 | 0 | 0 |
| Semantic errors | **0** | 13,744 | 14,090 | 29,915 |
| SimpleName references visited | 251,399 | 251,399 | 251,399 | 251,399 |
| → non-null binding | **251,395 (99.998%)** | 217,889 (86.7%) | 217,435 (86.5%) | 187,889 (74.7%) |
| → of those, `isRecovered()` | **0** | 12,840 | 13,242 | 42,938 |
| → **non-null and not recovered** | **251,395 (99.998%)** | 205,049 (81.6%) | 204,193 (81.2%) | **144,951 (57.7%)** |
| → into own source | 92,265 | 87,926 | 87,916 | 82,090 |
| → **into the JDK** | **50,979** | 49,368 | 49,366 | **0** |
| → **into a dependency jar** | **35,287** | 659 | 2 | **0** |
| MethodInvocation nodes | 78,474 | 78,474 | 78,474 | 78,474 |
| → resolved | **78,474 (100%)** | 49,996 (63.7%) | 49,787 (63.4%) | 33,522 (42.7%) |
| → **into JDK or dependency** | **40,391 (51.5%)** | 13,997 | 13,794 | **0** |
| ClassInstanceCreation nodes | 6,087 | 6,087 | 6,087 | 6,087 |
| → resolved | **6,087 (100%)** | 5,734 | 5,734 | 3,544 |
| → into external types | 2,134 | 1,942 | 1,942 | 0 |
| Wall clock, parse+visit | 3,905–5,466 ms | 6,855 ms | 4,123 ms | 3,287–3,839 ms |
| **ms per kLOC** | **19.2–26.9** | 33.7 | 20.3 | 16.2–18.9 |
| Peak RSS (`/usr/bin/time -l`) | 890 MB | — | 793 MB | 656 MB |

The 4 residual misses in `full` are Java **statement labels**, which carry no binding by design —
`TOP_UNRESOLVED_NAMES=[hierarchyTraversalx2, outerx2]`, from `MethodUtils.java:560`
(`hierarchyTraversal: while (…)`) and `StrBuilderClearTest.java:99` (`outer: for (…)`).

So with a classpath the effective rate is **100.0%**, with zero compiler errors, on 203k lines of
unbuilt source. **86,266 reference bindings and 40,391 call edges (51.5% of all calls) land outside
the project — and exactly 0 of them survive removing the classpath.**

### The recovered-binding signal — the claim in sourcing §5 does not hold

```
full        REC_KIND={}            ECHO=0      OTHER=0      REAL=0
jdk-only    REC_KIND={TYPE=13242}  ECHO=5776   OTHER=7447   REAL=19
empty       REC_KIND={TYPE=42938}  ECHO=23353  OTHER=12170  REAL=7415
```

`REC_KIND` is **`TYPE` only, in every configuration**; `MI_RECOVERED=0` and `CIC_RECOVERED=0` always.
No recovered method or variable binding ever appeared. Key shapes: `ECHO` = the key is literally
`Recovered#typeBindingL<sourceIdentifier>;0`, i.e. the source text re-emitted; `OTHER` = the key names
something *other* than the identifier; `REAL` = a resolvable key.

```
name=assertTrue  kind=TYPE key=Recovered#typeBindingLorg/junit;0 parent=QualifiedName
name=Annotation  kind=TYPE key=Recovered#typeBindingLjava/lang;0 parent=QualifiedName
name=Method      kind=TYPE key=Recovered#typeBindingLjava/lang;0 parent=QualifiedName
```

`java.lang.annotation.Annotation` recovers to a *type* named `java.lang`, shared by all four
segments; the static-imported **method** `assertTrue` recovers to a *type* keyed `org/junit`.
In `jdk-only` — one dependency set missing, JDK present — **19 of 13,242 recovered bindings (0.14%)**
carry a resolvable key and **7,447 (56.2%)** name the wrong symbol.

**And the flag is not transitive.** Counting bindings that report `isRecovered()==false` while their
own type, declaring class, return type, or a parameter type is recovered:

| | `full` | `jdk-only` | `empty` |
|---|---:|---:|---:|
| VARIABLE/METHOD bindings, `isRecovered()==false` | 156,637 | 124,801 | 103,249 |
| …of which a type in the signature **is** recovered | **0** | 1,281 (1.0%) | **53,623 (51.9%)** |

```
name=toString  kind=METHOD   isRecovered=false but returnType=Ljava/lang/String; isRecovered=true
name=value     kind=VARIABLE isRecovered=false but type=Ljava/lang/Object;      isRecovered=true
```

Note the fabricated types carry **real-looking keys** (`Ljava/lang/String;`), so key shape cannot
screen them either. An independent check agrees: with `setBindingsRecovery(false)` and everything else
held equal (`setStatementsRecovery(true)`, empty environment), non-null bindings drop 187,889 → 91,334.
**96,555 bindings exist only because recovery is on, yet only 42,938 admit it** — a 53,617 gap that
matches the 53,623 measured directly.

### Stable symbol keys, and overloads

`IMethodBinding.getKey()` is already a stable key; a normalised erasure key derived from
`getMethodDeclaration()` is equivalent and format-independent. Two of the four real
`StringUtils.abbreviate` overloads, verbatim:

```
DECL org.apache.commons.lang3.StringUtils.abbreviate
  jdtKey   = Lorg/apache/commons/lang3/StringUtils;.abbreviate(Ljava/lang/String;I)Ljava/lang/String;
  derived  = org/apache/commons/lang3/StringUtils#abbreviate(Ljava/lang/String;I)Ljava/lang/String;
  params   = [java.lang.String, int]
DECL org.apache.commons.lang3.StringUtils.abbreviate
  jdtKey   = Lorg/apache/commons/lang3/StringUtils;.abbreviate(Ljava/lang/String;II)Ljava/lang/String;
  derived  = org/apache/commons/lang3/StringUtils#abbreviate(Ljava/lang/String;II)Ljava/lang/String;
  params   = [java.lang.String, int, int]
```

4 declarations → 4 distinct keys. Its 72 call sites partition across them 20 / 12 / 16 / 24, and the
key computed at a call site equals the key computed at the declaration. Two consecutive runs produced
byte-identical output (`diff keys-run1.txt keys-run2.txt` → empty). Keys work equally into a
dependency jar — one name the baseline records as permanently unresolvable becomes 12+ symbols:

```
   6827 org/junit/jupiter/api/Assertions#assertEquals(Ljava/lang/Object;Ljava/lang/Object;)V
   3590 org/junit/jupiter/api/Assertions#assertEquals(II)V
    787 org/junit/jupiter/api/Assertions#assertEquals(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/String;)V
    440 org/junit/jupiter/api/Assertions#assertEquals(JJ)V
```

### Dependency weight

POM transitive closure: **19 artifacts, 14.76 MB**. Greedy one-at-a-time removal, each candidate set
re-verified by requiring the identical `SN_REF_RESOLVED=251395`, reduces this to **10 artifacts,
10.58 MB** — both JNA jars (3.23 MB), `core.expressions`, `equinox.registry`, `equinox.app`,
`core.filesystem`, `org.eclipse.text`, `core.commands`, `osgi.annotation` all drop out:

```
MINIMAL SET: 10 jars, 10.58 MB
   4.30 org.eclipse.jdt.core  3.21 ecj  1.54 org.eclipse.osgi  0.92 core.resources
   0.16 equinox.common  0.12 core.jobs  0.12 equinox.preferences  0.10 core.contenttype
   0.09 core.runtime  0.02 org.osgi.service.prefs                          (MB each)
```

## What this means for platform/code-graph

JDT is a **Tier A in-process producer for Java** and the numbers support that unreservedly: with a
classpath it resolves every call site and every reference except statement labels, on source that was
never compiled, at ~20 ms/kLOC and under 1 GB, for 10.6 MB of embedded jars. Its non-recovered
bindings deserve `resolved`, and its `IMethodBinding` keys are stable, overload-distinguishing, and
identical at declaration and call site, so they can serve as the store's symbol identity directly.
**The classpath, not the build, is the fidelity boundary:** 86,266 external reference bindings and
40,391 external call edges exist only when jars are supplied — precisely the category name matching
structurally cannot reach, where one `assertEquals` becomes 12 distinct symbols. What JDT cannot
supply is a trustworthy middle tier: **`isRecovered()` must not be mapped to `name-only`**. Ingest
should set `bindingsRecovery(false)`, record a null binding as an unresolved reference, and also
reject any binding whose signature types are recovered — at 51.9% taint the flag on the binding in
front of you says nothing about the binding it points to.

## Failures and limits

- **`jdt.core` + `ecj` alone does not run.** `java -cp "…jdt.core-3.46.0.jar:…ecj-3.46.0.jar" Probe full …` →
  `java.lang.NoClassDefFoundError: org/eclipse/core/runtime/IAdaptable`. The floor is the 10 jars above.
- **Statement labels have no binding.** All 4 `full`-configuration misses are labels. An ingest that
  counts every null-binding `SimpleName` as an unresolved reference will report phantom failures;
  labels must be excluded by syntactic position.
- **The subject has zero compile-scope dependencies.** commons-lang's 23 entries are all test-scope, so
  the 35,287 dependency-jar bindings and 26,336 dependency calls come from JUnit/EasyMock/Mockito/JMH.
  Real compile dependencies would shift the JDK/dependency split, not the with-versus-without
  conclusion, since `empty` yields 0 either way.
- **Classpath acquisition is build-free here but not free.** `dependency:build-classpath` succeeded in
  2.801 s without compiling, but it downloaded 5 plugin jars first and it requires a POM that
  resolves. A project whose dependency tree does not resolve degrades to the `jdk-only` column:
  81.2% trustworthy references, 63.4% resolved calls, and 13,242 misleading recovered bindings.
- **Source-level guess costs little but is not free.** Compliance `1.8` → 0 semantic errors. Compliance
  `21` → also 0 semantic errors and identical `MI_RESOLVED=78474`, but 1,910 fewer `PACKAGE` bindings
  (`java` as a root qualifier stops resolving) and `UNRESOLVED` 4 → 1,914. Edges unaffected; package
  nodes are not.
- **Timing is noisy — three sibling spike agents shared this machine.** `full` ranged 3,905–9,370 ms
  over six runs (median ≈ 4,400 ms); the 19.2–26.9 ms/kLOC band excludes the 9,370 ms outlier
  (46.1 ms/kLOC), reported here rather than discarded. Peak RSS is an observation, not a floor:
  default 8 GiB max heap, no `-Xmx`, so the GC had no reason to be frugal.
- **The JDK-versus-dependency split is a package-prefix heuristic** (`java.`/`javax.`/`jdk.`/`sun.`/
  `com.sun.`), not module identity. `isFromSource()` — the load-bearing own-source-versus-external
  discriminator — is JDT's own and exact.
- **Not measured:** single-file re-parse cost for delta application, and `overrides`/`implements`/
  `extends` edge extraction; both are outside this spike's question. Cross-file source resolution
  worked with **no** sourcepath entries (`jdk-only` still reached 87,916 own-source bindings against
  `full`'s 92,265) — the batch `createASTs` unit set makes the files mutually visible.
