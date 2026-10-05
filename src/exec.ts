import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentAuditTrace, sanitizeAuditValue } from "./audit.js";
import { currentSecretPolicy, refreshSecretPolicy, withSecretPolicy } from "./secret-screening.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** set when the child died on a signal (OOM kill, timeout, segfault) */
  signal?: string;
  timedOut?: boolean;
  truncated?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  spawnError?: string;
}

export interface ExecutableIdentity {
  command: string;
  available: boolean;
  path?: string;
  version?: string;
  sha256?: string;
}

// No shell: file names from a diff must never hit string interpolation.
export interface RunOpts {
  /** hard cap: the child is SIGTERM'd at the deadline (no orphaned waits) */
  timeoutMs?: number;
  /** explicit child environment; Pi runner uses this to keep provider secrets out of tools */
  env?: NodeJS.ProcessEnv;
  /** output cap; callers handling untrusted tools should keep this small */
  maxBuffer?: number;
  /** Host cancellation, independent of the subprocess deadline. */
  signal?: AbortSignal;
}

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "CI",
  "GITHUB_ACTIONS",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

function captureSubprocess(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
  startedAt: number,
  result: ExecResult,
): Promise<void> | undefined {
  return currentAuditTrace()?.record("subprocess", "completed", {
    argv: [cmd, ...args], cwd, environment_names: Object.keys(env ?? process.env).sort(),
    ...result, duration_ms: Date.now() - startedAt, timeout_ms: timeoutMs,
  }, { completeness: result.truncated ? "truncated" : "complete" });
}

/** Environment for untrusted checkout tools: runtime basics, never provider/GitHub credentials. */
export function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

export function run(cmd: string, args: string[], cwd: string, opts?: RunOpts): Promise<ExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const env = opts?.env ?? (process.env.LEVERET_SANITIZE_CHILD_ENV === "1" ? safeChildEnvironment() : undefined);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    execFile(cmd, args, { cwd, env, maxBuffer: opts?.maxBuffer ?? 64 * 1024 * 1024, timeout: timeoutMs, signal: opts?.signal }, (err, stdout, stderr) => {
      let code = 0;
      let signal: string | undefined;
      let timedOut = false;
      let truncated = false;
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: unknown; signal?: string; killed?: boolean };
        timedOut = opts?.signal?.aborted !== true && e.killed === true && Boolean(e.signal);
        truncated = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        if (opts?.signal?.aborted) signal = "SIGTERM";
        if (typeof e.signal === "string" && e.signal) {
          // A signal death reports err.code null; `?? 0` would read as success
          // and callers would trust partial stdout from a killed tool.
          code = -1;
          signal = e.signal;
        } else if (typeof e.code === "number") {
          code = e.code;
        } else {
          code = -1; // spawn failure (ENOENT etc.), not a tool verdict
        }
      }
      const result = { code, stdout: stdout ?? "", stderr: stderr ?? "", ...(signal ? { signal } : {}), ...(timedOut ? { timedOut } : {}), ...(truncated ? { truncated } : {}) };
      const captured = captureSubprocess(cmd, args, cwd, env, timeoutMs, startedAt, result);
      if (captured) void captured.then(() => resolve(result), () => resolve(result));
      else resolve(result);
    });
  });
}

export interface StreamRunOpts extends RunOpts {
  onStdout?(chunk: Buffer): void;
  onStderr?(chunk: Buffer): void;
}

/**
 * Streaming child execution for long-running harnesses. The child leads its own process group so cancellation,
 * deadlines and capture limits terminate every descendant that inherited its output pipes, even after the root
 * exited; only that owned group is ever signalled. Under an active secret policy, callbacks receive one screened
 * bounded copy per stream at completion, never independently screened fragments. Private returned stdout/stderr
 * remain exact for host protocol parsing.
 */
export function runStreaming(cmd: string, args: string[], cwd: string, opts?: StreamRunOpts): Promise<ExecResult> {
  // Keep the executor form for the project's ES2023 standard-library contract (no withResolvers declaration).
  return new Promise((resolveResult, rejectResult) => {
    const startedAt = Date.now();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBuffer = opts?.maxBuffer ?? 64 * 1024 * 1024;
    const env = opts?.env ?? (process.env.LEVERET_SANITIZE_CHILD_ENV === "1" ? safeChildEnvironment() : undefined);
    const policy = currentSecretPolicy();
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let truncated = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let spawnError: string | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let terminated = false;
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* group already gone */ }
    };
    const killOnHostExit = (): void => signalGroup("SIGKILL");
    process.once("exit", killOnHostExit);
    const terminate = (): void => {
      terminated = true;
      signalGroup("SIGTERM");
      forceTimer ??= setTimeout(() => signalGroup("SIGKILL"), 5000);
    };
    opts?.signal?.addEventListener("abort", terminate, { once: true });
    if (opts?.signal?.aborted) terminate();
    const keep = (chunks: Buffer[], chunk: Buffer, used: number, stream: "stdout" | "stderr"): number => {
      const remaining = Math.max(0, maxBuffer - used);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining) {
        truncated = true;
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        terminate();
      }
      return used + Math.min(chunk.length, remaining);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = keep(stdout, chunk, stdoutBytes, "stdout");
      if (!policy) opts?.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = keep(stderr, chunk, stderrBytes, "stderr");
      if (!policy) opts?.onStderr?.(chunk);
    });
    child.on("error", (error) => { spawnError = error.message; });
    const timer = setTimeout(() => {
      if (!opts?.signal?.aborted) { timedOut = true; terminate(); }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      opts?.signal?.removeEventListener("abort", terminate);
      process.removeListener("exit", killOnHostExit);
      clearTimeout(timer);
      clearTimeout(forceTimer);
      const result: ExecResult = {
        // A run that was cancelled, timed out or cut off never reads as success, even when the root exited 0 first.
        code: terminated && code === 0 ? -1 : code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(signal ? { signal } : {}),
        ...(timedOut ? { timedOut } : {}),
        ...(truncated ? { truncated } : {}),
        ...(stdoutTruncated ? { stdoutTruncated } : {}),
        ...(stderrTruncated ? { stderrTruncated } : {}),
        ...(spawnError ? { spawnError } : {}),
      };
      if (spawnError) result.stderr = `${result.stderr}${result.stderr ? "\n" : ""}${spawnError}`;
      const finish = async () => {
        if (policy) {
          await withSecretPolicy(policy, async () => {
            await refreshSecretPolicy(policy);
            const exposed = sanitizeAuditValue(result);
            if (!policy.available) {
              exposed.stdout = "[output withheld: screening unavailable]";
              exposed.stderr = "[output withheld: screening unavailable]";
            } else {
              if (stdoutTruncated) exposed.stdout = "[output withheld: truncated capture]";
              if (stderrTruncated) exposed.stderr = "[output withheld: truncated capture]";
            }
            if (stdoutBytes > 0) opts?.onStdout?.(Buffer.from(exposed.stdout));
            if (stderrBytes > 0) opts?.onStderr?.(Buffer.from(exposed.stderr));
            await captureSubprocess(cmd, args, cwd, env, timeoutMs, startedAt, exposed);
          });
        } else {
          const captured = captureSubprocess(cmd, args, cwd, env, timeoutMs, startedAt, result);
          if (captured) await captured.catch(() => {}); // flush() retains the existing audit failure contract.
        }
        resolveResult(result);
      };
      void finish().catch(rejectResult);
    });
  });
}

/** Unique scratch path: the MCP server is one long-lived process serving
 * concurrent calls, so pid alone collides — always add entropy. */
export function scratchPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`);
}

export function which(cmd: string): Promise<boolean> {
  return run("/usr/bin/which", [cmd], "/").then((r) => r.code === 0);
}

export async function executableIdentity(command: string, cwd = "/"): Promise<ExecutableIdentity> {
  const located = await run("/usr/bin/which", [command], "/");
  if (located.code !== 0) return { command, available: false };
  const path = located.stdout.trim();
  const versionResult = await run(command, ["--version"], cwd);
  let sha256: string | undefined;
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    sha256 = hash.digest("hex");
  } catch {
    // Version/path still identify wrappers whose target cannot be read.
  }
  const version = (versionResult.stdout || versionResult.stderr).trim().split("\n")[0];
  return { command, available: true, path, ...(version ? { version } : {}), ...(sha256 ? { sha256 } : {}) };
}
