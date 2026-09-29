# Java method references for Leveret

Date: 2026-09-29

Status: The conversational contract is approved. This written specification awaits
maintainer review; implementation planning and implementation are not authorized
by that approval alone.

## Purpose and scope

Leveret is the product. Inspect is its inspection and information-extraction
module, supplying evidence rather than review judgments.

The first integrated capability answers:

> Which checked source references outside this diff target this exact Java method?

Success requires a real Leveret review to retrieve and use an out-of-diff
reference. Producing or persisting facts without a reviewer consumer is not
completion. This implements the bounded semantic-intelligence direction in
[Leveret #76](https://github.com/leveret-dev/leveret/issues/76).

The initial scope is one Java module, including production and test source roots,
using supported cache-only classpath inputs. Executable method invocations and
method-reference expressions are included. Constructors, documentation links,
import statements, whole-program runtime dispatch, automatic cross-revision
symbol matching, and transitive impact queries are outside this contract.
Unsupported roots or modules must be disclosed, not silently omitted.

## Worked example

At the head revision, `src/main/java/example/Pricing.java` contains:

```java
package example;
final class Pricing {
    static int price(int quantity) { return quantity * 12; }
    static int price(String code) { return code.length(); }
}
```

Only the body of `price(int)` changed. The unchanged file
`src/test/java/example/PricingTest.java` contains:

```java
package example;
final class PricingTest {
    int numeric() { return Pricing.price(3); }
    int textual() { return Pricing.price("ABC"); }
}
```

Selecting the first declaration returns the invocation in `numeric()`, with
`numeric()` as its enclosing caller and `test` as its source set. The invocation
in `textual()` is excluded because it resolves to the other overload. Neither the
target build nor these test methods executes during inspection.

For a missing-dependency variant, add a method containing
`Pricing.price(MissingInputs.quantity())` to the second file, without providing
`MissingInputs`. That site must not appear as a checked call to either overload
unless its target can independently be established without recovered bindings.
Any indeterminate site is reported separately, with incomplete coverage. The
independently checked `Pricing.price(3)` result remains available.

## Boundaries and ownership

1. Leveret owns the change manifest, review lifecycle, trusted configuration,
   checkout identity, and interpretation of evidence.
2. Inspect owns extraction, analysis identity, fact storage, coverage reporting,
   and exact-method reference queries.
3. Existing classpath workers provide supported main/test classpaths and their
   diagnostics. Eclipse JDT provides bindings in a bounded worker process.
4. Existing H2 persistence stores finalized analyses. A thin internal integration
   makes queries available to the actual reviewer; it is not a separate server,
   public product API, or independently operated service.

Reuse [ChangeManifest](../../../src/change-evidence.ts) for base/head identities
and diff hunks. Reuse the evidence conventions in
[evidence-pack.ts](../../../src/evidence-pack.ts) and
[change-evidence.ts](../../../src/change-evidence.ts) for provenance, explicit
omissions, bounded delivery, and continuation. Do not introduce a competing diff
schema or represent semantic references as deterministic defect findings.

## Inputs and identity

Analysis accepts a repository identity, exact revision, verified source snapshot,
production and test roots, Java language level, ordered classpaths, and finite
worker limits supplied by trusted host policy. Main and test classpaths remain
distinct. Language settings and unsupported configuration must be explicit; a
host-JDK default must not silently stand in for the target's requested language.

The analysis identity is a digest of all inputs capable of changing the facts:
repository/revision, source contents and root/source-set assignments, extractor
and JDK identities, effective language configuration, ordered artifact identities
and content hashes, and effective resolution configuration. Preserve the
classpath workers' resolver versions, active profiles, and repository policy as
provenance. Paths alone are not artifact identity. A dirty or mismatched checkout
cannot be labeled as the requested revision.

A query supplies the analysis identity, existing change manifest, selected side
(`base` or `head`), and a declaration location identifying exactly one method.
The query also supplies a finite delivery budget, with an optional continuation
cursor. The selected manifest revision must match the analysis revision. A
method name alone is not a selector.

The selected method has an analysis-scoped symbol ID, signature, and declaration
range. No cross-revision stability is promised. Deleted methods can be queried
against the base snapshot. A failed lookup on head must not silently fall back
to base. Checkout paths and selectors are validated at the boundary.

## Result contract

A successful query returns these logical sections; the implementation plan will
map them onto the owning typed boundary rather than create a universal graph API.

| Section | Required content |
| --- | --- |
| Identity and target | Analysis identity, repository/revision, configuration identity, selected side, method symbol ID, signature, and declaration range |
| Checked references | Reference range, enclosing callable ID and declaration location when one exists, source set, kind (`call` or `method-reference`), target ID, and basis `checked` |
| Unresolved evidence | Site ranges, diagnostic reasons, and any known candidate IDs with their actual evidence basis; unknown candidates remain unknown |
| Coverage | Main/test scope and examined/skipped files, unresolved-site counts, diagnostics, and explicit complete/incomplete analysis coverage |
| Delivery | Returned and omitted information, explicit truncation, and an analysis/query-bound continuation cursor or `null` when exhausted |

A method reference identifies a referenced declaration; its enclosing method is
not thereby asserted to invoke that declaration. References in initializers may
have no enclosing callable. Results have deterministic source-location order,
with a stable tie-breaker for distinct records at the same location.

Unresolved evidence describes gaps in the analyzed scope. It is not attributed
to the selected method without supporting evidence. An ambiguous candidate is
not a checked reference. Candidate production is optional when the existing
producer cannot supply it; this slice does not add a structural fallback engine.

JDT binding recovery is not authority. A checked target must have a non-recovered
binding and sufficient non-recovered identity information to distinguish its
declaration. A recovered binding cannot be promoted by matching its name.

### Locations and diff filtering

Paths are repository-relative. Positions use one-based lines and zero-based
UTF-16 columns; ranges have exclusive ends. Invocation and method-reference
ranges cover the respective expression. Declaration ranges cover the method
declaration. Adapters explicitly convert to line-only consumer formats.

A reference is outside the diff when its range does not intersect changed hunk
lines on the selected side. Use `oldStart`/`oldLines` for base and
`newStart`/`newLines` for head. A zero-line side of a hunk contains no changed
source lines. Do not treat unchanged context lines as changes. If a range ends
at column zero, that ending line is not part of the range.

The query includes unchanged lines in changed files, not just unchanged files.
For renamed paths, use the selected side's path. An incomplete change manifest
cannot support an authoritative outside-diff classification and must be rejected.

### Coverage and delivery are independent

Complete delivery does not imply complete analysis. A finalized analysis can
have unresolved or skipped input and therefore incomplete coverage even when
all its query records have been delivered. Coverage summaries must survive
response truncation; detailed diagnostics and sites may require continuation.
Cursors cannot be reused with another analysis, target, manifest, or side.

An empty checked-reference list means only that none were found within the
stated scope and coverage. Even complete coverage concerns the supported static
reference forms, not reflection, dependency injection, runtime dispatch, or
proof that a change is safe.

## Failures, storage, and execution safety

Use one structured error shape with a machine-readable reason and diagnostic
message. Distinguish invalid input, snapshot/configuration mismatch, target
missing or indeterminate, unavailable analysis, invalid cursor, and worker
failure/resource exhaustion. These failures are not successful empty lists.

Missing dependencies produce incomplete coverage and explicit diagnostics, while
independently checked facts remain usable. A worker that finishes normally with
resolution gaps can finalize an incomplete-coverage analysis. A crashed or killed
worker cannot publish an unfinished analysis as complete or silently substitute
an older one; partial extraction is not a finalized queryable snapshot.

Store facts under their analysis identity and publish them atomically. Queries
select that identity, never merely the latest repository graph. PR-head facts
remain separate from accepted-base facts and cannot overwrite them. Only a
verified accepted revision may serve as an accepted-base analysis.

The worker has an enforced memory cap and deadline, no analysis credentials, and
no network access during extraction. It reads hostile source/archive data but
never runs target builds, package managers, generators, processors, or tests.
Reuse existing cache-only workers; cold-cache provisioning is not introduced by
this slice. Worker launch configuration and artifact access come from trusted
host policy rather than executable instructions in the target repository.

## Acceptance and evaluation

| Scenario | Required evidence |
| --- | --- |
| Exact overload and test caller | The worked example returns only `numeric()`'s call to `price(int)`, with checked basis and exact ranges |
| Reference kinds and locations | Method references remain distinct from calls; initializer references allow no enclosing callable; Unicode/range boundaries convert correctly |
| Missing or ambiguous dependency | Independently checked results survive; unresolved/recovered sites are separate; coverage is incomplete rather than falsely empty/complete |
| Revision and diff boundaries | Stale configuration or source is rejected; base/deleted-method queries work explicitly; unchanged lines, renames, zero-line hunks, and incomplete manifests follow the filtering rules |
| Bounded integrated consumption | Continuation preserves identity and omissions; worker failure publishes no complete snapshot; a real Leveret review retrieves and uses an out-of-diff reference |

Exercise deterministic cases through real extraction and query boundaries, not
mocked producer output alone. Include overload discrimination and missing-input
cases that can fail for plausible consumer-visible errors. Verify enforcement
of worker limits and the no-execution/no-credentials boundary.

Evaluate fixed Java examples and one pinned real repository against evidence
available through existing CodeGraph/Serena capabilities. Record useful extra
evidence, unresolved coverage, analysis/query latency, and the review's use of
the evidence. Any paid model run remains subject to separate execution approval;
a scripted query alone does not satisfy the real-review acceptance criterion.
This evaluation neither changes nor blocks Leveret's separate parity gate.

## Deferred work and approval gate

Multi-module resolution, cold-cache provisioning, additional languages, broad
rule catalogs, transitive impact analysis, remediation, and shared artifact
indexes require demonstrated need. Their absence is disclosed, not hidden
behind a claim of general Java support.

No historical private documents are imported by this specification. It records
the newly approved Leveret contract using current public implementation
boundaries. No separate inspect product lifecycle is introduced.

After maintainer approval of this written specification, create and review an
implementation plan before selecting an execution method. This document does
not itself authorize implementation, publication, deployment, or paid trials.
