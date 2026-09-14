import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside the real `workerd` runtime (via Miniflare), so Web Crypto, the Durable
 * Object, and bindings behave exactly as in production. Bindings/migrations are read from
 * `wrangler.jsonc`.
 */

// A throwaway RSA service-account key, generated once at config-load time (Node side). The
// CalendarSync DO reads `this.env.GOOGLE_SERVICE_ACCOUNT_KEY` from its namespace binding (not the
// per-test `env` override), so we pin a valid key here — tests stub the token-exchange fetch, but
// `jose` still imports + signs with this PEM, and it must not depend on a machine-local
// `.dev.vars`. The PKCS8 PEM imports cleanly via Web Crypto / jose `importPKCS8`.
const { privateKey: testServiceAccountPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const testServiceAccountKey = JSON.stringify({
  type: "service_account",
  client_email: "test-sa@vc-bots-test.iam.gserviceaccount.com",
  private_key: testServiceAccountPem,
});
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Distinct per-purpose channels so tests can assert real destinations even while
          // wrangler.jsonc temporarily points all three vars at one shared test channel.
          SLACK_EVENTS_CHANNEL_ID: "C-TEST-EVENTS",
          SLACK_ANNOUNCEMENTS_CHANNEL_ID: "C-TEST-ANNOUNCE",
          SLACK_EVENTADMIN_CHANNEL_ID: "C-TEST-EVENTADMIN",
          // Pinned so the signed-request tests (slack-app.test.ts) don't depend on a
          // machine-local `.dev.vars` value; tests sign with env.SLACK_SIGNING_SECRET.
          SLACK_SIGNING_SECRET: "test-signing-secret",
          // Pinned for the CalendarSync DO tests (it reads its own `this.env`, not a per-test
          // override). Valid key + watch config so the DO never falls back to `.dev.vars`. The
          // watch address is derived from PUBLIC_BASE_URL (set in wrangler.jsonc), not pinned here.
          GOOGLE_SERVICE_ACCOUNT_KEY: testServiceAccountKey,
          GOOGLE_WATCH_TOKEN: "test-watch-token",
          GOOGLE_CALENDAR_ID: "vc-events-test@group.calendar.google.com",
        },
      },
    }),
  ],
});
