import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
});
