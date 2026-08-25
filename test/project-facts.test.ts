import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectFacts } from "../src/project-facts.js";

describe("project facts", () => {
  it("derives build, framework, language, and root orientation without an LLM", async () => {
    const repo = mkdtempSync(join(tmpdir(), "leveret-project-facts-"));
    mkdirSync(join(repo, "src/main/java/example"), { recursive: true });
    mkdirSync(join(repo, "src/test/java/example"), { recursive: true });
    writeFileSync(join(repo, "build.gradle.kts"), "plugins { id(\"org.springframework.boot\") version \"3.5.0\" }\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0" } }));
    writeFileSync(join(repo, "src/main/java/example/App.java"), "class App {}\n");
    writeFileSync(join(repo, "src/test/java/example/AppTest.java"), "class AppTest {}\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture"], { cwd: repo });
    try {
      const facts = await projectFacts(repo);
      expect(facts).toMatchObject({
        trackedFiles: 4,
        languages: [{ language: "Java", files: 2 }],
        buildSystems: [
          { name: "Gradle", evidence: ["build.gradle.kts"] },
          { name: "Node package", evidence: ["package.json"] },
        ],
        frameworks: [
          { name: "React", evidence: ["package.json"] },
          { name: "Spring Boot", evidence: ["build.gradle.kts"] },
        ],
        sourceRoots: ["src/main"],
        testRoots: ["src/test"],
        manifests: ["build.gradle.kts", "package.json"],
        manifestErrors: [],
        truncated: { manifests: false, roots: false },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
