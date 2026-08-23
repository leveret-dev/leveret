import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { relayChallengeAllowed, relayConfigFromEnv, verifyRelayDelivery } from "../src/app/relay.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const body = Buffer.from(JSON.stringify({
  installation: { id: 42 },
  repository: { full_name: "leveret-dev/leveret" },
}));
const timestamp = 1_787_486_400;
const fields = [
  "v1",
  timestamp,
  "delivery-1",
  "leveret-dev/leveret",
  42,
  "pull_request",
  createHash("sha256").update(body).digest("hex"),
  "b".repeat(64),
].join("\n");
const signature = sign(null, Buffer.from(fields), privateKey).toString("base64url");
const headers = {
  authorization: "Bearer ghs_installation_token",
  "x-github-delivery": "delivery-1",
  "x-github-event": "pull_request",
  "x-leveret-config-hash": "b".repeat(64),
  "x-leveret-installation-id": "42",
  "x-leveret-key-id": "sig-test",
  "x-leveret-repository": "leveret-dev/leveret",
  "x-leveret-signature": signature,
  "x-leveret-timestamp": String(timestamp),
};
const config = {
  serves: ["leveret-dev/*"],
  signingKeys: { "sig-test": publicKey.export({ format: "jwk" }) },
};

describe("relay delivery trust", () => {
  it("loads relay trust only from complete host-owned configuration", () => {
    expect(relayConfigFromEnv({})).toBeNull();
    expect(() => relayConfigFromEnv({ LEVERET_SERVES: "leveret-dev/*" })).toThrow(/configured together/);
    expect(relayConfigFromEnv({
      LEVERET_SERVES: "leveret-dev/*,example/repo",
      LEVERET_RELAY_SIGNING_KEYS: JSON.stringify({ "sig-test": publicKey.export({ format: "jwk" }) }),
    })).toMatchObject({ serves: ["leveret-dev/*", "example/repo"] });
  });

  it("accepts one fresh signed delivery for a served repository", () => {
    expect(verifyRelayDelivery(headers, body, config, timestamp)).toEqual({
      token: "ghs_installation_token",
      delivery: "delivery-1",
      event: "pull_request",
      repository: "leveret-dev/leveret",
      installationId: 42,
    });
    expect(relayChallengeAllowed("leveret-dev/leveret", "42", config)).toBe(true);
  });

  it("rejects body tampering, stale signatures, and unserved repositories", () => {
    expect(verifyRelayDelivery(headers, Buffer.from("{}"), config, timestamp)).toBeNull();
    expect(verifyRelayDelivery(headers, body, config, timestamp + 301)).toBeNull();
    expect(verifyRelayDelivery(headers, body, { ...config, serves: ["other/*"] }, timestamp)).toBeNull();
    expect(relayChallengeAllowed("other/repo", "42", config)).toBe(false);
  });
});
