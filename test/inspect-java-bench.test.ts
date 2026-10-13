import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { traceConsumption } from "../bench/inspect-java.mjs";

const at = (line: number, start: number, end: number) => ({ start: { line, column: start }, end: { line, column: end } });
const caller = "src/test/java/example/PricingTest.java";

function reply(options: { complete: boolean; side?: "base" | "head"; targetBindingKey?: string }) {
  const bindingKey = options.targetBindingKey ?? "Lexample/Pricing;.price(I)I";
  const targetId = `13:shared-module:${bindingKey}`;
  const location = { path: caller, range: at(3, 27, 43), buildArtifact: null };
  return { ok: true, result: {
    summary: { analysisId: "a", repositoryId: "r", revision: "h", configurationSha256: "c", coverage: {
      complete: options.complete, mainExamined: 1, testExamined: 1, mainSkipped: 0, testSkipped: 0,
      mainUnresolved: 0, testUnresolved: options.complete ? 0 : 2, diagnosticCount: options.complete ? 0 : 1 } },
    target: { id: targetId, bindingKey, signature: "example.Pricing.price(int)",
      location: { path: "src/main/java/example/Pricing.java", range: at(3, 4, 60), buildArtifact: null },
      nameRange: at(3, 15, 20), sourceSet: "main" },
    side: options.side ?? "head",
    referenceScope: "outside-diff",
    items: [
      { kind: "reference", unresolved: null, file: null, diagnostic: null, reference: {
        id: "ref", targetId, location, enclosing: null, sourceSet: "test", kind: "call", basis: "checked",
        diffStatus: "outside-diff" } },
      ...options.complete ? [] : [{ kind: "unresolved", reference: null, file: null, diagnostic: null, unresolved: {
        id: "gap", location: { path: caller, range: at(5, 30, 60), buildArtifact: null },
        sourceSet: "test", reason: "missing-type", candidates: null } }],
    ],
    delivery: { complete: true, truncated: false, omittedRecords: 0, nextCursor: null },
  } };
}

/** Writes a real-shaped audit trace: one Java reference call, then the given submitted phase payload and its outcome. */
function trace(dir: string, result: ReturnType<typeof reply>, submitted: unknown, side = result.result.side, submitTool = "leveret_submit_phase", accepted = true) {
  const events = [
    { sequence: 1, category: "tools", event: "execution_start", tool_call_id: "call_java", payload: { tool: "leveret_java_references", args: { side } } },
    { sequence: 2, category: "tools", event: "execution_end", tool_call_id: "call_java", payload: { tool: "leveret_java_references",
      result: { content: [{ type: "text", text: "evidence_id: call_java" }, { type: "text", text: JSON.stringify(result) }] } } },
    { sequence: 3, category: "assistant", event: "message_end", payload: { thinking: `call_java ${caller} unresolved` } },
    { sequence: 4, category: "tools", event: "execution_start", tool_call_id: "call_submit", payload: { tool: submitTool, args: submitted } },
    { sequence: 5, category: "tools", event: "execution_end", tool_call_id: "call_submit", payload: { tool: submitTool, is_error: !accepted,
      result: { content: [{ type: "text", text: accepted ? "Phase result accepted." : "Validation failed" }] } } },
  ];
  writeFileSync(join(dir, "runner.ndjson"), events.map((event) => JSON.stringify(event)).join("\n"));
  return dir;
}

describe("Inspect Java evaluation", () => {
  it("refuses review mode before creating output without separate model approval", () => {
    const home = mkdtempSync(join(tmpdir(), "leveret-java-approval-"));
    const output = join(home, "review-output");
    try {
      let result: { stdout: string; status: number } | undefined;
      try {
        execFileSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
          "bench/inspect-java.mts", "--mode", "review", "--config", join(home, "missing.json"),
          "--config-sha256", "0".repeat(64), "--output", output,
        ], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, LEVERET_PAID_MODEL_APPROVED: "" } });
      } catch (error) {
        const failure = error as Error & { stdout: string; status: number };
        result = { stdout: failure.stdout, status: failure.status };
      }
      expect(result?.status).not.toBe(0);
      expect(JSON.parse(result?.stdout ?? "null")).toMatchObject({ ok: false, error: { code: "approval-required" } });
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts only a submitted record that cites the returned evidence with its caller and gap", async () => {
    const home = mkdtempSync(join(tmpdir(), "leveret-java-trace-"));
    const finding = (hint: string) => ({ findings: [{ evidence_ids: ["call_java"], evidence_hint: hint }] });
    const verdict = (result: ReturnType<typeof reply>, submitted: unknown, incomplete: boolean, side?: "base" | "head") =>
      traceConsumption(trace(home, result, submitted, side), ["call_java"], incomplete);
    try {
      expect(await verdict(reply({ complete: true }), finding(`sole checked caller ${caller}:3`), false))
        .toEqual({ evidenceReturned: true, subsequentUse: true, disclosedGap: true });
      expect(await verdict(reply({ complete: false }), finding(`${caller}: diagnostic + 2 unresolved`), true))
        .toEqual({ evidenceReturned: true, subsequentUse: true, disclosedGap: true });
      // Thinking-only citation is not use, nor is a submitted citation that omits the caller file.
      expect((await verdict(reply({ complete: true }), { findings: [] }, false)).subsequentUse).toBe(false);
      expect((await verdict(reply({ complete: true }), finding("checked caller exists"), false)).subsequentUse).toBe(false);
      // Arguments to other tools are not submitted output.
      expect((await traceConsumption(trace(home, reply({ complete: true }), finding(caller), "head", "leveret_read"), ["call_java"], false))
        .subsequentUse).toBe(false);
      // Gap wording in a neighbouring record does not count as disclosure for this call.
      expect(await verdict(reply({ complete: false }), { findings: [
        { evidence_ids: ["call_java"], evidence_hint: `checked caller ${caller}` },
        { evidence_ids: ["call_other"], evidence_hint: "2 unresolved" },
      ] }, true)).toMatchObject({ subsequentUse: true, disclosedGap: false });
      // Base-side calls, other targets, and complete coverage in the missing variant are not the expected evidence.
      expect((await verdict(reply({ complete: true }), finding(caller), false, "base")).evidenceReturned).toBe(false);
      expect((await verdict(reply({ complete: true, targetBindingKey: "Lexample/Pricing;.price(Ljava/lang/String;)I" }),
        finding(caller), false)).evidenceReturned).toBe(false);
      expect((await verdict(reply({ complete: true }), finding(`${caller} unresolved`), true)).evidenceReturned).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("counts only an accepted submission and refuses audit payloads that fail their checksum", async () => {
    const home = mkdtempSync(join(tmpdir(), "leveret-java-submit-"));
    const finding = { findings: [{ evidence_ids: ["call_java"], evidence_hint: `sole checked caller ${caller}:3` }] };
    try {
      // A validation-rejected submit call is not a submitted record.
      expect(await traceConsumption(trace(home, reply({ complete: true }), finding, "head", "leveret_submit_phase", false), ["call_java"], false))
        .toEqual({ evidenceReturned: true, subsequentUse: false, disclosedGap: true });
      const dir = trace(home, reply({ complete: true }), finding);
      const events = readFileSync(join(dir, "runner.ndjson"), "utf8").split("\n").map((line) => JSON.parse(line));
      const body = events[1].payload;
      const sha = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      mkdirSync(join(dir, "blobs/sha256"), { recursive: true });
      events[1] = { ...events[1], payload: undefined, payload_ref: { sha256: sha, bytes: 1, media_type: "application/json", encoding: "json" } };
      writeFileSync(join(dir, "runner.ndjson"), events.map((event) => JSON.stringify(event)).join("\n"));
      writeFileSync(join(dir, "blobs/sha256", sha), JSON.stringify(body));
      expect(await traceConsumption(dir, ["call_java"], false)).toEqual({ evidenceReturned: true, subsequentUse: true, disclosedGap: true });
      writeFileSync(join(dir, "blobs/sha256", sha), JSON.stringify({ ...body, tampered: true }));
      await expect(traceConsumption(dir, ["call_java"], false)).rejects.toThrow(/checksum/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
