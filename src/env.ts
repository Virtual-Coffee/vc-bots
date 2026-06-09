import type { CoworkingRoom } from "./index";

/**
 * Worker bindings, secrets, and config vars.
 *
 * `wrangler types` regenerates `worker-configuration.d.ts` (a global `Env`) from
 * `wrangler.jsonc`; this hand-written interface is what the app modules import so we
 * keep a single, reviewable shape — including the typed Durable Object namespace.
 */
export interface Env {
  // --- Bindings ---
  /** Co-working room Durable Object, keyed by Zoom meeting ID via `getByName`. */
  COWORKING_ROOM: DurableObjectNamespace<CoworkingRoom>;

  // --- Secrets (wrangler secret put / .dev.vars) ---
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ZOOM_WEBHOOK_SECRET_TOKEN: string;
  ZOOM_S2S_CLIENT_ID: string;
  ZOOM_S2S_CLIENT_SECRET: string;
  ZOOM_S2S_ACCOUNT_ID: string;
  CMS_TOKEN: string;

  // --- Config vars (wrangler.jsonc) ---
  ZOOM_MEETING_ID: string;
  SLACK_COWORKING_CHANNEL_ID: string;
  ROOM_TITLE: string;
  /** Channel for event reminders. */
  SLACK_REMINDERS_CHANNEL_ID: string;
  /** CMS GraphQL endpoint for event reminders. */
  CMS_GRAPHQL_URL: string;
  /** Logging threshold: debug | info | warn | error (default info). */
  LOG_LEVEL: string;
}
