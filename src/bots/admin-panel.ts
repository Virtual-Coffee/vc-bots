import { DateTime } from "luxon";
import type { AnyMessageBlock, AnyModalBlock, ModalView } from "slack-cloudflare-workers";
import type { Env } from "../env";
import { log } from "../log";
import { createSlackClient } from "../slack/client";
import { deleteOriginal, replaceEphemeral } from "../slack/response";
import { isWorkspaceAdmin, reminderReply } from "./admin";
import { homeView } from "./app-home";
import { type ReminderName, sendReminder } from "./reminders";
import { welcomeBlocks } from "./welcome";

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
 */

export const PANEL_REMINDER_ACTION_ID = "admin_panel_reminder";
export const PANEL_WELCOME_ACTION_ID = "admin_panel_welcome";
export const PANEL_COWORKING_ACTION_ID = "admin_panel_coworking";
export const PANEL_HOME_ACTION_ID = "admin_panel_home";

export const REMINDER_MODAL_CALLBACK_ID = "admin_reminder_modal";
export const WELCOME_MODAL_CALLBACK_ID = "admin_welcome_modal";
export const COWORKING_MODAL_CALLBACK_ID = "admin_coworking_modal";

export const PANEL_TEXT = "Bot admin panel";

const DENIED_TEXT = ":no_entry: This command is for workspace admins only.";
const ERROR_TEXT = ":warning: That failed — check the worker logs for details.";

const EASTERN = "America/New_York";

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
 * Shared guard for panel button clicks: require a `response_url` and workspace-admin caller.
 * Returns the response_url to use, or undefined when the click should be dropped (already
 * reported to the user where possible).
 */
async function guardClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<string | undefined> {
  const responseUrl = payload.response_url;
  if (!responseUrl) {
    log.warn("admin.panel.no_response_url", { user: payload.user.id });
    return undefined;
  }
  const client = createSlackClient(env);
  if (!(await isWorkspaceAdmin(client, payload.user.id))) {
    log.warn("admin.panel.denied", { user: payload.user.id });
    await replaceEphemeral(responseUrl, DENIED_TEXT);
    return undefined;
  }
  return responseUrl;
}

export async function handlePanelReminderClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = await guardClick(payload, env);
  if (!responseUrl) return;
  await createSlackClient(env).views.open({
    trigger_id: payload.trigger_id,
    view: reminderModal(responseUrl),
  });
}

export async function handlePanelWelcomeClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = await guardClick(payload, env);
  if (!responseUrl) return;
  await createSlackClient(env).views.open({
    trigger_id: payload.trigger_id,
    view: welcomeModal(responseUrl, payload.user.id),
  });
}

export async function handlePanelCoworkingClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = await guardClick(payload, env);
  if (!responseUrl) return;
  await createSlackClient(env).views.open({
    trigger_id: payload.trigger_id,
    view: coworkingModal(responseUrl),
  });
}

export async function handlePanelHomeClick(
  payload: AdminPanelActionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = await guardClick(payload, env);
  if (!responseUrl) return;
  try {
    await createSlackClient(env).views.publish({ user_id: payload.user.id, view: homeView(env) });
    await deleteOriginal(responseUrl);
  } catch (err) {
    log.error("admin.panel.home_failed", { user: payload.user.id, err: String(err) });
    await replaceEphemeral(responseUrl, ERROR_TEXT);
  }
}

// ── View-submission handlers (modal submit) ─────────────────────────────────

/**
 * Shared guard for modal submits: parse the panel response_url out of private_metadata and
 * re-check workspace-admin. Returns the response_url, or undefined when the submit should be
 * dropped (denied users get the panel replaced; missing metadata is just logged).
 */
async function guardSubmit(
  payload: AdminViewSubmissionPayload,
  env: Env,
): Promise<string | undefined> {
  const meta = parseMetadata(payload.view.private_metadata);
  if (!meta) {
    log.warn("admin.panel.bad_metadata", { user: payload.user.id, cb: payload.view.callback_id });
    return undefined;
  }
  const client = createSlackClient(env);
  if (!(await isWorkspaceAdmin(client, payload.user.id))) {
    log.warn("admin.panel.denied", { user: payload.user.id });
    await replaceEphemeral(meta.response_url, DENIED_TEXT);
    return undefined;
  }
  return meta.response_url;
}

export async function handleReminderSubmit(
  payload: AdminViewSubmissionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = await guardSubmit(payload, env);
  if (!responseUrl) return;
  try {
    const values = payload.view.state.values;
    const kind = values.kind?.kind?.selected_option?.value;
    const date = values.date?.date?.selected_date;
    if (kind !== "daily" && kind !== "weekly") {
      log.warn("admin.panel.bad_reminder_kind", { kind });
      await replaceEphemeral(responseUrl, ERROR_TEXT);
      return;
    }
    // Anchor at noon Eastern: DST-safe, and lands the daily/weekly window squarely on the
    // picked date. (The real cron anchors at 12:00 UTC ≈ 8am ET; this override is for testing
    // event windows, so the slight divergence is intentional.)
    const nowMs = date
      ? DateTime.fromISO(date, { zone: EASTERN }).set({ hour: 12 }).toMillis()
      : undefined;
    const result = await sendReminder(kind as ReminderName, env, nowMs);
    await replaceEphemeral(responseUrl, reminderReply(kind, result));
  } catch (err) {
    log.error("admin.panel.reminder_failed", { user: payload.user.id, err: String(err) });
    await replaceEphemeral(responseUrl, ERROR_TEXT);
  }
}

export async function handleWelcomeSubmit(
  payload: AdminViewSubmissionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = await guardSubmit(payload, env);
  if (!responseUrl) return;
  try {
    const target = payload.view.state.values.target?.target?.selected_user;
    if (!target) {
      log.warn("admin.panel.bad_welcome_target", { user: payload.user.id });
      await replaceEphemeral(responseUrl, ERROR_TEXT);
      return;
    }
    await createSlackClient(env).chat.postMessage({
      channel: target,
      text: "Welcome message preview",
      blocks: welcomeBlocks(env, target),
      link_names: true,
      unfurl_links: false,
      unfurl_media: false,
    });
    // Sending to yourself is self-verifiable (the DM appears) → just dismiss the panel.
    if (target === payload.user.id) {
      await deleteOriginal(responseUrl);
    } else {
      await replaceEphemeral(responseUrl, `:white_check_mark: Sent the welcome message to <@${target}>.`);
    }
  } catch (err) {
    log.error("admin.panel.welcome_failed", { user: payload.user.id, err: String(err) });
    await replaceEphemeral(responseUrl, ERROR_TEXT);
  }
}

export async function handleCoworkingSubmit(
  payload: AdminViewSubmissionPayload,
  env: Env,
): Promise<void> {
  const responseUrl = await guardSubmit(payload, env);
  if (!responseUrl) return;
  try {
    const op = payload.view.state.values.op?.op?.selected_option?.value;
    const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
    if (op === "open") {
      await stub.adminAnnounceOpen();
      await deleteOriginal(responseUrl); // the announcement is visible in-channel
      return;
    }
    if (op === "close") {
      const { closed } = await stub.adminAnnounceClose();
      if (closed) {
        await deleteOriginal(responseUrl);
      } else {
        await replaceEphemeral(responseUrl, ":information_source: No open announcement to close.");
      }
      return;
    }
    log.warn("admin.panel.bad_coworking_op", { op });
    await replaceEphemeral(responseUrl, ERROR_TEXT);
  } catch (err) {
    log.error("admin.panel.coworking_failed", { user: payload.user.id, err: String(err) });
    await replaceEphemeral(responseUrl, ERROR_TEXT);
  }
}
