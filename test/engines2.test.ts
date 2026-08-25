import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scan } from "../src/scan.js";

// typos + jscpd engines, files-mode fixtures (no git needed).

let repo: string;
const dupBody = Array.from({ length: 8 }, (_, i) => `    x${i} = compute_thing(${i}) + adjust(${i})`).join("\n");

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "leveret-eng2-"));
  writeFileSync(join(repo, "doc.md"), "Teh accomodate typo fixture\n");
  writeFileSync(join(repo, "dup1.py"), `def f1():\n${dupBody}\n`);
  writeFileSync(join(repo, "dup2.py"), `def f2():\n${dupBody}\n`);
});

describe("typos engine", () => {
  it("flags misspellings with corrections in the message", async () => {
    const result = await scan({ repo, files: ["doc.md"], engines: ["typos"] });
    const teh = result.findings.find((f) => f.engine === "typos" && f.message.includes("Teh"));
    expect(teh).toMatchObject({ file: "doc.md", line: 1, severity: "info" });
    expect(teh!.message).toContain("The");
  });
});

describe("jscpd engine", () => {
  it("is profile-gated: without a corpus it is not applicable", async () => {
    const result = await scan({ repo, files: ["dup1.py"], engines: ["jscpd"] });
    expect(result.engines).toEqual([expect.objectContaining({ engine: "jscpd", status: "not-applicable", selectedFiles: [], durationMs: expect.any(Number) })]);
  });

  it("reports duplication touching a changed file, naming the other end", async () => {
    writeFileSync(
      join(repo, ".leveret.yml"),
      'engines:\n  jscpd:\n    corpus: ["**/*.py"]\n    minTokens: 20\n',
    );
    const result = await scan({ repo, files: ["dup1.py"], engines: ["jscpd"] });
    const dup = result.findings.find((f) => f.engine === "jscpd");
    expect(dup).toMatchObject({ rule: "duplication", file: "dup1.py", severity: "info" });
    expect(dup!.message).toContain("dup2.py");
  });
});
