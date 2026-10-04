import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BuildArtifact, BuildTransformation } from "./build-evidence-contract.js";
import type { BuildEvidenceAdmission } from "./build-evidence.js";
import { refreshSecretPolicy, screenText, type SecretPolicy } from "./secret-screening.js";

export type BuildArtifactReadRequest = {
  manifestSha256: string;
  artifactId: string;
  range: { startLine: number; endLine: number } | null;
  byteBudget: number;
  cursor?: string;
};

export type BuildArtifactReadErrorCode =
  | "invalid-input" | "snapshot-mismatch" | "artifact-unavailable" | "unsupported-artifact"
  | "unsupported-encoding" | "secret-detected" | "screening-unavailable" | "invalid-cursor" | "budget-too-small";
export type BuildArtifactReadError = { code: BuildArtifactReadErrorCode; message: string; requiredBytes?: number };
export type BuildArtifactLineage = {
  transformationId: string;
  kind: BuildTransformation["kind"];
  basis: BuildTransformation["basis"];
  direction: "input" | "output";
  relatedArtifactIds: readonly string[];
};
export type BuildArtifactReadResult = {
  citation: { manifestSha256: string; artifactId: string; range: { startLine: number; endLine: number } };
  origin: BuildArtifact["origin"];
  repositoryPath: string | null;
  text: string;
  range: { startLine: number; endLine: number };
  lineage: readonly BuildArtifactLineage[];
  delivery: { complete: boolean; truncated: boolean; nextCursor: string | null };
};
export type BuildArtifactReadReply =
  | { ok: true; result: BuildArtifactReadResult }
  | { ok: false; error: BuildArtifactReadError };

const TEXT_ROLES: Readonly<Record<BuildArtifact["role"], boolean>> = {
  source: true, resource: true, template: true, schema: true, "build-config": true, report: true,
  classes: false, dependency: false,
};
const MAX_BUDGET = 262_144;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function failure(code: BuildArtifactReadErrorCode, message: string, requiredBytes?: number): BuildArtifactReadReply {
  return { ok: false, error: requiredBytes === undefined ? { code, message } : { code, message, requiredBytes } };
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function cursorKey(
  admission: Extract<BuildEvidenceAdmission, { outcome: "admitted" }>, artifact: Extract<BuildArtifact, { availability: "available"; kind: "file" }>,
  request: BuildArtifactReadRequest, policy: SecretPolicy,
): string {
  return digest(JSON.stringify({
    schema: 1, manifestSha256: admission.manifestSha256, artifactId: artifact.id, artifactSha256: artifact.content.sha256,
    range: request.range, policyId: policy.id,
  }));
}

function encodeCursor(key: string, line: number): string {
  return Buffer.from(JSON.stringify({ schema: 1, key, line }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, key: string): number | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!("schema" in parsed) || parsed.schema !== 1 || !("key" in parsed) || parsed.key !== key || !("line" in parsed)) return null;
    return validInteger(parsed.line, 1) ? parsed.line : null;
  } catch {
    return null;
  }
}

function lineage(admission: Extract<BuildEvidenceAdmission, { outcome: "admitted" }>, artifactId: string): BuildArtifactLineage[] {
  const result: BuildArtifactLineage[] = [];
  for (const transformation of admission.manifest.transformations) {
    if (transformation.inputArtifactIds.includes(artifactId)) {
      result.push({ transformationId: transformation.id, kind: transformation.kind, basis: transformation.basis,
        direction: "input", relatedArtifactIds: [...transformation.outputArtifactIds] });
    }
    if (transformation.outputArtifactIds.includes(artifactId)) {
      result.push({ transformationId: transformation.id, kind: transformation.kind, basis: transformation.basis,
        direction: "output", relatedArtifactIds: [...transformation.inputArtifactIds] });
    }
  }
  return result;
}

function linesOf(text: string): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g);
  return lines && lines.length > 0 ? lines : [""];
}

function responseBytes(result: BuildArtifactReadResult): number {
  return Buffer.byteLength(JSON.stringify({ ok: true, result }), "utf8");
}

/** Reads only frozen, screened text bytes from one admitted manifest; paths never come from the caller. */
export async function readBuildArtifact(
  admission: BuildEvidenceAdmission, request: BuildArtifactReadRequest, policy: SecretPolicy,
): Promise<BuildArtifactReadReply> {
  if (!request || typeof request !== "object" || typeof request.manifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(request.manifestSha256) || typeof request.artifactId !== "string" || request.artifactId.length === 0 ||
    !validInteger(request.byteBudget, 1) || request.byteBudget > MAX_BUDGET ||
    (request.range !== null && (!request.range || typeof request.range !== "object" ||
      !validInteger(request.range.startLine, 1) || !validInteger(request.range.endLine, 1) || request.range.startLine > request.range.endLine)) ||
    (request.cursor !== undefined && typeof request.cursor !== "string")) {
    return failure("invalid-input", "Invalid build artifact read request");
  }
  if (admission.outcome !== "admitted") return failure("artifact-unavailable", "Build evidence is not admitted for this side");
  if (request.manifestSha256 !== admission.manifestSha256) return failure("snapshot-mismatch", "Build artifact manifest differs from the admitted snapshot");
  const manifestArtifact = admission.manifest.artifacts.find((item) => item.id === request.artifactId);
  const status = admission.artifacts.get(request.artifactId);
  if (!manifestArtifact || !status || status.state !== "available") return failure("artifact-unavailable", "Build artifact is unavailable");
  if (manifestArtifact.availability !== "available" || manifestArtifact.kind !== "file" || !TEXT_ROLES[manifestArtifact.role]) {
    return failure("unsupported-artifact", "Build artifact is not supported text evidence");
  }
  if (!manifestArtifact.encoding || !/^utf-?8$/i.test(manifestArtifact.encoding)) {
    return failure("unsupported-encoding", "Build artifact encoding is not supported");
  }
  const frozen = admission.frozen.available.get(request.artifactId);
  if (!frozen) return failure("artifact-unavailable", "Build artifact is unavailable");
  let bytes: Buffer;
  try {
    bytes = await readFile(frozen.path);
  } catch {
    return failure("artifact-unavailable", "Frozen build artifact could not be read");
  }
  if (bytes.length !== manifestArtifact.content.sizeBytes || digest(bytes) !== manifestArtifact.content.sha256) {
    return failure("snapshot-mismatch", "Frozen build artifact changed after admission");
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return failure("unsupported-encoding", "Build artifact is not valid UTF-8");
  }
  await refreshSecretPolicy(policy);
  const exposure = screenText(text, policy);
  if (exposure.state === "withheld") return failure(exposure.reason, "Build artifact is withheld by the secret policy");

  const lines = linesOf(text);
  const requestedStart = request.range?.startLine ?? 1;
  const requestedEnd = Math.min(request.range?.endLine ?? lines.length, lines.length);
  if (requestedStart > lines.length) return failure("invalid-input", "Requested line range is outside the build artifact");
  const key = cursorKey(admission, manifestArtifact, request, policy);
  const start = request.cursor === undefined ? requestedStart : decodeCursor(request.cursor, key);
  if (start === null || start < requestedStart || start > requestedEnd) return failure("invalid-cursor", "Build artifact cursor does not match this read");
  const provenance = lineage(admission, manifestArtifact.id);
  const build = (end: number, chunk: string, complete: boolean): BuildArtifactReadResult => ({
    citation: { manifestSha256: admission.manifestSha256, artifactId: manifestArtifact.id, range: { startLine: start, endLine: end } },
    origin: manifestArtifact.origin, repositoryPath: manifestArtifact.repositoryPath, text: chunk,
    range: { startLine: start, endLine: end }, lineage: provenance,
    delivery: { complete, truncated: !complete, nextCursor: complete ? null : encodeCursor(key, end + 1) },
  });
  const empty = build(start - 1, "", false);
  const headerBytes = responseBytes(empty);
  if (headerBytes > request.byteBudget) return failure("budget-too-small", "Build artifact response header exceeds byte budget", headerBytes);

  let chunk = "";
  let end = start - 1;
  for (let line = start; line <= requestedEnd; line++) {
    const candidateText = chunk + lines[line - 1]!;
    const complete = line === requestedEnd;
    const candidate = build(line, candidateText, complete);
    const required = responseBytes(candidate);
    if (required > request.byteBudget) {
      if (end < start) return failure("budget-too-small", "Next build artifact line exceeds byte budget", required);
      break;
    }
    chunk = candidateText;
    end = line;
  }
  return { ok: true, result: build(end, chunk, end === requestedEnd) };
}
