import { z } from "zod";
import type { ChangeManifest } from "./change-evidence.js";

const position = z.object({ line: z.number().int().positive(), column: z.number().int().nonnegative() }).strict();
const range = z.object({ start: position, end: position }).strict();
const location = z.object({ path: z.string().min(1), range }).strict();
const method = z.object({ id: z.string().min(1), signature: z.string(), location, nameRange: range, sourceSet: z.enum(["main", "test"]) }).strict();
const reference = z.object({
  id: z.string().min(1), targetId: z.string().min(1), location, enclosing: method.nullable(),
  sourceSet: z.enum(["main", "test"]), kind: z.enum(["call", "method-reference"]), basis: z.literal("checked"),
}).strict();
const unresolved = z.object({
  id: z.string().min(1), location, sourceSet: z.enum(["main", "test"]), reason: z.string().min(1),
  candidates: z.array(z.object({ targetId: z.string().min(1), basis: z.string().min(1) }).strict()).nullable(),
}).strict();
const file = z.object({ path: z.string(), sourceSet: z.enum(["main", "test"]), examined: z.boolean(), reason: z.string().nullable() }).strict();
const coverage = z.object({
  complete: z.boolean(), mainExamined: z.number().int().nonnegative(), testExamined: z.number().int().nonnegative(),
  mainSkipped: z.number().int().nonnegative(), testSkipped: z.number().int().nonnegative(),
  mainUnresolved: z.number().int().nonnegative(), testUnresolved: z.number().int().nonnegative(), diagnosticCount: z.number().int().nonnegative(),
}).strict();
export const analysisSummarySchema = z.object({
  analysisId: z.string().min(1), repositoryId: z.string().min(1), revision: z.string().min(1),
  configurationSha256: z.string().min(1), coverage,
}).strict();
const detail = z.object({
  kind: z.enum(["reference", "unresolved", "file", "diagnostic"]),
  reference: reference.nullable(), unresolved: unresolved.nullable(), file: file.nullable(), diagnostic: z.string().nullable(),
}).strict().superRefine((item, ctx) => {
  const active = { reference: item.reference, unresolved: item.unresolved, file: item.file, diagnostic: item.diagnostic };
  if (Object.entries(active).filter(([, value]) => value !== null).length !== 1 || active[item.kind] === null) {
    ctx.addIssue({ code: "custom", message: "Detail record tag does not match its payload" });
  }
});
export const referencePageSchema = z.object({
  summary: analysisSummarySchema, target: method, side: z.enum(["base", "head"]), items: z.array(detail),
  delivery: z.object({ complete: z.boolean(), truncated: z.boolean(), omittedRecords: z.number().int().nonnegative(), nextCursor: z.string().nullable() }).strict(),
}).strict();
export const inspectErrorSchema = z.object({
  code: z.enum(["invalid-input", "snapshot-mismatch", "configuration-mismatch", "target-missing", "target-indeterminate",
    "analysis-unavailable", "invalid-cursor", "worker-failed", "resource-exhausted", "budget-too-small"]),
  message: z.string().min(1), requiredBytes: z.number().int().positive().optional(),
}).strict();
export const referenceReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: referencePageSchema }).strict(),
  z.object({ ok: z.literal(false), error: inspectErrorSchema }).strict(),
]);
export type AnalysisSummary = z.infer<typeof analysisSummarySchema>;
export type ReferencePage = z.infer<typeof referencePageSchema>;
export type InspectError = z.infer<typeof inspectErrorSchema>;
export type ReferenceRequest = {
  analysisId: string;
  configurationSha256: string;
  manifest: ChangeManifest;
  side: "base" | "head";
  target: { path: string; position: z.infer<typeof position> };
  byteBudget?: number;
  cursor?: string;
};
