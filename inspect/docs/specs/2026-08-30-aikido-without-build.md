# Aikido Security's Engine Stack and the No-Build Claim

**Date:** 2026-08-30

**Sources:**
- https://www.aikido.dev/open-source (2026-08-30)
- https://help.aikido.dev/code-scanning/scanning-practices/sast-by-aikido-supported-languages-and-security-focus (2026-08-30)
- https://help.aikido.dev/code-scanning/scanning-practices/multifile-vulnerability-tracing (2026-08-30)
- https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language (2026-08-30)
- https://help.aikido.dev/code-scanning/scanning-practices/java-scala-kotlin-projects-using-gradle-security-scanning-best-practices (2026-08-30)
- https://help.aikido.dev/code-scanning/scanning-practices/c-c-lockfile-less-scanning (2026-08-30)
- https://help.aikido.dev/miscellaneous-integrations/private-registries (2026-08-30)
- https://help.aikido.dev/getting-started/reachability-analysis/introduction-to-reachability-analysis (2026-08-30)
- https://help.aikido.dev/getting-started/reachability-analysis/reachability-engine-to-remove-false-positives (2026-08-30)
- https://help.aikido.dev/aikido-agent/sast-autotriage (2026-08-30)
- https://help.aikido.dev/code-scanning/scanning-practices/external-vulnerability-databases-used-in-our-sca-engine (2026-08-30)
- https://help.aikido.dev/code-scanning/miscellaneous/use-epss-values-to-further-reduce-noise (2026-08-30)
- https://help.aikido.dev/container-image-scanning/container-image-scanning-overview (2026-08-30)
- https://www.aikido.dev/code/open-source-dependency-scanning-sca (2026-08-30)
- https://www.aikido.dev/comparison/semgrep (2026-08-30)
- https://www.aikido.dev/code/static-code-analysis-sast (2026-08-30)
- https://docs.semgrep.dev/semgrep-code/semgrep-pro-engine-intro (2026-08-30)
- https://semgrep.dev/products/pro-engine/ (2026-08-30)
- https://semgrep.dev/blog/2023/the-birth-of-semgrep-pro-engine/ (2026-08-30)
- https://docs.semgrep.dev/references/feature-definitions (2026-08-30)
- https://docs.semgrep.dev/writing-rules/glossary (2026-08-30)
- https://docs.semgrep.dev/supported-languages (2026-08-30)
- https://semgrep.dev/products/product-updates/cross-function-on-all-scans/ (2026-08-30)

## 1. Engine inventory — ours vs. wrapped

Aikido's own supported-languages doc gives a per-line "Base engine" column — the single clearest disclosure in the market:

> "Aikido supports tracking tainted user input from top-level controllers to other files... | **Base engine** | **Taint analysis** | JavaScript | Aikido Engine + Opengrep | Across multiple files | ... | Infrastructure-as-code files ... | Aikido Engine + Checkov | Not applicable | Exposed secret discovery ... | Aikido Base Engine with Liveness Checks + Gitleaks | Not applicable"
(help.aikido.dev/.../sast-by-aikido-supported-languages-and-security-focus)

Opengrep is Aikido's own fork of Semgrep CE, disclosed on their open-source page: "**Opengrep** — SAST engine — A fork of SemgrepCE, it is maintained by multiple AppSec organizations to advance a vendor-neutral, truly open-source SAST engine." Aikido's Semgrep-comparison page confirms Aikido's SAST *used to run on Semgrep itself* before the fork: "Rewritten on OCaml 5.3. Median 3.22x speedup over Semgrep... The old Semgrep-based version crashed on large repos. Opengrep doesn't." (aikido.dev/comparison/semgrep)

| Engine | Ours / wrapped | Input it needs | Build required? | Source |
|---|---|---|---|---|
| Opengrep (Semgrep CE fork) | Wrapped (co-maintained OSS fork) | Parseable source AST, per repo | No | aikido.dev/open-source |
| "Aikido Engine" (risk categorisation + triage layer) | Ours | Opengrep findings + repo/file metadata | No | help.aikido.dev SAST-support page |
| Checkov | Wrapped | IaC files (Terraform/CFN/K8s/Docker/Pulumi) | No | help.aikido.dev SAST-support page |
| Gitleaks + "Liveness Checks" | Wrapped + ours | Git history/working tree text | No | help.aikido.dev SAST-support page |
| Reachability engine | Ours | Lightweight import/call graph built from source | No | help.aikido.dev reachability docs |
| AutoTriage / "exploitability agent" (LLM) | Ours | Code snippet + call tree selected by reachability engine | No | help.aikido.dev/aikido-agent/sast-autotriage |
| SCA vulnerability matcher | Ours | Parsed lockfile/manifest name@version | No | help.aikido.dev dependency-scanning-by-language |
| Aikido Intel (threat feed) | Ours | External feeds + own research, not per-repo | N/A | help.aikido.dev external-vulnerability-databases |
| C/C++ lockfile-less matcher | Ours | File hashes of vendored source vs. private library-hash DB | No | help.aikido.dev C/C++ lockfile-less page |
| Container image scanner | Claimed "Aikido's own scanner" in primary docs; **Trivy** asserted only by third-party blogs (Endor Labs) and a StackShare tag list, not in current primary docs | Image pulled from customer's registry | No (no build, just image pull) | help.aikido.dev container-scanning overview [UNVERIFIED for Trivy] |

## 2. SCA input: manifest/lockfile parsing, not build invocation

Aikido parses ~15 language-specific lockfile/manifest formats directly (npm/yarn/pnpm lockfiles, `poetry.lock`/`requirements.txt`, `Cargo.lock`, `Gemfile.lock`, `pom.xml`/`gradle.lockfile`, `.csproj`, etc. — full table in "Support for Dependency Scanning by Language (SCA)"). **Transitive closure is read straight out of the lockfile the customer already committed** — the lockfile already contains the full resolved dependency tree from a real `npm install`/`bundle install`/etc. run the customer performed; Aikido does not re-resolve a graph.

Where the manifest lacks pinned sub-versions, Aikido documents degraded results rather than compensating with its own resolver: *"build.gradle.\* (Gradle manifest) files might not contain exact versions for some of your dependencies. This can cause Aikido to not find the full range of risks in your application."* / *".csproj files often do not contain exact versions for subdependencies, which can cause Aikido to find some false positive CVEs in subdependencies."*

**One explicit opportunistic-build exception:** for Gradle, Aikido's AutoFix can open a PR that runs the actual build tool to generate a lockfile — the documented manual equivalent is literally `gradle dependencies --write-locks`. This is the one place Aikido concedes it needs live dependency resolution, and it is optional, PR-gated, and only improves precision for one ecosystem's edge case.

**Private registries:** authentication (npm/PNPM tokens, Maven `settings.xml`) is needed only for AutoFix (writing/regenerating lockfiles with private package versions) and for the separate "Registry Proxy" firewall feature (an install-time MITM that blocks malware/too-new packages) — not for the CVE-matching scan itself, which only needs the package name+version string already present in the lockfile text.

**C/C++** has no lockfile ecosystem at all for vendored code, so Aikido fingerprints instead: *"By hashing all relevant files in the repository, we can accurately match your project's dependencies with a database of the most popular open-source libraries... Even if you have made small edits to a library or if a small file is missing, our tool can still detect the library version."* This is snippet/hash fingerprinting against a private corpus, not manifest parsing or registry resolution.

**Vulnerability database:** matching is against an aggregated feed — *"our SCA engine aggregates data from trusted upstream databases and our own zero-delay intelligence feed"*: Aikido Intel, NVD, GitHub Advisory, Ubuntu USN, Debian, Alpine, Amazon Linux Security Center — all external, none requiring the customer's build.

## 3. Reachability / noise reduction — a four-stage funnel, not one mechanism

Aikido's own documentation names the stages explicitly and in order:

1. **Dependency-level reachability (SCA):** *"Is there an execution path from real application behavior to the vulnerable code?"* — built from a graph whose "Nodes represent functions, methods, modules, files" and "Edges represent... function calls, imports, dependency inclusion, and data-flow." Explicitly *approximate*: *"Aikido's reachability engine uses a 'conservative under-approximation,' so it only marks code as unreachable when it can be determined with high confidence."* No compiler or classpath — the graph is built statically from source text.
2. **Function-level reachability (SAST taint):** real source→sink dataflow via Opengrep, "Across multiple files" for the 12 languages listed in the SAST table, intra-file only for the remaining 7.
3. **Contextual (runtime) reachability:** a heuristic distinguishing prod vs. dev/test dependencies (e.g., a vulnerable package pulled in only by `eslint`/`mocha` is downgraded) — inferred from the dependency graph's position, not from an actual execution trace.
4. **Exploitability analysis / AutoTriage (LLM):** *"Before AutoTriage uses an LLM to look at your code, Aikido's reachability engine filters out false positives... If exploitability cannot be ruled out, then AutoTriage proceeds to prioritization... For some more complex cases, Aikido uses reasoning models to interpret more nuanced control and data flows."* This is an LLM reading the graph-selected snippet and call tree and writing prose reasoning — a judgment call, not a formal proof, and it only runs on findings that already survived stage 1–3.

A fifth, code-independent signal is folded into severity, not reachability: **KEV** (CISA's actively-exploited list, always on, +5 severity) and **EPSS** (predicted exploit probability, opt-in, can auto-ignore/downgrade) — pure external metadata about the CVE, unrelated to whether the customer's code reaches it.

**Distinction that matters:** stages 1–3 are code reachability (approximate graph connectivity over syntax, no compiler); stage 4 is LLM triage reading that same code; the KEV/EPSS layer is exploit-maturity metadata. Aikido's marketing ("95%/99%/100% false-positive reduction") blends all four into one number, but only stages 1–3 are "reachability" in the sense the rest of the industry uses the term.

## 4. Language coverage vs. depth

Per Aikido's own table (`sast-by-aikido-supported-languages-and-security-focus`), **every** SAST language runs on the same base engine (Aikido Engine + Opengrep) — depth differs only in how much of Opengrep's cross-file machinery is enabled per language:

| Cross-file (multi-file) taint | Intra-file taint only |
|---|---|
| JavaScript, TypeScript, PHP, .NET/C#, Java, Rust, Go, Ruby, Python, Scala, C/C++, Visual Basic | Swift, Android, Kotlin, Dart, Elixir, Apex, Clojure |

IaC (Checkov) and secrets (Gitleaks) have no taint/dataflow concept at all — pattern/rule matching only, marked "Not applicable" in Aikido's own table.

No Aikido document makes any claim about type resolution, classpath assembly, or compilation — consistent with (and inherited from) its Opengrep/Semgrep-CE lineage, which is architected specifically to avoid needing a build (see §5).

## 5. Semgrep interfile analysis: the technical mechanism (most transferable evidence)

- **Semgrep CE (OSS):** intraprocedural only — one function at a time.
- **Semgrep Code default (since Apr 2024, "cross-function on all scans" update):** cross-function (interprocedural) analysis runs on *every* scan by default, at no extra latency cost — still single-file, but tracks dataflow across functions within that file.
- **Semgrep Pro Engine cross-file (interfile) analysis** — a separate, proprietary `semgrep-core` binary (`semgrep install-semgrep-pro`), operating over a full checked-out repo root, **not** a build:
  - **Name resolution mechanism:** after parsing, "the AST undergoes name resolution to connect identifier uses to their definitions... populating the `id_info` field in `AST_generic.name`" — this is whole-project *syntactic* resolution (matching an identifier's use to its import/declaration across files), not a linker or compiler; it needs no `node_modules`, no resolvable classpath, no `.jar`s.
  - Three dataflow analyses ride on top of that resolution: **type inference** (heuristic — e.g., Java-stdlib-signature and naming-convention heuristics, not full nominal typing, since there is no classpath), **constant propagation** across files, and **cross-file taint analysis** ("tracks unsanitized variables flowing from a source to a sink through arbitrarily many files").
  - Semgrep states the goal plainly on its own product page: **"Works without compiled code — Easily scan your code and avoid rollout and management headaches. Scan more rapidly than other advanced analysis tools."**
  - Interfile support (GA): C, C++, C#, Go, Java, JavaScript/TypeScript, Kotlin, Python. Cross-function (interprocedural) is available for all 30+ Semgrep languages, marked experimental outside the interfile set.
  - Semgrep's own engineering post on building this ("The birth of Semgrep Pro Engine") found the *hard* part was not deep computation — *"We didn't need to compute if-branches or track values of an array... it wasn't clear that a precise analysis of [loop mutation/aliasing] was necessary"* — but ordinary structural understanding: inheritance, aliasing, and multi-file call chains. The unsolved case they name explicitly is **polyglot repos**: *"the difficulty wasn't needing very deep computation, but needing to understand a complicated repo with services in multiple languages."* A single-repo, source-only tool fundamentally cannot see across a language boundary.
- **Documented, self-disclosed limitations** (from Semgrep's own docs, not third parties):
  - CommonJS `function f(){...}; module.exports = f` (export assigned after definition) is not tracked by cross-file analysis.
  - *"Cross-file analysis resolves names differently than Semgrep CE's analysis... rules with `interfile: true` may produce different results than Semgrep CE. Some instances could be regarded as regressions."*
  - Automatic fallback to single-file analysis if cross-file preprocessing exceeds 5 GB memory or the scan doesn't finish within 3 hours — silently trading completeness for reliability on large repos.
  - Cross-file analysis originally ran only on full scans, not PR/MR diff scans; a later product update added interfile analysis to diff scans specifically to keep scan time under 5 minutes, implying full-repo interfile analysis is otherwise materially slower.

## Verdict table

| Question | Verdict |
|---|---|
| Engine inventory | Aikido SAST = Aikido's own triage/rules layer on **Opengrep**, Aikido's own fork of Semgrep CE (first-party-disclosed). IaC = **Checkov**. Secrets = **Gitleaks** + own liveness layer. All disclosed in Aikido's own support table. Container-scanner identity (Trivy?) is **not** confirmed in current primary docs — only in third-party blogs. |
| SCA input | Lockfile/manifest text parsing across ~15 ecosystems; transitive closure comes pre-resolved from the customer's own lockfile, never re-resolved by Aikido; degraded accuracy is explicitly documented when only a manifest is present; one narrow, PR-gated exception invokes Gradle itself to generate a lockfile; C/C++ uses file-hash fingerprinting instead of manifest parsing. |
| Reachability | A 4-stage funnel (import/call graph → intra/interprocedural taint → prod/dev heuristic → LLM reasoning), plus a 5th, code-independent KEV/EPSS metadata layer folded into severity. Only stages 1–3 are reachability of *code*; stage 4 is LLM triage; the 5th is exploit-maturity metadata. None require a build. |
| Depth vs. coverage | 12 languages get real cross-file taint on the same base engine; 7 get intra-file only; IaC/secrets are pattern-only with no taint concept. No classpath/compilation claim anywhere. |
| Semgrep mechanism | Interfile analysis is syntactic, whole-project **name resolution** (not a compiler/linker) feeding three dataflow passes; Semgrep's own marketing states it explicitly works "without compiled code"; self-disclosed limits include a CommonJS gap, CE/Pro result divergence, and automatic large-repo fallback to single-file analysis. |

## What this means for a checkout-at-rest product

- The market's "no build" credibility rests on two reproducible techniques, both source-only: **(a)** syntactic, AST-level cross-file name resolution (matching identifier uses to import/declaration sites) feeding taint/dataflow — exactly what Opengrep/Aikido and Semgrep Pro Engine ship as "interfile analysis," with no linker or classpath involved; **(b)** treating the customer's own committed lockfile as the pre-computed transitive-dependency closure, so SCA never resolves a dependency graph itself, only parses text the customer already produced by running their own build once, elsewhere, in the past.
- Reachability, as marketed by the closest checkout-at-rest competitor, is graph connectivity over that same syntactic AST (import/call edges) — not points-to analysis, not executed coverage — and is explicitly approximate/"under-approximate," erring toward over-reporting when the graph is unclear (reflection, dynamic imports, unusual build steps). The vendor documents this ceiling itself; a from-scratch reimplementation should expect and can safely publish the same ceiling.
- The extra "AI noise reduction" story is layered on top of, not instead of, that graph: an LLM re-reads the already-graph-selected snippet, and public exploit-maturity metadata (KEV/EPSS) adjusts severity. Neither needs build artifacts. The apparent magic in 90–100% false-positive-reduction marketing decomposes into (graph reachability) + (LLM re-read) + (public metadata) — a recipe fully available to a checkout-at-rest tool, not a deeper technical capability locked behind a build.
- Depth is genuinely uneven by design, and the credible vendors are transparent about it in support tables even while marketing "all languages" up front: full cross-file taint for languages with cheap, reliable syntactic import resolution (dynamic/scripting languages, JVM languages, Go/Rust/C-family); intra-file-only for languages where cross-file resolution is syntactically harder (Kotlin/Swift/Dart module systems, macro-heavy Elixir/Clojure). A checkout-at-rest product should scope its own cross-file claim the same way, per language, rather than as one blanket "multi-file analysis" checkbox.
- The single place both vendors quietly reach past pure statics — Aikido's opportunistic Gradle lockfile generation via a real `gradle` invocation — is optional, PR-gated, and improves precision for one ecosystem's manifest-only edge case. It is not load-bearing for the product's core value and matches this project's own scoping of sandbox build/resolution as opportunistic-only.

## Unverified / could not determine

- Whether Aikido's container-image scanner is literally Trivy: asserted only by a competitor comparison blog (Endor Labs) and a StackShare community tag list; Aikido's own current container-scanning documentation names only "Aikido's own scanner" and never names Trivy. `[UNVERIFIED]`
- Whether Grype, Brakeman, Bandit, or ZAP are still active production components versus legacy/discontinued integrations — these names appear only in a community-maintained StackShare list, not in any current Aikido primary document. `[UNVERIFIED]`
- The precise implementation of Aikido's opportunistic Gradle-lockfile-generation PR (whether it always shells out to `gradle dependencies --write-locks` in a sandbox, or uses a resolution library) — the docs describe the capability and give the manual equivalent, not the automated implementation. `[UNVERIFIED]`
- Semgrep's cross-file name-resolution algorithm internals are closed-source (unlike Semgrep CE); only the documented outcome, language matrix, and constraints are public. `[UNVERIFIED, by design]`
- Methodology behind Aikido Intel's headline figures ("12k+ known malicious packages," "67% never reported to a public database") — asserted in blog copy without a published methodology. `[UNVERIFIED]`
