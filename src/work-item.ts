import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const WORK_ITEM_SCHEMA = "leveret.work-item/v1";
export const WORK_ITEM_FILE_MAX_BYTES = 128 * 1024;

const availability = z.enum(["present", "missing", "truncated"]);
const provenance = z.object({
  source: z.enum(["github-webhook", "historical-replay"]),
  path: z.string().min(1).max(200),
}).strict();
const common = {
  provenance,
  trust: z.literal("untrusted-evidence"),
};
const textEvidence = z.object({
  value: z.string().nullable(),
  availability,
  original_bytes: z.number().int().nonnegative(),
  presented_bytes: z.number().int().nonnegative(),
  ...common,
}).strict().superRefine((field, context) => {
  if ((field.value === null) !== (field.availability === "missing")) {
    context.addIssue({ code: "custom", message: "missing text evidence must have a null value" });
  }
  if (field.presented_bytes > field.original_bytes) {
    context.addIssue({ code: "custom", message: "presented bytes exceed original bytes" });
  }
  if ((field.availability === "truncated") !== (field.presented_bytes < field.original_bytes)) {
    context.addIssue({ code: "custom", message: "text truncation state does not match byte counts" });
  }
});
const numberEvidence = z.object({
  value: z.number().int().nonnegative().nullable(),
  availability: z.enum(["present", "missing"]),
  ...common,
}).strict().superRefine((field, context) => {
  if ((field.value === null) !== (field.availability === "missing")) {
    context.addIssue({ code: "custom", message: "missing numeric evidence must have a null value" });
  }
});

export const workItemSchema = z.object({
  schema: z.literal(WORK_ITEM_SCHEMA),
  kind: z.literal("pull-request"),
  captured_at: z.iso.datetime({ offset: true }),
  fields: z.object({
    event: textEvidence,
    delivery_id: textEvidence,
    installation_id: numberEvidence,
    repository: textEvidence,
    number: numberEvidence,
    action: textEvidence,
    title: textEvidence,
    body: textEvidence,
    author_login: textEvidence,
    base_ref: textEvidence,
    base_sha: textEvidence,
    head_sha: textEvidence,
  }).strict(),
}).strict();

export type WorkItem = z.infer<typeof workItemSchema>;
type WorkItemSource = WorkItem["fields"]["event"]["provenance"]["source"];

export interface PullRequestWorkItemInput {
  event: string;
  deliveryId?: string;
  installationId?: number;
  repository: string;
  number: number;
  action: string;
  title?: string | null;
  body?: string | null;
  authorLogin?: string | null;
  baseRef: string;
  baseSha: string;
  headSha: string;
}

const TEXT_LIMITS = {
  event: 64,
  delivery_id: 256,
  repository: 512,
  action: 64,
  title: 4 * 1024,
  body: 64 * 1024,
  author_login: 256,
  base_ref: 1024,
  base_sha: 128,
  head_sha: 128,
} as const;

function boundedText(value: string | null | undefined, maxBytes: number, source: WorkItemSource, path: string) {
  if (value === null || value === undefined) {
    return { value: null, availability: "missing" as const, original_bytes: 0, presented_bytes: 0, provenance: { source, path }, trust: "untrusted-evidence" as const };
  }
  const original = Buffer.from(value);
  const text = original.length > maxBytes
    ? new TextDecoder().decode(original.subarray(0, maxBytes), { stream: true })
    : value;
  const presentedBytes = Buffer.byteLength(text);
  return {
    value: text,
    availability: original.length > maxBytes ? "truncated" as const : "present" as const,
    original_bytes: original.length,
    presented_bytes: presentedBytes,
    provenance: { source, path },
    trust: "untrusted-evidence" as const,
  };
}

function boundedNumber(value: number | null | undefined, source: WorkItemSource, path: string) {
  return {
    value: value ?? null,
    availability: value === null || value === undefined ? "missing" as const : "present" as const,
    provenance: { source, path },
    trust: "untrusted-evidence" as const,
  };
}

export function createPullRequestWorkItem(
  input: PullRequestWorkItemInput,
  source: WorkItemSource = "github-webhook",
  capturedAt = new Date().toISOString(),
): WorkItem {
  return workItemSchema.parse({
    schema: WORK_ITEM_SCHEMA,
    kind: "pull-request",
    captured_at: capturedAt,
    fields: {
      event: boundedText(input.event, TEXT_LIMITS.event, source, "event"),
      delivery_id: boundedText(input.deliveryId, TEXT_LIMITS.delivery_id, source, "delivery_id"),
      installation_id: boundedNumber(input.installationId, source, "installation.id"),
      repository: boundedText(input.repository, TEXT_LIMITS.repository, source, "repository.full_name"),
      number: boundedNumber(input.number, source, "pull_request.number"),
      action: boundedText(input.action, TEXT_LIMITS.action, source, "action"),
      title: boundedText(input.title, TEXT_LIMITS.title, source, "pull_request.title"),
      body: boundedText(input.body, TEXT_LIMITS.body, source, "pull_request.body"),
      author_login: boundedText(input.authorLogin, TEXT_LIMITS.author_login, source, "pull_request.user.login"),
      base_ref: boundedText(input.baseRef, TEXT_LIMITS.base_ref, source, "pull_request.base.ref"),
      base_sha: boundedText(input.baseSha, TEXT_LIMITS.base_sha, source, "pull_request.base.sha"),
      head_sha: boundedText(input.headSha, TEXT_LIMITS.head_sha, source, "pull_request.head.sha"),
    },
  });
}

export function parseWorkItem(value: string): WorkItem {
  return workItemSchema.parse(JSON.parse(value));
}

export async function writeWorkItem(directory: string, workItem: WorkItem): Promise<{ path: string; sha256: string; bytes: number }> {
  const content = `${JSON.stringify(workItem, null, 2)}\n`;
  const bytes = Buffer.byteLength(content);
  if (bytes > WORK_ITEM_FILE_MAX_BYTES) throw new Error("work-item file exceeds its byte limit");
  const path = join(directory, "work-item.json");
  await writeFile(path, content, { mode: 0o600 });
  return { path, sha256: createHash("sha256").update(content).digest("hex"), bytes };
}

export async function readWorkItem(path: string): Promise<{ workItem: WorkItem; sha256: string; bytes: number }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("LEVERET_WORK_ITEM must name a regular file");
  if (info.size > WORK_ITEM_FILE_MAX_BYTES) throw new Error("LEVERET_WORK_ITEM exceeds its byte limit");
  const content = await readFile(path, "utf8");
  return {
    workItem: parseWorkItem(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
  };
}
