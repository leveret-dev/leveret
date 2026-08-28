# Source-Tree License Map

## Classification Rule

Only GPL and AGPL trees qualify for the requested strong-copyleft shortcut. LGPL, MPL, EPL, permissive, source-available, proprietary, custom and unclear terms require full specifications. Classification is applied to source subtrees rather than inferred from repository ownership.

No primary in-scope SonarQube Community Build tree qualifies for a GPL or AGPL copy marker. Every inventoried part therefore requires a full specification.

This map records observed license terms and is not legal advice.

## Platform

| Tree or artifact | License | Evidence | Strong copyleft marker |
|---|---|---|---|
| `SonarSource/sonarqube` tag `26.8.0.126808` production source | `LGPL-3.0-or-later` | Root `LICENSE.txt`, `HEADER.spotless`, production source headers, and README license section | No |
| `SonarSource/sonarqube-webapp`; released `webapp-assets:2026.5.0.65571` | LGPL v3; repository headers indicate the project license | Artifact POM and repository `LICENSE.txt` | No |
| `sonar-plugin-api:13.8.0.4399` | LGPL v3 | Published POM and source archive | No |
| `sonar-scanner-engine-community:13.5.0.4089` | LGPL v3 | Published POM and source archive | No |
| `SonarSource/sonar-cayc-stats-plugin` tag `2.6.0.3665` | `LGPL-3.0-or-later` | Root `LICENSE`, POM, Java and TypeScript headers | No |

## Bundled Analyzer Trees

The SonarSource analyzer repositories below use Sonar Source-Available License v1.0 for analyzer-owned source. This custom license is recorded as `LicenseRef-SSAL-1.0`; it is not a standard SPDX license identifier and is not GPL or AGPL.

| Analyzer tree | Pinned release evidence | Primary license | Strong copyleft marker |
|---|---|---|---|
| `SonarSource/sonar-dotnet` | Tag `10.31.0.145097`, commit `64d936d2b2e0bf75e82bba15a8ed54881e8749c3` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-flex` | Tag `2.18.0.6281`, commit `84cf021e37206d01e7f04ffe7172c40d0ee8ad85` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-go` | Artifact `1.40.0.6765`; release-boundary candidate commit `ba90d496cc57d793b867a82ff656a51fc7993735` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-html` | Tag `3.30.0.8241`, commit `bea5cf6e3c328ae7ab55de591c8b02df0c2ad491` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-java` | Tag `8.37.0.45887`, commit `53f70bdf0f34a64bfe97b71f1bfee07e6d14baa6` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-java-symbolic-execution` | Tag `8.16.4.1912`, commit `8d1b73d26c83a998d7af4e4a8f10587654f2e12c` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/SonarJS` | Tag `13.4.0.43982`, commit `d02b514f8007f18a798876fc9361b9c233ab2f02` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-php` | Tag `3.60.0.16641`, commit `1edd16ff3f12c7a39d28eb61ee8b1b3ea4c3e875` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-python` | Artifact `5.27.0.35548`; release-boundary candidate commit `2c3590318c644163418f82b57341a21ac1b5cb99` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-kotlin` | Tag `3.7.0.9514`, commit `facf0e04ee5be1b19967968ed1f98734e6d773ff` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-ruby` | Tag `1.24.0.2550`, commit `406444ea31e5724951252db4bb87a74a69893dae` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-rust` | Tag `1.8.0.3284`, commit `2cd44039c36a7f0f17bddc9fce6359876bd1bdc1` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-scala` | Tag `1.24.0.2554`, commit `f8e0a83baf34dbe3fb8313eca792f0abd6e47ff5` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-xml` | Tag `2.18.0.7959`, commit `793fbcea0c1e65caa6afe5b3a4b5dd04c0c4d945` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-iac` | Immutable source artifact `2.13.0.21933`, SHA-256 `310503bc261339a90c283c5c6e4fe218d017ab948e12a3b4221630b62d5f0b7e` | `LicenseRef-SSAL-1.0` | No |
| `SonarSource/sonar-text` | Immutable source artifact `2.47.0.11983`, SHA-256 `de760fdca4ec1d30cb5195e5fd90c51ed364c8dcc0f64fe826099dfafd2f8d46` | `LicenseRef-SSAL-1.0` | No |

## Bundled Integration Tree

| Tree | Pinned release | License | Strong copyleft marker |
|---|---|---|---|
| `SonarSource/sonar-jacoco` | Tag `1.6.0.5741`, commit `d7ac50ea711e3321dabc2e4fbb7edf757507f892` | `LGPL-3.0-or-later` | No |

GitHub, GitLab, Bitbucket, Azure DevOps, LDAP and SAML integration source is part of the pinned `SonarSource/sonarqube` tree and inherits its `LGPL-3.0-or-later` production-source license unless a file-specific notice says otherwise.

## Subtree and Packaged-Dependency Exceptions

These exceptions affect provenance and redistribution but do not convert their containing Sonar-owned trees into GPL or AGPL trees.

| Location or dependency | Observed terms | Treatment |
|---|---|---|
| `sonar-application/src/main/assembly/sonarsource-svnkit-license.txt` | Custom SonarSource SVNKit/SQLJet terms | Full interoperability specification only; no copy marker. |
| `sonar-application/src/main/assembly/bin/winsw-license/` | MIT | No implementation specification for WinSW internals; process-runtime spec covers only Sonar-facing behavior. |
| `sonar-sarif/.../sarif-schema-2.1.0.json` | OASIS document notice | Reference SARIF contract and notice; no copy marker. |
| Analyzer Commons and SSLR dependencies | LGPL v3 | Weak copyleft under project rule; no copy marker. |
| Flex StAX API payload | POM offers GPL v2 or CDDL v1 alternatives; generated notice retains GPL text | Record chosen alternative if payload copying is contemplated. No exclusive-GPL subtree established. |
| Ruby JRuby payload | GPL v2, LGPL v2.1 or EPL v2 alternatives | No exclusive-GPL subtree; no copy marker. |
| HTML Jakarta EL payload | EPL v2 with conditional GPL secondary option | Primary EPL treatment; no copy marker. |
| Kotlin compiler, Scala parser libraries, Rust native dependencies, Go native dependencies, IaC Helm helpers, SonarJS Node dependencies and analyzer packaged notices | Mixed permissive, LGPL, MPL or EPL-family terms in inspected notices | Preserve package-level notices where required; none establishes a Sonar-owned GPL/AGPL tree. |
| Java custom-rule documentation example | MIT-0 | Documentation/example subtree, not bundled analyzer implementation. |
| Test-source Git submodules and shared build logic | Mixed external terms | Excluded as product implementation; may be used as behavioral evidence only. |

## Provenance Limitations

- Go `1.40.0.6765` and Python `5.27.0.35548` have immutable published artifacts and uniquely evidenced release-boundary commits, but their published POMs use SCM `HEAD` and no matching public Git tag exists. Specifications must identify the candidate commit as a limitation, not as cryptographically proven artifact provenance.
- IaC `2.13.0.21933` and Text `2.47.0.11983` have immutable public source archives and hashes but no matching public Git tags. Exact archives, not current branches, are authoritative.
- Shared SLang engine `1.21.0.8303` is published under SSAL and named by Ruby and Scala builds, but the public `SonarSource/slang` repository exposes no matching tag. Ruby and Scala plugin releases remain exactly pinned.
- Webapp `2026.5.0.65571`, scanner engine `13.5.0.4089`, and several unified runtime artifacts publish exact Maven artifacts but do not publish immutable Git commits in their POMs. Exact artifacts remain authoritative.
