import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BuildEvidenceInputError, buildEvidenceSchema, parseBuildEvidence } from "../src/build-evidence-contract.js";
import {
  FIXTURE_MODES, FIXTURE_REPOSITORY_ID, FIXTURE_SECRET_MARKER, createBuildFixture, fixtureGit, fixtureRequest,
  fixtureSelectedArtifacts, runFixtureExporter, type BuildFixture, type BuildFixtureMode,
} from "./build-evidence-fixture.js";

// Manifests are mutated as loose JSON on purpose: every case must stay otherwise valid, so a rejection
// can only come from the single violation the case introduces (never from a broken harness shape).
type Json = any;
type Case = [label: string, mutate: (m: Json) => void, source?: BuildFixtureMode];

let home: string;
const fx = {} as Record<BuildFixtureMode, BuildFixture>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "leveret-build-evidence-"));
  await Promise.all(FIXTURE_MODES.map(async (mode) => { fx[mode] = await createBuildFixture(join(home, mode), mode); }));
}, 180_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const text = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? []).toString("utf8");
const blob = (repo: string, revision: string, path: string) =>
  execFileSync("git", ["-C", repo, "cat-file", "blob", `${revision}:${path}`], { maxBuffer: 64 << 20 });
const art = (m: Json, id: string): Json => m.artifacts.find((a: Json) => a.id === id);
const comp = (m: Json, id: string): Json => m.compilations.find((c: Json) => c.id === id);
const byUtf8 = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(join(dir, entry.name), path) : [path];
  }).sort(byUtf8);
}

/** Text covered by a single-line range (one-based lines, zero-based UTF-16 columns, exclusive end). */
function sliced(source: string, range: Json): string {
  expect(range.end.line).toBe(range.start.line);
  return source.split("\n")[range.start.line - 1].slice(range.start.column, range.end.column);
}

function encode(mutate: (m: Json) => void, source: BuildFixtureMode = "valid"): Buffer {
  const m = structuredClone(fx[source].manifests.head) as Json;
  mutate(m);
  return Buffer.from(JSON.stringify(m));
}

function rejection(bytes: Uint8Array): BuildEvidenceInputError {
  let thrown: unknown;
  try { parseBuildEvidence(bytes); } catch (error) { thrown = error; }
  expect(thrown, "manifest was accepted").toBeInstanceOf(BuildEvidenceInputError);
  const error = thrown as BuildEvidenceInputError;
  expect(error.code).toBe("invalid-input");
  expect(error.safeReason.length).toBeGreaterThan(0);
  return error;
}

/** An accepted manifest is returned exactly as written: nothing coerced, dropped, defaulted or reordered. */
function accepted(bytes: Uint8Array): Json {
  const parsed = parseBuildEvidence(bytes);
  expect(parsed).toEqual(JSON.parse(Buffer.from(bytes).toString("utf8")));
  return parsed;
}

function unavailable(a: Json, availability = "missing"): void {
  for (const key of ["content", "encoding", "location", "entries"]) delete a[key];
  a.availability = availability;
  a.reason = "bytes are not available";
}

const HASH = "a".repeat(64);
const extra = (m: Json, record: Json) => { m.artifacts.push({ id: "extra", ...record }); };
const payloadFile = (path: string, sha: string, size: number) => ({
  kind: "file", role: "resource", origin: "materialized", repositoryPath: null, availability: "available",
  content: { location: { kind: "payload", path }, sha256: sha, sizeBytes: size }, encoding: null,
});
const payloadDir = (path: string, entries: Json[]) => ({
  kind: "directory", role: "classes", origin: "materialized", repositoryPath: null, availability: "available",
  location: { kind: "payload", path }, entries,
});
const entriesNamed = (...paths: string[]) => paths.map((path) => ({ path, sha256: HASH, sizeBytes: 1 }));
const pathEntry = { artifactId: "consumer-original", coordinates: null, upstreamCompilationId: null };

describe("strict manifest decoding", () => {
  it("accepts the exact bytes a client export command published and keeps every field", () => {
    for (const side of ["base", "head"] as const) {
      const bytes = readFileSync(fx.valid.pins[side].manifestPath);
      expect(parseBuildEvidence(bytes)).toEqual(fx.valid.manifests[side]);
      expect(parseBuildEvidence(new Uint8Array(bytes))).toEqual(fx.valid.manifests[side]);
    }
    expect(buildEvidenceSchema.parse(fx.valid.manifests.head)).toEqual(fx.valid.manifests.head);
    expect(buildEvidenceSchema.safeParse({ ...fx.valid.manifests.head, extra: true }).success).toBe(false);
  });

  it("preserves compilation IDs, source-set roles and upstream path entries as written", () => {
    const validBytes = Buffer.from(JSON.stringify(fx.valid.manifests.head));
    const parsed = parseBuildEvidence(validBytes);
    expect(parsed.compilations[0].moduleDir).toBe(".");
    expect(parsed.compilations[0].compiler.release).toEqual({ state: "unset", value: null });
    expect(parsed.compilations.map((c) => [c.id, c.sourceSetRole])).toEqual([["prod", "production"], ["test", "test"]]);
    expect(parsed.compilations[1].compileClasspath.entries).toEqual([{ artifactId: "prod-classes", coordinates: null, upstreamCompilationId: "prod" }]);
  });

  describe("duplicate JSON keys with an otherwise valid manifest", () => {
    const duplicated = (needle: string, replacement: string) => {
      const valid = JSON.stringify(fx.valid.manifests.head);
      expect(valid).toContain(needle);
      return Buffer.from(valid.replace(needle, () => replacement));
    };
    it.each([
      ["top-level key", '"schema":', '"schema":"leveret.build-evidence/v1","schema":'],
      ["nested key", '"id":"prod"', '"id":"prod","id":"prod"'],
      ["escaped duplicate of a plain key", '"id":"prod"', '"id":"prod","\\u0069d":"prod"'],
      ["plain duplicate of an escaped key", '"id":"prod"', '"\\u0069d":"prod","id":"prod"'],
      ["key deep inside a compilation", '"platform":{"state":"identified"', '"platform":{"state":"identified","state":"identified"'],
      ["key inside an object in an array", '{"path":"example/Consumer.class"', '{"path":"example/Consumer.class","path":"example/Consumer.class"'],
    ])("rejects a duplicated %s", (_label, needle, replacement) => {
      const bytes = duplicated(needle, replacement);
      // JSON.parse alone accepts these (last key wins) and the value is valid, so only a
      // duplicate-aware decoder can reject them.
      expect(() => JSON.parse(bytes.toString("utf8"))).not.toThrow();
      rejection(bytes);
    });
  });

  describe("duplicate detection is not confused by string content", () => {
    const head = () => structuredClone(fx.valid.manifests.head) as Json;
    const runIdMember = (m: Json) => `"runId":${JSON.stringify(m.producer.runId)}`;
    /** Serializes `m`, then splices raw object members into producer right after its last key. */
    const withMembers = (m: Json, raw: string) => {
      const json = JSON.stringify(m);
      expect(json).toContain(runIdMember(m));
      return Buffer.from(json.replace(runIdMember(m), () => `${runIdMember(m)},${raw}`));
    };
    /** Doubles producer.runId and the top-level context (after producer); every duplicate repeats its valid value. */
    const withRealDuplicates = (m: Json) => {
      const context = `"context":${JSON.stringify(m.context)}`;
      const json = JSON.stringify(m);
      expect(json).toContain(context);
      return Buffer.from(json
        .replace(runIdMember(m), () => `${runIdMember(m)},${runIdMember(m)}`)
        .replace(context, () => `${context},${context}`));
    };
    /**
     * Unknown keys are schema errors too, so reasons tell the two rejections apart: the same position
     * and a different cause must produce a different safe reason, and equal causes an equal one.
     */
    const reasons = () => {
      const duplicate = rejection(withMembers(head(), '"zz":1,"zz":1')).safeReason;
      const unknown = rejection(withMembers(head(), '"zz":1')).safeReason;
      expect(unknown, "control: a single unknown key is a schema rejection, not a duplicate").not.toBe(duplicate);
      return { duplicate, unknown };
    };

    it.each([
      ["both spelled with an escaped quote", String.raw`"a\"b":1,"a\"b":1`],
      ["escaped quote and its \\u0022 spelling", String.raw`"a\"b":1,"a\u0022b":1`],
      ["\\u0022 spelling and the escaped quote", String.raw`"a\u0022b":1,"a\"b":1`],
      ["a key that is a single escaped quote", String.raw`"\"":1,"\"":1`],
      ["a key ending in an escaped backslash", String.raw`"a\\":1,"a\\":1`],
      ["a key ending in an escaped backslash and quote", String.raw`"a\\\"":1,"a\\\"":1`],
    ])("rejects a duplicate key whose decoded name has a quote or backslash: %s", (_label, raw) => {
      const { duplicate } = reasons();
      expect(rejection(withMembers(head(), raw)).safeReason).toBe(duplicate);
    });

    it.each([
      ["one escaped backslash", "ends\\"],
      ["two escaped backslashes", "ends\\\\"],
      ["an escaped backslash then an escaped quote", 'ends\\"'],
      ["only a backslash", "\\"],
    ])("rejects real duplicates after a string value ending with %s before its closing quote", (_label, name) => {
      const m = head();
      m.producer.name = name;
      const bytes = withRealDuplicates(m);
      expect(bytes.toString("utf8")).toContain(JSON.stringify(name));
      expect(JSON.parse(bytes.toString("utf8")).producer.name, "the value itself is valid text").toBe(name);
      expect(rejection(bytes).safeReason).toBe(reasons().duplicate);
      // Control: with no duplicates the same value is an ordinary, valid manifest.
      accepted(Buffer.from(JSON.stringify(m)));
    });

    const structural = '{"id":1,"id":2}';
    const noisy = 'a,b]c}d[e{f:g"h\\i';
    const stringy = (m: Json) => {
      m.producer.name = structural;
      m.producer.version = noisy;
      m.producer.buildTool.name = "]},[{";
      m.context.profiles = [structural, noisy, "[", "}", ","];
      m.context.variant = { state: "set", value: '{"a":1,"a":2}' };
      m.diagnostics.push({ code: noisy, message: `x":1,"x":2,"${structural}`, compilationId: null, artifactIds: [] });
    };

    it("accepts structural-looking text inside string values as ordinary text", () => {
      const m = head();
      stringy(m);
      const parsed = accepted(Buffer.from(JSON.stringify(m)));
      expect(parsed.producer.name).toBe(structural);
      expect(parsed.producer.version).toBe(noisy);
      expect(parsed.context.profiles).toEqual([structural, noisy, "[", "}", ","]);
      expect(parsed.diagnostics[0].message).toBe(`x":1,"x":2,"${structural}`);
    });

    it.each([structural, noisy, "a,b", "]", "[", "}{", '"id":1,"id":2', "id"])(
      "does not mistake a key containing structural text %j for a duplicate", (key) => {
        const { unknown } = reasons();
        expect(rejection(withMembers(head(), `${JSON.stringify(key)}:1`)).safeReason).toBe(unknown);
        // Two different keys whose text contains each other's syntax are still two keys.
        expect(rejection(withMembers(head(), `${JSON.stringify(key)}:1,${JSON.stringify(`${key}.`)}:1`)).safeReason).toBe(unknown);
      });

    it("rejects real duplicates that follow structural text inside strings", () => {
      const m = head();
      stringy(m);
      const bytes = withRealDuplicates(m);
      expect(() => JSON.parse(bytes.toString("utf8"))).not.toThrow();
      expect(rejection(bytes).safeReason).toBe(reasons().duplicate);
      accepted(Buffer.from(JSON.stringify(m)));
    });

    it("rejects a real duplicate that follows a key made of structural text", () => {
      const { duplicate } = reasons();
      const key = JSON.stringify(structural);
      expect(rejection(withMembers(head(), `${key}:1,"zz":1,"zz":1`)).safeReason).toBe(duplicate);
      expect(rejection(withMembers(head(), `${key}:1,${key}:1`)).safeReason).toBe(duplicate);
    });
  });

  describe("JSON grammar and encoding", () => {
    const valid = () => Buffer.from(JSON.stringify(fx.valid.manifests.head));
    it("accepts trailing JSON whitespace but no trailing content", () => {
      accepted(Buffer.concat([valid(), Buffer.from(" \t\r\n")]));
      for (const trailing of ["{}", ",", " 0", "\u0000", JSON.stringify(fx.valid.manifests.head)]) {
        rejection(Buffer.concat([valid(), Buffer.from(trailing)]));
      }
    });
    it.each<[string, () => Buffer]>([
      ["empty input", () => Buffer.alloc(0)],
      ["truncated document", () => Buffer.from('{"schema":"leveret.build-evidence/v1"')],
      ["array root", () => Buffer.from("[]")],
      ["null root", () => Buffer.from("null")],
      ["string root", () => Buffer.from('"leveret.build-evidence/v1"')],
      ["single quotes", () => Buffer.from("{'schema':'leveret.build-evidence/v1'}")],
      ["trailing comma", () => Buffer.from(JSON.stringify(fx.valid.manifests.head).replace(/\}$/, ",}"))],
      ["raw newline inside a string", () => Buffer.from(JSON.stringify(fx.valid.manifests.head).replace('"fixture"', '"fix\nture"'))],
    ])("rejects %s", (_label, bytes) => { rejection(bytes()); });

    it.each([
      ["a lone continuation byte", [0xff]],
      ["an overlong encoding", [0xc0, 0xaf]],
      ["an encoded surrogate", [0xed, 0xa0, 0x80]],
      ["a truncated multibyte sequence", [0xe2, 0x82]],
    ])("rejects invalid UTF-8: %s", (_label, bytes) => {
      const marker = "@@BYTES@@";
      const m = structuredClone(fx.valid.manifests.head) as Json;
      m.producer.name = marker;
      const [before, after] = JSON.stringify(m).split(marker);
      rejection(Buffer.concat([Buffer.from(before), Buffer.from(bytes), Buffer.from(after)]));
    });

    it("accepts exactly one leading byte-order mark and non-ASCII text", () => {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      expect(parseBuildEvidence(Buffer.concat([bom, valid()]))).toEqual(fx.valid.manifests.head);
      rejection(Buffer.concat([bom, bom, valid()]));
      const parsed = accepted(encode((m) => { m.producer.name = "exporteur-é-日本-𝒳"; }));
      expect(parsed.producer.name).toBe("exporteur-é-日本-𝒳");
    });

    describe("numeric tokens are exact safe integers, whatever their spelling", () => {
      const MARK = 424242424242;
      const MAX = Number.MAX_SAFE_INTEGER;
      type Target = [label: string, set: (m: Json) => void, get: (m: Json) => number, minimum: number];
      const targets: Target[] = [
        ["file size", (m) => { art(m, "pricing-output").content.sizeBytes = MARK; }, (m) => art(m, "pricing-output").content.sizeBytes, 0],
        ["source-map line", (m) => { m.transformations[0].locations[0].inputRange.start.line = MARK; }, (m) => m.transformations[0].locations[0].inputRange.start.line, 1],
        ["source-map column", (m) => { m.transformations[0].locations[0].outputRange.end.column = MARK; }, (m) => m.transformations[0].locations[0].outputRange.end.column, 0],
      ];
      /** Manifest bytes with the target number written as a raw JSON token, exactly as a client may spell it. */
      const spelled = (set: (m: Json) => void, token: string) => {
        const json = encode(set).toString("utf8");
        expect(json.split(String(MARK)), "the marker occurs exactly once").toHaveLength(2);
        return Buffer.from(json.replace(String(MARK), () => token));
      };

      const exact: [token: string, value: number][] = [
        ["1e2", 100], ["1.0", 1], ["10E+1", 100], ["1.50e2", 150], ["1500e-1", 150], ["2e0", 2], ["0.1e1", 1],
        [String(MAX), MAX], [`${MAX}.000`, MAX], [`${MAX}0e-1`, MAX],
      ];
      it.each(targets.flatMap(([label, set, get]) => exact.map(([token, value]) => ({ label, set, get, token, value }))))(
        "accepts the exact safe-integer spelling $token (= $value) for a $label", ({ set, get, token, value }) => {
          expect(get(accepted(spelled(set, token)))).toBe(value);
        });

      const zero = ["0", "0.0", "-0", "-0.0", "0e5", "0e-5", "0.000e+9", "-0e0"];
      it.each(targets.filter(([, , , minimum]) => minimum === 0).flatMap(([label, set, get]) => zero.map((token) => ({ label, set, get, token }))))(
        "accepts the zero spelling $token for a $label", ({ set, get, token }) => {
          // -0 is an exact zero; adding +0 only normalizes the sign for the comparison.
          expect(get(accepted(spelled(set, token))) + 0).toBe(0);
        });
      it.each(zero)("rejects the zero spelling %s for a one-based line", (token) => {
        rejection(spelled(targets[1][1], token));
      });

      // `premise` is what the standard parser turns the token into: it hides the fraction or exponent,
      // so only a lexical check of the original token can tell these from valid integers.
      const inexact: [token: string, premise: number | null][] = [
        ["12.00000000000000001", 12], [`${MAX}.0000000001`, MAX], ["1.00000000000000000000001e1", 10],
        ["100000000000000000000000001e-26", 1], ["12e-999999999999", 0], ["1e-400", 0], ["-1e-400", -0],
        ["12.5", null], ["1.5e0", null], ["1e-1", null], ["25e-1", null], ["-1", null], ["-12", null], ["-0.5", null], ["-1e0", null],
        ["9007199254740992", null], ["9007199254740993", null], ["1e16", null], ["1.5e16", null], ["1e400", null], ["12e999999999999", null],
      ];
      it.each(targets.flatMap(([label, set]) => inexact.map(([token, premise]) => ({ label, set, token, premise }))))(
        "rejects the non-integer, negative or unsafe token $token for a $label", ({ set, token, premise }) => {
          if (premise !== null) expect(Object.is(JSON.parse(token), premise), "the standard parser hides this value").toBe(true);
          rejection(spelled(set, token));
        });
    });
  });

  describe("errors never echo raw values", () => {
    const marker = "LEVERET-RAW-MARKER-5d1c";
    const validBytes = () => Buffer.from(JSON.stringify(fx.valid.manifests.head));
    const cases: [string, () => Buffer][] = [
      ["unknown field name", () => encode((m) => { m.producer[marker] = 1; })],
      ["invalid enum value", () => encode((m) => { art(m, "pricing-output").role = marker; })],
      ["invalid path", () => encode((m) => { art(m, "pricing-output").repositoryPath = `../${marker}`; })],
      ["unresolved reference", () => encode((m) => { m.diagnostics.push({ code: "c", message: "m", compilationId: marker, artifactIds: [] }); })],
      ["duplicate record ID", () => encode((m) => { m.artifacts[0].id = marker; m.artifacts.push(structuredClone(m.artifacts[0])); })],
      ["wrong type", () => encode((m) => { m.revision = { [marker]: marker }; })],
      ["duplicate key", () => Buffer.from(`{"${marker}":1,"${marker}":2}`)],
      ["syntax error", () => Buffer.from(`{"a":${marker}`)],
      ["invalid UTF-8", () => Buffer.concat([Buffer.from(`{"${marker}":"`), Buffer.from([0xff]), Buffer.from('"}')])],
      ["trailing content", () => Buffer.concat([validBytes(), Buffer.from(` ${marker}`)])],
    ];
    it.each(cases)("%s", (_label, build) => {
      const error = rejection(build());
      for (const surface of [error.message, error.safeReason, error.stack ?? "", String(error), JSON.stringify({ ...error })]) {
        expect(surface).not.toContain(marker);
      }
      expect(error.cause, "raw parser/validator errors can carry values").toBeUndefined();
    });
  });
});

describe("wire shape", () => {
  const envelope: Case[] = [
    ...["schema", "repositoryId", "revision", "producer", "context", "artifacts", "compilations", "transformations", "diagnostics"]
      .map((key): Case => [`missing top-level ${key}`, (m) => { delete m[key]; }]),
    ["unsupported schema version", (m) => { m.schema = "leveret.build-evidence/v2"; }],
    ["unknown top-level field", (m) => { m.extra = true; }],
    ["unknown producer field", (m) => { m.producer.extra = 1; }],
    ["missing build tool", (m) => { delete m.producer.buildTool; }],
    ["unknown build tool field", (m) => { m.producer.buildTool.extra = 1; }],
    ["empty run ID", (m) => { m.producer.runId = ""; }],
    ["empty repository ID", (m) => { m.repositoryId = ""; }],
    ["non-string revision", (m) => { m.revision = 7; }],
    ["object collection instead of array", (m) => { m.artifacts = {}; }],
    ["null collection", (m) => { m.diagnostics = null; }],
  ];
  it.each(envelope)("rejects %s", (_label, mutate, source) => { rejection(encode(mutate, source)); });

  describe("context", () => {
    const contexts: Case[] = [
      ["empty context ID", (m) => { m.context.id = ""; }],
      ["profiles as a bare string", (m) => { m.context.profiles = "ci"; }],
      ["non-string profile name", (m) => { m.context.profiles = [1]; }],
      ["missing profiles", (m) => { delete m.context.profiles; }],
      ["missing variant", (m) => { delete m.context.variant; }],
      ["set variant without a value", (m) => { m.context.variant = { state: "set", value: null }; }],
      ["set variant missing the value key", (m) => { m.context.variant = { state: "set" }; }],
      ["unset variant with a value", (m) => { m.context.variant = { state: "unset", value: "release" }; }],
      ["unknown variant with a value", (m) => { m.context.variant = { state: "unknown", value: "release" }; }],
      ["unrecognized variant state", (m) => { m.context.variant = { state: "maybe", value: null }; }],
      ["unknown variant field", (m) => { m.context.variant.extra = 1; }],
      ["unknown context field", (m) => { m.context.extra = 1; }],
    ];
    it.each(contexts)("rejects %s", (_label, mutate) => { rejection(encode(mutate)); });
    it.each<Case>([
      ["unknown profiles", (m) => { m.context.profiles = null; }],
      ["unknown variant", (m) => { m.context.variant = { state: "unknown", value: null }; }],
      ["named profiles and a set variant", (m) => { m.context.profiles = ["ci", "jdk21"]; m.context.variant = { state: "set", value: "release" }; }],
    ])("keeps an unverified or non-default context parseable: %s", (_label, mutate) => { accepted(encode(mutate)); });
  });

  describe("path grammar", () => {
    const badPaths = ["", "/abs", "a//b", "./a", "a/./b", "../a", "a/../b", "a/..", "a/", "a\\b", "a\u0000b", "a\ud800b"];
    const places: [string, (m: Json, value: string) => void][] = [
      ["artifact repository path", (m, v) => { art(m, "pricing-output").repositoryPath = v; }],
      ["payload content path", (m, v) => { art(m, "pricing-output").content.location.path = v; }],
      ["directory location path", (m, v) => { art(m, "test-classes").location.path = v; }],
      ["directory entry path", (m, v) => { art(m, "test-classes").entries[0].path = v; }],
      ["source root path", (m, v) => { comp(m, "prod").sourceRoots[1].repositoryPath = v; }],
      ["source member path", (m, v) => { comp(m, "prod").sourceRoots[1].members[0].relativePath = v; }],
      ["module directory", (m, v) => { comp(m, "prod").moduleDir = v; }],
    ];
    it.each(badPaths.flatMap((v) => places.map(([name, set]): Case => [`${name} ${JSON.stringify(v)}`, (m) => set(m, v)])))(
      "rejects %s", (_label, mutate) => { rejection(encode(mutate)); });
    it.each(["a b/ü.java", "a/.hidden", "..a/b", "a/b..", "日本/ファイル.java", "a:b/c"])("accepts unusual but legal component names: %j", (path) => {
      for (const set of [places[0], places[1], places[5]]) accepted(encode((m) => set[1](m, path)));
    });
    it("allows the repository root only as a module directory", () => {
      expect(accepted(encode(() => undefined)).compilations[0].moduleDir).toBe(".");
      accepted(encode((m) => { comp(m, "prod").moduleDir = "services/billing"; }));
      rejection(encode((m) => { art(m, "pricing-output").repositoryPath = "."; }));
    });
  });

  describe("artifacts", () => {
    const sizes: unknown[] = [-1, 1.5, 2 ** 53, 1e21, "12", null, true, {}];
    const shapes: Case[] = [
      ...sizes.map((v): Case => [`file size ${JSON.stringify(v)}`, (m) => { art(m, "pricing-output").content.sizeBytes = v; }]),
      ...sizes.map((v): Case => [`directory entry size ${JSON.stringify(v)}`, (m) => { art(m, "test-classes").entries[0].sizeBytes = v; }]),
      ["uppercase content hash", (m) => { const c = art(m, "pricing-output").content; c.sha256 = c.sha256.toUpperCase(); }],
      ["short content hash", (m) => { art(m, "pricing-output").content.sha256 = HASH.slice(1); }],
      ["long content hash", (m) => { art(m, "pricing-output").content.sha256 = `${HASH}a`; }],
      ["non-hex content hash", (m) => { art(m, "pricing-output").content.sha256 = "g".repeat(64); }],
      ["uppercase entry hash", (m) => { const e = art(m, "test-classes").entries[0]; e.sha256 = e.sha256.toUpperCase(); }],
      ["unknown kind", (m) => { art(m, "pricing-output").kind = "symlink"; }],
      ["unknown role", (m) => { art(m, "pricing-output").role = "binary"; }],
      ["unknown origin", (m) => { art(m, "pricing-output").origin = "generated"; }],
      ["unknown availability", (m) => { art(m, "pricing-output").availability = "stale"; }],
      ["unknown artifact field", (m) => { art(m, "pricing-output").extra = 1; }],
      ["empty artifact ID", (m) => { art(m, "pricing-output").id = ""; }],
      ["missing repository path key", (m) => { delete art(m, "pricing-output").repositoryPath; }],
      ["unknown content field", (m) => { art(m, "pricing-output").content.extra = 1; }],
      ["remote content location", (m) => { art(m, "pricing-output").content.location = { kind: "url", path: "https://example.invalid/x" }; }],
      ["content missing size", (m) => { delete art(m, "pricing-output").content.sizeBytes; }],
      ["directory entry unknown field", (m) => { art(m, "test-classes").entries[0].extra = 1; }],
      ["directory entry missing hash", (m) => { delete art(m, "test-classes").entries[0].sha256; }],
    ];
    it.each(shapes)("rejects %s", (_label, mutate, source) => { rejection(encode(mutate, source)); });

    const conditional: Case[] = [
      ["available file with a reason", (m) => { art(m, "pricing-output").reason = "x"; }],
      ["available file with a null reason", (m) => { art(m, "pricing-output").reason = null; }],
      ["available file with a top-level location", (m) => { art(m, "pricing-output").location = { kind: "payload", path: "x" }; }],
      ["available file with entries", (m) => { art(m, "pricing-output").entries = []; }],
      ["available file without content", (m) => { delete art(m, "pricing-output").content; }],
      ["available file without encoding", (m) => { delete art(m, "pricing-output").encoding; }],
      ["numeric encoding", (m) => { art(m, "pricing-output").encoding = 65001; }],
      ["available directory with content", (m) => { art(m, "prod-classes").content = payloadFile("x", HASH, 1).content; }],
      ["available directory with an encoding", (m) => { art(m, "prod-classes").encoding = "UTF-8"; }],
      ["available directory with a reason", (m) => { art(m, "prod-classes").reason = "x"; }],
      ["available directory without location", (m) => { delete art(m, "prod-classes").location; }],
      ["available directory without entries", (m) => { delete art(m, "prod-classes").entries; }],
      ["directory with a repository location", (m) => { art(m, "prod-classes").location.kind = "repository"; }],
      ["available file marked missing but keeping its bytes", (m) => { art(m, "pricing-output").availability = "missing"; art(m, "pricing-output").reason = "x"; }],
      ["not-produced artifact with content", (m) => { art(m, "pricing-output").content = payloadFile("x", HASH, 1).content; }, "generation-failed"],
      ["not-produced artifact with an encoding", (m) => { art(m, "pricing-output").encoding = null; }, "generation-failed"],
      ["not-produced artifact with a location", (m) => { art(m, "pricing-output").location = { kind: "payload", path: "x" }; }, "generation-failed"],
      ["not-produced artifact with entries", (m) => { art(m, "pricing-output").entries = []; }, "generation-failed"],
      ["not-produced artifact without a reason", (m) => { delete art(m, "pricing-output").reason; }, "generation-failed"],
      ["not-produced artifact with an empty reason", (m) => { art(m, "pricing-output").reason = ""; }, "generation-failed"],
      ["not-produced artifact with a null reason", (m) => { art(m, "pricing-output").reason = null; }, "generation-failed"],
    ];
    it.each(conditional)("rejects conditional-field violation: %s", (_label, mutate, source) => { rejection(encode(mutate, source)); });

    it.each<Case>([
      ["a missing file", (m) => { unavailable(art(m, "pricing-output"), "missing"); }],
      ["a not-produced file", (m) => { unavailable(art(m, "pricing-output"), "not-produced"); }],
      ["a withheld resource", (m) => { unavailable(art(m, "app-resource-output"), "withheld"); }],
      ["a missing authored original that keeps its path", (m) => { unavailable(art(m, "consumer-original")); }],
      ["an unknown file encoding", (m) => { art(m, "pricing-output").encoding = null; }],
      ["an empty directory", (m) => { art(m, "test-classes").entries = []; }],
      ["a nonavailable directory", (m) => { unavailable(art(m, "prod-classes"), "not-produced"); }],
    ])("accepts %s", (_label, mutate) => { accepted(encode(mutate)); });

    const origins: Case[] = [
      ["authored file with a payload location", (m) => { art(m, "consumer-original").content.location = { kind: "payload", path: "x/y" }; }],
      ["authored location differing from its repository path", (m) => { art(m, "consumer-original").content.location.path = "src/main/java/example/Other.java"; }],
      ["nonavailable authored artifact without a path", (m) => { const a = art(m, "consumer-original"); unavailable(a); a.repositoryPath = null; }],
      ["materialized file with a repository location", (m) => { art(m, "pricing-output").content.location = { kind: "repository", path: "build/generated/example/Pricing.java" }; }],
      ["external file with a repository location", (m) => {
        extra(m, { ...payloadFile("x", HASH, 1), origin: "external", role: "dependency" });
        m.artifacts.at(-1).content.location = { kind: "repository", path: "lib/x.jar" };
      }],
      ["authored directory", (m) => { extra(m, { kind: "directory", role: "classes", origin: "authored", repositoryPath: "lib", availability: "missing", reason: "x" }); }],
      ["directory with a source role", (m) => { extra(m, { kind: "directory", role: "source", origin: "external", repositoryPath: null, availability: "missing", reason: "x" }); }],
      ["directory with a template role", (m) => { extra(m, { kind: "directory", role: "template", origin: "materialized", repositoryPath: null, availability: "missing", reason: "x" }); }],
      ["second authored artifact for one repository path", (m) => {
        extra(m, { kind: "file", role: "source", origin: "authored", repositoryPath: "src/main/java/example/Consumer.java", availability: "missing", reason: "x" });
      }],
      ["duplicate artifact ID", (m) => { m.artifacts.push(structuredClone(art(m, "pricing-output"))); }],
    ];
    it.each(origins)("rejects origin/kind violation: %s", (_label, mutate) => { rejection(encode(mutate)); });

    it.each<Case>([
      ["a materialized artifact sharing an authored logical path", (m) => {
        extra(m, { kind: "file", role: "source", origin: "materialized", repositoryPath: "src/main/java/example/Consumer.java", availability: "missing", reason: "x" });
      }],
      ["an external dependency directory without a path", (m) => {
        extra(m, { kind: "directory", role: "dependency", origin: "external", repositoryPath: null, availability: "missing", reason: "x" });
      }],
      ["an external dependency jar", (m) => {
        extra(m, { kind: "file", role: "dependency", origin: "external", repositoryPath: null, availability: "missing", reason: "x" });
      }],
    ])("accepts %s", (_label, mutate) => { accepted(encode(mutate)); });

    describe("one payload path, one identity", () => {
      const generated = (m: Json) => art(m, "pricing-output").content;
      it.each<Case>([
        ["file with a different hash", (m) => { extra(m, payloadFile(generated(m).location.path, HASH, generated(m).sizeBytes)); }],
        ["file with a different size", (m) => { extra(m, payloadFile(generated(m).location.path, generated(m).sha256, generated(m).sizeBytes + 1)); }],
        ["directory entry with a different hash", (m) => {
          extra(m, payloadDir("generated/main", [{ path: "example/Pricing.java", sha256: HASH, sizeBytes: generated(m).sizeBytes }]));
        }],
        ["directory entry with a different size", (m) => {
          extra(m, payloadDir("generated/main", [{ path: "example/Pricing.java", sha256: generated(m).sha256, sizeBytes: generated(m).sizeBytes + 1 }]));
        }],
      ])("rejects a conflicting %s", (_label, mutate) => { rejection(encode(mutate)); });
      it.each<Case>([
        ["file sharing bytes with another record", (m) => { extra(m, payloadFile(generated(m).location.path, generated(m).sha256, generated(m).sizeBytes)); }],
        ["directory entry agreeing with a file", (m) => {
          extra(m, payloadDir("generated/main", [{ path: "example/Pricing.java", sha256: generated(m).sha256, sizeBytes: generated(m).sizeBytes }]));
        }],
        ["same bytes at a different path", (m) => { extra(m, payloadFile("other/path.bin", generated(m).sha256, generated(m).sizeBytes)); }],
      ])("accepts a %s", (_label, mutate) => { accepted(encode(mutate)); });
    });

    describe("directory entry order is UTF-8 byte order", () => {
      it.each<[string, string[]]>([
        ["empty", []], ["ascending", ["a", "b"]], ["dot before slash", ["a.b", "a/b"]],
        ["BMP before supplementary plane", ["\uff5e", "\u{10000}"]],
      ])("accepts %s", (_label, paths) => { accepted(encode((m) => { extra(m, payloadDir("extra-dir", entriesNamed(...paths))); })); });
      it.each<[string, string[]]>([
        ["descending", ["b", "a"]], ["duplicate", ["a", "a"]], ["slash before dot", ["a/b", "a.b"]],
        ["UTF-16 order that is not UTF-8 order", ["\u{10000}", "\uff5e"]],
      ])("rejects %s", (_label, paths) => { rejection(encode((m) => { extra(m, payloadDir("extra-dir", entriesNamed(...paths))); })); });
    });
  });

  describe("compilations and source roots", () => {
    const graph: Case[] = [
      ["duplicate compilation ID", (m) => { m.compilations.push(structuredClone(comp(m, "test"))); }],
      ["unknown authored artifact", (m) => { comp(m, "prod").authoredArtifactIds.push("nope"); }],
      ["unknown resource artifact", (m) => { comp(m, "prod").resourceArtifactIds.push("nope"); }],
      ["unknown output artifact", (m) => { comp(m, "prod").outputArtifactIds.push("nope"); }],
      ["unknown input artifact", (m) => {
        const prod = comp(m, "prod");
        prod.inputArtifactIds.push("nope");
        prod.sourceRoots[1].members.push({ artifactId: "nope", relativePath: "example/Nope.java" });
      }],
      ["unknown member artifact", (m) => { comp(m, "prod").sourceRoots[1].members.push({ artifactId: "nope", relativePath: "example/Nope.java" }); }],
      ["materialized artifact listed as authored", (m) => { comp(m, "prod").authoredArtifactIds.push("pricing-output"); }],
      ["non-resource listed as a resource", (m) => { comp(m, "prod").resourceArtifactIds.push("consumer-original"); }],
      ["resource as an effective source input", (m) => {
        const prod = comp(m, "prod");
        prod.inputArtifactIds.push("app-resource-output");
        prod.sourceRoots[1].members.push({ artifactId: "app-resource-output", relativePath: "application.properties" });
      }],
      ["original and transformed output both effective inputs", (m) => {
        const prod = comp(m, "prod");
        prod.inputArtifactIds.push("pricing-original");
        prod.sourceRoots[0].members.push({ artifactId: "pricing-original", relativePath: "example/PricingOriginal.java" });
      }, "in-place"],
      ["input missing from every source root", (m) => { comp(m, "prod").sourceRoots[0].members = []; }],
      ["member that is not an effective input", (m) => { comp(m, "prod").sourceRoots[0].members.push({ artifactId: "pricing-test", relativePath: "example/PricingTest.java" }); }],
      ["input placed in two roots", (m) => { comp(m, "prod").sourceRoots[1].members.push({ artifactId: "consumer-original", relativePath: "example/Consumer.java" }); }],
      ["input placed twice in one root", (m) => { comp(m, "prod").sourceRoots[0].members.push({ artifactId: "consumer-original", relativePath: "example/Consumer2.java" }); }],
      ["repeated effective input", (m) => { comp(m, "prod").inputArtifactIds.push("consumer-original"); }],
      ["duplicate relative path inside a root", (m) => {
        const prod = comp(m, "prod");
        prod.sourceRoots[0].members = [];
        prod.sourceRoots[1].members.push({ artifactId: "consumer-original", relativePath: "example/Pricing.java" });
      }],
      ["duplicate root ID", (m) => { comp(m, "prod").sourceRoots[1].id = comp(m, "prod").sourceRoots[0].id; }],
      ["empty root ID", (m) => { comp(m, "prod").sourceRoots[0].id = ""; }],
      ["unknown root field", (m) => { comp(m, "prod").sourceRoots[0].extra = 1; }],
      ["unknown member field", (m) => { comp(m, "prod").sourceRoots[0].members[0].extra = 1; }],
      ["missing root path key", (m) => { delete comp(m, "prod").sourceRoots[0].repositoryPath; }],
    ];
    it.each(graph)("rejects %s", (_label, mutate, source) => { rejection(encode(mutate, source)); });

    it("rejects a repeated effective input even when it has no repository path to collide on", () => {
      const withExtra = (listed: string[]) => encode((m) => {
        extra(m, { ...payloadFile("generated/main/example/Extra.java", HASH, 1), role: "source" });
        const prod = comp(m, "prod");
        prod.inputArtifactIds.push(...listed);
        prod.sourceRoots[1].members.push({ artifactId: "extra", relativePath: "example/Extra.java" });
      });
      accepted(withExtra(["extra"])); // control: the same input listed once is a valid inventory
      rejection(withExtra(["extra", "extra"]));
    });

    it.each<Case>([
      ["same relative filename in different roots", (m) => { comp(m, "prod").sourceRoots[1].members[0].relativePath = "example/Consumer.java"; }],
      ["a root without a logical path", (m) => { comp(m, "prod").sourceRoots[1].repositoryPath = null; }],
      ["a compilation without sources", (m) => { const t = comp(m, "test"); t.inputArtifactIds = []; t.sourceRoots = []; }],
      ["the other source-set role", (m) => { comp(m, "test").sourceSetRole = "other"; }],
      ["repeated authored and output references", (m) => {
        comp(m, "prod").authoredArtifactIds.push("consumer-original");
        comp(m, "prod").outputArtifactIds.push("prod-classes");
      }],
    ])("accepts %s", (_label, mutate) => { accepted(encode(mutate)); });

    it("keeps generated and in-place layouts as the exporter observed them", () => {
      const generated = comp(fx.valid.manifests.head, "prod").sourceRoots;
      expect(generated.map((r: Json) => [r.id, r.repositoryPath, r.members.map((member: Json) => member.relativePath)])).toEqual([
        ["authored-main", "src/main/java", ["example/Consumer.java"]], ["generated-main", "build/generated", ["example/Pricing.java"]],
      ]);
      const inPlace = comp(parseBuildEvidence(readFileSync(fx["in-place"].pins.head.manifestPath)), "prod").sourceRoots;
      expect(inPlace.map((r: Json) => [r.id, r.members.map((member: Json) => member.artifactId)])).toEqual([["main", ["consumer-original", "pricing-output"]]]);
    });

    const fields: Case[] = [
      ...["id", "moduleId", "moduleDir", "name", "sourceSetRole", "language", "inputArtifactIds", "sourceRoots", "authoredArtifactIds", "resourceArtifactIds",
        "outputArtifactIds", "inventory", "compiler", "compileClasspath", "modulePath", "processorPath", "generationState", "resourceState", "compilationState"]
        .map((key): Case => [`missing compilation ${key}`, (m) => { delete comp(m, "prod")[key]; }]),
      ["unknown compilation field", (m) => { comp(m, "prod").extra = 1; }],
      ["empty module ID", (m) => { comp(m, "prod").moduleId = ""; }],
      ["empty compilation ID", (m) => { comp(m, "prod").id = ""; }],
      ["unknown source-set role", (m) => { comp(m, "prod").sourceSetRole = "main"; }],
      ["unsupported language", (m) => { comp(m, "prod").language = "kotlin"; }],
      ["unknown step state", (m) => { comp(m, "prod").compilationState = "ok"; }],
      ["null step state", (m) => { comp(m, "prod").generationState = null; }],
      ["complete inventory with a reason", (m) => { comp(m, "prod").inventory.reason = "why"; }],
      ["partial inventory without a reason", (m) => { comp(m, "prod").inventory = { state: "partial", reason: null }; }],
      ["unknown inventory with an empty reason", (m) => { comp(m, "prod").inventory = { state: "unknown", reason: "" }; }],
      ["unrecognized inventory state", (m) => { comp(m, "prod").inventory = { state: "maybe", reason: "x" }; }],
      ["unknown inventory field", (m) => { comp(m, "prod").inventory.extra = 1; }],
    ];
    it.each(fields)("rejects %s", (_label, mutate) => { rejection(encode(mutate)); });

    it.each<Case>([
      ["a partial inventory with its reason", (m) => { comp(m, "prod").inventory = { state: "partial", reason: "generated source missing" }; }],
      ["an unknown inventory with its reason", (m) => { comp(m, "prod").inventory = { state: "unknown", reason: "no inventory was recorded" }; }],
      ...["succeeded", "failed", "not-run", "unknown"].map((state): Case => [`${state} step states`, (m) => {
        Object.assign(comp(m, "prod"), { generationState: state, resourceState: state, compilationState: state });
      }]),
    ])("accepts %s", (_label, mutate) => { accepted(encode(mutate)); });
  });

  describe("compiler environment", () => {
    const compiler = (m: Json) => comp(m, "prod").compiler;
    const options = (m: Json) => compiler(m).moduleOptions;
    const rejects: Case[] = [
      ["unknown compiler field", (m) => { compiler(m).extra = true; }],
      ...["name", "version", "javaVersion", "platform", "release", "sourceLevel", "targetLevel", "encoding", "preview", "moduleOptions"]
        .map((key): Case => [`missing compiler ${key}`, (m) => { delete compiler(m)[key]; }]),
      ["numeric source level", (m) => { compiler(m).sourceLevel = 21; }],
      ["string preview flag", (m) => { compiler(m).preview = "false"; }],
      ["release set without a value", (m) => { compiler(m).release = { state: "set", value: null }; }],
      ["release unset with a value", (m) => { compiler(m).release = { state: "unset", value: "21" }; }],
      ["release unknown with a value", (m) => { compiler(m).release = { state: "unknown", value: "21" }; }],
      ["unrecognized release state", (m) => { compiler(m).release = { state: "maybe", value: null }; }],
      ["unrecognized platform state", (m) => { compiler(m).platform.state = "guess"; }],
      ["unknown platform with fingerprints", (m) => { compiler(m).platform.state = "unknown"; }],
      ["identified platform without fingerprints", (m) => { compiler(m).platform.fingerprints = []; }],
      ["identified platform without modules or rt.jar", (m) => { compiler(m).platform.fingerprints = [compiler(m).platform.fingerprints[0]]; }],
      ["duplicate fingerprint name", (m) => { compiler(m).platform.fingerprints.push(structuredClone(compiler(m).platform.fingerprints[1])); }],
      ["unrecognized fingerprint name", (m) => { compiler(m).platform.fingerprints.push({ name: "classpath", sha256: HASH }); }],
      ["uppercase fingerprint hash", (m) => { compiler(m).platform.fingerprints[0].sha256 = HASH.toUpperCase(); }],
      ["unknown fingerprint field", (m) => { compiler(m).platform.fingerprints[0].extra = 1; }],
      ["unknown module option key", (m) => { options(m).extra = []; }],
      ...["sourcePath", "bootClasspath", "addReads", "addExports", "patchModules", "addModules", "limitModules"]
        .map((key): Case => [`missing module option ${key}`, (m) => { delete options(m)[key]; }]),
      ["bare array as a module path", (m) => { options(m).sourcePath = []; }],
      ["read without targets", (m) => { options(m).addReads = [{ module: "m" }]; }],
      ["read with a non-string target", (m) => { options(m).addReads = [{ module: "m", targets: [1] }]; }],
      ["export without a package", (m) => { options(m).addExports = [{ module: "m", targets: [] }]; }],
      ["patch with a bare array path", (m) => { options(m).patchModules = [{ module: "m", path: [] }]; }],
      ["non-string added module", (m) => { options(m).addModules = [1]; }],
      ["object limit modules", (m) => { options(m).limitModules = {}; }],
      ["unknown source path with entries", (m) => { options(m).sourcePath = { state: "unknown", reason: "x", entries: [pathEntry] }; }],
    ];
    it.each(rejects)("rejects %s", (_label, mutate) => { rejection(encode(mutate)); });

    it.each<Case>([
      ["a release-selected platform with ct.sym", (m) => {
        compiler(m).release = { state: "set", value: "21" };
        compiler(m).platform.fingerprints.push({ name: "ct.sym", sha256: HASH });
      }],
      ["a legacy rt.jar platform", (m) => { compiler(m).platform.fingerprints = [{ name: "rt.jar", sha256: HASH }]; }],
      ["an unknown platform", (m) => { compiler(m).platform = { state: "unknown", fingerprints: [] }; }],
      ["an unknown release", (m) => { compiler(m).release = { state: "unknown", value: null }; }],
      ["every nullable string unknown", (m) => {
        Object.assign(compiler(m), { name: null, version: null, javaVersion: null, sourceLevel: null, targetLevel: null, encoding: null, preview: null });
      }],
      ["unknown module options", (m) => { compiler(m).moduleOptions = null; }],
      ["every module option unknown", (m) => {
        Object.assign(options(m), { addReads: null, addExports: null, patchModules: null, addModules: null, limitModules: null });
      }],
      ["known module options", (m) => {
        Object.assign(options(m), {
          addReads: [{ module: "m", targets: ["a", "b"] }], addExports: [{ module: "m", package: "p", targets: [] }],
          patchModules: [{ module: "m", path: { state: "complete", reason: null, entries: [pathEntry] } }],
          addModules: ["a"], limitModules: ["a"],
          sourcePath: { state: "partial", reason: "some roots are not exported", entries: [pathEntry] },
          bootClasspath: { state: "unknown", reason: "not reported", entries: [] },
        });
      }],
    ])("accepts %s", (_label, mutate) => { accepted(encode(mutate)); });

    it("rejects an unresolved artifact in a module path", () => {
      rejection(encode((m) => { options(m).sourcePath = { state: "complete", reason: null, entries: [{ ...pathEntry, artifactId: "nope" }] }; }));
    });
  });

  describe.each(["compileClasspath", "modulePath", "processorPath"])("%s", (name) => {
    const set = (m: Json, value: unknown) => { comp(m, "prod")[name] = value; };
    const wrapped = (value: Json) => (m: Json) => set(m, value);
    const rejects: Case[] = [
      ["complete with a reason", wrapped({ state: "complete", reason: "x", entries: [] })],
      ["partial without a reason", wrapped({ state: "partial", reason: null, entries: [pathEntry] })],
      ["unknown without a reason", wrapped({ state: "unknown", reason: null, entries: [] })],
      ["unknown with an empty reason", wrapped({ state: "unknown", reason: "", entries: [] })],
      ["unknown with entries", wrapped({ state: "unknown", reason: "x", entries: [pathEntry] })],
      ["missing entries", wrapped({ state: "complete", reason: null })],
      ["missing reason", wrapped({ state: "complete", entries: [] })],
      ["missing state", wrapped({ reason: null, entries: [] })],
      ["unrecognized state", wrapped({ state: "empty", reason: null, entries: [] })],
      ["null wrapper", wrapped(null)],
      ["bare entry array", wrapped([])],
      ["non-array entries", wrapped({ state: "complete", reason: null, entries: {} })],
      ["unknown wrapper field", wrapped({ state: "complete", reason: null, entries: [], extra: 1 })],
      ["entry with an unknown field", wrapped({ state: "complete", reason: null, entries: [{ ...pathEntry, extra: 1 }] })],
      ["entry without coordinates", wrapped({ state: "complete", reason: null, entries: [{ artifactId: "consumer-original", upstreamCompilationId: null }] })],
      ["entry without an upstream key", wrapped({ state: "complete", reason: null, entries: [{ artifactId: "consumer-original", coordinates: null }] })],
      ["entry with an empty artifact ID", wrapped({ state: "complete", reason: null, entries: [{ ...pathEntry, artifactId: "" }] })],
      ["entry with an unresolved artifact", wrapped({ state: "complete", reason: null, entries: [{ ...pathEntry, artifactId: "nope" }] })],
      ["entry with an unresolved upstream compilation", wrapped({ state: "complete", reason: null, entries: [{ ...pathEntry, upstreamCompilationId: "nope" }] })],
      ["upstream output that the upstream compilation does not list", (m) => {
        comp(m, "test")[name] = { state: "complete", reason: null, entries: [{ artifactId: "test-classes", coordinates: null, upstreamCompilationId: "prod" }] };
      }],
      ["coordinates without a classifier key", wrapped({ state: "complete", reason: null, entries: [{ ...pathEntry, coordinates: { group: "g", name: "n", version: "1", type: "jar" } }] })],
      ["coordinates with an unknown field", wrapped({ state: "complete", reason: null, entries: [{ ...pathEntry, coordinates: { group: "g", name: "n", version: "1", classifier: null, type: "jar", extra: 1 } }] })],
    ];
    it.each(rejects)("rejects %s", (_label, mutate) => { rejection(encode(mutate)); });

    it.each<Case>([
      ["complete and empty", wrapped({ state: "complete", reason: null, entries: [] })],
      ["partial with known entries and its reason", wrapped({ state: "partial", reason: "one dependency could not be resolved", entries: [pathEntry] })],
      ["unknown and empty with its reason", wrapped({ state: "unknown", reason: "not reported by the build tool", entries: [] })],
      ["entries with full coordinates", wrapped({ state: "complete", reason: null, entries: [
        { artifactId: "consumer-original", coordinates: { group: "org.slf4j", name: "slf4j-api", version: "2.0.17", classifier: null, type: "jar" }, upstreamCompilationId: null },
        { artifactId: "pricing-test", coordinates: { group: "g", name: "n", version: "1", classifier: "sources", type: "jar" }, upstreamCompilationId: null },
      ] })],
      ["coordinates with empty display strings", wrapped({ state: "complete", reason: null, entries: [
        { ...pathEntry, coordinates: { group: "", name: "", version: "", classifier: "", type: "" } },
      ] })],
      ["a repeated entry, preserving compiler order", wrapped({ state: "complete", reason: null, entries: [
        { ...pathEntry, artifactId: "pricing-test" }, pathEntry, { ...pathEntry, artifactId: "pricing-test" },
      ] })],
      ["an upstream output the upstream compilation lists", (m) => {
        comp(m, "test")[name] = { state: "complete", reason: null, entries: [{ artifactId: "prod-classes", coordinates: null, upstreamCompilationId: "prod" }] };
      }],
      ["an output artifact without an upstream claim", wrapped({ state: "complete", reason: null, entries: [{ artifactId: "test-classes", coordinates: null, upstreamCompilationId: null }] })],
    ])("accepts %s and keeps empty and unknown distinct", (_label, mutate) => { accepted(encode(mutate)); });
  });

  describe("upstream compilation graph", () => {
    it.each<Case>([
      ["upstream artifact outside the upstream outputs", (m) => {
        comp(m, "test").compileClasspath = { state: "complete", reason: null, entries: [{ artifactId: "test-classes", coordinates: null, upstreamCompilationId: "prod" }] };
      }],
    ])("rejects %s", (_label, mutate) => { rejection(encode(mutate)); });

    it.each<Case>([
      ["a compilation depending on its own output", (m) => {
        comp(m, "prod").compileClasspath = { state: "complete", reason: null, entries: [{ artifactId: "prod-classes", coordinates: null, upstreamCompilationId: "prod" }] };
      }],
      ["a mutual dependency between compilations", (m) => {
        comp(m, "prod").modulePath = { state: "complete", reason: null, entries: [{ artifactId: "test-classes", coordinates: null, upstreamCompilationId: "test" }] };
      }],
    ])("accepts %s: references are validated, no build is scheduled", (_label, mutate) => { accepted(encode(mutate)); });

    it("keeps an unproduced upstream output as an explicit gap instead of rejecting it", () => {
      const gap = accepted(Buffer.from(JSON.stringify(fx["generation-failed"].manifests.head)));
      expect(art(gap, "prod-classes")).toMatchObject({ availability: "not-produced" });
      expect(comp(gap, "test").compileClasspath.entries[0]).toEqual({ artifactId: "prod-classes", coordinates: null, upstreamCompilationId: "prod" });
    });
  });

  describe("transformations and source maps", () => {
    const first = (m: Json) => m.transformations[0];
    const location = (m: Json) => first(m).locations[0];
    const cloned = (m: Json, patch: (t: Json) => void) => { const t = structuredClone(first(m)); patch(t); m.transformations.push(t); };
    const rejects: Case[] = [
      ["duplicate transformation ID", (m) => cloned(m, (t) => { t.producer.executionId = "another-run"; })],
      ["unknown input artifact", (m) => { first(m).inputArtifactIds.push("nope"); }],
      ["unknown output artifact", (m) => { first(m).outputArtifactIds.push("nope"); }],
      ["repeated input artifact", (m) => { first(m).inputArtifactIds.push(first(m).inputArtifactIds[0]); }],
      ["repeated output artifact", (m) => { first(m).outputArtifactIds.push(first(m).outputArtifactIds[0]); }],
      ["authored artifact as an output", (m) => { first(m).outputArtifactIds.push("consumer-original"); }],
      ["compile as a transformation kind", (m) => { first(m).kind = "compile"; }],
      ["unrecognized basis", (m) => { first(m).basis = "guessed"; }],
      ["missing producer", (m) => { delete first(m).producer; }],
      ["empty execution ID", (m) => { first(m).producer.executionId = ""; }],
      ["producer without a version key", (m) => { delete first(m).producer.version; }],
      ["unknown producer field", (m) => { first(m).producer.extra = 1; }],
      ["unknown transformation field", (m) => { first(m).extra = 1; }],
      ["missing locations", (m) => { delete first(m).locations; }],
      ["non-array locations", (m) => { first(m).locations = {}; }],
      ["map input outside the record inputs", (m) => { location(m).inputArtifactId = "consumer-original"; }],
      ["map output outside the record outputs", (m) => { location(m).outputArtifactId = "app-resource-output"; }],
      ["map input that is not an artifact", (m) => { location(m).inputArtifactId = "nope"; }],
      ["precise map on inferred lineage", (m) => { first(m).basis = "inferred"; }],
      ["line zero", (m) => { location(m).inputRange.start.line = 0; }],
      ["fractional line", (m) => { location(m).inputRange.start.line = 1.5; }],
      ["negative column", (m) => { location(m).outputRange.start.column = -1; }],
      ["fractional column", (m) => { location(m).outputRange.end.column = 2.5; }],
      ["string column", (m) => { location(m).outputRange.end.column = "3"; }],
      ["range missing its end", (m) => { delete location(m).inputRange.end; }],
      ["unknown position field", (m) => { location(m).inputRange.start.extra = 1; }],
      ["unknown range field", (m) => { location(m).outputRange.extra = 1; }],
      ["unknown map field", (m) => { location(m).extra = 1; }],
      ["missing output range", (m) => { delete location(m).outputRange; }],
    ];
    it.each(rejects)("rejects %s", (_label, mutate, source) => { rejection(encode(mutate, source)); });

    it.each<Case>([
      ["inferred lineage without precise maps", (m) => { Object.assign(first(m), { basis: "inferred", locations: [] }); }],
      ["recorded lineage without precise maps", (m) => { first(m).locations = []; }],
      ["an unknown producer version", (m) => { first(m).producer.version = null; }],
      ["a second record from the same producer execution", (m) => cloned(m, (t) => { t.id = "another-record"; })],
      ["a map whose end precedes its start, left for the consumer to degrade", (m) => {
        const r = location(m).outputRange;
        [r.start, r.end] = [r.end, r.start];
      }],
      ["a zero-width range", (m) => { location(m).outputRange.end = structuredClone(location(m).outputRange.start); }],
      ["a range far beyond the text, left for the consumer to degrade", (m) => {
        Object.assign(location(m).outputRange, { start: { line: 9999, column: 9999 }, end: { line: 9999, column: 10001 } });
      }],
      ["a second map from another recorded input", (m) => {
        first(m).locations.push({ ...structuredClone(location(m)), inputArtifactId: "pricing-generator-config" });
      }],
      ...["generate", "transform", "resource-process"].map((kind): Case => [`${kind} lineage`, (m) => { first(m).kind = kind; }]),
    ])("accepts %s", (_label, mutate) => { accepted(encode(mutate)); });
  });

  describe("diagnostics", () => {
    const push = (record: Json): ((m: Json) => void) => (m) => { m.diagnostics.push({ code: "note", message: "m", compilationId: "prod", artifactIds: ["pricing-output"], ...record }); };
    it.each<Case>([
      ["unknown compilation", push({ compilationId: "nope" })],
      ["unknown artifact", push({ artifactIds: ["nope"] })],
      ["unknown field", push({ extra: 1 })],
      ["missing artifact list", (m) => { push({})(m); delete m.diagnostics[0].artifactIds; }],
    ])("rejects a diagnostic with %s", (_label, mutate) => { rejection(encode(mutate)); });
    it("accepts a manifest-wide gap with no compilation or artifacts", () => {
      accepted(encode(push({ compilationId: null, artifactIds: [] })));
    });
    it("accepts ordinary descriptive text and repeated artifact references as written", () => {
      accepted(encode(push({ code: "", message: "", artifactIds: ["pricing-output", "pricing-output"] })));
    });
  });
});

describe("real client-export fixtures", () => {
  describe.each(FIXTURE_MODES)("%s export", (mode) => {
    it("publishes an atomically written, hash-pinned manifest whose bytes verify for each side", () => {
      const f = fx[mode];
      expect(f.base).not.toBe(f.head);
      for (const side of ["base", "head"] as const) {
        const pin = f.pins[side];
        const bytes = readFileSync(pin.manifestPath);
        expect(sha256(bytes)).toBe(pin.manifestSha256);
        const manifest = parseBuildEvidence(bytes);
        expect(manifest).toEqual(f.manifests[side]);
        expect(manifest.revision).toBe(f[side]);
        expect(manifest.repositoryId).toBe(FIXTURE_REPOSITORY_ID);
        expect(pin.expectedContext.id).toBe(manifest.context.id);
        expect(pin.select).toEqual({ moduleDir: ".", productionId: "prod", testId: "test" });
        expect(readdirSync(dirname(pin.manifestPath)).sort(), "payload first, temp file renamed away").toEqual(["manifest.json", "payload", "workspace"]);
        for (const a of manifest.artifacts) {
          if (a.availability !== "available") continue;
          if (a.kind === "directory") {
            expect(filesUnder(join(pin.payloadRoot, a.location.path)), "exactly the listed members").toEqual(a.entries.map((e) => e.path));
            for (const e of a.entries) {
              const member = readFileSync(join(pin.payloadRoot, a.location.path, e.path));
              expect([sha256(member), member.length]).toEqual([e.sha256, e.sizeBytes]);
            }
            continue;
          }
          const content = a.origin === "authored" ? blob(f.repo, f[side], a.content.location.path) : readFileSync(join(pin.payloadRoot, a.content.location.path));
          expect([sha256(content), content.length]).toEqual([a.content.sha256, a.content.sizeBytes]);
          expect(a.content.location).toEqual(a.origin === "authored" ? { kind: "repository", path: a.repositoryPath } : { kind: "payload", path: a.content.location.path });
        }
        for (const c of manifest.compilations) {
          for (const root of c.sourceRoots) {
            for (const member of root.members) {
              const artifact = manifest.artifacts.find((a) => a.id === member.artifactId);
              expect(artifact?.repositoryPath).toBe(`${root.repositoryPath}/${member.relativePath}`);
            }
          }
        }
      }
    });

    it("declares the review pair it exposes and keeps original and generated identities distinct", () => {
      const f = fx[mode];
      const { originalArtifactId, generatedArtifactId } = fixtureSelectedArtifacts[mode];
      const original = f.manifests.head.artifacts.find((a) => a.id === originalArtifactId);
      const generated = f.manifests.head.artifacts.find((a) => a.id === generatedArtifactId);
      expect(original).toMatchObject({ origin: "authored", availability: "available" });
      expect(generated?.origin).toBe("materialized");
      expect(generated?.availability).toBe(mode === "generation-failed" ? "not-produced" : "available");
      expect(f.originalBytes.has(originalArtifactId)).toBe(true);
      expect(f.outputBytes.has(generatedArtifactId)).toBe(mode !== "generation-failed");
      for (const id of f.originalBytes.keys()) expect(f.outputBytes.has(id)).toBe(false);
    });
  });

  it("builds a runnable request for each side from the pins", () => {
    const f = fx.valid;
    expect(fixtureRequest(f, "base", "/tmp/runtime")).toEqual({
      repo: f.repo, repositoryId: FIXTURE_REPOSITORY_ID, revision: f.base, side: "base", pin: f.pins.base, runtimeDir: "/tmp/runtime",
    });
    expect(fixtureRequest(f, "head", "/tmp/runtime")).toMatchObject({ revision: f.head, side: "head", pin: f.pins.head });
    for (const pin of [f.pins.base, f.pins.head]) {
      expect(pin.manifestPath.startsWith("/")).toBe(true);
      expect(pin.payloadRoot.startsWith("/")).toBe(true);
      expect(pin.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(f.pins.base.payloadRoot).not.toBe(f.pins.head.payloadRoot);
  });

  it("generates Java and filtered resources from pinned template and config, then compiles them", () => {
    const f = fx.valid;
    const bytes = (side: "base" | "head", id: string) => {
      const a = f.manifests[side].artifacts.find((x) => x.id === id) as Json;
      return a.origin === "authored" ? blob(f.repo, f[side], a.content.location.path) : readFileSync(join(f.pins[side].payloadRoot, a.content.location.path));
    };
    expect(text(bytes("base", "pricing-output"))).toContain("return quantity * 10;");
    expect(text(bytes("head", "pricing-output"))).toContain("return quantity * 12;");
    expect(text(bytes("head", "pricing-template"))).toContain("return quantity * ${factor};");
    expect(text(f.outputBytes.get("pricing-output"))).toBe(text(bytes("head", "pricing-output")));
    expect(text(f.originalBytes.get("pricing-template"))).toBe(text(bytes("head", "pricing-template")));
    expect(text(bytes("head", "app-resource-original"))).toContain("endpoint=${endpoint}");
    expect(text(bytes("head", "app-resource-output"))).toBe("endpoint=https://billing.example.test\nregion=eu\n");

    const head = f.manifests.head as Json;
    const classes = (side: "base" | "head") => (f.manifests[side].artifacts.find((a) => a.id === "prod-classes") as Json).entries as Json[];
    expect(classes("head").map((e: Json) => e.path)).toEqual(["example/Consumer.class", "example/Pricing.class"]);
    expect(readFileSync(join(f.pins.head.payloadRoot, "classes/main/example/Pricing.class")).subarray(0, 4).toString("hex")).toBe("cafebabe");
    expect(classes("base")[1].sha256, "bytecode follows the regenerated source").not.toBe(classes("head")[1].sha256);
    expect(comp(head, "prod")).toMatchObject({ generationState: "succeeded", resourceState: "succeeded", compilationState: "succeeded", inventory: { state: "complete", reason: null } });
    expect(comp(head, "test")).toMatchObject({ compilationState: "succeeded" });
    expect(comp(head, "prod").compiler).toMatchObject({ release: { state: "unset", value: null }, sourceLevel: "21", targetLevel: "21", encoding: "UTF-8", preview: false });
    expect(comp(head, "prod").compiler.platform.fingerprints.map((p: Json) => p.name)).toEqual(["release", "modules"]);

    const generate = head.transformations.find((t: Json) => t.id === "pricing-generate");
    expect(generate).toMatchObject({ kind: "generate", basis: "exporter-recorded", inputArtifactIds: ["pricing-template", "pricing-generator-config"], outputArtifactIds: ["pricing-output"] });
    expect(sliced(text(f.originalBytes.get("pricing-template")), generate.locations[0].inputRange)).toBe("${factor}");
    expect(sliced(text(f.outputBytes.get("pricing-output")), generate.locations[0].outputRange)).toBe("12");
    const filter = head.transformations.find((t: Json) => t.id === "resource-filter");
    expect(sliced(text(f.originalBytes.get("app-resource-original")), filter.locations[0].inputRange)).toBe("${endpoint}");
    expect(sliced(text(f.outputBytes.get("app-resource-output")), filter.locations[0].outputRange)).toBe("https://billing.example.test");
  });

  it("keeps the Git original retrievable after in-place transformation, under a separate output identity", () => {
    const f = fx["in-place"];
    const head = f.manifests.head as Json;
    const original = f.originalBytes.get("pricing-original");
    const output = f.outputBytes.get("pricing-output");
    expect(text(original)).toContain("quantity * @FACTOR@");
    expect(text(output)).toContain("quantity * 12");
    expect(text(output)).not.toContain("@FACTOR@");
    const overwritten = readFileSync(join(dirname(f.pins.head.manifestPath), "workspace/src/main/java/example/Pricing.java"));
    expect(Buffer.compare(overwritten, Buffer.from(output!)), "the workspace path was really overwritten").toBe(0);
    expect(Buffer.compare(blob(f.repo, f.head, "src/main/java/example/Pricing.java"), Buffer.from(original!)), "Git bytes are still the pre-transformation original").toBe(0);

    const [authored, materialized] = ["pricing-original", "pricing-output"].map((id) => art(head, id));
    expect([authored.origin, materialized.origin]).toEqual(["authored", "materialized"]);
    expect(authored.repositoryPath).toBe(materialized.repositoryPath);
    expect(authored.content.sha256).not.toBe(materialized.content.sha256);
    const prod = comp(head, "prod");
    expect(prod.inputArtifactIds).toContain("pricing-output");
    expect(prod.inputArtifactIds).not.toContain("pricing-original");
    expect(prod.authoredArtifactIds).toContain("pricing-original");
    const transform = head.transformations.find((t: Json) => t.id === "pricing-inplace");
    expect(transform).toMatchObject({ kind: "transform", basis: "exporter-recorded", inputArtifactIds: ["pricing-original", "pricing-generator-config"], outputArtifactIds: ["pricing-output"] });
    expect(sliced(text(original), transform.locations[0].inputRange)).toBe("@FACTOR@");
    expect(sliced(text(output), transform.locations[0].outputRange)).toBe("12");
  });

  it("publishes a finalized failure manifest with a real gap and never fabricates the missing output", () => {
    const f = fx["generation-failed"];
    const head = f.manifests.head as Json;
    expect(blob(f.repo, f.head, "generator.properties").toString()).not.toContain("factor=");
    expect(art(head, "pricing-output")).toEqual({
      id: "pricing-output", kind: "file", role: "source", origin: "materialized", repositoryPath: "build/generated/example/Pricing.java",
      availability: "not-produced", reason: expect.stringMatching(/\S/),
    });
    expect(readdirSync(f.pins.head.payloadRoot), "no generated payload exists").not.toContain("generated");
    expect(f.outputBytes.has("pricing-output")).toBe(false);
    expect(f.outputBytes.has("app-resource-output")).toBe(true);
    expect(f.originalBytes.has("pricing-template")).toBe(true);
    expect(comp(head, "prod")).toMatchObject({
      generationState: "failed", resourceState: "succeeded", compilationState: "not-run",
      inventory: { state: "partial", reason: expect.stringMatching(/\S/) },
    });
    expect(comp(head, "test")).toMatchObject({ compilationState: "not-run", inventory: { state: "complete", reason: null } });
    expect(art(head, "prod-classes").availability).toBe("not-produced");
    expect(art(head, "test-classes").availability).toBe("not-produced");
    expect(head.diagnostics).toEqual([{ code: "generation-failed", message: expect.stringMatching(/\S/), compilationId: "prod", artifactIds: ["pricing-output"] }]);
    expect(head.transformations.map((t: Json) => t.id), "no invented lineage edge").toEqual(["resource-filter"]);
    // The base export of the same mode is an independent, healthy build.
    expect(art(f.manifests.base, "pricing-output").availability).toBe("available");
    expect(comp(f.manifests.base, "prod")).toMatchObject({ generationState: "succeeded", compilationState: "succeeded" });
  });

  it("derives a template defect's generated effect from the changed template bytes", () => {
    const f = fx["template-defect"];
    const baseTemplate = blob(f.repo, f.base, "templates/Pricing.java.tpl").toString();
    expect(baseTemplate).toContain("return quantity * ${factor};");
    expect(text(f.originalBytes.get("pricing-template"))).toContain("return quantity / ${factor};");
    expect(text(f.outputBytes.get("pricing-output"))).toContain("return quantity / 10;");
    expect(text(readFileSync(join(f.pins.base.payloadRoot, "generated/main/example/Pricing.java")))).toContain("return quantity * 10;");
    expect(comp(f.manifests.head, "prod")).toMatchObject({ generationState: "succeeded", compilationState: "succeeded" });
    const generate = (f.manifests.head as Json).transformations[0];
    expect(sliced(text(f.originalBytes.get("pricing-template")), generate.locations[0].inputRange)).toBe("${factor}");
    expect(sliced(text(f.outputBytes.get("pricing-output")), generate.locations[0].outputRange)).toBe("10");
  });

  it("leaks a credential-shaped value into a filtered resource only on the head side, outside any tracked byte", () => {
    const f = fx["secret-resource"];
    const output = text(f.outputBytes.get("app-resource-output"));
    expect(output).toContain(`token=${FIXTURE_SECRET_MARKER}\n`);
    expect(art(f.manifests.head, "app-resource-output").availability, "a leaky exporter reports it as available").toBe("available");
    expect(text(readFileSync(join(f.pins.base.payloadRoot, "resources/main/application.properties")))).not.toContain(FIXTURE_SECRET_MARKER);
    for (const bytes of f.originalBytes.values()) expect(text(bytes)).not.toContain(FIXTURE_SECRET_MARKER);
    expect(text(f.originalBytes.get("app-resource-original"))).toContain("token=${apiToken}");
    for (const side of ["base", "head"] as const) expect(readFileSync(f.pins[side].manifestPath, "utf8")).not.toContain(FIXTURE_SECRET_MARKER);
  });

  describe("the export command is a real pipeline", () => {
    it("follows the pinned revision's Git objects, not a dirty workspace or a canned answer", async () => {
      // Works on a private clone: the shared fixture repositories stay untouched for every other test.
      const clone = join(home, "pipeline-clone");
      fixtureGit(home, "clone", "-q", fx.valid.repo, clone);
      writeFileSync(join(clone, "generator.properties"), "endpoint=https://billing.example.test\nfactor=7\n");
      fixtureGit(clone, "add", "-A");
      fixtureGit(clone, "-c", "commit.gpgsign=false", "commit", "-m", "factor 7");
      const revision = fixtureGit(clone, "rev-parse", "HEAD");
      const template = join(clone, "templates/Pricing.java.tpl");
      const dirty = `${readFileSync(template, "utf8")}// uncommitted workspace edit\n`;
      writeFileSync(template, dirty);

      const output = join(home, "pipeline-run");
      await runFixtureExporter(clone, revision, output, "valid");
      const manifest = parseBuildEvidence(readFileSync(join(output, "manifest.json")));
      expect(manifest.revision).toBe(revision);
      expect(text(readFileSync(join(output, "payload/generated/main/example/Pricing.java")))).toContain("return quantity * 7;");
      const template0 = art(manifest, "pricing-template").content;
      expect(template0.sha256).toBe(sha256(blob(clone, revision, "templates/Pricing.java.tpl")));
      expect(template0.sha256).not.toBe(sha256(dirty));
      expect(fixtureGit(fx.valid.repo, "rev-parse", "HEAD"), "the shared fixture repository was not advanced").toBe(fx.valid.head);
      expect(fixtureGit(fx.valid.repo, "status", "--porcelain"), "and has no workspace changes").toBe("");
    });

    it("fails like a real command on a bad mode or an unknown revision, leaving no manifest", async () => {
      const f = fx.valid;
      const bad = join(home, "bad-mode");
      await expect(runFixtureExporter(f.repo, f.head, bad, "bogus" as BuildFixtureMode)).rejects.toThrow();
      const missing = join(home, "missing-revision");
      await expect(runFixtureExporter(f.repo, "0".repeat(40), missing, "valid")).rejects.toThrow();
      expect(() => readFileSync(join(missing, "manifest.json"))).toThrow();
    });
  });
});
