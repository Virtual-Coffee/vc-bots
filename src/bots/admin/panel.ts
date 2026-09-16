import { DateTime } from "luxon";
import type { AnyMessageBlock, AnyModalBlock, ModalView } from "slack-cloudflare-workers";
import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { deleteOriginal, replaceEphemeral } from "../../slack/response";
import { EASTERN, type ReminderName } from "../reminders";
import {
  type AdminAction,
  type AdminResult,
  adminReplyText,
  guardAdmin,
  runAdminAction,
} from "./actions";

/**
 * The interactive `/vc-bot-admin` panel: an ephemeral message of buttons (one per admin
 * function) shown when the command is run with no subcommand. Buttons that need input open a
 * modal via `client.views.open`; on completion the panel is REPLACED with output the admin
 * can't otherwise see (e.g. reminder counts) or DISMISSED when the result is self-verifiable
 * (a message visibly posted to a channel, the App Home tab, a DM).
 *
 * Registered as `.action()` / `.viewSubmission()` lazy listeners in `src/slack/app.ts`. The
 * panel is a per-user ephemeral, so REPLACE/DISMISS via its `response_url` are both safe
 * (unlike the shared room message — see `src/slack/response.ts`). A `block_actions` payload
 * carries that `response_url`, but a `view_submission` does NOT, so it travels into the modal
 * as `private_metadata` and back out on submit.
 *
 * This is the Block Kit adapter over `actions.ts`: each handler parses its payload into an
 * `AdminAction`, runs it (the admin gate and error handling live there), and delivers the
 * `AdminResult` into the panel. Only the modal-opening buttons gate themselves (`guardAdmin`).
 */

export const PANEL_REMINDER_ACTION_ID = "admin_panel_reminder";
export const PANEL_WELCOME_ACTION_ID = "admin_panel_welcome";
export const PANEL_COWORKING_ACTION_ID = "admin_panel_coworking";
export const PANEL_HOME_ACTION_ID = "admin_panel_home";
export const PANEL_WATCH_STATUS_ACTION_ID = "admin_panel_watch_status";
export const PANEL_WATCH_START_ACTION_ID = "admin_panel_watch_start";
export const PANEL_WATCH_STOP_ACTION_ID = "admin_panel_watch_stop";

export const REMINDER_MODAL_CALLBACK_ID = "admin_reminder_modal";
export const WELCOME_MODAL_CALLBACK_ID = "admin_welcome_modal";
export const COWORKING_MODAL_CALLBACK_ID = "admin_coworking_modal";

export const PANEL_TEXT = "Bot admin panel";

/** Panel ephemeral blocks: a heading plus one button per admin function. */
export function adminPanelBlocks(): AnyMessageBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Bot admin panel* — pick an action:" },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: PANEL_REMINDER_ACTION_ID,
          text: { type: "plain_text", text: "Run reminder…", emoji: true },
        },
        {
          type: "button",
          action_id: PANEL_WELCOME_ACTION_ID,
          text: { type: "plain_text", text: "Send welcome…", emoji: true },
        },
        {
          type: "button",
          action_id: PANEL_COWORKING_ACTION_ID,
          text: { type: "plain_text", text: "Coworking…", emoji: true },
        },
        {
          type: "button",
          action_id: PANEL_HOME_ACTION_ID,
          text: { type: "plain_text", text: "Publish App Home", emoji: true },
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Calendar Watch* — Google Calendar push channel:" },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: PANEL_WATCH_STATUS_ACTION_ID,
          text: { type: "plain_text", text: "Watch status", emoji: true },
        },
        {
          type: "button",
          action_id: PANEL_WATCH_START_ACTION_ID,
          text: { type: "plain_text", text: "Start watch", emoji: true },
        },
        {
          type: "button",
          action_id: PANEL_WATCH_STOP_ACTION_ID,
          text: { type: "plain_text", text: "Stop watch", emoji: true },
        },
      ],
    },
  ];
}

/** Carried through a modal so the submit handler can reach back to the panel ephemeral. */
interface PanelMetadata {
  response_url: string;
}

function parseMetadata(raw: string): PanelMetadata | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<PanelMetadata>;
    return typeof parsed.response_url === "string" ? { response_url: parsed.response_url } : undefined;
  } catch {
    return undefined;
  }
}

// ── Modal builders ──────────────────────────────────────────────────────────

function reminderModal(responseUrl: string): ModalView {
  const blocks: AnyModalBlock[] = [
    {
      type: "input",
      block_id: "kind",
      label: { type: "plain_text", text: "Which reminder?", emoji: true },
      element: {
        type: "radio_buttons",
        action_id: "kind",
        initial_option: { text: { type: "plain_text", text: "Daily" }, value: "daily" },
        options: [
          { text: { type: "plain_text", text: "Daily" }, value: "daily" },
          { text: { type: "plain_text", text: "Weekly" }, value: "weekly" },
        ],
      },
    },
    {
      type: "input",
      block_id: "date",
      label: { type: "plain_text", text: "Run as of date", emoji: true },
      element: {
        type: "datepicker",
        action_id: "date",
        initial_date: DateTime.now().setZone(EASTERN).toISODate() ?? undefined,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ":warning: Submitting posts to the live announcements channel (daily also (re)schedules the starting-soon messages). Past dates may fail to schedule.",
        },
      ],
    },
  ];
  return {
    type: "modal",
    callback_id: REMINDER_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ response_url: responseUrl } satisfies PanelMetadata),
    title: { type: "plain_text", text: "Run reminder" },
    submit: { type: "plain_text", text: "Run" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

function welcomeModal(responseUrl: string, userId: string): ModalView {
  const blocks: AnyModalBlock[] = [
    {
      type: "input",
      block_id: "target",
      label: { type: "plain_text", text: "Send the welcome message to", emoji: true },
      element: { type: "users_select", action_id: "target", initial_user: userId },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Sends the welcome message as a DM to the chosen member." }],
    },
  ];
  return {
    type: "modal",
    callback_id: WELCOME_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ response_url: responseUrl } satisfies PanelMetadata),
    title: { type: "plain_text", text: "Send welcome" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

function coworkingModal(responseUrl: string): ModalView {
  const blocks: AnyModalBlock[] = [
    {
      type: "input",
      block_id: "op",
      label: { type: "plain_text", text: "Co-working action", emoji: true },
      element: {
        type: "radio_buttons",
        action_id: "op",
        options: [
          { text: { type: "plain_text", text: "Announce room open" }, value: "open" },
          { text: { type: "plain_text", text: "Close announcement" }, value: "close" },
        ],
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Open posts to the live co-working channel." }],
    },
  ];
  return {
    type: "modal",
    callback_id: COWORKING_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ response_url: responseUrl } satisfies PanelMetadata),
    title: { type: "plain_text", text: "Coworking" },
    submit: { type: "plain_text", text: "Go" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

// ── Payload shapes ──────────────────────────────────────────────────────────

/**
 * The `block_actions` fields the panel handlers read — a structural subset of the framework's
 * `BlockAction` payload, kept narrow so tests can construct it directly.
 */
export interface AdminPanelActionPayload {
  user: { id: string };
  trigger_id: string;
  response_url?: string;
  actions: { action_id: string }[];
}

/**
 * The `view_submission` fields the modal handlers read — a structural subset of the
 * framework's `ViewSubmission` payload, kept narrow so tests can construct it directly.
 */
export interface AdminViewSubmissionPayload {
  user: { id: string };
  view: {
    callback_id: string;
    private_metadata: string;
    state: {
      values: Record<
        string,
        Record<
          string,
          {
            selected_option?: { value: string };
            selected_date?: string;
            selected_user?: string;
          }
        >
      >;
    };
  };
}

// ── Action handlers (panel buttons) ─────────────────────────────────────────

/**
 * Deliver a result into the panel ephemeral: DISMISS it when the work is self-verifiable
 * (`dismiss`), otherwise REPLACE it with the reply text. Denied / failed results always replace.
 */
async function deliver(responseUrl: string, result: AdminResult, dismiss: boolean): Promise<void> {
  if (dismiss && result.kind !== "denied" && result.kind !== "failed") {
    await deleteOriginal(responseUrl);
  } else {
    await replaceEphemeral(responseUrl, adminReplyText(result));
  }
}

/**
 * Panel buttons that open a modal do no action work, so they gate themselves; the click is
 * dropped without a `response_url` (nowhere to reply) and the panel is replaced with the denial
 * for non-admins.
 */
async function openModal(
  payload: AdminPanelActionPayload,
  env: Env,
  modal: string,
  view: (responseUrl: string) => ModalView,
): Promise<void> {
  const responseUrl = payload.response_url;
  if (!responseUrl) {
    log.warn("admin.panel.no_response_url", { user: payload.user.id });
    return;
  }
  if (!(await guardAdmin(env, payload.user.id, { modal }))) {
    await replaceEphemeral(responseUrl, adminReplyText({ kind: "denied" }));
    return;
  }
  await createSlackClient(env).views.open({
    trigger_id: payload.trigger_id,
    view: view(responseUrl),
  });
}

/** Run an action for a button click and deliver the result into the panel. */
async function runClick(
  payload: AdminPanelActionPayload,
  env: Env,
  action: AdminAction,
  dismiss: boolean,
): Promise<void> {
  const responseUrl = payload.response_url;
  if (!responseUrl) {
    log.warn("admin.panel.no_response_url", { user: payload.user.id });
    return;
  }
  const result = await runAdminAction(env, payload.user.id, action);
  await deliver(responseUrl, result, dismiss);
}

export async function handlePanelReminderClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  await openModal(payload, env, "reminder", reminderModal);
}

export async function handlePanelWelcomeClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  await openModal(payload, env, "welcome", (url) => welcomeModal(url, payload.user.id));
}

export async function handlePanelCoworkingClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  await openModal(payload, env, "coworking", coworkingModal);
}

export async function handlePanelHomeClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  // The App Home tab is self-verifiable → dismiss.
  await runClick(payload, env, { kind: "home", userId: payload.user.id }, true);
}

// ── Calendar Watch handlers (panel buttons) ─────────────────────────────────

export async function handlePanelWatchStatusClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  await runClick(payload, env, { kind: "watch", op: "status" }, false);
}

export async function handlePanelWatchStartClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  await runClick(payload, env, { kind: "watch", op: "start" }, false);
}

export async function handlePanelWatchStopClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  await runClick(payload, env, { kind: "watch", op: "stop" }, false);
}

// ── View-submission handlers (modal submit) ─────────────────────────────────

/**
 * Parse the panel response_url out of a submit's private_metadata (missing/bad metadata is
 * just logged — there's nowhere to reply). Returns undefined when the submit should be dropped.
 */
function submitResponseUrl(payload: AdminViewSubmissionPayload): string | undefined {
  const meta = parseMetadata(payload.view.private_metadata);
  if (!meta) {
    log.warn("admin.panel.bad_metadata", { user: payload.user.id, cb: payload.view.callback_id });
    return undefined;
  }
  return meta.response_url;
}

export async function handleReminderSubmit(
  payload: AdminViewSubmissionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = submitResponseUrl(payload);
  if (!responseUrl) return;
  const values = payload.view.state.values;
  const kind = values.kind?.kind?.selected_option?.value;
  const date = values.date?.date?.selected_date;
  if (kind !== "daily" && kind !== "weekly") {
    log.warn("admin.panel.bad_reminder_kind", { kind });
    await replaceEphemeral(responseUrl, adminReplyText({ kind: "failed" }));
    return;
  }
  // Anchor at noon Eastern: DST-safe, and lands the daily/weekly window squarely on the
  // picked date. (The real cron anchors at 12:00 UTC ≈ 8am ET; this override is for testing
  // event windows, so the slight divergence is intentional.)
  const nowMs = date
    ? DateTime.fromISO(date, { zone: EASTERN }).set({ hour: 12 }).toMillis()
    : Date.now();
  const result = await runAdminAction(env, payload.user.id, {
    kind: "reminder",
    name: kind as ReminderName,
    nowMs,
  });
  await deliver(responseUrl, result, false); // the counts are output the admin can't otherwise see
}

export async function handleWelcomeSubmit(
  payload: AdminViewSubmissionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = submitResponseUrl(payload);
  if (!responseUrl) return;
  const target = payload.view.state.values.target?.target?.selected_user;
  if (!target) {
    log.warn("admin.panel.bad_welcome_target", { user: payload.user.id });
    await replaceEphemeral(responseUrl, adminReplyText({ kind: "failed" }));
    return;
  }
  const result = await runAdminAction(env, payload.user.id, { kind: "welcome", target });
  // Sending to yourself is self-verifiable (the DM appears) → just dismiss the panel.
  await deliver(responseUrl, result, target === payload.user.id);
}

export async function handleCoworkingSubmit(
  payload: AdminViewSubmissionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = submitResponseUrl(payload);
  if (!responseUrl) return;
  const op = payload.view.state.values.op?.op?.selected_option?.value;
  if (op !== "open" && op !== "close") {
    log.warn("admin.panel.bad_coworking_op", { op });
    await replaceEphemeral(responseUrl, adminReplyText({ kind: "failed" }));
    return;
  }
  const result = await runAdminAction(env, payload.user.id, { kind: "coworking", op });
  // The announcement is visible in-channel → dismiss; a close with nothing open is not.
  const dismiss = result.kind === "coworking" && (result.op === "open" || result.closed);
  await deliver(responseUrl, result, dismiss);
}
