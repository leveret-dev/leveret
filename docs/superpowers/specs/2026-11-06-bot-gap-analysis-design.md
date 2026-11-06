# Bot review gap analysis (stage 1) — design

Date: 2026-11-06
Status: draft, awaiting owner review

## Context

Leveret's only scored benchmark, `bench/corpus.v1.json`, holds 13 hand-labelled
CodeRabbit findings from `pfBlockerNG/pfBlockerNG`. Since it was frozen, the owner's
pull requests have accumulated reviews from several bots across many repositories:
CodeRabbit (`coderabbitai`), Codex (`chatgpt-codex-connector`), Kilo Code
(`kilo-code-bot`), roboomp (`can1357/oh-my-pi`), and openwrt-ai (OpenWrt). A survey
on 2026-11-06 found about 1,000 PRs authored by `andrebrait` outside his own account,
across 47 repositories, plus his own `andrebrait/*` repositories and fork companion
PRs.

This is stage 1 of three. Each stage has its own spec, plan, and implementation:

1. **Gap analysis (this spec):** label every bot finding on the owner's PRs and
   measure what each bot catches, what maintainers accept, and what Leveret misses.
2. **Corpus v2:** freeze a multi-repository, multi-bot scored corpus from the
   stage-1 labels and extend the replay, report, and parity gate to it.
3. **Repository memories:** turn accepted and rejected findings, together with the
   maintainer replies, into per-repository Leveret memories.

## Goal

Produce evidence about review effectiveness that later work on prompts, policy, and
the corpus can rely on:

- the acceptance rate and noise rate of each bot;
- which categories of defect each bot finds, and how often each is accepted;
- accepted findings that only one bot raised, on PRs reviewed by more than one bot;
- the fraction of accepted bot findings that Leveret also finds, on a stratified
  sample.

Non-goals: a scored gate (stage 2), memory generation (stage 3), and any change to
Leveret's review engine.

## Inputs

- **PR source:** every pull request authored by `andrebrait`, in any repository,
  open or closed. Fork companion PRs and upstream PRs are both included.
- **Bot detection:** an author is a bot when its account type is `Bot`, its login
  ends in `[bot]`, or it is on the known list `openwrt-ai`, `roboomp`,
  `kilo-code-bot`. The known list exists only for accounts that GitHub does not mark
  as bots. Bots that appear later are detected without code changes.
- **Finding units:** inline review comments, review bodies, and PR conversation
  comments by a bot. A review body that only summarizes inline comments, a
  rate-limit or usage-limit notice, a walkthrough, or a status message is labelled
  `notice` and is not counted as a finding.
- PRs with no bot comments are counted in the report and then skipped.

## Pipeline

One script, `bench/mine.mts`, run through `npm run bench:mine`. It runs three
passes, each resumable from a gitignored cache at `.cache/mine/`.

### Pass 1: fetch

For each PR, cache:

- the PR metadata (base and head SHAs, state, merge commit);
- review comments, reviews, and issue comments, including the author type;
- review threads with `isResolved` (GraphQL);
- the commits pushed after each bot comment, with their diffs for the commented
  files.

GitHub calls read the `x-ratelimit-remaining` and `x-ratelimit-reset` headers and
wait until the reset when the quota is exhausted. Each PR is written to the cache
atomically when its fetch completes. A rerun skips PRs that are already cached,
unless `--refresh` is given.

### Pass 2: signals

For each finding, compute the mechanical signals:

| Signal | Meaning |
|---|---|
| `fixed` | A later commit on the PR changed lines within ±3 of the commented range in the same file. |
| `resolved` | The review thread is resolved. |
| `replied` | A human replied in the thread or quoted the finding. The reply text stays in the cache. |
| `notice` | The comment is not a finding (see Inputs). |
| `unknown` | The data for `fixed` is unavailable: deleted fork, force-pushed head, or unreachable SHA. |

A finding is labelled `accepted` without the judge when it has `fixed` and
`resolved` and no human reply. It is labelled `rejected` without the judge when it is
`resolved`, has no `fixed`, and the PR merged with the commented lines unchanged.
Everything else goes to pass 3.

### Pass 3: judge

A Flash-tier model (Gemini Flash or Grok) reads the finding, the replies, and the
follow-up diff. It returns `accepted`, `rejected`, or `unclear`, and one category
from a fixed list: `bug`, `security`, `concurrency`, `error-handling`,
`test-integrity`, `performance`, `api-contract`, `docs`, `style`, `other`.
Mechanically labelled findings also receive a category from the judge.

- Model calls are made by the bench script, never by Leveret's engine.
- Output is validated against a zod schema. Malformed output is retried once and
  then labelled `unclear`; it is never treated as `rejected`.
- Each judged row records the model identifier and the prompt's SHA-256.

### Hand audit

The miner writes a seeded random sample of 50 labelled findings to a local checklist
in the cache. The owner labels them by hand. The report states how often the
automatic labels agree with the hand labels, per label source (mechanical or judge).

### Leveret comparison

A stratified sample of about 60 PRs (stratified by repository, bot, and category,
restricted to PRs whose base and head commits are still fetchable) is replayed once
through Leveret with Flash-tier models, using the existing replay path. A Leveret
finding matches an accepted bot finding when it is in the same file, within ±3
lines, and the judge confirms they describe the same mechanism. The report gives the
match fraction with a 95% Wilson confidence interval.

## Outputs

### `bench/review-labels.v1.jsonl` (committed)

One row per finding, sorted by URL:

```json
{
  "url": "https://github.com/OWNER/REPO/pull/N#discussion_rID",
  "repository": "OWNER/REPO",
  "pull_request": 123,
  "bot": "coderabbitai",
  "kind": "inline | review | conversation",
  "path": "src/x.ts",
  "line": 42,
  "head_sha": "<40 hex>",
  "category": "bug",
  "disposition": "accepted | rejected | unclear | notice",
  "signals": ["fixed", "resolved"],
  "label_source": "mechanical | judge",
  "judge": { "model": "<id>", "prompt_sha256": "<64 hex>" },
  "duplicate_of": "<url or null>"
}
```

`path` and `line` are null for comments that are not inline. `judge` is null for
mechanical labels. `duplicate_of` links a fork companion's finding to the upstream
finding with the same head SHA, bot, path, and line. The row schema is strict and has
no field for comment or code text.

### `docs/reports/<date>-bot-gap-analysis.md` (committed)

Generated from the JSONL and the comparison run. It contains:

1. **Per bot:** findings, accepted, rejected, unclear, noise rate, and median
   findings per PR.
2. **Per category:** which bots find it and the acceptance rate.
3. **Overlap:** on PRs with two or more bots, accepted findings that only one bot
   raised.
4. **Per repository and language:** each bot's acceptance rate and finding count.
5. **Leveret gap:** the match fraction on the sample, with its confidence interval
   and the categories of the misses.
6. **Label quality:** hand-audit agreement, and counts of `unknown` signals.

Findings are counted once after deduplication. The report quotes no comment or code
text, and links to findings by URL.

## Privacy

- Committed artifacts hold URLs, labels, SHAs, paths, and line numbers only.
- Comment bodies, replies, and diffs stay in `.cache/mine/`, which is gitignored.
- Default stdout prints progress counts only, never comment text.

## Testing

`test/mine.test.ts`, on fixtures recorded from real API responses with the text
replaced:

- signal classification: the ±3 line window (hit at the edge, miss just outside),
  resolved and unresolved threads, notice detection for each bot's notice format;
- bot detection, including the known non-`Bot` accounts and a new `[bot]` login;
- deduplication of fork companion and upstream findings;
- the label row schema rejects a row that carries any extra field;
- resume: a second run over a populated cache makes no network calls.

Smoke proof: a live run on five PRs, one each from `pfBlockerNG/pfBlockerNG`,
`kahme247/ompweb`, `can1357/oh-my-pi`, `openwrt/packages`, and `leveret-dev/leveret`,
with the resulting rows checked by hand.

## Open risks

- Judge labels carry noise. The hand audit measures it but does not remove it.
- `fixed` misses fixes made in a different file or in a later PR. Those findings go to
  the judge as ambiguous rather than being counted as rejected.
- A sample of about 60 PRs gives wide confidence intervals for per-category
  comparisons with Leveret. Stage 2 provides the precise measurement.
