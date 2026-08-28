# Sonar Community Build Clean-Room Specification Coordination Design

## Purpose

This project will produce source-informed, implementation-independent specifications for the current stable SonarQube Community Build release and every analyzer or integration bundled with that release. The specifications must tell an independent implementation team what each part does, how it behaves, and which capabilities it must provide without reproducing implementation code or source-specific expression.

## Baseline

The source audit will identify and pin the current stable SonarQube Community Build release. Analyzer and integration revisions will be resolved from that release's build metadata and distribution contents. Branch heads will not be substituted for pinned revisions. The manifest will record each repository, tag or commit, distribution artifact, and source tree used for analysis.

Upstream source checkouts will remain outside this specification directory. Only specification documents, provenance facts, capability inventories, and license decisions may be written here.

## Output Structure

The output will use four top-level groups:

- `manifest/` records the release baseline, source revisions, license decisions, dependency relationships, and coverage status.
- `platform/` contains one subdirectory for each independently implementable Community Build platform part.
- `analyzers/` contains one subdirectory for each bundled language analyzer or inseparable analyzer family.
- `integrations/` contains one subdirectory for each bundled scanner, build-system bridge, protocol adapter, or external-system integration.

Every bundled artifact must map to exactly one full specification or one strong-copyleft copy marker. Shared behavior must have one owner and explicit references from dependent specifications.

## Source and License Handling

License classification applies to the smallest practical repository subtree. Repository-level classification must not hide differently licensed embedded or generated trees.

A tree under a strong copyleft license, including GPL or AGPL, receives a concise provenance document that identifies the repository, pinned revision, protected path, SPDX license identifier, and the instruction `copy directly, <license>`. No redundant behavioral specification will be produced for that protected tree.

Trees under LGPL, MPL, EPL, permissive, source-available, proprietary, or unclear terms do not qualify for this shortcut. They receive full clean-room specifications unless distribution rights or access prevent inspection. Unclear terms are recorded as unresolved license facts and treated conservatively; they are never silently classified as strong copyleft.

This process records observed license terms and is not legal advice.

## Per-Part Specification Contract

Each full specification will contain:

1. Identity, pinned source provenance, scope, exclusions, dependencies, and owned contracts.
2. Purpose and externally observable capabilities.
3. Accepted inputs, emitted outputs, public interfaces, identifiers, defaults, and precedence rules.
4. Processing stages, state transitions, persistence behavior, concurrency behavior, and lifecycle.
5. Language, file, project, and version detection behavior where applicable.
6. Complete rule, metric, symbol, issue, and indexing behavior where applicable, including parameters, exclusions, reporting locations, and expected classifications.
7. Configuration surfaces, compatibility requirements, extension points, and interoperability contracts.
8. Failure behavior, partial-result behavior, limits, security boundaries, and recovery behavior.
9. Prose acceptance scenarios with preconditions, actions, and expected outcomes.
10. Traceability from every stated capability to source paths, tests, documentation, metadata, or observable distribution behavior.

Specifications may preserve public names required for compatibility, including protocol fields, rule keys, metric keys, configuration keys, artifact coordinates, API paths, and externally visible identifiers. They must not contain implementation source, pseudocode, copied snippets, copied comments, decompiled output, or source-specific explanatory prose. Rule examples must be described in prose rather than source-language samples.

## Writer Coordination

The coordinator will first build the release inventory and license map. Work will then be divided by independently implementable part. Each writer receives:

- one owned output directory;
- exact pinned repositories, revisions, and source paths;
- relevant distribution artifacts and public documentation;
- known dependencies and shared-contract owners;
- the per-part specification contract;
- the prohibition on source and pseudocode.

Writers may inspect source, tests, metadata, documentation, and released artifacts. They must paraphrase behavior, cite provenance, distinguish observed facts from inference, and report missing evidence rather than invent behavior.

Parts with cross-cutting contracts will be written independently after contract ownership is assigned. The coordinator will reconcile terminology and references after all writers finish; writers must not create competing shared specifications.

## Integration Review

The coordinator will verify:

- every bundled platform module, analyzer, plugin, scanner, and integration is covered;
- every source tree has a pinned revision and license decision;
- every full specification includes what, how, capabilities, failure behavior, and acceptance criteria;
- rule and metric catalogs are complete for the pinned release;
- shared identifiers and contracts agree across parts;
- dependency references resolve to owned specifications;
- no implementation code, pseudocode, copied source text, or source-language examples appear in outputs;
- no placeholders, unresolved contradictions, or silent coverage gaps remain.

The final manifest will report covered parts, strong-copyleft copy markers, excluded artifacts with reasons, and any evidence limitations that prevent a complete claim.

## Completion Criteria

The project is complete when the pinned Community Build distribution can be accounted for artifact by artifact; each in-scope part has a conforming subdirectory; all cross-part contracts are consistent; all license decisions are traceable; and an independent implementation team can derive expected behavior and acceptance checks without access to the upstream checkout.
