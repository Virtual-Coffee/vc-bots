import { env, runInDurableObject } from "cloudflare:test";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleCalendarEvent } from "../src/google/calendar";
import {
  type FetchRecorder,
  installFetchRecorder,
  type RecordedCall,
} from "./helpers/fetch-recorder";
import {
  type AdminPanelActionPayload,
  type AdminViewSubmissionPayload,
  adminPanelBlocks,
  handlePanelClick,
  handlePanelSubmit,
  PANEL_BUTTONS,
} from "../src/bots/admin/panel";
import { log } from "../src/log";

/**
 * Unit coverage for the `/vc-bot-admin` panel handlers, using the same stubbed-fetch harness
 * as admin.test.ts. The panel ephemeral's response_url is PANEL_URL; modal clicks open a
 * view via /api/views.open (response_url threaded through private_metadata), and submits
 * either REPLACE that ephemeral (output the admin needs) or DELETE it (self-verifiable work).
 */

const PANEL_URL = "https://hooks.slack.com/actions/panel-1";
const TRIGGER_ID = "TRIG-1";

let rec: FetchRecorder;
let isAdmin: boolean;
let googleEvents: GoogleCalendarEvent[];
let postMessageOk: boolean;

beforeEach(() => {
  isAdmin = true;
  googleEvents = [];
  postMessageOk = true;
  rec = installFetchRecorder({
    googleEvents: () => googleEvents,
    respond(call) {
      if (call.url.includes("/api/users.info")) {
        return Response.json({ ok: true, user: { is_admin: isAdmin, is_owner: false } });
      }
      if (!postMessageOk && call.url.includes("/api/chat.postMessage")) {
        return Response.json({ ok: false, error: "channel_not_found" });
      }
      return undefined;
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function callsTo(fragment: string): RecordedCall[] {
  return rec.callsTo(fragment);
}
function panelReply(): Record<string, unknown> | undefined {
  const r = rec.calls.find((c) => c.url === PANEL_URL);
  return r ? JSON.parse(r.body) : undefined;
}
function viewsOpenView(): Record<string, unknown> {
  const call = callsTo("/api/views.open")[0];
  const params = new URLSearchParams(call!.body);
  return JSON.parse(params.get("view")!);
}
function metaResponseUrl(view: Record<string, unknown>): string {
  return JSON.parse(view.private_metadata as string).response_url;
}
function inputElement(view: Record<string, unknown>, blockId: string): Record<string, unknown> {
  const blocks = view.blocks as Array<Record<string, unknown>>;
  const block = blocks.find((b) => b.block_id === blockId);
  return block!.element as Record<string, unknown>;
}

function action(actionId: string): AdminPanelActionPayload {
  return {
    user: { id: "U1" },
    trigger_id: TRIGGER_ID,
    response_url: PANEL_URL,
    actions: [{ action_id: actionId }],
  };
}
function submission(
  callbackId: string,
  values: AdminViewSubmissionPayload["view"]["state"]["values"],
  opts?: { user?: string },
): AdminViewSubmissionPayload {
  return {
    user: { id: opts?.user ?? "U1" },
    view: {
      callback_id: callbackId,
      private_metadata: JSON.stringify({ response_url: PANEL_URL }),
      state: { values },
    },
  };
}

function googleEvt(startMs: number): GoogleCalendarEvent {
  const iso = new Date(startMs).toISOString();
  return { id: "1", summary: "Soon", start: { dateTime: iso }, end: { dateTime: iso } };
}

describe("admin panel — button clicks open modals", () => {
  it("reminder button opens the reminder modal with today's date and the panel response_url", async () => {
    await handlePanelClick(action("admin_panel_reminder"), env);
    expect(callsTo("/api/views.open")).toHaveLength(1);
    const view = viewsOpenView();
    expect(view.callback_id).toBe("admin_reminder_modal");
    expect(metaResponseUrl(view)).toBe(PANEL_URL);
    const today = DateTime.now().setZone("America/New_York").toISODate();
    expect(inputElement(view, "date").initial_date).toBe(today);
    expect(new URLSearchParams(callsTo("/api/views.open")[0]!.body).get("trigger_id")).toBe(
      TRIGGER_ID,
    );
  });

  it("welcome button opens the welcome modal pre-selecting the clicking admin", async () => {
    await handlePanelClick(action("admin_panel_welcome"), env);
    const view = viewsOpenView();
    expect(view.callback_id).toBe("admin_welcome_modal");
    expect(inputElement(view, "target").initial_user).toBe("U1");
  });

  it("coworking button opens the coworking modal", async () => {
    await handlePanelClick(action("admin_panel_coworking"), env);
    expect(viewsOpenView().callback_id).toBe("admin_coworking_modal");
  });

  it("publish App Home fires directly and dismisses the panel", async () => {
    await handlePanelClick(action("admin_panel_home"), env);
    const publish = callsTo("/api/views.publish");
    expect(publish).toHaveLength(1);
    expect(new URLSearchParams(publish[0]!.body).get("user_id")).toBe("U1");
    expect(panelReply()).toEqual({ delete_original: true });
  });

  it("post availability check-in fires directly and dismisses the panel", async () => {
    await handlePanelClick(action("admin_panel_availability"), env);
    expect(callsTo("/api/chat.postMessage")).toHaveLength(3);
    expect(callsTo("/api/reactions.add")).toHaveLength(10);
    expect(panelReply()).toEqual({ delete_original: true });
  });

  it("post availability check-in reports the off state instead of dismissing", async () => {
    await handlePanelClick(action("admin_panel_availability"), {
      ...env,
      SLACK_AVAILABILITY_CHANNEL_ID: "",
    });
    expect(callsTo("/api/chat.postMessage")).toHaveLength(0);
    expect(panelReply()!.text).toContain("SLACK_AVAILABILITY_CHANNEL_ID");
  });
});

describe("admin panel — reminder submit", () => {
  it("weekly posts to the channel and replaces the panel with the count", async () => {
    googleEvents = [googleEvt(Date.now() + 3_600_000)];
    await handlePanelSubmit(
      submission("admin_reminder_modal", {
        kind: { kind: { selected_option: { value: "weekly" } } },
        date: { date: { selected_date: "2024-06-18" } },
      }),
      env,
    );
    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);
    const reply = panelReply()!;
    expect(reply.replace_original).toBe(true);
    expect(reply.text).toContain("Posted the *weekly* reminder (1 event)");
  });

  it("the picked date drives the window — a Monday daily run reports the weekly-covers-Monday skip", async () => {
    googleEvents = [];
    // 2024-01-01 is a Monday; noon-Eastern of it lands sendReminder on the Monday-skip path.
    await handlePanelSubmit(
      submission("admin_reminder_modal", {
        kind: { kind: { selected_option: { value: "daily" } } },
        date: { date: { selected_date: "2024-01-01" } },
      }),
      env,
    );
    expect(callsTo("/api/chat.postMessage")).toHaveLength(0);
    expect(panelReply()!.text).toContain("Mondays");
  });
});

describe("admin panel — welcome submit", () => {
  it("to self DMs the user and dismisses the panel", async () => {
    await handlePanelSubmit(
      submission("admin_welcome_modal", {
        target: { target: { selected_user: "U1" } },
      }),
      env,
    );
    const post = callsTo("/api/chat.postMessage")[0];
    expect(new URLSearchParams(post!.body).get("channel")).toBe("U1");
    expect(panelReply()).toEqual({ delete_original: true });
  });

  it("to another member DMs them and replaces the panel with a confirmation", async () => {
    await handlePanelSubmit(
      submission("admin_welcome_modal", {
        target: { target: { selected_user: "U2" } },
      }),
      env,
    );
    const post = callsTo("/api/chat.postMessage")[0];
    expect(new URLSearchParams(post!.body).get("channel")).toBe("U2");
    const reply = panelReply()!;
    expect(reply.replace_original).toBe(true);
    expect(reply.text).toContain("Sent the welcome message to <@U2>");
  });
});

describe("admin panel — coworking submit", () => {
  // The handlers address one fixed DO instance (env.ZOOM_MEETING_ID), so its storage carries
  // between tests here; reset it so each coworking case starts from a known-empty room.
  beforeEach(async () => {
    const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
    await runInDurableObject(stub, (_i, state) => state.storage.deleteAll());
  });

  it("open posts an announcement and dismisses the panel", async () => {
    await handlePanelSubmit(
      submission("admin_coworking_modal", {
        op: { op: { selected_option: { value: "open" } } },
      }),
      env,
    );
    expect(callsTo("/api/chat.postMessage").length).toBeGreaterThanOrEqual(1);
    expect(panelReply()).toEqual({ delete_original: true });
  });

  it("close with nothing open replaces the panel with the info notice", async () => {
    await handlePanelSubmit(
      submission("admin_coworking_modal", {
        op: { op: { selected_option: { value: "close" } } },
      }),
      env,
    );
    expect(callsTo("/api/chat.update")).toHaveLength(0);
    expect(panelReply()!.text).toContain("No open announcement to close");
  });
});

describe("admin panel — watch buttons", () => {
  beforeEach(async () => {
    const stub = env.CALENDAR_SYNC.getByName("default");
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec("DELETE FROM channel; DELETE FROM event_snapshot;");
    });
  });

  it("watch status replaces the panel with the status line", async () => {
    await handlePanelClick(action("admin_panel_watch_status"), env);
    const reply = panelReply()!;
    expect(reply.replace_original).toBe(true);
    expect(reply.text).toContain("Calendar watch is *not active*");
  });
});

describe("admin panel — authorization & errors", () => {
  it("a non-admin click does no work and replaces the panel with the denial", async () => {
    isAdmin = false;
    await handlePanelClick(action("admin_panel_reminder"), env);
    expect(callsTo("/api/views.open")).toHaveLength(0);
    expect(panelReply()!.text).toContain("admins only");

    rec.calls.length = 0;
    await handlePanelClick(action("admin_panel_availability"), env);
    expect(callsTo("/api/chat.postMessage")).toHaveLength(0);
    expect(panelReply()!.text).toContain("admins only");
  });

  it("a non-admin submit does no work and replaces the panel with the denial", async () => {
    isAdmin = false;
    await handlePanelSubmit(
      submission("admin_welcome_modal", {
        target: { target: { selected_user: "U2" } },
      }),
      env,
    );
    expect(callsTo("/api/chat.postMessage")).toHaveLength(0);
    expect(panelReply()!.text).toContain("admins only");
  });

  it("a failed submit reports the error back into the panel", async () => {
    postMessageOk = false;
    await handlePanelSubmit(
      submission("admin_welcome_modal", {
        target: { target: { selected_user: "U2" } },
      }),
      env,
    );
    expect(panelReply()!.text).toContain(":warning:");
  });
});

describe("admin panel — the table", () => {
  it("action_ids and callback_ids are unique", () => {
    const actionIds = PANEL_BUTTONS.map((b) => b.actionId);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    const callbackIds = PANEL_BUTTONS.flatMap((b) =>
      b.click.kind === "modal" ? [b.click.modal.callbackId] : [],
    );
    expect(new Set(callbackIds).size).toBe(callbackIds.length);
  });

  it("an unknown action_id logs and does nothing", async () => {
    const warn = vi.spyOn(log, "warn");
    await handlePanelClick(action("admin_panel_nope"), env);
    expect(warn).toHaveBeenCalledWith("admin.panel.unknown_action", expect.anything());
    expect(rec.calls).toHaveLength(0);
  });

  it("an unknown callback_id logs and does nothing", async () => {
    const warn = vi.spyOn(log, "warn");
    await handlePanelSubmit(submission("admin_nope_modal", {}), env);
    expect(warn).toHaveBeenCalledWith("admin.panel.unknown_callback", expect.anything());
    expect(rec.calls).toHaveLength(0);
  });

  it.each([
    ["admin_reminder_modal", { kind: { kind: { selected_option: { value: "monthly" } } } }],
    ["admin_welcome_modal", {}],
    ["admin_coworking_modal", { op: { op: { selected_option: { value: "explode" } } } }],
  ])(
    "bad %s input logs bad_input and replaces the panel with the failed reply",
    async (cb, values) => {
      const warn = vi.spyOn(log, "warn");
      await handlePanelSubmit(submission(cb, values), env);
      expect(warn).toHaveBeenCalledWith("admin.panel.bad_input", { user: "U1", cb });
      expect(callsTo("/api/chat.postMessage")).toHaveLength(0);
      expect(panelReply()!.replace_original).toBe(true);
      expect(panelReply()!.text).toContain(":warning:");
    },
  );
});
