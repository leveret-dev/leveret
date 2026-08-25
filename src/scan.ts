import { existsSync, realpathSync } from "node:fs";
import { join, matchesGlob, resolve } from "node:path";
import { buildChangeManifest, validateChangeManifestCheckout, type ChangeManifest } from "./change-evidence.js";
import { parseSarif } from "./sarif.js";
import { baseFindingKeys, consumeKey, findingKey } from "./delta.js";
import { ENGINES, which, type Engine, type ScanContext } from "./engines/registry.js";
import { run } from "./exec.js";
import type { EngineReport, Finding, ScanResult } from "./findings.js";
import { applyMemory } from "./memory.js";
import { filterFindings, loadProfile, scopeFiles, type Profile } from "./profile.js";

function scannableFiles(manifest: ChangeManifest): string[] {
  return manifest.files.filter((file) => file.new.exists).map((file) => file.path);
}

function manifestRenames(manifest: ChangeManifest): Map<string, string> {
  return new Map(manifest.files
    .filter((file) => file.status === "rename")
    .map((file) => [file.oldPath, file.newPath]));
}

function manifestHunks(manifest: ChangeManifest): Map<string, [number, number][]> {
  return new Map(manifest.files
    .filter((file) => file.hunks.length > 0)
    .map((file) => [file.path, file.hunks.map((hunk) => [
      hunk.newStart,
      hunk.newStart + Math.max(hunk.newLines, 1) - 1,
    ] as [number, number])]));
}

export async function changedFiles(repo: string, base: string): Promise<string[]> {
  return scannableFiles(await buildChangeManifest(repo, base));
}

/** base path -> head path for renames, so a renamed file's base findings keep
 * matching under the head name instead of resurfacing as "introduced" */
export async function renamedFiles(repo: string, base: string): Promise<Map<string, string>> {
  return manifestRenames(await buildChangeManifest(repo, base));
}

/** head-side changed line ranges per file */
export async function changedHunks(
  repo: string,
  base: string,
): Promise<Map<string, [number, number][]>> {
  return manifestHunks(await buildChangeManifest(repo, base));
}

/** how close (in lines) a pre-existing finding must sit to a changed hunk to
 * count as "the change touches that part" and earn a reminder */
const REMINDER_RADIUS = 10;

function nearChange(hunks: Map<string, [number, number][]>, f: Finding): boolean {
  const ranges = hunks.get(f.file);
  if (!ranges) return false;
  const lo = f.line;
  const hi = f.endLine ?? f.line;
  return ranges.some(([s, e]) => hi >= s - REMINDER_RADIUS && lo <= e + REMINDER_RADIUS);
}

/** Run every applicable engine over one tree. The single engine-execution path —
 * the head scan and the delta base scan both go through here. */
async function runEngines(
  ctx: ScanContext,
  profile: Profile,
  wanted: Engine[],
  headRepo: string,
  reports?: EngineReport[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  await Promise.all(
    wanted.map(async (engine) => {
      const startedAt = Date.now();
      // Rule packs resolve against the HEAD repo, never ctx.repo: during the delta
      // base pass ctx.repo is the base worktree, where a pack added by the change
      // under review does not exist yet.
      const engineProfile = profile.engines[engine.id];
      const rules = engineProfile?.rules?.map((r) => resolve(headRepo, r));
      const ectx: ScanContext = { ...ctx, rules, engineProfile };
      const selected = scopeFiles(profile, engine.id, engine.select(ectx)).sort();
      if (selected.length === 0) {
        reports?.push({ engine: engine.id, status: "not-applicable", selectedFiles: [], durationMs: Date.now() - startedAt });
        return;
      }
      // custom engines may name a repo-local script rather than a PATH binary
      if (!(await which(engine.bin)) && !existsSync(join(ctx.repo, engine.bin))) {
        reports?.push({ engine: engine.id, status: "missing", detail: `${engine.bin} not on PATH`, selectedFiles: selected, durationMs: Date.now() - startedAt });
        return;
      }
      try {
        const found = await engine.scan(ectx, selected);
        // Some engines (ruff) echo absolute paths — and resolve symlinks while at
        // it (macOS /var vs /private/var). Identity across trees needs
        // repo-relative files, so strip both spellings of the repo root here.
        const roots = [ctx.repo, realpathSync(ctx.repo)];
        for (const f of found) {
          for (const root of roots) {
            if (f.file.startsWith(`${root}/`)) f.file = f.file.slice(root.length + 1);
          }
        }
        findings.push(...found);
        // Status is finalized post-filter in scan(): an engine whose findings all
        // get dropped by delta/profile/memory must not read as "findings".
        reports?.push({
          engine: engine.id,
          status: found.length > 0 ? "findings" : "clean",
          found: found.length,
          kept: found.length,
          selectedFiles: selected,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        reports?.push({ engine: engine.id, status: "error", detail: String(err).slice(0, 500), selectedFiles: selected, durationMs: Date.now() - startedAt });
      }
    }),
  );
  return findings;
}

export async function scan(opts: {
  repo: string;
  base?: string;
  files?: string[];
  manifest?: ChangeManifest;
  engines?: string[];
  profilePath?: string;
  rulesRoot?: string;
  memoryRepo?: string;
  /** custom commands are trusted only in an explicitly controlled invocation */
  allowCustomEngines?: boolean;
  /** with a base: drop findings already present at the base tree (default true) */
  delta?: boolean;
}): Promise<ScanResult> {
  let manifest = opts.manifest;
  let base = opts.base;
  if (base) {
    if (manifest) {
      await validateChangeManifestCheckout(opts.repo, manifest);
      if (base !== manifest.base) throw new Error("scan base does not match the change manifest");
    } else {
      manifest = await buildChangeManifest(opts.repo, base);
    }
    base = manifest.base;
  } else if (manifest) {
    throw new Error("scan needs base when a change manifest is supplied");
  }
  const files = opts.files ?? (manifest ? scannableFiles(manifest) : []);
  if (files.length === 0 && !opts.files) {
    throw new Error("scan needs either files[] or a base ref with changes");
  }
  const profile = await loadProfile(
    opts.profilePath ? resolve(opts.profilePath) : join(opts.repo, ".leveret.yml"),
  );
  const custom: Engine[] = (opts.allowCustomEngines === false ? [] : profile.custom).map((def) => ({
    id: def.id,
    bin: def.command[0]!,
    select: (ctx) => ctx.files.filter((f) => def.files.some((g) => matchesGlob(f, g))),
    scan: async (ctx, selected) => {
      const r = await run(def.command[0]!, [...def.command.slice(1), ...selected], ctx.repo);
      return parseSarif(def.id, r.stdout);
    },
  }));
  const wanted = [...ENGINES, ...custom].filter(
    (e) => !opts.engines || opts.engines.includes(e.id),
  );

  const reports: EngineReport[] = [];
  const findings = await runEngines(
    { repo: opts.repo, files, base },
    profile,
    wanted,
    opts.rulesRoot ?? opts.repo,
    reports,
  );

  // Delta: everything the base tree already produced is pre-existing. Range engines
  // (gitleaks) are inherently delta and deselect themselves without a base.
  let preExisting = 0;
  let baseErrors: EngineReport[] = [];
  let reminderCandidates: Finding[] = [];
  if (base && manifest) {
    const renames = manifestRenames(manifest);
    const baseScan = await baseFindingKeys(opts.repo, base, renames, (baseRepo, baseReports) =>
      runEngines(
        {
          repo: baseRepo,
          // renamed files exist at base only under their OLD names — scan those too
          files: [...files, ...renames.keys()].filter((f) => existsSync(join(baseRepo, f))),
        },
        profile,
        wanted,
        opts.rulesRoot ?? opts.repo,
        baseReports,
      ),
    );
    baseErrors = baseScan.errors;
    for (const f of findings) {
      // multiset consumption: a second identical bad line beyond the base count
      // is a genuinely introduced defect, not a pre-existing one
      f.provenance = consumeKey(baseScan.keys, await findingKey(opts.repo, f))
        ? "pre-existing"
        : "introduced";
    }
    if (opts.delta !== false) {
      const dropped = findings.filter((f) => f.provenance === "pre-existing");
      preExisting = dropped.length;
      findings.splice(0, findings.length, ...findings.filter((f) => f.provenance === "introduced"));
      // Pre-existing is dropped, never forgotten: a defect sitting next to the
      // changed lines gets re-surfaced as a reminder while someone is in there —
      // unless the profile explicitly says reminders: false, or a suppression
      // prices the class. (Owner ruling, 2026-08-21.)
      if (profile.reminders) {
        const hunks = manifestHunks(manifest);
        reminderCandidates = dropped.filter((f) => nearChange(hunks, f));
      }
    }
  } else {
    for (const f of findings) f.provenance = "introduced";
  }

  const { kept: afterProfile, suppressed: byProfile } = filterFindings(profile, findings);
  const memoryRepo = opts.memoryRepo ?? opts.repo;
  const { kept, suppressed: byMemory } = await applyMemory(memoryRepo, afterProfile, opts.repo);
  // reminders pass the same profile + memory suppression layers as findings
  const { kept: remindersAfterProfile } = filterFindings(profile, reminderCandidates);
  const { kept: reminders } = await applyMemory(memoryRepo, remindersAfterProfile, opts.repo);
  reminders.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const suppressed = [...byProfile, ...byMemory].sort((a, b) => a.rule.localeCompare(b.rule));
  kept.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const r of reports) {
    if (r.found === undefined) continue; // not-applicable / missing / error ran nothing
    r.kept = kept.filter((f) => f.engine === r.engine).length;
    r.status = r.kept > 0 ? "findings" : r.found > 0 ? "filtered" : "clean";
  }
  reports.sort((a, b) => a.engine.localeCompare(b.engine));
  return { findings: kept, engines: reports, suppressed, preExisting, baseErrors, reminders };
}
