import { SlackApp, type AckResponse } from "slack-cloudflare-workers";
import { ADMIN_COMMAND, handleAdminCommand } from "../bots/admin";
import {
  COWORKING_MODAL_CALLBACK_ID,
  handleCoworkingSubmit,
  handlePanelCoworkingClick,
  handlePanelHomeClick,
  handlePanelReminderClick,
  handlePanelWelcomeClick,
  handleReminderSubmit,
  handleWelcomeSubmit,
  PANEL_COWORKING_ACTION_ID,
  PANEL_HOME_ACTION_ID,
  PANEL_REMINDER_ACTION_ID,
  PANEL_WELCOME_ACTION_ID,
  REMINDER_MODAL_CALLBACK_ID,
  WELCOME_MODAL_CALLBACK_ID,
} from "../bots/admin-panel";
import {
  CANCEL_ACTION_ID,
  JOIN_REDIRECT_ACTION_ID,
  handleJoinClick,
  handleJoinDismiss,
} from "../bots/coworking/join";
import { JOIN_ACTION_ID } from "../bots/coworking/room-message";
import { JOIN_EVENT_ACTION_ID } from "../bots/reminders/blocks";
import { handleAppHomeOpened, handleTeamJoin } from "../bots/welcome";
import type { Env } from "../env";

/** ACK inside Slack's 3s window with an empty 200; the lazy handler does the real work. */
const ack: () => Promise<AckResponse> = async () => {};

/**
 * The SlackApp serving all three `/slack/*` endpoints (events, interactivity, commands).
 *
 * `app.run` is path-agnostic: it verifies the signature against the raw body, answers the
 * `url_verification` handshake, ACKs within Slack's 3s window, and runs the lazy handlers
 * via `ctx.waitUntil`.
 *
 * Instantiated per request: registration is closures-only (no I/O), and it lets handlers
 * close over `publicBaseUrl` (the join-redirect base, which may be the request origin).
 *
 * Handlers reply through `src/slack/response.ts`, never `context.respond` — see ADR 0004.
 */
export function createSlackApp(env: Env, publicBaseUrl: string): SlackApp<Env> {
  return new SlackApp<Env>({
    env,
    // Static authorize (fixed single-workspace token) and the self-event filter off — ADR 0007.
    authorize: async () => ({
      botToken: env.SLACK_BOT_TOKEN,
      botId: "",
      botUserId: "",
      botScopes: [],
    }),
    ignoreSelfEvents: false,
  })
    .event("team_join", async ({ payload }) => handleTeamJoin(payload, env))
    .event("app_home_opened", async ({ payload }) => handleAppHomeOpened(payload, env))
    // ⚠️ Shared channel message: its response_url's "original" IS the room card — respondEphemeral
    // only, never replace/delete (ADR 0004).
    .action(JOIN_ACTION_ID, ack, async ({ payload }) =>
      handleJoinClick(payload, env, publicBaseUrl),
    )
    // ☕ Join (url button — the browser is already opening Zoom) and Cancel both dismiss the
    // per-user join ephemeral; deleting THAT original is safe.
    .action(JOIN_REDIRECT_ACTION_ID, ack, async ({ payload }) => handleJoinDismiss(payload, env))
    .action(CANCEL_ACTION_ID, ack, async ({ payload }) => handleJoinDismiss(payload, env))
    // The reminders "Join Event" button is also a url button — the browser opens Zoom on its
    // own. This registration exists purely so the click is ACKed instead of 404ing ("no listener
    // found"), which Slack renders as a warning triangle. No lazy handler: nothing to do.
    .action(JOIN_EVENT_ACTION_ID, ack)
    .command(ADMIN_COMMAND, ack, async ({ payload }) =>
      handleAdminCommand(payload, env),
    )
    // `/vc-bot-admin` (no args) panel buttons. Each is a per-user ephemeral, so the handlers
    // may safely replace/delete via the click's response_url. Modal buttons open a modal,
    // threading that response_url through `private_metadata` (a view_submission has none).
    .action(PANEL_REMINDER_ACTION_ID, ack, async ({ payload }) =>
      handlePanelReminderClick(payload, env),
    )
    .action(PANEL_WELCOME_ACTION_ID, ack, async ({ payload }) =>
      handlePanelWelcomeClick(payload, env),
    )
    .action(PANEL_COWORKING_ACTION_ID, ack, async ({ payload }) =>
      handlePanelCoworkingClick(payload, env),
    )
    .action(PANEL_HOME_ACTION_ID, ack, async ({ payload }) => handlePanelHomeClick(payload, env))
    // Modal submits. The empty ack closes the modal; the real work runs in the lazy handler,
    // which reaches the panel ephemeral via the response_url carried in private_metadata.
    .viewSubmission(REMINDER_MODAL_CALLBACK_ID, async () => {}, async ({ payload }) =>
      handleReminderSubmit(payload, env),
    )
    .viewSubmission(WELCOME_MODAL_CALLBACK_ID, async () => {}, async ({ payload }) =>
      handleWelcomeSubmit(payload, env),
    )
    .viewSubmission(COWORKING_MODAL_CALLBACK_ID, async () => {}, async ({ payload }) =>
      handleCoworkingSubmit(payload, env),
    );
}
