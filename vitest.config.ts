import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";
import { generateServiceAccountKey } from "./test/helpers/google-key";

// The live cron strings, so test/cron.test.ts can pin CRON_JOBS to wrangler.jsonc.
const { crons } = unstable_readConfig({ config: "./wrangler.jsonc" }).triggers;

/**
 * Tests run inside the real `workerd` runtime (via Miniflare), so Web Crypto, the Durable
 * Object, and bindings behave exactly as in production. Bindings/migrations are read from
 * `wrangler.jsonc`.
 */

// A throwaway RSA service-account key, generated once at config-load time (Node side, via the
// same Web Crypto helper the workerd suites use). The CalendarSync DO reads
// `this.env.GOOGLE_SERVICE_ACCOUNT_KEY` from its namespace binding (not the per-test `env`
// override), so we pin a valid key here — the DO suites fake the calendar port, but any
// end-to-end path that mints a token still needs a PEM `jose` can import, and it must not
// depend on a machine-local `.dev.vars`.
export default defineConfig(async () => {
  const { json: testServiceAccountKey } = await generateServiceAccountKey(
    "test-sa@vc-bots-test.iam.gserviceaccount.com",
  );
  return {
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
            SLACK_AVAILABILITY_CHANNEL_ID: "C-TEST-AVAIL",
            // Pinned so the signed-request tests (slack-app.test.ts) don't depend on a
            // machine-local `.dev.vars` value; tests sign with env.SLACK_SIGNING_SECRET.
            SLACK_SIGNING_SECRET: "test-signing-secret",
            // Pinned for the CalendarSync DO tests (it reads its own `this.env`, not a per-test
            // override). Valid key + watch config so the DO never falls back to `.dev.vars`. The
            // watch address is derived from PUBLIC_BASE_URL (set in wrangler.jsonc), not pinned here.
            GOOGLE_SERVICE_ACCOUNT_KEY: testServiceAccountKey,
            GOOGLE_WATCH_TOKEN: "test-watch-token",
            GOOGLE_CALENDAR_ID: "vc-events-test@group.calendar.google.com",
            // The suites exercise the Google source through the fetch recorder's Calendar stub;
            // wrangler.jsonc's interim "cms" default is pinned back to "google" here, and the CMS
            // source is covered by its own suite (reminders-cms.test.ts) via an explicit name.
            EVENT_SOURCE: "google",
            CMS_TOKEN: "test-cms-token",
            // Test-only: the configured `triggers.crons`, for the cron-contract test.
            TEST_WRANGLER_CRONS: JSON.stringify(crons),
          },
        },
      }),
    ],
  };
});
