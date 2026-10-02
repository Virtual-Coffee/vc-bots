import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminPanelBlocks,
  handlePanelCoworkingClick,
  handlePanelReminderClick,
  handlePanelWelcomeClick,
} from "../src/bots/admin/panel";
import { type FetchRecorder, installFetchRecorder } from "./helpers/fetch-recorder";

/**
 * Characterization of the panel's hand-tuned Block Kit: `adminPanelBlocks()` and the three
 * modal views, pinned as full literals. The modal builders are private, so each view is read
 * back from the `views.open` body a click records. Only `click` knows how a click is invoked.
 */

const PANEL_URL = "https://hooks.slack.com/actions/panel-1";

let rec: FetchRecorder;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-06-18T16:00:00Z"));
  rec = installFetchRecorder({
    respond(call) {
      if (call.url.includes("/api/users.info")) {
        return Response.json({ ok: true, user: { is_admin: true, is_owner: false } });
      }
      return undefined;
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const handlers = {
  admin_panel_reminder: handlePanelReminderClick,
  admin_panel_welcome: handlePanelWelcomeClick,
  admin_panel_coworking: handlePanelCoworkingClick,
};

async function click(actionId: keyof typeof handlers): Promise<void> {
  await handlers[actionId](
    {
      user: { id: "U1" },
      trigger_id: "TRIG-1",
      response_url: PANEL_URL,
      actions: [{ action_id: actionId }],
    },
    env,
  );
}

async function openedView(actionId: keyof typeof handlers): Promise<unknown> {
  await click(actionId);
  const call = rec.callsTo("/api/views.open")[0];
  return JSON.parse(new URLSearchParams(call!.body).get("view")!);
}

const metadata = JSON.stringify({ response_url: PANEL_URL });

describe("admin panel — Block Kit layout", () => {
  it("adminPanelBlocks", () => {
    expect(adminPanelBlocks()).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Bot admin panel* — pick an action:" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "admin_panel_reminder",
            text: { type: "plain_text", text: "Run reminder…", emoji: true },
          },
          {
            type: "button",
            action_id: "admin_panel_welcome",
            text: { type: "plain_text", text: "Send welcome…", emoji: true },
          },
          {
            type: "button",
            action_id: "admin_panel_coworking",
            text: { type: "plain_text", text: "Coworking…", emoji: true },
          },
          {
            type: "button",
            action_id: "admin_panel_home",
            text: { type: "plain_text", text: "Publish App Home", emoji: true },
          },
          {
            type: "button",
            action_id: "admin_panel_availability",
            text: { type: "plain_text", text: "Post availability check-in", emoji: true },
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
            action_id: "admin_panel_watch_status",
            text: { type: "plain_text", text: "Watch status", emoji: true },
          },
          {
            type: "button",
            action_id: "admin_panel_watch_start",
            text: { type: "plain_text", text: "Start watch", emoji: true },
          },
          {
            type: "button",
            action_id: "admin_panel_watch_stop",
            text: { type: "plain_text", text: "Stop watch", emoji: true },
          },
        ],
      },
    ]);
  });

  it("reminder modal", async () => {
    expect(await openedView("admin_panel_reminder")).toEqual({
      type: "modal",
      callback_id: "admin_reminder_modal",
      private_metadata: metadata,
      title: { type: "plain_text", text: "Run reminder" },
      submit: { type: "plain_text", text: "Run" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
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
          element: { type: "datepicker", action_id: "date", initial_date: "2024-06-18" },
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
      ],
    });
  });

  it("welcome modal", async () => {
    expect(await openedView("admin_panel_welcome")).toEqual({
      type: "modal",
      callback_id: "admin_welcome_modal",
      private_metadata: metadata,
      title: { type: "plain_text", text: "Send welcome" },
      submit: { type: "plain_text", text: "Send" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "target",
          label: { type: "plain_text", text: "Send the welcome message to", emoji: true },
          element: { type: "users_select", action_id: "target", initial_user: "U1" },
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: "Sends the welcome message as a DM to the chosen member." },
          ],
        },
      ],
    });
  });

  it("coworking modal", async () => {
    expect(await openedView("admin_panel_coworking")).toEqual({
      type: "modal",
      callback_id: "admin_coworking_modal",
      private_metadata: metadata,
      title: { type: "plain_text", text: "Coworking" },
      submit: { type: "plain_text", text: "Go" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
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
      ],
    });
  });
});
