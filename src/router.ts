import { activeSourceName } from "./bots/reminders";
import type { Env } from "./env";
import { log } from "./log";
import { createSlackApp } from "./slack/app";
import { notifyBotLog } from "./slack/notify";
import { handleZoomWebhook } from "./zoom/webhook";

/**
 * HTTP front door. A plain method+path switch — no router dependency for ~4 routes.
 *
 * Every bot route verifies its provider signature against the raw body, before parsing:
 * the Zoom route (`src/zoom/webhook.ts`) does it as its FIRST step; the Slack routes delegate
 * to the `SlackApp` (`src/slack/app.ts`), which does the same internally.
 */
export async function route(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Health check — handy for uptime pings and the deploy smoke test.
  if ((method === "GET" && path === "/health") || (method === 'HEAD' && path === '/')) {
    return new Response("ok", { status: 200 });
  }

  // Per-user join redirect: the token (minted by the DO on a Join click) IS the credential, so
  // there's no signature to verify. Resolves to the personal Zoom url and 302s the browser there.
  if (method === "GET" && path.startsWith("/join/")) {
    return handleJoinRedirect(path.slice("/join/".length), env);
  }

  log.info("request", { method, path });

  switch (`${method} ${path}`) {
    case "POST /zoom/webhook":
      return handleZoomWebhook(req, env);

    case "POST /google/notify":
      return handleGoogleNotify(req, env, ctx);

    // One path-agnostic SlackApp serves all three Slack endpoints: it verifies the
    // signature against the raw body, answers the url_verification handshake, ACKs within
    // Slack's 3s window, and runs the registered handlers via ctx.waitUntil. Hand over the
    // request UNREAD — app.run reads the body itself.
    case "POST /slack/events":
    case "POST /slack/interactivity":
    case "POST /slack/commands": {
      log.info("slack.request", { path });
      // Surface the join link under the public base URL (the Netlify rewrite), not workers.dev.
      const base = (env.PUBLIC_BASE_URL || url.origin).replace(/\/+$/, "");
      return createSlackApp(env, base).run(req, ctx);
    }

    default:
      return new Response("Not found", { status: 404 });
  }
}

// --- Join-link redirect → co-working room ---

/** Tokens are 32 hex chars today; accept a little slack so the format can evolve. */
const JOIN_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

async function handleJoinRedirect(token: string, env: Env): Promise<Response> {
  const expired = new Response(
    "This join link has expired — head back to Slack and click Join again.",
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
  if (!JOIN_TOKEN_RE.test(token)) {
    log.info("join.redirect", { found: false }); // never log the token
    return expired;
  }
  const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
  const resolved = await stub.resolveJoinToken(token);
  log.info("join.redirect", { found: Boolean(resolved) });
  if (!resolved) return expired;
  return new Response(null, {
    status: 302,
    headers: { Location: resolved.joinUrl, "Cache-Control": "no-store" },
  });
}

// Google Calendar push (`watch`) notifications POST here with an empty body — all signal is in
// X-Goog-* headers. There's no body signature; authenticity is the per-channel token we set when
// registering the watch. We ACK fast (200) and run the sync via the DO in the background — non-2xx
// would make Google retry-storm, so even dropped notifications return 200.
async function handleGoogleNotify(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const goog: Record<string, string> = {};
  for (const [k, v] of req.headers) {
    if (k.startsWith("x-goog-")) goog[k] = v;
  }
  const state = goog["x-goog-resource-state"];
  const channelId = goog["x-goog-channel-id"];
  const resourceId = goog["x-goog-resource-id"];
  const messageNumber = goog["x-goog-message-number"];
  // Never log the channel token or the full header bag — x-goog-channel-token is a credential.
  log.info("google.notify", { state, channelId, resourceId, messageNumber });

  // Authenticate via the per-channel token. Drop silently (200) on mismatch so spoofed/stale
  // notifications don't trigger a Google retry-storm. Never log the provided/expected value.
  const provided = req.headers.get("x-goog-channel-token");
  if (provided !== env.GOOGLE_WATCH_TOKEN) {
    log.warn("google.notify.bad_token", { channelId });
    return new Response(null, { status: 200 });
  }

  // Initial handshake when a watch channel is created — no change to process.
  if (state === "sync") {
    return new Response(null, { status: 200 });
  }

  // A stale watch may still fire after a cutover back to CMS — ignore unless Google is active.
  if (activeSourceName(env) !== "google") {
    log.info("google.notify.ignored_source");
    return new Response(null, { status: 200 });
  }

  const stub = env.CALENDAR_SYNC.getByName("default");
  ctx.waitUntil(
    (async () => {
      try {
        // The DO drops pushes whose channel id isn't its stored one (stale/replaced channels).
        await stub.notify(channelId ?? "");
      } catch (error) {
        log.error("google.notify.failed", { channelId, error: String(error) });
        await notifyBotLog(env, "google.notify.failed", { channelId, error: String(error) });
      }
    })(),
  );
  return new Response(null, { status: 200 });
}
