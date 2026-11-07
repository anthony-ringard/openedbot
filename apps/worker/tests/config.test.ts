import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkerConfig } from "../src/config";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

function testEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    OPENEDBOT_ENV: "test",
    RUNTIME_TOKEN_ENCRYPTION_KEY: encryptionKey,
    ...overrides,
  };
}

function productionEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  const publicKey = Buffer.alloc(65);
  publicKey[0] = 4;
  return testEnvironment({
    OPENEDBOT_ENV: "production",
    BLOB_DRIVER: "r2",
    R2_BUCKET: "private",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    PUSH_VAPID_PUBLIC_KEY: publicKey.toString("base64url"),
    PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 7).toString("base64url"),
    PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
    TRANSACTIONAL_EMAIL_FROM: "openedbot <ops@openedbot.example>",
    EVENTS_INTERNAL_TOKEN: "events-secret",
    RELAY_INTERNAL_TOKEN: "relay-secret",
    RUN_KEY_SECRET: "run-key-secret",
    ...overrides,
  });
}

describe("worker instance identity", () => {
  test("loads the same process-wide mTLS identity boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "openedbot-worker-mtls-"));
    try {
      const cert = join(directory, "client.pem");
      const key = join(directory, "client.key");
      const ca = join(directory, "server-ca.pem");
      writeFileSync(cert, "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n", { mode: 0o644 });
      writeFileSync(key, "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n", { mode: 0o640 });
      writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n", { mode: 0o644 });
      const config = readWorkerConfig(testEnvironment({
        HERMES_MTLS_MODE: "required",
        HERMES_MTLS_CERT_FILE: cert,
        HERMES_MTLS_KEY_FILE: key,
        HERMES_MTLS_CA_FILE: ca,
      }));
      expect(config.hermesMtls).toMatchObject({ cert: expect.stringContaining("client"), key: expect.stringContaining("key") });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps WORKER_ID as a prefix and always adds a per-process nonce", () => {
    const first = readWorkerConfig(testEnvironment({ WORKER_ID: "queue-a" })).workerId;
    const second = readWorkerConfig(testEnvironment({ WORKER_ID: "queue-a" })).workerId;

    expect(first).toMatch(/^queue-a-[0-9]+-[0-9a-f]{8}$/u);
    expect(second).toMatch(/^queue-a-[0-9]+-[0-9a-f]{8}$/u);
    expect(second).not.toBe(first);
  });

  test("rejects an unsafe or unbounded instance prefix", () => {
    expect(() => readWorkerConfig(testEnvironment({ WORKER_ID: "worker with spaces" }))).toThrow("WORKER_ID");
    expect(() => readWorkerConfig(testEnvironment({ WORKER_ID: "x".repeat(65) }))).toThrow("WORKER_ID");
  });
});


describe("OPENEDBOT_ENV", () => {
  test("an unknown value refuses to start instead of running on development rules", () => {
    expect(() => readWorkerConfig(productionEnvironment({ OPENEDBOT_ENV: "prod" }))).toThrow(/OPENEDBOT_ENV must be one of/);
    expect(readWorkerConfig(productionEnvironment({ OPENEDBOT_ENV: "preprod", TRANSACTIONAL_EMAIL_RESEND_API_KEY: "re_test-secret" })).environment).toBe("production");
  });
});

describe("transactional email transports", () => {
  test("two transports together are refused, whichever pair", () => {
    expect(() => readWorkerConfig(testEnvironment({
      TRANSACTIONAL_EMAIL_ENDPOINT: "https://mail.openedbot.example/send",
      TRANSACTIONAL_EMAIL_SMTP_URL: "smtp://127.0.0.1:1025",
      TRANSACTIONAL_EMAIL_FROM: "openedbot@openedbot.local",
      TRANSACTIONAL_EMAIL_TOKEN: "token",
    }))).toThrow(/exactly one transport/);
    expect(() => readWorkerConfig(testEnvironment({
      TRANSACTIONAL_EMAIL_BREVO_API_KEY: "xkeysib-secret",
      TRANSACTIONAL_EMAIL_SMTP_URL: "smtp://127.0.0.1:1025",
      TRANSACTIONAL_EMAIL_FROM: "openedbot@openedbot.local",
    }))).toThrow(/exactly one transport/);
  });

  test("the development internal token is refused in production", () => {
    expect(() => readWorkerConfig(productionEnvironment({ EVENTS_INTERNAL_TOKEN: "openedbot-events-dev-token", TRANSACTIONAL_EMAIL_RESEND_API_KEY: "re_test-secret" }))).toThrow(/development default/);
    expect(() => readWorkerConfig(productionEnvironment({ RUN_KEY_SECRET: "  openedbot-run-key-dev-secret  ", TRANSACTIONAL_EMAIL_RESEND_API_KEY: "re_test-secret" }))).toThrow(/development default/);
    expect(() => readWorkerConfig(productionEnvironment({ WORKER_INTERNAL_TOKEN: "worker-secret", TRANSACTIONAL_EMAIL_RESEND_API_KEY: "re_test-secret" }))).toThrow(/WORKER_INTERNAL_TOKEN is no longer read/);
    expect(readWorkerConfig(testEnvironment()).internalSecrets.roles.events.value).toBe("openedbot-events-dev-token");
  });

  test("SMTP alone is accepted outside production", () => {
    const config = readWorkerConfig(testEnvironment({
      TRANSACTIONAL_EMAIL_SMTP_URL: "smtp://127.0.0.1:1025",
      TRANSACTIONAL_EMAIL_FROM: "openedbot@openedbot.local",
    }));
    expect(config.transactionalEmail.smtpUrl).toBe("smtp://127.0.0.1:1025");
    expect(config.transactionalEmail.endpoint).toBeNull();
    expect(config.transactionalEmail.brevoApiKey).toBeNull();
  });

  test("Brevo alone is read as the transport", () => {
    const config = readWorkerConfig(testEnvironment({
      TRANSACTIONAL_EMAIL_BREVO_API_KEY: "xkeysib-secret",
      TRANSACTIONAL_EMAIL_FROM: "openedbot@openedbot.local",
    }));
    expect(config.transactionalEmail.brevoApiKey).toBe("xkeysib-secret");
    expect(config.transactionalEmail.smtpUrl).toBeNull();
    expect(config.transactionalEmail.endpoint).toBeNull();
  });

  test("Resend alone is accepted in production with the configured sender", () => {
    const config = readWorkerConfig(productionEnvironment({
      TRANSACTIONAL_EMAIL_RESEND_API_KEY: "re_test-secret",
    }));
    expect(config.transactionalEmail.resendApiKey).toBe("re_test-secret");
    expect(config.transactionalEmail.resendBaseUrl).toBe("https://api.resend.com");
    expect(config.transactionalEmail.from).toBe("openedbot <ops@openedbot.example>");
    expect(config.environment).toBe("production");
  });

  test("Resend and SMTP together are refused in production", () => {
    expect(() => readWorkerConfig(productionEnvironment({
      TRANSACTIONAL_EMAIL_RESEND_API_KEY: "re_test-secret",
      TRANSACTIONAL_EMAIL_SMTP_URL: "smtp://127.0.0.1:1025",
    }))).toThrow(/exactly one transport/);
  });

  test("production Resend base URL must use HTTPS without credentials", () => {
    expect(() => readWorkerConfig(productionEnvironment({
      TRANSACTIONAL_EMAIL_RESEND_API_KEY: "re_test-secret",
      TRANSACTIONAL_EMAIL_RESEND_BASE_URL: "http://user:pass@resend-compatible.test",
    }))).toThrow(/TRANSACTIONAL_EMAIL_RESEND_BASE_URL/);
  });

  test("production without any transport is refused, and names the transports", () => {
    const failure = (() => {
      try {
        readWorkerConfig(testEnvironment({
          OPENEDBOT_ENV: "production",
          BLOB_DRIVER: "r2",
          R2_BUCKET: "private",
          R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
          R2_ACCESS_KEY_ID: "key",
          R2_SECRET_ACCESS_KEY: "secret",
          TRANSACTIONAL_EMAIL_FROM: "openedbot <ops@openedbot.example>",
          EVENTS_INTERNAL_TOKEN: "events-secret",
          RELAY_INTERNAL_TOKEN: "relay-secret",
          RUN_KEY_SECRET: "run-key-secret",
        }));
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(failure?.message).toContain("TRANSACTIONAL_EMAIL_BREVO_API_KEY");
    expect(failure?.message).toContain("TRANSACTIONAL_EMAIL_RESEND_API_KEY");
  });
});

describe("web push VAPID", () => {
  test("absent hors production : fonctionnalité éteinte", () => {
    expect(readWorkerConfig(testEnvironment()).vapid).toBeNull();
  });

  test("production sans clés : refus au démarrage", () => {
    expect(() => readWorkerConfig(testEnvironment({
      OPENEDBOT_ENV: "production",
      BLOB_DRIVER: "r2",
      R2_BUCKET: "private",
      R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      TRANSACTIONAL_EMAIL_ENDPOINT: "https://mail.openedbot.example/send",
      TRANSACTIONAL_EMAIL_TOKEN: "token",
      TRANSACTIONAL_EMAIL_FROM: "openedbot <ops@openedbot.example>",
      EVENTS_INTERNAL_TOKEN: "events-secret",
      RELAY_INTERNAL_TOKEN: "relay-secret",
      RUN_KEY_SECRET: "run-key-secret",
    }))).toThrow(/PUSH_VAPID/);
  });

  test("production : l'opt-in boucle locale du Web Push est refusé", () => {
    expect(() => readWorkerConfig(productionEnvironment({
      TRANSACTIONAL_EMAIL_ENDPOINT: "https://mail.openedbot.example/send",
      TRANSACTIONAL_EMAIL_TOKEN: "token",
      PUSH_ALLOW_LOOPBACK_ENDPOINTS: "1",
    })))
      .toThrow(/PUSH_ALLOW_LOOPBACK_ENDPOINTS/);
    expect(readWorkerConfig(testEnvironment({
      PUSH_VAPID_PUBLIC_KEY: productionEnvironment().PUSH_VAPID_PUBLIC_KEY!,
      PUSH_VAPID_PRIVATE_KEY: productionEnvironment().PUSH_VAPID_PRIVATE_KEY!,
      PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
      PUSH_ALLOW_LOOPBACK_ENDPOINTS: "1",
    })).vapid?.allowLoopbackEndpoints).toBe(true);
  });
});

describe("link events retention", () => {
  test("defaults to 90 days and reads WORKER_TOOL_ERRORS_RETENTION_DAYS", () => {
    expect(readWorkerConfig(testEnvironment()).toolErrorsRetentionDays).toBe(90);
    expect(readWorkerConfig(testEnvironment({ WORKER_TOOL_ERRORS_RETENTION_DAYS: "14" })).toolErrorsRetentionDays).toBe(14);
  });

  test("defaults to 30 days and reads WORKER_LINK_EVENTS_RETENTION_DAYS", () => {
    expect(readWorkerConfig(testEnvironment()).linkEventsRetentionDays).toBe(30);
    expect(readWorkerConfig(testEnvironment({ WORKER_LINK_EVENTS_RETENTION_DAYS: "7" })).linkEventsRetentionDays).toBe(7);
  });
});

describe("dedicated runtime link gateway", () => {
  test("keeps event API and connector gateway origins independent", () => {
    const config = readWorkerConfig(testEnvironment({ API_INTERNAL_URL: "http://api:8790", RUNTIME_LINK_INTERNAL_URL: "http://links:8792/" }));
    expect(config.apiInternalUrl).toBe("http://api:8790");
    expect(config.runtimeLinkInternalUrl).toBe("http://links:8792");
  });

  test("defaults to the monolithic API origin", () => {
    expect(readWorkerConfig(testEnvironment({ API_PORT: "9000" })).runtimeLinkInternalUrl).toBe("http://127.0.0.1:9000");
    expect(readWorkerConfig(testEnvironment({ API_INTERNAL_URL: "http://api:9001" })).runtimeLinkInternalUrl).toBe("http://api:9001");
  });
});

test("separate link mode refuses a missing gateway URL", () => {
  expect(() => readWorkerConfig(testEnvironment({ RUNTIME_LINK_MODE: "seperate" }))).toThrow("RUNTIME_LINK_MODE");
  for (const url of ["", "   "]) {
    expect(() => readWorkerConfig(testEnvironment({ RUNTIME_LINK_MODE: "separate", RUNTIME_LINK_INTERNAL_URL: url }))).toThrow("RUNTIME_LINK_INTERNAL_URL");
  }
  expect(readWorkerConfig(testEnvironment({ RUNTIME_LINK_MODE: "separate", RUNTIME_LINK_INTERNAL_URL: "http://links:8792" })).runtimeLinkInternalUrl).toBe("http://links:8792");
});

describe("rotation automatique du jeton de lien", () => {
  test("24 h en production, 168 h ailleurs, réglable par LINK_TOKEN_MAX_AGE_HOURS", () => {
    expect(readWorkerConfig(testEnvironment()).linkTokenMaxAgeHours).toBe(168);
    expect(readWorkerConfig(testEnvironment({ LINK_TOKEN_MAX_AGE_HOURS: "12" })).linkTokenMaxAgeHours).toBe(12);
    expect(() => readWorkerConfig(testEnvironment({ LINK_TOKEN_MAX_AGE_HOURS: "0" }))).toThrow();
  });
});
