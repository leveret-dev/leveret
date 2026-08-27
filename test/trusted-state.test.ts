import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scan } from "../src/scan.js";
import { materializeTrustedReviewState } from "../src/trusted-state.js";

const repos: string[] = [];

function git(repo: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("trusted review state", () => {
  it("uses base policy and memory and cannot execute a checkout-defined engine", async () => {
    const repo = mkdtempSync(join(tmpdir(), "leveret-trusted-test-"));
    repos.push(repo);
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, ".leveret.yml"), 'review:\n  enabled: true\nengines:\n  semgrep:\n    rules: ["rules/trusted.yml"]\n  ast-grep:\n    rules: ["sgconfig.yml"]\n');
    mkdirSync(join(repo, "rules"));
    writeFileSync(join(repo, "rules", "trusted.yml"), "base rule\n");
    writeFileSync(join(repo, "sgconfig.yml"), 'ruleDirs: ["sgrules"]\n');
    mkdirSync(join(repo, "sgrules"));
    writeFileSync(join(repo, "sgrules", "no-eval.yml"), "trusted ast rule\n");
    mkdirSync(join(repo, ".leveret"));
    writeFileSync(join(repo, ".leveret", "memory.jsonl"), '{"kind":"convention","text":"trusted ruling","author":"owner","created":"2026-08-22"}\n');
    writeFileSync(join(repo, "input.txt"), "base\n");
    git(repo, ["add", "."]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
    git(repo, ["branch", "base"]);

    const marker = join(repo, "executed");
    writeFileSync(
      join(repo, ".leveret.yml"),
      `review:\n  enabled: false\ncustom:\n  - id: evil\n    command: [touch, ${JSON.stringify(marker)}]\n    files: ["**/*"]\n`,
    );
    writeFileSync(join(repo, "input.txt"), "head\n");
    writeFileSync(join(repo, "rules", "trusted.yml"), "hostile replacement\n");
    writeFileSync(join(repo, "sgrules", "no-eval.yml"), "hostile ast replacement\n");
    writeFileSync(join(repo, ".leveret", "memory.jsonl"), '{"kind":"convention","text":"hostile ruling","author":"attacker","created":"2026-08-22"}\n');
    git(repo, ["add", "."]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "head"]);

    const trusted = await materializeTrustedReviewState(repo, "base");
    try {
      expect(readFileSync(trusted.profilePath, "utf8")).toContain("enabled: true");
      expect(readFileSync(join(trusted.root, "rules", "trusted.yml"), "utf8")).toBe("base rule\n");
      expect(readFileSync(join(trusted.root, "sgrules", "no-eval.yml"), "utf8")).toBe("trusted ast rule\n");
      expect(readFileSync(join(trusted.root, ".leveret", "memory.jsonl"), "utf8")).toContain("trusted ruling");
      await scan({
        repo,
        base: "base",
        engines: ["evil"],
        profilePath: trusted.profilePath,
        memoryRepo: trusted.root,
        allowCustomEngines: false,
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await trusted.close();
    }
  });

  it("overlays hash-pinned host memory outside the reviewed repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "leveret-trusted-overlay-test-"));
    repos.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, ".leveret.yml"), "");
    writeFileSync(join(repo, "input.txt"), "base\n");
    git(repo, ["add", "."]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
    const memory = join(root, "benchmark-memory.jsonl");
    const content = '{"kind":"convention","text":"benchmark ruling","author":"owner","created":"2026-08-26"}\n';
    writeFileSync(memory, content);

    const trusted = await materializeTrustedReviewState(repo, "HEAD", {
      path: memory,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    try {
      expect(readFileSync(join(trusted.root, ".leveret", "memory.jsonl"), "utf8")).toBe(content);
    } finally {
      await trusted.close();
    }
  });

  it("rejects host memory whose content does not match its pinned hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "leveret-trusted-overlay-hash-test-"));
    repos.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, ".leveret.yml"), "");
    writeFileSync(join(repo, "input.txt"), "base\n");
    git(repo, ["add", "."]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
    const memory = join(root, "benchmark-memory.jsonl");
    writeFileSync(memory, '{"kind":"convention","text":"benchmark ruling","author":"owner","created":"2026-08-26"}\n');

    await expect(materializeTrustedReviewState(repo, "HEAD", {
      path: memory,
      sha256: "0".repeat(64),
    })).rejects.toThrow("trusted memory SHA-256 mismatch");
  });

  it("rejects host memory stored inside the reviewed repository", async () => {
    const repo = mkdtempSync(join(tmpdir(), "leveret-trusted-overlay-inside-test-"));
    repos.push(repo);
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, ".leveret.yml"), "");
    const memory = join(repo, "benchmark-memory.jsonl");
    const content = '{"kind":"convention","text":"untrusted ruling","author":"attacker","created":"2026-08-26"}\n';
    writeFileSync(memory, content);
    git(repo, ["add", "."]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);

    await expect(materializeTrustedReviewState(repo, "HEAD", {
      path: memory,
      sha256: createHash("sha256").update(content).digest("hex"),
    })).rejects.toThrow("trusted memory must stay outside the reviewed repository");
  });
});
