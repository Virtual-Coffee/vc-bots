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
  /**
   * Public base URL the join redirect is surfaced under (the Netlify rewrite in front of the
   * Worker). May include a path prefix. Empty/unset falls back to the request origin (wrangler dev).
   */
  PUBLIC_BASE_URL: string;
  SLACK_COWORKING_CHANNEL_ID: string;
  ROOM_TITLE: string;
  /** #events-style channel — hourly event reminders post here. */
  SLACK_EVENTS_CHANNEL_ID: string;
  /** Announcements channel — will carry the daily/weekly event reminders. */
  SLACK_ANNOUNCEMENTS_CHANNEL_ID: string;
  /** #vc-events-admin — mirrors the hourly reminder with extra info (e.g. the Zoom host key). */
  SLACK_EVENTADMIN_CHANNEL_ID: string;
  /** CMS GraphQL endpoint for event reminders. */
  CMS_GRAPHQL_URL: string;
  /** Comma-separated Slack user IDs mentioned as community maintainers in the welcome message. */
  WELCOME_MAINTAINER_IDS: string;
  /** Logging threshold: debug | info | warn | error (default info). */
  LOG_LEVEL: string;
}
