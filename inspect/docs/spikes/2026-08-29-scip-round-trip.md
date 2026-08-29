# Spike: the SCIP round trip

> **Scope status, 2026-08-29 (final):** SCIP is both an import format and an opportunistic producer path — the toolchains these indexers need are provisioned in a sandbox we own at rung 2, never expected in the customer's environment, and the resolvable dependency tree they also need is often unavailable on a private codebase (`docs/specs/2026-08-29-code-graph-sourcing.md` §2, §5.3, §5.5). The reader mechanics, the call-derivation rule, and every operational trap below apply either way, including to an index the customer already produced.

**Date:** 2026-08-29
**Question:** "Produce an index with scip-go on a real Go repository, parse it in-process with the Maven Central bindings, and derive typed edges plus an unresolved set from occurrences."
**Verdict:** The round trip works and is cheap — 44k lines indexed in 5.9s, decoded in-process in 93ms, every typed edge kind populated — but **both signals section 7 expected to derive edge kinds from are absent in practice**: `syntax_kind` is `UnspecifiedSyntaxKind` on 100% of occurrences and `enclosing_range` appears only on function/method *definitions*, never on references; and the unresolved set cannot be synthesized from occurrences at all, because a reference this producer fails to resolve is not a symbol-less occurrence — it is no occurrence.

## Setup

```
# Go was not installed. Official tarball into the scratch dir, not the package manager.
curl -sSL -o go1.27.0.darwin-arm64.tar.gz https://go.dev/dl/go1.27.0.darwin-arm64.tar.gz
tar xzf go1.27.0.darwin-arm64.tar.gz && ./go/bin/go version   # go version go1.27.0 darwin/arm64
export GOROOT=$PWD/go PATH=$PWD/go/bin:$PATH GOPATH=$PWD/gopath
go install github.com/scip-code/scip-go/cmd/scip-go@latest    # scip-go --version -> 0.2.7
```

Scratch root `/Users/andre/git/leveret-spike/scip/`: `go/` (toolchain), `gopath/bin/scip-go`, `reader/`
(Maven project: `ScipStats`, `ScipDerive`, `ScipKeys`), `idents/` (Go `go/scanner` token dumper),
`subject-cobra/`, `subject-prom/`, `scip.proto` (962 lines, from the schema repository).

| Subject | Revision | Licence | Go files | Lines |
|---|---|---|---|---|
| `github.com/spf13/cobra` | `7da941c3547e93b8c9f70bbd3befca79c6335388` (v1.10.1) | Apache-2.0 | 36 | 16,656 |
| `github.com/prometheus/client_golang` | `89c60c0554699c74fa3d4eec472b98a3108905e3` (v1.24.1-32) | Apache-2.0 | 162 | 44,401 |

JVM: JDK 26.0.2.1, Maven 3.9.16. **The coordinate the sourcing document names resolves**; no `protoc` fallback was needed.

```
[INFO] spike:scip-reader:jar:1
[INFO] \- org.scip-code:scip-java-bindings:jar:0.9.0:compile
# transitive: com.google.protobuf:protobuf-java:4.34.2 (protobuf-java-util is <optional>)
# classes: org.scip_code.scip.{Index,Document,Occurrence,SymbolInformation,Relationship,SymbolRole,SyntaxKind}
```

## Measurements

| | cobra v1.10.1 | client_golang v1.24.1-32 |
|---|---:|---:|
| `scip-go index ./...` wall clock | 0.966 s | 5.907 s |
| index size, bytes (per source line) | 1,593,023 (96) | 4,672,213 (105) |
| JVM `Index.parseFrom` | 80 ms | 93 ms |
| documents (of which path escapes the root) | 37 (2) | 142 (18) |
| source files covered by a document | 35 of 36 | 124 of 162 |
| occurrences (carrying a symbol / **with no symbol**) | 22,763 (22,763 / **0**) | 49,457 (49,457 / **0**) |
| distinct symbols (of which `local N`) | 1,828 (789) | 3,440 (435) |
| definitions (`symbol_roles & 0x1`) / references | 3,880 / 18,883 | 8,601 / 40,856 |
| `ReadAccess` bit set | every reference | every reference |
| `Import` / `WriteAccess` / `Test` / `Generated` / `ForwardDefinition` | 0 | 0 |
| deprecated `range` field / typed `single_line_range` | 22,763 / **0** | 49,457 / **0** |
| `enclosing_range` on definitions / on references | 591 / **0** | 995 / **0** |
| `syntax_kind` other than `UnspecifiedSyntaxKind` | **0** | **0** |
| `SymbolInformation` (with `kind` / `signature_documentation` / docstring) | 3,849 (3,846 / 3,849 / 333) | 8,517 (8,508 / 8,503 / 760) |
| `Relationship`: total, `is_implementation` / `is_reference` / `is_type_definition` / `is_definition` | 19: 19 / 0 / 0 / 0 | 375: 375 / 0 / 0 / 0 |
| `external_symbols`; symbols referenced but not defined here | 0; 242 | 5; 862 |
| **derived** `declares` | 3,880 | 8,601 |
| **derived** `calls` (attributed to an enclosing caller) | 3,992 (3,991) | 6,548 (6,515) |
| …distinct caller→callee pairs | 2,524 | 3,818 |
| **derived** `instantiates` / `imports` / `references` | 460 / 199 / 13,548 | 1,548 / 799 / 31,663 |
| Go `IDENT` tokens (`go/scanner`) / covered by an occurrence | 24,948 / 21,946 | 65,573 / 47,484 |
| …in a file with **no document** | 22 (1 file) | 12,187 (38 files) |
| …uncovered but Go-predeclared | 2,980 | 5,806 |
| …**genuinely unresolved** | **0** | **96** (15 names) |
| moniker parse, all distinct symbols, best of 200 | 0.48 ms (265 ns/symbol) | 1.93 ms (560 ns/symbol) |

### The call-versus-reference rule, and its accuracy

Section 7 predicted "correlating the occurrence's syntax kind with its enclosing range"; for a reference
neither exists, and the index carries no `Document.text` either. What works:

> **`calls`** ⇔ the occurrence is **not** a `Definition`, **and** its symbol's last descriptor is a
> method descriptor (`name().` / `name(disambiguator).`), **and** the source character at the
> occurrence's end column is `(` or `[`. **Caller attribution:** the innermost definition-occurrence
> `enclosing_range` in the same document containing the reference range. Those ranges exist on exactly
> the `Function` + `Method` definitions (cobra 423+168 = 591, prom 656+339 = 995), which is why 3,991
> of 3,992 cobra calls get a caller.

Hand-checked on two named samples, 95 occurrences, **95 correct** (55/55 positives, 40/40 negatives):
**every method-descriptor reference in cobra's `flag_groups.go`**, and **the first 40 predicted non-calls index-wide**.

```
# positives, flag_groups.go
40:22  calls next='(' caller=Command#MarkFlagsRequiredTogether()  if err := c.Flags().SetAnnotation(v, requiredAsGroupAnnotation, append  | /FlagSet#SetAnnotation().
94:2   calls next='(' caller=Command#ValidateFlagGroups()          processFlagForGroupAnnotation(flags, pflag, requiredAsGroupAnnotation,  | /processFlagForGroupAnnotation().
216:6  calls next='(' caller=sortedKeys()                          sort.Strings(keys)  | scip-go gomod github.com/golang/go/src go1.15 sort/Strings().

# negatives, index-wide
cobra.go:33:36         "trim":                    strings.TrimSpace,  | … go1.15 strings/TrimSpace().
completions.go:775:21  Args:              NoArgs,                     | /NoArgs().
command.go:472:8       return defaultUsageFunc                        | /defaultUsageFunc().
```

The rule's one false-negative class is measured, not asserted: a call through a func-typed field or variable carries a *term* descriptor (`Run.`), invisible to the rule.

```
MISSED calls through a func-typed field/variable (term descriptor + paren)
  cobra 60   (signature_documentation contains "func(": 50, no SymbolInformation in this index: 6)
  prom  391  (signature_documentation contains "func(": 287, no SymbolInformation in this index: 68)
command.go:1019:4  c.Run(c, argWoFlags)           | kind=Field    sig=struct field Run func(cmd *Command, args []string)
command.go:454:9   err := fn(c.OutOrStderr(), c)  | kind=Variable sig=var fn func(w Writer, data interface{}) error
```

Recall as stated: **98.5%** (cobra, 3992/4052), **94.4–95.8%** (prom). Recovering those edges means
string-matching `func(` in the free-text `signature_documentation`: +50/60 cobra, +287/391 prom. The
residue is a named func type (`var parg PositionalArgs`) or an external symbol with no `SymbolInformation` here — undecidable without indexing the dependency too.

### Ten real symbol keys

Canonical key: `scheme|manager|package|version|descriptor-path`; owner = path minus its last descriptor.

| # | intent | key (from `subject-cobra/index.scip`) |
|---|---|---|
| 1 | method, pointer receiver | `scip-go\|gomod\|github.com/spf13/cobra\|v1.10.1\|github.com/spf13/cobra/Command#Execute().` owner `…/Command#` |
| 2 | same name, other owner | `…\|github.com/spf13/cobra/Command#ArgsLenAtDash().` vs `…\|github.com/spf13/pflag\|v1.0.9\|github.com/spf13/pflag/FlagSet#ArgsLenAtDash().` |
| 3 | stdlib function | `scip-go\|gomod\|github.com/golang/go/src\|go1.15\|fmt/Sprintf().` |
| 4 | escaped identifier | `` `path/filepath`/ `` → `…\|go1.15\|path/filepath/` |
| 5 | dependency type | `…\|github.com/spf13/pflag\|v1.0.9\|github.com/spf13/pflag/FlagSet#` |
| 6 | struct field (term descriptor) | `…\|v1.10.1\|github.com/spf13/cobra/Command#Aliases.` |
| 7 | anonymous struct, synthetic name | `…\|github.com/spf13/cobra/Command#$anon_eb3cbe2d5ea52873#called.` |
| 8 | document-scoped local | `local 1` → **`active_help.go#local:1`** — document qualification is mandatory |
| 9 | package / namespace | `…\|v1.10.1\|github.com/spf13/cobra/` |
| 10 | overload (Go has none; well-formed JVM symbol) | `semanticdb\|maven\|com.example:mylib\|1.0.0\|com/example/Foo#bar(+1).`, disambiguator `+1`, key differs from `bar().` while the owner matches |

Parsing the grammar is as cheap as section 7 claims: **265–560 ns per symbol**, 0.48 ms for every
distinct moniker in the cobra index against 80 ms to protobuf-decode it. The ~50-line parser must handle
both escapes the grammar defines — backtick identifiers (`` `path/filepath` ``) and a literal space
written as a double space (`scip-go gomod my  module v1 pkg/Foo#` → package `my module`, verified). Go
emits no method disambiguators: 0 of 591 declared method symbols carry one; the 13 method names shared
by two owners are disambiguated by the owner path.

## What this means for `platform/code-graph`

SCIP serves **Tier A, out-of-process** as the sourcing document places it, and ingestion is genuinely
cheap: one Maven dependency, one `parseFrom`, 93 ms for 44k lines. Its facts deserve `resolved` — after
removing Go's predeclared identifiers, **0 of 24,948 identifiers in cobra and 96 of 65,573 in
client_golang are unaccounted for**, and every reference carries a moniker naming package and version,
so `strings.Join` and `pflag.FlagSet#SetAnnotation` become real edges into library code rather than the
unresolved names the section-12 baseline was stuck with. What it cannot supply is larger than a
confidence tag: **all four typed edge kinds are ours**, derived from the descriptor suffix plus one
character read from the source file, because the two fields intended for that job are empty; **the
unresolved set is unrepresentable in this format**, so producing it costs a per-language lexer, a
per-language predeclared list, and a position-keyed diff against every occurrence range; node identity
needs `local N` qualified by document (2,262 of 3,849 `SymbolInformation` entries collide if keyed by
the symbol string alone) and the moniker `version` normalized, since it varies with producer
configuration; and an export flag exists only by language convention — for Go from name case (564
exported / 234 unexported non-local symbols), for a language with access modifiers only as free text
inside `signature_documentation`.

## Failures and limits

**`go install github.com/sourcegraph/scip-go/...` fails — the module renamed itself.** The historical
import path is dead; use `github.com/scip-code/scip-go`:

```
go: github.com/sourcegraph/scip-go/cmd/scip-go@latest: version constraints conflict:
	github.com/sourcegraph/scip-go@v0.2.7: parsing go.mod:
	module declares its path as: github.com/scip-code/scip-go
	        but was required as: github.com/sourcegraph/scip-go
```

**Maven Central's search API does not know the group; the repository does.** `solrsearch?q=g:"org.scip-code"`
returns `numFound: 0`; the nearest indexed artifacts are the older `com.sourcegraph:scip-java-proto:0.10.4`
(protobuf-java 3.15.6). Resolution by coordinate works — `…/org/scip-code/scip-java-bindings/0.9.0/scip-java-bindings-0.9.0.jar`
→ HTTP 200, 221,360 bytes, 81 classes; versions 0.8.0, 0.8.1, 0.9.0 (`lastUpdated 20260629172735`).

**An index is platform-specific.** cobra's `command_win.go` has no document in a macOS-produced index
(1 file, 22 identifiers), excluded by its build constraint. Nothing in the index says so.

**A multi-module repository silently loses everything outside the root module.** `scip-go index ./...`
in client_golang produced no documents for `exp/` or `tutorials/whatsup/` (each has its own `go.mod`):
38 files, **12,187 of 65,573 identifiers — 18.6% of the identifier mass** — while `scip-go missing ./...`
reports `No missing documents`. Orchestration must run the producer once per discovered module.

**Document paths escape the analysis root.** 2 of 37 cobra and 18 of 142 client_golang documents carry a
`relative_path` of the form `../../../../Library/Caches/go-build/<hash>-d` — generated test-main and cgo
files from the build cache, on disk but outside the repository. Ingestion must reject them or the store
acquires nodes for files no revision contains.

**Moniker keys are not stable across producer configuration.** Two runs of scip-go 0.2.7 on the same
revision differing only by `--go-version` produce **174 of 1,828 symbols with different keys (9.5%)**:
`… github.com/golang/go/src go1.15 os/exec/Cmd#Run().` versus `… go1.27 …`. The default is inferred and
differed between subjects (`go1.15` cobra, `go1.25.0` client_golang). Normalize the stdlib package
version on ingest or a toolchain bump orphans a tenth of the graph.

**`Relationship` is sparse and one-sided.** 19 entries in cobra (which reported computing 179
implementation pairs), 375 in client_golang; all `is_implementation`, none setting `is_reference`, `is_type_definition`, or `is_definition`. `overrides` and `extends` have no carrier in a Go index.

**Caveats on the derived numbers.** `imports` (199 / 799) uses a source-text heuristic — a symbol ending
in `/` on a line inside an `import` block — because the `Import` role bit is never set; it is not
compiler-verified. `instantiates` (460 / 1,548) is "type-descriptor reference immediately followed by
`{`", counting composite literals and excluding `new(T)`. `references` is the residue after the other
kinds, so an error in one rule moves a count into another. The predeclared filter is a hand-written list
of Go's 44 predeclared names plus `_` and `Error`; a declaration shadowing one would be misfiled. Wall
clocks are single runs with a warm module cache on an M1 Pro. The 11 client_golang signatures matching an access-modifier keyword are coincidental prose, not structured visibility.

**The grammar example in the sourcing document's section 7 does not parse.**
`semanticdb maven com.example mylib 1.0.0 com/example/Foo#bar().` has five space-separated header
tokens; the grammar allows exactly four (spaces escaped as a double space). A conforming parser reads
`version = mylib` and descriptors `1.`, `0.`, `0 com/`, `example/`, `Foo#`, `bar().`. The intended form
is `com.example:mylib` as one token.
