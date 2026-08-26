import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGraphify } from "../src/app/graphify.js";

describe("ensureGraphify", () => {
  it("builds and validates a code-only graph outside the checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "leveret-graphify-"));
    const repo = join(root, "repo");
    const output = join(root, "prepared");
    const bin = join(root, "graphify-fixture.mjs");
    mkdirSync(repo);
    mkdirSync(output);
    writeFileSync(join(repo, "index.ts"), "export const value = 1;\n");
    writeFileSync(bin, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("graphify 1.0.0"); process.exit(0); }
const out = process.argv[process.argv.indexOf("--out") + 1];
mkdirSync(join(out, "graphify-out"), { recursive: true });
writeFileSync(join(out, "graphify-out", "graph.json"), JSON.stringify({ nodes: [{ id: "value" }], links: [{ source: "value", target: "value" }] }));
`);
    chmodSync(bin, 0o755);

    const status = await ensureGraphify(repo, output, bin);
    expect(status).toMatchObject({ ok: true, indexedNodes: 1, indexedEdges: 1 });
    expect(status.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(status.graphPath?.startsWith(repo)).toBe(false);
    expect(existsSync(status.graphPath!)).toBe(true);
  });

  it("reports an unavailable binary without throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "leveret-no-graphify-"));
    const repo = join(root, "repo");
    const output = join(root, "prepared");
    mkdirSync(repo);
    mkdirSync(output);
    await expect(ensureGraphify(repo, output, "definitely-not-graphify-bin")).resolves.toMatchObject({ ok: false });
  });
});
