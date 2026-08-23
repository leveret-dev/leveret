# Serena 1.7.0 language-server bundling audit

Status: engineering/licensing research for Leveret. This is not legal advice.
Implementation tracking: [issue #40](https://github.com/leveret-dev/leveret/issues/40).

## Scope and conclusion

This audit is pinned to Serena `v1.7.0`, commit
[`949a27e`](https://github.com/oraios/serena/tree/949a27ef1e5fda1a6e7b561e777bcece345c6ffd).
That tag declares 73 `LanguageServerId` values and maps each value to the class
listed below. The authoritative inventory is
[`src/solidlsp/ls_config.py`](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/ls_config.py#L90-L308),
not the prose documentation, which can lag the enum.

Leveret should not treat "Serena supports it" as "one redistributable,
self-contained artifact exists." Serena's adapters fall into four materially
different groups:

1. managed npm, uvx, or release downloads that can usually be staged;
2. servers that can be staged but still require a language toolchain at review
   time;
3. servers discovered from a user/system toolchain and not installed by Serena;
4. proprietary, remote, or legally ambiguous components that Leveret must not
   redistribute without explicit permission or legal approval.

Redistribution policy is not a runtime prohibition. An operator may own a license,
toolchain, private package source, or right to download a server that Leveret cannot
publish. Leveret must support both packaged/offline operation and explicit
operator-controlled Serena downloads into a persistent, host-owned
`LEVERET_SERENA_BUNDLE`. Each review receives a fresh temporary `SERENA_HOME` built
from that bundle. Neither mode may expose GitHub/model credentials or write package
state into the reviewed checkout.

The pull-request checkout is input data only. It is never an authority for Leveret
or Serena configuration, executable discovery, plugins, extensions, hooks,
activation commands, SDKs, virtual environments, package-manager bins, or language
servers. Valid configuration comes from the host or the trusted base commit
materialized outside the checkout. Every executable path must canonicalize under a
host-owned allowlisted root. A server that cannot be prevented from loading or
executing checkout-provided components must run inside an enforcing sandbox or be
reported unavailable.

The same boundary applies to the LLM. All text and derived content from the pull
request—including source, comments, documentation, strings, diffs, filenames, and
AST/LSP/graph/analyzer output—is untrusted evidence data and never instructions. It
cannot alter the system/phase contract, tool routing, schema, authorization, or
runtime policy. Leveret must label repository-derived tool results accordingly and
the model must ignore any embedded requests or prompt-like text.

The existing Leveret PHP bundle is the immediate blocker: Serena's default PHP
backend installs `intelephense@1.14.4`, whose package license grants personal,
non-transferable use and expressly prohibits copying and distribution. Leveret
must remove it from redistributable artifacts. `php_phpantom` (MIT, self-contained)
is the closest bundle-safe default; `php_phpactor` (MIT) is another option when
PHP 8.1+ is deliberately included or required.

## Assessment labels

- **BUNDLE**: permissive upstream license; include the license, copyright notices,
  third-party notices, hashes, and an SBOM.
- **BUNDLE + OBLIGATIONS**: redistribution appears possible, but copyleft/source
  delivery or other material obligations apply. Legal review and a compliance
  process are required before shipping.
- **PREINSTALL**: require or install through the system/toolchain. This is an
  engineering decision, not necessarily a license prohibition.
- **DO NOT REDISTRIBUTE**: the reviewed terms do not grant Leveret redistribution
  rights. The user may still install or let Serena download the component under
  rights that apply to that user.
- **LEGAL REVIEW**: the downloaded binary's complete terms or transitive bundle
  were not sufficiently clear to approve redistribution.

Every BUNDLE decision is conditional on auditing the exact produced artifact,
including its transitive npm/Python/.NET/JVM contents. A repository's top-level
license alone is not enough for a release gate.

## Matrix: managed or stageable artifacts

| Serena ID | SolidLSP class / actual server | Serena install and v1.7.0 default | Runtime / platform notes | Upstream license | Leveret disposition | Primary sources |
|---|---|---|---|---|---|---|
| `python` | `PyrightServer` / Pyright | `uvx pyright==1.1.403` | Python + `uv`; stage the complete uv environment | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/pyright_server.py) · [license](https://github.com/microsoft/pyright/blob/main/LICENSE.txt) |
| `python_ty` | `TyLanguageServer` / ty | `uvx ty==0.0.25` | Native wheels vary by OS/architecture; Python + `uv` to stage | MIT | **BUNDLE** per supported wheel | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/ty_server.py) · [license](https://github.com/astral-sh/ty/blob/main/LICENSE) |
| `python_pyrefly` | `PyreflyLanguageServer` / Pyrefly | `uvx pyrefly==1.1.1` | Native wheels vary by OS/architecture | MIT | **BUNDLE** per supported wheel | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/pyrefly_server.py) · [license](https://github.com/facebook/pyrefly/blob/main/LICENSE) |
| `python_basedpyright` | `BasedPyrightLanguageServer` / basedpyright | `uvx basedpyright==1.39.9` | Python + `uv`; stage complete environment | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/basedpyright_server.py) · [license](https://github.com/DetachHead/basedpyright/blob/main/LICENSE.txt) |
| `csharp` | `CSharpLanguageServer` / Microsoft Roslyn Language Server | downloads `roslyn-language-server.<platform>` NuGet `5.5.0-2.26078.4` | NuGet artifacts for Win x64/arm64, macOS x64/arm64, Linux x64/arm64; targets bundled .NET 10 layout | Roslyn source MIT; binary package contains Microsoft/transitive payloads | **LEGAL REVIEW** before bundling exact NuGet payload | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/csharp_language_server.py) · [Roslyn license](https://github.com/dotnet/roslyn/blob/main/License.txt) · [NuGet](https://www.nuget.org/packages/roslyn-language-server.linux-x64/5.5.0-2.26078.4) |
| `csharp_omnisharp` | `OmniSharp` / OmniSharp + Razor LS | managed archives `1.39.10`; Razor `7.0.0-preview.23363.1` | many OS/arch variants; .NET/runtime form varies by archive | MIT, but Razor/MS binary payload adds separate terms | **LEGAL REVIEW**; do not assume the aggregate archive is MIT-only | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/omnisharp.py) · [manifest](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/omnisharp/runtime_dependencies.json) · [license](https://github.com/OmniSharp/omnisharp-roslyn/blob/master/license.md) |
| `typescript` | `TypeScriptLanguageServer` / `typescript-language-server` + TypeScript | npm `typescript-language-server@5.1.3`, `typescript@5.9.3` | Node.js >=18.16 and npm to stage/run; same backend covers JS/JSX/TS/TSX | Apache-2.0 + Apache-2.0 | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/typescript_language_server.py) · [TSLS license](https://github.com/typescript-language-server/typescript-language-server/blob/master/LICENSE) · [TypeScript license](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) |
| `typescript_vts` | `VtsLanguageServer` / vtsls | npm `@vtsls/language-server@0.2.9` | Node.js + npm | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/vts_language_server.py) · [license](https://github.com/yioneko/vtsls/blob/main/LICENSE) |
| `vue` | `VueLanguageServer` / Vue LS + TypeScript LS | npm `@vue/language-server@3.1.5`, TypeScript `5.9.3`, TSLS `5.1.3` | Node.js + npm; bundle all three as one versioned artifact | MIT + Apache-2.0 | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/vue_language_server.py) · [Vue license](https://github.com/vuejs/language-tools/blob/master/LICENSE) |
| `svelte` | `SvelteLanguageServer` / Svelte LS + TypeScript LS/plugin | npm `svelte-language-server@0.18.0`, TypeScript `6.0.3`, TSLS `5.1.3`, `typescript-svelte-plugin@0.3.52` | Node.js >=18 + npm; bundle as one versioned artifact | MIT plus Apache-2.0 TSLS | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/svelte_language_server.py) · [license](https://github.com/sveltejs/language-tools/blob/master/LICENSE) |
| `dart` | `DartLanguageServer` / Dart SDK analysis server | downloads Dart SDK `3.7.1` | Very large toolchain; Linux x64, macOS x64/arm64, Windows x64/arm64 in Serena; no Linux arm64 artifact | BSD-3-Clause | **BUNDLE** is allowed with notices, but make it an optional toolchain layer | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/dart_language_server.py) · [license](https://github.com/dart-lang/sdk/blob/main/LICENSE) |
| `cpp` | `ClangdLanguageServer` / clangd | managed clangd `19.1.2` unless system `clangd` exists | Serena artifacts: Linux x64, Windows x64, macOS x64/arm64; **no Linux arm64** | Apache-2.0 with LLVM exceptions | **BUNDLE** on listed targets; PREINSTALL on Linux arm64 | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/clangd_language_server.py) · [license](https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT) |
| `php` | `Intelephense` / Intelephense | npm `intelephense@1.14.4` | Node.js + npm | Custom personal, non-transferable license; copying/distribution prohibited | **DO NOT REDISTRIBUTE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/intelephense.py) · [official npm metadata](https://registry.npmjs.org/intelephense/1.14.4) |
| `php_phpactor` | `PhpactorServer` / Phpactor | downloads PHAR `2025.12.21.1` | Requires system PHP 8.1+ | MIT | **BUNDLE** PHAR; **PREINSTALL** PHP runtime | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/phpactor.py) · [license](https://github.com/phpactor/phpactor/blob/master/LICENSE) |
| `php_phpantom` | `PHPantomServer` / `phpantom_lsp` | managed native archive `0.8.0` | Linux/macOS/Windows x64 and arm64 entries in Serena | MIT | **BUNDLE**; preferred replacement for redistributable default PHP support | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/phpantom.py) · [license](https://github.com/PHPantom-dev/phpantom_lsp/blob/main/LICENSE) |
| `clojure` | `ClojureLSP` / clojure-lsp | managed release `2026.02.20-16.08.58` | Server binaries are OS/arch-specific; project analysis also requires Clojure/JVM tooling | MIT | **BUNDLE** server; **PREINSTALL** project toolchain/JDK | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/clojure_lsp.py) · [license](https://github.com/clojure-lsp/clojure-lsp/blob/master/LICENSE) |
| `elixir` | `ElixirTools` / Expert | uses PATH or downloads `v0.1.0-rc.6` | Linux/macOS x64/arm64 and Windows x64; requires compatible Elixir/Erlang project toolchain | Apache-2.0 | **BUNDLE** server; **PREINSTALL** Elixir/Erlang | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/elixir_tools/elixir_tools.py) · [license](https://github.com/elixir-lang/expert/blob/main/LICENSE) |
| `elm` | `ElmLanguageServer` / Elm LS + Elm compiler | npm `@elm-tooling/elm-language-server@2.8.0`, `elm@0.19.1-6` unless system binaries exist | Node.js + npm; npm compiler contains platform-specific binary | MIT + BSD-3-Clause | **BUNDLE** exact npm closure | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/elm_language_server.py) · [LS license](https://github.com/elm-tooling/elm-language-server/blob/master/LICENSE) · [compiler license](https://github.com/elm/compiler/blob/master/LICENSE) |
| `terraform` | `TerraformLS` / terraform-ls | managed `0.36.5` | Linux/macOS x64/arm64, Windows x64; requires `terraform` on PATH. Modern Terraform CLI has separate BUSL terms | MPL-2.0 for LS | **BUNDLE** LS with MPL notices/source changes; **PREINSTALL** Terraform CLI | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/terraform_ls.py) · [LS license](https://github.com/hashicorp/terraform-ls/blob/main/LICENSE) · [Terraform license](https://github.com/hashicorp/terraform/blob/main/LICENSE) |
| `bash` | `BashLanguageServer` / Bash LS (+ optional ShellCheck) | npm `bash-language-server@5.6.0`; Serena may download ShellCheck `0.10.0` | Node.js + npm; ShellCheck native artifact is platform-specific | LS MIT; ShellCheck GPL-3.0 | **BUNDLE** LS; put ShellCheck in **BUNDLE + OBLIGATIONS** layer or omit | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/bash_language_server.py) · [LS license](https://github.com/bash-lsp/bash-language-server/blob/main/LICENSE) · [ShellCheck license](https://github.com/koalaman/shellcheck/blob/master/LICENSE) |
| `cue` | `CueLanguageServer` / `cue lsp` | managed CUE CLI `v0.16.1` | Platform-specific Go binary; the CLI is both toolchain and LS | Apache-2.0 | **BUNDLE** per supported platform | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/cue_language_server.py) · [license](https://github.com/cue-lang/cue/blob/master/LICENSE) |
| `lua` | `LuaLanguageServer` / LuaLS | PATH/common path or managed `3.15.0` | Linux x64/arm64, macOS x64/arm64, Windows x64 | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/lua_ls.py) · [license](https://github.com/LuaLS/lua-language-server/blob/master/LICENSE) |
| `luau` | `LuauLanguageServer` / luau-lsp | PATH or managed `1.63.0` | Platform-specific native binary; optional Roblox definitions are separate downloaded data | MIT | **BUNDLE** binary; vendor and pin any definitions separately | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/luau_lsp.py) · [license](https://github.com/JohnnyMorganz/luau-lsp/blob/main/LICENSE.md) |
| `markdown` | `Marksman` / Marksman | managed `2024-12-18` | Platform-specific native binary | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/marksman.py) · [license](https://github.com/artempyanykh/marksman/blob/master/LICENSE) |
| `latex` | `TexlabLanguageServer` / TexLab | managed `5.25.1` | Platform-specific native binary | GPL-3.0 | **BUNDLE + OBLIGATIONS** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/texlab_language_server.py) · [license](https://github.com/latex-lsp/texlab/blob/master/LICENSE) |
| `scala` | `ScalaLanguageServer` / Metals | PATH or Coursier bootstrap `1.6.4` | Requires JDK and Coursier; prefetch the exact Coursier cache/closure | Apache-2.0 | **BUNDLE** cache with notices; **PREINSTALL** JDK if not included in platform image | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/scala_language_server.py) · [license](https://github.com/scalameta/metals/blob/main/LICENSE) |
| `fortran` | `FortranLanguageServer` / fortls | `uvx fortls==3.2.2` | Python + `uv`; compiler is optional for syntax but needed for real builds | MIT | **BUNDLE** staged uv environment | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/fortran_language_server.py) · [license](https://github.com/fortran-lang/fortls/blob/master/LICENSE) |
| `haxe` | `HaxeLanguageServer` / vshaxe server | PATH/VS Code extension discovery or Open VSX `vshaxe@2.34.2` | Requires Node.js and Haxe compiler >=3.4; VSIX must be audited as a closure | MIT | **BUNDLE** server with notices; **PREINSTALL** Haxe compiler | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/haxe_language_server.py) · [license](https://github.com/nadako/vshaxe/blob/master/LICENSE.txt) |
| `fsharp` | `FSharpLanguageServer` / FsAutoComplete | managed .NET tool `0.83.0` | Requires `dotnet`; NuGet/tool closure is platform-neutral managed code | MIT | **BUNDLE** tool closure; **PREINSTALL** compatible .NET runtime | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/fsharp_language_server.py) · [license](https://github.com/ionide/FsAutoComplete/blob/main/LICENSE.md) |
| `powershell` | `PowerShellLanguageServer` / PowerShell Editor Services + PSScriptAnalyzer | downloads PSES `4.4.0`; installs PSScriptAnalyzer `1.25.0` | Requires `pwsh`; server/modules are platform-neutral PowerShell | MIT + MIT | **BUNDLE** server/modules; **PREINSTALL** or separately bundle `pwsh` with its notices | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/powershell_language_server.py) · [PSES license](https://github.com/PowerShell/PowerShellEditorServices/blob/main/LICENSE) · [PSSA license](https://github.com/PowerShell/PSScriptAnalyzer/blob/master/LICENSE) |
| `pascal` | `PascalLanguageServer` / pasls | managed `v0.2.0` or PATH | Native artifact varies by OS/arch; FPC needed for full navigation | GPL-3.0 | **BUNDLE + OBLIGATIONS**; **PREINSTALL** FPC/Lazarus | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/pascal_server.py) · [license](https://github.com/zen010101/pascal-language-server/blob/master/LICENSE) |
| `matlab` | `MatlabLanguageServer` / MathWorks MATLAB LS extension | downloads VS Code extension `1.3.9` | Node.js plus user-licensed MATLAB R2021b+; no useful server without MATLAB | Extension source MIT; MATLAB proprietary | **BUNDLE** extension only after exact VSIX audit; **DO NOT REDISTRIBUTE** MATLAB | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/matlab_language_server.py) · [extension license](https://github.com/mathworks/MATLAB-language-server/blob/main/LICENSE.md) · [MATLAB terms](https://www.mathworks.com/company/aboutus/policies_statements.html) |
| `bsl` | `BSLLanguageServer` / bsl-language-server | managed JAR `0.29.0` | Requires Java 21+ | LGPL-3.0 | **BUNDLE + OBLIGATIONS**; include corresponding source/notices | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/bsl_language_server.py) · [license](https://github.com/1c-syntax/bsl-language-server/blob/develop/LICENSE) |
| `ada` | `AdaLanguageServer` / AdaCore ALS | managed `2026.2.202604091` | Native archives are platform-specific; GNAT/GPR project tooling improves results | GPL-3.0 | **BUNDLE + OBLIGATIONS**; exact binary/source correspondence required | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/ada_language_server.py) · [license](https://github.com/AdaCore/ada_language_server/blob/master/COPYING3) |
| `nextflow` | `NextflowLanguageServer` / Nextflow LS | managed JAR `26.04.3` | Requires Java 17+ | Apache-2.0 | **BUNDLE** JAR; include/provide JRE separately | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/nextflow_language_server.py) · [license](https://github.com/nextflow-io/language-server/blob/main/LICENSE) |
| `yaml` | `YamlLanguageServer` / Red Hat YAML LS | npm `yaml-language-server@1.19.2` | Node.js + npm; schema network access follows operator policy or uses a vendored catalog | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/yaml_language_server.py) · [license](https://github.com/redhat-developer/yaml-language-server/blob/main/LICENSE) |
| `json` | `JsonLanguageServer` / `vscode-json-languageserver` | npm `vscode-json-languageserver@1.3.4` | Node.js + npm | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/json_language_server.py) · [package](https://www.npmjs.com/package/vscode-json-languageserver) |
| `toml` | `TaploServer` / Taplo | PATH or managed `0.10.0` | Native OS/arch artifacts; Serena validates download hashes for its pinned release | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/taplo_server.py) · [license](https://github.com/tamasfe/taplo/blob/master/LICENSE) |
| `hlsl` | `HlslLanguageServer` / shader-language-server | PATH, managed binary/build `1.3.1` | Release binaries on Linux/Windows; Serena builds from Rust source on macOS when needed | MIT | **BUNDLE** exact built binary + source commit/notices | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/hlsl_language_server.py) · [license](https://github.com/antaalt/shader-sense/blob/master/LICENSE) |
| `systemverilog` | `SystemVerilogLanguageServer` / `verible-verilog-ls` | PATH or managed `v0.0-4051-g9fdb4057` | Linux x64/arm64, macOS archive, Windows x64 | Apache-2.0 | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/systemverilog_server.py) · [license](https://github.com/chipsalliance/verible/blob/master/LICENSE) |
| `solidity` | `SolidityLanguageServer` / Nomic Solidity LS (+ Forge package) | npm `@nomicfoundation/solidity-language-server@0.8.4`, Forge helper `1.5.1` | Node.js + npm; exact two-package closure must be retained | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/solidity_language_server.py) · [package](https://www.npmjs.com/package/@nomicfoundation/solidity-language-server) · [license](https://github.com/NomicFoundation/hardhat-vscode/blob/main/LICENSE) |
| `ansible` | `AnsibleLanguageServer` / Ansible LS | npm `@ansible/ansible-language-server@1.2.3` | Node.js + npm; `ansible`, Python and optional lint tools are external | MIT | **BUNDLE** LS; **PREINSTALL** Ansible/Python toolchain | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/ansible_language_server.py) · [license](https://github.com/ansible/vscode-ansible/blob/main/LICENSE) |
| `html` | `VsCodeHtmlLanguageServer` / VS Code HTML LS | npm `vscode-langservers-extracted@4.10.0` | Node.js + npm | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/vscode_html_language_server.py) · [service license](https://github.com/microsoft/vscode-html-languageservice/blob/main/License.txt) |
| `scss` | `SomeSassLanguageServer` / some-sass | npm `some-sass-language-server@2.3.8` | Node.js + npm; handles SCSS, Sass and CSS | MIT | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/some_sass_language_server.py) · [package](https://www.npmjs.com/package/some-sass-language-server) |
| `angular` | `AngularLanguageServer` / Angular LS + language service + TypeScript | npm Angular LS/service `21.2.10`, TypeScript `5.9.3`, TSLS `5.1.3` | Node.js + npm; requires a real Angular/Nx workspace; bundle four-package closure | MIT plus Apache-2.0 TSLS | **BUNDLE** | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/angular_language_server.py) · [Angular license](https://github.com/angular/angular/blob/main/LICENSE) |

## Matrix: system/toolchain, embedded, remote, or proprietary backends

These IDs are supported by Serena 1.7.0, but Serena does not produce a fixed,
self-contained server artifact suitable for the existing Leveret prefetch model.

| Serena ID | SolidLSP class / actual server | Install mechanism / version | Runtime and redistribution assessment | Primary sources |
|---|---|---|---|---|
| `python_jedi` | `JediServer` / `jedi-language-server` | literal `jedi-language-server` from PATH; no version pin | MIT; **PREINSTALL** or add a separately pinned Python environment before claiming offline support | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/jedi_server.py) · [license](https://github.com/pappasam/jedi-language-server/blob/master/LICENSE.txt) |
| `rust` | `RustAnalyzer` / rust-analyzer | `rustup which`, then `rustup component add`, then PATH; no Serena pin | Apache-2.0/MIT upstream; **PREINSTALL** matching Rust toolchain because rust-analyzer must track it | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/rust_analyzer.py) · [license](https://github.com/rust-lang/rust-analyzer/blob/master/LICENSE-APACHE) |
| `java` | `EclipseJDTLS` / JDT LS from Red Hat vscode-java VSIX | default VSIX `1.54.0-923`, Gradle `8.14.2`, bundled JRE 21; alternate user JDTLS/Lombok paths | JDT LS is EPL-2.0, but VSIX aggregate includes a JRE, Lombok, Gradle integration and third-party notices. **LEGAL REVIEW** exact VSIX; upstream JDTLS + user JDK mode is safer | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/eclipse_jdtls.py) · [JDT LS license](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/master/LICENSE) · [vscode-java notices](https://github.com/redhat-developer/vscode-java/blob/main/ThirdPartyNotices.txt) |
| `kotlin` | `KotlinLanguageServer` / JetBrains Kotlin LS | managed CDN `262.9593.0` | Linux/macOS x64/arm64; no Windows artifact for this packaging generation. Downloaded binary has no source/license link in Serena. **LEGAL REVIEW** before redistribution | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/kotlin_language_server.py) · [Kotlin license context](https://github.com/JetBrains/kotlin/blob/master/license/LICENSE.txt) |
| `go` | `Gopls` / gopls | requires `go` and `gopls` on PATH; no pin | BSD-3-Clause; **PREINSTALL** via pinned Go toolchain (`go install golang.org/x/tools/gopls@...`) | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/gopls.py) · [license](https://github.com/golang/tools/blob/master/LICENSE) |
| `ruby` | `RubyLsp` / ruby-lsp | project/global gem or Serena gem install `0.26.8` through rbenv/mise/asdf/RVM/system Ruby | MIT; server can be cached, but Ruby ABI/project Bundler coupling makes **PREINSTALL** the reliable tier | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/ruby_lsp.py) · [license](https://github.com/Shopify/ruby-lsp/blob/main/LICENSE.txt) |
| `ruby_solargraph` | `Solargraph` / Solargraph | project/global gem; Serena metadata references gem `0.51.1` but relies on Ruby environment | MIT; **PREINSTALL** with matching Ruby/Bundler | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/solargraph.py) · [license](https://github.com/castwide/solargraph/blob/master/LICENSE) |
| `cpp_ccls` | `CCLS` / ccls | `ccls` from PATH or `ls_path`; no pin/download | Apache-2.0; **PREINSTALL** because build and libc/LLVM compatibility are host-specific | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/ccls_language_server.py) · [license](https://github.com/MaskRay/ccls/blob/master/LICENSE) |
| `r` | `RLanguageServer` / R `languageserver` package | system `R` and installed `languageserver`; no pin | R package is MIT; **PREINSTALL** R and a pinned package library | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/r_language_server.py) · [license](https://github.com/REditorSupport/languageserver/blob/master/LICENSE) |
| `perl` | `PerlLanguageServer` / Perl::LanguageServer | system Perl + CPAN module; no pin | Artistic-2.0; **PREINSTALL** a pinned Perl/CPAN environment | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/perl_language_server.py) · [license](https://github.com/richterger/Perl-LanguageServer/blob/master/LICENSE) |
| `swift` | `SourceKitLSP` / sourcekit-lsp | system Swift toolchain; no pin | Apache-2.0; **PREINSTALL** matching Swift toolchain | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/sourcekit_lsp.py) · [license](https://github.com/swiftlang/sourcekit-lsp/blob/main/LICENSE.txt) |
| `crystal` | `CrystalLanguageServer` / Crystalline | `crystalline` from PATH; no pin | MIT; **PREINSTALL** because server must match Crystal compiler/project | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/crystal_language_server.py) · [license](https://github.com/elbywan/crystalline/blob/master/LICENSE) |
| `zig` | `ZigLanguageServer` / ZLS | system `zls` + Zig; no pin | MIT; **PREINSTALL** a matched Zig/ZLS pair | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/zls.py) · [license](https://github.com/zigtools/zls/blob/master/LICENSE) |
| `nix` | `NixLanguageServer` / nixd | finds nixd or runs `nix profile install github:nix-community/nixd`; no pin | LGPL-3.0; networked, unpinned install is unsuitable. **PREINSTALL** a locked Nix closure; **BUNDLE + OBLIGATIONS** only after closure/SBOM audit | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/nixd_ls.py) · [license](https://github.com/nix-community/nixd/blob/main/LICENSE) |
| `erlang` | `ErlangLanguageServer` / archived erlang_ls | `erlang_ls`, Erlang/OTP and normally rebar3 from PATH; no pin | Apache-2.0; **PREINSTALL** toolchain; upstream is archived, so keep experimental | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/erlang_language_server.py) · [license](https://github.com/erlang-ls/erlang_ls/blob/main/LICENSE) |
| `ocaml` | `OcamlLanguageServer` / ocaml-lsp-server | uses opam switch; requires OCaml and ocaml-lsp-server >=1.23 for cross-file refs; no exact pin | ISC; **PREINSTALL** a project-compatible opam switch | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/ocaml_lsp_server.py) · [license](https://github.com/ocaml/ocaml-lsp/blob/master/LICENSE.md) |
| `al` | `ALLanguageServer` / Microsoft AL VS Code extension | Serena downloads Marketplace extension `18.0.2242655` | Microsoft Marketplace binary; the public `microsoft/AL` repository is samples, not a redistribution grant for the extension. **DO NOT REDISTRIBUTE** without Microsoft permission | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/al_language_server.py) · [Marketplace terms](https://aka.ms/vsmarketplace-ToU) |
| `rego` | `RegalLanguageServer` / Regal | `regal` from PATH; no pin | Apache-2.0; technically bundleable, but Serena has no managed artifact. **PREINSTALL** now; add a pinned packager to promote to BUNDLE | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/regal_server.py) · [license](https://github.com/StyraInc/regal/blob/main/LICENSE) |
| `julia` | `JuliaLanguageServer` / LanguageServer.jl | system Julia; runs unpinned `Pkg.add("LanguageServer")` if absent | MIT; unsuitable for a published reproducible pack, but valid in operator-enabled download mode. **PREINSTALL** a pinned Julia Project/Manifest for offline use | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/julia_server.py) · [license](https://github.com/julia-vscode/LanguageServer.jl/blob/master/LICENSE.md) |
| `haskell` | `HaskellLanguageServer` / HLS wrapper | PATH/GHCup/Stack/Cabal; no pin | Apache-2.0; **PREINSTALL** compiler-matched HLS via GHCup | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/haskell_language_server.py) · [license](https://github.com/haskell/haskell-language-server/blob/master/LICENSE) |
| `lean4` | `Lean4LanguageServer` / built-in `lean --server` | `lean` and `lake` from elan/toolchain; no Serena pin | Apache-2.0; **PREINSTALL** project-selected Lean toolchain | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/lean4_language_server.py) · [license](https://github.com/leanprover/lean4/blob/master/LICENSE) |
| `groovy` | `GroovyLanguageServer` / user-supplied Groovy LS JAR | `ls_jar_path` is required; Serena only downloads vscode-java JRE bundle `1.42.0-561` | No canonical server artifact/license is selected, and aggregate JRE VSIX needs audit. **PREINSTALL** user JAR/JDK; do not advertise a bundled server | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/groovy_language_server.py) · [configuration](https://github.com/oraios/serena/blob/v1.7.0/docs/02-usage/050_configuration.md#groovy) |
| `gdscript` | `GodotLanguageServer` / Godot editor built-in LSP | remote TCP connection to a running Godot 3/4 editor, default port 6008 | No child server artifact exists. Godot is MIT, but runtime must be running and project-matched. **PREINSTALL/REMOTE**, never claim offline subprocess bundling | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/godot_language_server.py) · [Godot license](https://github.com/godotengine/godot/blob/master/LICENSE.txt) |
| `qml` | `QmlLanguageServer` / Qt `qmlls` | `qmlls6`/`qmlls` from Qt 6 PATH; no pin | Qt offers GPL/LGPL/commercial terms with module/tool-specific details. **PREINSTALL** Qt; **LEGAL REVIEW** before redistributing qmlls | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/qml_language_server.py) · [Qt licensing](https://www.qt.io/licensing/open-source-lgpl-obligations) |
| `gleam` | `GleamLanguageServer` / built-in `gleam lsp` | `gleam` from PATH; no pin | Apache-2.0; **PREINSTALL** project-compatible compiler, or later package the complete compiler as an optional toolchain layer | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/gleam_language_server.py) · [license](https://github.com/gleam-lang/gleam/blob/main/LICENSE) |
| `wolfram` | `WolframLanguageServer` / LSPServer paclet through WolframKernel | discovers Mathematica 13+ or Wolfram Engine 12.1+; no pin | LSPServer is MIT, kernel is proprietary. **DO NOT REDISTRIBUTE** kernel; use user installation/license | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/wolfram_language_server.py) · [LSPServer license](https://github.com/WolframResearch/LSPServer/blob/master/LICENSE) · [Wolfram terms](https://www.wolfram.com/legal/agreements/wolfram-mathematica.html) |
| `msl` | `MslLanguageServer` / Serena's bundled Python `msl_lsp_server.py` | shipped inside Serena; current Python interpreter; same version as Serena | Serena is MIT; no extra server download. **BUNDLE** automatically with pinned Serena | [adapter](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/msl_language_server.py) · [server](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/msl_lsp_server.py) · [Serena license](https://github.com/oraios/serena/blob/v1.7.0/LICENSE) |
| `deno` | `DenoLanguageServer` / built-in `deno lsp` | `deno` CLI from PATH; no pin | MIT; **PREINSTALL** project-compatible Deno, or package it as a separate optional toolchain layer | [Serena](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/deno_language_server.py) · [license](https://github.com/denoland/deno/blob/main/LICENSE.md) |

## Artifact tiers for Leveret

### Tier A: default offline bundle

Build one immutable, per-OS/architecture artifact containing Serena itself and
the high-value permissive servers that need no project-specific compiler:

- TypeScript/JavaScript, vtsls, Vue, Svelte, YAML, JSON, HTML, SCSS, Angular,
  Solidity, Ansible LS and Bash LS;
- Pyright, basedpyright, ty, Pyrefly and fortls as fully staged uv environments;
- PHPantom instead of Intelephense;
- clangd where Serena has an artifact, LuaLS, luau-lsp, Taplo, Marksman,
  Verible, shader-language-server, CUE and Expert;
- Serena's built-in mSL server.

Node.js and Python/uv are runtime dependencies of this tier unless the produced
artifact turns their servers into truly self-contained launchers. The install
must set every packaged `ls_path` explicitly from an immutable manifest. Its
certification smoke runs with package/download networks disabled.

### Tier B: optional runtime/toolchain layers

Publish separately because size, ABI, compiler compatibility, or project
selection dominates: Dart SDK, Java/JDTLS, Clojure/JDK, Elixir/Erlang, Elm,
Terraform LS plus user Terraform, Scala/Metals, F#/PowerShell plus .NET/pwsh,
Haxe, MATLAB extension, Nextflow/JDK, and compiler-coupled system servers (Rust,
Go, Ruby, Swift, Crystal, Zig, OCaml, Julia, Haskell, Lean, Gleam, Deno).

Do not download these during a review unless the operator enabled Serena downloads.
Image builds may download them;
the resulting layer must have a lock manifest, source URL, SHA-256, license set,
SBOM, platform ID and a smoke-tested executable path.

### Tier C: compliance-gated optional layer

TexLab, Pascal LS, Ada LS, BSL LS, nixd and ShellCheck require a copyleft
compliance decision and corresponding-source delivery process. They are not
appropriate for the first bundle merely because Serena can fetch them.

### Tier D: user-provided or dynamically downloaded

- Intelephense: redistribution is prohibited by the npm package license.
- Microsoft AL extension: no verified redistribution grant.
- Kotlin LS CDN artifact and aggregated Roslyn/OmniSharp/Java VSIX payloads:
  hold until exact binary terms and transitive notices are approved.
- Godot, QML, Groovy, MATLAB runtime and Wolfram runtime: external runtime,
  remote editor, required user JAR, or proprietary installation.

## Packaging gates

1. Pin Serena by immutable commit/version and assert that the 73-ID enum has not
   changed before accepting a new Serena release.
2. Generate the supported-language manifest from successful cold prefetches,
   not a handwritten list. Record server version, platform, executable, SHA-256,
   source URL, license files and runtime requirements.
3. Cold-build each platform artifact with network access, then run a fixture for
   every advertised ID with all network paths blocked. A cached `uvx`, npm,
   Coursier, Julia Pkg, Nix, rustup or toolchain fetch is not offline proof.
4. Never copy a host-installed server into the artifact without provenance and
   licensing metadata. Never follow PATH, config, plugin, extension, hook, SDK,
   virtualenv, `node_modules/.bin`, `vendor/bin`, or binstub discovery into the
   reviewed checkout. Treat project files only as untrusted analysis input.
5. Produce an SPDX or CycloneDX SBOM and a third-party notices bundle from the
   actual artifact. Scan npm/Python/NuGet/JAR/native transitive dependencies and
   embedded runtimes, not only the top-level repository license.
6. Refuse unsupported OS/architecture combinations explicitly. In particular,
   Serena 1.7.0 has gaps such as clangd Linux arm64, Dart Linux arm64 and the
   current Kotlin packaging's Windows support.
7. Make runtime network behavior explicit operator policy. Recommended/default
   packaged mode is offline: missing layers degrade visibly. An operator may enable
   Serena package/download access through trusted YAML, environment, or CLI; those
   downloads persist under host-owned `LEVERET_SERENA_BUNDLE`, never the checkout.
   Host policy can force offline, and neither mode exposes GitHub/model credentials.

## Primary Serena references

- [Serena v1.7.0 `pyproject.toml`](https://github.com/oraios/serena/blob/v1.7.0/pyproject.toml)
  defines the Serena/Python package and pinned dependencies.
- [Language-server enum and class routing](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/ls_config.py)
  is the complete 73-ID inventory.
- [SolidLSP dependency providers](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/ls.py)
  define uvx and executable-provider behavior.
- [Serena language-server settings](https://github.com/oraios/serena/blob/v1.7.0/docs/02-usage/050_configuration.md#language-server-specific-settings)
  document the public overrides and default versions.
- [Serena MIT license](https://github.com/oraios/serena/blob/v1.7.0/LICENSE)
  covers Serena and its shipped custom mSL server, but does not relicense third-party
  servers downloaded by SolidLSP.
