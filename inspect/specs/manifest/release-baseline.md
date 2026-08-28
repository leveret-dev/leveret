# Release Baseline

## Selected Release

- Product: SonarQube Community Build
- Stable release: 26.8.0.126808
- Publication date: 2026-08-05
- Source repository: https://github.com/SonarSource/sonarqube
- Release page: https://github.com/SonarSource/sonarqube/releases/tag/26.8.0.126808
- Git tag: `26.8.0.126808`
- Git commit: `b33183b846cd47c7a811e280f5755f13d8fa8cc7`
- Official distribution: https://binaries.sonarsource.com/Distribution/sonarqube/sonarqube-26.8.0.126808.zip
- Official distribution SHA-256: `ea1c5c1932f9c25350eafc4cdb1a839527c117e5d98b5fcf222a715b6b50a1f2`

The GitHub release is neither a draft nor a prerelease. It was the newest stable repository release when the source audit began.

## External Checkout

The source is checked out at `/tmp/sonar-cleanroom-source/sonarqube-26.8.0.126808`. The checkout is detached at the exact tag and commit above. This path is outside the specification workspace and is provenance only; implementation teams must not receive or depend on it.

## Version Evidence

- GitHub release metadata identifies the release name, tag, publication time, and target commit.
- The checked-out Git tag resolves exactly to the recorded commit.
- Root `gradle.properties` declares Community Build version `26.8`.
- Root `build.gradle` pins bundled plugin artifact versions.
- `sonar-application/bundled_plugins.gradle` identifies the plugin artifacts included by Community Build assembly.
- SonarSource's distribution service publishes the recorded SHA-256 checksum.

## Baseline Rule

All platform, analyzer, integration, rule, metric, protocol, and compatibility specifications must describe this release and its resolved dependency revisions. Later branch or release behavior is out of scope unless explicitly identified as evidence clarifying an unchanged pinned-release contract.
