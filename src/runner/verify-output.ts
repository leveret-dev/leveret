import { z } from "zod";

const text = z.string().min(1);
const coverageVerdict = z.enum(["findings", "considered-fine", "not-examined"]);

const lensSchema = z.object({ lens: text, outcome: text }).strict();
const fileCoverageSchema = z.object({
  file: text,
  verdict: coverageVerdict,
  note: text.optional(),
}).strict();

const reportSchema = z.object({
  id: text,
  file: text,
  line: z.number().int().positive(),
  title: text,
  tier: z.enum(["critical", "major", "minor", "nit"]),
  severity: z.enum(["error", "warning", "info"]),
  scope: z.enum(["in-diff", "out-of-diff"]),
  correlation: text.optional(),
  evidence: text,
  suggested_fix: text.optional(),
  evidence_ids: z.array(text),
  extra_real: z.boolean().nullable().optional(),
  beyond_diff: z.boolean().nullable().optional(),
}).strict().superRefine((item, ctx) => {
  if (item.scope === "out-of-diff" && !item.correlation) {
    ctx.addIssue({ code: "custom", path: ["correlation"], message: "out-of-diff reports require correlation" });
  }
});

const verdictSchema = z.object({
  id: text,
  grade: z.enum(["actionable", "priced-noise", "false-positive", "dropped"]),
  reason: text.optional(),
}).strict().superRefine((verdict, ctx) => {
  if (verdict.grade !== "actionable" && !verdict.reason) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: `${verdict.grade} verdicts require a reason` });
  }
});

const resolutionSchema = z.object({
  threadId: text,
  status: z.enum(["resolved", "still-open"]),
  note: text,
}).strict();

const coverageSchema = z.object({
  lenses: z.array(lensSchema),
  files: z.array(fileCoverageSchema),
}).strict();

const verifyOutputSchema = z.object({
  report: z.array(reportSchema),
  verdicts: z.array(verdictSchema),
  coverage: coverageSchema,
  resolutions: z.array(resolutionSchema).optional(),
}).strict();

const reviewOutputSchema = z.looseObject({
  concerns: z.array(z.looseObject({
    id: text,
    file: text,
    lead_ids: z.array(text).optional(),
  })),
  coverage: coverageSchema,
});

export type VerifyOutput = z.infer<typeof verifyOutputSchema>;
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export type FinalVerifyOutput = Omit<VerifyOutput, "coverage"> & {
  coverage: {
    lenses: VerifyOutput["coverage"]["lenses"];
    files: { file: string; verdict: z.infer<typeof coverageVerdict> | "findings-priced"; note?: string }[];
  };
};

export function parseReviewOutput(output: unknown): ReviewOutput {
  return reviewOutputSchema.parse(output);
}

/** Normalize harmless optional-field shapes before strict schema validation. */
export function normalizeVerifyOutput(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const value = output as Record<string, unknown>;
  const report = Array.isArray(value.report) ? value.report.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const normalized = { ...item } as Record<string, unknown>;
    if (normalized.scope === "in-diff") delete normalized.correlation;
    else if (normalized.correlation === "") delete normalized.correlation;
    if (normalized.suggested_fix === "") delete normalized.suggested_fix;
    return normalized;
  }) : value.report;
  const verdicts = Array.isArray(value.verdicts) ? value.verdicts.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const normalized = { ...item } as Record<string, unknown>;
    if (normalized.grade === "actionable" && normalized.reason === "") delete normalized.reason;
    return normalized;
  }) : value.verdicts;
  const coverage = value.coverage && typeof value.coverage === "object" && !Array.isArray(value.coverage)
    ? {
        ...(value.coverage as Record<string, unknown>),
        files: Array.isArray((value.coverage as Record<string, unknown>).files)
          ? ((value.coverage as Record<string, unknown>).files as unknown[]).map((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return item;
              const normalized = { ...item } as Record<string, unknown>;
              if (normalized.note === "") delete normalized.note;
              return normalized;
            })
          : (value.coverage as Record<string, unknown>).files,
      }
    : value.coverage;
  return { ...value, report, verdicts, coverage };
}

/** Account mechanically for changed files omitted by targeted discovery/verification. */
export function completeVerificationCoverage(output: FinalVerifyOutput, changedFiles: string[]): FinalVerifyOutput {
  const files = [...output.coverage.files];
  const present = new Set(files.map((file) => file.file));
  for (const file of changedFiles) {
    if (present.has(file)) continue;
    files.push({ file, verdict: "not-examined", note: "not examined by discovery or targeted verification" });
    present.add(file);
  }
  return { ...output, coverage: { ...output.coverage, files } };
}


export interface VerifyExpectations {
  concerns: { id: string; file: string }[];
  leads: { id: string; file: string }[];
  changedFiles: string[];
  priorThreadIds: string[];
}

const REQUIRED_LENSES = [
  "correctness-hostile-inputs",
  "contract-conformance",
  "test-honesty",
  "blast-radius",
  "leads-triage",
];

function exactIds(gaps: Set<string>, label: string, actual: string[], expected: string[]): void {
  const counts = new Map<string, number>();
  for (const id of actual) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) gaps.add(`${label}:duplicate:${id}`);
  const expectedSet = new Set(expected);
  for (const id of expectedSet) if (!counts.has(id)) gaps.add(`${label}:missing:${id}`);
  for (const id of counts.keys()) if (!expectedSet.has(id)) gaps.add(`${label}:unknown:${id}`);
}

/** Validate the complete verifier contract and deterministic accounting invariants. */
export function verifySchemaGaps(output: unknown, expected: VerifyExpectations): string[] {
  const parsed = verifyOutputSchema.safeParse(output);
  if (!parsed.success) {
    return [...new Set(parsed.error.issues.map((issue) => `schema:${issue.path.join(".") || "output"}`))];
  }

  const gaps = new Set<string>();
  const value = parsed.data;
  exactIds(gaps, "coverage.lenses", value.coverage.lenses.map((lens) => lens.lens), REQUIRED_LENSES);
  exactIds(gaps, "verdicts", value.verdicts.map((verdict) => verdict.id), [
    ...expected.concerns.map((concern) => concern.id),
    ...expected.leads.map((lead) => lead.id),
  ]);

  const actionable = value.verdicts.filter((verdict) => verdict.grade === "actionable").map((verdict) => verdict.id);
  exactIds(gaps, "report", value.report.map((report) => report.id), actionable);

  const coveredFiles = value.coverage.files.map((file) => file.file);
  const requiredFiles = new Set([
    ...expected.changedFiles,
    ...expected.concerns.map((concern) => concern.file),
    ...expected.leads.map((lead) => lead.file),
    ...value.report.map((report) => report.file),
  ]);
  const fileCounts = new Map<string, number>();
  for (const file of coveredFiles) fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
  for (const [file, count] of fileCounts) if (count > 1) gaps.add(`coverage.files:duplicate:${file}`);
  for (const file of requiredFiles) if (!fileCounts.has(file)) gaps.add(`coverage.files:missing:${file}`);

  const coverageByFile = new Map(value.coverage.files.map((file) => [file.file, file.verdict]));
  for (const concern of expected.concerns) {
    const verdict = coverageByFile.get(concern.file);
    if (verdict === "considered-fine" || verdict === "not-examined") gaps.add(`coverage.files:downgraded:${concern.file}`);
  }
  const grades = new Map(value.verdicts.map((verdict) => [verdict.id, verdict.grade]));
  for (const lead of expected.leads) {
    const verdict = coverageByFile.get(lead.file);
    if ((grades.get(lead.id) === "actionable" || grades.get(lead.id) === "priced-noise")
      && (verdict === "considered-fine" || verdict === "not-examined")) {
      gaps.add(`coverage.files:downgraded-lead:${lead.file}:${lead.id}`);
    }
  }
  for (const report of value.report) {
    if (coverageByFile.get(report.file) !== "findings") gaps.add(`coverage.files:report-without-findings:${report.file}`);
  }

  const resolutions = value.resolutions ?? [];
  exactIds(gaps, "resolutions", resolutions.map((resolution) => resolution.threadId), expected.priorThreadIds);
  return [...gaps];
}

/** Preserve review coverage mechanically; verification may disclose more, never less. */
export function mergeVerificationCoverage(reviewInput: unknown, verifyInput: unknown, leads: { id: string; file: string }[] = []): FinalVerifyOutput {
  const review = reviewOutputSchema.parse(reviewInput);
  const verify = verifyOutputSchema.parse(verifyInput);
  const verifyFiles = new Map(verify.coverage.files.map((file) => [file.file, file]));
  const concernIdsByFile = new Map<string, string[]>();
  for (const concern of review.concerns) {
    const ids = concernIdsByFile.get(concern.file) ?? [];
    ids.push(concern.id);
    concernIdsByFile.set(concern.file, ids);
  }
  const leadIdsByFile = new Map<string, string[]>();
  for (const lead of leads) {
    const ids = leadIdsByFile.get(lead.file) ?? [];
    ids.push(lead.id);
    leadIdsByFile.set(lead.file, ids);
  }
  const grades = new Map(verify.verdicts.map((verdict) => [verdict.id, verdict.grade]));
  const reportFiles = new Set(verify.report.map((report) => report.file));
  const orderedFiles = [...review.coverage.files.map((file) => file.file)];
  for (const file of verify.coverage.files) if (!orderedFiles.includes(file.file)) orderedFiles.push(file.file);
  for (const lead of leads) if (!orderedFiles.includes(lead.file)) orderedFiles.push(lead.file);
  const reviewFiles = new Map(review.coverage.files.map((file) => [file.file, file]));

  const files = orderedFiles.map((file) => {
    const reviewed = reviewFiles.get(file);
    const verified = verifyFiles.get(file);
    const concernIds = concernIdsByFile.get(file) ?? [];
    const leadIds = leadIdsByFile.get(file) ?? [];
    if (reportFiles.has(file)) {
      return { file, verdict: "findings" as const, ...(verified?.note ? { note: verified.note } : {}) };
    }
    if (concernIds.length > 0) {
      const allPriced = concernIds.every((id) => grades.get(id) === "priced-noise");
      return allPriced
        ? { file, verdict: "findings-priced" as const, note: verified?.note ?? "all review concerns were priced-noise" }
        : { file, verdict: "findings" as const, ...(verified?.note ? { note: verified.note } : {}) };
    }
    if (leadIds.some((id) => grades.get(id) === "priced-noise")) {
      return { file, verdict: "findings-priced" as const, note: verified?.note ?? "post-walk lead was priced-noise" };
    }
    if (verified?.verdict === "findings") {
      return { file, verdict: "findings" as const, ...(verified?.note ? { note: verified.note } : {}) };
    }
    return reviewed ?? verified!;
  });

  return {
    ...verify,
    coverage: {
      lenses: review.coverage.lenses,
      files,
    },
  };
}
