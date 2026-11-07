import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Files where repositories document how their code should be reviewed. Leveret reads them from
 * the base commit only, so a reviewed change cannot rewrite the rules it is reviewed by.
 */
export const REVIEW_GUIDANCE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "CODING_STANDARDS.md",
  ".github/copilot-instructions.md",
  ".coderabbit.yaml",
  ".coderabbit.yml",
] as const;
export const GUIDANCE_FILE_MAX_BYTES = 16 * 1024;
export const GUIDANCE_TOTAL_MAX_BYTES = 48 * 1024;

/** Renders the guidance found under `root` for a phase contract, fenced and size-capped. */
export async function reviewGuidanceText(root: string): Promise<string> {
  const sections: string[] = [];
  let remaining = GUIDANCE_TOTAL_MAX_BYTES;
  for (const path of REVIEW_GUIDANCE_FILES) {
    const content = await readFile(join(root, path)).catch(() => undefined);
    if (content === undefined) continue;
    const shown = Math.min(content.length, GUIDANCE_FILE_MAX_BYTES, remaining);
    remaining -= shown;
    const label = shown < content.length ? `${path} (truncated to ${shown} of ${content.length} bytes)` : path;
    // Escape `<` so file text cannot close the fence and pose as contract text.
    const body = content.subarray(0, shown).toString("utf8").replaceAll("<", "&lt;");
    sections.push(`### ${label}\n<repository-guidance>\n${body}\n</repository-guidance>`);
    if (remaining === 0) break;
  }
  return sections.length > 0 ? sections.join("\n\n") : "No repository review guidance found at the base commit.";
}
