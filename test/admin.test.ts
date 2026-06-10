import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminCommand, parseSlashCommand } from "../src/bots/admin";
import type { SlackSlashCommand } from "../src/slack/types";

const RESPONSE_URL = "https://hooks.slack.com/commands/resp-1";

interface RecordedCall {
  url: string;
  body: string;
}
let recorded: RecordedCall[];
let isAdmin: boolean;
let cmsEvents: Array<{ id: string; title: string; startsAt: string }>;

beforeEach(() => {
  recorded = [];
  isAdmin = true;
  cmsEvents = [];
  const spy = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    let url: string;
    let body = "";
    if (input instanceof Request) {
      url = input.url;
      body = new TextDecoder().decode(await input.clone().arrayBuffer());
    } else {
      url = String(input);
      body = typeof init?.body === "string" ? init.body : "";
    }
    recorded.push({ url, body });

    if (url.includes("/api/users.info")) {
      return Response.json({ ok: true, user: { is_admin: isAdmin, is_owner: false } });
    }
    if (url.includes("virtualcoffee.io/graphql")) {
      return Response.json({ data: { events: cmsEvents } });
    }
    return Response.json({ ok: true, ts: "1700000000.000100", channel: "C" });
  });
  vi.stubGlobal("fetch", spy);
});
afterEach(() => vi.unstubAllGlobals());

function cmd(text: string): SlackSlashCommand {
  return {
    command: "/vc-bot-admin",
    text,
    user_id: "U1",
    channel_id: "C9",
    response_url: RESPONSE_URL,
    trigger_id: "t",
    team_id: "T",
  };
}
function callsTo(fragment: string): RecordedCall[] {
  return recorded.filter((r) => r.url.includes(fragment));
}
function replyText(): string | undefined {
  const r = recorded.find((c) => c.url === RESPONSE_URL);
  return r ? JSON.parse(r.body).text : undefined;
}

describe("parseSlashCommand", () => {
  it("parses required fields and defaults the rest", () => {
    const parsed = parseSlashCommand(
      new URLSearchParams({ command: "/vc-bot-admin", text: "daily", user_id: "U1", response_url: RESPONSE_URL }),
    );
    expect(parsed?.command).toBe("/vc-bot-admin");
    expect(parsed?.text).toBe("daily");
    expect(parsed?.channel_id).toBe("");
  });

  it("returns null when required fields are missing", () => {
    expect(parseSlashCommand(new URLSearchParams({ text: "daily" }))).toBeNull();
  });
});

describe("handleAdminCommand — authorization", () => {
  it("rejects non-admins and fires nothing", async () => {
    isAdmin = false;
    await handleAdminCommand(cmd("daily"), env);
    expect(replyText()).toContain("admins only");
    expect(callsTo("/api/chat.postMessage")).toHaveLength(0);
  });
});

describe("handleAdminCommand — reminders", () => {
  it("posts the daily reminder to the channel and confirms the count", async () => {
    cmsEvents = [
      { id: "1", title: "Soon", startsAt: new Date(Date.now() + 3_600_000).toISOString() },
    ];
    await handleAdminCommand(cmd("daily"), env);
    expect(callsTo("/api/chat.postMessage")).toHaveLength(1);
    expect(replyText()).toContain("Posted the *daily* reminder (1 event)");
  });

  it("reports when there are no upcoming events", async () => {
    cmsEvents = [];
    await handleAdminCommand(cmd("weekly"), env);
    expect(callsTo("/api/chat.postMessage")).toHaveLength(0);
    expect(replyText()).toContain("No upcoming events");
  });
});

describe("handleAdminCommand — previews", () => {
  it("welcome DMs the invoker", async () => {
    await handleAdminCommand(cmd("welcome"), env);
    const post = callsTo("/api/chat.postMessage")[0];
    expect(new URLSearchParams(post!.body).get("channel")).toBe("U1");
    expect(replyText()).toContain("welcome");
  });

  it("home publishes the App Home view", async () => {
    await handleAdminCommand(cmd("home"), env);
    expect(callsTo("/api/views.publish")).toHaveLength(1);
    expect(replyText()).toContain("App Home");
  });
});

describe("handleAdminCommand — coworking announce", () => {
  it("open posts an announcement, close updates it", async () => {
    await handleAdminCommand(cmd("coworking open"), env);
    expect(callsTo("/api/chat.postMessage").length).toBeGreaterThanOrEqual(1);
    expect(replyText()).toContain("room-open announcement");

    recorded = [];
    await handleAdminCommand(cmd("coworking close"), env);
    expect(callsTo("/api/chat.update")).toHaveLength(1);
    expect(replyText()).toContain("Closed the co-working announcement");
  });

  it("shows usage for an unknown subcommand", async () => {
    await handleAdminCommand(cmd("nonsense"), env);
    expect(replyText()).toContain("/vc-bot-admin");
  });
});

describe("handleAdminCommand — failures", () => {
  it("reports an error back instead of leaving the waitUntil rejection uncaught", async () => {
    // The route has already ACKed by the time this runs (ctx.waitUntil), so a throw here would
    // surface as an uncaught error and the admin would see nothing. Make the work fail:
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { body?: unknown }) => {
        const url = input instanceof Request ? input.url : String(input);
        const body =
          input instanceof Request
            ? new TextDecoder().decode(await input.clone().arrayBuffer())
            : typeof init?.body === "string"
              ? init.body
              : "";
        recorded.push({ url, body });
        if (url.includes("/api/users.info")) {
          return Response.json({ ok: true, user: { is_admin: true, is_owner: false } });
        }
        if (url.includes("/api/chat.postMessage")) {
          return Response.json({ ok: false, error: "channel_not_found" });
        }
        return Response.json({ ok: true });
      }),
    );

    await expect(handleAdminCommand(cmd("welcome"), env)).resolves.toBeUndefined();
    expect(replyText()).toContain(":warning:");
  });
});
