import { createHmac, timingSafeEqual } from "node:crypto";
import { createPullRequestWorkItem, type WorkItem } from "../work-item.js";

// GitHub webhook plumbing: signature verification and event → job routing.
// Pure; the HTTP server and API client wrap around this.

export function verifySignature(
  secret: string,
  body: string,
  header: string | undefined,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const got = header.slice("sha256=".length);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}


/** GitHub caps webhook payloads at 25 MB and simply does not deliver anything
 * larger, so nothing legitimate ever exceeds this. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** The rejections that need no body. A webhook endpoint is public — under relay
 * mode its URL is published in a repository — and the signature cannot be checked
 * until the whole body has been read, so anything that cannot be a GitHub delivery
 * is refused before a single byte is buffered. Returns the status to answer with,
 * or null to go on and read the body. */
export function preBodyReject(
  headers: Record<string, string | string[] | undefined>,
): number | null {
  if (!headers["x-hub-signature-256"]) return 401;
  if (!headers["x-github-event"]) return 400;
  const declared = Number(headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return 413;
  return null;
}

/** Read a request body, giving up the moment it passes the cap — a chunked
 * request declares no length, so the counter is the only real bound. Returns null
 * when the cap is passed, having destroyed the stream rather than drained it. */
export function readCappedBody(
  req: NodeJS.ReadableStream & { destroy?: (err?: Error) => void },
  cap = MAX_BODY_BYTES,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        req.destroy?.();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
    req.on("close", () => resolve(null));
  });
}

export type Job =
  | {
      kind: "review";
      repo: string;
      pr: number;
      headSha: string;
      baseSha: string;
      baseRef: string;
      cloneUrl: string;
      action: string;
      title: string;
      event: "pull_request";
      deliveryId?: string;
      installationId?: number;
      workItem: WorkItem;
    }
  | {
      kind: "learn-feed";
      repo: string;
      pr: number;
      author: string;
      body: string;
      inReplyTo: number;
      event: "pull_request_review_comment";
      deliveryId?: string;
      installationId?: number;
    };

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

interface PullPayload {
  action?: string;
  pull_request?: {
    number: number;
    title?: string;
    body?: string | null;
    user?: { login?: string };
    head: { sha: string };
    base: { ref: string; sha: string; repo: { full_name: string; clone_url: string } };
  };
  comment?: {
    id: number;
    user?: { login?: string; type?: string };
    body?: string;
    in_reply_to_id?: number;
  };
  installation?: { id: number };
}

export function routeEvent(event: string, payload: PullPayload, deliveryId?: string): Job | null {
  if (event === "pull_request" && payload.action && REVIEW_ACTIONS.has(payload.action)) {
    const pr = payload.pull_request;
    if (!pr) return null;
    return {
      kind: "review",
      repo: pr.base.repo.full_name,
      pr: pr.number,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      baseRef: pr.base.ref,
      cloneUrl: pr.base.repo.clone_url,
      action: payload.action,
      title: pr.title ?? "",
      workItem: createPullRequestWorkItem({
        event: "pull_request",
        deliveryId,
        installationId: payload.installation?.id,
        repository: pr.base.repo.full_name,
        number: pr.number,
        action: payload.action,
        title: pr.title,
        body: pr.body,
        authorLogin: pr.user?.login,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
      }),
      event: "pull_request",
      ...(deliveryId ? { deliveryId } : {}),
      ...(payload.installation ? { installationId: payload.installation.id } : {}),
    };
  }
  if (event === "pull_request_review_comment" && payload.action === "created") {
    const c = payload.comment;
    const pr = payload.pull_request;
    // A human reply in a finding thread is the learn feed; bots never teach.
    if (!c || !pr || c.user?.type === "Bot" || !c.in_reply_to_id) return null;
    return {
      kind: "learn-feed",
      repo: pr.base.repo.full_name,
      pr: pr.number,
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      inReplyTo: c.in_reply_to_id,
      event: "pull_request_review_comment",
      ...(deliveryId ? { deliveryId } : {}),
      ...(payload.installation ? { installationId: payload.installation.id } : {}),
    };
  }
  return null;
}
