# Pi quality replay vs OMP and CodeRabbit (2026-08-24)

This is a small quality benchmark, not a latency benchmark. Each replay ran the
current production runner as if the pull request had been submitted to Leveret:

- harness: `leveret-runner-pi`, Pi `0.84.2`, system prompt v2
- model: `openai-codex/gpt-5.6-sol`, thinking `high`
- capabilities: code graph and isolated probes enabled; LSP unavailable because
  `LEVERET_SERENA_BUNDLE` was unset
- credentials: only an OMP-exported OpenAI Codex access token was copied into an
  otherwise empty temporary Pi agent directory; no OMP settings, models, prompts,
  skills, extensions, rules, sessions, or caches were loaded
- verdict rule: a reported finding counts only when its current code or executed
  probe proves an in-scope defect. Deliberate ceilings and repository-priced rules
  are non-actionable even when technically true.

## Method correction

The 2026-08-21 benchmark replayed `refs/pull/N/head` after review fixes, then measured
recall against CodeRabbit findings raised on earlier commits. That cannot measure
recall: the accepted defects no longer exist at the replayed head.

This run therefore has two separate comparisons:

1. Final PR heads, matching the old OMP corpus, for Pi-to-OMP continuity.
2. CodeRabbit `original_commit_id` snapshots for a fair Pi-to-CodeRabbit recall
   check. Only #2444 and #2521 were added; #2417 had three incremental review
   snapshots and was left out to keep this session bounded.

## Final-head continuity against OMP

| PR | Head | Leads | Pi | Valid | OMP | Overlap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| pfBlockerNG #2417 | `b7ca578` | 11 | 4 | 1 | 2 | 1 |
| pfBlockerNG #2444 | `aaf8019` | 0 | 3 | 3 | 1 | 0 |
| pfBlockerNG #2521 | `0bdd7d9` | 24 | invalid JSON | — | 1 | — |
| **Total** | | | **7 + 1 failed run** | **4** | **4** | **1/4** |

Pi recovered only OMP's #2417 manual-republish race. It missed OMP's #2417
mutation-test gap and #2444 stale `--print-conf` reference; #2521 did not
produce a review. It did find three additional actionable #2444 defects.

Three #2417 publications were rejected during independent judgment:

- The third-release queue loss is explicitly documented with manual recovery: a
  deliberate current ceiling, not a newly discovered defect.
- SHA pinning is a repository-priced rule: this corpus had zero SHA-pinned Actions,
  and the old verifier already classified this class as noise.
- Same-varver rows are intentional. `live_gate_matrix.py` promises one row per CI
  leg and explicitly says those legs are never deduplicated by FreeBSD major.

Raw output: [archive](2026-08-24-pi-quality-raw-output.tar.gz).

## Calibrated recall against CodeRabbit

| PR | CR snapshot | Leads | Pi | Valid | CR accepted | Overlap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| pfBlockerNG #2444 | `ed359c6` | 0 | 4 | 4 | 6 | 0 |
| pfBlockerNG #2521 | `b312a6d` | 24 | 2 | 0 | 6 | 0 |
| **Total** | | | **6** | **4** | **12** | **0/12** |

These are not second reviews of the fixed PR heads. All six top-level CodeRabbit
comments on #2444 identify `ed359c691...` as their `original_commit_id`, and all
seven on #2521 identify `b312a6def...`. Leveret checked out those exact commits
directly, before any response fixes. The later `aaf8019` and `0bdd7d9` heads do
not contribute to this 0/12 result.

The four #2444 findings are evidence-backed defects CodeRabbit missed: failed
refresh overwrites a working conf, `pkg info -l` failure passes verification,
`fetch | sh` masks fetch failure, and the deprecated migrator repeats the inventory
fail-open. Pi found none of CodeRabbit's six findings on the same source tree.

Both #2521 findings were the already-priced mutable-Action-tag class, so
publishing them would be noise. Pi missed all six accepted CodeRabbit findings
on the same source tree. CodeRabbit posted a seventh suggestion about the GNU-tar
assertion, but the maintainer skipped it with executed reasoning: changing the
assertion to `/usr/sbin/tar` would make the check tautological.

The adoption recall gate still fails: **0/12**, now measured on valid pre-fix
snapshots rather than final heads. The systems remain complementary, not
substitutable.

Raw output: [archive](2026-08-24-pi-quality-raw-output.tar.gz).

## Leveret controls where CodeRabbit reported clean

| PR | Head | Leads | Pi actionable | CodeRabbit actionable | Judgment |
| --- | --- | ---: | ---: | ---: | --- |
| leveret #1 | `44058bd` | 0 | 2 | 0 | both confirmed |
| leveret #2 | `c1e8b1c` | 0 | 5 | 0 | all five confirmed |

Pi found seven real issues CodeRabbit missed:

- #1: duplicate custom-engine IDs corrupt per-engine counts; profile/memory status
  finalization lacks a regression-sensitive test.
- #2: space-delimited finding keys collide; reminder suppressions disappear
  from the tally; quoted Git paths lose reminder hunks; deleted-file hunks
  attach to the previous file; autonomous consumers were not taught the new
  `baseErrors` and `reminders` channels.

These defects remain observable in current `main`; the replay probes are
included in the raw outputs.

Raw output: [archive](2026-08-24-pi-quality-raw-output.tar.gz).

## Harness findings

1. **Recall has not improved against CodeRabbit's accepted set.** The calibrated
   result is 0/13 despite deep, useful findings elsewhere.
2. **Breadth improved substantially.** Pi produced fourteen final-head/control
   findings; eleven were independently actionable, including seven CodeRabbit-clean
   Leveret defects. The value is complementary breadth, not replacement recall.
3. **Publication precision is inconsistent.** The final-head/control set published
   three non-actionable #2417 findings out of fourteen (78.6% precision after human
   judgment). The calibrated set published two non-actionable findings out of six
   (66.7%).
4. **Runner reliability is not yet gate quality.** One of the five intended
   primary replays failed after both internal attempts because the assistant
   returned no JSON.
5. **Schema enforcement is shallow.** All six successful outputs emitted lens
   names as strings instead of the contract's lens objects; four also emitted
   file names as strings. `verifySchemaGaps()` accepts any non-empty arrays, so
   malformed coverage passes without correction.
6. **Tool timeout telemetry is incorrect.** Across the six successful outputs, 43
   calls were labeled `timeout` while all 43 had `isError: false`. The runner infers
   timeout by regex-searching tool output, so reading code or tests containing words
   such as `timeout` creates false timeout metrics.
7. **Cold repository memory remains the dominant gap.** The old OMP verifier knew
   mutable Action tags were priced noise; current Pi published the same class three
   times because no trusted ruling was available at these historical bases.

## Verdict

Pi is a better independent defect hunter than the old single-agent OMP result, but
it is not yet a better CodeRabbit substitute. It goes deep, executes useful probes,
and finds high-value defects the other reviewers miss. It still follows
different threads from CodeRabbit, fails to reproduce CodeRabbit's accepted
findings, and can publish known noise when memory is cold.

Do not unpark CodeRabbit retirement from this result. The next quality experiment
should first fix the JSON/schema/telemetry failures and seed trusted repo rulings,
then rerun these two exact `original_commit_id` snapshots. Adding more PRs before
those fixes would mostly repeat the same failure modes.
