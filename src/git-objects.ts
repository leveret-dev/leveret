import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

/**
 * Git object failures. `inspect-java.ts` maps them onto its bridge error with the same code and message;
 * admission code reports them as safe artifact rejections instead.
 */
export class GitObjectError extends Error {
  constructor(readonly code: "invalid-input" | "snapshot-mismatch" | "worker-failed", message: string) { super(message); }
}

export interface GitTreeEntry { path: string; oid: string; mode: string }

const gitEnv = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" };
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_GIT_BYTES = 64 * 1024 * 1024;

/** Repository-relative path without an absolute prefix, empty or `..` component, backslash or NUL. */
export function isSafeRelativePath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") && !path.split("/").some((part) => part === ".." || part === "");
}

export async function gitBytes(repo: string, args: string[], input?: Buffer, signal?: AbortSignal): Promise<Buffer> {
  // This project targets ES2023, before Promise.withResolvers is available.
  return new Promise<Buffer>((done, fail) => {
    const child = spawn("git", args, { cwd: repo, env: gitEnv, stdio: ["pipe", "pipe", "pipe"], signal });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_GIT_BYTES) { child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 4096); });
    // A killed or early-exiting child closes its stdin; the failure is reported through "error" and "close".
    child.stdin.once("error", () => undefined);
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > MAX_GIT_BYTES) fail(new GitObjectError("worker-failed", `Git object read failed: ${stderr || code}`));
      else done(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

export async function readGitTree(repo: string, revision: string, signal?: AbortSignal): Promise<GitTreeEntry[]> {
  const bytes = await gitBytes(repo, ["ls-tree", "-r", "-z", revision], undefined, signal);
  const result: GitTreeEntry[] = [];
  for (const chunk of bytes.toString("binary").split("\0")) {
    if (!chunk) continue;
    const item = decoder.decode(Buffer.from(chunk, "binary"));
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\t(.+)$/s.exec(item);
    if (!match) throw new GitObjectError("snapshot-mismatch", "Unsupported Git tree entry");
    const path = match[4]!;
    if (!isSafeRelativePath(path)) throw new GitObjectError("invalid-input", `Unsafe snapshot path: ${path}`);
    result.push({ mode: match[1]!, oid: match[3]!, path });
  }
  return result;
}

export async function readGitBlobs(repo: string, entries: readonly GitTreeEntry[], signal?: AbortSignal): Promise<Map<string, Buffer>> {
  const bytes = await gitBytes(repo, ["cat-file", "--batch"], Buffer.from(`${entries.map((item) => item.oid).join("\n")}\n`), signal);
  let offset = 0;
  const result = new Map<string, Buffer>();
  for (const item of entries) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw new GitObjectError("snapshot-mismatch", "Incomplete Git object header");
    const header = decoder.decode(bytes.subarray(offset, end));
    const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== item.oid) throw new GitObjectError("snapshot-mismatch", "Git object identity differs");
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length > MAX_GIT_BYTES || end + 1 + length >= bytes.length || bytes[end + 1 + length] !== 10) {
      throw new GitObjectError("snapshot-mismatch", "Incomplete Git object body");
    }
    const content = bytes.subarray(end + 1, end + 1 + length);
    result.set(item.path, content);
    offset = end + length + 2;
  }
  if (offset !== bytes.length) throw new GitObjectError("snapshot-mismatch", "Unrequested Git object content");
  return result;
}
