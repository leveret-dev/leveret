import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rulingsText } from "./memory.js";
import { reviewGuidanceText } from "./review-guidance.js";

// The agent contracts ship with the package (agents/*.md) and are served through
// MCP prompts, so any client can discover and run the pipeline without leveret
// shipping an orchestrator. Serving substitutes the repo's accumulated rulings
// (conventions + fingerprint reasons) into the contract, so the agents review
// WITH the repo's case law — the generalizing half of CodeRabbit-style learnings.

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

export const CONTRACTS = {
  review: "review.md",
  verify: "verify.md",
} as const;

export type ContractName = keyof typeof CONTRACTS;

export async function loadContract(
  name: ContractName,
  args: { repo: string; base: string; policyRoot?: string },
): Promise<string> {
  const raw = readFileSync(join(AGENTS_DIR, CONTRACTS[name]), "utf8");
  // The policy root holds the trusted rulings and review guidance: the base-commit copy when Leveret
  // runs a review, or the user's own checkout when the contract is served over MCP.
  const policyRoot = args.policyRoot ?? args.repo;
  const rulings = await rulingsText(policyRoot);
  const guidance = await reviewGuidanceText(policyRoot);
  const text = raw
    .replaceAll("{{REPO}}", args.repo)
    .replaceAll("{{BASE}}", args.base)
    .replaceAll("{{RULINGS}}", rulings)
    .replaceAll("{{GUIDANCE}}", guidance);
  const leftover = text.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`contract ${name}: unsubstituted placeholder ${leftover[0]}`);
  return text;
}
