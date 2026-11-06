import { describe, expect, it } from "vitest";
import type { LabelRow } from "../bench/mine-labels.mjs";
import { matchFindings, stratifiedSample, type Candidate } from "../bench/mine.mjs";

const sha = (c: string) => c.repeat(40);
let nextId = 1;
function accepted(repository: string, pr: number, overrides: Partial<LabelRow> = {}): LabelRow {
  const id = nextId++;
  return {
    url: `https://github.com/${repository}/pull/${pr}#discussion_r${id}`, repository, pull_request: pr, bot: "coderabbitai[bot]", kind: "inline",
    path: "src/x.ts", line: 10, head_sha: sha("a"), category: "bug", disposition: "accepted", signals: ["fixed", "resolved"],
    label_source: "mechanical", judge: { model: "m", prompt_sha256: "d".repeat(64) }, duplicate_of: null, ...overrides,
  };
}

describe("stratifiedSample", () => {
  // Stratum A (o/a) has 5 PRs; strata B (o/b) and C (o/c) have one each.
  const rows = [
    ...[1, 2, 3, 4, 5].map((pr) => accepted("o/a", pr)),
    accepted("o/b", 1),
    accepted("o/c", 1, { category: "security" }),
    accepted("o/d", 1, { disposition: "rejected" }),
    accepted("o/e", 1, { duplicate_of: "https://github.com/o/a/pull/1#discussion_r1" }),
  ];

  it("takes one PR per stratum per round", async () => {
    const sample = await stratifiedSample(rows, 3, 4);
    const counts = sample.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.repository]: (acc[c.repository] ?? 0) + 1 }), {});
    expect(counts).toEqual({ "o/a": 2, "o/b": 1, "o/c": 1 });
    expect((await stratifiedSample(rows, 3, 4)).map((c) => `${c.repository}#${c.pull_request}`)).toEqual(sample.map((c) => `${c.repository}#${c.pull_request}`));
  });

  it("replaces an unusable PR from its own stratum", async () => {
    const rejectedB: Candidate[] = [];
    const twoB = [...rows, accepted("o/b", 2)];
    const sample = await stratifiedSample(twoB, 3, 3, async (c) => {
      if (c.repository === "o/b" && rejectedB.length === 0) {
        rejectedB.push(c);
        return false;
      }
      return true;
    });
    expect(sample.filter((c) => c.repository === "o/b")).toHaveLength(1);
    expect(sample.find((c) => c.repository === "o/b")!.pull_request).not.toBe(rejectedB[0]!.pull_request);
  });

  it("replays the commit with the most accepted findings, earliest on a tie", async () => {
    const pr = [
      accepted("o/z", 1, { head_sha: sha("1"), url: "https://github.com/o/z/pull/1#discussion_r50" }),
      accepted("o/z", 1, { head_sha: sha("2"), url: "https://github.com/o/z/pull/1#discussion_r20" }),
    ];
    const [tie] = await stratifiedSample(pr, 1, 1);
    expect(tie!.replay_head).toBe(sha("2"));
    expect(tie!.targets).toEqual(["https://github.com/o/z/pull/1#discussion_r20"]);
    const [most] = await stratifiedSample([...pr, accepted("o/z", 1, { head_sha: sha("1") })], 1, 1);
    expect(most!.replay_head).toBe(sha("1"));
    expect(most!.targets).toHaveLength(2);
  });
});

describe("matchFindings", () => {
  const target = { url: "u1", path: "src/x.ts", line: 12, start_line: 10, body: "B" };
  it("matches within the line window on the same path when the judge confirms", async () => {
    const yes = async () => true;
    expect(await matchFindings([target], [{ file: "src/x.ts", line: 15, title: "t" }], yes)).toEqual(["u1"]);
    expect(await matchFindings([target], [{ file: "src/x.ts", line: 7, title: "t" }], yes)).toEqual(["u1"]);
    expect(await matchFindings([target], [{ file: "src/x.ts", line: 16, title: "t" }], yes)).toEqual([]);
    expect(await matchFindings([target], [{ file: "src/y.ts", line: 12, title: "t" }], yes)).toEqual([]);
    expect(await matchFindings([target], [{ file: "src/x.ts", line: 12, title: "t" }], async () => false)).toEqual([]);
  });
});
