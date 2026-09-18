import type { AvailabilitySheet, CalendarSync, CoworkingRoom } from "./index";

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
  /** Google Calendar sync Durable Object — one singleton instance via getByName("default"). */
  CALENDAR_SYNC: DurableObjectNamespace<CalendarSync>;
  /** Availability check-in Durable Object, keyed by the availability channel ID via `getByName`. */
  AVAILABILITY_SHEET: DurableObjectNamespace<AvailabilitySheet>;

  // --- Secrets (wrangler secret put / .dev.vars) ---
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ZOOM_WEBHOOK_SECRET_TOKEN: string;
  /** Zoom Server-to-Server OAuth app — mints co-working invite links. */
  ZOOM_S2S_CLIENT_ID: string;
  ZOOM_S2S_CLIENT_SECRET: string;
  ZOOM_S2S_ACCOUNT_ID: string;
  /** Craft CMS GraphQL bearer token — the interim `cms` event source. */
  CMS_TOKEN: string;
  /** Full Google service-account JSON (one line). Carries a private key — never log it. */
  GOOGLE_SERVICE_ACCOUNT_KEY: string;
  /** Verification token echoed back in the X-Goog-Channel-Token header of every Calendar push notification. Never log it. */
  GOOGLE_WATCH_TOKEN: string;

  // --- Config vars (wrangler.jsonc) ---
  ZOOM_MEETING_ID: string;
  /**
   * Public base URL the Worker is reachable at (the Netlify rewrite in front of the Worker). May
   * include a path prefix. Used for the join redirect surfaced in Slack AND as the base for the
   * Google Calendar watch address (`${PUBLIC_BASE_URL}/google/notify`) — Google requires a
   * trusted HTTPS certificate there (the push guide lists no domain-registration step; if
   * `watch start` is refused for the domain, verify it under Cloud Console → Domain verification).
   * Empty/unset falls back to the request origin for the join redirect (wrangler dev), but a
   * watch can't be registered without it.
   */
  PUBLIC_BASE_URL: string;
  SLACK_COWORKING_CHANNEL_ID: string;
  ROOM_TITLE: string;
  /** #events-style channel — the scheduled starting-soon messages post here. */
  SLACK_EVENTS_CHANNEL_ID: string;
  /** Announcements channel — carries the daily/weekly event summaries. */
  SLACK_ANNOUNCEMENTS_CHANNEL_ID: string;
  /** #vc-events-admin — gets a mirror of each starting-soon message with extra info (the event's host key, from the calendar's private `hostCode` property). */
  SLACK_EVENTADMIN_CHANNEL_ID: string;
  /** Hosts channel for the Monday availability check-in. Empty/unset turns the feature off. */
  SLACK_AVAILABILITY_CHANNEL_ID: string;
  /**
   * Private #bot-log channel for important error alerts (cron + co-working DO/Zoom failures).
   * Empty/unset disables alerting (the bot must be invited to the channel to post). See
   * `src/slack/notify.ts`.
   */
  SLACK_BOTLOG_CHANNEL_ID: string;
  /** CMS GraphQL endpoint for event announcements (Craft + Solspace Calendar) — interim. */
  CMS_GRAPHQL_URL: string;
  /** Google Calendar id for event announcements (the …@group.calendar.google.com address). */
  GOOGLE_CALENDAR_ID: string;
  /** Default event source for reminders: "cms" (interim) | "google" — see `reminders/source.ts`. */
  EVENT_SOURCE: string;
  /** Comma-separated Slack user IDs mentioned as community maintainers in the welcome message. */
  WELCOME_MAINTAINER_IDS: string;
  /** Logging threshold: debug | info | warn | error (default info). */
  LOG_LEVEL: string;
}
