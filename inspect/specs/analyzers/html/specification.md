# HTML analyzer specification

## 1. Identity and conformance baseline

This specification defines the HTML analyzer bundled with SonarQube Community Build `26.8.0.126808`. The bundled artifact is `org.sonarsource.html:sonar-html-plugin:3.30.0.8241`. Its authoritative source is `SonarSource/sonar-html`, tag `3.30.0.8241`, commit `bea5cf6e3c328ae7ab55de591c8b02df0c2ad491`. Analyzer-owned source is licensed under Sonar Source-Available License v1.0, recorded as `LicenseRef-SSAL-1.0`; this document specifies behavior rather than authorizing a source copy. [H1][H2][H3]

The plugin key is `web`. It defines language `web` named `HTML`, language `jsp` named `JSP`, and rule repository `Web` named `SonarAnalyzer`. The artifact declares Java 17, minimum plugin API `9.9`, SonarLint support, and required languages `web,jsp,js,php`. [H4][H5]

## 2. Purpose, scope, and exclusions

The analyzer performs tolerant structural analysis of HTML, JSP and HTML-bearing server/template formats. It owns HTML/JSP recognition, page lexing and hierarchy construction, `Web` rules, HTML measures, highlighting, CPD tokens, comment suppression markers and issue-resolution directives. [H5][H6]

The default HTML suffixes are exactly `.html`, `.xhtml`, `.cshtml`, `.vbhtml`, `.aspx`, `.ascx`, `.rhtml`, `.erb`, `.shtm`, `.shtml`, `.cmp`, `.twig`, and `.htm`. Default JSP suffixes are exactly `.jsp`, `.jspf`, and `.jspx`. The sensor additionally considers fixed HTML-bearing suffixes `php`, `php3`, `php4`, `php5`, `phtml`, `inc`, and `vue`, regardless of the two configurable suffix lists. [H5][H7]

Processing a PHP-family or Vue file does not transfer full PHP or Vue ownership to this component. The HTML analyzer inspects only HTML host/template content and selected HTML inside PHP string literals. It does not parse PHP control/data semantics, infer PHP types, parse Vue script or style blocks, calculate host-language measures, import host-language reports, or replace the PHP, JavaScript, TypeScript, CSS or embedded-web analyzers. [H6][H8][H9]

Only main files are selected. Test files are excluded. This analyzer has no coverage or test-execution importer, external-issue importer, symbol index, cross-file DOM, browser execution, network fetch, framework runtime, JavaScript semantic engine or CSS semantic engine. Project/profile state, persistence, issue lifecycle, aggregate duplication and quality gates remain platform-owned. [H6]

## 3. Dependencies and owned contracts

The plugin consumes plugin API `13.8.0.4399`, SSLR `1.26.0.4194`, analyzer commons and recognizers `2.29.0.5138`, Reflections `0.10.2`, and Jakarta Expression Language `4.0.2`. The scanner supplies indexed files, active rules, input charsets, issue/measure sinks, highlighting, CPD and analysis-error APIs. [H4][H5]

The component owns public setting keys `sonar.html.file.suffixes` and `sonar.jsp.file.suffixes`, language keys `web` and `jsp`, repository/key pairs in section 9, parser-visible node positions, HTML-specific measures and issue locations. It consumes generic scanner exclusions and report transport without redefining them.

## 4. Recognition and configuration precedence

### 4.1 Suffix properties

`sonar.html.file.suffixes` and `sonar.jsp.file.suffixes` are project-scoped multi-value properties. Their configured arrays directly replace their respective defaults through the platform configuration service. Values used for special ERB double-extension recognition are trimmed, lowercased and normalized by removing one leading dot; blank values are ignored. The fixed PHP/Vue suffix set is always added for sensor selection and cannot be removed through either property. [H5][H7][H10]

HTML and JSP language classification is scanner-owned after the analyzer publishes suffix arrays. The sensor then selects every main file whose language is `web` or `jsp`, plus main files carrying a fixed PHP/Vue extension. [H6]

### 4.2 ERB evidence filter

A non-ERB candidate passes unchanged. A filename ending case-insensitively in `.erb` is analyzed only when either the preceding extension is in the normalized union of configured HTML suffixes, configured JSP suffixes and fixed PHP/Vue suffixes, or the first 2,048 characters provide HTML evidence after ERB blocks are removed. One HTML document/root marker is sufficient; otherwise at least two known HTML start-tag markers are required. A content-read failure keeps the file so normal sensor error reporting can expose the failure. [H10]

This filter prevents generic text, YAML, Dockerfile or other non-HTML ERB templates from being treated as HTML solely because they end in `.erb`.

### 4.3 Active rules and templates

Only active `Web` rules are instantiated. Rules `IllegalAttributeCheck`, `S8551`, `S140`, `S8488`, `S8687`, `LibraryDependencyCheck`, `ChildElementIllegalCheck`, `ChildElementRequiredCheck`, `ParentElementIllegalCheck`, and `ParentElementRequiredCheck` are declared rule templates. Their useful behavior depends on configured parameters. [H11]

HTML built-in profile `Sonar way` activates: `AvoidCommentedOutCodeCheck`, `DoctypePresenceCheck`, `FlashUsesBothObjectAndEmbedCheck`, `FrameWithoutTitleCheck`, `ImgWithoutAltCheck`, `InputWithoutLabelCheck`, `ItemTagNotWithinContainerTagCheck`, `LinksIdenticalTextsDifferentTargetsCheck`, `MetaRefreshCheck`, `MouseEventWithoutKeyboardEquivalentCheck`, `PageWithoutTitleCheck`, `S1134`, `S1135`, `S1827`, `S4084`, `S4645`, `S5148`, `S5247`, `S5254`, `S5255`, `S5256`, `S5257`, `S5258`, `S5260`, `S5264`, `S5725`, `S6793`, `S6807`, `S6811`, `S6819`, `S6821`, `S6822`, `S6823`, `S6824`, `S6825`, `S6827`, `S6840`, `S6841`, `S6842`, `S6843`, `S6844`, `S6845`, `S6846`, `S6847`, `S6848`, `S6850`, `S6851`, `S6852`, `S6853`, `S7039`, `S7071`, `S7074`, `S7926`, `S7927`, `S7929`, `S7930`, `S8697`, `S8720`, `S8732`, `TableHeaderHasIdOrScopeCheck`, and `UnsupportedTagsInHtml5Check`. The separately registered JSP `Sonar way` profile is empty. [H12][H13]

## 5. Parser behavior

### 5.1 Lexical forms

The page lexer recognizes, in precedence order, HTML comments, JSP comments, Twig comments, doctypes, XML/PHP processing directives, JSP directives, JSP expressions, CDATA, normal tags and remaining text. It preserves line and column positions and emits tag, attribute, directive, expression, comment and text nodes. [H8]

After tokenization it constructs parent/child links with HTML-aware recovery. Void elements never become content parents. The lexer applies optional-close behavior for document metadata, list items, definition items, paragraphs, ruby content, options and table sections/cells. A mismatched closing tag can close intervening known HTML elements when a matching open element remains on the stack. Malformed structure is therefore often recoverable and can be reported by structural rules rather than rejected as a parse error. [H8]

### 5.2 Server-side/template content

PHP processing blocks remain directive nodes. The analyzer also lexically extracts HTML from PHP single-quoted, double-quoted, heredoc and nowdoc string literals. It ignores PHP comments while finding literals, replaces interpolated portions with opaque dynamic content, re-lexes only literals containing an HTML marker, rebases nodes to original source coordinates and balances tags local to the extracted sequence. It never executes PHP. [H9]

Only checks explicitly opting into embedded-node callbacks receive normal element/text callbacks for extracted PHP-string nodes. All checks can still see those nodes in the document node list, so tree-reconstructing checks may inspect them deliberately. The explicit callback opt-ins in this revision are `S6793`, `S6807`, `S6821`, `S6822`, `S6841`, and `S6852`. [H14]

A `.vue` file uses the Vue lexer. Only content inside the first outer `template` region is returned; the outer template tags, script/style regions and content after its matching end are excluded. Nested template elements are retained. A Vue file without an open template produces an empty HTML node stream. [H15]

### 5.3 Failure model

There is no HTML parsing-error rule. Any exception while opening, lexing, visiting or finalizing a file is caught at the file boundary, logged, and saved as an analysis error on that file. The sensor then continues with later files. Outputs already saved before the exception, such as highlighting/CPD produced before rule visitors run, are not rolled back; accumulated issues and measures are saved only after a successful complete scan. [H6][H16]

## 6. Processing stages, lifecycle, and concurrency

The sensor builds one visitor pipeline from active rules, then iterates eligible main files. Before each file it checks scanner cancellation and returns immediately if cancelled. It reads with the input file charset, chooses the Vue or general lexer, constructs nodes, runs metric/suppression visitors, runs rule visitors, and finally saves measures, issues and line-level NCLOC data. Rule visitors receive `startDocument`, ordered node callbacks and `endDocument` for each file. [H6][H16]

Outside SonarLint, runtime API 9.3 or newer is told that files are independent. This component owns no durable state. Visitors clear per-document collections before reuse. Scanner/runtime controls scheduling and persistence. [H6]

## 7. Measures, highlighting, duplication, and directives

### 7.1 Measure ownership

Measures are produced only when the input language is absent, `web`, or `jsp`. A PHP, Vue or other foreign-language file selected by fixed suffix can receive HTML issues, but the HTML analyzer emits no measures, line-level NCLOC, highlighting or CPD for that file; its owning language analyzer remains authoritative. [H17][H18]

For owned files, `ncloc` counts nonblank lines occupied by tags, directives, expressions or text. `comment_lines` counts nonblank HTML comment lines, excluding a leading comment when no prior node exists as defined by the visitor. Line-level `ncloc_data` identifies each counted code line. `complexity` starts at one and increments for recognized JSTL conditional/iteration tags and for whitespace-delimited `&&`, `||`, `and`, or `or` operators inside unified-expression attribute values. [H18][H19]

No classes, functions, statements, executable-line data or cognitive-complexity measure is emitted.

### 7.2 Highlighting and CPD

Outside SonarLint and only for measure-owned files, a second HTML lexer emits highlighting and CPD. Doctypes are structured comments; expressions are annotations; tags are keywords; attribute value portions are strings; comments are comments. CPD receives every non-EOF token with its original token value and exact range; literals are not normalized and no import-like region is removed. An illegal highlighting or CPD range logs a warning and abandons both outputs for that file without aborting rules. [H20]

No symbol or reference output is produced. There is no coverage, test or external-report behavior.

### 7.3 Suppression and issue-resolution directives

A comment or expression containing exact text `//NOSONAR` marks its starting line through the platform `NoSonarFilter`. It does not suppress adjacent lines by itself. [H21]

Outside SonarLint and on runtime API 13.5 or newer, HTML comments are scanned for case-insensitive `SONAR-RESOLVE` directives using analyzer-commons syntax. Complete directives create issue-resolution records for their target line, statuses, rule keys, justification and comment. Invalid directives log warnings; they do not abort the file. [H22]

### 7.4 Issues

Issues use repository `Web`. A check can locate an issue on a full line, an exact node range, an exact attribute-name range, or the file when line zero is used. Remediation gap is preserved when supplied. This analyzer emits no quick fixes. [H6][H23]

## 8. Security and trust boundaries

All source and rule parameters are untrusted project input. The analyzer performs lexical/structural processing only; it does not execute scripts, JSP, PHP, ERB, Twig, Razor, Vue or expression-language functions. No URL in markup is fetched. Jakarta EL is used only to validate supported unified-expression syntax. PHP extraction is bounded by source size but not by a separate public byte limit; ERB sniffing alone is capped at 2,048 characters. [H8][H9][H10]

The scanner process controls readable paths and memory. Source content is read in full for selected files, so practical size limits follow scanner memory. Issues, analysis errors, measures and directives cross into platform-owned persistence and authorization only through scanner APIs.

## 9. Complete rule catalog

The catalog contains every annotated check discovered under `org.sonar.plugins.html` at the pinned revision. Unless a row states otherwise, a rule has no parameters, applies to a successfully tokenized active-rule file, accepts cases that do not meet its named structural condition, and locates the issue on the relevant element, attribute, comment, text, expression or file line/range. Dynamic attribute values are not evaluated; checks requiring a known literal generally do not assert a violation when the required fact is indeterminate. [H11][H23][H24]

| Rule key | Detection semantics, exclusions, and primary location | Parameters and defaults | Type; default severity |
|---|---|---|---|
| `AvoidCommentedOutCodeCheck` | Reports HTML comments recognized with high confidence as disabled code. Copyright, conditional, server-side-include and recognized template comments are excluded. Location is the comment start line. | None | Code smell; Major |
| `AvoidHtmlCommentCheck` | On server-side pages, reports HTML comments containing dynamic values. Static and conditional comments are excluded. | None | Code smell; Minor |
| `BoldAndItalicTagsCheck` | Reports presentational `b` and `i` elements where semantic `strong` or `em` is expected. | None | Bug; Minor |
| `ChildElementIllegalCheck` | Reports each configured child occurring directly under the configured parent. Empty defaults produce no match. | `child` = empty; `parent` = empty | Code smell; Major |
| `ChildElementRequiredCheck` | Reports a configured parent lacking the configured direct child. Empty defaults produce no match. | `child` = empty; `parent` = empty | Code smell; Major |
| `ComplexityCheck` | Reports a file when calculated HTML/JSP complexity exceeds the limit; location is file-level and gap is the excess. | `max` = `10` | Code smell; Major |
| `DoctypePresenceCheck` | Reports an HTML document whose `html` element is not preceded by a doctype. Fragments without an `html` root are excluded. | None | Bug; Major |
| `DoubleQuotesCheck` | Reports attributes delimited with single quotes rather than double quotes. Unquoted and expression-managed values follow lexer classification. | None | Code smell; Minor |
| `DynamicJspIncludeCheck` | Reports JSP include directives whose target is dynamic instead of a fixed resource. | None | Code smell; Major |
| `FieldsetWithoutLegendCheck` | Reports a `fieldset` without a contained `legend`. | None | Bug; Minor |
| `FileLengthCheck` | Reports an owned file exceeding the configured line limit; location is file-level. | `maxLength` = `1000` | Code smell; Major |
| `FlashUsesBothObjectAndEmbedCheck` | Reports legacy Flash embedding that does not provide the expected paired `object` and `embed` structure. Non-Flash objects are excluded. | None | Bug; Minor |
| `FrameWithoutTitleCheck` | Reports frame or iframe content without a title attribute. | None | Bug; Minor |
| `HeaderCheck` | Reports a file whose initial content lacks the configured literal or regular-expression header. Empty default requires configuration to be useful; location is file-level. | `headerFormat` = empty; `isRegularExpression` = `false` | Code smell; Blocker |
| `IllegalAttributeCheck` | Reports attributes matching a configured comma-separated `element.attribute` list, case-insensitively. Empty default matches none. | `attributes` = empty | Code smell; Major |
| `IllegalElementCheck` | Reports elements whose qualified or local name occurs in the configured forbidden list. Empty default matches none. | `elements` = empty | Code smell; Major |
| `IllegalNamespaceCheck` | In XHTML documents, reports namespace declarations in the configured disallowed list. Empty default matches none. | `namespaces` = empty | Code smell; Major |
| `IllegalTabCheck` | Reports tab characters in source formatting. Location is the affected line. | None | Code smell; Minor |
| `IllegalTagLibsCheck` | Reports JSP taglib directives using a configured forbidden URI. | `tagLibs` = `http://java.sun.com/jstl/sql` | Code smell; Blocker |
| `ImgWithoutAltCheck` | Reports `img`, image `input`, and `area` elements lacking the required alternate-text attribute. | None | Code smell; Minor |
| `ImgWithoutWidthOrHeightCheck` | Reports an image missing either width or height metadata. | None | Bug; Major |
| `InlineStyleCheck` | Reports a `style` attribute on an element. | None | Code smell; Major |
| `InputWithoutLabelCheck` | Reports labelable `input`, `select` or `textarea` controls without an associated label; non-labelable input types are excluded. | None | Bug; Major |
| `InternationalizationCheck` | Reports literal user-facing text in configured attributes when it is not a unified/resource expression and does not match the ignore expression. | `attributes` = `outputLabel.value, outputText.value`; `ignoredContentRegex` = empty | Bug; Major |
| `ItemTagNotWithinContainerTagCheck` | Reports `li` outside `ul`/`ol`, or `dt` outside `dl`. | None | Bug; Minor |
| `JspScriptletCheck` | Reports JSP scriptlet/expression nodes, while ordinary markup expressions handled as template data are excluded. | None | Code smell; Major |
| `LibraryDependencyCheck` | Reports JSP page imports that match configured Java package/class prefixes. Empty library list matches none. | `libraries` = empty; `message` = `Remove the usage of this library which is not allowed.` | Code smell; Blocker |
| `LinkToImageCheck` | Reports anchors whose target directly names a recognized image resource. | None | Code smell; Major |
| `LinkToNothingCheck` | Reports anchors targeting only `#` or the recognized no-op JavaScript target. Real destinations are excluded. | None | Code smell; Major |
| `LinksIdenticalTextsDifferentTargetsCheck` | Reports the later link when equal normalized visible text points to a different target. Links without comparable static text/targets are excluded. | None | Code smell; Major |
| `LongJavaScriptCheck` | Reports an inline script region exceeding the configured line count. External scripts and shorter regions are excluded. | `maxLines` = `5` | Code smell; Major |
| `MaxLineLengthCheck` | Reports each physical line longer than the configured limit. | `maxLength` = `120` | Code smell; Major |
| `MetaRefreshCheck` | Reports meta refresh or redirect directives. | None | Code smell; Major |
| `MouseEventWithoutKeyboardEquivalentCheck` | Reports mouse-only event handlers without the corresponding keyboard handler. Configured custom elements are excluded. | `whitelistedElements` = `lightning-button,lightning-button-icon,lightning-button-menu` | Bug; Minor |
| `MultiplePageDirectivesCheck` | Reports additional JSP `page` directives after the first. | None | Code smell; Minor |
| `NonConsecutiveHeadingCheck` | Reports heading-level jumps that skip an intermediate level; location is the later heading. | None | Code smell; Minor |
| `PageWithoutFaviconCheck` | Reports a complete page lacking a favicon link. Fragments without page structure are excluded. | None | Code smell; Major |
| `PageWithoutTitleCheck` | Reports a complete page without a nonempty title element. Fragments are excluded. | None | Bug; Major |
| `ParentElementIllegalCheck` | Reports the configured child when its direct parent is the configured forbidden parent. Empty defaults match none. | `child` = empty; `parent` = empty | Code smell; Info |
| `ParentElementRequiredCheck` | Reports the configured child when it lacks the configured direct parent. Empty defaults match none. | `child` = empty; `parent` = empty | Code smell; Major |
| `RequiredAttributeCheck` | Reports configured elements missing configured attributes from a comma-separated `element.attribute` list. Empty default matches none. | `attributes` = empty | Code smell; Major |
| `S1134` | Reports the first standalone, case-insensitive `FIXME` marker in each comment. Letter-embedded occurrences are excluded. | None | Code smell; Major |
| `S1135` | Reports the first standalone, case-insensitive `TODO` marker in each comment. Letter-embedded occurrences are excluded. | None | Code smell; Info |
| `S140` | Reports nodes selected by configured XPath in files matching the optional Ant-style pattern. Empty expression selects nothing. | `expression` = empty; `filePattern` has no declared default; `message` = `The XPath expression matches this piece of code` | Code smell; Major |
| `S1436` | Reports a page that lacks an element with the configured `id`; the runtime field starts empty and requires configuration. Location is file-level. | `id` has no declared metadata default; runtime value = empty | Code smell; Major |
| `S1827` | In HTML5 documents, reports attributes deprecated by HTML5. Non-HTML5 documents are excluded. | None | Code smell; Major |
| `S1829` | Reports absolute URIs in configured tag/attribute pairs; relative, fragment and indeterminate dynamic values are excluded. | `attributes` = `a.href,applet.codebase,area.href,base.href,blockquote.cite,body.background,del.cite,form.action,frame.longdesc,frame.src,head.profile,iframe.longdesc,iframe.src,img.longdesc,img.src,img.usemap,input.src,input.usemap,ins.cite,link.href,object.classid,object.codebase,object.data,object.usemap,q.cite,script.src,audio.src,button.formaction,command.icon,embed.src,html.manifest,input.formaction,source.src,video.poster,video.src` | Code smell; Major |
| `S4084` | Reports video elements without a subtitles/captions track. | None | Code smell; Major |
| `S4645` | Reports a script element nested within another script element. | None | Bug; Major |
| `S5148` | Reports links opening a new browsing context without protective `rel` semantics. Non-blank targets are excluded when required protection is present. | None | Vulnerability; Minor |
| `S5247` | Reports recognized template directives that disable automatic escaping. Other directives and enabled escaping are excluded. | None | Vulnerability; Major |
| `S5254` | Reports a page whose `html` or fallback `body` element lacks a language attribute. Fragments lacking both are excluded. | None | Bug; Major |
| `S5255` | Reports repeated similar controls/content that cannot be distinguished by accessible labels. Statically distinct accessible names are excluded. | None | Code smell; Major |
| `S5256` | Reports data tables without header cells. Layout tables are handled separately. | None | Bug; Major |
| `S5257` | Reports a table used for page layout. Data tables are excluded. | None | Code smell; Major |
| `S5258` | Reports semantic table markup, such as captions or headers, on a table classified as layout-only. | None | Bug; Critical |
| `S5260` | Reports data cells that do not reference the appropriate headers in complex tables. Simple associations that are structurally determinable are excluded. | None | Bug; Critical |
| `S5264` | Reports an object element without fallback content. Empty/whitespace-only fallback is insufficient. | None | Code smell; Minor |
| `S5725` | Reports remote script/link resources without an integrity attribute. Local and non-applicable resources are excluded. | None | Vulnerability; Minor |
| `S6793` | Reports ARIA attributes whose static value is invalid for that property's declared value type. Dynamic/indeterminate values are excluded. | None | Code smell; Major |
| `S6807` | Reports an element with a recognized ARIA role that lacks properties required by that role. | None | Code smell; Major |
| `S6811` | Reports ARIA properties unsupported by the element's recognized role. Indeterminate roles are excluded. | None | Code smell; Major |
| `S6819` | Reports use of an ARIA role when a native HTML element provides the same semantics, except configured allowed roles. Unknown allowed role names are ignored and produce a deduplicated analysis warning. | `allowedRoles` = empty | Code smell; Major |
| `S6821` | Reports invalid or abstract static ARIA role values. Dynamic role values are excluded. | None | Code smell; Major |
| `S6822` | Reports a role redundant with the element's implicit role, except configured `tag=role` pairs. | `allowedRedundantRoles` = `nav=navigation` | Code smell; Major |
| `S6823` | Reports an element with `aria-activedescendant` that is not keyboard-focusable. | None | Code smell; Major |
| `S6824` | Reports ARIA role/property use on elements that do not support ARIA semantics. | None | Code smell; Major |
| `S6825` | Reports focusable elements hidden from accessibility APIs with `aria-hidden`. | None | Code smell; Major |
| `S6827` | Reports anchors without accessible content. Content hidden from accessibility APIs does not satisfy the rule. | None | Code smell; Minor |
| `S6840` | Reports invalid static `autocomplete` values or values used on unsupported controls. Dynamic values are excluded. | None | Code smell; Major |
| `S6841` | Reports positive static `tabindex` values; `0` and `-1` are accepted. | None | Code smell; Major |
| `S6842` | Reports semantically non-interactive elements assigned interactive ARIA roles. | None | Code smell; Major |
| `S6843` | Reports native interactive elements assigned non-interactive ARIA roles. | None | Code smell; Major |
| `S6844` | Reports anchors used as buttons rather than links. Anchors with genuine navigation semantics are excluded. | None | Code smell; Major |
| `S6845` | Reports `tabindex` on non-interactive elements, subject to recognized role and focus exceptions. | None | Code smell; Major |
| `S6846` | Reports any `accesskey` attribute. | None | Code smell; Major |
| `S6847` | Reports event handlers on elements classified as non-interactive when no interactive semantics make them appropriate. | None | Code smell; Major |
| `S6848` | Reports interactive handlers on static elements lacking a corresponding role and keyboard accessibility. | None | Code smell; Major |
| `S6850` | Reports heading elements without accessible content. | None | Code smell; Major |
| `S6851` | Reports alternate text containing redundant words that merely announce an image/graphic. Dynamic alternate text is excluded. | None | Code smell; Major |
| `S6852` | Reports elements with interactive ARIA roles that cannot receive focus. | None | Code smell; Major |
| `S6853` | Reports labels without accessible text or without an associated control. Either nesting or a valid static `for`/`id` association can satisfy control association. | None | Code smell; Major |
| `S7039` | Reports recognized Content Security Policy declarations containing unsafe or overly broad directives. Location is the policy-bearing meta attribute. | None | Vulnerability; Major |
| `S7071` | On a `webview`, reports every present `nodeintegration` attribute regardless of value, at that attribute name. It also parses a static comma-separated `webpreferences` value with first-entry-wins semantics and reports that attribute when the first `sandbox` value is `false`, `0`, `no`, or `off`, or, if sandbox was not reported, the first `nodeIntegration` value is `1`, `true`, or `yes`. Missing attributes and dynamic `webpreferences` values are excluded. | None | Vulnerability; Critical |
| `S7074` | Reports supported webview configuration that disables web security. | None | Vulnerability; Major |
| `S7926` | Reports viewport metadata that disables zoom or imposes a restrictive maximum scale. | None | Code smell; Major |
| `S7927` | Reports controls whose static accessible name does not contain the visible label text. Dynamic/indeterminate names are excluded. | None | Code smell; Major |
| `S7929` | Reports audio/video configured to autoplay, subject to recognized muted behavior. | None | Code smell; Major |
| `S7930` | Reports a later element whose static `id` duplicates an earlier static `id`; location is the duplicate attribute. Dynamic IDs are excluded. | None | Bug; Critical |
| `S8488` | Template form of required-attribute detection: reports configured elements missing configured attributes. Empty default matches none. | `attributes` = empty | Code smell; Major |
| `S8551` | Template form of forbidden-element detection: reports configured element names. Empty default matches none. | `elements` = empty | Code smell; Major |
| `S8687` | Reports `lang` values whose primary subtag is absent from the configured case-insensitive ISO 639-1 allowlist. An empty runtime allowlist logs an analysis warning and makes the rule inert. | `languages` has no declared metadata default; runtime value = empty | Code smell; Major |
| `S8697` | On `img` or `source` elements with a static `srcset`, reports at most one element-range issue for the first non-dynamic-URL candidate that does not have exactly one valid, positive width or pixel-density descriptor; missing, multiple, malformed, and zero descriptors are invalid. A sole descriptorless `source` candidate is accepted when the element has `media` or `type`. A dynamic whole value and candidates whose URLs are dynamic are skipped. | None | Code smell; Minor |
| `S8699` | On a `form`, validates a directly resolved static `method` first and accepts only case-insensitive `get`, `post`, or `dialog`; dynamic, unified-expression, or qualified method values are skipped. If no direct method exists, any `th:method` is accepted; otherwise the first `method` assignment in `th:attr` is parsed, with dynamic Thymeleaf expressions skipped and determinable values validated against the same set. It reports the form range only when no effective method exists or a determinable value is invalid. | None | Code smell; Minor |
| `S8720` | Reports `aria-role` attributes and requires the standard `role` attribute instead. Location is the attribute name. | None | Bug; Major |
| `S8732` | Reports a legend not directly parented by `fieldset` or `optgroup`. | None | Bug; Major |
| `ServerSideImageMapsCheck` | Reports an `ismap` attribute on an image. | None | Bug; Minor |
| `TableHeaderHasIdOrScopeCheck` | Reports table header cells having neither `id` nor `scope`. | None | Bug; Major |
| `TableWithoutCaptionCheck` | Reports a table without a caption or other recognized accessible description. | None | Bug; Minor |
| `UnclosedTagCheck` | Reports non-void opening tags without a matching close, except configured optional/ignored tags. | `ignoreTags` = `HTML,HEAD,BODY,P,DT,DD,LI,OPTION,OPTGROUP,THEAD,TH,TBODY,TR,TD,TFOOT,COLGROUP,RT,RP,IMG,INPUT,BR,HR,FRAME,AREA,BASE,BASEFONT,COL,ISINDEX,LINK,META,PARAM,WBR,EMBED,SOURCE,TRACK` | Bug; Minor |
| `UnifiedExpressionCheck` | Parses JSF unified expressions and reports syntax failures. Configured function names are accepted during validation; an empty list grants none. | `functions` = empty | Bug; Major |
| `UnsupportedTagsInHtml5Check` | In HTML5 documents, reports elements removed or deprecated by HTML5. Other doctypes are excluded. | None | Bug; Major |
| `WhiteSpaceAroundCheck` | Reports missing required whitespace around JSP/JSF tag constructs and attributes. | None | Code smell; Minor |
| `WmodeIsWindowCheck` | Reports legacy Flash embedding whose window-mode parameter is missing or not the expected window mode. Non-Flash objects are excluded. | None | Bug; Minor |

## 10. Failure, partial results, and recovery

A per-file exception creates one analysis error and does not stop later files. A read failure during ERB sniffing deliberately passes the file onward so this error path remains visible. A malformed but lexically recoverable document is not an analysis error; rules decide whether its structure is problematic. [H6][H8][H10]

If highlighting/CPD range validation alone fails, those outputs are abandoned with a warning while rule processing continues. If a rule throws, the file scan aborts into the analysis-error path and its buffered issues/measures are not saved. No analyzer-owned retry or persistent checkpoint exists; a later scanner run starts again from current input. [H6][H16][H20]

## 11. Compatibility and limits

Conformance requires exact plugin/language/repository keys, default and fixed suffix sets, ERB/Vue/PHP host behavior, rule keys and parameters, measure ownership and issue locations. HTML matching is generally case-insensitive for tag and attribute names where HTML semantics require it; source suffix behavior follows scanner predicates and the explicit lowercasing only where this specification states it. [H7][H8][H10][H23]

The parser is intentionally tolerant and does not claim full standards validation, browser layout, accessibility-tree equivalence, framework component expansion or runtime template evaluation. Dynamic values can limit certainty. No public maximum node count or file length is imposed, apart from rule `FileLengthCheck` when active and the 2,048-character ERB sniff window.

## 12. Acceptance scenarios

1. **Default suffixes.** A main `.html` file is classified as `web` and analyzed; a main `.jsp` file is classified as `jsp`; a test file is ignored.
2. **Fixed host suffix.** A main `.php` or `.vue` file is selected even when neither configured suffix list includes it. HTML issues may be produced, but HTML measures, highlighting and CPD are not emitted when another language owns the file.
3. **Vue boundary.** A Vue component yields nodes only from its first outer template. Script and style contents do not enter this analyzer's rule or measure model.
4. **PHP non-execution.** HTML in supported PHP string literals is structurally inspected at original coordinates. PHP expressions are treated as dynamic content and never executed.
5. **ERB exclusion.** A bare `.erb` file with neither a recognized preceding extension nor sufficient HTML evidence in its first 2,048 characters is skipped. A `.html.erb` file is kept.
6. **Tolerant markup.** A recoverable missing/implicit HTML end tag still produces a node hierarchy and rule results rather than a parser issue. An unexpected runtime parsing exception produces an analysis error and later files continue.
7. **Owned metrics.** An owned HTML page emits `ncloc`, `comment_lines`, `complexity` and line NCLOC. Complexity begins at one and increases for recognized JSTL structures and supported unified-expression operators.
8. **Suppression.** A comment containing exact `//NOSONAR` marks only its starting line through the platform filter.
9. **Configured template rule.** Activating `S8488` with a required `element.attribute` pair reports an element missing that attribute; leaving its parameter empty yields no match.
10. **No report behavior.** Supplying coverage, test or external-issue paths has no HTML-analyzer effect because this component registers no such importer.

## 13. Provenance index

- **[H1]** `manifest/component-inventory.md`, HTML row; `manifest/release-baseline.md`.
- **[H2]** `manifest/license-map.md`, `SonarSource/sonar-html` row.
- **[H3]** `sonar-html` tag `3.30.0.8241`, commit `bea5cf6e3c328ae7ab55de591c8b02df0c2ad491`: `LICENSE.txt`, root `pom.xml`.
- **[H4]** Same revision: root `pom.xml`; `sonar-html-plugin/pom.xml`.
- **[H5]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/HtmlPlugin.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/api/HtmlConstants.java`.
- **[H6]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/core/HtmlSensor.java`.
- **[H7]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/core/Html.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/core/Jsp.java`.
- **[H8]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/lex/PageLexer.java`; tokenizer classes in `sonar-html-plugin/src/main/java/org/sonar/plugins/html/lex/`.
- **[H9]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/lex/PhpEmbeddedHtmlExtractor.java`.
- **[H10]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/core/ErbFileFilter.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/core/HtmlFileExtensions.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/core/InputFileReader.java`.
- **[H11]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/rules/HtmlRulesDefinition.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/rules/CheckClasses.java`.
- **[H12]** Same revision: `sonar-html-plugin/src/main/resources/org/sonar/l10n/web/rules/Web/Sonar_way_profile.json`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/rules/SonarWayProfile.java`.
- **[H13]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/rules/JspQualityProfile.java`.
- **[H14]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/checks/EmbeddedHtmlCheck.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/visitor/HtmlAstScanner.java`; the six cataloged opt-in check classes.
- **[H15]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/lex/VueLexer.java`.
- **[H16]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/visitor/HtmlAstScanner.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/visitor/DefaultNodeVisitor.java`.
- **[H17]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/visitor/HtmlSourceCode.java`.
- **[H18]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/analyzers/PageCountLines.java`.
- **[H19]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/analyzers/ComplexityVisitor.java`.
- **[H20]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/core/HtmlTokensVisitor.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/core/HtmlLexer.java`.
- **[H21]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/visitor/NoSonarScanner.java`.
- **[H22]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/visitor/SonarResolveScanner.java`.
- **[H23]** Same revision: `sonar-html-plugin/src/main/java/org/sonar/plugins/html/checks/AbstractPageCheck.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/checks/HtmlIssue.java`; `sonar-html-plugin/src/main/java/org/sonar/plugins/html/checks/PreciseHtmlIssue.java`.
- **[H24]** Same revision: every annotated class below `sonar-html-plugin/src/main/java/org/sonar/plugins/html/checks/` and matching metadata below `sonar-html-plugin/src/main/resources/org/sonar/l10n/web/rules/Web/`.
