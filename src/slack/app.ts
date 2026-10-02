import {
  SlackApp,
  type AckResponse,
  type SourceSpecifiedBlockActionLazyHandler,
} from "slack-cloudflare-workers";
import { ADMIN_COMMAND, handleAdminCommand } from "../bots/admin/slash";
import {
  handlePanelClick,
  handlePanelSubmit,
  PANEL_BUTTONS,
  PANEL_MODALS,
} from "../bots/admin/panel";
import { handleReactionChange } from "../bots/availability";
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
import { log } from "../log";
import { notifyBotLog } from "./notify";

/** ACK inside Slack's 3s window with an empty 200; the lazy handler does the real work. */
const ack: () => Promise<AckResponse> = async () => {};

/**
 * The request a `.action` lazy handler receives. `.action`'s lazy slot is a union of two
 * handler types, and inferring `lazy`'s request from that union collapses `payload` to
 * `never` — so the action registrations name it explicitly.
 */
type ActionRequest = Parameters<SourceSpecifiedBlockActionLazyHandler<Env>>[0];

/**
 * The SlackApp serving all three `/slack/*` endpoints (events, interactivity, commands).
 *
 * `app.run` is path-agnostic: it verifies the signature against the raw body, answers the
 * `url_verification` handshake, ACKs within Slack's 3s window, and runs the lazy handlers
 * via `ctx.waitUntil`.
 *
 * Instantiated per request: registration is closures-only (no I/O).
 *
 * Handlers reply through `src/slack/response.ts`, never `context.respond` — see ADR 0004.
 */
export function createSlackApp(env: Env): SlackApp<Env> {
  /**
   * Last-resort catch around every lazy handler. slack-edge hands `handler.lazy(request)`
   * straight to `ctx.waitUntil` with no try/catch, so a rejecting lazy handler is silent —
   * the user saw the ACK, nobody sees the failure. Handlers keep their own catches; this only
   * turns whatever escapes them into a `slack.lazy_failed` alert in `#bot-log`.
   */
  const lazy =
    <R>(handler: string, fn: (req: R) => Promise<void>) =>
    async (req: R): Promise<void> => {
      try {
        await fn(req);
      } catch (err) {
        log.error("slack.lazy_failed", { handler, err: String(err) });
        await notifyBotLog(env, "slack.lazy_failed", { handler, err: String(err) });
      }
    };

  const app = new SlackApp<Env>({
    env,
    // Static authorize (fixed single-workspace token) and the self-event filter off — ADR 0007.
    authorize: () =>
      Promise.resolve({
        botToken: env.SLACK_BOT_TOKEN,
        botId: "",
        botUserId: "",
        botScopes: [],
      }),
    ignoreSelfEvents: false,
  })
    .event(
      "team_join",
      lazy("team_join", async ({ payload }) => handleTeamJoin(payload, env)),
    )
    .event(
      "app_home_opened",
      lazy("app_home_opened", async ({ payload }) => handleAppHomeOpened(payload, env)),
    )
    // Availability check-in: any reaction change on a day message re-renders its sign-up
    // sheet. Reactions elsewhere are dropped inside the handler.
    .event(
      "reaction_added",
      lazy("reaction_added", async ({ payload }) => handleReactionChange(payload, env)),
    )
    .event(
      "reaction_removed",
      lazy("reaction_removed", async ({ payload }) => handleReactionChange(payload, env)),
    )
    // ⚠️ Shared channel message: its response_url's "original" IS the room card — respondEphemeral
    // only, never replace/delete (ADR 0004).
    .action(
      JOIN_ACTION_ID,
      ack,
      lazy<ActionRequest>("coworking.join", async ({ payload }) => handleJoinClick(payload, env)),
    )
    // ☕ Join (url button — the browser is already opening Zoom) and Cancel both dismiss the
    // per-user join ephemeral; deleting THAT original is safe.
    .action(
      JOIN_REDIRECT_ACTION_ID,
      ack,
      lazy<ActionRequest>("coworking.dismiss", async ({ payload }) =>
        handleJoinDismiss(payload, env),
      ),
    )
    .action(
      CANCEL_ACTION_ID,
      ack,
      lazy<ActionRequest>("coworking.dismiss", async ({ payload }) =>
        handleJoinDismiss(payload, env),
      ),
    )
    // url buttons: the browser opens the link itself, but Slack still posts a block_actions
    // payload and renders a warning triangle if it isn't ACKed (404 "no listener found"). No
    // lazy handler: nothing to do. Ours is the reminders "Join Event" button; virtualcoffee.io's
    // link buttons all carry a `website_` action_id prefix (its ADR 0016).
    .action(JOIN_EVENT_ACTION_ID, ack)
    .action(/^website_/, ack)
    .command(
      ADMIN_COMMAND,
      ack,
      lazy("admin.command", async ({ payload }) => handleAdminCommand(payload, env)),
    );

  // `/vc-bot-admin` (no args) panel, registered from its table. Each button is a per-user
  // ephemeral, so the handlers may safely replace/delete via the click's response_url; modal
  // buttons open a modal, threading that response_url through `private_metadata` (a
  // view_submission has none). The empty ack closes a modal; the real work runs in the lazy
  // handler.
  for (const button of PANEL_BUTTONS) {
    app.action(
      button.actionId,
      ack,
      lazy<ActionRequest>(`admin.panel.${button.logName}`, async ({ payload }) =>
        handlePanelClick(payload, env),
      ),
    );
  }
  for (const modal of PANEL_MODALS) {
    app.viewSubmission(
      modal.callbackId,
      async () => {},
      lazy(`admin.modal.${modal.logName}`, async ({ payload }) => handlePanelSubmit(payload, env)),
    );
  }
  return app;
}
