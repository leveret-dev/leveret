import { App, Octokit } from "octokit";
import type { InlineComment } from "./render.js";

// Thin GitHub App client: everything interesting happens in render/webhook/runner;
// this file only moves bytes to the API.

export interface AppAuth {
  appId: string;
  privateKey: string;
}

export function makeApp(auth: AppAuth): App {
  return new App({ appId: auth.appId, privateKey: auth.privateKey });
}

export interface GitHubAccess {
  octokit(): Promise<Octokit>;
  botLogin(): Promise<string>;
  token(): Promise<string>;
}

export function appAccess(app: App, installationId: number): GitHubAccess {
  return {
    octokit: () => app.getInstallationOctokit(installationId),
    botLogin: async () => {
      const { data } = await app.octokit.request("GET /app");
      return `${(data as { slug: string }).slug}[bot]`;
    },
    token: () => app.octokit.rest.apps.createInstallationAccessToken({ installation_id: installationId }).then((response) => response.data.token),
  };
}

export function tokenAccess(token: string, login = "leveret[bot]"): GitHubAccess {
  const octokit = new Octokit({ auth: token });
  return { octokit: async () => octokit, botLogin: async () => login, token: async () => token };
}

/** One review submission: walkthrough as the review body, findings as inline
 * comments. Inline anchors can fail (file renamed since head, line outside the
 * diff); GitHub rejects the whole review then, so retry once without inline
 * comments rather than losing the walkthrough. */
export async function postReview(
  access: GitHubAccess,
  repo: string,
  pr: number,
  headSha: string,
  walkthrough: string,
  inline: InlineComment[],
): Promise<void> {
  const octokit = await access.octokit();
  const [owner, name] = repo.split("/") as [string, string];
  const base = {
    owner,
    repo: name,
    pull_number: pr,
    commit_id: headSha,
    event: "COMMENT" as const,
    body: walkthrough,
  };
  try {
    await octokit.rest.pulls.createReview({
      ...base,
      comments: inline.map((c) => ({ path: c.path, line: c.line, side: "RIGHT" as const, body: c.body })),
    });
  } catch {
    await octokit.rest.pulls.createReview(base);
  }
}

export async function postComment(
  access: GitHubAccess,
  repo: string,
  issue: number,
  body: string,
): Promise<number> {
  const octokit = await access.octokit();
  const [owner, name] = repo.split("/") as [string, string];
  const r = await octokit.rest.issues.createComment({ owner, repo: name, issue_number: issue, body });
  return r.data.id;
}

export async function updateComment(
  access: GitHubAccess,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  const octokit = await access.octokit();
  const [owner, name] = repo.split("/") as [string, string];
  await octokit.rest.issues.updateComment({ owner, repo: name, comment_id: commentId, body });
}

/** The bot's review threads on a PR, for incremental re-review. */
export async function fetchReviewThreads(
  access: GitHubAccess,
  repo: string,
  pr: number,
): Promise<unknown> {
  const octokit = await access.octokit();
  const [owner, name] = repo.split("/") as [string, string];
  return octokit.graphql(
    `query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              path
              line
              comments(first: 1) { nodes { databaseId author { login } body } }
            }
          }
        }
      }
    }`,
    { owner, name, pr },
  ).then((data) => ({ data }));
}

export async function resolveThread(
  access: GitHubAccess,
  threadId: string,
): Promise<void> {
  const octokit = await access.octokit();
  await octokit.graphql(
    `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`,
    { id: threadId },
  );
}

export async function replyInThread(
  access: GitHubAccess,
  repo: string,
  pr: number,
  commentId: number,
  body: string,
): Promise<void> {
  const octokit = await access.octokit();
  const [owner, name] = repo.split("/") as [string, string];
  await octokit.rest.pulls.createReplyForReviewComment({
    owner,
    repo: name,
    pull_number: pr,
    comment_id: commentId,
    body,
  });
}
