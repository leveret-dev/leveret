# leveret — design

Goal: a production-grade replacement for CodeRabbit's review capability, built as
composable layers an agent (Claude Code or any MCP client) drives, instead of a hosted
black box. The benchmark for "works" is defined at the bottom; until it passes, leveret
changes nothing in the repos it reviews.

## Why CodeRabbit catches more than a naive LLM reviewer

From its published architecture, four pillars matter:

1. **Deterministic first pass** — a fleet of static analyzers, linters, secret and
   dependency scanners runs before any LLM sees the diff, producing grounded leads.
2. **Structural context** — a dependency-aware code graph traces changed symbols to
   call sites *outside* the diff; AST-level matching grounds pattern claims.
3. **A verification filter** — a second agent cross-checks every proposed comment and
   silently drops anything it cannot verify. Low false-positive rate is the product.
4. **Memory** — learnings per PR thread, per repo, and per organization suppress
   re-raising what was already priced and encode repo conventions.

leveret replicates each pillar with local, inspectable pieces:

| Pillar | leveret component |
| --- | --- |
| Deterministic first pass | engine registry behind the `scan` MCP tool |
| Code graph | leveret's OWN capability: `ensureGraph()` builds the index into every checkout at the exact reviewed commit; agents query it via the codegraph MCP. The reviewed repo shipping or lacking an index is irrelevant. |
| AST grounding | `ast_search` (ast-grep) + custom rule packs; LSP diagnostics via the client's LSP surface (e.g. Serena) |
| Verification filter | three-layer filter pipeline (below) ending in a verification agent |
| Memory | in-repo, versioned finding-verdict store + `remember` tool |

## Evidence so far (2026-08-20, v0.1 probe)

Scanning a real 15-commit range of pfBlockerNG produced 27 findings, all shellcheck,
all in one shellspec file the target repo deliberately excludes from shellcheck:

- 25/27 false positives by construction (SC2016 single-quoted `$1` for an inner
  `sh -c`; SC2329 functions invoked through the shellspec DSL's string indirection).
- 2/27 technically true but inert (SC2162 `read` without `-r` on a fixture fifo that
  can never carry a backslash).
- 0/27 actionable.

Conclusion: raw engine output is unusable as review comments, and — the sharper
lesson — a binary real/false-positive filter is not enough. The SC2162 pair is *true*
and still must not be posted. Findings need three grades.

## The three-grade filter

Every lead ends in exactly one grade:

- **`actionable`** — true, in scope, worth a comment. Surfaced with evidence.
- **`priced-noise`** — technically true, but the repo has (or now makes) a considered
  decision that fixing it buys nothing. Dropped from output, **recorded with its
  rationale** so the pricing is auditable and never re-litigated.
- **`false-positive`** — the claim is wrong (tool cannot see intent, DSL indirection,
  allowlisted value). Dropped, recorded so it never resurfaces.

Three layers assign grades, cheapest first; each layer only passes down what it
cannot decide:

1. **Profile (deterministic, per repo)** — `.leveret.yml` in the target repo:
   per-engine path scopes (e.g. shellcheck only under `src/`, `scripts/`), severity
   floors, rule suppressions — each entry carrying a `reason:`. Kills whole noise
   classes for free. Suppressions are never silent: `scan` reports counts of what the
   profile dropped and why (a truncated report must not read as "clean").
2. **Memory (deterministic lookup)** — fingerprint match against the repo's verdict
   store. A previously graded finding whose anchor line is unchanged auto-applies its
   stored grade; a changed anchor invalidates the match and the lead falls through to
   layer 3 (code moved — the pricing may no longer hold).
3. **Verification agent (LLM, adversarial)** — for surviving leads plus everything the
   review agent proposes: refute-or-evidence. A claim it cannot ground in executed
   evidence (command + output) or cited code is dropped. It assigns the final grade
   and writes new memories for grades 2 and 3, so the expensive path runs at most
   once per finding class.

## Memory design

Repo-scope memory lives **in the reviewed repo**, versioned and reviewable —
`.leveret/memory.jsonl`, one entry per graded finding class:

```json
{"fp": "shellcheck/SC2016/tests/shell/**", "grade": "false-positive",
 "reason": "shellspec specs pin literal $(...) command text; single-quoted $1 is the inner sh -c's positional parameter",
 "anchor": null, "author": "verifier-agent", "confirmedBy": "andrebrait",
 "created": "2026-08-20", "lastApplied": "2026-08-20"}
```

- **Fingerprint** (`fp`): `engine/rule/path-or-glob`. Class-wide entries use globs
  (grade applies to the rule in that subtree); instance entries pin a file plus an
  `anchor` — the hash of the trimmed matched line — so the memory dies with the code
  it priced instead of suppressing a future, different occurrence.
- **Scopes**, mirroring CodeRabbit's three: thread scope is the PR conversation
  itself (no store needed); repo scope is the file above; org scope (shared
  conventions across repos) is a later import layer, not MVP.
- **Provenance**: entries record who graded (agent or human) and human confirmation
  when given ("won't fix" reply on a PR comment is a confirmation event).
- **Human feedback is a memory *source*, not just a confirmation** (CodeRabbit
  parity, 2026-08-21): CodeRabbit builds its learnings primarily by mining the
  maintainer's replies to its own comments — corrections, "we do X here", scope
  rulings — not only its own verdicts. leveret needs the same ingestion path: a
  reply on a posted finding (or an explicit teach flow) becomes a memory entry with
  the human as author, carrying more authority than an agent-graded one. Agent
  verdicts decay and get GC'd; human-taught entries persist until a human retires
  them.
- **Promotion**: when instance entries for the same rule pile up under one subtree,
  the verifier proposes a profile entry or a glob memory — recurring pricing should
  become one line, not N.
- **Hygiene**: `lastApplied` enables garbage collection of memories that stopped
  matching anything; stale pricing is deleted, not hoarded.
- **Memories vs CodeRabbit learnings (gap analysis, 2026-08-21).** Fingerprint
  entries are the *suppression half* of learnings only: mechanical, drop-only, and
  invisible to the review agent. Learnings additionally generalize (free text in the
  reviewer's prompt matches novel findings) and teach (a learned convention RAISES
  findings). Closing the gap, in order: (1) inject the `reason` prose of in-scope
  memories into the review/verify prompts — the reviewer reviews *with* the repo's
  accumulated rulings, and the LLM supplies fuzzy generalization for free; (2) add a
  second entry kind, `convention` — fingerprint-free teaching text ("this repo
  invokes Python only through uv run"), sourced from `learn`, usable both to
  suppress and to raise; (3) keep fingerprints as the cheap exact tier that runs
  before any LLM sees anything.

## MCP surface (target)

- `scan {repo, base|files, engines?}` — as today, plus: applies profile + memory
  layers, returns leads **with grades already attached where decidable**, and a
  suppression report (`dropped: N by profile rule X / memory fp Y`).
- `ast_search {repo, pattern, lang, paths?}` — unchanged; also the verifier's
  grounding tool for "every call site shaped like this" claims.
- `remember {repo, fp, grade, reason, anchor?}` — persists a verdict to the repo
  store. Called by the verification agent (and by a human-driven session adopting a
  "won't fix" decision).
- `memory {repo, query?}` — list/inspect entries, surface promotion candidates.
- `learn {repo, thread}` (planned, priority over further benchmarking — owner,
  2026-08-21) — ingest human feedback into memory: given a posted finding and the
  human replies to it, extract the ruling (wrong / won't-fix-here / convention) into
  a memory entry authored by the human. Two feeders: live PR threads on leveret's own
  findings, and **historical mining** — where a leveret replay finding matches a
  CodeRabbit finding in an old PR, the full comment history already contains the
  maintainer's ruling on it; ingest that same feedback, giving leveret the identical
  training signal CodeRabbit received.

Deliberately not wrapped: code-graph queries (CodeGraph MCP exists), LSP diagnostics
(client surface), shell probes (the driving agent already executes commands — leveret
never needs its own sandbox because the agent *is* the sandbox).

## Deployment modes and conversational state (owner decisions, 2026-08-21)

**Both modes ship.** GitHub Actions is the canonical zero-infrastructure path for a
FOSS self-hostable reviewer: `on: pull_request` replaces the webhook (GitHub
delivers events to its own runners), a workflow file is the whole install, and a
self-hosted runner keeps model credentials at home with no inbound port (it polls
outbound). The webhook App server remains the always-on option for hosts that want
App identity and instant reviews — and reachability is part of that offering, not
the user's puzzle: the docs first-class relay/tunnel setups (smee.io for testing,
cloudflared or similar for production) so webhook mode works from a NAT'd box with
no exposed port. Both are thin entries over the same
scan/runner/renderer internals. Known shared wart: fork PRs get a read-only token —
punted for MVP.

**Audit sessions are evidence, not resumable conversation state.** The standardized
Pi client persists a fresh native session for every phase and attempt beneath the
host-owned audit run. It never discovers sessions from the reviewed checkout. A
future per-PR conversation store may restore only trusted owner storage, re-verify,
then route a human ruling into `learn`; audit artifacts remain untrusted evidence and
are never automatic learning input. Cache eviction must still degrade to a fresh
review.

## Reporting (product decision, 2026-08-21)

Findings publish in **importance tiers** — `critical / major / minor / nit` — a
review judgment assigned by the verification agent, deliberately distinct from the
engines' mechanical `severity`. Inline comments group by tier, most severe first.

Beside the inline findings, every review leaves a **walkthrough summary comment**
(the CodeRabbit-style report of work done, not just defects found):

- per-lens outcomes — every lens listed with its result, clean included;
- per-file verdicts for every changed file: `findings / considered-fine /
  not-examined (why)`;
- the engine table (status, found/kept counts), suppression tallies with reasons,
  `preExisting` count, base-pass errors, and the reminders section.

**Out-of-diff findings are a first-class category**: defects in untouched code that
correlate with the change (the symbol the diff modifies, another copy of the pattern
the diff fixes, a consumer of an altered contract). They carry `scope:
"out-of-diff"` plus a stated `correlation`, render in their own summary section
(GitHub cannot inline them on the diff), and are never dropped merely for being
outside the diff. Distinct from *reminders*: reminders are pre-existing mechanical
engine findings adjacent to changed lines; out-of-diff findings are agent-discovered
and correlation-driven, any distance away.

The principle throughout: the report shows **what was checked**, not only what was
found — a clean review must be distinguishable from a shallow one. The model emits
one structured verify object (`report` + `verdicts` + `coverage`); deterministic
code combines it with `ScanResult` and renders PR comments, walkthrough Markdown,
benchmark tables, or future HTML. The model never reformats the same result for
each presentation surface.

## Distribution: GitHub App + BYOAI (product decision, 2026-08-21)

leveret ships as a **GitHub App** — install on a repo, PRs get reviewed, findings
arrive as review comments with an interactive thread — while staying **BYOAI**: the
model, its credentials, and the code never route through infrastructure the user
does not control. The two requirements compose by splitting the app in half:

- **The App layer** owns GitHub plumbing only: webhook receipt, check runs, posting
  review comments, reading thread replies (the `learn` feed). It holds a GitHub App
  key and nothing else — no model keys, no code storage.
- **The runner layer** does the review: checks out the diff, runs the deterministic
  engines, drives the review/verify agents against the user's provider (Anthropic or
  OpenAI key, subscription OAuth, or an OpenAI-compatible local endpoint). It runs on
  the user's hardware — their CI runner, a container, a box in the closet.

Deployment modes, same code:

1. **Fully self-hosted** (default, the privacy pitch): the user deploys both halves
   from this repo — App via GitHub's app-manifest one-click flow, runner wherever
   they like. Nothing leaves their perimeter.
2. **Hosted App, customer runner**: the shared App proxy verifies GitHub, reads a
   client-encrypted endpoint from trusted default-branch configuration, mints a
   repository-scoped installation token, and signs the raw delivery to the user's
   box. The box verifies the proxy key and its own `serves:` allowlist before it
   reviews or posts directly with that token. The hosted half sees webhook metadata
   and the transient destination, never source checkouts or model credentials.

Either way the MCP surface stays the local/interactive interface; the App is a
second consumer of the same engine + agent-contract code, not a fork of it.

### Branding a user-owned App (2026-08-22)

Self-hosting and branding pull against each other, and GitHub decides how far the
brand can travel: an App has exactly one webhook URL, so one shared "Leveret" App
cannot deliver to everybody's private server — mode 1 requires an App per user.
Two more constraints follow from GitHub's own rules: App names are unique across
all of GitHub (34 characters, slugged to lowercase with spaces as dashes), and the
App-manifest schema has no avatar field.

So the brand rides on three surfaces instead of on owning the name:

- **The name's leading word.** Setup names the App `Leveret <owner>`, which slugs to
  `leveret-<owner>` and signs every review `leveret-<owner>[bot]`.
- **The avatar**, uploaded by hand — the one manual step, called out on both setup
  pages with the PNG offered for download, because it is the mark that shows up
  beside every comment.
- **The comments themselves**, which are ours entirely: the walkthrough heading, the
  hare, and the acknowledgement copy carry the product regardless of the App's name.

Mode 2 would restore a single branded App, at the cost of the perimeter — which is
the trade that mode 2 already is.

### Runner standardization (owner decision, updated 2026-08-22)

Prompt contracts alone do not standardize a reviewer: the harness (tool
orchestration, system framing, output discipline) shapes the review as much as the
model. The same ruling as the code graph applies — **the harness is part of the
reviewer**. The standardized client is `leveret-runner-pi`, built on upstream Pi package
`@earendil-works/pi-coding-agent@0.84.2` (exact tarball integrity in
`package-lock.json`). Pi owns providers,
OAuth, model calls and the agent loop. Leveret owns the system prompt, tools,
deadlines, metrics and output contract.

The client runs from a host-owned temporary directory and uses in-memory settings
and sessions plus a resource loader that returns no project settings, prompts,
context files, extensions, skills or themes. The reviewed checkout is named only as
the evaluation target in the phase contract and tools; it cannot extend the toolset
or replace the system prompt. Built-in
filesystem, mutation, and shell tools are absent. Leveret supplies canonical-path,
symlink-safe read/search/list tools that cannot leave the checkout. A bounded probe
tool is exposed only when the host explicitly declares an isolated review sandbox.
Autonomous reviews materialize `.leveret.yml` and repo rulings from the trusted base
commit outside the checkout; PR-head policy cannot disable review, add an engine, or
suppress its own findings.

Leveret registers its scan/context/AST/memory functions directly, invokes CodeGraph
through fixed adapters, and proxies a small read-only Serena toolset. Serena reads a
disposable shadow tree of file symlinks and writes configuration/cache only outside
the checkout. It starts only from a pre-staged `LEVERET_SERENA_BUNDLE` manifest;
Leveret creates a fresh `SERENA_HOME` inside each review's temporary runtime
directory, and runtime LSP downloads are refused.
Its dashboard HTTP server, GUI, tray manager and anonymous usage report are disabled.
The Pi adapter records durable tool metrics because Serena's dashboard-free counters
otherwise remain process-local.
The initial fixed-path bundle is intentionally limited to TypeScript/JavaScript, PHP,
Bash, YAML, and JSON; its manifest records absolute packaged executables. Languages
that still depend on uvx or a host toolchain are reported unavailable rather than
being falsely labeled staged.

The autonomous Pi surface can read trusted rulings but cannot promote its own
verdicts into memory. Its verdicts remain in the durable run artifact; versioned
repo memory and the authenticated human learn feed remain the write paths. This
prevents review-target prompt injection from teaching future reviews.

Pi is pinned because its provider catalog and SDK shape are part of the reviewer.
The required provider paths are OpenAI and Anthropic by API key, their personal
subscription OAuth paths, and local OpenAI-compatible endpoints. The caller chooses
provider, model, thinking and per-phase deadline; no raw harness passthrough exists.
Every walkthrough records Pi/model, prompt hash, live capabilities, and phase tool
metrics. `LEVERET_RUNNER` remains the bring-your-own-harness escape hatch.

The interactive MCP path is deliberately not standardized: a human is present there
to judge their own client and tool configuration. Autonomous App/Actions reviews use
the Pi client so comparable reviews have one known prompt and tool surface.

Pi is evaluated on Leveret's provider, isolation, grounding, observability, and
output goals, not the findings or incidental features of an earlier harness. Prompt
and tool-routing quality are expected to be tuned from subsequent organic reviews.

## Agent pipeline

```
[diff] → scan (profile + memory applied) ─┐
         CodeGraph blast radius ──────────┼→ [review agent] → concerns
         LSP diagnostics on touched files ┘        ↓
                                        [verification agent]
                                 refute-or-evidence, 3-grade verdicts
                                          ↓                ↓
                                   actionable → report   priced-noise / false-positive
                                                          → remember → dropped
```

- **Review agent** (read-only): input is the diff, graded leads, and structural
  context. It must trace changed symbols through the code graph to call sites outside
  the diff — cross-file breakage is the class a diff-only reviewer structurally
  misses. Output: concerns with location and claimed impact.
- **Verification agent** (read-only, adversarial): tries to refute every concern and
  every surviving lead. Evidence bar: executed probe or cited current code, never
  plausibility. Unverifiable → dropped silently. This asymmetry — generation is
  generous, publication is strict — is what keeps the output trustworthy.

Both are prompt contracts (files in `agents/`), executable by any client that can
spawn read-only subagents; leveret ships the contracts, not an orchestrator.

## Providers (BYOM — explicit requirement, 2026-08-20)

The engine layer stays model-free. Everywhere leveret drives or configures a model
(P5 harness, any future direct integration), BOTH providers are first-class, each
through BOTH auth paths:

- **Anthropic Claude** — API key, and OAuth for Claude Pro/Max subscriptions.
- **OpenAI** — API key, and OAuth for ChatGPT subscriptions.
- **Local models** — llama.cpp (`llama-server`), Ollama, vLLM, LM Studio and kin, which
  all speak the OpenAI-compatible API. This falls out of the OpenAI path done right:
  the base URL is configurable and the API key optional — a hardcoded
  `api.openai.com` or a mandatory key would silently exclude every local backend.
  Fully-offline review (the self-hosted pitch) depends on this path.

Practical consequence for P5: the agent contracts must run unmodified under a client
authenticated either way (e.g. Claude Code under a Max subscription or an API key;
a Codex/ChatGPT-backed client likewise), and any provider abstraction leveret ships
treats subscription OAuth as a peer of the API key, never an afterthought.

## Roadmap

- [x] **P1** — engine registry (semgrep, gitleaks, shellcheck, ruff, actionlint),
      normalized findings, MCP `scan` + `ast_search`, integration tests
- [x] **P2** — profiles (landed)
      suppressions, suppression reporting
- [x] **P3** — memory store, fingerprints + anchors, `remember` + `memory` tools,
      auto-apply in `scan`, promotion candidates
- [x] **P4** — engine additions: osv-scanner (dependency CVEs), zizmor (workflow
      security), project-local phpstan/phpcs, custom ast-grep rule packs
- [x] **P5** — review + verification agent prompt contracts
- [ ] **P6** — benchmark, then the adoption decision

## Validation gate (the benchmark)

Corpus data lives in `bench/corpus.v1.json`: one strict, hashed row per root
CodeRabbit finding, with accepted/rejected disposition provenance,
`original_commit_id`, an exact frozen two-dot range, source range and mechanism,
scorer notes, and bounded typed defect-presence predicates. The two committed
`leveret.work-item/v1` snapshots are hash-pinned inputs; replay never fetches mutable
PR text. The corpus validates mechanically as 12 accepted targets plus the rejected
#2521 GNU-tar control. A repaired head or failed precondition is invalid, never a
miss.

`npm run bench:experiment-plan -- --corpus bench/corpus.v1.json --experiment
<experiment.json>` validates a strict `leveret.replay-experiment/v1` manifest and
prints the complete run plan without invoking a model. Every configuration pins
the corpus, context/discovery/scheduler/routing variables, prompt/tool/policy/card/
rule/cache hashes, reference hardware, one cold trial, and exactly four warm trial
IDs. Discovery and scheduling remain independent variables; routing is a
separately hash-pinned host file outside the checkout.

`npm run bench:replay -- <repo> --corpus bench/corpus.v1.json --experiment
<experiment.json> --routing <outside-checkout.json> --routing-sha256 <hash>` is the
paid boundary. It validates frozen commits and executable preconditions before
calling the standardized runner, persists complete and failed outcomes, and
rejects actual run identities that differ from the manifest. No command runs paid
trials automatically after landing.

Finalized #51 runs feed `npm run bench:report -- --corpus
bench/corpus.v1.json --json <source.json> [--markdown <report.md>] <run-dir...>`.
JSON is the deterministic source; Markdown only renders it. Runs remain grouped by
the exact experiment configuration and retain generation, verification,
publication, validity, tool/schema failures, stage/wall/worker timings, cold/warm
cache metrics, tokens/cost when supplied, and extra-real/beyond-diff counts.
Missing detail stays `null`/`unknown`, never zero or clean. Semantic target states
come only from explicit adjudication, never titles.

The immutable thresholds live only in `bench/parity-gate.v1.json`.
The frozen 2026-08-25 valid reruns published six independently accepted findings:
one overlapped the 12-target set and five were extra-real; all six were in-diff.
The gate therefore freezes extra-real at five and beyond-diff at zero.
`npm run bench:parity -- --corpus bench/corpus.v1.json --report <source.json>
--adjudication <independent.json> --experiment <experiment.json> --json
<decision.json> [--markdown <decision.md>]` consumes those four JSON inputs and
emits one `pass | fail | blocked` decision with evidence per gate. It requires
4/5 generation and 3/5 publication for every accepted mechanism, at least 90%
independently adjudicated precision, at least 95% completed-run reliability, no
frozen-baseline extra-real or beyond-diff regression, no priced-noise or rejected
GNU-tar publication, and a warm-cache median no greater than ten minutes on the
declared hardware. Cold time and summed worker compute are separate evidence.
Missing, mixed, invalid, or under-five data blocks. CodeRabbit retirement remains
blocked unless every candidate gate passes.
