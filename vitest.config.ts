import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside the real `workerd` runtime (via Miniflare), so Web Crypto, the Durable
 * Object, and bindings behave exactly as in production. Bindings/migrations are read from
 * `wrangler.jsonc`.
 */
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
          SLACK_JOBS_CHANNEL_ID: "C-TEST-JOBS",
          // Pinned so the signed-request tests (slack-app.test.ts) don't depend on a
          // machine-local `.dev.vars` value; tests sign with env.SLACK_SIGNING_SECRET.
          SLACK_SIGNING_SECRET: "test-signing-secret",
        },
      },
    }),
  ],
});
