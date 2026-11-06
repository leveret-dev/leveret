import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPrs, fetchPr, runFetch, THROTTLE, type CachedPr, type Gh } from "../bench/mine.mjs";

const SHA = (c: string) => c.repeat(40);
const bot = { login: "coderabbitai[bot]", type: "Bot" };
const human = { login: "andrebrait", type: "User" };

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Serves GitHub-shaped responses by route; records every call. */
function fakeGh(options: { failPr?: number; compare404?: boolean; diverged?: boolean; searchTotal?: (q: string) => number } = {}) {
  const calls: string[] = [];
  const gh: Gh = {
    async request(route, params = {}) {
      calls.push(`${route} ${JSON.stringify(params)}`);
      const p = params as Record<string, unknown>;
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        if (p.pull_number === options.failPr) throw httpError(500);
        return { data: { html_url: `https://github.com/${p.owner}/${p.repo}/pull/${p.pull_number}`, state: "closed", merged: true, base: { sha: SHA("b") }, head: { sha: SHA("f") } } };
      }
      if (route === "GET /repos/{owner}/{repo}") return { data: { fork: p.owner === "me", language: "TypeScript" } };
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") {
        if (options.compare404) throw httpError(404);
        if (options.diverged) return { data: { status: "diverged", files: [{ filename: "unrelated.ts", patch: "@@ -1 +1 @@\n-a\n+b" }] } };
        return { data: { status: "ahead", files: [{ filename: "src/x.ts", patch: "@@ -10,1 +10,1 @@\n-a\n+b" }] } };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        // src/x.ts line 11 changes between the reviewed commit and the head; src/y.ts is deleted at the head.
        const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
        if (p.path === "src/y.ts") {
          if (p.ref === SHA("f")) throw httpError(404);
          return { data: lines.join("\n") + "\n" };
        }
        if (p.ref === SHA("f")) lines[10] = "changed";
        return { data: lines.join("\n") + "\n" };
      }
      if (route === "GET /search/issues") {
        const total = options.searchTotal?.(String(p.q)) ?? 1;
        return { data: { total_count: total, items: [] } };
      }
      throw new Error(`unexpected route ${route}`);
    },
    async paginate(route, params = {}) {
      calls.push(`${route} ${JSON.stringify(params)}`);
      const p = params as Record<string, unknown>;
      if (route === "GET /search/issues") {
        const q = String(p.q);
        const day = q.match(/created:(\S+)\.\./)![1];
        return [{ repository_url: "https://api.github.com/repos/o/r", number: day === "2020-01-01" ? 1 : 2 }, { repository_url: "https://api.github.com/repos/o/r", number: 1 }];
      }
      if (route.endsWith("/issues/{issue_number}/comments")) return [{ id: 1, html_url: "https://github.com/o/r/pull/1#issuecomment-1", user: human, body: "@coderabbitai review", created_at: "2026-01-01T00:00:00Z" }];
      if (route.endsWith("/pulls/{pull_number}/reviews")) return [{ id: 2, html_url: "https://github.com/o/r/pull/1#pullrequestreview-2", user: bot, body: "", submitted_at: "2026-01-01T00:00:00Z", commit_id: SHA("c") }];
      if (route.endsWith("/pulls/{pull_number}/comments")) return [
        { id: 10, html_url: "https://github.com/o/r/pull/1#discussion_r10", user: bot, body: "finding A", created_at: "2026-01-01T00:00:00Z", path: "src/x.ts", original_line: 10, original_start_line: null, original_commit_id: SHA("c"), in_reply_to_id: null },
        { id: 11, html_url: "https://github.com/o/r/pull/1#discussion_r11", user: bot, body: "finding B", created_at: "2026-01-01T00:00:00Z", path: "src/y.ts", original_line: 5, original_start_line: 3, original_commit_id: SHA("c"), in_reply_to_id: null },
        { id: 12, html_url: "https://github.com/o/r/pull/1#discussion_r12", user: null, body: "reply", created_at: "2026-01-02T00:00:00Z", path: "src/x.ts", original_line: 10, original_start_line: null, original_commit_id: SHA("d"), in_reply_to_id: 10 },
      ];
      throw new Error(`unexpected route ${route}`);
    },
    async graphql(_query, variables = {}) {
      calls.push(`graphql ${JSON.stringify(variables)}`);
      const after = (variables as Record<string, unknown>).after;
      const page = after
        ? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ isResolved: false, comments: { nodes: [{ databaseId: 11 }] } }] }
        : { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 10 }, { databaseId: 12 }] } }] };
      return { repository: { pullRequest: { reviewThreads: page } } };
    },
  };
  return { gh, calls };
}

describe("fetchPr", () => {
  it("caches threads and one compare per reviewed commit of a bot root comment", async () => {
    const { gh, calls } = fakeGh();
    const pr = await fetchPr(gh, "o/r", 1);
    expect(pr.threads).toEqual([{ comment_ids: [10, 12], is_resolved: true }, { comment_ids: [11], is_resolved: false }]);
    expect(Object.keys(pr.compares)).toEqual([SHA("c")]);
    expect(pr.compares[SHA("c")]).toEqual({ status: "ok", files: [{ filename: "src/x.ts", patch: "@@ -10,1 +10,1 @@\n-a\n+b" }] });
    expect(calls.filter((call) => call.includes("compare"))).toEqual([`GET /repos/{owner}/{repo}/compare/{basehead} ${JSON.stringify({ owner: "o", repo: "r", basehead: `${SHA("c")}...${SHA("f")}` })}`]);
    expect(pr.review_comments[2]!.user).toEqual({ login: "ghost", type: "User" });
    expect(pr).toMatchObject({ repository: "o/r", number: 1, merged: true, head_sha: SHA("f"), repo_fork: false, repo_language: "TypeScript" });
  });

  it("caches an unreachable reviewed commit as unavailable and still succeeds", async () => {
    const { gh } = fakeGh({ compare404: true });
    const pr = await fetchPr(gh, "o/r", 1);
    expect(pr.compares[SHA("c")]).toEqual({ status: "unavailable" });
  });

  it("diffs the commented files directly when history was rewritten after the review", async () => {
    const { gh } = fakeGh({ diverged: true });
    const pr = await fetchPr(gh, "o/r", 1);
    const compare = pr.compares[SHA("c")];
    expect(compare?.status).toBe("ok");
    const files = compare?.status === "ok" ? compare.files : [];
    expect(files.map((f) => f.filename).sort()).toEqual(["src/x.ts", "src/y.ts"]);
    expect(files.find((f) => f.filename === "src/x.ts")!.patch).toMatch(/^@@ -11 \+11 @@/m);
    expect(files.find((f) => f.filename === "src/y.ts")!.patch).toMatch(/^@@ -1,20 \+0,0 @@/m);
  });
});

describe("runFetch", () => {
  const only = [1, 2, 3, 4, 5].map((n) => `o/r#${n}`);

  it("writes nothing partial when a PR fails and resumes from the failed PR", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "mine-"));
    await expect(runFetch(fakeGh({ failPr: 3 }).gh, { author: "andrebrait", refresh: false, only, cacheRoot })).rejects.toThrow();
    expect((await readdir(join(cacheRoot, "prs"))).sort()).toEqual(["o__r__1.json", "o__r__2.json"]);
    const { gh, calls } = fakeGh();
    const summary = await runFetch(gh, { author: "andrebrait", refresh: false, only, cacheRoot });
    expect(calls.filter((call) => call.startsWith("GET /repos/{owner}/{repo}/pulls/{pull_number} ")).map((call) => JSON.parse(call.slice(call.indexOf("{\"")))).map((p) => p.pull_number)).toEqual([3, 4, 5]);
    expect(summary).toEqual({ fetched: 3, cached: 2, withoutBots: 0 });
    const cached = JSON.parse(await readFile(join(cacheRoot, "prs", "o__r__4.json"), "utf8")) as CachedPr;
    expect(cached.number).toBe(4);
  });

  it("makes no GitHub calls over a populated cache", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "mine-"));
    await runFetch(fakeGh().gh, { author: "andrebrait", refresh: false, only, cacheRoot });
    const { gh, calls } = fakeGh();
    expect(await runFetch(gh, { author: "andrebrait", refresh: false, only, cacheRoot })).toEqual({ fetched: 0, cached: 5, withoutBots: 0 });
    expect(calls).toEqual([]);
  });
});

describe("discoverPrs", () => {
  it("bisects a window over the search cap and merges the halves without duplicates", async () => {
    const { gh, calls } = fakeGh({ searchTotal: (q) => (q.includes("2020-01-01..2020-01-02") ? 1500 : 10) });
    const prs = await discoverPrs(gh, "andrebrait", "2020-01-01", "2020-01-02");
    expect(prs).toEqual([{ repository: "o/r", number: 1 }, { repository: "o/r", number: 2 }]);
    expect(calls.filter((call) => call.startsWith("GET /search/issues")).length).toBe(5);
  });
});

describe("throttling", () => {
  it("keeps retrying primary and secondary rate limits", () => {
    expect(THROTTLE.onRateLimit(60, {}, {}, 5)).toBe(true);
    expect(THROTTLE.onSecondaryRateLimit(60, {}, {}, 5)).toBe(true);
  });
});
