# Bot review gap analysis (stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mine every bot finding on PRs authored by `andrebrait`, label each one, and publish a label file and a gap report that compares the bots with each other and with Leveret.

**Architecture:** Pure labelling logic lives in `bench/mine-labels.mts` and report rendering in `bench/mine-report.mts`. `bench/mine.mts` is the CLI, with five subcommands (`fetch`, `label`, `audit`, `compare`, `report`). It owns the GitHub client, the cache under `.cache/mine/`, judge calls through Pi's `ModelRuntime.completeSimple`, and the Leveret replays through the existing `runTrial` in `bench/replay.mts`.

**Tech Stack:** TypeScript (`.mts`, run with `tsx`), `octokit` (already a dependency; its bundled throttling plugin handles rate limits), `zod`, `@earendil-works/pi-coding-agent` `ModelRuntime`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-11-06-bot-gap-analysis-design.md`

## Global Constraints

- Committed artifacts carry URLs, labels, SHAs, paths and line numbers only. Comment bodies, replies and diffs never leave `.cache/mine/`, which is gitignored.
- Default stdout prints progress counts only, never comment text.
- Leveret's engine makes no model calls. Judge calls live in `bench/` only.
- Bot detection: the account `type` is `Bot`, OR the login ends in `[bot]`, OR the login is one of `openwrt-ai`, `roboomp`, `kilo-code-bot`.
- Categories (fixed): `bug`, `security`, `concurrency`, `error-handling`, `test-integrity`, `performance`, `api-contract`, `docs`, `style`, `other`.
- Line window: ±3 lines.
- Hand-audit sample: 50 findings, seeded. Leveret comparison sample: 60 PRs. Confidence interval: 95% Wilson.
- Judge output that fails validation is retried once, then labelled `unclear`. It is never labelled `rejected`.
- Shell scripts, if any: POSIX `sh`.

## Decisions this plan adds to the spec

- **`fixed` is computed from a single compare per reviewed commit:** `GET /repos/{o}/{r}/compare/{original_commit_id}...{final_head}`. Its patches use the old-side line numbers, which are exactly the lines the bot commented on. A 404 or 422 response means `unknown`.
- **The Leveret replay targets the commit the bot reviewed, not the final head.** At the final head the fixes are already applied, so Leveret could not find the defects. For each sampled PR, the replay head is the `original_commit_id` shared by the most accepted findings on that PR; ties go to the earliest commit.
- **`judge` records the model that assigned the category,** which is every non-notice row. `label_source` records who decided the disposition. This replaces the spec's "judge is null for mechanical labels": mechanical rows still need a category, and the category comes from the judge.
- **`category` is null only on `notice` rows.**
- **PR discovery bisects by creation date,** because GitHub search caps each query at 1,000 results.

## Review Focus

1. A review comment on a deleted line or a renamed file. `original_line` can be null, or the compare entry can be renamed. Expected: the row gets `unknown`, not `rejected`.
2. A force-pushed PR whose `original_commit_id` is no longer reachable. Expected: compare returns 404 or 422, the row is `unknown`, and the run continues.
3. A finding body or reply containing `</finding>`, or "ignore previous instructions". Expected: the judge input stays fenced, and the output is still schema-validated.
4. A rerun after the process is killed mid-PR. Expected: no partial cache files (atomic rename), and the rerun refetches only the incomplete PR.
5. A secondary rate limit (HTTP 403 with `retry-after`). Expected: the client waits and retries, without crashing or skipping the PR.

Each one is pinned by a test in its owning task, marked **(RF n)**.

---

### Task 1: Pure labelling core

**Files:**
- Create: `bench/mine-labels.mts`
- Test: `test/mine-labels.test.ts`

**Interfaces:**
- Produces:
  - `CATEGORIES` (readonly tuple, as in Global Constraints)
  - `labelRowSchema` (strict zod) and `type LabelRow`, with fields exactly as in the spec's row example. `kind ∈ {inline, review, conversation}`, `disposition ∈ {accepted, rejected, unclear, notice}`, `signals ⊆ {fixed, resolved, replied, notice, unknown}`, `label_source ∈ {mechanical, judge}`, `judge: {model: string, prompt_sha256: hex64} | null`, `duplicate_of: url | null`. A refine makes `category === null` iff `disposition === "notice"`.
  - `isBot(user: {login: string; type: string}): boolean`
  - `isNotice(bot: string, kind: LabelRow["kind"], body: string): boolean`
  - `type Hunk = { oldStart: number; oldLines: number }` and `parseHunks(patch: string): Hunk[]`
  - `touchesWindow(hunks: Hunk[], start: number, end: number): boolean`. True when any hunk's old-side range `[oldStart, oldStart + max(oldLines,1) - 1]` overlaps `[start-3, end+3]`.
  - `type Signals = { fixed: boolean | null; resolved: boolean; replied: boolean; notice: boolean }`, where `fixed` is null when unknown
  - `signalList(s: Signals): LabelRow["signals"]` (sorted; null `fixed` becomes `unknown`)
  - `mechanicalDisposition(s: Signals, merged: boolean): "accepted" | "rejected" | null`. Returns `notice`-free results only; `null` means "send to the judge".
  - `markDuplicates(rows: LabelRow[], forkRepos: Set<string>): LabelRow[]`

- [ ] **Step 1: Write the failing tests**

```ts
it("windows ±3 around the commented range", () => {
  const hunks = parseHunks("@@ -20,2 +20,3 @@\n ctx\n-old\n+new\n+more");
  expect(touchesWindow(hunks, 24, 24)).toBe(true);   // 21 + 3
  expect(touchesWindow(hunks, 25, 25)).toBe(false);  // just outside
  expect(touchesWindow(parseHunks("@@ -10,0 +11,2 @@\n+a\n+b"), 13, 13)).toBe(true); // pure insertion
});
it("detects bots by type, suffix, and the known list", () => {
  expect(isBot({ login: "coderabbitai[bot]", type: "Bot" })).toBe(true);
  expect(isBot({ login: "new-reviewer[bot]", type: "User" })).toBe(true);
  for (const login of ["openwrt-ai", "roboomp", "kilo-code-bot"]) expect(isBot({ login, type: "User" })).toBe(true);
  expect(isBot({ login: "andrebrait", type: "User" })).toBe(false);
});
it("labels mechanically only on the spec's two rules", () => {
  const base = { fixed: false, resolved: false, replied: false, notice: false };
  expect(mechanicalDisposition({ ...base, fixed: true, resolved: true }, true)).toBe("accepted");
  expect(mechanicalDisposition({ ...base, fixed: true, resolved: true, replied: true }, true)).toBeNull();
  expect(mechanicalDisposition({ ...base, resolved: true }, true)).toBe("rejected");
  expect(mechanicalDisposition({ ...base, resolved: true }, false)).toBeNull();
  expect(mechanicalDisposition({ ...base, fixed: null, resolved: true }, true)).toBeNull(); // RF 1/2: unknown never rejects
});
it("rejects rows carrying text", () => {
  expect(() => labelRowSchema.parse({ ...validRow, body: "x" })).toThrow();
  expect(() => labelRowSchema.parse({ ...validRow, disposition: "notice", category: "bug" })).toThrow();
});
it("points fork companion findings at the upstream finding", () => {
  const [up, fork] = markDuplicates([row("org/repo", 1), row("me/repo", 7)], new Set(["me/repo"]));
  expect(up.duplicate_of).toBeNull();
  expect(fork.duplicate_of).toBe(up.url);
});
```

`isNotice` gets one case per bot, built from the fixtures in Task 2, Step 1 (bodies with the text replaced, keeping the markers): a CodeRabbit walkthrough (`<!-- walkthrough_start -->`), a CodeRabbit rate-limit notice, a CodeRabbit review body with only `Actionable comments posted: N` (notice) versus one containing `Outside diff range` (not a notice), a Codex usage-limit notice, a Codex "didn't find any major issues" review, a Kilo summary, an empty body, and one real inline finding per bot (not a notice). Inline comments are never notices unless their body is empty.

- [ ] **Step 2:** `npx vitest run test/mine-labels.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `bench/mine-labels.mts`. `isNotice` is a table of `{bot, kinds, pattern}` regex entries, so a new notice format means one new line in the table. In `markDuplicates`, the group key is `(head_sha, bot, path, line)`. The canonical row is the one whose repository is not in `forkRepos`; ties go to the lowest URL.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `bench: add pure labelling core for bot review mining`.

### Task 2: Fetch pass and cache

**Files:**
- Create: `bench/mine.mts` (CLI skeleton and `fetch`)
- Create: `test/fixtures/mine/` (recorded responses for 5 PRs with the text replaced)
- Modify: `.gitignore` (add `.cache/`), `package.json` (`"bench:mine": "tsx bench/mine.mts"`)
- Test: `test/mine-fetch.test.ts`

**Interfaces:**
- Consumes: `isBot` (Task 1).
- Produces:
  - `CACHE_ROOT = ".cache/mine"`, with one file per PR at `prs/<owner>__<repo>__<n>.json`, written via tmp file plus `rename`.
  - `type CachedPr = { repository: string; number: number; url: string; state: "open"|"closed"; merged: boolean; base_sha: string; head_sha: string; repo_fork: boolean; repo_language: string | null; issue_comments: Comment[]; reviews: Review[]; review_comments: ReviewComment[]; threads: { comment_ids: number[]; is_resolved: boolean }[]; compares: Record<string, { status: "ok"; files: { filename: string; previous_filename?: string; patch?: string }[] } | { status: "unavailable" }> }`. `Comment`, `Review` and `ReviewComment` keep the GitHub fields used later: `id, html_url, user{login,type}, body, created_at`, plus `in_reply_to_id, path, original_line, original_start_line, original_commit_id` on review comments.
  - `discoverPrs(gh, author: string, from: string, to: string): Promise<{repository: string; number: number}[]>`. It bisects the creation-date window while `total_count > 1000`.
  - `fetchPr(gh, repository: string, number: number): Promise<CachedPr>`
  - `runFetch(gh, opts: { author: string; refresh: boolean; only?: string[] }): Promise<{ fetched: number; cached: number; withoutBots: number }>`
  - `type Gh = Pick<Octokit, "request" | "graphql" | "paginate">`, which can be injected for tests.

- [ ] **Step 1:** Record the fixtures. Fetch PRs `pfBlockerNG/pfBlockerNG#2444`, `kahme247/ompweb` (one with Kilo comments), `can1357/oh-my-pi` (one with roboomp comments), `openwrt/packages#31070`, and `leveret-dev/leveret` (one with CodeRabbit comments) with `gh api`. Save the responses under `test/fixtures/mine/<key>/<endpoint>.json`. Replace every `body` with a placeholder that keeps the notice markers Task 1 uses.
- [ ] **Step 2: Write the failing tests**
  - `fetchPr` on the fake `Gh` (which serves the fixtures by route) returns threads with `is_resolved`, and one compare per distinct `original_commit_id` of a bot review comment.
  - **(RF 2)** A compare route answering 404 is cached as `{status:"unavailable"}`, and the fetch still succeeds.
  - **(RF 4)** If `runFetch` throws midway on PR 3 of 5, no `*.tmp` file is left behind; the rerun requests only PRs 3 to 5.
  - A second `runFetch` over a populated cache makes zero `Gh` calls, except discovery.
  - `discoverPrs` splits a window whose fake `total_count` is 1,500 into two halves and returns the union without duplicates.
  - **(RF 5)** The client factory `githubClient(token)` sets `throttle.onRateLimit` and `onSecondaryRateLimit` to return `true`. The test asserts that both handlers return `true` for retry count 5.
- [ ] **Step 3:** Run them. Expected: FAIL.
- [ ] **Step 4:** Implement the above.
  - **Token:** `GH_TOKEN`, falling back to `gh auth token`.
  - **Discovery:** the search query is `is:pr author:<author> created:<from>..<to>`, starting from `2015-01-01` to today.
  - **Threads:** one GraphQL query per PR on `pullRequest.reviewThreads(first:100){nodes{isResolved comments(first:100){nodes{databaseId}}}}`, paginated.
  - **Repository metadata:** fetched once per repository and reused (`fork`, `language`).
  - **Compare target:** the merge commit for merged PRs, otherwise the head SHA.
  - **Progress line:** `fetch <done>/<total> cached=<n> bots=<n>`.
- [ ] **Step 5:** Run them. Expected: PASS.
- [ ] **Step 6:** Commit: `bench: fetch and cache bot reviews on authored PRs`.

### Task 3: Signals, judge and the `label` pass

**Files:**
- Modify: `bench/mine.mts` (add `label`)
- Test: `test/mine-label.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `extractFindings(pr: CachedPr): Finding[]`. A `Finding` is `{ url, repository, pull_request, bot, kind, path, line, start_line, head_sha, body, replies: string[], signals: Signals, merged }`. Only bot-authored root comments become findings; replies in a bot's own thread are not separate findings.
  - `JUDGE_PROMPT` (const string) and `JUDGE_PROMPT_SHA256`
  - `judgeOutputSchema = z.object({ disposition: z.enum(["accepted","rejected","unclear"]), category: z.enum(CATEGORIES) }).strict()`
  - `type Complete = (system: string, user: string) => Promise<string>`
  - `judge(f: Finding, patch: string | null, complete: Complete, model: string): Promise<{ disposition; category; model; prompt_sha256 }>`. The result is cached at `judge/<sha256(url + prompt_sha256 + model)>.json`.
  - `runLabel(opts: { complete: Complete; model: string }): Promise<LabelRow[]>`. It writes `bench/review-labels.v1.jsonl`, sorted by URL, one `labelRowSchema`-validated row per line.
  - `modelComplete(provider: string, model: string): Promise<Complete>`. It wraps `ModelRuntime.create` (the same `authPath`/`modelsPath` as `src/runner/pi.ts`) and `completeSimple`, and returns the concatenated text content.

**Signals:**
- `fixed`: `touchesWindow` on the compare entry whose `filename` or `previous_filename` equals `path`. An absent entry means `false`. A compare that is `unavailable`, or a null `original_line`, means `null` **(RF 1)**.
- `resolved`: the thread containing the comment is resolved.
- `replied`: a non-bot reply in the thread. For `review` and `conversation` findings: a later non-bot issue comment that @mentions the bot, or quotes the finding's first line.
- `notice`: `isNotice`.

The judge user message fences the untrusted text in `<finding>`, `<replies>` and `<diff>` elements, after escaping `<` as `&lt;` inside them. The diff is truncated to 16 KiB. The system prompt asks for the JSON object only.

- [ ] **Step 1: Write the failing tests** (fake `Complete`):
  - A finding with `fixed` + `resolved` and no reply gets `label_source: "mechanical"` and `disposition: "accepted"`, and its category comes from the judge.
  - The judge returns invalid JSON twice: the row is `unclear` / `other`, `label_source: "judge"`, and the fake was called exactly twice.
  - **(RF 3)** A body containing `</finding>` and "ignore previous instructions" reaches `Complete` with `&lt;/finding>`, so exactly one real closing tag remains.
  - A notice row has `category: null`, and the judge is not called.
  - A second `runLabel` with the judge cache populated calls `Complete` zero times.
  - No line of the written JSONL contains any fixture body placeholder text.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. The CLI is `label --judge-provider <p> --judge-model <m>`, with both flags required. Progress line: `label <done>/<total> judged=<n> mechanical=<n>`.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit: `bench: label bot findings with signals and a Flash-tier judge`.

### Task 4: Hand audit and the report

**Files:**
- Create: `bench/mine-report.mts`
- Modify: `bench/mine.mts` (add `audit` and `report`)
- Test: `test/mine-report.test.ts`

**Interfaces:**
- Consumes: `LabelRow`; the comparison results from Task 5 (optional input).
- Produces:
  - `auditSample(rows: LabelRow[], seed: number, n = 50): LabelRow[]`, deterministic and drawn from non-notice, non-duplicate rows. `audit` writes `.cache/mine/audit.jsonl` with `{url, auto: disposition, label_source, hand: null}` and never overwrites `hand` values that are already filled.
  - `wilson(successes: number, n: number): { low: number; high: number }`, with z = 1.96.
  - `type Comparison = { url_pr: string; replay_head: string; targets: string[]; matched: string[]; status: "complete" | "invalid"; reason?: string }`
  - `renderReport(rows: LabelRow[], audit: {url; auto; label_source; hand}[], comparisons: Comparison[], date: string): string`. It contains the six sections of the spec, in the spec's order.
    - **Noise rate** = rejected ÷ (accepted + rejected).
    - **Overlap** = accepted findings with no other bot's finding on the same PR, path, and ±3 lines. The report says this is location-based.
    - **Leveret gap** = matched ÷ targets, over complete comparisons, with the Wilson interval.
  - Duplicates are excluded from every count.
  - The report prints no comment text, only counts and URLs.

- [ ] **Step 1: Write the failing tests:**
  - `wilson(0, 0)` returns `{low: 0, high: 1}`, and `wilson(30, 60)` returns about `{0.377, 0.623}`, to 3 decimal places.
  - `auditSample` with the same seed returns the same 50 URLs, and it excludes notice and duplicate rows.
  - `renderReport` on a 6-row fixture: the per-bot table shows the noise rate `0.50` for a bot with 1 accepted and 1 rejected; a duplicate row is not counted; the overlap counts one unique accepted finding; the Leveret section shows `1/2` and its interval; the output contains no `body` placeholder.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. `report` writes `docs/reports/<YYYY-MM-DD>-bot-gap-analysis.md`. It reads the label file, `audit.jsonl` if present, and `compare/*.json` if present.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit: `bench: hand-audit sample and gap report rendering`.

### Task 5: Leveret comparison

**Files:**
- Modify: `bench/mine.mts` (add `compare`)
- Test: `test/mine-compare.test.ts`

**Interfaces:**
- Consumes: `runTrial` and `TrialPlan` from `bench/replay.mts` (called with `rows: []` and `mode: "diff-only"`); `summarizeResult` from `bench/report.mts` (to read `result.json` findings from `audit_run_dir`); `Complete` from Task 3; `wilson` and `Comparison` from Task 4.
- Produces:
  - `stratifiedSample(rows: LabelRow[], seed: number, n = 60): { repository: string; pull_request: number; replay_head: string; targets: string[] }[]`
    - Candidates are PRs with at least one accepted, non-duplicate inline finding.
    - The stratum is `repository|bot|category` of the PR's most frequent accepted finding.
    - Shuffle within each stratum (seeded), then take one PR per stratum in sorted stratum order, round after round, until `n` PRs are taken or the candidates run out.
    - `replay_head` follows the rule in "Decisions this plan adds".
    - `targets` are the accepted findings at that head.
  - `matchFindings(targets: Finding[], leveret: {file: string; line: number; title: string}[], confirm: (t: Finding, l) => Promise<boolean>): Promise<string[]>`. A Leveret finding is a candidate when it has the same path and lies within ±3 of the target's range. `confirm` asks the judge, with fenced input, for `{"same": boolean}`; invalid output twice counts as `false`.
  - `runCompare(opts: { complete; model; runnerProvider; runnerModel; seed; n })`
    - **Mirror:** each repository is mirrored at `.cache/mine/repos/<owner>__<repo>` with `git clone --filter=blob:none`.
    - **Fetch:** fetch `pull/<n>/head` and `replay_head`. If the fetch fails, or if `merge-base` does not resolve, skip the PR and draw the next PR from the same stratum.
    - **Replay:** set `LEVERET_RUNNER_PROVIDER` and `LEVERET_RUNNER_MODEL` for the runner, call `runTrial`, and write `compare/<owner>__<repo>__<n>.json` as a `Comparison`.

- [ ] **Step 1: Write the failing tests:**
  - `stratifiedSample` over a fixture with 3 strata of sizes 5, 1 and 1 and `n = 4` returns 2 from the first stratum and 1 from each of the others, and the result is stable for a fixed seed.
  - `replay_head` picks the commit with the most accepted findings, and the earlier commit on a tie.
  - `matchFindings`: a Leveret finding at line +3 is a candidate, +4 is not, and a different path is not; `confirm` returning false means no match.
  - A PR whose fetch fails is replaced from its stratum. This uses an injected `fetchPr` failure; it never calls the network.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. CLI: `compare --judge-provider <p> --judge-model <m> --runner-provider <p> --runner-model <m> [--seed 1] [--n 60]`. Progress line: `compare <done>/<n> complete=<n> invalid=<n>`.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit: `bench: stratified Leveret comparison against accepted bot findings`.

### Task 6: Smoke run, full run, publish

**Files:**
- Create: `bench/review-labels.v1.jsonl`, `docs/reports/2026-MM-DD-bot-gap-analysis.md`
- Modify: `DESIGN.md` (one paragraph in the benchmark section that points to `bench:mine`, the label file and the report)

- [ ] **Step 1: Smoke.** Run `npm run bench:mine -- fetch --only <the 5 fixture PRs>`, then `label` with Gemini Flash or Grok. Check every row by hand against its GitHub thread. Expected: the dispositions are plausible, there are no text fields, and stdout shows counts only.
- [ ] **Step 2: Full fetch.** Run `fetch` for all PRs, unattended (a few hours under rate limits). Expected: the final progress line, and `withoutBots` reported.
- [ ] **Step 3:** Run `label`, then `audit`. Hand the audit checklist path to the owner and wait until the hand labels are filled in.
- [ ] **Step 4:** Run `compare` (60 PRs, Flash-tier runner and judge), then `report`.
- [ ] **Step 5:** Verify: `npm test`, `npm run build`, and `grep -c '"body"' bench/review-labels.v1.jsonl` returns `0`.
- [ ] **Step 6:** Commit: `bench: publish bot review labels and gap report`.
