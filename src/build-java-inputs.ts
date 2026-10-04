import { cp, mkdir, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { scopeResolver } from "./build-artifacts.js";
import type { BuildArtifact, BuildCompilation, BuildPathEntry, BuildPathSet } from "./build-evidence-contract.js";
import type { AdmittedBuildEvidence, BuildEvidenceAdmission, ScopeRole } from "./build-evidence.js";
import type { InspectJavaConfig } from "./inspect-java.js";

export type PreparedBuildArtifact = {
  manifestSha256: string;
  artifactId: string;
  origin: "authored" | "materialized" | "external";
};

export type PreparedJavaCompilation = {
  id: string;
  resolutionDomain: string;
  sourceSet: "main" | "test";
  files: readonly {
    physicalPath: string;
    displayPath: string;
    encoding: string;
    buildArtifact: PreparedBuildArtifact;
  }[];
  roots: readonly string[];
  sourcePath: readonly string[];
  classpath: readonly string[];
  compiler: {
    sourceLevel: string | null;
    targetLevel: string | null;
    encoding: string | null;
    preview: boolean | null;
    release: { state: "set" | "unset" | "unknown"; value: string | null };
    platform: Readonly<Record<string, string>>;
    usedModuleOptions: readonly string[] | null;
  };
  origins: readonly {
    path: string;
    artifact: PreparedBuildArtifact;
    ownerCompilationId: string | null;
  }[];
};

type CommonScope = {
  role: ScopeRole;
  compilationId: string | null;
  withheldRepositoryPaths: readonly string[];
};
export type BuildJavaScopeDecision = CommonScope & (
  | { outcome: "prepared"; compilationId: string; compilation: PreparedJavaCompilation }
  | { outcome: "fallback"; reason: string }
  | { outcome: "unavailable"; reason: string }
);
export type BuildJavaDecision = {
  /** Sandbox path. The private host path is admission.frozen.scratch/java-worker-view and is never serialized. */
  workerView: "/prepared";
  scopes: readonly [BuildJavaScopeDecision, BuildJavaScopeDecision];
};

const WORKER_VIEW = "/prepared" as const;
const workerLevel = /^(?:1\.[89]|[9]|1[0-9]|2[0-5])$/;

function citation(admission: AdmittedBuildEvidence, artifact: BuildArtifact): PreparedBuildArtifact {
  return { manifestSha256: admission.manifestSha256, artifactId: artifact.id, origin: artifact.origin };
}

function exportCompilationId(admission: AdmittedBuildEvidence, compilationId: string): string {
  return `export:${admission.manifestSha256}:${compilationId}`;
}

function usedModuleOptions(compilation: BuildCompilation): string[] | null {
  const options = compilation.compiler.moduleOptions;
  if (options === null) return null;
  const used: string[] = [];
  if (options.sourcePath.state !== "complete" || options.sourcePath.entries.length > 0) used.push("source-path");
  if (options.bootClasspath.state !== "complete" || options.bootClasspath.entries.length > 0) used.push("boot-classpath");
  if (options.addReads === null || options.addReads.length > 0) used.push("add-reads");
  if (options.addExports === null || options.addExports.length > 0) used.push("add-exports");
  if (options.patchModules === null || options.patchModules.length > 0) used.push("patch-module");
  if (options.addModules === null || options.addModules.length > 0) used.push("add-modules");
  if (options.limitModules === null || options.limitModules.length > 0) used.push("limit-modules");
  return used;
}

function unsupportedReason(compilation: BuildCompilation, config: InspectJavaConfig): string | null {
  if (compilation.inventory.state !== "complete") return "incomplete-inventory";
  if (compilation.compileClasspath.state !== "complete") return "incomplete-classpath";
  if (compilation.modulePath.state !== "complete" || compilation.modulePath.entries.length > 0) return "unsupported-module-path";
  const compiler = compilation.compiler;
  if (compiler.release.state !== "unset") return "unsupported-release";
  if (!compiler.sourceLevel || !compiler.targetLevel || !workerLevel.test(compiler.sourceLevel) || !workerLevel.test(compiler.targetLevel)) {
    return "unsupported-language-level";
  }
  if (!compiler.encoding || !/^utf-?8$/i.test(compiler.encoding)) return "unsupported-encoding";
  if (compiler.preview !== false) return "unsupported-preview";
  const used = usedModuleOptions(compilation);
  if (used === null || used.length > 0) return "unsupported-module-options";
  if (compiler.platform.state !== "identified") return "unsupported-platform";
  const fingerprints = Object.fromEntries(compiler.platform.fingerprints.map((item) => [item.name, item.sha256]));
  if (!fingerprints.modules) return "unsupported-platform";
  for (const [name, hash] of Object.entries(fingerprints)) {
    if (config.jdkFiles[name === "modules" ? "lib/modules" : name === "ct.sym" ? "lib/ct.sym" : name] !== hash) {
      return "unsupported-platform";
    }
  }
  return null;
}

function unavailableArtifact(admission: AdmittedBuildEvidence, id: string): "artifact-rejected" | "artifact-withheld" | "artifact-unavailable" | null {
  const status = admission.artifacts.get(id);
  if (!status || status.state === "rejected") return "artifact-rejected";
  if (status.state === "withheld") return "artifact-withheld";
  return status.state === "available" ? null : "artifact-unavailable";
}

function entriesProblem(admission: AdmittedBuildEvidence, set: BuildPathSet): string | null {
  for (const entry of set.entries) {
    const problem = unavailableArtifact(admission, entry.artifactId);
    if (problem) return problem;
    const frozen = admission.frozen.available.get(entry.artifactId);
    if (!frozen || (frozen.artifact.role !== "classes" && frozen.artifact.role !== "dependency")) return "artifact-unavailable";
  }
  return null;
}

function scopeWithheldPaths(admission: AdmittedBuildEvidence, compilationId: string | null): string[] {
  if (compilationId === null) return [];
  const scopesOf = scopeResolver(admission.manifest);
  const paths = new Set<string>();
  const artifacts = new Map(admission.manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const producers = new Map<string, string[]>();
  for (const transformation of admission.manifest.transformations) {
    for (const output of transformation.outputArtifactIds) {
      const inputs = producers.get(output);
      if (inputs) inputs.push(...transformation.inputArtifactIds);
      else producers.set(output, [...transformation.inputArtifactIds]);
    }
  }
  for (const artifact of admission.manifest.artifacts) {
    if (admission.artifacts.get(artifact.id)?.state !== "withheld" || !scopesOf(artifact.id).includes(compilationId)) continue;
    const seen = new Set<string>();
    const pending = [artifact.id];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const repositoryPath = artifacts.get(id)?.repositoryPath;
      if (repositoryPath !== null && repositoryPath !== undefined) paths.add(repositoryPath);
      pending.push(...(producers.get(id) ?? []));
    }
  }
  return [...paths].sort();
}

function fallbackScopes(admission: Exclude<BuildEvidenceAdmission, AdmittedBuildEvidence>): BuildJavaDecision {
  const reason = admission.outcome === "rejected" ? admission.reason : "unconfigured";
  const productionId = admission.outcome === "rejected" ? admission.selection.productionId : null;
  const testId = admission.outcome === "rejected" ? admission.selection.testId : null;
  return {
    workerView: WORKER_VIEW,
    scopes: [
      { role: "production", compilationId: productionId, outcome: "fallback", reason, withheldRepositoryPaths: [] },
      admission.outcome === "rejected" && testId === null
        ? { role: "test", compilationId: null, outcome: "unavailable", reason: "not-requested", withheldRepositoryPaths: [] }
        : { role: "test", compilationId: testId, outcome: "fallback", reason, withheldRepositoryPaths: [] },
    ],
  };
}

async function copyArtifact(
  admission: AdmittedBuildEvidence,
  entry: BuildPathEntry,
  artifactIndex: ReadonlyMap<string, number>,
  staged: Set<string>,
  stagingRoot: string,
): Promise<{ path: string; artifact: BuildArtifact }> {
  const index = artifactIndex.get(entry.artifactId);
  const frozen = admission.frozen.available.get(entry.artifactId);
  if (index === undefined || !frozen) throw new Error("prepared artifact disappeared after admission");
  const relative = `artifacts/${index}`;
  if (!staged.has(entry.artifactId)) {
    await cp(frozen.path, join(stagingRoot, relative), { recursive: frozen.artifact.kind === "directory", force: false, errorOnExist: true });
    staged.add(entry.artifactId);
  }
  return { path: `${WORKER_VIEW}/${relative}`, artifact: frozen.artifact };
}

/** Normalizes one immutable export into the exact Task 4 JVM input, or selects coherent legacy fallback per role. */
export async function prepareBuildJavaInputs(admission: BuildEvidenceAdmission, config: InspectJavaConfig): Promise<BuildJavaDecision> {
  if (admission.outcome !== "admitted") return fallbackScopes(admission);
  const stagingRoot = join(admission.frozen.scratch, "java-worker-view");
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(join(stagingRoot, "sources"), { recursive: true, mode: 0o700 });
  await mkdir(join(stagingRoot, "artifacts"), { recursive: true, mode: 0o700 });
  const compilationById = new Map(admission.manifest.compilations.map((item) => [item.id, item]));
  const compilationIndex = new Map(admission.manifest.compilations.map((item, index) => [item.id, index]));
  const artifactById = new Map(admission.manifest.artifacts.map((item) => [item.id, item]));
  const artifactIndex = new Map(admission.manifest.artifacts.map((item, index) => [item.id, index]));
  const staged = new Set<string>();

  const decide = async (role: ScopeRole): Promise<BuildJavaScopeDecision> => {
    const scope = admission.scopes.find((item) => item.role === role)!;
    const withheldRepositoryPaths = scopeWithheldPaths(admission, scope.compilationId);
    const common = { role, compilationId: scope.compilationId, withheldRepositoryPaths };
    if (scope.state === "not-requested") return { ...common, outcome: "unavailable", reason: "not-requested" };
    if (scope.state !== "selected") return { ...common, outcome: "fallback", reason: scope.reasons[0] ?? scope.state };
    const compilation = compilationById.get(scope.compilationId!);
    if (!compilation) return { ...common, outcome: "fallback", reason: "compilation-not-found" };
    const unsupported = unsupportedReason(compilation, config) ?? entriesProblem(admission, compilation.compileClasspath);
    if (unsupported) return { ...common, outcome: "fallback", reason: unsupported };
    for (const id of compilation.inputArtifactIds) {
      const problem = unavailableArtifact(admission, id);
      if (problem) return { ...common, outcome: "fallback", reason: problem };
      const source = artifactById.get(id);
      if (!source || source.availability !== "available" || source.kind !== "file" || source.role !== "source") {
        return { ...common, outcome: "fallback", reason: "artifact-unavailable" };
      }
      if (!source.encoding || !/^utf-?8$/i.test(source.encoding)) {
        return { ...common, outcome: "fallback", reason: "unsupported-encoding" };
      }
    }

    const roots = admission.frozen.sourceRoots.get(compilation.id);
    if (!roots || roots.length !== compilation.sourceRoots.length) return { ...common, outcome: "fallback", reason: "artifact-unavailable" };
    const preparedRoots: string[] = [];
    const files: PreparedJavaCompilation["files"][number][] = [];
    for (const [rootIndex, root] of roots.entries()) {
      const relativeRoot = `sources/${compilationIndex.get(compilation.id)!}/${rootIndex}`;
      await cp(root.path, join(stagingRoot, relativeRoot), { recursive: true, force: false, errorOnExist: true });
      preparedRoots.push(`${WORKER_VIEW}/${relativeRoot}`);
      const declared = compilation.sourceRoots[rootIndex]!;
      for (const member of declared.members) {
        const artifact = artifactById.get(member.artifactId);
        if (!artifact || artifact.availability !== "available" || artifact.kind !== "file" || artifact.role !== "source") {
          return { ...common, outcome: "fallback", reason: "artifact-unavailable" };
        }
        const displayPath = artifact.repositoryPath ?? (declared.repositoryPath
          ? posix.join(declared.repositoryPath, member.relativePath)
          : posix.join("build-artifacts", String(artifactIndex.get(artifact.id)!), member.relativePath));
        files.push({
          physicalPath: `${WORKER_VIEW}/${relativeRoot}/${member.relativePath}`,
          displayPath, encoding: artifact.encoding ?? "", buildArtifact: citation(admission, artifact),
        });
      }
    }

    const classpath: string[] = [];
    const origins: PreparedJavaCompilation["origins"][number][] = [];
    for (const entry of compilation.compileClasspath.entries) {
      const copied = await copyArtifact(admission, entry, artifactIndex, staged, stagingRoot);
      classpath.push(copied.path);
      origins.push({
        path: copied.path, artifact: citation(admission, copied.artifact),
        ownerCompilationId: entry.upstreamCompilationId === null ? null : exportCompilationId(admission, entry.upstreamCompilationId),
      });
    }
    const compiler = compilation.compiler;
    const environment = {
      sourceLevel: compiler.sourceLevel, targetLevel: compiler.targetLevel, encoding: compiler.encoding, preview: compiler.preview,
      release: compiler.release, platform: Object.fromEntries(compiler.platform.state === "identified"
        ? compiler.platform.fingerprints.map((item) => [item.name, item.sha256]) : []), usedModuleOptions: usedModuleOptions(compilation),
    };
    return {
      ...common, outcome: "prepared", compilationId: compilation.id,
      compilation: {
        id: exportCompilationId(admission, compilation.id), resolutionDomain: `build:${admission.manifestSha256}:${compilation.id}`,
        sourceSet: role === "production" ? "main" : "test", files, roots: preparedRoots,
        sourcePath: preparedRoots, classpath, compiler: environment, origins,
      },
    };
  };

  return { workerView: WORKER_VIEW, scopes: [await decide("production"), await decide("test")] };
}
