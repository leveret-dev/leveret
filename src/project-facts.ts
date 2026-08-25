import { extname } from "node:path";
import { run, safeChildEnvironment } from "./exec.js";

export interface ProjectFacts {
  trackedFiles: number;
  languages: { language: string; files: number }[];
  buildSystems: { name: string; evidence: string[] }[];
  frameworks: { name: string; evidence: string[] }[];
  sourceRoots: string[];
  testRoots: string[];
  manifests: string[];
  manifestErrors: string[];
  truncated: { manifests: boolean; roots: boolean };
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".go": "Go",
  ".html": "HTML",
  ".inc": "PHP",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".sh": "Shell",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".vue": "Vue",
};

const BUILD_MARKERS: Record<string, string> = {
  "Cargo.toml": "Cargo",
  "Gemfile": "Bundler",
  "Package.swift": "Swift Package Manager",
  "build.gradle": "Gradle",
  "build.gradle.kts": "Gradle",
  "bun.lock": "Bun",
  "composer.json": "Composer",
  "go.mod": "Go modules",
  "package-lock.json": "npm",
  "package.json": "Node package",
  "pnpm-lock.yaml": "pnpm",
  "pom.xml": "Maven",
  "pyproject.toml": "Python/PEP 517",
  "uv.lock": "uv",
  "yarn.lock": "Yarn",
};

const NODE_FRAMEWORK_PACKAGES: Record<string, string[]> = {
  "Angular": ["@angular/core"],
  "Express": ["express"],
  "Next.js": ["next"],
  "React": ["react"],
  "Svelte": ["svelte"],
  "Vue": ["vue"],
};

const TEXT_FRAMEWORK_MARKERS: Record<string, string[]> = {
  "Android": ["com.android.application", "com.android.library"],
  "Django": ["django"],
  "FastAPI": ["fastapi"],
  "Flask": ["flask"],
  "Micronaut": ["io.micronaut"],
  "Quarkus": ["io.quarkus"],
  "Spring Boot": ["org.springframework.boot", "spring-boot"],
};

const TEXT_FRAMEWORK_MANIFESTS = new Set(["Gemfile", "build.gradle", "build.gradle.kts", "composer.json", "pom.xml", "pyproject.toml"]);

const MANIFEST_NAMES = new Set([...Object.keys(BUILD_MARKERS), "settings.gradle", "settings.gradle.kts"]);
const MAX_MANIFESTS = 50;
const MAX_ROOTS = 50;

function rootCandidates(files: string[], test: boolean): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index]!;
      const matches = test
        ? part === "test" || part === "tests" || part === "spec" || part === "__tests__" || (part === "src" && parts[index + 1] === "test")
        : (part === "src" && parts[index + 1] !== "test") || part === "app" || part === "lib";
      if (!matches) continue;
      const end = part === "src" && (parts[index + 1] === "main" || parts[index + 1] === "test") ? index + 2 : index + 1;
      roots.add(parts.slice(0, end).join("/"));
      break;
    }
  }
  return [...roots].sort();
}

/** Derive bounded project orientation from tracked paths and dependency manifests. */
export async function projectFacts(repo: string): Promise<ProjectFacts> {
  const listed = await run("git", ["ls-files", "-z"], repo, {
    timeoutMs: 60_000,
    env: safeChildEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr.slice(0, 500)}`);
  const files = listed.stdout.split("\0").filter(Boolean);
  const languageCounts: Record<string, number> = {};
  for (const file of files) {
    if (MANIFEST_NAMES.has(file.split("/").at(-1)!)) continue;
    const language = LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()];
    if (language) languageCounts[language] = (languageCounts[language] ?? 0) + 1;
  }

  const allManifests = files.filter((file) => MANIFEST_NAMES.has(file.split("/").at(-1)!)).sort();
  const manifests = allManifests.slice(0, MAX_MANIFESTS);
  const buildEvidence: Record<string, string[]> = {};
  const frameworkEvidence: Record<string, string[]> = {};
  const manifestErrors: string[] = [];
  await Promise.all(manifests.map(async (file) => {
    const name = file.split("/").at(-1)!;
    const buildSystem = BUILD_MARKERS[name];
    if (buildSystem) (buildEvidence[buildSystem] ??= []).push(file);
    const shown = await run("git", ["show", `HEAD:${file}`], repo, {
      timeoutMs: 10_000,
      env: safeChildEnvironment(),
      maxBuffer: 1024 * 1024,
    });
    if (shown.code !== 0) {
      manifestErrors.push(file);
      return;
    }
    const content = shown.stdout;
    if (name === "package.json") {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const dependencies = new Set<string>();
        for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const values = parsed[section];
          if (values && typeof values === "object" && !Array.isArray(values)) {
            for (const dependency of Object.keys(values)) dependencies.add(dependency);
          }
        }
        for (const [framework, packages] of Object.entries(NODE_FRAMEWORK_PACKAGES)) {
          if (packages.some((dependency) => dependencies.has(dependency))) (frameworkEvidence[framework] ??= []).push(file);
        }
      } catch {
        manifestErrors.push(file);
      }
    } else if (TEXT_FRAMEWORK_MANIFESTS.has(name)) {
      for (const [framework, markers] of Object.entries(TEXT_FRAMEWORK_MARKERS)) {
        if (markers.some((marker) => content.toLowerCase().includes(marker.toLowerCase()))) {
          (frameworkEvidence[framework] ??= []).push(file);
        }
      }
    }
  }));

  const allSourceRoots = rootCandidates(files, false);
  const allTestRoots = rootCandidates(files, true);
  return {
    trackedFiles: files.length,
    languages: Object.entries(languageCounts)
      .map(([language, count]) => ({ language, files: count }))
      .sort((left, right) => right.files - left.files || left.language.localeCompare(right.language)),
    buildSystems: Object.entries(buildEvidence).map(([name, evidence]) => ({ name, evidence: evidence.sort() })).sort((left, right) => left.name.localeCompare(right.name)),
    frameworks: Object.entries(frameworkEvidence).map(([name, evidence]) => ({ name, evidence: evidence.sort() })).sort((left, right) => left.name.localeCompare(right.name)),
    sourceRoots: allSourceRoots.slice(0, MAX_ROOTS),
    testRoots: allTestRoots.slice(0, MAX_ROOTS),
    manifests,
    manifestErrors: manifestErrors.sort(),
    truncated: {
      manifests: allManifests.length > MAX_MANIFESTS,
      roots: allSourceRoots.length > MAX_ROOTS || allTestRoots.length > MAX_ROOTS,
    },
  };
}
