# Tool-assisted review guidance for the CodeRabbit recall gaps

Status: primary-source research, 2026-08-24. This note proposes checks and
retrieval design only; it does not implement rules or change reviewer prompts.

## Scope and conclusion

The source set is the twelve mechanisms still missed after the latest replay
recovered the stale generated-URL finding: five from pfBlockerNG
[#2444](https://github.com/pfBlockerNG/pfBlockerNG/pull/2444) at `ed359c69` and
seven from [#2521](https://github.com/pfBlockerNG/pfBlockerNG/pull/2521) at
`b312a6de`.

No checked tool would have emitted any of the twelve exact findings as written.
ShellCheck has one related rule, SC2259, but it applies only when a pipeline
stage also redirects its input; the missed smoke implementation contained only
`/bin/sh < file`, so the rule correctly remained silent. The complete checked
catalogs were ShellCheck 0.11.0, actionlint's documented checks, zizmor's audit
registry, and the Semgrep community rules at commit `40b8c63`; ast-grep supplies
a rule engine rather than a relevant built-in catalog
([ShellCheck analyzer and options](https://github.com/koalaman/shellcheck/blob/9af7ee28ce587baadd950b85dd6826a16b9c068d/shellcheck.1.md),
[actionlint checks](https://github.com/rhysd/actionlint/blob/011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7/docs/checks.md),
[zizmor audits](https://github.com/zizmorcore/zizmor/blob/75dc69ba6fee36fd4b359886bff6284de13d4fe6/docs/audits.md),
[Semgrep catalog snapshot](https://github.com/semgrep/semgrep-rules/tree/40b8c63f75dc7c22c8a77482d73bfb864b146f7e),
[ast-grep rule essentials](https://ast-grep.github.io/guide/rule-config.html)).

The gaps divide into four defect classes:

1. **Unenforced output invariants:** hook mode and required generated artifacts
   (1–2).
2. **Test fidelity and vacuity:** incomplete list/negative coverage, different
   transport, incomplete shell-command parsing, workflow-wide instead of
   job-local checks, and comment/substr matching (3–5, 10–12).
3. **Runner sequencing, command identity, and prerequisites:** udev settling,
   diverted `tar`, and incomplete preflight inventory (6–8).
4. **Framework environment guidance:** invoking pytest outside uv's project
   environment (9).

The best near-term split is:

- keep the existing deterministic belt for adjacent syntax/security findings;
- add a few small semantic checks where the contract is explicit and literal;
- use versioned language/framework caveat cards for facts that tools cannot infer;
- reserve model judgment for undeclared universes, intent, runtime identity, and
  whether a test really exercises the stated contract.

### Local mode probes on the replay mechanisms

The installed tools were also exercised rather than credited from option names:

- ShellCheck 0.11.0 with `--enable=all` over representative missed shell shapes
  (`fetch | sh`, the unequal branch-only `chmod`, incomplete preflight, bare
  `tar`) emitted only SC2154/SC2250 hygiene findings, not the target mechanisms.
- zizmor 1.29.0 `--pedantic` over the exact #2521 tree emitted 262 findings:
  132 `unpinned-uses`, 57 `template-injection`, 43
  `undocumented-permissions`, 16 `concurrency-limits`, and 14 across four other
  security/smell audits. None represented the seven missed operational/test
  contracts. This mode would add substantial priced noise without closing recall.
- Ruff `--select ALL` over the three missed Python test guards emitted only
  complexity, formatting, docstring, assertion-use, and copyright diagnostics.
  It did not identify incomplete command parsing, workflow job-scope collapse, or
  source-substring vacuity.

These probes reinforce the catalog result: stricter selection increases adjacent
diagnostics, but it does not manufacture the missing project invariants.

## What the existing tools and stricter modes actually provide

### ShellSpec: diagnostics and formatters are not adequacy analysis

ShellSpec was checked at upstream commit `f2d13f9` rather than credited by
analogy with other test frameworks.

- `--syntax-check` checks the specfile without running examples. `--dry-run`
  prints formatter output without running examples. `--xtrace` traces the
  evaluation, and `--xtrace-only` executes the evaluation but skips
  expectations. These are syntax/debugging modes, not vacuity or mutation
  checks
  ([option definitions](https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/lib/libexec/optparser/parser_definition.sh#L137-L170)).
- `--format` selects `progress`, `documentation`, `tap`, `junit`, `failures`,
  `null`, or `debug`. The formatters render result events; the summary counts
  examples and result categories, not expectations or assertions
  ([CLI](https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/docs/cli.md#reporter---format--generator---output),
  [summary source](https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/lib/libexec/reporter/summary_formatter.sh#L5-L42)).
- `--fail-no-examples` fails only when the entire run contains no examples. It
  does not detect a missing parameter row or an example with a weak assertion
  ([option source](https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/lib/libexec/optparser/parser_definition.sh#L67-L76)).
- `--sandbox` empties and locks `PATH` except ShellSpec support paths, which can
  expose a reached unstubbed command. Absolute commands still run, the mode is
  not security isolation, and it does not infer a project's preflight contract
  ([sandbox documentation](https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/docs/cli.md#sandbox-mode---sandbox)).
- Kcov integration is line coverage, requires Kcov, supports only bash/zsh/ksh,
  omits external commands and other documented paths, and has no documented
  branch, mutation, assertion, or vacuity coverage. It therefore cannot prove
  the list-boundary and negative-assertion mechanisms, and is unavailable for a
  suite deliberately run under dash
  ([coverage documentation](https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/README.md#code-coverage)).
- ShellSpec does provide explicit `exist` and `be executable` path matchers and
  parameter tables. Those catch mechanisms 1–4 only after the required artifact
  or scenario universe has been explicitly supplied; `be executable` does not
  require exact mode `0755`
  ([path matchers](https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/docs/references.md#L417-L445),
  [parameters](https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/docs/references.md#L739-L795)).

Thus `--syntax-check`, `--xtrace`, `debug`, `--sandbox`, `--random`, and Kcov are
useful diagnostics or test-development aids, but none is an automatic recall
answer for these twelve defects.

### ShellCheck, actionlint, zizmor, and workflow schemas

- ShellCheck's extended analysis is enabled by default. `--enable=all` enables
  optional checks, while `--check-sourced` and `--external-sources` broaden
  source analysis. These switches only select or extend registered checks; they
  do not add project invariants, test mutation, or cross-file completeness
  ([manual](https://github.com/koalaman/shellcheck/blob/9af7ee28ce587baadd950b85dd6826a16b9c068d/shellcheck.1.md#options)).
- SC2259 reports when a redirection overrides piped input, for example
  `ls | grep foo < file`. It cannot compare a test description claiming a pipe
  with an implementation that uses only file redirection
  ([SC2259](https://www.shellcheck.net/wiki/SC2259),
  [rule source](https://github.com/koalaman/shellcheck/blob/9af7ee28ce587baadd950b85dd6826a16b9c068d/src/ShellCheck/Analytics.hs#L3716-L3783)).
- actionlint validates workflow shape, expressions, job dependencies, matrices,
  events, runners, action inputs, and related syntax. It invokes ShellCheck on
  each Bash/sh `run:` block independently; it has no cross-step command-state
  model
  ([check catalog](https://github.com/rhysd/actionlint/blob/011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7/docs/checks.md),
  [ShellCheck visitor](https://github.com/rhysd/actionlint/blob/011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7/rule_shellcheck.go#L53-L61)).
  A custom Go rule can be injected through `LinterOptions.OnRulesCreated`, but
  this is an embedding API, not an `actionlint.yaml` rule facility
  ([upstream example](https://github.com/rhysd/actionlint/blob/011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7/example_your_own_rule_test.go#L11-L48)).
- zizmor is valuable for its registered GitHub Actions security audits, not
  these operational contracts. Its `adhoc-packages` audit currently recognizes
  JavaScript and Ruby package tools, not `pip`/`pip3`; its configuration can
  tune existing audits but cannot define arbitrary new ones
  ([audit catalog](https://github.com/zizmorcore/zizmor/blob/75dc69ba6fee36fd4b359886bff6284de13d4fe6/docs/audits.md#adhoc-packages),
  [configuration](https://github.com/zizmorcore/zizmor/blob/75dc69ba6fee36fd4b359886bff6284de13d4fe6/docs/configuration.md#settings)).
- GitHub's workflow schema and the SchemaStore schema validate allowed keys,
  types, and structure. `run` remains a string; a schema cannot express command
  ordering, executable provenance, or same-job setup/use coupling
  ([GitHub language-service schema](https://github.com/actions/languageservices/blob/4043eda158e16579cc5fb1b0b07a4bce2a76f0b5/workflow-parser/src/workflow-v1.0.json#L2165-L2197),
  [SchemaStore workflow schema](https://json.schemastore.org/github-workflow.json)).
  YAML Language Server applies such schemas for validation, completion, hover,
  and document structure; it is not a shell or workflow-policy engine
  ([YAML Language Server](https://github.com/redhat-developer/yaml-language-server#features)).

### Structural rules, mutation, and language servers

Semgrep supports Bash and YAML, but marks both experimental; Python is generally
available. Its rule syntax supplies positive/negative, enclosing, metavariable,
and path constraints. ast-grep has built-in Bash, Python, and YAML parsers plus
`inside`, `has`, `follows`, and `precedes`, but a rule tests one AST node at a
time. Cross-file set comparison needs a small outer index
([Semgrep language support](https://semgrep.dev/docs/supported-languages),
[Semgrep rule syntax](https://semgrep.dev/docs/writing-rules/rule-syntax),
[ast-grep languages](https://ast-grep.github.io/reference/languages.html),
[ast-grep relational rules](https://ast-grep.github.io/guide/rule-config/relational-rule.html),
[one-node limitation](https://ast-grep.github.io/guide/rule-config/composite-rule.html)).
This makes ast-grep the safer syntax input for shell/YAML leads today and
Semgrep useful for Python and narrowly tested nested/generic rules. Neither
engine supplies the missing rules out of the box.

Mutation testing is the right proof for several vacuity gaps, but not an
existing one-command answer:

- Cosmic Ray explains the distinction precisely: line coverage proves execution,
  while a surviving production-code mutation shows that tests did not check the
  changed behavior. It is Python-only
  ([official documentation](https://cosmic-ray.readthedocs.io/en/latest/)).
- mutmut likewise mutates Python and runs pytest by default; mutmut 3+ focuses on
  code inside functions. It does not mutate shell/YAML/Markdown directly
  ([official README](https://github.com/boxed/mutmut/blob/main/README.rst)).
- `mutation_test` can apply bounded literal/regex replacements to any text file
  and judge configured commands by exit status. That makes it usable for shell,
  YAML, and Markdown mutations, but it is a configurable mutation runner, not a
  ready-made rule pack; mutations must be narrow enough not to create invalid
  inputs
  ([official README](https://github.com/domohuhn/mutation-test/blob/main/README.md)).

Language servers do not close this gap. Bash Language Server offers navigation,
completion, simple diagnostics, and optional ShellCheck delegation; YAML
Language Server provides syntax/schema intelligence; Pyright is a static Python
type checker. None claims mutation analysis, assertion strength, generated-set
completeness, or workflow command-state reasoning
([Bash Language Server](https://github.com/bash-lsp/bash-language-server),
[YAML Language Server](https://github.com/redhat-developer/yaml-language-server),
[Pyright](https://github.com/microsoft/pyright)).

## Defect-to-tool matrix

"Custom" below means a plausible deterministic check, not shipped coverage.
"Guidance/judgment" is what remains when no machine-readable contract exists.

| # | Defect and primary evidence | Proven existing coverage | Small deterministic check | Guidance or LLM-only residual |
|---:|---|---|---|---|
| 1 | **Idempotent branch loses a mode postcondition:** identical hook bytes skip `chmod`, leaving a 0644 boot hook ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2444#discussion_r3790082579)). | None. ShellCheck's chmod-specific SC2253 concerns ambiguous `chmod -r`, not state across branches ([SC2253](https://www.shellcheck.net/wiki/SC2253)). ShellSpec catches this only with an equal-bytes/0644 scenario plus an explicit executable or exact-mode assertion. | Reusable Bash AST lead: when a content comparator gates replacement, compare metadata-setting operations across every success branch. Behavioral proof: preseed equal bytes at 0644 and require 0755 after the real command. | Whether executable mode is an invariant, and whether other metadata must also be repaired, is intent unless an install manifest declares it. |
| 2 | **Required output is optionalized:** the publisher silently omits a missing generated client script ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2444#discussion_r3790082585)). | None. ShellCheck SC1091 concerns an actual unresolved `source`, not an artifact omitted before it is referenced ([SC1091](https://www.shellcheck.net/wiki/SC1091)). | Compare a canonical required-artifact manifest with generated and staged sets; fail on set difference. As a lead, flag existence-guarded `add`/`stage`/`publish` operations in publisher files. Fault proof removes each required generated input and requires publisher failure. | Without an authoritative artifact universe, whether omission is optional or fail-closed is product judgment. |
| 3 | **Boundary mutation is unproved:** the refresh test stales `install-edge`, not the final `install-nightly` list entry ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2444#discussion_r3790082589)). | None. ShellSpec/Kcov can show eligible lines executed, not that first/middle/last list mutations are killed. | From a canonical channel list, delete/rename each derived entry independently and require the refresh test to fail; at minimum exercise first, middle, and final entries. | Coupling distant list representations is LLM-only when there is no canonical list or generator relation to index. |
| 4 | **Negative assertion has an incomplete universe:** stage mode checks two scripts, not all scripts ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2444#discussion_r3790082591)). | None. ShellSpec parameterization does not infer missing rows. | Enumerate candidates from the same manifest used by the publisher, materialize each forbidden candidate, and apply one parameterized negative assertion to every member. Compare asserted and required sets. | “All scripts” remains judgment if the universe is implicit in prose or directory convention. |
| 5 | **Smoke transport differs from its contract:** claimed `fetch | sh`, executed `/bin/sh < file` ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2444#discussion_r3790082592)). | SC2259 is only a partial adjacent detector: it catches a pipe and overriding redirection in the same shell syntax, not this implementation. POSIX defines a pipeline's stdout-to-stdin connection separately from redirection ([shell specification](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)). | Parse the invoked shell fragment and classify `pipeline` versus regular-file redirection; behavioral proof must use the real producer or a FIFO/non-seekable stdin and exercise a child that reads stdin. | Mapping a prose/docstring claim to the responsible helper and deciding which transport property matters remains review judgment unless the test contract is machine-readable. |
| 6 | **Device event is not synchronized:** `udevadm trigger` is followed by KVM use without settle ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2521#discussion_r3803609623)). | None in actionlint, schema, ShellCheck, or zizmor. systemd documents that `trigger --settle` waits for its triggered events and `udevadm settle` waits for current queued events ([manual](https://www.freedesktop.org/software/systemd/man/latest/udevadm.html#udevadm%20settle%20%5Boptions%E2%80%A6%5D)). | High-confidence ordered rule: within one job/control path, flag `udevadm trigger` followed by a configured device consumer before either accepted settle form. | Consumer vocabulary, called scripts/actions, and nontrivial conditional implication require framework guidance or model review. |
| 7 | **Executable identity is assumed after diversion:** GNU-tar assertion invokes bare `tar` ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2521#discussion_r3803609633)). | None. POSIX resolves a slashless command through `PATH`; the name itself does not establish GNU identity ([command search](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#tag_19_09_01_04)). GNU tar recommends first verifying that GNU tar is actually in use ([manual](https://www.gnu.org/software/tar/manual/html_node/help.html)). | Stateful, configured workflow rule: after a diversion/alternative changes a tool path, flag a later bare invocation until an absolute path or an identity-checked resolution is established. Runtime `--version` probe is definitive. | Package-manager effects, aliases, shell command caches, and intended implementation identity usually need project-specific guidance and sometimes runtime proof. |
| 8 | **Preflight inventory is incomplete:** later `pkill` is absent from the required-tool list ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2521#discussion_r3803609637)). | None. ShellCheck's optional SC2230 only recommends `command -v` over `which`; it does not compare command sets ([SC2230](https://www.shellcheck.net/wiki/SC2230)). | Parse literal external command names, remove functions/builtins/absolute project scripts via an allowlist, and subtract the canonical preflight set within the same script/job. A focused mode can check only commands after the declared exhaustive preflight. | Whether every external command must be preflighted is policy unless the preflight declares itself exhaustive. Dynamic commands and wrappers remain uncertain. |
| 9 | **Framework environment guidance is wrong:** docs run `python -m pytest` after `uv sync` ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2521#discussion_r3803609653)). | None; workflow linters and language servers do not validate shell recipes inside Python docstrings. uv says `.venv` is isolated from the current shell by default and prescribes `uv run` ([uv run](https://docs.astral.sh/uv/concepts/projects/run/)). | Reusable documentation rule selected only when uv evidence exists: after `uv sync`, flag bare `python`/`pytest` until `uv run`, `.venv/bin/...`, or explicit activation appears. | Snippet boundaries and an activation established elsewhere may require narrow project guidance; do not issue this rule in non-uv projects. |
| 10 | **A shell-language guard parses spellings, not commands:** it misses `pip3` and quoted package arguments ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2521#discussion_r3803609662)). | None. zizmor `adhoc-packages` recognizes npm/yarn/pnpm/gem/bundle, not pip. ShellCheck can diagnose an unquoted grep regex, not an incomplete quoted one. | Parse the `run` scalar as shell, normalize `pip`, `pip3`, `python -m pip`, `python3 -m pip`, versioned Python executables, and quoted argument nodes, then apply the prohibited-package policy. Python's `shlex.split` is a smaller Unix-shell lexer when a full Bash parser is unnecessary ([Python docs](https://docs.python.org/3/library/shlex.html)). Add independent pip3, single-quote, and double-quote mutations. | Wrappers, aliases, requirements-file policy, and the prohibited package set are project configuration. Full shell evaluation is not safely inferred statically. |
| 11 | **A workflow test collapses job boundaries:** iptables setup/probe is found anywhere, not in the armed job ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2521#discussion_r3803609666)). | actionlint/schema prove structure only. GitHub documents that a job's steps run in order on the same runner; separate jobs do not share that runner state ([job semantics](https://docs.github.com/en/actions/get-started/understand-github-actions#jobs)). | Match each job mapping separately. For every configured armed marker, require setup and probe descendants in that same job, in order, with conditions at least as broad as the use. ast-grep can scope `has` relations to the job node; an outer checker handles condition and set logic. | The semantic relation from `SMOKE_BLOCK_EGRESS` to iptables is project knowledge unless encoded as rule metadata. Reusable workflows/composite actions need expansion or conservative leads. |
| 12 | **A test mistakes source text for executable proof:** bare `locale -a` or a comment satisfies a substring assertion ([comment](https://github.com/pfBlockerNG/pfBlockerNG/pull/2521#discussion_r3803609673)). | None. YAML/schema tools parse comments away but do not require a command to fail when a locale is absent. ShellSpec's `include` matcher is deliberately substring matching ([matcher](https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/docs/references.md#L563-L599)). | Parse YAML, inspect the armed job's `run` AST rather than raw source, and require an executable `locale -a` membership check whose failure propagates (`set -e`, `&&`, or explicit failure). Mutation replaces it with a comment/bare listing and must be killed. | The required locale and accepted failure idioms are project/framework guidance; assertion adequacy remains model review when commands are hidden behind scripts. |

## Recommended layers

### Available now

1. Keep Leveret's ShellCheck, actionlint, zizmor, Semgrep, ast-grep, and LSP
   baseline. They remove syntax/security/type noise before model review, but must
   not be scored as recall for these mechanisms. Leveret already supports local
   Semgrep/ast-grep packs
   ([current engine belt](../../README.md#how-it-works),
   [rule-pack recipe](../recipes.md#custom-repo-rules-built-in-semgrep--ast-grep-engines)).
2. Where ShellSpec is already the repository's test runner, use the real target
   shell, explicit path/status/mode assertions, parameter tables derived from a
   canonical list, and `--sandbox` only for controlled command-isolation tests.
   Use `--xtrace` for diagnosis, not as proof; do not treat Kcov as vacuity
   detection.
3. Apply the GitHub workflow schema/YAML Language Server for shape and actionlint
   with ShellCheck integration for each `run:` block. Keep zizmor for security.
   Their clean result is a prerequisite, not evidence that sequencing or
   job-local operational contracts hold.

### Small deterministic additions

Implement only rules whose inputs can be stated explicitly:

1. `udev-trigger-before-consumer` — ordered job/run check with accepted settle
   forms and configured consumers (mechanism 6).
2. `external-command-not-preflighted` — shell command/preflight set difference
   with builtin/function/optional allowlists (8).
3. `workflow-prerequisite-same-job` — configured armed/setup/probe triples scoped
   to one job (11).
4. `uv-sync-then-bare-project-command` — documentation/docstring shell-block
   rule activated by deterministic uv evidence (9).
5. `shell-command-guard-uses-parser` — detect raw substring/regex guards over
   workflow shell and provide a parsed command stream to policy checks (10, 12).
6. `required-artifact-set` — compare declared generated/published/tested sets;
   only enable where a canonical manifest or generator relation exists (2–4).
7. A bounded mutation profile, initially: equal bytes + wrong mode; remove each
   required artifact; remove first/middle/final list elements; violate each
   negative candidate; pipe-to-file transport substitution; `pip3` and quoted
   args; split setup and use into separate jobs; replace executable assertion
   with comment/bare listing (1–5, 10–12).

The workflow rules can be implemented as an actionlint embedding, but Leveret's
existing rule-pack path favors ast-grep/Semgrep plus one small outer index for
set and hierarchy relations. Do not build a general shell interpreter.

### Explicit reviewer judgment

Only unresolved questions should reach the reviewer:

- On idempotent or “up-to-date” branches, which postconditions must be repaired
  even when content bytes do not change?
- Is every generated/published artifact required, and what is the authoritative
  universe?
- Does a smoke test reproduce the production transport, process, filesystem,
  and failure semantics rather than merely equivalent happy-path output?
- Do list tests kill first, middle, final, omitted, and forbidden-member
  mutations?
- After a diversion, PATH change, or package install, which executable actually
  runs and how is its identity proven?
- Does each armed workflow job contain its own ordered prerequisites and a
  failing probe, rather than borrowing evidence from another job or a comment?

These are caveat-card questions, not global prompt furniture. If a deterministic
rule or declared contract answers one, omit it from the model packet.

## Precomputed guidance and rule-pack retrieval

### 1. Extract project facts without a model

Build a versioned fact record from the trusted base plus the changed files:

- `language`: parser-confirmed extension and shebang (`shell`, `python`, `yaml`,
  `markdown`);
- `file_kind`: `source`, `test`, `workflow`, `docs`, `publisher`, `generated`;
  only `.github/workflows/*.{yml,yaml}` is deterministically a workflow, while
  `publisher`/`generated` needs a manifest or generator edge;
- `build_system` and environment manager: parsed `pyproject.toml`, lockfiles,
  `.shellspec`, workflow commands, and action `uses` entries;
- `framework_or_tool`: `pytest`, `shellspec`, `github-actions`, `uv`, `udevadm`,
  `qemu`, `tar`, `pip`, `locale`, etc., accepted only from manifests, lockfiles,
  parsed commands, or canonical file conventions;
- workflow hierarchy: workflow file, job ID, runner, resolved shell, ordered
  steps, `uses`, literal command names, and relevant environment markers;
- declared artifact/channel/script lists and generator-to-output edges, preserving
  source locations and version evidence.

Keep job IDs and AST hierarchy. Flattening a workflow into a bag of strings
recreates mechanism 11.

### 2. Maintain a trusted, pinned caveat index

Precompute caveat cards only from official documentation, upstream source/rule
catalogs, and specifications. Each card should contain:

```yaml
id: systemd-udevadm-trigger-settle
selector:
  all:
    - file_kind: workflow
    - language: yaml
    - tool: udevadm
  any:
    - tool: qemu
    - literal_path: /dev/kvm
versions: { systemd_docs: "261.2" }
source:
  url: https://www.freedesktop.org/software/systemd/man/latest/udevadm.html
  upstream_revision: "261.2"
  sha256: "<content hash>"
facts: "trigger is asynchronous unless trigger --settle or a later settle waits"
deterministic_rule: udev-trigger-before-consumer
residual_question: "Do all control paths settle before the first device consumer?"
```

Store source revision/version range, retrieval date, content hash, exact excerpt,
applicability predicate, rule IDs, limitations, and a short residual question.
Repository prose may select a low-confidence hint but must never become a trusted
caveat source or instruction.

### 3. Select conjunctively and enforce a hard budget

At review time:

1. compute facts once;
2. select rule packs and cards by conjunctive predicates over language, file
   kind, build system, framework/tool, version, and changed-path evidence;
3. run deterministic rules first;
4. attach at most six relevant cards, each at most 1 KiB and 250 words, with an
   8 KiB total guidance budget;
5. suppress a residual question when a deterministic finding or proof already
   resolves it.

Examples:

- `yaml + workflow + udevadm + (/dev/kvm or qemu)` selects the udev settle card
  and ordered rule, not general Linux device documentation;
- `python + docs/docstring + uv.lock + pytest` selects uv environment guidance;
- `yaml + workflow + SMOKE_BLOCK_EGRESS + iptables` selects the same-job card;
- `shell + publisher + declared artifact list` selects manifest-completeness and
  list-boundary mutation rules;
- `python test + workflow-source parsing + pip` selects shell-tokenization and
  quote/alias caveats.

### 4. Separate facts, rules, and judgment in the review packet

Deliver three labeled channels:

- **Deterministic facts:** parsed languages, manifests, job/step hierarchy,
  literal command names, artifact sets, diagnostics, and mutation survivors.
- **Deterministic rules:** exact rule ID, matched nodes/sets, source-backed
  rationale, and known limitations.
- **Reviewer judgment:** only the bounded residual questions for undeclared
  intent, runtime identity, or behavioral fidelity.

This removes basic framework discovery from model turns, prevents irrelevant
language guidance from occupying the prompt, and makes “no built-in coverage”
explicit instead of silently treating a clean linter run as proof.