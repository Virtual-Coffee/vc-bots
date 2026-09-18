import { vi } from "vitest";

/**
 * Records every outbound `fetch` a test triggers (Slack Web API, Zoom OAuth, Zoom invite links,
 * Google Calendar, Slack `response_url`s) and answers each with a canned response, so
 * end-to-end suites can run against the real Worker/DO code with no network.
 *
 * `installFetchRecorder` stubs the global `fetch` (undo it with `vi.unstubAllGlobals()` in
 * `afterEach`). Answers come from the test's own `respond` override first, then the defaults:
 * Zoom OAuth → a token, Zoom invite links → one attendee with `zoomJoinUrl`, Google OAuth → a
 * token, Google Calendar events list → the next page in `googlePages` else `{ items: googleEvents }`,
 * a single-event GET → `googleEvent(id)` else the matching `googleEvents` item else 404,
 * `events/watch` → a `res-1` channel expiring in 7 days, `channels/stop` → `{}`,
 * `users.profile.get` → `profileName`, `auth.test` → `botUserId`, `reactions.get` → no
 * reactions, `chat.postMessage` → the next ts in `postTs` (the last one repeats), and anything
 * else → `{ ok: true }` with `defaultTs`.
 */

export interface RecordedCall {
  url: string;
  /** Upper-case HTTP method (`GET` when unspecified). */
  method: string;
  body: string;
  /** The `Authorization` request header, `null` when absent. */
  authorization: string | null;
}

/** Answer a call yourself, or return `undefined` to fall through to the defaults. */
export type Responder = (
  call: RecordedCall,
) => Response | undefined | Promise<Response | undefined>;

export interface FetchRecorderOptions {
  /** Tried before the defaults for every call. */
  respond?: Responder;
  /** ts handed out by successive `chat.postMessage` calls; the last one repeats. */
  postTs?: string[];
  /** ts in the generic `{ ok: true }` answer (chat.update etc.). */
  defaultTs?: string;
  /** The personal join url the Zoom invite-link stub returns. */
  zoomJoinUrl?: string;
  /** `real_name` the `users.profile.get` stub returns. */
  profileName?: string;
  /** Events: list items the Google Calendar stub returns (a single page); a thunk is re-read per call. */
  googleEvents?: object[] | (() => object[]);
  /** Raw Events: list pages shifted off this array in order (pagination); once drained, `googleEvents`. */
  googlePages?: object[];
  /** Answer a single-event GET yourself (a body, a Response, or `undefined` for the default). */
  googleEvent?: (id: string) => object | Response | undefined;
  /** `user_id` the `auth.test` stub returns. */
  botUserId?: string;
}

export interface FetchRecorder {
  /** Every call so far, in order — survives `respondWith` swaps. */
  readonly calls: RecordedCall[];
  /** Calls whose url contains `fragment` (e.g. `"/api/chat.update"`, `"api.zoom.us/v2/meetings/"`). */
  callsTo(fragment: string): RecordedCall[];
  /** The form-encoded body of a Slack Web API call. */
  form(call: RecordedCall): URLSearchParams;
  /** The `blocks` payload (JSON string) of the most recent call to a Slack endpoint. */
  lastBlocks(fragment: string): string;
  /** Swap the override responder mid-test; recording keeps accumulating. */
  respondWith(responder: Responder | undefined): void;
}

const DEFAULT_TS = "1700000000.000100";
/** The `extendedProperties.private.hostCode` the Zoom-link Google fixtures carry. */
export const HOST_CODE = "123456";

export function installFetchRecorder(options: FetchRecorderOptions = {}): FetchRecorder {
  const calls: RecordedCall[] = [];
  let respond = options.respond;
  let postCount = 0;
  const postTs = options.postTs ?? [options.defaultTs ?? DEFAULT_TS];
  const defaultTs = options.defaultTs ?? DEFAULT_TS;
  const zoomJoinUrl = options.zoomJoinUrl ?? "https://zoom.us/w/personal-1";
  const profileName = options.profileName ?? "Ada";
  const googleEvents = (): object[] => {
    const events = options.googleEvents ?? [];
    return typeof events === "function" ? events() : events;
  };
  const googlePages = options.googlePages ?? [];
  const botUserId = options.botUserId ?? "UBOT";

  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    // One effective Request, so `fetch(request, init)` overrides are recorded like the rest.
    const request = new Request(input, init);
    const call: RecordedCall = {
      url: request.url,
      method: request.method,
      body: new TextDecoder().decode(await request.arrayBuffer()),
      authorization: request.headers.get("authorization"),
    };
    calls.push(call);
    const { url, method } = call;

    const custom = await respond?.(call);
    if (custom) return custom;

    if (url.includes("zoom.us/oauth/token")) {
      return Response.json({
        access_token: "zoom-token",
        token_type: "bearer",
        expires_in: 3600,
      });
    }
    if (method === "POST" && url.includes("api.zoom.us/v2/meetings/")) {
      return Response.json({ attendees: [{ name: profileName, join_url: zoomJoinUrl }] });
    }
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "g-tok", expires_in: 3600 });
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/")) {
      return googleCalendar(url, method);
    }
    if (url.includes("/api/users.profile.get")) {
      return Response.json({ ok: true, profile: { real_name: profileName } });
    }
    if (url.includes("/api/auth.test")) {
      return Response.json({ ok: true, user_id: botUserId, bot_id: "B-BOT" });
    }
    if (url.includes("/api/reactions.get")) {
      return Response.json({ ok: true, type: "message", message: { reactions: [] } });
    }
    if (url.includes("/api/chat.postMessage")) {
      const ts = postTs[Math.min(postCount++, postTs.length - 1)] ?? defaultTs;
      return Response.json({ ok: true, ts, channel: "C0B6C3BFEDD" });
    }
    return Response.json({ ok: true, ts: defaultTs, channel: "C0B6C3BFEDD" });
  });
  vi.stubGlobal("fetch", spy);

  function googleCalendar(url: string, method: string): Response {
    const { pathname } = new URL(url);
    if (pathname === "/calendar/v3/channels/stop") {
      return Response.json({});
    }
    if (method === "POST" && pathname.endsWith("/events/watch")) {
      return Response.json({ resourceId: "res-1", expiration: String(Date.now() + 604_800_000) });
    }
    // Single-event GET: /calendar/v3/calendars/{id}/events/{eventId}
    const single = pathname.match(/\/events\/([^/]+)$/);
    if (single) {
      const id = decodeURIComponent(single[1]!);
      const custom = options.googleEvent?.(id);
      if (custom instanceof Response) return custom;
      const body = custom ?? googleEvents().find((e) => (e as { id?: string }).id === id);
      return body ? Response.json(body) : new Response("not found", { status: 404 });
    }
    // Events: list.
    return Response.json(googlePages.shift() ?? { items: googleEvents() });
  }

  const callsTo = (fragment: string) => calls.filter((c) => c.url.includes(fragment));
  const form = (call: RecordedCall) => new URLSearchParams(call.body);
  return {
    calls,
    callsTo,
    form,
    lastBlocks(fragment) {
      const call = callsTo(fragment).at(-1);
      return call ? (form(call).get("blocks") ?? "") : "";
    },
    respondWith(responder) {
      respond = responder;
    },
  };
}
