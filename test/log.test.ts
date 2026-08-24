import { describe, expect, it } from "vitest";
import { formatLine, makeLogger } from "../src/app/log.js";

// Cloud-ready logging: one JSON object per line, every line carrying the run's
// UUID — and in app mode the PR URL — so any aggregator can slice by run.

describe("formatLine", () => {
  it("emits parseable JSON with ts, level, msg, and the bound fields", () => {
    const line = formatLine("info", "cloning", { runId: "r-1", prUrl: "https://github.com/o/r/pull/7" });
    const d = JSON.parse(line);
    expect(d).toMatchObject({ level: "info", msg: "cloning", runId: "r-1", prUrl: "https://github.com/o/r/pull/7" });
    expect(typeof d.ts).toBe("string");
    expect(Date.parse(d.ts)).not.toBeNaN();
  });

  it("merges per-call extras and keeps errors as strings", () => {
    const d = JSON.parse(formatLine("error", "job failed", { runId: "r-2" }, { err: new Error("boom") }));
    expect(d.err).toContain("boom");
    expect(d.runId).toBe("r-2");
  });

  it("redacts authorization material before operational stdout", () => {
    const line = formatLine("error", "job failed", { runId: "r" }, { err: new Error("Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz") });
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});

describe("makeLogger", () => {
  it("binds fields once; every level carries them", () => {
    const out: string[] = [];
    const log = makeLogger({ runId: "r-3", prUrl: "u" }, (l) => out.push(l));
    log.info("a");
    log.warn("b", { detail: "d" });
    log.error("c");
    expect(out).toHaveLength(3);
    for (const l of out) expect(JSON.parse(l).runId).toBe("r-3");
    expect(JSON.parse(out[1]!).detail).toBe("d");
    expect(JSON.parse(out[2]!).level).toBe("error");
  });
});

describe("crash report carries the run UUID", () => {
  it("failMessage names the run so a PR comment correlates to the logs", async () => {
    const { failMessage } = await import("../src/app/render.js");
    const msg = failMessage(new Error("boom"), "0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(msg).toContain("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(msg).toContain("boom");
  });
});
