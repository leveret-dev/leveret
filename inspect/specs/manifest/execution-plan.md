# Sonar Community Build Clean-Room Specification Execution Plan

> **For agentic workers:** Execute assigned parts independently. Read `manifest/coordination-design.md` before inspecting upstream material. Do not place upstream source inside this specification workspace.

**Goal:** Produce complete, source-informed, code-free specifications for the current stable SonarQube Community Build release and every bundled analyzer and integration.

**Architecture:** A coordinator pins the release, inventories its artifacts, classifies source-tree licenses, assigns one independently implementable part to each writer, and integrates the resulting documents through shared contracts and a coverage manifest. Upstream checkouts remain outside the output workspace.

**Materials:** Upstream Git repositories, released Community Build distribution metadata, public documentation, source tests, build metadata, and Markdown specifications.

**Design:** `manifest/coordination-design.md`

## Global Constraints

- Target the current stable SonarQube Community Build release selected when source audit begins.
- Resolve analyzer and integration revisions from that release; do not substitute current branch heads.
- Keep every upstream checkout outside this specification workspace.
- Write prose specifications only. Do not include source, pseudocode, copied snippets, copied comments, decompiled output, or source-language examples.
- Preserve public compatibility identifiers only when required to define observable contracts.
- Apply license decisions per source subtree.
- Use a strong-copyleft copy marker only for GPL or AGPL trees. Do not apply that shortcut to LGPL, MPL, EPL, permissive, source-available, proprietary, or unclear trees.
- Cite repository, revision, source path, and evidence type for every capability.
- Distinguish observed facts from inference. Do not invent missing behavior.
- Map every bundled artifact to exactly one full specification or strong-copyleft marker.

## Task 1: Pin and Acquire the Release

**Outputs:**

- Create `manifest/release-baseline.md`.
- Create upstream checkouts in a temporary directory outside this workspace.

**Steps:**

- [x] Identify the newest stable release designated SonarQube Community Build by official release metadata.
- [x] Record release name, version, tag, commit, publication date, distribution coordinates, and official source URL.
- [x] Acquire the exact tagged SonarQube source into the external source directory.
- [x] Record immutable checkout commit and archive checksums when published artifacts are available.
- [x] Confirm the workspace contains no copied upstream files.

**Acceptance:** `manifest/release-baseline.md` identifies one reproducible release and its immutable source revision.

## Task 2: Build the Bundled-Part Inventory

**Outputs:**

- Create `manifest/component-inventory.md`.
- Create `manifest/dependency-map.md`.

**Steps:**

- [x] Inspect release build metadata and distribution contents to enumerate platform modules, bundled plugins, analyzers, scanners, and integrations.
- [x] Resolve every bundled artifact to its source repository, exact tag or commit, artifact coordinate, and distribution location.
- [x] Acquire required repositories at resolved revisions in the external source directory.
- [x] Divide platform modules into independently implementable behavioral parts rather than mirroring incidental build directories.
- [x] Assign each shared protocol, storage model, rule catalog, metric catalog, and lifecycle contract to one owning part.
- [x] Record dependency relationships and specification references between parts.
- [x] Mark non-functional packaging artifacts as excluded with concrete reasons.

**Acceptance:** Every bundled artifact appears once in the inventory with source provenance, planned output directory, and contract owner.

## Task 3: Classify Source-Tree Licenses

**Output:** Create `manifest/license-map.md`.

**Steps:**

- [x] Inspect repository license files, file headers, notices, vendored-tree notices, generated-source declarations, and subtree-specific terms at pinned revisions.
- [x] Record SPDX identifier, copyright owner, evidence path, and affected tree for each decision.
- [x] Split mixed-license repositories at the smallest practical subtree.
- [x] Label GPL and AGPL trees as strong copyleft.
- [x] Label LGPL, MPL, EPL, permissive, source-available, proprietary, and unclear trees as requiring full specifications.
- [x] For each strong-copyleft tree, create its planned part directory and a provenance document containing `copy directly, <license>`.
- [x] Record unclear or inaccessible terms as evidence limitations; do not infer permissive status.

**Acceptance:** Every inventoried source tree has a traceable license decision and exactly one output treatment.

## Task 4: Dispatch Independent Part Writers

**Outputs:**

- Create `platform/<part>/specification.md` for each non-strong-copyleft platform part.
- Create `analyzers/<language-or-family>/specification.md` for each non-strong-copyleft bundled analyzer.
- Create `integrations/<integration>/specification.md` for each non-strong-copyleft integration.
- Create one provenance copy marker in place of each strong-copyleft specification.

**Steps:**

- [x] Prepare one assignment per independent part using exact inventory row, source revisions, source paths, dependencies, and owned contracts.
- [x] Dispatch all assignments that do not share output files in one parallel batch.
- [x] Require each writer to cover identity, purpose, capabilities, inputs, outputs, processing behavior, state, configuration, compatibility, failure behavior, limits, security boundaries, and prose acceptance scenarios.
- [x] Require analyzer writers to cover language and version recognition, file detection, parsing and semantic behavior, symbol and dependency models, rule keys, rule behavior, parameters, exclusions, issue locations, metrics, indexing, and partial-analysis behavior.
- [x] Require platform writers to cover startup, plugin lifecycle, scanner ingestion, compute processing, persistence, issue lifecycle, quality profiles, quality gates, authentication, authorization, APIs, background tasks, project lifecycle, and extension contracts within their assigned scope.
- [x] Require integration writers to cover discovery, configuration precedence, transport contracts, authentication, invocation lifecycle, compatibility, retries only where observed, failure reporting, and produced artifacts.
- [x] Require provenance for each capability and explicit `[INFERENCE]` labels where source evidence supports only an inferred contract.
- [x] Reject assignments containing implementation code, pseudocode, copied source expression, source-language examples, or undocumented behavior.

**Acceptance:** Every planned part directory contains a conforming full specification or strong-copyleft marker.

## Task 5: Integrate Cross-Part Contracts

**Outputs:**

- Update part specifications where contract references disagree.
- Update `manifest/dependency-map.md`.
- Create `manifest/coverage-index.md`.

**Steps:**

- [x] Compare every producer contract with all consuming specifications.
- [x] Normalize public identifier spelling, version constraints, default values, configuration precedence, state names, and failure semantics to pinned-release evidence.
- [x] Remove duplicate ownership and replace duplicated shared behavior with references to its owning part.
- [x] Verify analyzer outputs align with scanner ingestion, compute processing, issue persistence, profile activation, metric aggregation, and quality-gate evaluation.
- [x] Verify integration outputs align with the platform protocol and authentication specifications.
- [x] Map each inventory row to its completed output and status in the coverage index.
- [x] Record evidence limitations without weakening observed requirements.

**Acceptance:** Cross-part contracts have one owner, all references resolve, and every inventory row maps to a completed output.

## Task 6: Final Clean-Room and Completeness Review

**Outputs:**

- Create `manifest/review-report.md`.
- Finalize `manifest/coverage-index.md`.

**Steps:**

- [x] Check every specification against the per-part contract in `manifest/coordination-design.md`.
- [x] Search outputs for source-code fences, pseudocode, copied comments, source-language examples, placeholders, and unexplained source-specific terminology.
- [x] Compare rule and metric counts against pinned analyzer metadata.
- [x] Compare bundled artifacts against the coverage index and reject unmatched or multiply owned entries.
- [x] Verify all provenance references use pinned revisions.
- [x] Verify all strong-copyleft markers identify exact paths and licenses.
- [x] Review inferred statements and retain only those supported by cited evidence.
- [x] Confirm an implementation team can derive observable acceptance checks without upstream-source access.
- [x] Record checks, discrepancies found, corrections made, and remaining evidence limitations in the review report.

**Acceptance:** Review report demonstrates artifact coverage, contract consistency, provenance integrity, license coverage, and absence of implementation code.

## Task 7: Refresh Workspace Knowledge Graph

**Output:** Update the repository knowledge graph after all specifications are final.

**Steps:**

- [x] Run the repository's incremental graph update from the repository root.
- [x] Confirm new specification files appear in graph output.
- [x] Confirm no graph update failure requires recording in `manifest/review-report.md`.

**Acceptance:** Knowledge graph reflects final specification workspace, or review report contains exact blocking evidence when graph tooling is unavailable.
