#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildChangeManifest, type ChangeManifest } from "../src/change-evidence.js";
import { InspectJavaError, loadInspectJavaConfig, openInspectJava, type InspectJavaBridge, type InspectJavaConfig } from "../src/inspect-java.js";
import { referenceReplySchema, type ReferencePage } from "../src/inspect-java-contract.js";
import { pathIsInside } from "../src/path.js";
import { runStreaming } from "../src/exec.js";
import { connectSerena, serenaBundleProblem } from "../src/runner/serena.js";

const corpusRevision = "620f4ff4b4b0934e6dc46465fe5c92fd7e1fb997";
const corpusCandidates = [
  { checkout: "/tmp/leveret-oracle-subjects/commons-lang", cache: "/tmp/leveret-oracle-repos/commons-lang" },
  { checkout: "/tmp/leveret-oracle/subjects/commons-lang", cache: "/tmp/leveret-oracle/repos/commons-lang" },
];
const oracleHashes = {
  "oracle-compile.txt": "40d4238e3e537ef7e6f78086095fd93557624184998fd0fde8e95ab24a55d8df",
  "oracle-test.txt": "115961f299e56e2a5225653868471aba1c740fab409300c2b7d72a894d92a0fe",
};
const limitsSchema = z.object({ heapBytes: z.number().int().positive(), addressSpaceBytes: z.number().int().positive(), deadlineMs: z.number().int().positive(), maxOutputBytes: z.number().int().positive() }).strict();
const templateSchema = z.object({
  schema: z.literal(1), distribution: z.string().min(1), jdkHome: z.string().min(1), cache: z.string().min(1),
  limits: limitsSchema, distributionFiles: z.record(z.string(), z.string()).optional(),
  jdkFiles: z.record(z.string(), z.string()).optional(),
}).passthrough();
const checkedPath = "src/test/java/example/PricingTest.java";
const targetPath = "src/main/java/example/Pricing.java";
const target = { path: targetPath, position: { line: 3, column: 17 } };
const targetId = "Lexample/Pricing;.price(I)I";
const baseSource = "package example;\nfinal class Pricing {\n    static int price(int quantity) { return quantity * 10; }\n    static int price(String code) { return code.length(); }\n}\n";
const headSource = baseSource.replace("quantity * 10", "quantity * 12");
const testSource = "package example;\nfinal class PricingTest {\n    int numeric() { return Pricing.price(3); }\n    int textual() { return Pricing.price(\"ABC\"); }\n}\n";

interface Options { mode: "deterministic" | "review"; config: string; configSha256: string; output: string }
interface Fixture { repo: string; base: string; head: string; manifest: ChangeManifest }
interface FixtureEvaluation { cases: Record<string, unknown>; missingRevision: string }
function options(args: string[]): Options {
  const raw: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!name?.startsWith("--") || !args[i + 1] || raw[name]) throw new Error("Expected distinct --mode, --config, --config-sha256, and --output values");
    raw[name] = args[i + 1]!;
  }
  if (Object.keys(raw).sort().join(",") !== ["--config", "--config-sha256", "--mode", "--output"].join(",") ||
    !["deterministic", "review"].includes(raw["--mode"] ?? "") || !/^[a-f0-9]{64}$/.test(raw["--config-sha256"] ?? "")) {
    throw new Error("Invalid evaluation arguments");
  }
  return { mode: raw["--mode"] as Options["mode"], config: raw["--config"]!, configSha256: raw["--config-sha256"]!, output: raw["--output"]! };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const gitEnv = {
  PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Leveret Evaluation", GIT_AUTHOR_EMAIL: "evaluation@invalid.example",
  GIT_COMMITTER_NAME: "Leveret Evaluation", GIT_COMMITTER_EMAIL: "evaluation@invalid.example",
  GIT_AUTHOR_DATE: "2020-01-02T03:04:05Z", GIT_COMMITTER_DATE: "2020-01-02T03:04:05Z",
};
function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }).trim();
}
function commit(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function fixture(out: string): Promise<Fixture> {
  const repo = join(out, "fixture");
  await mkdir(join(repo, "src/main/java/example"), { recursive: true });
  await mkdir(join(repo, "src/test/java/example"), { recursive: true });
  git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, targetPath), baseSource);
  await writeFile(join(repo, checkedPath), testSource);
  await writeFile(join(repo, "gradle.lockfile"), "empty=compileClasspath,testCompileClasspath\n");
  const base = commit(repo, "Base: price quantity by ten");
  await writeFile(join(repo, targetPath), headSource);
  const head = commit(repo, "Head: price quantity by twelve");
  const manifest = await buildChangeManifest(repo, base);
  if (manifest.head !== head || manifest.files.length !== 1 || manifest.files[0]?.path !== targetPath) {
    throw new Error("Deterministic fixture changed more than price(int)");
  }
  return { repo, base, head, manifest };
}

async function pinnedConfig(template: z.infer<typeof templateSchema>, output: string, repo: string,
  label: string, overrides: Record<string, unknown>): Promise<{ config: InspectJavaConfig; path: string; sha256: string }> {
  const bin = ["bin/leveret-inspect", ...(await readdir(join(template.distribution, "lib"))).map((name) => `lib/${name}`)];
  const distributionFiles = Object.fromEntries(await Promise.all(bin.map(async (name) => [name, await hashFile(join(template.distribution, name))])));
  const jdkFiles = Object.fromEntries(await Promise.all(["bin/java", "release", "lib/modules", "lib/server/libjvm.so"]
    .map(async (name) => [name, await hashFile(join(template.jdkHome, name))])));
  if (template.distributionFiles && JSON.stringify(Object.entries(template.distributionFiles).sort()) !== JSON.stringify(Object.entries(distributionFiles).sort())) {
    throw new InspectJavaError("configuration-mismatch", "Operator-pinned distribution changed");
  }
  if (template.jdkFiles && JSON.stringify(Object.entries(template.jdkFiles).sort()) !== JSON.stringify(Object.entries(jdkFiles).sort())) {
    throw new InspectJavaError("configuration-mismatch", "Operator-pinned JDK changed");
  }
  const payload = JSON.stringify({ schema: 1, distribution: template.distribution, distributionFiles,
    jdkHome: template.jdkHome, jdkFiles, cache: template.cache, limits: template.limits, ...overrides });
  const path = join(output, `${label}-config.json`);
  await writeFile(path, payload, { mode: 0o600 });
  const sha256 = createHash("sha256").update(payload).digest("hex");
  return { config: await loadInspectJavaConfig(repo, path, sha256), path, sha256 };
}

function checked(page: ReferencePage, expected: number): void {
  const checked = page.items.filter((item) => item.kind === "reference").map((item) => item.reference!);
  if (checked.length !== expected || checked.some((item) => item.basis !== "checked" || item.sourceSet !== "test" || item.kind !== "call")) {
    throw new Error(`Expected ${expected} checked test calls, got ${checked.length}`);
  }
}

async function query(bridge: InspectJavaBridge, manifest: ChangeManifest, side: "base" | "head", selector = target,
  byteBudget?: number, cursor?: string): Promise<ReferencePage> {
  const summary = bridge.summaries[side];
  return bridge.references({ analysisId: summary.analysisId, configurationSha256: summary.configurationSha256,
    manifest, side, target: selector, ...(byteBudget === undefined ? {} : { byteBudget }), ...(cursor === undefined ? {} : { cursor }) });
}

async function fixtureCases(fixed: Fixture, config: InspectJavaConfig, output: string): Promise<FixtureEvaluation> {
  const { repo, base, head, manifest } = fixed;
  const started = performance.now();
  const bridge = await openInspectJava(repo, manifest, config, join(output, "fixture-store"));
  let baseline: ReferencePage;
  let staleRejected = false;
  try {
    baseline = await query(bridge, manifest, "head");
    checked(baseline, 1);
    const reference = baseline.items.find((item) => item.kind === "reference")?.reference;
    if (reference?.location.path !== checkedPath || JSON.stringify(reference.location.range) !== JSON.stringify({
      start: { line: 3, column: 27 }, end: { line: 3, column: 43 },
    }) || reference.enclosing?.signature !== "example.PricingTest.numeric()" || !baseline.summary.coverage.complete) {
      throw new Error("Exact fixture reference, range, caller, or coverage does not match the approved example");
    }
    await writeFile(join(repo, checkedPath), testSource.replace("Pricing.price(3)", "Pricing.price(4)"));
    try { await query(bridge, manifest, "head"); }
    catch (error) { staleRejected = error instanceof InspectJavaError && error.code === "snapshot-mismatch"; }
    if (!staleRejected) throw new Error("Dirty unchanged test source reused a stale analysis");
    await writeFile(join(repo, checkedPath), testSource);
  } finally { await bridge.close(); }

  const cases: Record<string, unknown> = {};
  cases.baseline = {
    base, head, analysis_id: baseline.summary.analysisId, configuration_sha256: baseline.summary.configurationSha256,
    target_id: baseline.target.id, target_signature: baseline.target.signature, checked: baseline.items.filter((item) => item.kind === "reference"),
    coverage: baseline.summary.coverage, stale_source_rejected: staleRejected, latency_ms: Math.round(performance.now() - started),
  };

  async function variant(name: string, edit: () => Promise<void>, check: (bridge: InspectJavaBridge, change: ChangeManifest) => Promise<unknown>) {
    await edit();
    const revision = commit(repo, name);
    const change = await buildChangeManifest(repo, head);
    const worker = await openInspectJava(repo, change, config, join(output, `${name.replaceAll(" ", "-")}-store`));
    try { cases[name] = { revision, result: await check(worker, change) }; }
    finally { await worker.close(); git(repo, ["reset", "--hard", head]); }
    return revision;
  }
  const missingRevision = await variant("missing input", async () => {
    await writeFile(join(repo, checkedPath), testSource.replace(/\n}\n$/, "\n    int missing() { return Pricing.price(MissingInputs.quantity()); }\n}\n"));
  }, async (worker, change) => {
    const page = await query(worker, change, "head");
    checked(page, 1);
    if (page.summary.coverage.complete || !page.items.some((item) => item.kind === "unresolved")) throw new Error("Missing dependency was not disclosed");
    return { checked: page.items.filter((item) => item.kind === "reference"), unresolved: page.items.filter((item) => item.kind === "unresolved"), coverage: page.summary.coverage };
  });
  await variant("deleted method", async () => {
    await writeFile(join(repo, targetPath), headSource.replace("    static int price(int quantity) { return quantity * 12; }\n", "\n"));
  }, async (worker, change) => {
    const page = await query(worker, change, "base");
    checked(page, 1);
    let headMissing = false;
    try { await query(worker, change, "head"); }
    catch (error) { headMissing = error instanceof InspectJavaError && error.code === "target-missing"; }
    if (!headMissing) throw new Error("Deleted method silently resolved on head");
    return { base_reference: page.items.find((item) => item.kind === "reference"), head_target_missing: headMissing, coverage: page.summary.coverage };
  });
  await variant("additional module", async () => {
    await mkdir(join(repo, "extra/src/main/java"), { recursive: true });
    await writeFile(join(repo, "extra/src/main/java/Other.java"), "class Other {}\n");
  }, async (worker, change) => {
    const page = await query(worker, change, "head");
    if (page.summary.coverage.complete || !page.items.some((item) => item.file?.path === "extra/src/main/java/Other.java" && !item.file.examined)) {
      throw new Error("Unsupported Java module was silently omitted");
    }
    return { coverage: page.summary.coverage, skipped: page.items.filter((item) => item.file?.examined === false) };
  });

  const calls = Array.from({ length: 16 }, (_, index) => `    int caller${index}() { return Pricing.price(${index}); }`).join("\n");
  await writeFile(join(repo, checkedPath), testSource.replace(/\n}\n$/, `\n${calls}\n}\n`));
  const pagedBase = commit(repo, "Page fixture: unchanged callers");
  await writeFile(join(repo, targetPath), headSource.replace("quantity * 12", "quantity * 13"));
  const pagedHead = commit(repo, "Page fixture: changed target body");
  const pagedManifest = await buildChangeManifest(repo, pagedBase);
  const paged = await openInspectJava(repo, pagedManifest, config, join(output, "pagination-store"));
  try {
    const full = await query(paged, pagedManifest, "head");
    checked(full, 17);
    const ids = full.items.filter((item) => item.kind === "reference").map((item) => item.reference!.id);
    const collected: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    let byteBudget = 1500;
    for (let attempt = 0; attempt < 64; attempt++) {
      let part: ReferencePage;
      try { part = await query(paged, pagedManifest, "head", target, byteBudget, cursor ?? undefined); }
      catch (error) {
        if (error instanceof InspectJavaError && error.code === "budget-too-small" &&
          error.requiredBytes && error.requiredBytes <= 262144) {
          byteBudget = Math.max(byteBudget + 1, error.requiredBytes);
          continue;
        }
        throw error;
      }
      collected.push(...part.items.filter((item) => item.kind === "reference").map((item) => item.reference!.id));
      cursor = part.delivery.nextCursor;
      pages++;
      if (!cursor) break;
    }
    if (cursor) throw new Error("Pagination did not advance");
    if (pages < 2 || JSON.stringify(collected) !== JSON.stringify(ids)) throw new Error("Paged references lost or duplicated records");
    cases.pagination = { base: pagedBase, head: pagedHead, page_count: pages, checked_ids: ids, complete: full.delivery.complete };
  } finally { await paged.close(); git(repo, ["reset", "--hard", head]); }
  return { cases, missingRevision };
}

async function fixedComparisons(repo: string, output: string): Promise<Record<string, unknown>> {
  let codegraph: Record<string, unknown>;
  try {
    execFileSync("codegraph", ["init", "--yes", repo], {
      cwd: repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
    });
    const parsed = JSON.parse(execFileSync("codegraph", ["callers", "--path", repo, "--limit", "20", "--json", "example.Pricing.price"], {
      cwd: repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
    })) as { callers?: Array<{ name: string; filePath: string; startLine: number }> };
    if (!Array.isArray(parsed.callers)) throw new Error("No CodeGraph caller result for fixed example");
    const candidates = [];
    for (const caller of parsed.callers) {
      if (!/^src\/(main|test)\/java\//.test(caller.filePath)) continue;
      const line = (await readFile(join(repo, caller.filePath), "utf8")).split("\n")[caller.startLine - 1] ?? "";
      candidates.push({ ...caller, source_line: line.trim(), basis: "structural-candidate" });
    }
    codegraph = { availability: "available", overload_selection: "not asserted", candidates };
  } catch (error) {
    codegraph = { availability: "unavailable", reason: String(error).slice(0, 300) };
  }
  const problem = serenaBundleProblem(repo);
  let serena: Record<string, unknown> = { availability: "unavailable", reason: problem ?? "Java LSP not available" };
  if (!problem) {
    try {
      const runtime = join(output, "fixture-serena-runtime");
      await mkdir(runtime);
      const connection = await connectSerena(repo, runtime);
      try {
        const tool = connection.tools.find((entry) => entry.name === "lsp_find_referencing_symbols");
        if (!tool) throw new Error("Serena has no reference tool");
        const result = await tool.execute("fixture-serena", { name_path: "Pricing/price", relative_path: targetPath },
          undefined, undefined, {} as never);
        serena = { availability: "available", basis: "language-server-candidate", version: connection.version,
          result: result.content };
      } finally { await connection.close(); }
    } catch (error) { serena = { availability: "unavailable", reason: String(error).slice(0, 300) }; }
  }
  return { codegraph, serena };
}

interface OutlineMember { symbolType: string; name: string; range: { start: { line: number; column: number }; byteOffset: { start: number } }; signature: string }
interface OutlineEntry { name: string; members?: OutlineMember[] }
interface OutlineFile { path: string; items: OutlineEntry[] }
interface FrozenSelector { path: string; name: string; position: { line: number; column: number }; nameOffset: number; owner: string }

async function selectors(repo: string): Promise<{ selected: FrozenSelector[]; enumerated: number }> {
  const raw = execFileSync("ast-grep", ["outline", "--lang", "java", "--view", "expanded", "--json=stream", "src/main/java", "src/test/java"],
    { cwd: repo, env: { ...process.env, HOME: "/nonexistent" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const list: FrozenSelector[] = [];
  let enumerated = 0;
  for (const line of raw.split("\n").filter(Boolean)) {
    const file = JSON.parse(line) as OutlineFile;
    if (!file.path.startsWith("src/main/java/") && !file.path.startsWith("src/test/java/")) continue;
    const source = await readFile(join(repo, file.path), "utf8");
    const rows = source.split("\n");
    for (const owner of file.items) for (const method of owner.members ?? []) {
      if (method.symbolType !== "method") continue;
      enumerated++;
      const name = method.name;
      if (!method.signature.includes(`${name}(`)) continue;
      const matcher = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
      for (let row = method.range.start.line; row < Math.min(rows.length, method.range.start.line + 12); row++) {
        const match = matcher.exec(rows[row] ?? "");
        if (!match) continue;
        const column = match.index;
        const offset = rows.slice(0, row).join("\n").length + (row > 0 ? 1 : 0) + column;
        list.push({ path: file.path, name, position: { line: row + 1, column },
          nameOffset: Buffer.byteLength(source.slice(0, offset)), owner: owner.name });
        break;
      }
    }
  }
  list.sort((a, b) => a.path.localeCompare(b.path) || a.nameOffset - b.nameOffset);
  if (list.length < 20) throw new Error(`Only ${list.length} syntax-derived Java selectors were available`);
  return { selected: list.slice(0, 20), enumerated };
}

async function pinnedCorpus(): Promise<{ repo: string; cache: string; cacheSha256: string; artifacts: number }> {
  for (const candidate of corpusCandidates) {
    const repo = await realpath(candidate.checkout).catch(() => null);
    const cache = await realpath(candidate.cache).catch(() => null);
    if (!repo || !cache) continue;
    if (git(repo, ["rev-parse", "HEAD"]) !== corpusRevision || git(repo, ["status", "--porcelain", "--untracked-files=no"])) {
      throw new Error("Commons Lang checkout is not the clean pinned revision");
    }
    for (const [name, sha256] of Object.entries(oracleHashes)) {
      if (await hashFile(join(cache, name)) !== sha256) throw new Error(`Pinned oracle cache changed: ${name}`);
    }
    const artifacts = new Set<string>();
    for (const name of Object.keys(oracleHashes)) {
      for (const absolute of (await readFile(join(cache, name), "utf8")).split("\n").filter(Boolean)) {
        const path = await realpath(absolute);
        if (!pathIsInside(cache, path) || !path.endsWith(".jar")) throw new Error("Oracle artifact escapes the pinned cache");
        artifacts.add(path);
      }
    }
    const digest = createHash("sha256");
    for (const path of [...artifacts].sort()) digest.update(`${path.slice(cache.length + 1)}:${await hashFile(path)}\n`);
    return { repo, cache, cacheSha256: digest.digest("hex"), artifacts: artifacts.size };
  }
  throw new Error("Provisioned Commons Lang checkout and artifact cache are unavailable; cold provisioning is forbidden");
}

async function evaluateCorpus(repo: string, cache: string, output: string, template: z.infer<typeof templateSchema>) {
  const { selected, enumerated } = await selectors(repo);
  await writeFile(join(output, "frozen-selectors.json"), JSON.stringify({ revision: corpusRevision, selected, enumerated }, null, 2));
  const javaLevel = /<maven\.compiler\.source>([^<]+)<\/maven\.compiler\.source>/.exec(await readFile(join(repo, "pom.xml"), "utf8"))?.[1];
  if (!javaLevel) throw new Error("Commons Lang Java language level is not explicit");
  const trusted = await pinnedConfig({ ...template, cache }, output, repo, "commons-lang", {
    repositoryId: "apache/commons-lang", module: ".", build: "maven", mainRoots: ["src/main/java"], testRoots: ["src/test/java"], javaLevel,
  });
  const manifest: ChangeManifest = { schema: 1, base: corpusRevision, head: corpusRevision, range: `${corpusRevision}...${corpusRevision}`,
    files: [], errors: [], truncated: false };
  const started = performance.now();
  const bridge = await openInspectJava(repo, manifest, trusted.config, join(output, "commons-lang-store"));
  const analysisMs = Math.round(performance.now() - started);
  const rows: Array<Record<string, unknown>> = [];
  try {
    for (const item of selected) {
      const path = item.path;
      const before = performance.now();
      let inspect: Record<string, unknown>;
      try {
        const first = await query(bridge, manifest, "head", { path, position: item.position });
        const details = [...first.items];
        let last = first;
        let pages = 1;
        while (last.delivery.nextCursor) {
          if (pages >= 256) throw new Error("Inspect pagination exceeded 256 pages");
          last = await query(bridge, manifest, "head", { path, position: item.position }, undefined, last.delivery.nextCursor);
          details.push(...last.items);
          pages++;
        }
        inspect = { target_id: first.target.id, signature: first.target.signature,
          checked: details.filter((detail) => detail.kind === "reference").map((detail) => ({
            id: detail.reference!.id, path: detail.reference!.location.path, range: detail.reference!.location.range,
            kind: detail.reference!.kind, source_set: detail.reference!.sourceSet, basis: detail.reference!.basis,
          })), coverage: first.summary.coverage, pages, delivery: last.delivery };
      } catch (error) {
        inspect = { error: error instanceof InspectJavaError ? { code: error.code, message: error.message } : String(error) };
      }
      const inspectMs = Math.round(performance.now() - before);
      const codegraphStarted = performance.now();
      const packagePath = dirname(path.replace(/^src\/(?:main|test)\/java\//, ""));
      const fqn = [packagePath === "." ? "" : packagePath.replaceAll("/", "."), item.owner, item.name].filter(Boolean).join(".");
      let codegraph: Record<string, unknown>;
      let rawCodegraph: string | undefined;
      try {
        rawCodegraph = execFileSync("codegraph", ["callers", "--path", repo, "--limit", "200", "--json", fqn],
          { cwd: repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
        const found = JSON.parse(rawCodegraph) as { callers?: Array<{ filePath: string; startLine: number; name: string }> };
        if (!Array.isArray(found.callers)) throw new Error("CodeGraph did not return a caller list");
        const candidates = [];
        for (const caller of found.callers) {
          if (!/^src\/(main|test)\/java\//.test(caller.filePath)) continue;
          const source = await readFile(join(repo, caller.filePath), "utf8");
          const nearby = source.split(/\r?\n/).slice(Math.max(0, caller.startLine - 1), caller.startLine + 60).join("\n");
          candidates.push({ ...caller, name_seen_near_candidate: nearby.includes(`${item.name}(`), basis: "structural-candidate" });
        }
        codegraph = { availability: "available", resolution: "candidate-only", candidates, truncated: found.callers.length >= 200 };
      } catch (error) {
        codegraph = rawCodegraph === undefined
          ? { availability: "unavailable", reason: String(error).slice(0, 300) }
          : { availability: "available", resolution: "indeterminate", diagnostic: rawCodegraph.slice(0, 300), candidates: null };
      }
      rows.push({ selector: item, inspect, codegraph, inspect_query_ms: inspectMs,
        codegraph_query_ms: Math.round(performance.now() - codegraphStarted) });
    }
  } finally { await bridge.close(); }
  const serenaProblem = serenaBundleProblem(repo);
  let serena: Record<string, unknown> = { availability: "unavailable", reason: serenaProblem ?? "no staged Java LSP bundle" };
  if (!serenaProblem) {
    try {
      const runtime = join(output, "serena-runtime");
      await mkdir(runtime);
      const connection = await connectSerena(repo, runtime);
      try {
        const tool = connection.tools.find((entry) => entry.name === "lsp_find_referencing_symbols");
        if (!tool) throw new Error("Serena has no reference tool");
        const candidates = [];
        for (const item of selected) {
          try {
            const reply = await tool.execute(`serena-${item.nameOffset}`, { name_path: `${item.owner}/${item.name}`, relative_path: item.path },
              undefined, undefined, {} as never);
            candidates.push({ selector: item.nameOffset, basis: "language-server-candidate", result: reply.content });
          } catch (error) { candidates.push({ selector: item.nameOffset, error: String(error) }); }
        }
        serena = { availability: "available", version: connection.version, languages: connection.indexing?.languages, candidates };
      } finally { await connection.close(); }
    } catch (error) { serena = { availability: "unavailable", reason: String(error).slice(0, 300) }; }
  }
  let codegraphVersion: string | null = null;
  try { codegraphVersion = execFileSync("codegraph", ["--version"], { encoding: "utf8" }).trim(); }
  catch { /* Individual selectors already record comparison unavailability. */ }
  return { revision: corpusRevision, java_level: javaLevel, frozen_selectors: selected.length,
    enumerated_methods: enumerated, analysis_id: bridge.summaries.head.analysisId,
    coverage: bridge.summaries.head.coverage, analysis_ms: analysisMs,
    total_comparison_ms: Math.round(performance.now() - started),
    configuration_sha256: trusted.sha256, codegraph_version: codegraphVersion,
    ast_grep_version: execFileSync("ast-grep", ["--version"], { encoding: "utf8" }).trim(),
    serena, selectors: rows };
}

interface RunnerEvent {
  sequence: number;
  category: string;
  event: string;
  tool_call_id?: string;
  payload?: unknown;
  payload_ref?: { sha256: string };
}

async function review(fixed: Fixture, config: { path: string; sha256: string }, out: string,
  variant: "fixed" | "missing", revision: string, base: string, incomplete: boolean) {
  git(fixed.repo, ["reset", "--hard", revision]);
  const trace = join(out, `private-review-trace-${variant}`);
  await mkdir(trace, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    LEVERET_REPO: fixed.repo, LEVERET_BASE: base,
    LEVERET_INSPECT_JAVA_CONFIG: config.path, LEVERET_INSPECT_JAVA_CONFIG_SHA256: config.sha256,
    LEVERET_TRACE_DIR: trace, LEVERET_RUN_ID: randomUUID(), LEVERET_TRACE_ENABLED: "1",
    LEVERET_TRACE_FAILURE: "fail", LEVERET_DATA: join(out, "review-data"),
  };
  const result = await runStreaming(process.execPath, [join(resolve(), "dist/runner/pi.js")], resolve(),
    { env, timeoutMs: 30 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut || result.truncated) throw new Error(`Real ${variant} review failed: ${result.stderr.slice(0, 1000)}`);
  const value = JSON.parse(result.stdout) as { run_configuration?: {
    tool_calls?: Array<{ toolCallId: string; toolName: string }>;
    model?: string; thinking?: string; identities?: unknown;
  } };
  const ids = value.run_configuration?.tool_calls?.filter((call) => call.toolName === "leveret_java_references")
    .map((call) => call.toolCallId) ?? [];
  const verdict = await traceConsumption(trace, ids, incomplete);
  return {
    status: verdict.evidenceReturned && verdict.subsequentUse && verdict.disclosedGap ? "verified" : "unverified",
    tool_call_ids: ids, expected_evidence_returned: verdict.evidenceReturned, subsequent_evidence_use: verdict.subsequentUse,
    incomplete_coverage_disclosed: verdict.disclosedGap,
    model: value.run_configuration?.model, thinking: value.run_configuration?.thinking,
    identities: value.run_configuration?.identities, audit_directory: trace,
  };
}

/** Checks a real review's audit trace: the expected Java evidence was returned, then cited in later reasoning. */
export async function traceConsumption(trace: string, ids: string[], incomplete: boolean) {
  const events = (await readFile(join(trace, "runner.ndjson"), "utf8")).split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as RunnerEvent);
  async function payload(event: RunnerEvent): Promise<Record<string, unknown>> {
    if (event.payload_ref) {
      const bytes = await readFile(join(trace, "blobs/sha256", event.payload_ref.sha256));
      if (createHash("sha256").update(bytes).digest("hex") !== event.payload_ref.sha256) throw new Error("Audit tool evidence checksum mismatch");
      return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    }
    return event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  }
  let evidenceReturned = false;
  let subsequentUse = false;
  let disclosedGap = !incomplete;
  for (const id of ids) {
    const started = events.find((event) => event.category === "tools" && event.event === "execution_start" && event.tool_call_id === id);
    const ended = events.find((event) => event.category === "tools" && event.event === "execution_end" && event.tool_call_id === id);
    if (!started || !ended || ended.sequence <= started.sequence) continue;
    const args = (await payload(started)).args as { side?: string } | undefined;
    if (args?.side !== "head") continue;
    const toolResult = (await payload(ended)).result as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const text = toolResult?.content?.find((part) => part.type === "text" && part.text?.startsWith("{"))?.text;
    const reply = referenceReplySchema.safeParse(JSON.parse(text ?? "null"));
    if (!reply.success || !reply.data.ok) continue;
    const { result } = reply.data;
    // Select by what the tool resolved, not by the exact column the model chose inside the name token.
    if (incomplete) {
      if (result.summary.coverage.complete || !result.items.some((item) => item.kind === "unresolved")) continue;
    } else if (result.target.id !== targetId || !result.items.some((item) => item.kind === "reference" &&
      item.reference?.location.path === checkedPath && item.reference.basis === "checked")) continue;
    evidenceReturned = true;
    const later: string[] = [];
    for (const event of events) {
      if (event.sequence <= ended.sequence) continue;
      if (event.category === "assistant" && event.event === "message_end" ||
        event.category === "result" && event.event === "phase_submitted") {
        later.push(JSON.stringify(await payload(event)));
      } else if (event.category === "tools" && event.event === "execution_start") {
        const data = await payload(event);
        if (data.tool === "leveret_submit_phase") later.push(JSON.stringify(data));
      }
    }
    const reasoning = later.join("\n");
    if (!reasoning.includes(id) || !reasoning.includes(checkedPath)) continue;
    subsequentUse = true;
    if (incomplete) {
      // The disclosure must accompany a citation of this call, not appear anywhere in the transcript.
      for (let at = reasoning.indexOf(id); at >= 0 && !disclosedGap; at = reasoning.indexOf(id, at + 1)) {
        disclosedGap = /unresolved|incomplete|complete=false|missing dependency/i.test(reasoning.slice(Math.max(0, at - 600), at + 600));
      }
    }
  }
  return { evidenceReturned, subsequentUse, disclosedGap };
}

async function main(): Promise<void> {
  const args = options(process.argv.slice(2));
  if (args.mode === "review" && process.env.LEVERET_PAID_MODEL_APPROVED !== "1") {
    console.log(JSON.stringify({ ok: false, error: { code: "approval-required", message: "Separate model-execution approval is required" } }));
    process.exitCode = 2;
    return;
  }
  const out = resolve(args.output);
  if (!isAbsolute(args.output)) throw new Error("Evaluation output must be an absolute path");
  const parent = await realpath(dirname(out));
  if (pathIsInside(await realpath(resolve()), join(parent, basename(out)))) throw new Error("Evaluation output cannot be inside Leveret's checkout");
  const original = await readFile(args.config);
  if (createHash("sha256").update(original).digest("hex") !== args.configSha256) throw new Error("Operator configuration digest mismatch");
  const template = templateSchema.parse(JSON.parse(original.toString("utf8")));
  const corpus = await pinnedCorpus();
  const configLocation = await realpath(args.config);
  if (pathIsInside(await realpath(resolve()), configLocation) || pathIsInside(corpus.repo, configLocation)) {
    throw new Error("Operator configuration must be outside reviewed checkouts");
  }
  if (pathIsInside(corpus.repo, join(parent, basename(out)))) throw new Error("Evaluation output cannot be inside the Java corpus");
  const existingOutput = await realpath(out).catch(() => null);
  if (existingOutput && (pathIsInside(corpus.repo, existingOutput) ||
    pathIsInside(await realpath(resolve()), existingOutput))) {
    throw new Error("Evaluation output symlink enters a reviewed checkout");
  }
  await mkdir(out, { recursive: true, mode: 0o700 });
  if ((await readdir(out)).length !== 0) throw new Error("Evaluation output directory must be empty");
  const fixed = await fixture(out);
  const fixtureConfig = await pinnedConfig(template, out, fixed.repo, "fixture", {
    repositoryId: "evaluation/fixture", module: ".", build: "gradle", mainRoots: ["src/main/java"], testRoots: ["src/test/java"], javaLevel: "21",
  });
  const fixtureResult = await fixtureCases(fixed, fixtureConfig.config, out);
  const fixtureComparison = await fixedComparisons(fixed.repo, out);
  const corpusResult = await evaluateCorpus(corpus.repo, corpus.cache, out, template);
  let reviewResult: Record<string, unknown> & { status: string } = { status: "not-authorized" };
  if (args.mode === "review") {
    try {
      const fixedReview = await review(fixed, fixtureConfig, out, "fixed", fixed.head, fixed.base, false);
      const missingReview = await review(fixed, fixtureConfig, out, "missing", fixtureResult.missingRevision, fixed.head, true);
      reviewResult = {
        status: fixedReview.status === "verified" && missingReview.status === "verified" ? "verified" : "unverified",
        fixed: fixedReview, missing_dependency: missingReview,
      };
    } catch (error) {
      reviewResult = { status: "unverified", error: String(error) };
    }
  }
  const report = { schema: "leveret.inspect-java-evaluation/v1", operator_config_sha256: args.configSha256,
    fixture: { ...fixtureResult.cases, comparison: fixtureComparison },
    corpus: { cache_sha256: corpus.cacheSha256, artifacts: corpus.artifacts, ...corpusResult },
    reviewer_consumption: reviewResult };
  await writeFile(join(out, "deterministic.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: args.mode === "deterministic" || reviewResult.status === "verified",
    output: join(out, "deterministic.json"), reviewer_consumption: reviewResult.status }));
  if (args.mode === "review" && reviewResult.status !== "verified") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: { code: error instanceof InspectJavaError ? error.code : "evaluation-failed", message: String(error) } }));
  process.exitCode = 1;
});
