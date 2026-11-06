// Bot review miner (docs/superpowers/specs/2026-11-06-bot-gap-analysis-design.md).
// Usage: npm run bench:mine -- <fetch|label|audit|compare|report> [options]
// Raw comment text stays in the gitignored cache; stdout prints progress counts only.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "octokit";
import { isBot } from "./mine-labels.mjs";

export const CACHE_ROOT = ".cache/mine";

export interface Gh {
  request(route: string, params?: object): Promise<{ data: any }>;
  paginate(route: string, params?: object): Promise<any[]>;
  graphql(query: string, variables?: object): Promise<any>;
}

export interface User { login: string; type: string }
export interface Comment { id: number; html_url: string; user: User; body: string; created_at: string }
export interface Review extends Comment { commit_id: string | null }
export interface ReviewComment extends Comment {
  in_reply_to_id: number | null;
  path: string;
  original_line: number | null;
  original_start_line: number | null;
  original_commit_id: string;
}
export type Compare = { status: "ok"; files: { filename: string; previous_filename?: string; patch?: string }[] } | { status: "unavailable" };
export interface CachedPr {
  repository: string;
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  base_sha: string;
  head_sha: string;
  repo_fork: boolean;
  repo_language: string | null;
  issue_comments: Comment[];
  reviews: Review[];
  review_comments: ReviewComment[];
  threads: { comment_ids: number[]; is_resolved: boolean }[];
  compares: Record<string, Compare>;
}

export const THROTTLE = {
  onRateLimit: (_retryAfter: number, _options: object, _octokit: object, _retryCount: number) => true,
  onSecondaryRateLimit: (_retryAfter: number, _options: object, _octokit: object, _retryCount: number) => true,
};

export function githubClient(token = process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()): Gh {
  return new Octokit({ auth: token, throttle: THROTTLE }) as unknown as Gh;
}

const user = (value: { login: string; type: string } | null): User => (value ? { login: value.login, type: value.type } : { login: "ghost", type: "User" });
const split = (repository: string) => {
  const [owner, repo] = repository.split("/");
  return { owner: owner!, repo: repo! };
};

const SEARCH_CAP = 1000;
const day = (date: Date) => date.toISOString().slice(0, 10);

/** Every PR by `author` created in [from, to] (inclusive days), bisecting windows over the search cap. */
export async function discoverPrs(gh: Gh, author: string, from: string, to: string): Promise<{ repository: string; number: number }[]> {
  const found = new Map<string, { repository: string; number: number }>();
  const visit = async (start: string, end: string): Promise<void> => {
    const q = `is:pr author:${author} created:${start}..${end}`;
    const { data } = await gh.request("GET /search/issues", { q, per_page: 1 });
    if (data.total_count === 0) return;
    if (data.total_count > SEARCH_CAP) {
      if (start === end) throw new Error(`more than ${SEARCH_CAP} PRs created on ${start}`);
      const low = Date.parse(start);
      const middle = new Date(low + Math.floor((Date.parse(end) - low) / 86_400_000 / 2) * 86_400_000);
      await visit(start, day(middle));
      await visit(day(new Date(middle.getTime() + 86_400_000)), end);
      return;
    }
    for (const item of await gh.paginate("GET /search/issues", { q, per_page: 100 })) {
      const repository = String(item.repository_url).replace(/^.*\/repos\//, "");
      found.set(`${repository}#${item.number}`, { repository, number: item.number });
    }
  };
  await visit(from, to);
  return [...found.values()].sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number);
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
      nodes { isResolved comments(first: 100) { nodes { databaseId } } } } } } }`;

export async function fetchPr(gh: Gh, repository: string, number: number, repos = new Map<string, { fork: boolean; language: string | null }>()): Promise<CachedPr> {
  const { owner, repo } = split(repository);
  const { data: pr } = await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
  if (!repos.has(repository)) {
    const { data } = await gh.request("GET /repos/{owner}/{repo}", { owner, repo });
    repos.set(repository, { fork: Boolean(data.fork), language: data.language ?? null });
  }
  const meta = repos.get(repository)!;
  const issueComments: Comment[] = (await gh.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: number, per_page: 100 }))
    .map((c) => ({ id: c.id, html_url: c.html_url, user: user(c.user), body: c.body ?? "", created_at: c.created_at }));
  const reviews: Review[] = (await gh.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo, pull_number: number, per_page: 100 }))
    .map((r) => ({ id: r.id, html_url: r.html_url, user: user(r.user), body: r.body ?? "", created_at: r.submitted_at ?? "", commit_id: r.commit_id ?? null }));
  const reviewComments: ReviewComment[] = (await gh.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", { owner, repo, pull_number: number, per_page: 100 }))
    .map((c) => ({
      id: c.id, html_url: c.html_url, user: user(c.user), body: c.body ?? "", created_at: c.created_at,
      in_reply_to_id: c.in_reply_to_id ?? null, path: c.path, original_line: c.original_line ?? null,
      original_start_line: c.original_start_line ?? null, original_commit_id: c.original_commit_id,
    }));
  const cached: CachedPr = {
    repository, number, url: pr.html_url, state: pr.state, merged: Boolean(pr.merged), base_sha: pr.base.sha, head_sha: pr.head.sha,
    repo_fork: meta.fork, repo_language: meta.language, issue_comments: issueComments, reviews, review_comments: reviewComments, threads: [], compares: {},
  };
  if (![...issueComments, ...reviews, ...reviewComments].some((c) => isBot(c.user))) return cached;

  for (let after: string | null = null; ;) {
    const result: any = await gh.graphql(THREADS_QUERY, { owner, repo, number, after });
    const page = result.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) cached.threads.push({ comment_ids: node.comments.nodes.map((c: { databaseId: number }) => c.databaseId), is_resolved: Boolean(node.isResolved) });
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  const reviewed = new Set(reviewComments.filter((c) => c.in_reply_to_id === null && isBot(c.user)).map((c) => c.original_commit_id));
  for (const commit of reviewed) {
    try {
      const { data } = await gh.request("GET /repos/{owner}/{repo}/compare/{basehead}", { owner, repo, basehead: `${commit}...${cached.head_sha}` });
      // Only a straight line from the reviewed commit to the final head says which reviewed lines changed.
      cached.compares[commit] = data.status === "ahead" || data.status === "identical"
        ? { status: "ok", files: (data.files ?? []).map((f: any) => ({ filename: f.filename, ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}), ...(f.patch ? { patch: f.patch } : {}) })) }
        : { status: "unavailable" };
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
      if (status !== 404 && status !== 422) throw error;
      cached.compares[commit] = { status: "unavailable" };
    }
  }
  return cached;
}

export const prFile = (cacheRoot: string, repository: string, number: number) => join(cacheRoot, "prs", `${repository.replace("/", "__")}__${number}.json`);

export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, content);
  await rename(`${path}.tmp`, path);
}

export async function runFetch(gh: Gh, opts: { author: string; refresh: boolean; only?: string[]; cacheRoot?: string }): Promise<{ fetched: number; cached: number; withoutBots: number }> {
  const cacheRoot = opts.cacheRoot ?? CACHE_ROOT;
  const prs = opts.only
    ? opts.only.map((ref) => {
      const match = ref.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
      if (!match) throw new Error(`expected OWNER/REPO#N, got ${ref}`);
      return { repository: match[1]!, number: Number(match[2]) };
    })
    : await discoverPrs(gh, opts.author, "2008-01-01", day(new Date()));
  const repos = new Map<string, { fork: boolean; language: string | null }>();
  const summary = { fetched: 0, cached: 0, withoutBots: 0 };
  for (const [index, { repository, number }] of prs.entries()) {
    const path = prFile(cacheRoot, repository, number);
    let pr: CachedPr;
    if (!opts.refresh && existsSync(path)) {
      pr = JSON.parse(await readFile(path, "utf8")) as CachedPr;
      summary.cached++;
    } else {
      pr = await fetchPr(gh, repository, number, repos);
      await writeAtomic(path, `${JSON.stringify(pr)}\n`);
      summary.fetched++;
    }
    if (![...pr.issue_comments, ...pr.reviews, ...pr.review_comments].some((c) => isBot(c.user))) summary.withoutBots++;
    if ((index + 1) % 25 === 0 || index + 1 === prs.length) console.log(`fetch ${index + 1}/${prs.length} cached=${summary.cached} fetched=${summary.fetched} without-bots=${summary.withoutBots}`);
  }
  return summary;
}

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

export function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "fetch": {
      const only = option(args, "--only");
      await runFetch(githubClient(), { author: option(args, "--author") ?? "andrebrait", refresh: args.includes("--refresh"), only: only?.split(",") });
      return;
    }
    default:
      throw new Error("usage: mine.mts <fetch> [options]");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
