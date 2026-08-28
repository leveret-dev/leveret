# Text and Secrets Analyzer Specification

## 1. Identity, authority, and license

This specification covers the Community Build artifact `org.sonarsource.text:sonar-text-plugin:2.47.0.11983`, published as “Text Code Quality and Security.” Its plugin key is `text`, its entry point is the Text and Secrets plugin, its minimum declared SonarQube version is 9.8, its minimum Java runtime is 17, and it declares SonarLint support. The artifact is bundled by SonarQube Community Build `26.8.0.126808`.

The authoritative implementation evidence is the immutable Maven source archive at `https://repo1.maven.org/maven2/org/sonarsource/text/sonar-text-plugin/2.47.0.11983/sonar-text-plugin-2.47.0.11983-sources.jar`, whose SHA-256 is `de760fdca4ec1d30cb5195e5fd90c51ed364c8dcc0f64fe826099dfafd2f8d46`. The corresponding published POM is at `https://repo1.maven.org/maven2/org/sonarsource/text/sonar-text-plugin/2.47.0.11983/sonar-text-plugin-2.47.0.11983.pom`.

No matching public Git tag exists. No Git commit is asserted as an exact source-to-artifact mapping. Current `master` and all other `SonarSource/sonar-text` branch contents are not release authority and were not used to expand this release’s behavior. The immutable source archive, its hash, the released plugin manifest, and the pinned SonarQube distribution are authoritative.

Analyzer-owned source is licensed under Sonar Source-Available License v1.0, recorded by this project as `LicenseRef-SSAL-1.0`. The published POM calls the license `SSALv1`. This is not a GPL or AGPL copy case, so a full clean-room specification is required. Evidence: source-archive `licenses/LICENSE.txt`, released `META-INF/MANIFEST.MF`, and the published POM.

## 2. Purpose, scope, and exclusions

The artifact performs two independent domains of content analysis over files already indexed by the scanner:

- repository `text`, language key `text`: Unicode security checks;
- repository `secrets`, language key `secrets`: detection of publicly shipped credential, token, private-key, connection-string, and webhook formats.

Both registered languages have zero file suffixes. They exist to own rules and quality profiles, not to claim files. Files retain their language assignment from other analyzers, or remain unassigned. The plugin therefore owns content selection and issue production, not general language recognition.

In scope are file eligibility, hidden-file and Git behavior, binary and suffix exclusion, Unicode checks, all 29 public secret specification files, all 70 public detection entries, all 30 secret rule keys, all three Text rule keys, rule metadata, issue ranges, global analyzer settings, failure behavior, concurrency, and telemetry.

Out of scope are parsing and semantic models, syntax highlighting, symbols, cross-references, code duplication, code metrics, coverage, test execution reports, and external-issue report import. The artifact implements none of those contracts. Scanner indexing, active-rule selection, quality profiles, issue persistence and lifecycle, source storage, telemetry transport, and global exclusions are owned by their corresponding platform specifications.

`com.sonarsource.text:sonar-text-developer-plugin:2.47.0.11983` and `com.sonarsource.text:sonar-text-enterprise-plugin:2.47.0.11983` are not bundled by Community Build and are excluded. Their source archives and pattern inventories are not present in the authoritative public archive. Their rule keys, pattern IDs, formats, filters, and behavior are therefore unavailable for this specification and no behavior is inferred from them. This is an explicit scope boundary, not an incomplete Community catalog. Evidence: pinned SonarQube `build.gradle`, `sonar-application/bundled_plugins.gradle`, and source-archive `org/sonar/plugins/secrets/SecretsSpecificationFilesDefinition.java`.

## 3. Dependencies and owned contracts

The analyzer consumes these host contracts:

- Sonar plugin loading, active checks, indexed `InputFile` objects, charset metadata, file type, language assignment, hidden-file status, path predicates, cancellation, issue creation, analysis errors, warnings, and telemetry properties;
- project settings and quality-profile activation;
- scanner-side global file inclusion, `sonar.exclusions`, and indexing size limits;
- local Git status, using Git CLI when available and JGit otherwise;
- analyzer-commons `2.28.0.5085` for the analyzer-agnostic test-file heuristic opt-out key;
- Aho-Corasick `0.6.3` for shared content-prefilter dispatch and JGit `7.7.0.202606012155-r` for the fallback Git implementation;
- Java regular expressions and Jackson Smile runtime specification deserialization. The archive’s JSON schema and validator are release-generation evidence; the production loader does not invoke schema validation.

It owns these externally observable contracts:

- which indexed files it requests and which checks run on each requested file;
- the two rule repositories and their default profiles;
- the 33 rule keys and their issue behavior;
- public secret-format detection and filtering;
- analyzer-specific settings, warnings, analysis errors, logs, and telemetry identifiers.

The plugin performs no network validation of a candidate credential and makes no claim that a syntactically accepted credential is live. It has no database or durable state and does not contact a credential provider.

## 4. Inputs, eligibility, and file recognition

### 4.1 Input boundary

Only scanner-indexed files can be analyzed. `sonar.text.inclusions` can select additional indexed files but cannot recover a file rejected before indexing. In the pinned Community Build, the scanner-owned hidden setting `sonar.filesize.limit` defaults to 20 MB and allows files exceeding that limit to be discarded before analyzer execution. The Text artifact defines no independent file-size setting and no maximum byte count. Once an `InputFile` is supplied, it reads the whole decoded file into a line list and constructs a second normalized whole-file string. Scanner-side size and indexing policy therefore remains the effective size boundary. Large indexed files can consume memory proportional to their decoded content; the analyzer does not stream rule matching.

The scanner-provided charset is used. Line terminators are removed during reading and reconstructed as line-feed separators between lines. A final line terminator is not retained in the normalized content. Rules operate either on this line list or normalized string.

### 4.2 Normal SonarQube selection

Unless `sonar.text.analyzeAllFiles` is true, the selected set is the union of:

1. non-hidden indexed files with any non-null language assignment; and
2. on plugin API 12.0 or newer outside SonarLint, hidden indexed files or files matching `sonar.text.inclusions`, provided that local Git status succeeded and did not report the file as untracked or modified.

On API versions before 12.0, the hidden-file branch is unavailable. The sensor declares hidden-file processing only on API 12.0 or newer and never declares it in SonarLint.

The default `sonar.text.inclusions` patterns are `**/*.sh`, `**/*.bash`, `**/*.zsh`, `**/*.ksh`, `**/*.ps1`, `**/*.properties`, `**/*.conf`, `**/*.pem`, `**/*.config`, `**/*.env`, `.aws/config`, and `**/*.key`.

Additional-inclusion and hidden-file processing requires successful Git status. Files reported by Git as modified or untracked are rejected from that branch. Files under `.git` are rejected. Language-assigned visible files do not depend on Git status. If Git status cannot be obtained, analysis falls back to visible language-assigned files and emits a warning explaining that `sonar.text.inclusions` requires analysis inside a Git repository. A cross-filesystem path that cannot be relativized also falls back to the visible-language predicate: on API 12.0 or newer outside SonarLint, the file must be both language-assigned and non-hidden; on older APIs, a language assignment alone satisfies that fallback. SonarLint uses analyze-all selection and does not enter this Git branch.

When `sonar.text.inclusions.activate=false`, Git is not initialized for this selection purpose and only visible language-assigned files are selected.

### 4.3 Analyze-all and SonarLint selection

In SonarLint, and when internal setting `sonar.text.analyzeAllFiles=true`, selection changes to every indexed file except names rejected by the fast binary-name predicate. This branch ignores custom user suffix exclusions for file selection. Secret-only suffix exclusions still apply later to secret checks.

The binary-name predicate lowercases the substring after the final dot and rejects these 360 extensions:

`3dm`, `3ds`, `3g2`, `3gp`, `7z`, `a`, `aac`, `aar`, `adp`, `ai`, `aif`, `aiff`, `alz`, `amr`, `ape`, `apk`, `appimage`, `ar`, `arj`, `asf`, `at`, `au`, `avi`, `b`, `bak`, `baml`, `bfc`, `bh`, `bin`, `bk`, `bmp`, `br`, `btif`, `bytes`, `bz2`, `bzip2`, `cab`, `caf`, `cer`, `cfe`, `cfs`, `cgm`, `changesubtype`, `ckp`, `class`, `cmx`, `cpio`, `cr2`, `cur`, `dat`, `data`, `db`, `dcm`, `deb`, `dex`, `dii`, `dim`, `djvu`, `dll`, `dmg`, `dng`, `doc`, `docm`, `docx`, `dot`, `dotm`, `dra`, `ds_store`, `dsk`, `dts`, `dtshd`, `dvb`, `dvd`, `dvm`, `dwg`, `dxf`, `dylib`, `ecelp4800`, `ecelp7470`, `ecelp9600`, `egg`, `enc`, `eol`, `eot`, `eps`, `epub`, `exe`, `exec`, `f4v`, `fbs`, `fdm`, `fdt`, `fdx`, `fe`, `fh`, `fla`, `flac`, `flatpak`, `fli`, `flv`, `fnm`, `fpx`, `fst`, `fvt`, `g3`, `gch`, `gem`, `gh`, `gif`, `gpg`, `graffle`, `gz`, `gzip`, `h261`, `h263`, `h264`, `heif`, `hmap`, `icns`, `ico`, `idx`, `ief`, `img`, `ipa`, `ir`, `iso`, `jar`, `jce`, `jks`, `jnilib`, `jpeg`, `jpg`, `jpgv`, `jpm`, `jxr`, `kdbx`, `kdd`, `kdi`, `kdm`, `keystore`, `keystream`, `kjsm`, `kotlin_module`, `ktx`, `ldf`, `lha`, `lib`, `lvp`, `lz`, `lzh`, `lzma`, `lzo`, `m3u`, `m4a`, `m4v`, `macho32`, `macho64`, `mar`, `mdf`, `mdi`, `meta`, `mht`, `mid`, `midi`, `mj2`, `mka`, `mkv`, `mmdb`, `mmr`, `mng`, `mo`, `mobi`, `mobileprovision`, `mov`, `movie`, `mp3`, `mp4`, `mp4a`, `mpeg`, `mpg`, `mpga`, `mxu`, `nef`, `nes`, `nib`, `node`, `npx`, `npz`, `numbers`, `nupkg`, `nvd`, `nvm`, `o`, `odp`, `ods`, `odt`, `oga`, `ogg`, `ogv`, `otf`, `ott`, `p12`, `pages`, `pbm`, `pcap`, `pch`, `pcx`, `pdb`, `pdf`, `pea`, `pf`, `pfx`, `pgm`, `phar`, `pic`, `pkcs12`, `pkenc`, `pkg`, `pkl`, `plaso`, `plist`, `png`, `pnm`, `pos`, `pot`, `potm`, `potx`, `ppa`, `ppam`, `ppm`, `pps`, `ppsm`, `ppsx`, `ppt`, `pptm`, `pptx`, `proto`, `protobuf`, `ps`, `psd`, `pxm`, `pya`, `pyc`, `pyo`, `pyv`, `qt`, `rar`, `ras`, `raw`, `res`, `resources`, `rgb`, `rip`, `rlc`, `rmf`, `rmvb`, `rpm`, `rsc`, `rtf`, `rz`, `s3m`, `s7z`, `scc`, `scpt`, `sgi`, `shar`, `si`, `signature`, `sil`, `sketch`, `slk`, `smv`, `snap`, `snk`, `so`, `sqlite`, `sqlite3`, `st`, `stack2`, `stl`, `sub`, `suo`, `swc`, `swf`, `tab`, `tab_i`, `tar`, `tbz`, `tbz2`, `tga`, `tgz`, `thmx`, `tif`, `tiff`, `tim`, `tip`, `tlog`, `tlz`, `tmd`, `truststore`, `ttc`, `ttf`, `tvd`, `tvm`, `tvx`, `txz`, `typedefs`, `ucfg`, `ucfgs`, `udf`, `uvh`, `uvi`, `uvm`, `uvp`, `uvs`, `uvu`, `viv`, `vob`, `war`, `wasm`, `wav`, `wax`, `wbmp`, `wdp`, `weba`, `webm`, `webp`, `whl`, `wim`, `wm`, `wma`, `wmv`, `wmx`, `woff`, `woff2`, `wrm`, `wvx`, `xbm`, `xcf`, `xcuserstate`, `xif`, `xla`, `xlam`, `xls`, `xlsb`, `xlsm`, `xlsx`, `xlt`, `xltm`, `xltx`, `xm`, `xmind`, `xpi`, `xpm`, `xwd`, `xz`, `z`, `zip`, `zipx`, and `zstd`.

It also rejects any filename ending in `cacerts`. A bare filename of exactly 32, 40, 64, or 128 hexadecimal characters is rejected when its Shannon entropy is greater than 3.1; these lengths correspond to common digest-name lengths. A dotless name or name ending in a dot has no extension and is not rejected on extension alone.

### 4.4 Content-level binary handling

For a selected file with no language assignment, the reader checks each decoded line for any character in U+0001–U+0007, U+000E–U+001A, or U+001C–U+001F. Finding one marks the file binary, discards its accumulated content, warns, and skips all Text and Secrets checks. U+0000, U+0008–U+000D, U+001B, and characters at or above U+0020 do not trigger this predicate.

For a file with a language assignment, this content-level binary-character check is not performed. The scanner and owning language analyzer are trusted to have supplied text. The extension blacklist is also not part of normal language-file selection. Consequently, a language-assigned file with a normally binary-looking suffix remains eligible unless the scanner excluded it.

### 4.5 Secret-only suffix exclusions

`sonar.secrets.excluded.file.suffixes` affects only Secrets rules. Its default is `.adoc,.md,.mdx,.dist,.html,.example,.sample,.template`. Text rules still run on such files.

The deprecated `sonar.text.excluded.file.suffixes` is additive. Values from both properties are trimmed, stripped of characters other than ASCII letters, digits, hyphen, underscore, and dot, deduplicated, and unioned. A value consisting of one leading dot followed by an extension name is matched through the scanner extension predicate. Any other retained value is matched as a case-sensitive filename suffix. Use of the deprecated property emits an analysis warning and telemetry.

Global scanner exclusions take precedence because an unindexed file never reaches this plugin. Secret suffix exclusions then gate only the Secrets checks. Text rules are unaffected.

### 4.6 Test files

Every secret specification starts from MAIN files only. A scanner-classified `InputFile.Type.TEST` is excluded from Secrets rules regardless of automatic-test settings. Text rules still run.

When `sonar.tests` is blank and the runtime is not SonarLint, the analyzer additionally classifies a file as an automatic test file if any of these case-insensitive path rules applies:

- its filename starts with `test`, contains `test.` or `tests.`, or ends in `.spec.js`, `.spec.jsx`, `.spec.ts`, `.spec.tsx`, `_spec.rb`, `_test.rb`, or `.t`;
- a relative-path directory is `doc`, `docs`, `test`, `tests`, `e2e`, `mock`, `mocks`, `__tests__`, `__fixtures__`, `testdata`, or `fixtures`;
- any relative-path directory name ends in `test` or `tests`.

By default, such a file is skipped by all Secrets checks and counted in the scan log. A nonblank `sonar.tests` disables this automatic heuristic. `sonar.secrets.disableTestFileDetection=true` or the analyzer-commons setting `sonar.testFileHeuristic.disabled=true` skips this filter: automatic-test candidates are then emitted with a low-confidence annotation. Neither setting re-enables scanner-classified TEST files.

## 5. Processing model and issue production

### 5.1 Stages

A conforming implementation shall perform these observable stages:

1. Resolve analyzer activation and active Text and Secrets checks.
2. Initialize public secret specifications, content prefilters, global filter settings, Git service, telemetry, worker count, and regex timeout management.
3. Select indexed files according to Section 4.
4. For each selected file, trigger scanner metadata generation, classify automatic test status when enabled, read and normalize content, and apply content-level binary rejection where applicable.
5. Dispatch Text rules and eligible Secrets rules. Public secret specifications may first require case-insensitive content terms, path patterns, or extension predicates. Matching then identifies candidates, auxiliary context accepts or rejects them, and post-filters apply entropy, known-fake, path, or URI tests.
6. Convert accepted secret captures to scanner text ranges, remove overlapping secret issues according to selectivity, and save issues.
7. Emit warnings, analysis errors, progress information, and telemetry; then stop worker and regex executors.

Content prefiltering is an optimization and must not change results. It may use a shared trie to avoid running provider checks whose required content terms do not occur.

### 5.2 Secret candidate and location contract

Every public secret specification in this artifact identifies the reportable value as its first capture. The issue range is exactly that capture in normalized file coordinates, including multiple lines where a format permits them. Provider labels, assignment operators, usernames, surrounding URLs, and context-only markers are outside the range unless the catalog explicitly says the whole URL or key block is captured.

Private-key rules in `secrets:S6706` report the opening key marker, not the encoded body. `secrets:S6335` captures its entire unencrypted key block. Database rules normally report only the password; the quoted alternatives of `odbc-connection-string` under `secrets:S6703` include their surrounding single or double quote delimiters in the captured issue range. Token rules report the token. Webhook rules report the full webhook URL.

Text rules report an issue on the entire containing line. Their messages identify a one-based column, hidden payload, or sequence count as applicable; they do not create a narrow character range.

### 5.3 Overlap handling

Secret issues are buffered per file. Overlapping ranges form groups and only one issue per group is saved. `specific` entries have priority 0, `providerGeneric` entries priority 1, and `analyzerGeneric` entries priority 2. The five `providerGeneric` public entries are the four `secrets:S6703` entries and `pkcs8-private-key` under `secrets:S6706`; all other public entries are `specific`. Thus a specific Google service-account key finding wins over the overlapping generic PKCS#8 marker. The artifact defines no secondary semantic priority between entries with equal selectivity; a compatible implementation must not promise a particular equal-priority winner.

### 5.4 Filters and confidence

Entropy is Shannon entropy over the captured candidate or explicitly named random segment. A candidate passes when entropy is greater than or equal to its entry threshold.
Effective entry prefilters merge provider-level and entry-level include and reject lists. A rule-level post-filter, when present, replaces rather than merges with the provider post-filter; an entry with no rule-level post-filter inherits the provider post-filter. Catalog rows state the resulting effective constraints.

The shared known-fake filter rejects values shorter than six characters; common sample, example, placeholder, redaction, dummy, test, and password words; repeated-character values; variable and template interpolation; environment or configuration lookups; command substitutions; bracketed placeholders; encrypted-value markers; secret-manager references; formatting placeholders; 1Password references; shortened values containing ellipses; and other curated fake forms recorded by the public specifications. Individual entries add format-specific documentation values or placeholder forms.

`sonar.secrets.disableEntropyFilter=true` does not remove an entropy requirement from the catalog. Instead, a candidate that fails only that filter is emitted as low confidence. `sonar.secrets.disableKnownFakeSecretFilter=true` similarly emits candidates that match a curated known-fake exclusion. If one or more skippable filters would have rejected an emitted candidate, its normal message gains a suffix of the form `low-confidence match, disabled filters:` followed, in stable order, by `entropy`, `known fake secrets`, and/or `automatic test file detection`. Hard format constraints, path exclusions, auxiliary context, MAIN-file scope, and path/URI heuristics remain active.

Path heuristic rejection requires at least two slash or backslash characters and a separator-to-length ratio of at least 0.15. URI heuristic rejection recognizes complete `http`, `https`, `ftp`, `ftps`, `file`, `smtp`, or `imap` scheme URLs.

Auxiliary line-distance checks reject a candidate when its line has 1,000 or more characters unless an entry supplies another limit. The generic PKCS#8 entry supplies 5,000. Character-distance checks do not use that line-length guard.

## 6. Unicode-security rule catalog

Repository `text` is named `Sonar`. Its default profile is `Sonar way`, containing all three rules. All three have status `ready` and scope `All`. None has rule parameters.
`text:S6389` and `text:S7628` carry tags `cwe` and `former-hotspot`; `text:S8522` carries tag `cwe`.

| Rule | Detection and exclusions | Issue contract | Metadata |
|---|---|---|---|
| `text:S6389` — Source code should not contain bidirectional control characters | On each line, track U+202A, U+202B, U+202D, and U+202E until U+202C, and track U+2066, U+2067, and U+2068 until U+2069. Report only when an opener remains unclosed at line end. Unmatched closing controls are ignored. A fully balanced line is compliant. Exclude Android internationalization files whose path ends in a locale-qualified `res/values-…/strings.xml`. | At most one whole-line issue per line; message gives the one-based column selected from the remaining unclosed controls. | Vulnerability; default severity Major; Security impact Medium; Clean Code attribute Clear; constant remediation 5 minutes; CWE-94 and ASVS 4.0 5.2.5 and 5.2.8; no rule parameter; quick-fix status unknown. |
| `text:S7628` — Unicode tag blocks should not be used | Detect a consecutive sequence of at least two code points from U+E0020 through U+E007F. Convert tag code points to their corresponding visible payload for the message. Do not report a payload that is blank or has converted length at most one. Skip a black-flag sequence beginning U+1F3F4 and continuing through tag characters, with or without U+E007F, as a legitimate flag emoji. | Whole-line issue for each reportable sequence; message includes converted hidden text and a one-based logical column. Normally this column counts code points. If an earlier black-flag tag sequence was skipped on the same line, that entire skipped sequence advances the counter by one column, so later reported columns are intentionally collapsed relative to physical code-point positions. | Vulnerability; default severity Major; Security impact Medium; Clean Code attribute Clear; constant remediation 5 minutes; CWE-94 and OWASP LLM Top 10 2025 LLM01; no rule parameter; quick-fix status unknown. |
| `text:S8522` — Consecutive Unicode Variation Selectors should not be used | Detect each consecutive run of four or more code points in U+FE00–U+FE0F or U+E0100–U+E01EF. Runs of one through three are excluded. | Whole-line issue for each qualifying run; message includes run length and one-based code-point column. | Vulnerability; default severity Major; Security impact High; Clean Code attribute Trustworthy; constant remediation 5 minutes; CWE-94 and CWE-506; no rule parameter; quick-fix status unknown. |

Evidence: source-archive `org/sonar/plugins/text/**`, `org/sonar/l10n/text/rules/text/*.json`, and `org/sonar/l10n/text/rules/text/Sonar_way_profile.json`.

## 7. Public Secrets rule and pattern catalog

Repository `secrets` is named `Sonar Secrets Analyzer`. Its default profile is `Sonar way`, containing all 30 rules below. Every rule has status `ready`, scope `All`, type Vulnerability, default severity Blocker, Security impact Blocker, Clean Code attribute Trustworthy, constant remediation 30 minutes, tags `cwe` and `secret`, and quick-fix status infeasible. Every rule maps to CWE-798, CWE-259, OWASP A3, CERT MSC03-J., OWASP Top 10 2021 A7, PCI DSS 3.2 6.5.10, PCI DSS 4.0 6.2.4, ASVS 4.0 2.10.4, 3.5.2, and 6.4.1, and STIG ASD_V5R3 V-222642. `secrets:S6706` additionally maps to OWASP Mobile Top 10 2024 M1 and M10. None has rule parameters.

The catalog below is exhaustive for the public artifact. Names after each YAML filename are public specification entry IDs.

Exact released rule titles are:

| Rule key | Title |
|---|---|
| `S6290` | Amazon Web Services credentials should not be disclosed |
| `S6292` | Amazon MWS credentials should not be disclosed |
| `S6334` | Google API keys should not be disclosed |
| `S6335` | Google Cloud service accounts keys should not be disclosed |
| `S6338` | Azure Storage Account Keys should not be disclosed |
| `S6684` | Azure Subscription Keys should not be disclosed |
| `S6687` | Django secret keys should not be disclosed |
| `S6689` | GitHub tokens should not be disclosed |
| `S6690` | GitLab tokens should not be disclosed |
| `S6693` | SSH private keys should not be disclosed |
| `S6694` | MongoDB database passwords should not be disclosed |
| `S6697` | MySQL database passwords should not be disclosed |
| `S6698` | PostgreSQL database passwords should not be disclosed |
| `S6701` | Telegram bot keys should not be disclosed |
| `S6702` | SonarQube tokens should not be disclosed |
| `S6703` | Database passwords should not be disclosed |
| `S6706` | Cryptographic private keys should not be disclosed |
| `S6708` | Discord Webhook URLs should not be disclosed |
| `S6739` | Redis credentials should not be disclosed |
| `S6751` | PyPI tokens should not be disclosed |
| `S6752` | Artifactory tokens should not be disclosed |
| `S6758` | NPM access tokens should not be disclosed |
| `S6762` | Grafana tokens should not be disclosed |
| `S6771` | Postman tokens should not be disclosed |
| `S6782` | Docker Hub tokens should not be disclosed |
| `S6783` | Infura API keys should not be disclosed |
| `S6987` | Docker swarm tokens should not be disclosed |
| `S6995` | Splunk tokens should not be disclosed |
| `S7013` | OpenAI API keys should not be disclosed |
| `S7791` | SonarQube Scoped Organization tokens should not be disclosed |

### 7.1 Cloud, AI, and platform credentials

| Rule and public entries | Detection semantics, exclusions, filters, and issue location |
|---|---|
| `secrets:S6290` — Amazon Web Services credentials; `aws.yaml`: `aws-secret-access-keys-1`, `aws-secret-access-keys-2`, `aws-secret-access-keys-s3cmd`, `aws-session-tokens` | Detect a 40-character AWS secret-access value using the alphanumeric, slash, or plus alphabet when it is near AWS/Amazon secret wording; detect canonical secret-access-key labels; and detect `secret_key` assignments in paths containing `s3cfg`. The first form excludes nearby Caver and Klaytn contexts. The three access-key entries require entropy 4.2 and reject alphabetic-only, numeric-only, and shared known-fake values. Also detect AWS session-token assignments with at least 50 characters from the permitted token, quote, whitespace, and padding alphabet after AWS/Amazon content prefiltering; shared known-fake exclusions apply. Location is the 40-character key or session-token value, which may span normalized lines. |
| `secrets:S6292` — Amazon MWS credentials; `mws.yaml`: `mws-auth-token` | Require `amzn.mws` somewhere in the file, then detect an `amzn.mws.` token followed by a lowercase hexadecimal UUID. Reject candidates containing the same word character eight or more times consecutively and sample or example forms. Location is the complete token. No entropy filter is configured. |
| `secrets:S6334` — Google API keys; `google-api.yaml`: `google-api-keys` | Require `AIza` content, then detect `AIza` followed by 35 characters from the Google API-key alphabet. Reject paths matching `**/GoogleService-Info.plist`, `**/google-services.json`, or `**/google-services*.json`; candidates near Firebase or `maps.googleapis.com` within 250 characters; candidates near `firebase_url` within 100 lines; candidates near recognized Google Maps API identifiers, key wording, or Maps embed URL within 100 characters; candidates with the same word character repeated six or more times; and sample or example forms. Location is the complete key. |
| `secrets:S6335` — Google Cloud service-account keys; `gcp.yaml`: `google-service-account-keys` | Require `accounts.google.com` somewhere in the file, then detect an unencrypted PKCS#8 private-key block whose encoded body is at least 80 contiguous base64 characters or is wrapped in segments of at least 40 characters, with matching begin and end markers. No JSON parsing or specific field name is required. Reject seven-or-more repeated word characters, sample, example, redacted, and `private_key` forms, plus one curated published fake key. Location is the entire key block. As a specific entry it outranks the overlapping generic `S6706` PKCS#8 marker. |
| `secrets:S6338` — Azure Storage Account Keys; `azure.yaml`: `azure-storage-account-keys`, `azure-storage-account-key-connection-string` | Detect a quoted 86-character base64 payload followed by two padding characters when Azure storage host wording occurs within 20 lines; reject `project.assets.json` and a same-line `sha512` context. Independently detect the same key after `AccountKey=` in a connection string. Both entries inherit the shared known-fake exclusions and additionally reject the exact published Azure Storage/Azurite emulator account key and the exact published Cosmos DB local-emulator key. Location is only the 88-character key. |
| `secrets:S6684` — Azure Subscription Keys; `azure.yaml`: `azure-subscription-keys`, `azure-subscription-keys-context-url-before`, `azure-subscription-keys-context-url-after` | Detect a 32-character hexadecimal key, case-insensitively, within 15 characters of subscription-key wording, except a preceding Microsoft Key Vault expression within 150 characters. Also detect the same key near key/secret wording one to three lines before or after a Microsoft API hostname. All entries require entropy 3.0. Location is the hexadecimal key. |
| `secrets:S7013` — OpenAI API keys; `OpenAI.yaml`: `openai` | Detect an `sk-` key with an optional hyphenated namespace portion and a final alphanumeric segment of 48–250 characters, requiring OpenAI wording within two lines. Require entropy 3.9 and reject a tail containing the same alphanumeric character repeated at least five times. Location is the complete key. |
| `secrets:S7791` — SonarQube Scoped Organization tokens; `sonarqube-scoped-org-token.yaml`: `sonarqube-token-scoped` | Detect `sqco_` followed by exactly 59 ASCII alphanumeric characters. Location is the complete token. |
| `secrets:S6702` — SonarQube tokens; `sonarqube.yaml`: `sonarqube-token-with-prefix`, `sonarqube-legacy-token` | Detect `sqa_`, `sqp_`, or `squ_` followed by 40 lowercase hexadecimal characters. Also detect a legacy 40-character hexadecimal value within 30 characters after Sonar/SonarQube login or token wording, while excluding the prefixed forms from this legacy entry. Location is the complete token or legacy value. |

### 7.2 Source control, package, and container services

| Rule and public entries | Detection semantics, exclusions, filters, and issue location |
|---|---|
| `secrets:S6689` — GitHub tokens; `github.yaml`: `github-v2-tokens`, `github-fine-grained-tokens`, `github-oauth-access-tokens`, `github-oauth-token-url` | Detect `ghp_`, `ghu_`, `ghs_`, `gho_`, or `ghr_` plus 36–255 word characters, requiring entropy 4.0 on the random part. Detect `github_pat_` plus 22 alphanumeric characters, an underscore, and 59 alphanumeric characters, requiring entropy 4.8 on the random part. Detect a 40-character hexadecimal OAuth secret near client-secret/access-token wording when an `Iv1.` client identifier with 16 hexadecimal characters occurs in context, requiring entropy 3.1. Detect a 40-character hexadecimal credential embedded in an HTTPS GitHub URL, optionally followed by `x-oauth-basic`. The first three reject path-like and URI-like values plus repeated/sample forms; the URL form applies the shared known-fake set. Location is the complete token or credential value, not the surrounding URL. |
| `secrets:S6690` — GitLab tokens; `gitlab.yaml`: `gitlab-v2-tokens`, `gitlab-tokens` | Detect `glpat-` followed by 20 characters from the alphanumeric, underscore, or hyphen alphabet, requiring entropy 3.2 on that segment. Also detect the longer form with 32 such characters, a two-digit segment, and a nine-character lowercase alphanumeric suffix, requiring entropy 3.5 on the 32-character segment. Reject path-like and URI-like candidates. Location is the complete token. |
| `secrets:S6751` — PyPI tokens; `pypi.yaml`: `pypi-api-token` | Detect `pypi-` followed by at least 150 characters from the permitted alphanumeric, underscore, and hyphen alphabet. Require entropy 5.0. Location is the complete token. |
| `secrets:S6752` — Artifactory tokens; `artifactory.yaml`: `artifactory-api-key`, `artifactory-identity-token`, `artifactory-access-token` | Detect an `AKCp` API key with one digit and 68 URL-safe token characters, requiring entropy 4.8; an identity token beginning `cmVmdGtuO` with 55 URL-safe token characters, requiring entropy 4.6; and the Artifactory three-segment access-token encoding with minimum segment lengths of 30, 100, and 100 after its fixed header prefix, requiring entropy 5.5. Location is the complete token. |
| `secrets:S6758` — NPM access tokens; `npm.yaml`: `npm-access-token` | Detect `npm_` followed by exactly 36 ASCII alphanumeric characters. Require entropy 4.26 and apply the shared known-fake set. Location is the complete token. |
| `secrets:S6771` — Postman tokens; `postman.yaml`: `postman-token` | Detect `PMAK-`, 24 hexadecimal characters, a hyphen, and 34 hexadecimal characters, case-insensitively for the hexadecimal portion. Location is the complete token. |
| `secrets:S6782` — Docker Hub tokens; `docker-hub.yaml`: `docker-hub-personal-access-token` | Detect `dckr_pat_` followed by exactly 27 word or hyphen characters. Require entropy 4.22 and reject curated sample forms including the published documentation value. Location is the complete token. |
| `secrets:S6987` — Docker swarm tokens; `Docker-swarm.yaml`: `docker-swarm-join` | Detect a `SWMTKN-` join token containing a one-digit version, a 50-character lowercase alphanumeric secret, and a 25-character lowercase alphanumeric identifier. Require entropy 4.0 and reject ten curated documentation-example suffixes. Location is the complete token. |

### 7.3 Communication, monitoring, and web frameworks

| Rule and public entries | Detection semantics, exclusions, filters, and issue location |
|---|---|
| `secrets:S6687` — Django secret keys; `django.yaml`: `default-secret-key`, `settings.py-secret-key-string`, `settings.py-secret-key-env-default`, `env-secret-key` | Detect `django-insecure-` plus exactly 50 characters from Django’s allowed lowercase-alphanumeric and punctuation set, requiring entropy 4.9; this rule-level post-filter replaces the provider known-fake filter. In any `settings.py`, detect literal `SECRET_KEY` or `SECRET_KEY_FALLBACKS` assignments and literal default values supplied to supported environment getters, requiring Django wording in file context; these two entries inherit shared known-fake exclusions. In a path matching `.env`, detect those assignments when Django or `ALLOWED_HOSTS` context exists and reject a value that looks like a filesystem path; this rule-level path filter replaces the provider known-fake filter. Location is the assigned key or default value. |
| `secrets:S6701` — Telegram bot keys; `telegram.yaml`: `telegram-bot-key` | Require `telegram` somewhere in the file, then detect 9–12 digits, a colon, `AA`, and 33 characters from the permitted letter, underscore, and hyphen alphabet. Require entropy 4.4 and reject long repeated-character, `123456`, sample, and example forms. Location is the complete token. |
| `secrets:S6708` — Discord Webhook URLs; `discord.yaml`: `discord-webhook-urls` | Require `discord` somewhere in the file, then detect a Discord or DiscordApp API webhook URL, with optional HTTPS scheme, an identifier of at least 18 digits, and a 68-character token segment. Location is the complete URL. |
| `secrets:S6762` — Grafana tokens; `grafana.yaml`: `grafana-api-token`, `grafana-service-account-token`, `grafana-cloud-access-token` | After a Grafana content prefilter, detect legacy API tokens beginning with the encoded `eyJrIjoi` header and at least 48 base64 characters. Detect `glsa_` service-account tokens with 32 alphanumeric characters and an eight-character lowercase hexadecimal suffix, requiring entropy 4.3 and rejecting curated sample values. Detect cloud access tokens beginning `glc_eyJ` with at least 48 base64 characters. Legacy and cloud entries inherit provider exclusions for sample, example, placeholder-like `foo`/`bar`, test, `abcd`, and redacted forms; the service-account entry’s rule-level post-filter replaces those provider exclusions. Location is the complete token. |
| `secrets:S6783` — Infura API keys; `infura.yaml`: `infura-api-keys` | Require `infura.io/v3` somewhere in the file, then detect exactly 32 word characters in the path segment after an `.infura.io/v3/` hostname. Reject eight-or-more repeated word characters and one curated published example key. Location is the 32-character key, not the URL. |
| `secrets:S6995` — Splunk tokens; `splunk.yaml`: `splunk-hec-token`, `splunk-api-token` | Require `splunk` somewhere in the file. Detect a UUID-shaped hexadecimal HEC token within 20 characters after token wording and with Splunk or HEC wording in the preceding four lines; HEC context alone is insufficient unless the provider-level Splunk content gate is also met. Reject values beginning with all-zero or all-one eight-character groups. Also detect a three-segment JWT-like value whose first two segments begin `ey`, requiring Splunk wording in the preceding four lines. Location is the token. |

### 7.4 Databases and connection strings

The shared hard path-exclusion set in this subsection is: `**/appsettings.Development*.json`, `**/appsettings.Local*.json`, `**/launchSettings.json`, `**/.devcontainer/devcontainer.json`, `**/.devcontainer.json`, `**/application-dev.properties`, `**/.env.dev*`, `**/.env.test*`, `**/.ddev/**`, `**/docker-compose.dev.yaml`, `**/docker-compose.dev.yml`, `**/docker-compose.override.yaml`, `**/docker-compose.override.yml`, `**/compose.dev.yaml`, `**/compose.dev.yml`, `**/compose.override.yaml`, `**/compose.override.yml`, `**/public/locales/*/*.json`, `**/locales/*/translation.json`, `**/locales/*.json`, `**/i18n/*.json`, `**/lang/*.json`, `**/i18n/*.properties`, `**/resources/messages*.properties`, and `**/resources/i18n/messages*.properties`.

| Rule and public entries | Detection semantics, exclusions, filters, and issue location |
|---|---|
| `secrets:S6694` — MongoDB database passwords; `mongodb.yaml`: `mongo-url`, `mongodb-cli-unquoted`, `mongodb-cli-quoted-outer` | Require Mongo or MongoDB content and reject every path in the shared hard path-exclusion set. Detect a password between username and host in Mongo or MongoDB connection URIs, including driver suffixes; this entry uses its own shared and Mongo-specific placeholder exclusions. Detect an unquoted or outer-quoted value of at least three characters passed through `-p` or `--password` within 100 characters of `mongo`, `mongodump`, `mongoimport`, `mongorestore`, or `mongosh`; these CLI entries inherit provider-level shared and Mongo-specific known-fake exclusions. Location is only the password. |
| `secrets:S6697` — MySQL database passwords; `mysql.yaml`: `mysql-url`, `mysql-env-mysql_password-unquoted`, `mysql-env-mysql_password-quoted`, `mysql-cli-unquoted`, `mysql-cli-quoted-outer`, `mysql-cli-quoted-inner` | Detect a password of at least two characters between username and host in MySQL or MySQLX connection URIs. Detect quoted and unquoted `MYSQL_PASSWORD` values. Detect values of at least three characters passed through compact `-p` or `--password=` syntax within 100 characters of `mysql`, `mysqladmin`, or `mysqldump`, covering unquoted, outer-quoted, and value-quoted layouts. Each entry applies its curated placeholder, interpolation, masking, and shared known-fake exclusions. Location is only the password. |
| `secrets:S6698` — PostgreSQL database passwords; `postgresql.yaml`: `postgres-url`, `postgres-url-password-from-env-with-default`, `postgres-env-pg_password-unquoted`, `postgres-env-pg_password-quoted`, `psql-cli-unquoted`, `psql-cli-quoted` | Detect a password in PostgreSQL, Postgres, Postgis, or driver-suffixed connection URIs; exclude URI candidates preceded within 50 characters by regex wording. Detect a literal fallback value inside shell-style environment substitution in such a URI. Detect quoted or unquoted `PG_PASSWORD` assignments, excluding command-substitution starts where specified. Detect quoted or unquoted `PGPASSWORD` values followed within 40 characters by `psql`. Apply the full shared hard path-exclusion set to every entry. All six entries inherit provider exclusions for database-password variable names, shell variables and substitutions, bracketed and angle-bracketed placeholders, masking, string-concatenation fragments, positional brace placeholders, `postgres`, `prisma`, and `bitnami` defaults, and the shared known-fake forms. No entropy filter is configured. Location is only the password or literal fallback. |
| `secrets:S6703` — Database passwords; `odbc.yaml`: `java-datasource-unquoted`, `java-datasource-quoted`, `jdbc-connection-string`, `odbc-connection-string` | Provider-generic entries detect quoted or unquoted datasource password properties with a corresponding username property within three lines, allowing up to 400 dotted qualifier segments. Detect a JDBC query password when user or username occurs on the same line. Detect an ODBC `password` or `pwd` field when a user/UID field and at least one provider, data-source, initial-catalog, or database field occur within three lines. Apply the full shared hard path-exclusion set and extensive placeholder, interpolation, translation, and known-fake exclusions. Locations are the password values, except that a quoted `odbc-connection-string` alternative includes its surrounding single or double quotes in the issue range. |
| `secrets:S6739` — Redis credentials; `redis.yaml`: `redis-url` | Detect a password between user and host in a Redis or TLS Redis URI. Apply the shared known-fake set. Location is only the password. |

### 7.5 Private keys and authentication standards

| Rule and public entries | Detection semantics, exclusions, filters, and issue location |
|---|---|
| `secrets:S6693` — SSH private keys; `ssh.yaml`: `ssh-private-key`, `putty-private-key` | Detect an OpenSSH private-key begin marker when the expected OpenSSH encoded prefix and matching end marker occur after it. Detect a PuTTY user-key header with a numeric format version when a private-line count and a hexadecimal private MAC of at least 40 characters occur later. Location is the opening marker or PuTTY header. |
| `secrets:S6706` — Cryptographic private keys; `pubkey-crypto.yaml`: `rsa-private-key`, `rsa-private-key-encrypted`, `ec-private-key`, `ec-private-key-encrypted`, `pkcs8-private-key`, `pkcs8-private-key-encrypted` | Detect unencrypted RSA keys when at least 60 base64 characters and an end marker occur within 5,000 characters after the opening marker. Detect encrypted RSA and EC keys only when encryption metadata, at least 60 base64 characters, and the corresponding end marker occur after the opening marker. Detect unencrypted EC keys with at least 60 base64 characters and an end marker. Detect unencrypted PKCS#8 keys with at least 60 base64 characters within one line of the opener, on a candidate line shorter than 5,000 characters, and a later end marker; this provider-generic entry applies the shared hard path-exclusion set from Section 7.4. Detect encrypted PKCS#8 keys with at least 60 base64 characters and the corresponding end marker. Encrypted keys are intentionally still findings. Location is always the opening marker. |

Evidence for the entire Secrets catalog: source-archive `org/sonar/plugins/secrets/configuration/*.yaml`, `org/sonar/plugins/secrets/common/*.yaml`, `org/sonar/plugins/secrets/SecretsSpecificationFilesDefinition.java`, `org/sonar/plugins/secrets/SecretsCheckList.java`, `org/sonar/l10n/secrets/rules/secrets/*.json`, and `org/sonar/l10n/secrets/rules/secrets/Sonar_way_profile.json`.

## 8. Configuration and precedence

### 8.1 Registered project settings

| Key | Default | Contract |
|---|---:|---|
| `sonar.text.activate` | `true` | Master switch for both Text and Secrets analysis. When false, no files or rules are analyzed; disabled-sensor telemetry is emitted where supported. |
| `sonar.text.inclusions.activate` | `true` | When false, suppress additional path and hidden-file inclusion and avoid Git initialization for that selection; visible language-assigned files remain eligible. |
| `sonar.text.inclusions` | patterns in Section 4.2 | Additional indexed path patterns. Effective only when inclusion activation is true and Git status succeeds. |
| `sonar.secrets.excluded.file.suffixes` | `.adoc,.md,.mdx,.dist,.html,.example,.sample,.template` | Secret-only suffix exclusion. Text rules remain active. |
| `sonar.text.excluded.file.suffixes` | empty | Deprecated additive secret-only suffix exclusion. Emits warning and telemetry when nonempty. |
| `sonar.secrets.disableEntropyFilter` | `false` | Converts entropy-only rejections into low-confidence issues. Other filters remain active. |
| `sonar.secrets.disableTestFileDetection` | `false` | Converts automatic-test-file rejections into low-confidence issues. Does not affect scanner-classified TEST files. |
| `sonar.secrets.disableKnownFakeSecretFilter` | `false` | Converts curated-known-fake rejections into low-confidence issues. Other filters remain active. |

### 8.2 Operational and internal settings

| Key | Default | Contract |
|---|---:|---|
| `sonar.text.threads` | available processor count | Number of parallel file workers and regex workers. Community Build does not cap a positive configured value to processor count; it warns when greater. Zero or a negative value is not accepted by file-worker construction and can abort initialization. |
| `sonar.text.regex.timeout.match` | `10000` ms | First timeout for one regular-expression matching task. Only a parseable positive integer changes the default. |
| `sonar.text.regex.timeout.execution` | `60000` ms | Additional wait after failed interruption. Only a parseable positive integer changes the default. |
| `sonar.text.analyzeAllFiles` | `false` | Internal selection override described in Section 4.3. It is not registered as a project UI property. |
| `sonar.text.debug.logRejectedCandidates` | `false` | Enables internal debug logs for rejected secret candidates. Logs rule ID, file, offset, filter type, entropy values or known-fake filter detail, but not candidate text. |
| `sonar.text.debug.logRejectedCandidates.maxPerRulePerFile` | `20` | Per-rule, per-file rejection-log limit. Values below one become one when logging is enabled. |
| `sonar.text.duration.statistics` | `false` | Enables detailed duration, memory, and telemetry debug logging. It does not alter findings. |
| `sonar.testFileHeuristic.disabled` | `false` | Analyzer-commons generic opt-out honored in addition to `sonar.secrets.disableTestFileDetection`. |
| `sonar.tests` | platform-defined | A nonblank value disables this analyzer’s automatic filename/path test heuristic. It does not change MAIN/TEST type filtering. |

### 8.3 Precedence summary

The effective order is: scanner indexing and global exclusions; `sonar.text.activate`; active rules; file selection mode; Git and hidden-file eligibility; content binary rejection; explicit MAIN-file requirement for secrets; automatic test-file behavior; secret-only suffix exclusion; entry-specific path/content/context conditions; structural match; entropy, known-fake, path, and URI post-filters; overlap resolution. A later setting cannot recover a file rejected at an earlier stage unless this specification explicitly defines a low-confidence bypass for that filter.

No per-rule parameters exist. Active-rule and quality-profile settings therefore control only whether a cataloged rule runs, not its token format or threshold.

## 9. Concurrency, lifecycle, persistence, and telemetry

Files are processed concurrently using `sonar.text.threads`. Checks within one file run sequentially. Scanner metadata generation and issue saving are synchronized because the host API does not guarantee thread safety. Secret candidates are collected per file and flushed after overlap handling. File-processing order and automatic-test skipped-path order are not stable under parallel execution.

The public secret specification loader is initialized once per scanner-side container and reused for a SonarLint instance. The check dispatch trie is initialized once per module container. Per-analysis automatic-test counters and optional skipped paths are reset before reuse. Worker executors and regex executors are shut down after normal analysis. Shutdown waits up to one hour for file workers.

The analyzer persists no state. Outputs are host issue records, analysis-error records, warnings, logs, and telemetry properties. No analyzer-defined measures, coverage, duplication blocks, symbols, highlighting, or external reports are written to the scanner report.

On plugin API 10.9 or newer, telemetry keys have the `text.` prefix. Observed keys are:

- `text.is_sensor_disabled`;
- `text.pluginVersion`;
- `text.sensor_time_ms_community`;
- `text.analyzed_files_count` and, when supported, `text.analyzed_hidden_files_count`;
- `text.all_tracked_text_files_count`;
- `text.excluded.binary.extensions`;
- `text.secrets.excluded.user.suffix` and deprecated-key `text.excluded.user.suffix`;
- `text.secrets.disable_entropy_filter`, `text.secrets.disable_test_file_detection`, and `text.secrets.disable_known_fake_secret_filter`;
- `text.civendor_travisci`, `text.civendor_jenkins`, `text.civendor_circleci`, `text.civendor_gitlab`, `text.civendor_appveyor`, `text.civendor_azurepipelines`, `text.civendor_bamboo`, `text.civendor_buildkite`, `text.civendor_bitbucketpipelines`, `text.civendor_semaphore`, and `text.civendor_dockercompose`.

String telemetry longer than 16 KiB is dropped. The binary-extension telemetry list is limited to the 1,000 most frequent suffixes. Telemetry carries counts, file suffixes, CI-file presence, plugin version, and setting states; it does not carry candidate secret text.

## 10. Failure, partial-result, and recovery behavior

- If no active Text or Secrets rule exists, no file analysis occurs.
- If one public Smile specification resource is missing or cannot be deserialized, the loader warns with the specification filename, omits that specification, and continues loading others. An active rule with no loaded entries warns and produces no findings. Runtime schema-validation failure is not a released behavior: the production loader does not call the archive’s schema validator.
- Failure to read or prepare one file produces an analysis error attached to that file, logs a warning, and continues other files.
- A runtime exception while running checks for one file produces an analysis error for that file. Buffered secret candidates that were not flushed are not promised as partial output. Other files continue unless the worker manager propagates a fatal executor exception.
- An ordinary regex match timeout after 10,000 ms requests interruption. If interruption completes within another 10,000 ms, matching for that entry stops, a warning is emitted, and candidates accumulated before timeout are returned as partial results.
- If regex interruption still has not completed, the analyzer warns and waits the configured execution timeout, 60,000 ms by default. Failure to finish then reinitializes the regex executor and throws a runtime failure for the current file.
- Non-integer regex timeout settings are ignored with debug logging. Nonpositive values do not replace defaults.
- Git discovery failure degrades to visible language-assigned files; it does not fail the scan.
- A content-binary unassigned file is skipped with a warning. A language-assigned file containing the same controls is not subject to this check.
- Scanner cancellation stops submission of new files, drains already submitted work, and marks the progress report cancelled.
- If the analyzer master switch is false, it logs deactivation and returns without analysis.

## 11. Security and trust boundaries

All indexed file content and paths are untrusted input. Implementations shall preserve these safeguards and boundaries:

- candidate matching must be bounded by the two-stage regex timeout and use interruption-aware input;
- file-level failures must not expose candidate secret text in logs;
- normal issues must contain a remediation message and source range, not duplicate the credential in the message;
- debug rejection logging is off by default, rate-limited, and must not log candidate text;
- telemetry must not contain file content or candidate values;
- automatic test and known-fake filters reduce deliberate examples and fixture noise but are not proof that excluded values are safe;
- syntax-only findings must never trigger network requests, credential validation, revocation, or mutation;
- Git inspection is local status inspection. Failure must degrade as specified rather than broadening additional-inclusion analysis;
- secret suffix exclusions are user policy and must not suppress Unicode security rules;
- the analyzer-specific lack of a file-size cap must not be represented as permission to bypass scanner indexing limits. Resource protection at indexing remains a scanner responsibility.

A token-shaped value can be invalid, revoked, scoped, public by design, or a false positive. Conversely, unsupported formats and commercial-only formats are not detected by this public catalog. Findings are therefore evidence for review, not credential-validity attestations.

## 12. Compatibility and limits

- The released manifest requires Java 17 and SonarQube 9.8 or newer.
- Hidden-file processing requires plugin API 12.0 or newer and is disabled as a declared capability in SonarLint.
- Telemetry requires plugin API 10.9 or newer.
- Both analyzer languages claim no suffixes. Compatibility depends on scanner indexing and other analyzers’ language assignments.
- Matching uses decoded Java strings and Java regular-expression semantics. Unicode sequence columns normally count code points; for `text:S7628`, each skipped black-flag tag sequence counts as one logical column when calculating the start of a later sequence on the same line. Secret issue ranges are host scanner ranges derived from normalized offsets.
- No public extension point exists for adding custom secret patterns through project configuration in this artifact. Its 29 public specification files are fixed release resources.
- No project setting changes a provider’s structural format, context distance, entropy threshold, shared path list, or rule metadata.
- No binary payload scanning, archive expansion, Git-history scanning, commit scanning, or remote-repository scanning is provided. Only current indexed working-tree files are considered.
- The analyzer does not inspect secret validity, expiry, ownership, permission scope, or revocation state.

## 13. Acceptance scenarios

1. **Pinned identity.** Given the Maven source archive used for implementation review, calculating SHA-256 yields `de760fdca4ec1d30cb5195e5fd90c51ed364c8dcc0f64fe826099dfafd2f8d46`. No behavior is taken from a branch head or asserted Git tag.

2. **Language-assigned file.** Given an indexed, visible file assigned to any language and at least one active Text or Secrets rule, analysis considers the file without requiring a `sonar.text.inclusions` match or successful Git status.

3. **Additional unassigned file.** Given an indexed unassigned `.pem` file in a successfully detected Git repository and not reported by Git as untracked or modified, default inclusions select it. If the same file is modified or untracked, the additional-inclusion branch rejects it.

4. **No Git repository.** Given a project without successful Git status, a visible language-assigned file remains eligible, while an unassigned file matching a default inclusion does not. The scan warns about inclusion behavior and continues.

5. **Hidden file.** Given plugin API 12.0 or newer outside SonarLint, a hidden indexed file not reported by Git as untracked or modified is eligible even when no explicit inclusion matches. On an older API, that hidden-file capability is not declared.

6. **Secret suffix exclusion.** Given an indexed Markdown file, active `text:S6389`, and an active Secrets rule, the default `.md` exclusion suppresses only the Secrets rule. An unclosed bidirectional opener still produces a Text issue.

7. **Unassigned binary content.** Given an unassigned selected file containing U+0002, the analyzer warns and produces no Text or Secrets issue for it. Given the same decoded control in a language-assigned file, this analyzer’s content-binary predicate does not reject it.

8. **No analyzer size override.** Given a large file that the scanner did not index because of scanner size policy, `sonar.text.inclusions` cannot make it available. Given a large file that is indexed, the analyzer reads its complete decoded content and applies no additional byte-size threshold.

9. **Balanced and unbalanced bidirectional controls.** Given a line where every formatting and isolate opener has its corresponding closer before line end, `text:S6389` emits no issue. Given an opener still unclosed at line end, it emits one whole-line issue whose message names a one-based column.

10. **Unicode tag flag exclusion.** Given a black-flag emoji followed by tag characters, `text:S7628` skips that flag sequence. Given a separate nonblank tag payload of at least two tag code points later on the same line, it emits a whole-line issue containing the decoded hidden payload. Its reported start column counts the entire earlier skipped black-flag sequence as one logical column.

11. **Variation-selector threshold.** Given three consecutive variation selectors, `text:S8522` emits no issue. Given four consecutive selectors from either supported range, it emits one whole-line issue with count and start column.

12. **Provider token and entropy.** Given a structurally valid public token whose catalog entry has an entropy threshold, a value meeting the threshold produces an issue at the captured token range, subject to context and other filters. A value below the threshold is rejected by default. With `sonar.secrets.disableEntropyFilter=true`, that same value is emitted with an entropy low-confidence annotation.

13. **Explicit and automatic tests.** Given a scanner-classified TEST file, Secrets rules never run even when automatic test detection is disabled. Given a MAIN file under `fixtures` while `sonar.tests` is blank, Secrets rules skip it by default; disabling the automatic filter permits findings with a low-confidence annotation. Text rules run in both cases.

14. **Generic and specific overlap.** Given an unencrypted PKCS#8 block accepted by both `secrets:S6335` and generic `secrets:S6706`, overlap resolution retains the specific Google service-account finding and discards the generic overlapping finding.

15. **Shared development-path exclusion.** Given a MongoDB, PostgreSQL, generic ODBC/JDBC, or generic PKCS#8 candidate in a path matching the exact shared development/localization list, its corresponding entry is not run. Disabling entropy or known-fake filtering does not bypass this hard path exclusion.

16. **Regex timeout.** Given hostile content that exceeds the match timeout but responds to interruption, the entry logs a timeout and returns only candidates accumulated before interruption. If it cannot be interrupted within both timeout periods, the current file receives an analysis error and the regex executor is replaced.

17. **Master deactivation.** Given `sonar.text.activate=false`, neither repository analyzes files, and supported runtimes receive disabled-sensor telemetry.

18. **Commercial boundary.** Given a format present only in developer or enterprise Text artifacts, this Community artifact has no required finding. An implementation must not invent or import those unavailable patterns into the Community catalog.

## 14. Provenance index

- Bundling and exact version: pinned SonarQube `build.gradle` and `sonar-application/bundled_plugins.gradle` at Community Build `26.8.0.126808` commit `b33183b846cd47c7a811e280f5755f13d8fa8cc7`.
- Scanner-owned indexing size setting: pinned SonarQube `sonar-core/src/main/java/org/sonar/core/config/ScannerProperties.java`.
- Immutable source and license: Maven source archive URL and SHA-256 in Section 1; source-archive `licenses/LICENSE.txt`; published POM.
- Released identity and compatibility: released plugin `META-INF/MANIFEST.MF`; source-archive `org/sonar/plugins/secrets/pluginVersion.properties`.
- Plugin registration and settings: `org/sonar/plugins/common/TextAndSecretsPlugin.java` and `TextAndSecretsSensor.java`.
- File eligibility, hidden-file, inclusion, Git, binary-name, hash-name, and secret suffix behavior: `org/sonar/plugins/common/predicates/*.java`, `org/sonar/plugins/common/git/*.java`, `org/sonar/plugins/common/BinaryFileUtils.java`, and `org/sonar/plugins/common/InputFileContext.java`.
- File processing, errors, cancellation, issue synchronization, and overlap behavior: `org/sonar/plugins/common/analyzer/*.java`, `org/sonar/plugins/common/thread/ParallelizationManager.java`, and `org/sonar/plugins/secrets/configuration/model/Selectivity.java`.
- Text rules: `org/sonar/plugins/text/**/*.java` and `org/sonar/l10n/text/rules/text/*`.
- Secrets rule registration and public specification inventory: `org/sonar/plugins/secrets/SecretsCheckList.java`, `SecretsRulesDefinition.java`, `SecretsSpecificationFilesDefinition.java`, and `org/sonar/l10n/secrets/rules/secrets/*`.
- Exact public secret formats and exclusions: `org/sonar/plugins/secrets/configuration/*.yaml` and `org/sonar/plugins/secrets/common/*.yaml`.
- Secret matching, prefilters, auxiliary context, entropy, known-fake behavior, low-confidence messages, issue ranges, and timeout recovery: `org/sonar/plugins/secrets/api/**/*.java`, `org/sonar/plugins/secrets/configuration/**/*.java`, and `org/sonar/plugins/secrets/utils/*.java`.
- Telemetry and operational diagnostics: `org/sonar/plugins/common/measures/*.java`, `org/sonar/plugins/common/warnings/*.java`, and `org/sonar/plugins/secrets/api/filters/RejectionLogger.java`.
- Dependency versions: released artifact `META-INF/maven/**/pom.properties`; analyzer-commons source artifact `org/sonarsource/analyzer/commons/appsec/TestFileClassifier.java` for `sonar.testFileHeuristic.disabled`.

All source paths in this index are relative to the authoritative immutable source archive unless explicitly identified as released-artifact or pinned-SonarQube paths.
