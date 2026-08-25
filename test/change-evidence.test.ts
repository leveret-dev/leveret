import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_PATCH_RESPONSE_BYTES,
  materializeChangeEvidence,
  openChangeEvidence,
  type ChangeEvidence,
  type PatchEvidenceRequest,
} from "../src/change-evidence.js";
import { scan } from "../src/scan.js";

const root = mkdtempSync(join(tmpdir(), "leveret-change-evidence-"));
const repo = join(root, "repo");
const manifestPath = join(root, "change-evidence.v1.json");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Leveret Test",
  GIT_AUTHOR_EMAIL: "leveret@example.invalid",
  GIT_COMMITTER_NAME: "Leveret Test",
  GIT_COMMITTER_EMAIL: "leveret@example.invalid",
};
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
let evidence: ChangeEvidence;

beforeAll(async () => {
  mkdirSync(repo);
  git(["init", "-b", "main"]);
  writeFileSync(join(repo, "rename old.txt"), "rename me\n");
  writeFileSync(join(repo, "delete me.txt"), "delete me\n");
  writeFileSync(join(repo, "copy-source.txt"), "copy source\n".repeat(20));
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(repo, "multi.txt"), Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  git(["add", "--", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);

  git(["mv", "--", "rename old.txt", "renamed\t雪.txt"]);
  unlinkSync(join(repo, "delete me.txt"));
  writeFileSync(join(repo, "copied.txt"), readFileSync(join(repo, "copy-source.txt")));
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 9, 8, 7]));
  writeFileSync(join(repo, "space name.txt"), "space\n");
  writeFileSync(join(repo, "quote\"name.txt"), "quote\n");
  writeFileSync(join(repo, "unicodé.txt"), "unicode\n");
  writeFileSync(join(repo, "-leading.txt"), "dash\n");
  writeFileSync(join(repo, "tab\tname.txt"), "tab\n");
  writeFileSync(join(repo, "fail.txt"), "unique missing object contents\n");
  writeFileSync(join(repo, "large.txt"), `${"x".repeat(1024 * 1024 + 64 * 1024)}\n`);
  const multi = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
  multi[9] = "changed ten";
  multi[89] = "changed ninety";
  writeFileSync(join(repo, "multi.txt"), `${multi.join("\n")}\n`);
  git(["add", "-A", "--", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "head"]);
  evidence = await materializeChangeEvidence(repo, base, manifestPath);
}, 30_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("change evidence", () => {
  it("builds one NUL-safe manifest with hostile paths, statuses, counts, types, and hunks", async () => {
    const byPath = new Map(evidence.manifest.files.map((file) => [file.path, file]));
    for (const path of ["space name.txt", "quote\"name.txt", "unicodé.txt", "-leading.txt", "tab\tname.txt", "renamed\t雪.txt"]) {
      expect(byPath.has(path)).toBe(true);
    }
    expect(byPath.get("renamed\t雪.txt")).toMatchObject({ status: "rename", oldPath: "rename old.txt", newPath: "renamed\t雪.txt" });
    expect(byPath.get("copied.txt")?.status).toBe("copy");
    expect(byPath.get("delete me.txt")).toMatchObject({ status: "delete", new: { exists: false, type: "missing" } });
    expect(byPath.get("binary.bin")).toMatchObject({ binary: true, lines: { added: null, deleted: null }, new: { type: "binary", bytes: 4 } });
    expect(byPath.get("multi.txt")?.hunks).toHaveLength(2);
    const compact = await evidence.retrieve({ kind: "manifest" });
    expect(compact.kind).toBe("manifest");
    expect(compact.modelBytes).toBe(Buffer.byteLength(JSON.stringify(evidence.manifest)));
    expect(compact.omitted).toEqual([]);
    expect((await scan({ repo, base: evidence.manifest.base, manifest: evidence.manifest, engines: [] })).findings).toEqual([]);
  });

  it("returns only requested hunks with stable byte-bounded cursor pages and named omissions", async () => {
    const request: PatchEvidenceRequest = { kind: "patch", paths: ["multi.txt"], context: 0, hunk: 2, byteBudget: 64 };
    const first = await evidence.retrieve(request);
    const repeated = await evidence.retrieve(request);
    expect(first).toEqual(repeated);
    expect(first.kind).toBe("patch");
    if (first.kind !== "patch") throw new Error("expected patch evidence");
    expect(first.modelBytes).toBe(first.returned.reduce((bytes, item) => bytes + Buffer.byteLength(item.patch), 0));
    expect(first.modelBytes).toBeLessThanOrEqual(64);
    expect(first.nextCursor).not.toBeNull();
    expect(first.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ path: "multi.txt", hunks: [2], reason: expect.stringContaining("byte budget") })]));
    const second = await evidence.retrieve({ ...request, cursor: first.nextCursor! });
    expect(second.kind).toBe("patch");
    if (second.kind !== "patch") throw new Error("expected patch evidence");
    expect(second.returned[0]?.byteStart).toBeGreaterThan(0);
    await expect(evidence.retrieve({ ...request, paths: ["space name.txt"], cursor: first.nextCursor! })).rejects.toThrow(/cursor/);
  });

  it("cannot return a synthetic one-megabyte patch or accept an oversized budget in one model response", async () => {
    const page = await evidence.retrieve({ kind: "patch", paths: ["large.txt"], byteBudget: MAX_PATCH_RESPONSE_BYTES });
    expect(page.kind).toBe("patch");
    if (page.kind !== "patch") throw new Error("expected patch evidence");
    expect(page.modelBytes).toBeLessThanOrEqual(MAX_PATCH_RESPONSE_BYTES);
    expect(page.auditBytes).toBeGreaterThan(1024 * 1024);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    expect(page.omitted.every((item) => item.path === "large.txt")).toBe(true);
    await expect(evidence.retrieve({ kind: "patch", paths: ["large.txt"], byteBudget: MAX_PATCH_RESPONSE_BYTES + 1 })).rejects.toThrow(/byteBudget/);
    await expect(evidence.retrieve({ kind: "patch", paths: ["../escape"] })).rejects.toThrow(/invalid.*path/);
    await expect(evidence.retrieve({ kind: "patch", paths: ["unknown.txt"] })).rejects.toThrow(/unknown/);
  });

  it("names one failed file without hiding a valid sibling", async () => {
    const failed = evidence.manifest.files.find((file) => file.path === "fail.txt")!;
    const oid = failed.new.oid!;
    const objectPath = join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));
    const object = readFileSync(objectPath);
    unlinkSync(objectPath);
    try {
      const response = await evidence.retrieve({ kind: "patch", paths: ["fail.txt", "space name.txt"], context: 0 });
      expect(response.kind).toBe("patch");
      if (response.kind !== "patch") throw new Error("expected patch evidence");
      expect(response.errors.join("\n")).toContain("fail.txt");
      expect(response.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ path: "fail.txt" })]));
      expect(response.returned).toEqual(expect.arrayContaining([expect.objectContaining({ path: "space name.txt" })]));
    } finally {
      writeFileSync(objectPath, object);
    }
  });

  it("loads only an exact manifest outside the checkout and rejects stale or malformed identity", async () => {
    const inside = join(repo, "manifest.json");
    copyFileSync(manifestPath, inside);
    await expect(openChangeEvidence(repo, inside)).rejects.toThrow(/outside/);
    const malformed = join(root, "malformed.json");
    writeFileSync(malformed, '{"schema":1,"files":[]}\n');
    await expect(openChangeEvidence(repo, malformed)).rejects.toThrow(/base\/head/);
    writeFileSync(join(repo, "later.txt"), "later\n");
    git(["add", "--", "later.txt"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "later"]);
    await expect(openChangeEvidence(repo, manifestPath)).rejects.toThrow(/base\/head.*checkout/);
  });
});
