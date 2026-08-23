import { createHash, createPublicKey, verify } from "node:crypto";
import { posix } from "node:path";

export interface RelayConfig {
  serves: string[];
  signingKeys: Record<string, JsonWebKey>;
}

export interface RelayDelivery {
  token: string;
  delivery: string;
  event: string;
  repository: string;
  installationId: number;
}

export function relayConfigFromEnv(env: Record<string, string | undefined>): RelayConfig | null {
  const serves = env.LEVERET_SERVES?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const rawKeys = env.LEVERET_RELAY_SIGNING_KEYS;
  if (serves.length === 0 && !rawKeys) return null;
  if (serves.length === 0 || !rawKeys) throw new Error("LEVERET_SERVES and LEVERET_RELAY_SIGNING_KEYS must be configured together");
  const signingKeys = JSON.parse(rawKeys) as Record<string, JsonWebKey>;
  if (!signingKeys || typeof signingKeys !== "object" || Object.keys(signingKeys).length === 0) {
    throw new Error("LEVERET_RELAY_SIGNING_KEYS must contain at least one key");
  }
  return { serves, signingKeys };
}

const value = (header: string | string[] | undefined): string | undefined =>
  Array.isArray(header) ? header[0] : header;

const served = (repository: string, config: RelayConfig): boolean =>
  config.serves.some((pattern) => posix.matchesGlob(repository, pattern));

export function relayChallengeAllowed(repository: string, installationId: string, config: RelayConfig): boolean {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository) && /^[1-9]\d*$/.test(installationId) && served(repository, config);
}

export function verifyRelayDelivery(
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  config: RelayConfig,
  now = Math.floor(Date.now() / 1000),
): RelayDelivery | null {
  const authorization = value(headers.authorization);
  const delivery = value(headers["x-github-delivery"]);
  const event = value(headers["x-github-event"]);
  const configHash = value(headers["x-leveret-config-hash"]);
  const installation = value(headers["x-leveret-installation-id"]);
  const keyId = value(headers["x-leveret-key-id"]);
  const repository = value(headers["x-leveret-repository"]);
  const signature = value(headers["x-leveret-signature"]);
  const timestampValue = value(headers["x-leveret-timestamp"]);
  const timestamp = Number(timestampValue);
  const installationId = Number(installation);
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";

  if (!token || !delivery || !event || !repository || !keyId || !signature ||
    !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300 ||
    !Number.isSafeInteger(installationId) || installationId <= 0 ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository) || !served(repository, config) ||
    !/^[0-9a-f]{64}$/.test(configHash ?? "") || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;

  const publicJwk = config.signingKeys[keyId];
  if (!publicJwk) return null;
  const message = [
    "v1",
    timestamp,
    delivery,
    repository,
    installationId,
    event,
    createHash("sha256").update(body).digest("hex"),
    configHash,
  ].join("\n");
  try {
    if (!verify(null, Buffer.from(message), createPublicKey({ key: publicJwk, format: "jwk" }), Buffer.from(signature, "base64url"))) {
      return null;
    }
  } catch {
    return null;
  }
  return { token, delivery, event, repository, installationId };
}
