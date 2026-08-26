# Sonar open-source licensing assessment for Leveret

Status: primary-source engineering/licensing research, 2026-08-26. This is not
legal advice. All web and repository sources were retrieved on 2026-08-26 unless
an effective or update date is stated separately.

## Answer: do not add Sonar analysis to Leveret without written permission

**Leveret may use the genuinely open-source Sonar components under their normal
licenses, but the current public terms do not provide a low-risk path to use
Sonar's language analyzers or their results in Leveret's AI-assisted analyzer
toolbelt.** SonarQube Community Build's core and SonarScanner CLI are
LGPL-3.0-or-later, but Sonar says the Community Build binary is packaged with
analyzers under its Sonar Source-Available License (SSAL), not an OSI-approved
open-source license. The current SSAL grant is limited to a “Non-competitive
Purpose”; that definition excludes both competing functionality even when
provided free of charge and using outside AI to ingest, interpret, analyze, or
interact with data provided by the program ([Sonar license overview](https://www.sonarsource.com/license/),
[current SSAL v1.0.1](https://www.sonarsource.com/license/ssal/),
[Community Build 26.8 distribution notice](https://github.com/SonarSource/sonarqube/blob/26.8.0.126808/sonar-application/src/main/assembly/COPYING)).

That restriction is directly relevant. Sonar describes Community Build as an
“automated code review and static analysis tool,” while Leveret is an AI-assisted
code-review/analyzer system ([Community Build homepage](https://docs.sonarsource.com/sonarqube-community-build)).
Putting the Sonar analyzers in Leveret's belt, or feeding their issues to
Leveret's model, falls at least within the SSAL AI exclusion and presents a
substantial competitive-purpose risk. A process, sidecar, container, or optional
download boundary does not change the permitted purpose.

Leveret being maintained by an individual, released under
AGPL-3.0-or-later, offered without charge, or operated as a nonprofit project
does not create an exception. SSAL says a product may compete “even if it is
provided free of charge.” Its `Recipient` is “anyone”; its permission turns on
purpose, not corporate form. The commercial agreements likewise define a
customer as an individual or entity, and the trademark rules state no nonprofit
exception ([SSAL §§1–3](https://www.sonarsource.com/license/ssal/),
[Primary Customer Agreement §1](https://www.sonarsource.com/legal/primary-agreement/),
[trademark guidelines](https://www.sonarsource.com/trademark-use/)).

**Shortest low-risk route:** obtain written SonarSource permission that
specifically covers Leveret, AI interpretation of findings, use in a code-review
system, API/result conversion, downstream open-source users, and any intended
redistribution. If permission is granted, add only an opt-in adapter to an
operator-provided scanner and operator-provided SonarQube endpoint; do not bundle
Community Build or analyzers. Without that permission, do not promote a Sonar
analyzer in Leveret. Using another OSI-licensed analyzer is shorter and safer.

## Product names and license map

The current names matter because similarly named components have different
licenses and terms:

- **SonarQube Community Build** is the current name for the no-cost,
  self-managed product formerly called Community Edition. The current documented
  release is **26.8.0.126808** ([release notes](https://docs.sonarsource.com/sonarqube-community-build/server-update-and-maintenance/release-notes),
  [license overview](https://www.sonarsource.com/license/)).
- **SonarQube Server** is the commercial self-managed product. Its current plans
  are **Developer, Enterprise, and Data Center** and are licensed by an Order,
  the Primary Customer Agreement, and the Server Supplemental Terms—not an OSS
  license ([plans](https://www.sonarsource.com/plans-and-pricing/sonarqube/),
  [license administration](https://docs.sonarsource.com/sonarqube-server/instance-administration/license-administration),
  [Server terms](https://www.sonarsource.com/legal/sonarqube/terms-and-conditions/)).
- **SonarQube Cloud** is the current SaaS name; its terms call it “formerly
  SonarCloud.” It is service access under contract, not a downloadable
  open-source program. Current plans are Free, Team, Enterprise, and a free
  **OSS plan** for open-source organizations with unlimited public repositories
  but no private projects ([Cloud Supplemental Terms](https://www.sonarsource.com/legal/sonarcloud/terms-of-service/),
  [subscription plans](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans)).
- **SonarScanner CLI** is the `sonar-scanner` CI client. It is distinct from the
  newer **SonarQube CLI** (`sonar`). The current documented SonarScanner CLI is
  **8.1.0.6389** ([scanner documentation](https://docs.sonarsource.com/sonarqube-community-build/analyzing-source-code/scanners/sonarscanner),
  [8.1 license file](https://github.com/SonarSource/sonar-scanner-cli/blob/8.1.0.6389/LICENSE.txt)).
  It launches analysis against a SonarQube URL; the LGPL client alone is not the
  language-analysis engine. The separate SonarQube CLI can list already-stored
  issues as JSON, TOON, table, or CSV, but offers no documented SARIF output
  ([output formats](https://docs.sonarsource.com/sonarqube-cli/using-sonarqube-cli/output-formats)).

| Component / reviewed version | Governing source and license | Classification | Consequence for Leveret |
|---|---|---|---|
| SonarQube Community Build 26.8.0.126808, core without analyzers | Release `COPYING` plus source headers say LGPLv3; source headers specify version 3 or later ([COPYING](https://github.com/SonarSource/sonarqube/blob/26.8.0.126808/sonar-application/src/main/assembly/COPYING), [header](https://github.com/SonarSource/sonarqube/blob/26.8.0.126808/HEADER.spotless)) | **OSI-approved OSS**, LGPL-3.0-or-later | Running, modifying, and redistribution are possible under LGPL obligations. This does not license the separately packaged analyzers. |
| Community Build 26.8 ZIP/image as actually shipped | LGPL core **plus SSALv1 analyzers**, expressly stated by Sonar and in the release notice ([overview](https://www.sonarsource.com/license/), [COPYING](https://github.com/SonarSource/sonarqube/blob/26.8.0.126808/sonar-application/src/main/assembly/COPYING)) | **Mixed OSS and source-available** | Do not call the whole analyzer-bearing distribution “LGPL-only” or “open source.” Exact JAR/image contents control. |
| SonarScanner CLI 8.1.0.6389 | `LICENSE.txt` is LGPLv3; source header says version 3 or later ([license](https://github.com/SonarSource/sonar-scanner-cli/blob/8.1.0.6389/LICENSE.txt), [source header](https://github.com/SonarSource/sonar-scanner-cli/blob/8.1.0.6389/src/main/java/org/sonarsource/scanner/cli/Cli.java)) | **OSI-approved OSS**, LGPL-3.0-or-later | Safe to treat as a separate client, subject to exact archive/image dependencies and LGPL notices/source obligations if redistributed. It does not make the analyzers or backend LGPL. |
| Current common language analyzers | Current repositories use the SSAL text described below | **Source-available, not OSI OSS** | The public grant does not cover Leveret's intended AI/competitive integration. Keep out absent permission. |
| SonarQube Server Developer/Enterprise/Data Center | Order + Primary Customer Agreement + Server Supplemental Terms; licensed by edition and LOC ([terms](https://www.sonarsource.com/legal/sonarqube/terms-and-conditions/)) | **Commercial/proprietary** | No redistribution or general integration right follows from buying or trialing a license. Results use is contract-limited. |
| SonarQube Cloud, including Free and OSS plans | Primary Customer Agreement + Cloud terms + AUP; Free/Team have additional terms, while no OSS-specific legal supplement was verified ([Cloud terms](https://www.sonarsource.com/legal/sonarcloud/terms-of-service/), [plans](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans), [Free/Team terms](https://www.sonarsource.com/legal/cloud-free-and-team/), [AUP](https://www.sonarsource.com/legal/aup/)) | **SaaS/proprietary terms** | “Free” and “OSS” describe plan eligibility/price, not an open-source license or unrestricted API/result use. |

### The Community Build analyzer set is mostly one SSAL, but not one license closure

The 26.8 release's [bundle manifest](https://github.com/SonarSource/sonarqube/blob/26.8.0.126808/sonar-application/bundled_plugins.gradle)
and [version declarations](https://github.com/SonarSource/sonarqube/blob/26.8.0.126808/build.gradle)
identify the common bundled plugins below. The active language-analyzer
repositories checked all use the same top-level **SSAL v1.0** text, updated
2024-11-13. That text already contains the competition and outside-AI
restrictions. The central web license is now labeled **SSAL v1.0.1**, updated
2025-11-20, and contains the same restrictions. The label difference must be
recorded, not guessed away: the license file inside the exact downloaded JAR is
the artifact-level evidence.

| Bundled Community Build 26.8 plugin(s) | Version(s) in 26.8 | Official repository license evidence | Assessment |
|---|---:|---|---|
| C# and VB.NET | 10.31.0.145097 | [`sonar-dotnet` 10.31 license](https://github.com/SonarSource/sonar-dotnet/blob/10.31.0.145097/LICENSE.txt) | SSAL v1.0 |
| Flex | 2.18.0.6281 | [`sonar-flex` SSAL](https://github.com/SonarSource/sonar-flex/blob/1eb8cce18632db84f961ef0107e540c7f24b7f5f/sonar-flex-plugin/src/main/resources/licenses/LICENSE.txt) | SSAL v1.0 |
| Go | 1.40.0.6765 | [`sonar-go` SSAL](https://github.com/SonarSource/sonar-go/blob/efe10d609a42f9dbf5f9154ef424dd216d9674ac/sonar-go-plugin/src/main/resources/licenses/LICENSE.txt) | SSAL v1.0 |
| HTML | 3.30.0.8241 | [`sonar-html` 3.30 license](https://github.com/SonarSource/sonar-html/blob/3.30.0.8241/LICENSE.txt) | SSAL v1.0 |
| Java; Java symbolic execution | 8.37.0.45887; 8.16.4.1912 | [`sonar-java` release license](https://github.com/SonarSource/sonar-java/blob/8.37.0.45887/LICENSE.txt); [symbolic-execution 8.16 license](https://github.com/SonarSource/sonar-java-symbolic-execution/blob/8.16.4.1912/LICENSE.txt) | SSAL v1.0 |
| JavaScript, TypeScript, and current CSS analysis | 13.4.0.43982 | [`SonarJS` 13.4 license](https://github.com/SonarSource/SonarJS/blob/13.4.0.43982/LICENSE.txt) | SSAL v1.0 |
| PHP | 3.60.0.16641 | [`sonar-php` 3.60 license](https://github.com/SonarSource/sonar-php/blob/3.60.0.16641/LICENSE.txt) | SSAL v1.0 |
| Python | 5.27.0.35548 | [`sonar-python` SSAL](https://github.com/SonarSource/sonar-python/blob/4019df9257a903f29ce6abf7cb8b067a29bbbe08/LICENSE.txt) | SSAL v1.0 |
| Kotlin | 3.7.0.9514 | [`sonar-kotlin` SSAL](https://github.com/SonarSource/sonar-kotlin/blob/125b30fc300513d94aeb3adce3f120cb61343c6e/LICENSE.txt) | SSAL v1.0 |
| Ruby; Scala | 1.24.0.2550; 1.24.0.2554 | [`sonar-ruby` 1.24 license](https://github.com/SonarSource/sonar-ruby/blob/1.24.0.2550/LICENSE.txt); [`sonar-scala` SSAL snapshot](https://github.com/SonarSource/sonar-scala/blob/e151ca164a4c89495507ff5e6961555ead922da0/sonar-scala-plugin/src/main/resources/licenses/LICENSE.txt) | SSAL v1.0 |
| Rust | 1.8.0.3284 | [`sonar-rust` SSAL](https://github.com/SonarSource/sonar-rust/blob/72179dd5fdeea84599b48383b14ec9eaed0378d3/sonar-rust-plugin/src/main/resources/licenses/LICENSE.txt) | SSAL v1.0 |
| XML | 2.18.0.7959 | [`sonar-xml` 2.18 license](https://github.com/SonarSource/sonar-xml/blob/2.18.0.7959/LICENSE.txt) | SSAL v1.0 |
| IaC | 2.13.0.21933 | [`sonar-iac` SSAL](https://github.com/SonarSource/sonar-iac/blob/668c6c3cc380751ac7ee97c09ddd3c610b53da0b/LICENSE.txt) | SSAL v1.0 |
| Text/secrets | 2.47.0.11983 | [`sonar-text` packaged SSAL](https://github.com/SonarSource/sonar-text/blob/81bbedf50bf8617c3d3fdc20b3ab95ad343c381a/sonar-text-plugin/src/main/resources/licenses/LICENSE.txt) | SSAL v1.0 |
| JaCoCo report importer | 1.6.0.5741 | [`sonar-jacoco` license](https://github.com/SonarSource/sonar-jacoco/blob/522a83b5c4dc56ee830ed81aeeda08412308a199/LICENSE.txt) | LGPLv3; this is a coverage importer, not a Sonar language analyzer |
| Clean-as-You-Code plugin | 2.6.0.3665 | Coordinate is in the 26.8 build, but no matching public source/license file was verified | **Unknown—inspect the exact JAR** |

This is not evidence that every file inside each JAR has only the top-level
license. Several plugins embed native programs and third-party libraries with
their own notices. Conversely, the archived
[`sonar-css` repository](https://github.com/SonarSource/sonar-css/blob/master/LICENSE)
is LGPL, but it is not the current CSS analyzer; current CSS support is in the
SSAL-licensed SonarJS plugin. Repository names and historical badges are not a
release compliance inventory.

## What the licenses and terms actually require

### LGPL-3.0-or-later: real open-source permission, with copyleft obligations

SPDX identifies `LGPL-3.0-or-later` as both OSI-approved and FSF Free/Libre and
publishes the complete incorporated LGPL/GPL text
([SPDX license record](https://spdx.org/licenses/LGPL-3.0-or-later.html)). The
relevant consequences are:

- Running an unmodified LGPL program is unrestricted. GPL §2 also says output is
  covered only when its content itself constitutes a covered work. Merely
  executing an LGPL scanner as a child process does not make Leveret a derivative
  work.
- Distributing source requires intact copyright/license/no-warranty notices and
  the license. Distributing object code requires corresponding source by one of
  GPL §6's permitted methods. Modified source must be marked as modified and
  remain under the applicable LGPL/GPL terms.
- Linking creates an LGPL “Combined Work.” LGPL §4 requires prominent notice,
  copies of the GPL and LGPL, preservation of modification and reverse-engineering
  rights, and either a suitable shared-library mechanism or source/application
  material sufficient to relink with a modified library.
- Side-by-side aggregation does not relicense independent Leveret code, but each
  included component keeps its own obligations. A container is a distribution
  medium, not a license exception.
- GPLv3 §13 expressly permits combining GPLv3-covered material with AGPLv3. That
  makes the LGPL portions workable with Leveret's AGPL-3.0-or-later license, but
  it does not erase LGPL §4 or object-code/source-delivery duties.

For the scanner ZIPs and Docker images, the embedded JRE and other dependencies
must be audited separately. Sonar's 8.1 page offers both JRE-bearing
platform archives/images and an “Any” archive requiring a preinstalled JVM; the
top-level scanner license is not proof that every payload has that license
([8.1 downloads](https://docs.sonarsource.com/sonarqube-community-build/analyzing-source-code/scanners/sonarscanner)).

### SSAL v1.0/v1.0.1: source-visible but purpose-restricted

The reviewed repository SSAL v1.0 and current web SSAL v1.0.1 provide a
copyright and patent grant only for a defined **Non-competitive Purpose**. The
full clauses—not a badge—control ([Java 8.37 artifact-source license](https://github.com/SonarSource/sonar-java/blob/8.37.0.45887/LICENSE.txt),
[current SSAL v1.0.1](https://www.sonarsource.com/license/ssal/)):

> “Competing” includes marketing a substitute for SonarQube's functionality or
> value, through services, libraries, plug-ins, or other interfaces, including
> when it is provided free of charge.

> “Non-competitive Purpose” excludes providing substantially similar
> functionality, Competing with SonarQube, and employing outside AI to ingest,
> interpret, analyze, train on, or interact with data provided by the Program,
> or to engage with the Program in any manner.

SSAL §§2–3 then grant reproduction, derivative-work, distribution/sublicensing,
and patent rights only for that permitted purpose. If a permitted-purpose
recipient distributes the program in any form, it must also make source
available, state that source is available under SSAL and explain how to obtain
it, license distributed source under SSAL, include the agreement, and preserve
notices. Material breach terminates rights after an uncured reasonable period.

SSAL is therefore source-available, not OSI open source: its competition and AI
field-of-use limits conflict with the Open Source Definition's no-field-of-
endeavor principle ([OSI Open Source Definition](https://opensource.org/osd)).
It also cannot simply be merged or relicensed into Leveret's AGPL work; the
field-of-use restriction is not a permission Leveret can remove or pass on as
AGPL-only. A process boundary can avoid creating a combined copyrighted work,
but it cannot expand SSAL's purpose grant.

### Commercial SonarQube Server and SonarQube Cloud: contract and AUP, not OSS

The current Primary Customer Agreement expressly excludes no-cost downloads
such as Community Build from its definition of commercial “Products.” For
commercial Products it grants a limited, non-transferable, non-sublicensable
right to use the ordered SaaS or self-managed Product and to access/use Results
Data, conditioned on use solely for the customer and affiliates' **internal
development purposes** ([Primary Agreement §§1–2](https://www.sonarsource.com/legal/primary-agreement/)).
The Server supplement further limits deployment by ordered LOC and extra copies
to testing, staging, and disaster recovery
([Server Supplemental Terms §2](https://www.sonarsource.com/legal/sonarqube/terms-and-conditions/)).

The AUP, last updated 2025-11-07, requires prior written consent to:

- copy, distribute, modify, reverse engineer, or create derivative works of the
  Products or Documentation;
- create, market, or distribute add-ons or enhancements, or incorporate a
  Product into another product; and
- use Results Data to develop, build, or enhance a competing product, expressly
  including static-analysis tools, security scanners, and **code-review
  systems** ([AUP §§3, 5, 6](https://www.sonarsource.com/legal/aup/)).

AUP §6 permits a customer to use Results Data with general-purpose AI coding
assistants for that customer's internal development, but expressly leaves §5's
integration restrictions in place. That is not a public grant to make Sonar a
Leveret backend. SonarQube Cloud's Free tier is still governed by the Primary
Agreement, Cloud terms, AUP, and Free/Team supplement. That supplement says
Free/Team Customer Data must contain no Personal Data and permits SonarSource to
use Customer and Usage Data for product and model improvement
([Free/Team §§3, 6](https://www.sonarsource.com/legal/cloud-free-and-team/)).
The separately documented **OSS plan** may fit Leveret's own public organization:
it is free, allows unlimited public repositories and branch/PR analysis, and
allows no private projects. It does not say that the service or Results Data is
open source, and no OSS-plan-specific legal/data supplement was verified; the
Primary Agreement, Cloud supplement, and AUP still control
([Cloud subscription plans, “OSS plan”](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans#oss-plan-sonarqube-for-oss)).

### APIs, JSON, and SARIF do not supply a separate license

Community Build documents a bearer-token Web API and warns that Web API v2 will
gradually replace v1 ([Community Build Web API](https://docs.sonarsource.com/sonarqube-community-build/extension-guide/web-api)).
The scanner's documented CLI options launch and submit an analysis. Its
`report-task.txt` supplies a compute-engine task ID, not findings; a correct
integration would poll completion and call the public, Browse-permission
`api/issues/search` endpoint
([analysis parameters](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/analysis-parameters/parameters-not-settable-in-ui),
[official Web API schema](https://next.sonarqube.com/sonarqube/api/webservices/list?include_internals=false)).
No direct SonarScanner issue JSON or SARIF export option was verified. Sonar's
SARIF documentation covers **importing third-party SARIF 2.1.0 reports into
SonarQube**, not exporting Sonar findings
([SonarScanner CLI](https://docs.sonarsource.com/sonarqube-community-build/analyzing-source-code/scanners/sonarscanner),
[SARIF import](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/importing-external-issues/importing-issues-from-sarif-reports)).
The distinct SonarQube CLI can retrieve stored issues in JSON and other formats,
but that convenience does not change the analyzer or Results Data terms
([SonarQube CLI output formats](https://docs.sonarsource.com/sonarqube-cli/using-sonarqube-cli/output-formats)).

A public API is a technical interface, not an independent copyright or contract
license. For Community Build, AI use of analyzer-provided data remains within
the SSAL problem. For commercial Server/Cloud, API issue records are “Results
Data” under the Primary Agreement and the AUP restrictions apply. Converting
authorized records to Leveret's schema or SARIF is mechanically easy, but it
does not cure an unauthorized source use.

### Rules, descriptions, metadata, and implementation code

Rule implementations, bundled rule descriptions, examples, and resource files
inside the current analyzer repositories are part of SSAL-licensed programs.
Copying implementations or mirroring a description corpus into an AGPL
repository requires rights that the public SSAL grant does not provide for
Leveret's intended purpose. Commercial Documentation is additionally covered by
the AUP's no-copy/no-derivative-work clauses.

Rule keys, language identifiers, locations, severities, and short issue messages
may include factual or customer-specific elements, but this note does not assume
that every field is copyrightable or uncopyrightable. The conservative path is
to retain only the per-finding fields required by a permissioned API integration,
preserve provenance, and link to Sonar's rule page. Do not copy rule
implementations, prose catalogs, examples, default profiles, or metadata corpora.

### Trademarks are a separate obligation

SonarSource's current policy lists Sonar™, SonarSource™, SonarQube Server™,
SonarQube for IDE™, and SonarQube Cloud™ as Sonar marks. It allows factual,
descriptive use, but requires the mark to be used as an adjective in ordinary
descriptive text, a superscript `TM`, attribution, and a clear statement that the
software is not a Sonar product. It prohibits use in a product, business, domain,
handle, or brand name and any implication of partnership, sponsorship, or
endorsement ([trademark guidelines](https://www.sonarsource.com/trademark-use/)).
Do not name a Leveret module or edition “Sonar” or use Sonar logos. A minimal
compatibility statement, if permission is obtained, is safer than branding.

## Integration-mode decision table

Labels describe the current public evidence, not a legal opinion. “Allowed” for
an LGPL layer never implies that the separate analyzer/backend is approved.

| Leveret integration mode | Decision | Obligations and reason |
|---|---|---|
| Operator runs unmodified SonarScanner CLI as a separate executable; Leveret neither redistributes it nor ingests Sonar findings | **Allowed** for the LGPL client itself | LGPL permits unmodified execution. The client alone is not a useful Sonar analyzer; verify the endpoint, downloaded engine/plugins, and their terms before expanding the workflow. |
| Leveret publishes a wrapper that discovers an operator-installed scanner and connects to an operator-supplied endpoint | **Unknown / verify per artifact and endpoint** | A thin subprocess wrapper avoids LGPL linkage and redistribution. End-to-end rights still depend on Community Build's SSAL analyzers or the customer's Server/Cloud agreement; finding ingestion into Leveret needs permission. |
| Run Community Build unmodified as a separate process, sidecar, or container and pass findings to Leveret/model | **Avoid / needs permission** | Separation avoids a combined binary but not SSAL's competitive-purpose and outside-AI exclusions. |
| Let each operator optionally download Community Build or analyzers | **Avoid / needs permission** | Operator-controlled download reduces Leveret's redistribution duties; it does not change the intended use or make the SSAL grant apply. |
| Redistribute the SonarScanner CLI ZIP/image with Leveret | **Allowed with obligations** | Pin an exact artifact; include notices and LGPL/GPL text, provide corresponding source as required, preserve relink/modification rights where linkage exists, and audit embedded JRE/transitive licenses. It still supplies no analyzer permission. |
| Redistribute the Community Build ZIP/image or copy it into a Leveret image | **Avoid / needs permission** for Leveret's use; otherwise **allowed with obligations only for an SSAL-permitted purpose** | The image is a mixed aggregate. LGPL source/notices and SSAL source/notice requirements both apply, exact transitive licenses must be met, and Leveret's intended AI/competitive purpose is outside the public SSAL grant. |
| Fork or modify only the LGPL Community Build core or Scanner CLI | **Allowed with obligations** | Mark changes; license and provide corresponding source under LGPL/GPL rules; meet combined-work/relink duties. A core-only fork does not provide the SSAL analysis engines. |
| Fork, modify, or port a current language analyzer | **Avoid / needs permission** | SSAL derivative-work rights are limited to non-competitive purposes; distributing source must stay SSAL. Do not merge it into Leveret's AGPL code. |
| Link Leveret to an LGPL scanner/core library | **Allowed with obligations** | LGPL §4 combined-work notices, license copies, reverse-engineering allowance, and relink/shared-library mechanism apply. A subprocess is simpler. |
| Link or bundle an SSAL analyzer library/plugin | **Avoid / needs permission** | Linkage does not escape the purpose restriction and creates a harder single-work/AGPL licensing problem. |
| Fetch Community Build issues through its Web API and ingest them into Leveret or its model | **Avoid / needs permission** | The API is documented, but analyzer data remains subject to the SSAL AI-purpose exclusion. |
| Fetch commercial Server or Cloud issues, including from the Free or OSS plan | **Avoid / needs permission** for a published Leveret integration | Results Data is limited to internal development; the AUP restricts product integrations and using results to develop/enhance code-review systems. Each operator also needs an authorized account/token and applicable subscription. The OSS plan permits public-repository analysis but does not waive these terms. |
| Convert authorized issue JSON into Leveret findings or SARIF | **Allowed with obligations only after source-use permission** | Transformation code can be AGPL. Preserve provenance and schema meaning; official docs establish SARIF import, not a blanket Sonar export/data license. |
| Copy individual rule IDs/URLs for permissioned findings | **Allowed with obligations** | Keep only necessary per-finding provenance; obey API/Results Data terms and trademark attribution. Do not infer permission to mirror the catalog. |
| Copy rule descriptions, examples, profiles, metadata catalogs, or implementations | **Avoid / needs permission** | Current analyzer material is SSAL; commercial Documentation is contract-restricted. Factual-field questions do not justify bulk copying. |
| Use SonarQube Cloud as the analyzer backend | **Avoid / needs permission** for Leveret integration | SaaS access is contractual, including Free and OSS plans. The OSS plan may cover Leveret's own public repositories, not private ones, but is not an integration/data license. Obtain SonarSource consent and comply with account, token, plan, AUP, data, and rate/usage requirements. |
| Refer to compatibility in prose | **Allowed with obligations** | Follow the trademark guidelines: descriptive adjective use, `TM`, attribution, no branding/logo or endorsement implication. |

## Why profit status does not change the result

| Regime | What triggers permission or obligations | Effect of individual/nonprofit/free status |
|---|---|---|
| LGPL-3.0-or-later | Modification, conveyance, object-code/source delivery, and linkage; ordinary unmodified execution is expressly permitted | None. The license grants the same freedoms and imposes the same compliance duties whether distribution is commercial, free, personal, or nonprofit. |
| SSAL v1.0/v1.0.1 | Whether the purpose is non-competitive, whether outside AI engages with the Program/data, and whether copies or modified works are distributed | None favorable. The competition definition expressly includes products/services provided free of charge, and the AI exclusion is independent of revenue. |
| Commercial SonarQube Server | Customer's Order, tier/LOC, deployment count, internal-development condition, AUP, and consent | “Customer” includes an individual or entity. A nonprofit purchase or trial gets only the ordered rights, not redistribution or public-integration rights. |
| SonarQube Cloud | Account/plan, Primary Agreement, Cloud and any plan supplements, AUP, internal development, and data restrictions | Nonprofit status alone has no effect. Open-source-organization status may qualify public repositories for the free OSS plan, but the service and Results Data remain contractual and the plan allows no private projects. |
| Trademarks | Nature and presentation of the mark use and likelihood of confusion/endorsement | The published guidelines state no nonprofit exception. |

## Recommended permissioned design

If SonarSource gives written permission, the minimum Leveret design is:

1. **Operator-provided dependencies only.** Accept an explicit scanner path and
   Community Build/Server/Cloud base URL plus a least-privilege operator token.
   Do not auto-download or redistribute the scanner, server, image, JARs, or rule
   corpus.
2. **Subprocess plus supported API.** Run the scanner as an external process,
   wait for server-side completion, and use only documented Web API endpoints.
   Do not link analyzer libraries or scrape the UI/database.
3. **Minimal issue conversion.** Convert only the fields necessary for Leveret's
   existing finding schema: stable rule key, message, severity/type, path,
   range, project/revision, issue URL, and Sonar provenance. Keep raw output out
   of prompts unless the permission expressly covers model ingestion.
4. **No Sonar branding.** Describe compatibility only in ordinary prose under
   the trademark policy; do not create a “Sonar” Leveret edition, logo, or
   product name.
5. **Fail closed.** Keep the provider unavailable unless the exact permission,
   endpoint class, artifact versions, and terms snapshot are present in the
   compliance manifest.

The requested permission should expressly answer all of these points rather
than merely say “open-source projects may use Sonar”: Leveret's AGPL publication,
commercial and noncommercial downstream users, CI and hosted operation,
SonarScanner execution, Community Build analyzers, Server/Cloud APIs, issue
storage and conversion, AI interpretation, public review output, exact
redistribution (if any), modified components (if any), and trademark wording.

## Automated due-diligence gates before promotion

1. **Pin artifacts:** version, immutable source tag/commit, download URL,
   SHA-256/container digest, OS/architecture, and release date. Reject `latest`.
2. **Unpack the real closure:** enumerate every ZIP/JAR/native binary/JRE and all
   container layers; generate an SBOM; archive all embedded license and notice
   files. Never approve from a GitHub badge or top-level repository license.
3. **Verify license text:** hash the exact LGPL and SSAL files. Fail when the
   SSAL label/text changes (including v1.0 versus v1.0.1), a license is missing,
   a new `com.sonarsource.*`/unknown plugin appears, or the bundled-plugin list
   changes.
4. **Diff the bundle manifest:** compare the released plugin coordinates and
   versions against an allowlist and source mapping. Treat the unverified CAYC
   plugin and every transitive/native payload as blocked until classified.
5. **Record source delivery:** for every redistributed LGPL/SSAL object, record
   the exact corresponding-source location, offered duration/method, required
   notices, modification markers, and relink mechanism. Test that links work
   without credentials.
6. **Gate on permission scope:** machine-check that a reviewed written grant
   covers the exact Leveret use mode, AI ingestion, Results Data conversion,
   downstream users, endpoint/product tier, artifact versions, and any
   redistribution. Expiration or scope mismatch disables the integration.
7. **Watch mutable terms:** snapshot and hash the SSAL, Primary Agreement,
   Server/Cloud supplements, AUP, and trademark policy with their retrieved and
   effective dates. Any change requires human re-review before the next release.
8. **Exercise only supported interfaces:** contract-test documented API v1/v2
   issue fields, processing completion, pagination, token scopes, rate/usage
   limits, and deletion/retention behavior. Do not fall back to UI scraping,
   internal endpoints, database access, or scanner logs.
9. **Prevent corpus copying:** reject vendored Sonar rule prose, examples,
   profiles, metadata catalogs, logos, and analyzer source. Permit only approved
   per-finding fields and rule URLs.
10. **Check names and notices:** lint user-facing text for factual descriptive
    trademark use, required `TM`/attribution/disclaimer, and the absence of Sonar
    marks from Leveret product/module names.

## Ambiguities deliberately left open

- The repository analyzer licenses are labeled SSAL v1.0 while the current
  central page is v1.0.1. Both contain the restrictions material here, but only
  the exact license packaged with a pinned binary establishes that artifact's
  version.
- Community Build's release notice says it is packaged with SSALv1 analyzers,
  but that statement is not an SBOM. The exact ZIP/image may include additional
  OSS, source-available, and proprietary/transitive terms.
- The CAYC plugin's exact public source/license was not verified. It remains
  blocked rather than being inferred from its Maven group or neighboring
  plugins.
- No official direct SonarScanner issue JSON/SARIF export was verified. The
  documented SARIF direction is into SonarQube; a supported issue API is the
  likely extraction boundary, subject to permission and versioned schemas.
- This note does not decide whether a particular rule key, message fragment, or
  output field is copyrightable. The explicit SSAL purpose restriction and
  commercial Results Data/AUP clauses are sufficient reasons not to build the
  proposed integration without permission.
- A customer's separately negotiated Order can override or supplement the public
  terms. Leveret must review that actual agreement rather than assume the public
  terms are the complete contract.
