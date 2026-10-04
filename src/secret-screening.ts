import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One secret-exposure policy for everything Leveret persists or shows: audit records, logs, and the build
 * evidence a reviewer model may read. The built-in shapes below are the ones audit redaction always used;
 * the host adds exact known credential values and regex rules. Nothing here is read from a reviewed
 * checkout or from an imported export, and no matched value is ever returned, logged or thrown.
 */

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
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

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

const patternsOf = (policy: SecretPolicy | undefined): RegExp[] => [...BUILT_IN_RULES, ...(policy?.additionalRules.map((rule) => rule.pattern) ?? [])];

/** Longest first, so a value that contains another known value is replaced whole. */
const valuesOf = (policy: SecretPolicy): string[] =>
  [...policy.knownValues].filter((value) => value.length > 0 && !policy.nonSecretValues.has(value)).sort((a, b) => b.length - a.length);

function detects(text: string, policy: SecretPolicy): boolean {
  if (valuesOf(policy).some((value) => text.includes(value))) return true;
  for (const pattern of patternsOf(policy)) {
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
  let result = text;
  if (policy) for (const value of valuesOf(policy)) result = result.replaceAll(value, REDACTED);
  for (const pattern of patternsOf(policy)) {
    result = result.replace(scanner(pattern), (match) => (policy?.nonSecretValues.has(match) ? match : REDACTED));
  }
  return result;
}
