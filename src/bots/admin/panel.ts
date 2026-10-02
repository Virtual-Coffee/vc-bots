import { DateTime } from "luxon";
import type { AnyMessageBlock, AnyModalBlock, Button, ModalView } from "slack-cloudflare-workers";
import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { deleteOriginal, replaceEphemeral } from "../../slack/response";
import { EASTERN } from "../../events";
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
 * One `PANEL_BUTTONS` row per button drives everything: the Block Kit button, the click
 * dispatch, and (for modal buttons) the modal view, its submit parsing and the replace-vs-
 * dismiss rule. `src/slack/app.ts` registers each row's exact `action_id` / `callback_id` as a
 * lazy listener that calls `handlePanelClick` / `handlePanelSubmit`. The panel is a per-user
 * ephemeral, so REPLACE/DISMISS via its `response_url` are both safe (unlike the shared room
 * message — see `src/slack/response.ts`). A `block_actions` payload carries that
 * `response_url`, but a `view_submission` does NOT, so it travels into the modal as
 * `private_metadata` and back out on submit.
 *
 * This is the Block Kit adapter over `actions.ts`: each click or submit is parsed into an
 * `AdminAction`, run (the admin gate and error handling live there), and its `AdminResult`
 * delivered into the panel. Only the modal-opening buttons gate themselves (`guardAdmin`).
 */

export const PANEL_TEXT = "Bot admin panel";

const REMINDER_MODAL_CALLBACK_ID = "admin_reminder_modal";
const WELCOME_MODAL_CALLBACK_ID = "admin_welcome_modal";
const COWORKING_MODAL_CALLBACK_ID = "admin_coworking_modal";

/** Carried through a modal so the submit handler can reach back to the panel ephemeral. */
interface PanelMetadata {
  response_url: string;
}

function parseMetadata(raw: string): PanelMetadata | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<PanelMetadata>;
    return typeof parsed.response_url === "string"
      ? { response_url: parsed.response_url }
      : undefined;
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
      elements: [
        { type: "mrkdwn", text: "Sends the welcome message as a DM to the chosen member." },
      ],
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

type ModalValues = AdminViewSubmissionPayload["view"]["state"]["values"];

/** A modal a panel button opens, and how its submit becomes an action. */
interface PanelModal {
  callbackId: string;
  view: (responseUrl: string, userId: string) => ModalView;
  /** `undefined` = the submitted values are unusable. */
  parse: (values: ModalValues, userId: string) => AdminAction | undefined;
}

interface PanelButton {
  actionId: string;
  label: string;
  /** Which row of `adminPanelBlocks()` the button sits in. */
  row: "main" | "watch";
  /** Names the `guardAdmin` gate and the `admin.panel.<x>` / `admin.modal.<x>` lazy listeners. */
  logName: string;
  /** DISMISS the panel (true) or REPLACE it with the reply (false); denied/failed always replace. */
  dismiss: (result: AdminResult, userId: string) => boolean;
  click:
    { kind: "modal"; modal: PanelModal } | { kind: "run"; action: (userId: string) => AdminAction };
}

// ── The table ───────────────────────────────────────────────────────────────

export const PANEL_BUTTONS: readonly PanelButton[] = [
  {
    actionId: "admin_panel_reminder",
    label: "Run reminder…",
    row: "main",
    logName: "reminder",
    click: {
      kind: "modal",
      modal: {
        callbackId: REMINDER_MODAL_CALLBACK_ID,
        view: reminderModal,
        parse(values) {
          const kind = values.kind?.kind?.selected_option?.value;
          const date = values.date?.date?.selected_date;
          if (kind !== "daily" && kind !== "weekly") return undefined;
          // Anchor at noon Eastern: DST-safe, and lands the daily/weekly window squarely on the
          // picked date. (The real cron anchors at 12:00 UTC ≈ 8am ET; this override is for testing
          // event windows, so the slight divergence is intentional.)
          const nowMs = date
            ? DateTime.fromISO(date, { zone: EASTERN }).set({ hour: 12 }).toMillis()
            : Date.now();
          return { kind: "reminder", name: kind, nowMs };
        },
      },
    },
    dismiss: () => false, // the counts are output the admin can't otherwise see
  },
  {
    actionId: "admin_panel_welcome",
    label: "Send welcome…",
    row: "main",
    logName: "welcome",
    click: {
      kind: "modal",
      modal: {
        callbackId: WELCOME_MODAL_CALLBACK_ID,
        view: welcomeModal,
        parse(values) {
          const target = values.target?.target?.selected_user;
          return target ? { kind: "welcome", target } : undefined;
        },
      },
    },
    // Sending to yourself is self-verifiable (the DM appears) → just dismiss the panel.
    dismiss: (result, userId) => result.kind === "welcome" && result.target === userId,
  },
  {
    actionId: "admin_panel_coworking",
    label: "Coworking…",
    row: "main",
    logName: "coworking",
    click: {
      kind: "modal",
      modal: {
        callbackId: COWORKING_MODAL_CALLBACK_ID,
        view: coworkingModal,
        parse(values) {
          const op = values.op?.op?.selected_option?.value;
          return op === "open" || op === "close" ? { kind: "coworking", op } : undefined;
        },
      },
    },
    // The announcement is visible in-channel → dismiss; a close with nothing open is not.
    dismiss: (result) => result.kind === "coworking" && (result.op === "open" || result.closed),
  },
  {
    actionId: "admin_panel_home",
    label: "Publish App Home",
    row: "main",
    logName: "home",
    // The App Home tab is self-verifiable → dismiss.
    dismiss: () => true,
    click: { kind: "run", action: (userId) => ({ kind: "home", userId }) },
  },
  {
    actionId: "admin_panel_availability",
    label: "Post availability check-in",
    row: "main",
    logName: "availability",
    // The trio is visible in-channel → dismiss; only the off state needs telling.
    dismiss: (result) => result.kind === "availability" && result.posted,
    click: { kind: "run", action: () => ({ kind: "availability" }) },
  },
  {
    actionId: "admin_panel_watch_status",
    label: "Watch status",
    row: "watch",
    logName: "watch_status",
    dismiss: () => false,
    click: { kind: "run", action: () => ({ kind: "watch", op: "status" }) },
  },
  {
    actionId: "admin_panel_watch_start",
    label: "Start watch",
    row: "watch",
    logName: "watch_start",
    dismiss: () => false,
    click: { kind: "run", action: () => ({ kind: "watch", op: "start" }) },
  },
  {
    actionId: "admin_panel_watch_stop",
    label: "Stop watch",
    row: "watch",
    logName: "watch_stop",
    dismiss: () => false,
    click: { kind: "run", action: () => ({ kind: "watch", op: "stop" }) },
  },
];

function buttonBlock(b: PanelButton): Button {
  return {
    type: "button",
    action_id: b.actionId,
    text: { type: "plain_text", text: b.label, emoji: true },
  };
}

/** Panel ephemeral blocks: a heading plus one button per admin function. */
export function adminPanelBlocks(): AnyMessageBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Bot admin panel* — pick an action:" },
    },
    {
      type: "actions",
      elements: PANEL_BUTTONS.filter((b) => b.row === "main").map(buttonBlock),
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Calendar Watch* — Google Calendar push channel:" },
    },
    {
      type: "actions",
      elements: PANEL_BUTTONS.filter((b) => b.row === "watch").map(buttonBlock),
    },
  ];
}

// ── Dispatch ────────────────────────────────────────────────────────────────

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
 * Panel buttons that open a modal do no action work, so they gate themselves; the panel is
 * replaced with the denial for non-admins.
 */
async function openModal(
  payload: AdminPanelActionPayload,
  env: Env,
  responseUrl: string,
  button: PanelButton,
  modal: PanelModal,
): Promise<void> {
  if (!(await guardAdmin(env, payload.user.id, { modal: button.logName }))) {
    await replaceEphemeral(responseUrl, adminReplyText({ kind: "denied" }));
    return;
  }
  await createSlackClient(env).views.open({
    trigger_id: payload.trigger_id,
    view: modal.view(responseUrl, payload.user.id),
  });
}

/**
 * A panel button click: look the button up by `action_id` and open its modal or run its action.
 * The click is dropped without a `response_url` (nowhere to reply).
 */
export async function handlePanelClick(payload: AdminPanelActionPayload, env: Env): Promise<void> {
  const actionId = payload.actions[0]?.action_id;
  const button = PANEL_BUTTONS.find((b) => b.actionId === actionId);
  if (!button) {
    log.warn("admin.panel.unknown_action", { user: payload.user.id, action: actionId });
    return;
  }
  const responseUrl = payload.response_url;
  if (!responseUrl) {
    log.warn("admin.panel.no_response_url", { user: payload.user.id });
    return;
  }
  const { click } = button;
  if (click.kind === "modal") {
    await openModal(payload, env, responseUrl, button, click.modal);
    return;
  }
  const userId = payload.user.id;
  const result = await runAdminAction(env, userId, click.action(userId));
  await deliver(responseUrl, result, button.dismiss(result, userId));
}

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

/** A modal submit: look the modal's button up by `callback_id`, parse its values, run, deliver. */
export async function handlePanelSubmit(
  payload: AdminViewSubmissionPayload,
  env: Env,
): Promise<void> {
  const callbackId = payload.view.callback_id;
  const button = PANEL_BUTTONS.find(
    (b) => b.click.kind === "modal" && b.click.modal.callbackId === callbackId,
  );
  if (!button || button.click.kind !== "modal") {
    log.warn("admin.panel.unknown_callback", { user: payload.user.id, cb: callbackId });
    return;
  }
  const responseUrl = submitResponseUrl(payload);
  if (!responseUrl) return;
  const userId = payload.user.id;
  const action = button.click.modal.parse(payload.view.state.values, userId);
  if (!action) {
    log.warn("admin.panel.bad_input", {
      user: userId,
      cb: callbackId,
      values: payload.view.state.values,
    });
    await replaceEphemeral(responseUrl, adminReplyText({ kind: "failed" }));
    return;
  }
  const result = await runAdminAction(env, userId, action);
  await deliver(responseUrl, result, button.dismiss(result, userId));
}
