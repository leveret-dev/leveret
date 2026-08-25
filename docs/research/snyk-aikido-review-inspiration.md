# Snyk and Aikido review-pipeline inspiration

Status: primary-source research, 2026-08-24. This note extracts transferable
architecture and product ideas; it does not compare pricing, reverse engineer
private systems, benchmark either vendor, or propose a vendor integration.

## Evidence rules and scope

This note uses the dimensions and existing work tracked by [Leveret issue
#64](https://github.com/leveret-dev/leveret/issues/64): applicability routing,
analyzer breadth, reachability/context, prioritization, fixability,
incremental scans/cache, CI/PR integration, false-positive controls, and
structured reporting.

Evidence labels mean:

- **D** — documented in first-party product documentation. This proves what the
  vendor publishes, not that the behavior is complete or independently measured.
- **O** — directly inspectable in a first-party public interface, option list,
  schema, rule reference, or repository-controlled configuration format. No live
  Snyk or Aikido tenant was exercised for this note.
- **I** — an inference or proposed transfer to Leveret, not a claim about vendor
  internals.

Marketing assertions are kept separate from mechanisms. In particular, Snyk's
claim that its AI engine yields fewer false positives is not a published
precision/recall result ([Snyk Code](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code.md)).
Aikido's “no noise” language and its internal claim that reasoning detects
roughly twice as many false positives in complex cases are likewise not
independent evidence ([SAST language support](https://help.aikido.dev/code-scanning/scanning-practices/sast-by-aikido-supported-languages-and-security-focus.md),
[SAST AutoTriage](https://help.aikido.dev/aikido-agent/sast-autotriage.md)). No
quantitative vendor claim is used to justify an experiment below.

## Snyk: documented mechanisms

### Analyzer families and applicability

- **D:** Snyk Code is SAST available through the web/SCM, IDE, CLI, CI/CD, and
  API. Its documented semantic engine models API usage, control flow, data flow
  from source to sink, points-to relationships, types, and value ranges; its
  hardcoded-secret rules are part of SAST rather than a standalone secret
  scanner ([Snyk Code](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code.md)).
  Snyk publishes its security-rule catalog with rule name, language, CWE, and
  OWASP/CWE category mappings ([Snyk Code security rules](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/snyk-code-security-rules.md)).
- **D:** Snyk Open Source is SCA for direct and transitive dependency
  vulnerabilities plus license issues, with language/package-manager-specific
  support and remediation advice ([Snyk Open Source](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-open-source.md)).
- **D:** Snyk IaC scans Terraform, CloudFormation, Kubernetes, and ARM in IDE,
  SCM, CLI, and Terraform workflows; it also scans deployed AWS, Azure, and GCP
  environments and reports fix advice ([Snyk IaC](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-iac.md)).
- **D:** Snyk Container inventories OS packages, unmanaged Node/OpenJDK
  binaries, and application packages found through manifests in the final built
  image. It reads the filesystem without executing the image and then matches
  inventory against vulnerability data ([How Snyk Container works](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-container/how-snyk-container-works.md)).
- **D:** Native Snyk PR Checks currently document Snyk Code, Snyk Open Source,
  and license checks. Code changes trigger a full-repository Code scan; Open
  Source checks supported dependency files; license checks apply configured
  policy. IaC and container have SCM/CI/fix-PR workflows, but the current native
  PR Check catalog does not list them as equivalent gate types
  ([PR Check configuration](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks/configure-pull-request-checks.md),
  [Snyk IaC](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-iac.md),
  [Dockerfile fix PRs](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-container/scan-your-dockerfile/fix-vulnerable-base-images-in-your-dockerfile.md)).

**Transfer:** analyzer breadth alone is not the lesson. The reusable pattern is a
capability registry whose entries declare target artifacts, supported ecosystems,
analysis depth, output schema, and whether the result can gate or only inform.
That is stricter than “run every installed tool.”

### Reachability, context, and prioritization

- **D:** Snyk reachability joins a first-party application call graph to the call
  graph of open-source dependencies and marks a vulnerability reachable when a
  path reaches a code element ranked as a root cause. Vulnerability curation,
  related-element analysis, root-cause ranking, program analysis, and security
  expert review all contribute ([reachability analysis](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/reachability-analysis.md)).
- **D:** Snyk explicitly warns that “no path found” is not proof of
  unreachability. Reflection, incomplete control-flow information, dynamic
  behavior, first-party changes, vulnerability re-analysis, and SAST
  improvements can change the result. Reachability is GA only for the listed
  ecosystems, with C# still Early Access in the reviewed documentation
  ([reachability limits and support](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/reachability-analysis.md)).
- **D:** The Early Access Risk Score for Open Source and Container is a 0–1,000
  issue score split into impact and exploit-likelihood inputs. Documented inputs
  include CVSS impact/exploitability, exploit maturity, EPSS, advisory age,
  social trends, malicious-package state, provider urgency, package popularity,
  project business criticality, reachability, and transitive depth. The score is
  not available in the CLI and legacy API fields remain named `priority`
  ([Risk Score](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/risk-score.md)).

**Transfer:** represent reachability as evidence with `reachable`, `no_path`, and
`unknown/not_applicable` states plus confidence and graph freshness. It should
change ranking and verification effort, never silently erase a concern merely
because a static graph found no path.

### Fixability and fix verification

- **D:** Open Source distinguishes `fixable`, `partially fixable`, and `no
  supported fix`. Fixability is based on whether all dependency paths have a
  supported remediation, while “fixed in” merely states that some secure package
  version exists. Snyk limits automatic transitive-dependency fixes to avoid
  breaking changes and supplies recommendations when it cannot safely construct a
  fix PR ([vulnerability fix types](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-open-source/manage-vulnerabilities/vulnerability-fix-types.md)).
- **D:** Snyk Code's Agent Fix documents a detector-in-the-loop process: retrieve
  CWE-specific human-written examples, generate multiple candidates, rescan each
  candidate to require that the original issue disappears and no new issue is
  introduced, and retry with scan feedback. The docs also require human review,
  limit automated output to single-file fixes, and suppress suggestions when the
  loop cannot meet its security/functional benchmarks
  ([Snyk Agent Fix](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/manage-code-vulnerabilities/fix-code-vulnerabilities-automatically.md)).
- **D:** IaC reports administrator-selected checks and recommendations rather than
  promising an automatically verified edit
  ([Terraform scan and fix](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-iac/scan-your-iac-source-code/scan-terraform-files/scan-and-fix-security-issues-in-terraform-files-current-iac.md)).
  Container's Dockerfile workflow recommends less vulnerable official base images
  and can open a PR changing the final-stage `FROM` line, but its docs tell users
  to verify application behavior before merging
  ([Dockerfile fix PRs](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-container/scan-your-dockerfile/fix-vulnerable-base-images-in-your-dockerfile.md)).

**Transfer:** fixability is useful review metadata even when Leveret never edits a
PR. A finding that includes a bounded, verified remedy is cheaper to act on than
one with no known safe remediation. Detector-specific rechecks are stronger than
an LLM merely asserting that its suggested patch works.

### PR checks, incremental behavior, and caching

- **D:** Snyk PR Checks run live tests of the before and after branches and fail
  only when the new branch has more issues. A code change triggers analysis across
  the entire repository, so the comparison is differential even though the Code
  scan itself is not documented as changed-files-only
  ([PR Checks](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks.md)).
- **D:** Gates can be scoped by analyzer, severity, “dependency added with issues”
  versus “repository has any issues,” and fix availability. Snyk notes that the
  fix-available gate depends on ecosystem FixPR support
  ([PR Check configuration](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks/configure-pull-request-checks.md)).
- **D:** The PR surface publishes pass/fail and a summary comment grouped by check
  type and severity; SCM branch protection decides whether failure blocks merge
  ([PR Checks](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks.md)).
- **D:** Container integrations can retain an installed-software snapshot and
  reevaluate an unchanged image against newly disclosed vulnerabilities without
  reaccessing the image. Changed images must be reimported, and recurring scans do
  not discover dependency changes absent reimport
  ([recurring container scans](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-container/how-snyk-container-works.md)).
- **D:** Enabling the Early Access Risk Score requires a retest; the docs state
  Open Source projects are automatically retested daily and Container projects
  weekly ([Risk Score retesting](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/risk-score.md)).

**Unverified:** the reviewed public sources do not disclose Snyk Code parse/index
cache keys, cross-PR cache reuse, invalidation rules, hit rates, stage timings, or
whether before/after scans share internal work. “Full scan” must not be rewritten
as “cold scan”; no cache conclusion follows.

### False-positive controls and structured output

- **D:** Snyk ignores can be temporary, permanent, or “until a fix is available,”
  carry reasons and expiry, and propagate from the web project to subsequent PR
  checks. CLI/Open Source ignores can live in a repository `.snyk` file with a
  dependency path, reason, and expiry
  ([ignore issues](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/ignore-issues.md),
  [`.snyk` policy file](https://docs.snyk.io/scan-fix-and-prevent/prevent/policies/the-.snyk-file.md)).
- **D:** Snyk Code uses an intermediate representation to recognize an ignored
  issue through some refactors and variable renames rather than relying only on a
  raw line fingerprint ([Code ignores](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/ignore-issues.md#ignore-issues-in-snyk-code)).
- **D:** Rule Extensions let an organization register fully qualified sanitizer
  functions and sanitizer semantics so taint paths through trusted validation are
  not reported. The docs warn that the wrong sanitizer type can hide real issues
  ([custom sanitizers](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/rule-extensions/custom-sanitizers.md)).
- **O:** Before publishing a Rule Extension, the Impact Testing API can run it on a
  selected project and return `added_findings`, `removed_findings`, counts, rule,
  location, severity, path, and priority score
  ([impact testing](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/rule-extensions/impact-testing.md)).
- **O:** `snyk code test` exposes issue sink path/line, data-flow information,
  severity summaries, process exit status, severity filtering, and JSON or SARIF
  output/file export
  ([Code CLI results](https://docs.snyk.io/developer-tools/snyk-cli/snyk-cli/scan-and-maintain-projects-using-the-cli/snyk-cli-for-snyk-code/view-snyk-code-cli-results.md)).

**Transfer:** trusted guidance that changes detector semantics needs an impact test,
not immediate activation. Leveret's priced-noise memory can remain post-detection;
custom sanitizer/rule knowledge is a different, higher-risk control plane because
it can prevent candidate creation entirely.

## Aikido: documented mechanisms

### Analyzer families, local execution, and applicability

- **D:** Aikido's repository checks cover OSS dependencies, secrets, licenses,
  SAST, IaC, malware, and mobile findings; separate product views cover cloud,
  containers, domains, and APIs
  ([Aikido Security Checks](https://help.aikido.dev/getting-started/core-functionalities/aikido-security-checks.md)).
- **D:** Aikido documents a custom risk model layered over customized open-source
  engines. The current support table names Aikido Engine plus Opengrep for SAST,
  Checkov for IaC, and Gitleaks plus liveness checks for secrets. It separately
  declares whether taint analysis is cross-file or within-file for each language
  ([SAST/IaC support](https://help.aikido.dev/code-scanning/scanning-practices/sast-by-aikido-supported-languages-and-security-focus.md)).
- **D:** Cross-file SAST traces untrusted input through function calls to dangerous
  sinks and exposes a call graph in “View code analysis.” The dedicated page lists
  the languages with cross-file versus intra-file support
  ([multi-file vulnerability tracing](https://help.aikido.dev/code-scanning/scanning-practices/multifile-vulnerability-tracing.md)).
- **D:** SCA scans on every push and PR, in the IDE, and on a default daily
  scheduled rescan so new CVEs can surface without a dependency change. It scans
  supported lockfiles/manifests in both the repository root and all subfolders
  ([SCA language support](https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language.md)).
- **O:** The local scanner can explicitly select `code`, `dependencies`, `iac`, and
  `secrets`; exclude paths; disable artifact scanning; include dev dependencies;
  scan complete Git history for secrets; and choose release or PR gating. Its PR
  mode requires base/head commits and seeks only new branch vulnerabilities
  ([local scanner options](https://help.aikido.dev/code-scanning/local-code-scanning/cli-options-for-local-scanner.md)).

**Monorepo/application boundary:** Aikido documents recursive manifest discovery,
but not a general automatic application-boundary detector. Its monorepo split is
manual path configuration, limited in the reviewed docs to GitLab and Azure
DevOps, and supports SCA/SAST/IaC but not secrets
([SCA language support](https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language.md),
[split a monorepo](https://help.aikido.dev/code-scanning/miscellaneous/split-your-monorepo-per-path.md)).
Any stronger “automatic app detection” claim is unverified.

### Reachability, contextual triage, and prioritization

- **D:** Aikido describes a graph of functions, methods, modules, files, calls,
  imports, dependency inclusion, and data flow. Findings are anchored to vulnerable
  dependency symbols or SAST sinks, and queries start from framework-aware entry
  points such as handlers, CLI commands, and jobs
  ([reachability introduction](https://help.aikido.dev/getting-started/reachability-analysis/introduction-to-reachability-analysis.md)).
- **D:** Its reachability stages distinguish dependency-level symbol use,
  function-level source/sanitizer/sink flow, and runtime context such as
  production versus build/test dependencies. Findings with no path are removed or
  downgraded before later scoring, while concrete paths remain inspectable
  ([reachability introduction](https://help.aikido.dev/getting-started/reachability-analysis/introduction-to-reachability-analysis.md),
  [reachability examples](https://help.aikido.dev/getting-started/reachability-analysis/reachability-engine-to-remove-false-positives.md)).
- **D:** The docs call the analysis a conservative under-approximation: when
  reflection, dynamic imports, metaprogramming, or build steps make the graph
  ambiguous, Aikido says it retains or only lowers the issue rather than declaring
  it unreachable. It also rechecks reachability after dependency and code changes
  ([reachability limitations](https://help.aikido.dev/getting-started/reachability-analysis/introduction-to-reachability-analysis.md),
  [reachability examples](https://help.aikido.dev/getting-started/reachability-analysis/reachability-engine-to-remove-false-positives.md)).
- **D:** SAST AutoTriage is explicitly downstream of scanning. Rules handle most
  findings; for some complex cases a reasoning model receives a call-tree-derived
  context pack. Reachability first attempts to rule out exploitability, then
  remaining findings are ranked by exploitability and impact, including
  sanitization, trusted stores, prod/test use, data sensitivity, and selected
  semantic edge cases ([SAST AutoTriage](https://help.aikido.dev/aikido-agent/sast-autotriage.md)).
- **D:** Aikido's 0–100 severity score combines vulnerability feeds with contextual
  factors including KEV/public exploits, production versus test, backend versus
  frontend, reachability, customer-set asset context, and optional EPSS-based
  downgrade/ignore rules ([severity score](https://help.aikido.dev/getting-started/core-functionalities/how-is-severity-score-calculated.md)).

**Transfer:** the architecture worth testing is deterministic/rule-based reduction
first, bounded graph context second, and model reasoning only for the residual
ambiguous cases. It is not the unsupported claim that Aikido's false-positive rate
will transfer to general code review.

### PR checks, Deep Review, and feedback lifecycle

- **D:** Aikido PR gating covers SCA, IaC, secrets, SAST, malware, license risk,
  and code quality. Native GitHub/GitLab/Bitbucket/Azure integrations or a CI/local
  scanner can apply a minimum-severity gate, choose scan types, keep checks
  non-blocking, skip drafts, and distinguish new from fixed branch issues
  ([PR Gating](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality.md)).
- **D:** Inline PR comments can represent SAST, secrets, IaC, SCA, code quality,
  and Deep Review findings. Available AutoFix suggestions can be applied from the
  PR, and later scans resolve or remove a comment after confirming the issue is
  fixed ([inline comments](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality/autofix-suggestions-and-inline-commenting-for-pr-checks.md)).
- **D:** Deep Review is the separately documented agentic reviewer. It retrieves
  relevant repository context beyond changed lines, can use manually linked
  repositories for shared-library/API/service context, and posts PR comments
  ([Deep Review](https://help.aikido.dev/deep-review/how-deep-review-works.md)).
- **D:** A developer can reply in natural language to ignore a Deep Review finding
  or provide contrary context. The reviewed documentation says supplied context
  improves future reviews but also says shared memory across reviews is “coming
  soon”; no current persistent-memory mechanism is documented
  ([Deep Review feedback](https://help.aikido.dev/deep-review/how-deep-review-works.md)).

**Unverified:** Deep Review's retrieval algorithm, prompt topology, verification
stage, model routing, cache, worker count, and measured review precision/latency
are not disclosed in the reviewed sources. “Context beyond the diff” supports a
product capability, not a CodeRabbit-parity architecture claim.

### Incrementality and cache surfaces

- **D:** Native PR gating is documented as scanning the branch diff; local PR mode
  requires exact base/head commits and targets only newly introduced findings
  ([PR Gating](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality.md),
  [local scanner options](https://help.aikido.dev/code-scanning/local-code-scanning/cli-options-for-local-scanner.md)).
- **D:** Daily SCA rescans catch newly disclosed CVEs in unchanged dependencies
  ([SCA language support](https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language.md)).
- **O:** The local scanner exposes `--no-lockfiles-cache`, described as disabling
  dependency/lockfile caching used for automated rescans. It also exposes an
  artifact-scanning trade-off that can save time at the cost of not inspecting
  artifacts such as JARs
  ([local scanner options](https://help.aikido.dev/code-scanning/local-code-scanning/cli-options-for-local-scanner.md)).

**Unverified:** these interfaces do not reveal Aikido's parse/graph cache,
dependency invalidation, cache identity, hit rate, warm/cold timing, or whether
Deep Review reuses prepared repository context. The docs also do not establish
whether every underlying analyzer executes only on changed files; “scans the
branch diff” is a gate/product contract, not a disclosed scheduler.

### False-positive controls, fix guidance, and reporting

- **D:** A repository `.aikido` file can exclude paths, ignore named CVEs with a
  reason, and configure AutoFix behavior. Path matching is simple string inclusion,
  not glob or regex matching
  ([`.aikido` configuration](https://help.aikido.dev/code-scanning/scanning-practices/ignore-via-code-with-aikido-files.md)).
- **D:** UI ignores can apply to one issue/group, a path, a CVE across repositories,
  or a rule across repositories. The ignored view retains automatic and manual
  exclusions and their rationale
  ([ignore issues](https://help.aikido.dev/getting-started/core-functionalities/ignore-issues-to-remove-issues-from-main-feed.md)).
- **D:** An optional approval inbox keeps a finding visible until an authorized
  reviewer accepts a reasoned ignore request and records requester, reviewer, and
  decision, providing a risk-acceptance audit trail
  ([ignore approval](https://help.aikido.dev/getting-started/core-functionalities/approval-inbox-for-ignored-issues.md)).
- **D:** SAST/IaC AutoFix provides a patch preview, confidence class, SCM PR or IDE
  application, and explicitly recommends manual review
  ([SAST/IaC AutoFix](https://help.aikido.dev/autofix-and-remediation/scope/ai-autofix-for-sast-and-iac-issues.md)).
  The documented multi-layer automated plus human patch testing applies only to
  Aikido Images and Aikido Libraries, not to SAST/IaC AI AutoFix; it must not be
  generalized ([patch testing scope](https://help.aikido.dev/autofix-and-remediation/faq/how-are-patches-tested.md)).
- **O:** Local gating can write issues to a JSON file. The CI API accepts exact
  base/head, PR metadata, enabled scanner gates, severity, custom Checkov SARIF,
  and Syft JSON SBOMs. Its status response exposes per-scanner completion booleans,
  new-issue counts by category, a diff URL, and final gate status
  ([local scanner options](https://help.aikido.dev/code-scanning/local-code-scanning/cli-options-for-local-scanner.md),
  [CI API](https://help.aikido.dev/pr-and-release-gating/cli-for-pr-and-release-gating/aikido-ci-api.md)).
- **D:** CI Scan History records past scan status plus newly introduced and
  resolved issues and links to the scan diff
  ([CI Scan History](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality/ci-scan-history-overview.md)).

**Transfer:** suppression must remain reviewable state rather than disappearance;
a machine-facing run should expose each analyzer's applicability, completion,
counts, failure/degradation, delta, and evidence link independently of the final
pass/fail summary.

## Dimension-by-dimension comparison

Every vendor cell below is either cited vendor documentation (**D**) or a public
interface/schema inspected in that documentation (**O**). The last column is a
Leveret inference (**I**).

| #64 dimension | Snyk | Aikido | Transfer to Leveret and existing owner |
| --- | --- | --- | --- |
| Applicability routing | **D:** Product-specific scanners declare supported languages/artifacts; native PR checks route Code, Open Source, and license checks, with Code performing a full-repository scan ([configuration](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks/configure-pull-request-checks.md)). | **O:** Local scans select code/dependencies/IaC/secrets, exclude paths, and trade artifact coverage for speed; language tables declare cross-file versus intra-file analysis ([CLI options](https://help.aikido.dev/code-scanning/local-code-scanning/cli-options-for-local-scanner.md), [language support](https://help.aikido.dev/code-scanning/scanning-practices/sast-by-aikido-supported-languages-and-security-focus.md)). | **I:** Add an evidence-pack capability manifest and route only applicable analyzers/leads to a leg. [#58](https://github.com/leveret-dev/leveret/issues/58) owns leg/tool routing; [#60](https://github.com/leveret-dev/leveret/issues/60) owns the compact shared manifest. |
| Analyzer breadth | **D:** SAST, SCA/license, IaC/cloud, and container/image inventories are separate analyzers and lifecycles ([Code](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code.md), [Open Source](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-open-source.md), [IaC](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-iac.md), [Container](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-container/how-snyk-container-works.md)). | **D:** Repository gates span SAST/SCA/IaC/secrets/malware/license/code quality, with cloud/container/domain families outside that gate ([PR gating](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality.md), [security checks](https://help.aikido.dev/getting-started/core-functionalities/aikido-security-checks.md)). | **I:** Preserve analyzer identity and lifecycle; do not flatten unlike results into generic “scan leads.” [#50](https://github.com/leveret-dev/leveret/issues/50) owns normalized deterministic lead handling; [#58](https://github.com/leveret-dev/leveret/issues/58) owns discipline-specific consumers. |
| Reachability/context | **D:** Snyk joins application and dependency call graphs but says no-path is not proof of unreachable ([reachability](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/reachability-analysis.md)). | **D:** Aikido documents entry-point, call/import/dependency/data-flow graphs, production/test context, inspectable paths, and conservative ambiguity handling ([reachability](https://help.aikido.dev/getting-started/reachability-analysis/introduction-to-reachability-analysis.md)). | **I:** Store path, confidence, coverage limit, source SHA, and freshness; route `unknown` for deeper review. [#38](https://github.com/leveret-dev/leveret/issues/38) owns persistent graph context; [#48](https://github.com/leveret-dev/leveret/issues/48) owns honest coverage state. |
| Prioritization | **D:** Risk Score composes impact, exploit likelihood, business criticality, reachability, and dependency depth ([Risk Score](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/risk-score.md)). | **D:** Rules/reachability precede model triage; residual issues are ranked using exploitability, impact, asset context, KEV/EPSS, prod/test, and sanitization ([AutoTriage](https://help.aikido.dev/aikido-agent/sast-autotriage.md), [severity](https://help.aikido.dev/getting-started/core-functionalities/how-is-severity-score-calculated.md)). | **I:** Rank on separable evidence dimensions rather than one opaque score; send the ambiguous tail, not every raw hit, to model verification. [#50](https://github.com/leveret-dev/leveret/issues/50) owns pre-cap suppression/accounting; [#58](https://github.com/leveret-dev/leveret/issues/58) owns verifier consolidation. |
| Fixability | **D:** Open Source distinguishes full/partial/no supported fix; Code fixes are rescanned and retried, but require human review ([fix types](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-open-source/manage-vulnerabilities/vulnerability-fix-types.md), [Agent Fix](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/manage-code-vulnerabilities/fix-code-vulnerabilities-automatically.md)). | **D:** SAST/IaC fixes expose preview/confidence/manual review; no general automated-validation contract was found ([AutoFix](https://help.aikido.dev/autofix-and-remediation/scope/ai-autofix-for-sast-and-iac-issues.md), [patch-test scope](https://help.aikido.dev/autofix-and-remediation/faq/how-are-patches-tested.md)). | **I:** Add `fixability` and verification evidence to concern/verdict schemas; use the original detector as an oracle where possible. [#48](https://github.com/leveret-dev/leveret/issues/48) owns strict concern/verdict accounting; [#61](https://github.com/leveret-dev/leveret/issues/61) owns runnable counterexample/fix evidence. |
| Incremental scans/cache | **D:** PRs compare before/after but Code scans the repository; unchanged image inventories can be reevaluated against new vulnerability data without image access ([PR Checks](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks.md), [container rescans](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-container/how-snyk-container-works.md)). | **D/O:** PR gates target new diff findings, SCA rescans unchanged dependencies daily, and local scanning exposes a lockfile cache for automated rescans ([PR gating](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality.md), [SCA](https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language.md), [CLI options](https://help.aikido.dev/code-scanning/local-code-scanning/cli-options-for-local-scanner.md)). | **I:** Separate source-change invalidation from knowledge/rule-change invalidation. [#38](https://github.com/leveret-dev/leveret/issues/38) owns exact-SHA reusable graph snapshots, but no existing #64 child owns analyzer preparation/result-cache invalidation; add one rather than widening #38. |
| CI/PR integration | **D:** Webhooks trigger before/after scans, pass/fail, review notes, summary counts, and optional SCM blocking ([PR Checks](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks.md)). | **D:** Native or pipeline gates select scanners/severity, distinguish new/fixed issues, publish inline comments, and resolve comments after fixes ([PR gating](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality.md), [inline comments](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality/autofix-suggestions-and-inline-commenting-for-pr-checks.md)). | **I:** Treat `new`, `persisting`, `fixed`, and `reopened` as finding lifecycle states tied to exact base/head. [#59](https://github.com/leveret-dev/leveret/issues/59) owns exact PR/work-item identity; [#48](https://github.com/leveret-dev/leveret/issues/48) owns comment/coverage disposition consistency. |
| False-positive controls | **D/O:** Scoped/expiring/reasoned ignores, refactor-stable Code ignores, custom sanitizers, and pre-publication impact tests ([ignores](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/ignore-issues.md), [sanitizers](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/rule-extensions/custom-sanitizers.md), [impact tests](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/rule-extensions/impact-testing.md)). | **D:** Reachability/rules auto-ignore first; manual ignores have issue/path/CVE/rule scope and optional approval/audit ([AutoTriage](https://help.aikido.dev/aikido-agent/sast-autotriage.md), [ignores](https://help.aikido.dev/getting-started/core-functionalities/ignore-issues-to-remove-issues-from-main-feed.md), [approval](https://help.aikido.dev/getting-started/core-functionalities/approval-inbox-for-ignored-issues.md)). | **I:** Separate post-detection pricing from detector-semantic exceptions; require trusted authority, reason, scope, expiry, impact test, and rollback for the latter. [#42](https://github.com/leveret-dev/leveret/issues/42) owns authority/provenance; [#45](https://github.com/leveret-dev/leveret/issues/45) owns durable corrected/dead-end learning. |
| Structured reporting | **O/D:** Code emits sink/data-flow/severity plus JSON/SARIF; PR summaries group checks and severity ([CLI results](https://docs.snyk.io/developer-tools/snyk-cli/snyk-cli/scan-and-maintain-projects-using-the-cli/snyk-cli-for-snyk-code/view-snyk-code-cli-results.md), [PR Checks](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks.md)). | **O/D:** Local gates write JSON; CI status includes per-scanner completion and issue counts; history records new/resolved status and diff links ([CLI options](https://help.aikido.dev/code-scanning/local-code-scanning/cli-options-for-local-scanner.md), [CI API](https://help.aikido.dev/pr-and-release-gating/cli-for-pr-and-release-gating/aikido-ci-api.md), [history](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality/ci-scan-history-overview.md)). | **I:** Keep a versioned machine run envelope separate from the human walkthrough. [#51](https://github.com/leveret-dev/leveret/issues/51) owns full audit traces; [#48](https://github.com/leveret-dev/leveret/issues/48) owns strict final schemas and complete accounting. |

## What is genuinely new beyond the CodeRabbit inspiration

Issue #64 already records CodeRabbit-style applicable-tool selection, bounded
repository/context retrieval, verification/ranking, incremental reviews, reusable
preparation caches, parallel specialized agents, and structured trace/report
requirements. Snyk and Aikido do **not** justify duplicating those ideas. They add
six materially different design pressures:

1. **Reachability is a typed, explainable, freshness-sensitive finding input, not
   merely “more repository context.”** Both vendors warn—explicitly or by guarded
   ambiguity behavior—that static no-path evidence is not proof of safety
   ([Snyk](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/reachability-analysis.md),
   [Aikido](https://help.aikido.dev/getting-started/reachability-analysis/introduction-to-reachability-analysis.md)).
2. **Applicability has a product contract.** Scanner target type, language,
   analysis depth, gate eligibility, and degradation should be declared before
   execution, not inferred from whichever binary happens to return output
   ([Snyk PR scanner types](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks/configure-pull-request-checks.md),
   [Aikido local scanner types](https://help.aikido.dev/code-scanning/local-code-scanning/cli-options-for-local-scanner.md)).
3. **Fixability is independent of severity.** Full, partial, recommendation-only,
   and detector-verified remedies should affect actionability without suppressing
   a real issue ([Snyk fix types](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-open-source/manage-vulnerabilities/vulnerability-fix-types.md),
   [Snyk detector loop](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/manage-code-vulnerabilities/fix-code-vulnerabilities-automatically.md)).
4. **Rule/knowledge change invalidation differs from source invalidation.** An
   unchanged artifact can acquire a new vulnerability result; cached inventory and
   cached verdict are not the same object
   ([Snyk container rescans](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-container/how-snyk-container-works.md),
   [Aikido scheduled SCA](https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language.md)).
5. **Detector-semantic exceptions need prepublication impact tests.** Teaching a
   taint engine a sanitizer can create false negatives, so its blast radius must be
   measured before activation
   ([Snyk sanitizers](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/rule-extensions/custom-sanitizers.md),
   [impact testing](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/rule-extensions/impact-testing.md)).
6. **Risk acceptance is a governed workflow.** Reason, scope, expiry, requester,
   approver, and future-match behavior are useful first-class data rather than a
   hidden suppression bit
   ([Snyk ignores](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/ignore-issues.md),
   [Aikido approval inbox](https://help.aikido.dev/getting-started/core-functionalities/approval-inbox-for-ignored-issues.md)).

## Ordered Leveret experiments / issue additions

1. **Extend #58/#60 with an applicability manifest experiment.** Before any model
   call, emit target kind, language/ecosystem, changed artifacts, candidate
   analyzers, analysis depth, expected schema, gate eligibility, and explicit
   non-applicability reason. Route the relevant subset to each leg and measure
   avoided work plus missed findings. This operationalizes the scanner contracts
   documented by [Snyk](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks/configure-pull-request-checks.md)
   and [Aikido](https://help.aikido.dev/code-scanning/local-code-scanning/cli-options-for-local-scanner.md).
2. **Extend #38/#48 with typed reachability evidence.** Add `reachable`,
   `no_path`, `unknown`, and `not_applicable`, plus path/evidence IDs, graph SHA,
   coverage limitations, and freshness. Benchmark ranking with and without this
   feature, but prohibit `no_path` from mechanically producing “clean.” This
   follows both vendors' guarded static-analysis limits
   ([Snyk](https://docs.snyk.io/scan-fix-and-prevent/fix/prioritize-issues-for-fixing/reachability-analysis.md),
   [Aikido](https://help.aikido.dev/getting-started/reachability-analysis/introduction-to-reachability-analysis.md)).
3. **Extend #50/#58 with deterministic-first residual triage.** Apply exact
   applicability, trusted suppression, reachability, and contextual facts before
   the cap; reserve model reasoning for ambiguous residual leads. Record every
   stage's disposition so noise reduction cannot masquerade as coverage. Aikido
   explicitly documents this order
   ([AutoTriage](https://help.aikido.dev/aikido-agent/sast-autotriage.md)).
4. **Extend #48/#61 with fixability and detector-oracle fields.** Classify findings
   as `verified_fix`, `candidate_fix`, `recommendation_only`, or `no_known_fix`;
   where a deterministic detector raised the concern, apply the candidate in an
   isolated probe and rerun that detector before presenting it as verified. Do not
   auto-edit PRs. The testable mechanism is Snyk's scan/generate/rescan loop, not
   its “production-ready” wording
   ([Agent Fix](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/manage-code-vulnerabilities/fix-code-vulnerabilities-automatically.md)).
5. **Add a new #64 child for analyzer cache and invalidation contracts.** #38's
   graph snapshots are related but should not absorb scanner preparation/results.
   Key cached artifacts by repository/base/head, analyzer/rule version,
   ecosystem, manifest/lockfile digest, configuration hash, and knowledge snapshot;
   distinguish reusable inventory from a reevaluated verdict. Measure warm/cold
   time and invalidation correctness using unchanged-input/new-rule fixtures
   inspired by [Snyk container snapshots](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-container/how-snyk-container-works.md)
   and [Aikido scheduled SCA](https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language.md).
6. **Extend #42/#45 with a governed detector-exception experiment.** Keep current
   priced-noise memory post-detection. For exceptions that alter detection itself,
   require maintainer authority, target analyzer/rule/function, reason, expiry,
   corpus impact showing added/removed findings, and atomic rollback. Snyk's
   sanitizer impact test is the concrete reusable precedent
   ([custom sanitizers](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/rule-extensions/custom-sanitizers.md),
   [impact testing](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/rule-extensions/impact-testing.md)).
7. **Extend #59/#48 with finding lifecycle reconciliation.** For every exact
   base/head, mechanically classify stable finding IDs as new, persisting, fixed,
   reopened, ignored, or unverifiable; resolve comments only after the responsible
   analyzer or verifier confirms the fix. Aikido documents both new/fixed branch
   views and resolved comment behavior
   ([PR gating](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality.md),
   [inline comments](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality/autofix-suggestions-and-inline-commenting-for-pr-checks.md)).
8. **Extend #51/#48's run schema with per-analyzer status.** Record applicability,
   started/completed/degraded/failed, version/config hash, counts by disposition,
   new/fixed deltas, timing/cache state, evidence IDs, and final gate/publication
   decision. Generate the human walkthrough from this envelope rather than making
   prose the source of truth. Aikido's public CI response demonstrates the minimum
   useful separation of scanner completion and aggregate gate status
   ([CI API](https://help.aikido.dev/pr-and-release-gating/cli-for-pr-and-release-gating/aikido-ci-api.md));
   Snyk's JSON/SARIF output demonstrates portable finding records
   ([Code CLI results](https://docs.snyk.io/developer-tools/snyk-cli/snyk-cli/scan-and-maintain-projects-using-the-cli/snyk-cli-for-snyk-code/view-snyk-code-cli-results.md)).

## Claims deliberately left unverified

- No public source reviewed here establishes either vendor's independent
  precision, recall, false-positive rate, CodeRabbit overlap, or performance on
  Leveret's frozen #64 corpus.
- No source establishes Snyk Code or Aikido Deep Review's private prompt topology,
  model roster, worker concurrency, retrieval algorithm, candidate-verification
  topology, or cache-hit behavior
  ([Snyk Code](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code.md),
  [Aikido Deep Review](https://help.aikido.dev/deep-review/how-deep-review-works.md)).
- Snyk's before/after comparison does not prove changed-files-only execution; its
  docs explicitly say Code performs a full repository scan
  ([Snyk PR Checks](https://docs.snyk.io/scan-fix-and-prevent/prevent/pull-request-checks.md)).
  Aikido's “scans the diff” contract does not disclose whether each underlying
  analyzer is itself incremental
  ([Aikido PR gating](https://help.aikido.dev/pr-and-release-gating/aikido-ci-gating-functionality.md)).
- Aikido's documentation does not verify general automatic app-boundary detection;
  it verifies recursive manifest discovery and manual path splitting only
  ([SCA support](https://help.aikido.dev/code-scanning/scanning-practices/support-for-dependency-scanning-by-language.md),
  [monorepo split](https://help.aikido.dev/code-scanning/miscellaneous/split-your-monorepo-per-path.md)).
- Aikido's automated/human patch-test matrix applies to Images and Libraries, not
  SAST/IaC AI AutoFix
  ([patch testing](https://help.aikido.dev/autofix-and-remediation/faq/how-are-patches-tested.md)).
  Snyk's detector rescans prove only the documented security checks, not full
  application behavior
  ([Snyk Agent Fix](https://docs.snyk.io/scan-fix-and-prevent/scan-with-snyk/snyk-code/manage-code-vulnerabilities/fix-code-vulnerabilities-automatically.md)).
- Neither vendor's public docs provide the warm-cache p50/p95 stage timing,
  reference hardware, model cost, or completed-run reliability needed by #64's
  parity gate. Those remain Leveret benchmark obligations, not vendor facts.
