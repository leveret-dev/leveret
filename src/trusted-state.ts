import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { run } from "./exec.js";
import { loadProfile } from "./profile.js";
import { parse } from "yaml";

export interface TrustedReviewState {
  root: string;
  profilePath: string;
  close(): Promise<void>;
}

export interface TrustedMemoryOverlay {
  path: string;
  sha256: string;
}

async function fileAtRef(repo: string, ref: string, path: string): Promise<string | undefined> {
  const result = await run("git", ["show", `${ref}:${path}`], repo);
  return result.code === 0 ? result.stdout : undefined;
}

function trustedPath(root: string, path: string): string {
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  if (isAbsolute(path) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`trusted profile rule path escapes the repository: ${path}`);
  }
  return destination;
}

async function copyBlob(repo: string, base: string, root: string, path: string): Promise<string> {
  const content = await fileAtRef(repo, base, path);
  if (content === undefined) throw new Error(`trusted profile rule is missing at ${base}: ${path}`);
  const destination = trustedPath(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  return content;
}

async function copyTree(repo: string, base: string, root: string, path: string): Promise<void> {
  trustedPath(root, path);
  const listed = await run("git", ["ls-tree", "-r", "--name-only", base, "--", path], repo);
  const files = listed.stdout.split("\n").filter(Boolean);
  if (listed.code !== 0 || files.length === 0) throw new Error(`trusted rule directory is missing at ${base}: ${path}`);
  for (const file of files) await copyBlob(repo, base, root, file);
}

async function hostMemory(repo: string, overlay: TrustedMemoryOverlay): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(overlay.sha256)) throw new Error("trusted memory SHA-256 is invalid");
  const [repoRoot, memoryPath] = await Promise.all([realpath(repo), realpath(resolve(overlay.path))]);
  const rel = relative(repoRoot, memoryPath);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) {
    throw new Error("trusted memory must stay outside the reviewed repository");
  }
  const content = await readFile(memoryPath);
  if (createHash("sha256").update(content).digest("hex") !== overlay.sha256) {
    throw new Error("trusted memory SHA-256 mismatch");
  }
  return content.toString("utf8");
}

/** Copy review policy from the trusted base commit, outside the untrusted checkout. */
export async function materializeTrustedReviewState(
  repo: string,
  base: string,
  memoryOverlay?: TrustedMemoryOverlay,
): Promise<TrustedReviewState> {
  const root = await mkdtemp(join(tmpdir(), "leveret-trusted-"));
  const profilePath = join(root, ".leveret.yml");
  try {
    await writeFile(profilePath, (await fileAtRef(repo, base, ".leveret.yml")) ?? "");
    const profile = await loadProfile(profilePath);
    for (const rule of Object.values(profile.engines).flatMap((engine) => engine.rules ?? [])) {
      const content = await copyBlob(repo, base, root, rule);
      const doc = parse(content) as { ruleDirs?: unknown } | null;
      if (!Array.isArray(doc?.ruleDirs)) continue;
      for (const directory of doc.ruleDirs) {
        if (typeof directory !== "string") throw new Error(`trusted ruleDirs entry must be a path string: ${rule}`);
        await copyTree(repo, base, root, join(dirname(rule), directory));
      }
    }
    const memory = memoryOverlay ? await hostMemory(repo, memoryOverlay) : await fileAtRef(repo, base, ".leveret/memory.jsonl");
    if (memory !== undefined) {
      await mkdir(join(root, ".leveret"), { recursive: true });
      await writeFile(join(root, ".leveret", "memory.jsonl"), memory);
    }
    return {
      root,
      profilePath,
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
