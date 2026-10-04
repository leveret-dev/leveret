import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:buffer";

/**
 * One secret-exposure policy for everything Leveret persists or shows: audit records, logs, and the build
 * evidence a reviewer model may read. The built-in shapes below are the ones audit redaction always used;
 * the host adds exact known credential values and regex rules. Nothing here is read from a reviewed
 * checkout or from an imported export, and no matched value is ever returned, logged or thrown.
 *
 * Screening is fail-closed. `available` is false until a refresh succeeded and again after one failed, because
 * without the host's current credential list nothing can be called clean: text is withheld and the exposure
 * check is reported unavailable instead of silently passing. Redaction for persistence is best effort and
 * never blocks a write.
 */

/**
 * The longest text, in bytes, that is decoded into one string for screening. A decoded string never has more
 * UTF-16 units than the text has bytes, so the JavaScript engine's own string limit is the one length past
 * which a single string may not exist. This is a technical ceiling, not a client capacity policy: nothing
 * shorter is ever withheld for its size.
 */
export const MAX_SCREENABLE_BYTES = constants.MAX_STRING_LENGTH;

export const REDACTED = "[REDACTED]";

export type SecretPolicy = {
  /** Safe, host-chosen identifier; recorded in summaries instead of any policy content. */
  id: string;
  /** False until a refresh succeeded, and again after one failed: unscreened text is never "clean". */
  available: boolean;
  /** Exact credential values, accumulated for the run: a refresh adds, nothing removes. */
  knownValues: Set<string>;
  refreshKnownValues: () => Promise<readonly string[]>;
  /** Host-pinned rules with stable IDs. A rule never comes from a target or an export. */
  additionalRules: readonly { id: string; pattern: RegExp }[];
  /** Client-declared placeholders (e.g. a keyless local endpoint's literal key), excluded by exact value only. */
  nonSecretValues: ReadonlySet<string>;
};

export type ExposureDecision =
  | { state: "available" }
  | { state: "withheld"; reason: "secret-detected" | "screening-unavailable" };

const BUILT_IN_RULES: readonly RegExp[] = [
  /\bBearer\s+[^\s"']+/gi,
  /(--?(?:api[-_]?key|token|secret|password|authorization)=)[^\s]+/gi,
  /(--?(?:api[-_]?key|token|secret|password|authorization)\s+)[^\s]+/gi,
  /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
];

/**
 * Private key blocks run from the leftmost header to the nearest footer after it. Headers and footers are each
 * found once, left to right: when no footer follows the header at hand none follows any later header either,
 * so the scan is linear in the text however many headers never close. A single lazy pattern would search to
 * the end of the text again for every unterminated header.
 */
function* privateKeyBlocks(text: string): Generator<readonly [start: number, end: number]> {
  const header = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
  const footer = /-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
  for (let from = 0;;) {
    header.lastIndex = from;
    const begin = header.exec(text);
    if (!begin) return;
    footer.lastIndex = begin.index + begin[0].length;
    const end = footer.exec(text);
    if (!end) return;
    from = end.index + end[0].length;
    yield [begin.index, from];
  }
}

/** A match that is exactly a client-declared placeholder is not a secret. */
const redactionOf = (policy: SecretPolicy | undefined) => (match: string): string => (policy?.nonSecretValues.has(match) ? match : REDACTED);

const active = new AsyncLocalStorage<SecretPolicy>();

// A supplied pattern may be global, sticky or carry a stale lastIndex. Matching always uses a private global
// copy whose position is reset before every use, so repeated checks cannot skip a match.
const scanners = new WeakMap<RegExp, RegExp>();
function scanner(pattern: RegExp): RegExp {
  let copy = scanners.get(pattern);
  if (!copy) {
    copy = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}g`);
    scanners.set(pattern, copy);
  }
  copy.lastIndex = 0;
  return copy;
}

const hostRules = (policy: SecretPolicy | undefined): RegExp[] => policy?.additionalRules.map((rule) => rule.pattern) ?? [];

/** Longest first, so a value that contains another known value is replaced whole. */
const valuesOf = (policy: SecretPolicy): string[] =>
  [...policy.knownValues].filter((value) => value.length > 0 && !policy.nonSecretValues.has(value)).sort((a, b) => b.length - a.length);

function detects(text: string, policy: SecretPolicy): boolean {
  if (valuesOf(policy).some((value) => text.includes(value))) return true;
  for (const pattern of BUILT_IN_RULES) {
    for (const match of text.matchAll(scanner(pattern))) if (!policy.nonSecretValues.has(match[0])) return true;
  }
  for (const [start, end] of privateKeyBlocks(text)) if (!policy.nonSecretValues.has(text.slice(start, end))) return true;
  for (const pattern of hostRules(policy)) {
    for (const match of text.matchAll(scanner(pattern))) if (!policy.nonSecretValues.has(match[0])) return true;
  }
  return false;
}

/**
 * Adds the host's current credential values. A failed refresh leaves the policy unavailable and surfaces
 * nothing about why: the thrown error may itself carry a credential.
 */
export async function refreshSecretPolicy(policy: SecretPolicy): Promise<void> {
  try {
    for (const value of await policy.refreshKnownValues()) policy.knownValues.add(value);
    policy.available = true;
  } catch {
    policy.available = false;
  }
}

export function screenText(text: string, policy: SecretPolicy): ExposureDecision {
  if (!policy.available) return { state: "withheld", reason: "screening-unavailable" };
  return detects(text, policy) ? { state: "withheld", reason: "secret-detected" } : { state: "available" };
}

/** Makes `policy` the active one for everything `run` awaits, so raw audit and log sanitization can use it. */
export function withSecretPolicy<T>(policy: SecretPolicy, run: () => Promise<T>): Promise<T> {
  return active.run(policy, run);
}

/**
 * Removes every built-in credential shape, and inside a policy scope every known value and host rule match.
 * Persistence is best effort by design: it redacts whatever is known now and never fails or blocks a write.
 */
export function redactAuditText(text: string): string {
  const policy = active.getStore();
  const replacement = redactionOf(policy);
  let result = text;
  if (policy) for (const value of valuesOf(policy)) result = result.replaceAll(value, REDACTED);
  for (const pattern of BUILT_IN_RULES) result = result.replace(scanner(pattern), replacement);
  let rebuilt = "";
  let copied = 0;
  for (const [start, end] of privateKeyBlocks(result)) {
    rebuilt += result.slice(copied, start) + replacement(result.slice(start, end));
    copied = end;
  }
  if (copied > 0) result = rebuilt + result.slice(copied);
  for (const pattern of hostRules(policy)) result = result.replace(scanner(pattern), replacement);
  return result;
}
