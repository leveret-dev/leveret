# Java reference evidence: deterministic evaluation

Date: 2026-09-29

Status: Extraction, persistence, sandbox, and the registered reviewer tool were exercised. **Actual Leveret model consumption remains unverified:** no separate paid/local model-execution approval was supplied.

## Reproduction and provenance

- Branch baseline: implementation plan commit `e19eae0`; approved contract: [`../superpowers/specs/2026-09-29-inspect-java-references-design.md`](../superpowers/specs/2026-09-29-inspect-java-references-design.md).
- Host: Linux x86-64, Temurin JDK 26.0.2, Bubblewrap 0.12.0, util-linux `prlimit` 2.41.5. The fixture requested Java 21; the Commons Lang POM requests Java 1.8. These are explicit source levels, not the worker JDK default.
- Operator template: `/tmp/leveret-java-eval-template.json`, SHA-256 `4223a889673bf2cc0cc8468f055b4ead56b0960440ba3ec132928b2399d55df3`. The driver froze installed distribution and JDK file hashes in separate derived, external fixture/corpus configurations. No checkout supplied an executable, cache path, mount, JVM option, or worker limit.
- Deterministic command: `npx tsx bench/inspect-java.mts --mode deterministic --config /tmp/leveret-java-eval-template.json --config-sha256 4223a889673bf2cc0cc8468f055b4ead56b0960440ba3ec132928b2399d55df3 --output /tmp/leveret-java-eval-20260929-i`.
- Detailed results and selector list outside Git: `/tmp/leveret-java-eval-20260929-i/deterministic.json` (SHA-256 `1af5d5488323f30dc08f0344ba3bfcbf9ca6b1e12ce25f8a5483ff7772b564dd`) and `/tmp/leveret-java-eval-20260929-i/frozen-selectors.json` (SHA-256 `2a821a9a392dd52bbcba556b73a1fd226fd538dbf2b8748bae1a1953605954c1`). Derived fixture configuration SHA-256 `8b6832105507bf759dfd0ffa059ca12d3200cb4d83afd538239228cb59e5e1ea`; corpus configuration SHA-256 `474b48b390a9b2c911b4c509475f13886dff36e8212b734381fad7fb24abf3e1`. No historical private Inspect documents or downloaded corpus were imported into Leveret.

## Fixed two-file change

| Case | Pinned revision(s) | Observed result |
| --- | --- | --- |
| Numeric overload | Base `55c3f80ed43b46c7331c59ee54dc8f4cd1688efb`, head `aa505c1f2e5ecf982103cf1246ae439cf5d03f23` | The changed `price(int)` declaration (`Lexample/Pricing;.price(I)I`) returned only `src/test/java/example/PricingTest.java:3`, UTF-16 columns `[27,43)`, in `numeric()`, source set `test`, kind `call`, basis `checked`. The `price(String)` call was excluded. Main 1/1 and test 1/1 files examined; coverage complete for supported forms. A dirty, unchanged test source was rejected before query. Initial analysis plus query: 7,418 ms. |
| Missing argument type | `b16b194bbf544a57cfeefb5f370b15f482490b22` | The same checked numeric call survived. Two sites involving `MissingInputs` were separately unresolved; test coverage incomplete, with one compiler diagnostic. Neither site was promoted to a checked overload. |
| Deleted method | `e3300e03ad9f114a5da14fad9709a06812f6ac58` | The base-side selector returned the unchanged test caller; the same selector on head returned `target-missing`, not an implicit base fallback. |
| Extra module | `59256fee0be093bbabcbc5e50d69c424d24f8f24` | `extra/src/main/java/Other.java` appeared as an unexamined file with an unsupported-root/module reason; main skipped 1, overall coverage incomplete. |
| Bounded pagination | Base `a17e64052e729fe77fc2104c0116f55a867a3ade`, head `99d18ef404ca07ee99ae39156546bb31206df103` | Seventeen distinct checked reference IDs were recovered in source order across 18 pages without loss, duplication, or a non-advancing cursor. |

For the same fixed revision and source sets, CodeGraph 1.6.0 returned `numeric()` and `textual()` as **structural caller candidates** for `example.Pricing.price`; their source lines were checked independently. That name-level response did not distinguish the overloads. Inspect's checked result did. Serena was unavailable because `LEVERET_SERENA_BUNDLE` was unset; no Serena result was fabricated.

## Pinned real Java repository

Apache Commons Lang revision `620f4ff4b4b0934e6dc46465fe5c92fd7e1fb997` was clean before analysis. The existing cache's `oracle-compile.txt` and `oracle-test.txt` matched SHA-256 `40d4238e3e537ef7e6f78086095fd93557624184998fd0fde8e95ab24a55d8df` and `115961f299e56e2a5225653868471aba1c740fab409300c2b7d72a894d92a0fe`. Twenty-three referenced JARs had aggregate path-and-content digest `9c76ea5dda6590b9f30b61ff488b04a278cce27c9c305c4cf5c1783f90eddb86`; no package manager, target build, generator, processor, or test ran during extraction.

The driver froze the first 20 syntax-derived method selectors, sorted by repository path and method-name byte offset, **before** invoking Inspect or CodeGraph. ast-grep 0.45.3 enumerated 4,275 methods; the selected 20 happened to lie in `AnnotationUtils.java` and `AppendableJoiner.java`. ast-grep outline is syntax-local and does not resolve references ([official outline contract](https://ast-grep.github.io/reference/outline-rules)). This fixed selection is intentionally narrow, not a random or representative sample.

- Inspect analysis ID `0f6e1de2424cbbec3f8feaf761e6b262fa527afa8487487bb373e2177a1c53c0`; derived configuration SHA-256 `474b48b390a9b2c911b4c509475f13886dff36e8212b734381fad7fb24abf3e1`. All 20 selectors resolved, and each selector was paged to a complete delivery (3 pages each), yielding 77 distinct checked reference records within examined source. Coverage was complete for supported forms: 264 main and 362 test files examined, zero unresolved sites, zero skipped files and zero compiler diagnostics. Zero results for an individual method mean no checked references in this stated scope, not safety.
- An earlier run on the same revision recorded 69 records and four unresolved test sites. That driver kept only the first page, and scope-wide details could push target references past it; target-first ordering plus complete paging accounts for the eight additional records. The four unresolved sites disappeared after implicit enum `values`/`valueOf` and synthetic record members stopped counting as gaps, the only change in that fix set that removes unresolved sites; their individual locations were not retained by the earlier driver.
- CodeGraph indexed the same revision's Java production/test files and returned 31 **caller candidates** across the 20 queries. Seven symbol queries returned non-JSON informational output, recorded as indeterminate rather than empty. Its rows are caller-method candidates, whereas Inspect rows are exact call/method-reference sites; the counts are not directly comparable and establish no general superiority. Nearby source text was inspected for candidate names but did not establish exact overload bindings.
- Serena 1.7.0 was installed but had no staged `LEVERET_SERENA_BUNDLE`; its Java reference comparison was unavailable, not negative.
- Warm-cache extraction/open of this corpus took 18,720 ms. Across 20 selectors, complete paged Inspect queries took 5,585–9,492 ms (median 6,592 ms; sum 139,005 ms); CodeGraph query latency was 281–430 ms (median 324 ms; sum 6,556 ms). Total comparison wall time was 164,449 ms. These are single-host observations, not throughput promises.

## Verification

- `./inspect/gradlew -p inspect :runtime:installDist`: successful; installed distribution contains `THIRD-PARTY-NOTICES.txt`.
- `npm run build`: successful.
- `npm test`: 33 files, 257 tests passed.
- `npm run test:inspect`: all JVM module tests passed. Existing classpath oracles may provision fixture-only caches as part of their test boundary; the production extractor never runs target build tools or tests.
- `npx tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck --strict bench/inspect-java.mts`: successful. The opt-in deterministic CLI exercised the installed sandboxed command; review mode remained gated.

## Authorization and remaining acceptance

The deterministic driver made **no provider calls**. Registered-tool tests called `leveret_java_references`, retrieved the unchanged caller source, and observed evidence IDs, but a scripted tool call is not a Leveret model review. Review mode requires a separate `LEVERET_PAID_MODEL_APPROVED=1` operator authorization and a real Pi reviewer trace. This gate was not opened, so there is no verified reviewer reasoning/coverage use of the returned caller or model disclosure of the missing-dependency case. Do not describe this feature as acceptance-complete, merged, deployed, or a replacement for Leveret's separate parity gate.
