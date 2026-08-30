# Reachability Into Dependency Code Without Compiling the Target

**Date:** 2026-08-30

**Sources:**
- https://www.endorlabs.com/learn/what-is-reachability-based-dependency-analysis (observed 2026-08-30)
- https://docs.endorlabs.com/scan/sca/call-graphs (observed 2026-08-30)
- https://docs.endorlabs.com/scan/sca/reachability-analysis (observed 2026-08-30)
- https://docs.endorlabs.com/scan/sca/reachability-analysis/pre-computed-reachability (observed 2026-08-30)
- https://docs.endorlabs.com/scan-with-endorlabs/language-scanning/java/ (observed 2026-08-30)
- https://docs.endorlabs.com/scan/sca/binary-artifact-scan (observed 2026-08-30)
- https://docs.deps.dev/api/v3/ (observed 2026-08-30)
- https://security.googleblog.com/2023/04/announcing-depsdev-api-critical.html (observed 2026-08-30)
- https://github.com/google/deps.dev/blob/main/README.md (observed 2026-08-30)
- https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages (observed 2026-08-30)
- https://github.blog/changelog/2024-03-26-codeql-can-scan-java-projects-without-a-build/ (observed 2026-08-30)
- https://docs.socket.dev/docs/static-reachability-analysis (observed 2026-08-30)
- https://docs.socket.dev/docs/faq (observed 2026-08-30)
- https://sourcegraph.com/blog/cross-repository-code-navigation (observed 2026-08-30)
- https://sourcegraph.com/blog/scip-python (observed 2026-08-30)
- https://support.snyk.io/hc/en-us/articles/360010554837-Reachable-Vulnerabilities- (observed 2026-08-30)
- https://help.aikido.dev/getting-started/reachability-analysis/introduction-to-reachability-analysis (observed 2026-08-30)
- https://help.aikido.dev/getting-started/reachability-analysis/reachability-engine-to-remove-false-positives (observed 2026-08-30)

## Q1 — Endor Labs: what does the call graph actually require?

Endor Labs' own engineering blog (Gousios & Apostolopoulos, "What is Reachability-Based Dependency Analysis?") is explicit about the mechanism, and it is the single most load-bearing quote in this report:

> "To deal with ecosystem scale, we create a call graph per package version, store those call graphs and then, given a client dependency set, we stitch them on the fly."

This confirms the stitching hypothesis as real, shipping, and vendor-stated — not our inference. The design: a **static per-package-version call graph is computed once, centrally, keyed by package+version**, then joined at query time against whatever dependency set a customer resolves. This is why Endor can claim call graphs "not only for each project release but also for all its dependencies" without recomputing the OSS side per customer.

But the client's own first-party code is a different story, and the requirement is build-dependent per language. Endor's own Java doc is unambiguous:

| Requirement | Endor Labs statement (verbatim) |
|---|---|
| Java, full/deep scan | "You must build your Java projects before running a scan... the standard `.m2` cache must exist and contain successfully downloaded dependencies... To perform a deep scan the target artifact must be generated on the file system as well." |
| Java, quick scan | Dependencies "must be located in the local package manager cache" — still requires a prior resolve/build step, not source-only. |
| Fallback when build fails | "Pre-computed reachability" — dependency-metadata-only, **no call graph**, transitive-only, explicitly framed as "a fallback for full scans when builds fail." |
| Binary path | `endorctl scan` can target a pre-built artifact/binary directly "without requiring access to source code or build systems" — but this needs *someone's* completed build output (e.g., a published JAR), not zero build anywhere in the chain. |

So Endor Labs' precomputation solves the **dependency side** of the join (the 100+ packages a project pulls in) — it does not solve the **first-party root** of the call graph for a compiled language. For Java, the root still needs a successful local build to get function-level reachability; without one, Endor degrades to dependency-level-only reachability (a coarser signal: "is the transitive package imported at all," not "is the vulnerable function called").

Construction mechanics (same blog, primary source): static call graphs are over-approximations by necessity (virtual dispatch requires imitating a vtable), benchmarked internally against dynamic call graphs from instrumented runs, and explicitly carry false positives *and* false negatives — "different use cases have different sensitivity... for security risk, false negatives can be problematic." Endor traces its call-graph lineage to TU Delft's Software Analytics lab and the EU FASTEN project (academic, not proprietary-only, work).

## Q2 — Is "index public artifacts centrally, resolve private code locally" a real shipping pattern?

**Yes for Endor Labs** (confirmed above — primary source, own words). **Partially yes for deps.dev.** **Yes for Socket, at the granularity of "which function is vulnerable," not "the whole call graph."** **No evidence of it for Sourcegraph** — the opposite is documented there.

| System | Centrally precomputed? | Granularity | Evidence |
|---|---|---|---|
| Endor Labs | Yes — per package-version call graphs, stored, stitched per client | Function/method | Own blog, quoted above |
| deps.dev | Yes — Google indexes ~5M packages/50M+ versions once, serves via public API/gRPC | **Package & version metadata only**: available versions, licenses (SPDX), declared/resolved dependency requirements (raw POM/`package.json`/etc. fields), OSV advisory keys, SLSA/attestation data, Scorecard signals. The `GetVersion`/`GetDependencies` schema has no function, symbol, or call-graph field anywhere. | `docs.deps.dev/api/v3/` full schema walk |
| Socket | Yes — a human/AI-curated "reachability specification" per CVE, naming which functions in the affected package are responsible | Function-level **mapping of vuln→function**, not a full stored call graph of the package | `docs.socket.dev/docs/static-reachability-analysis` FAQ |
| Sourcegraph SCIP | **No** — auto-indexing "clones your repositories into isolated executors" and indexes "every library you depend on" per tenant; "indexing cost scales with the depth of your dependency graph" | Symbol-level (precise defs/refs), but computed **per repository**, not shared across customers | `sourcegraph.com/blog/cross-repository-code-navigation`, `scip-python` post |
| Snyk (Java) | No stated central library call-graph cache; requires the *customer's own* built bytecode | Function-level, but rooted in a build the customer must have already run | `support.snyk.io` reachability article |

**Verdict:** the pattern is real, but it is not uniform. Where it is real (Endor, deps.dev, Socket) it is real for exactly the sub-problem that is *actually shareable across customers*: the open-source side of the graph, which is public and identical for every customer who depends on `log4j-core:2.14.1`. None of them use central precomputation to avoid needing to see or build the *customer's own* first-party code — that half of the join is always customer-local. deps.dev proves the pattern works at dependency-graph granularity; nobody has shipped a public, symbol-level, cross-customer index of function bodies at deps.dev's scale — Endor's and Socket's per-package-version graphs are proprietary and internal, not published.

## Q3 — CodeQL `build-mode: none` for Java: mechanics and documented tradeoffs

Per GitHub's own reference doc (`build-options-for-compiled-languages`):

> "CodeQL will attempt to run Gradle or Maven to extract accurate dependency information (**but not to invoke a build**), before creating a database from all Java files present. Every root Maven or Gradle project file... is queried for dependency information, and more recent dependency versions are preferred if there is a clash."

So `build-mode: none` for Java is not "no tooling involved" — it still **shells out to Maven/Gradle** to resolve the dependency tree (which needs registry/network access, and a private-registry credential if the org uses one), it just never invokes `compile`/`package`. The CodeQL database is then built by parsing every `.java` file directly, using the resolved dependency JARs only for type/API information.

GitHub's documented accuracy cost, verbatim:
- "Gradle or Maven build scripts cannot be queried for dependency information, and dependency guesses (based on Java package names) are inaccurate."
- "The repository normally generates code during the build process. This would be analyzed if you created the CodeQL database using a different mode." — **generated code is invisible** in no-build mode.
- Multiple JDK versions required by different files → CodeQL picks the highest version seen in any build script; files needing a lower version "will be partially analyzed."
- Colliding class names (e.g., two files both defining `org.myproject.Test`) → "missing method call targets, which has an impact on dataflow analysis."
- Kotlin+Java mixed repos are **not supported** in `build-mode: none` at all; Kotlin code is skipped with a warning, and the repo must fall back to `autobuild`.

Adoption data point (GitHub Changelog, 2024-03-26): "large-scale testing has shown that CodeQL can be successfully enabled for over 90% of Java repos without manual intervention" under `build-mode: none`, which became the **default** for newly configured Java-only repos in default setup.

This is exactly our design problem, solved and shipped by a major vendor, with GitHub choosing to trade dataflow/call-target precision for build-independence at default-setup scale — and publishing the exact list of what breaks.

## Q4 — What everyone gives up (explicit vendor statements)

| Vendor | Explicit accuracy cost, as stated by the vendor |
|---|---|
| CodeQL (Java, no-build) | Inaccurate dependency guesses when build files can't be queried; generated code missed entirely; JDK-version and class-name collisions break dataflow call targets; Kotlin unsupported |
| CodeQL (C#, no-build) | Only one NuGet version usable when several exist (usually the newest); only one target framework used when multiple (`net48`/`net5.0`/`netstandard1.6`) are referenced; colliding class names miss call targets |
| CodeQL (C/C++, no-build) | Inaccurate when code depends on undiscoverable custom macros/defines, or has heavy external-dependency use not resolvable without a build |
| Endor Labs | Static call graphs are inherent over-approximations (vtable/virtual-dispatch imitation); explicit false positives *and* false negatives; "pre-computed reachability" fallback gives dependency-level only, no function granularity, when build fails |
| Socket | Reflection handled only "best-effort" (e.g., Java properties-file-loaded classes marked *potentially* reachable, not confirmed); anything invoked only via a CLI (not in-process) is unreachable-by-definition in their model and classified **"not determinable"**; .NET and Rust fall back to **class-level**, not function-level, specifically so the analysis can "operate... without requiring the application to be built" |
| Aikido | "Highly dynamic patterns, custom loaders, or unusual build steps can obscure call graphs"; conservative under-approximation means ambiguous cases are kept at higher severity rather than resolved |
| Snyk | No documented no-build path for Java reachability at all — CLI reachability explicitly "must have the app already built (compiled), and the bytecode of the app should be available" |

Common thread across every vendor above: **reflection, dynamic dispatch/loading, generated code, and DI wiring are the recurring blind spots**, independent of whether a build ran. A build increases confidence in *type resolution* (which overload, which override), not in *reflective* call targets — those remain heuristic even for vendors that do require a build (Snyk, Endor's Java full scan).

## Verdict table — what each vendor needs from the customer

| Vendor | Needs a customer build? | Needs customer's registry creds? | Reachability granularity without a build | Central precomputation of public deps? |
|---|---|---|---|---|
| Endor Labs (Java, full scan) | Yes | Only if fetching private deps | N/A (build required) | Yes, for the OSS side only |
| Endor Labs (pre-computed fallback) | No | No | Dependency-level only, transitive deps only | Yes (manifest/metadata-driven) |
| CodeQL Java (`build-mode: none`) | No compile, but yes to a Maven/Gradle *resolve* step | Yes, for private-registry accuracy | Function-level, degraded (see Q3/Q4) | No — resolves and parses per-repo each run |
| CodeQL Java/Kotlin mixed (`autobuild`) | Yes | Yes | N/A (build required) | No |
| Snyk (Java CLI reachability) | Yes (bytecode required) | Only for dependency fetch | N/A (build required) | Not documented |
| Socket | No | No | Function-level (most ecosystems), class-level (.NET/Rust) | Yes — per-CVE vuln→function specs, not full call graphs |
| Aikido | No (read-only repo clone, ephemeral containers) | No | Function/class-level, lightweight graph | Not documented as cross-customer |
| deps.dev | N/A — not a code scanner | No (public API) | No code-level reachability at all — package/version graph only | Yes — fully public, documented |
| Sourcegraph SCIP | No compile for source-only languages; compiled languages need type info the indexer sources however it can | Depends on indexer | Symbol-level, precise, per-repo | **No** — cost scales per tenant with dependency depth |

## What this means for a checkout-at-rest product

1. **The transferable trick is real, but narrower than the pitch.** Central, once-computed, per-public-artifact indexing is a genuine shipping pattern (Endor Labs' per-package-version call graphs; deps.dev's public dependency graph; Socket's per-CVE reachability specs). It only ever covers the **public, version-pinned, identical-for-every-customer** side of the graph — i.e., exactly the dependency corpus a manifest/lockfile names. It has never been used, by any vendor we found, to avoid needing the *customer's own* code.
2. **The customer's own code is where the real fork happens**, and there are exactly two documented strategies for it in a compiled language, both shipped in production:
   - **Require a build** (Snyk Java, Endor Labs Java full scan) — full function-level fidelity, at the cost of needing a green build (which is exactly the constraint this product has ruled out).
   - **Parse-only, resolve-but-don't-compile** (CodeQL Java `build-mode: none`, Aikido, Socket) — accept documented, named precision losses (generated code invisible, overload/override ambiguity on class-name or version collisions, reflection reduced to best-effort heuristics) in exchange for working on 90%+ of repos with zero build. GitHub ships this as the *default* for Java.
3. **Dependency resolution ≠ compilation, and that distinction is the actual lever.** Even the most build-averse vendor (CodeQL) still shells out to Maven/Gradle to resolve a dependency tree — it just stops short of compiling. That step alone needs registry reachability and, for private dependencies, credentials. A checkout-at-rest product can adopt the same split: attempt dependency-graph resolution from lockfiles/build manifests (no credentials required if public, best-effort degrade if private/unreachable) and skip compilation entirely, exactly as CodeQL's Java no-build mode does.
4. **A public, centrally computed, per-artifact call-graph corpus for popular JVM/PyPI/npm library versions is the single highest-leverage asset this product could build once and reuse forever** — it is the direct analogue of Endor's approach and does not require ever touching a customer's private registry, because it is built from the same public artifacts deps.dev already indexes. The join step (stitching customer code to that corpus) is exactly the reachability problem Endor solves per query — and it is orthogonal to whether the customer's own code was compiled.
5. **Reflection/DI/generated-code blindness is priced in everywhere, including build-based vendors.** This is not a no-build-specific cost; it is a static-analysis-specific cost. A checkout-at-rest product loses nothing extra here relative to Snyk or Endor's full-build mode.

## Unverified / could not determine

- Whether Endor Labs' "dynamic call graphs" benchmarking corpus is used to *correct* the static per-package-version graphs before storage, or only to measure them after the fact — the blog says "benchmark and refine" but does not describe the refinement mechanism. `[UNVERIFIED]`
- Whether Snyk maintains any centrally precomputed, cross-customer library call-graph cache analogous to Endor's — no primary-source evidence found either way; Snyk's own docs discuss only the customer-side build requirement. `[UNVERIFIED]`
- Exact false-positive/false-negative rates for CodeQL Java `build-mode: none` vs `autobuild` on the same repo — GitHub states the *categories* of degradation but not a quantified accuracy delta. `[UNVERIFIED]`
- Whether Sourcegraph caches SCIP indexes for popular open-source dependency *versions* across different customer repositories that happen to share the same dependency (to avoid literally re-indexing `lodash` for every tenant) — the public blog posts describe per-repo indexing cost scaling with dependency depth but do not confirm or deny a shared dependency-index cache. `[UNVERIFIED]`
- The "92%"/"95%" noise-reduction figures for Endor Labs and Aikido are marketing-adjacent claims repeated across their own materials; we did not find the underlying methodology (denominator, benchmark corpus) published. Treat as vendor-stated, not independently verified. `[UNVERIFIED]`
