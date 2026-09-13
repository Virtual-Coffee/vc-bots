import { vi } from "vitest";

/**
 * Records every outbound `fetch` a test triggers (Slack Web API, Zoom OAuth, Zoom invite links,
 * Zoom meeting/user lookups, Google Calendar, Slack `response_url`s) and answers each with a
 * canned response, so end-to-end suites can run against the real Worker/DO code with no network.
 *
 * `installFetchRecorder` stubs the global `fetch` (undo it with `vi.unstubAllGlobals()` in
 * `afterEach`). Answers come from the test's own `respond` override first, then the defaults:
 * Zoom OAuth → a token, Zoom invite links → one attendee with `zoomJoinUrl`, Zoom meeting GET →
 * `{ host_id }`, Zoom user GET → `{ host_key: zoomHostKey }`, Google OAuth → a token, Google
 * Calendar events list → `{ items: googleEvents }`, `users.profile.get` → `profileName`,
 * `chat.postMessage` → the next ts in `postTs` (the last one repeats), and anything else →
 * `{ ok: true }` with `defaultTs`.
 */

export interface RecordedCall {
  url: string;
  /** Upper-case HTTP method (`GET` when unspecified). */
  method: string;
  body: string;
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
  /** `host_key` the Zoom user stub returns (the meeting stub's `host_id` is always `HOST1`). */
  zoomHostKey?: string;
  /** Events: list items the Google Calendar stub returns (a single page); a thunk is re-read per call. */
  googleEvents?: object[] | (() => object[]);
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
/** `host_id` every stubbed Zoom meeting reports. */
export const ZOOM_HOST_ID = "HOST1";
/** `host_key` the stubbed Zoom user reports unless `zoomHostKey` overrides it. */
export const ZOOM_HOST_KEY = "123456";

export function installFetchRecorder(options: FetchRecorderOptions = {}): FetchRecorder {
  const calls: RecordedCall[] = [];
  let respond = options.respond;
  let postCount = 0;
  const postTs = options.postTs ?? [options.defaultTs ?? DEFAULT_TS];
  const defaultTs = options.defaultTs ?? DEFAULT_TS;
  const zoomJoinUrl = options.zoomJoinUrl ?? "https://zoom.us/w/personal-1";
  const profileName = options.profileName ?? "Ada";
  const zoomHostKey = options.zoomHostKey ?? ZOOM_HOST_KEY;
  const googleEvents = () => {
    const events = options.googleEvents ?? [];
    return typeof events === "function" ? events() : events;
  };

  const spy = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    let url: string;
    let method: string;
    let body = "";
    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      body = new TextDecoder().decode(await input.clone().arrayBuffer());
    } else {
      url = String(input); // string or URL
      method = init?.method?.toUpperCase() ?? "GET";
      body = typeof init?.body === "string" ? init.body : "";
    }
    const call: RecordedCall = { url, method, body };
    calls.push(call);

    const custom = await respond?.(call);
    if (custom) return custom;

    if (url.includes("zoom.us/oauth/token")) {
      return Response.json({ access_token: "zoom-token", token_type: "bearer", expires_in: 3600 });
    }
    if (method === "POST" && url.includes("api.zoom.us/v2/meetings/")) {
      return Response.json({ attendees: [{ name: profileName, join_url: zoomJoinUrl }] });
    }
    if (url.includes("api.zoom.us/v2/meetings/")) {
      return Response.json({ host_id: ZOOM_HOST_ID });
    }
    if (url.includes("api.zoom.us/v2/users/")) {
      return Response.json({ host_key: zoomHostKey });
    }
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "g-tok", expires_in: 3600 });
    }
    if (url.includes("googleapis.com/calendar/v3/calendars/")) {
      return Response.json({ items: googleEvents() });
    }
    if (url.includes("/api/users.profile.get")) {
      return Response.json({ ok: true, profile: { real_name: profileName } });
    }
    if (url.includes("/api/chat.postMessage")) {
      const ts = postTs[Math.min(postCount++, postTs.length - 1)] ?? defaultTs;
      return Response.json({ ok: true, ts, channel: "C0B6C3BFEDD" });
    }
    return Response.json({ ok: true, ts: defaultTs, channel: "C0B6C3BFEDD" });
  });
  vi.stubGlobal("fetch", spy);

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
