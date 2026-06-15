import type { Env } from "./env";
import { log } from "./log";
import { createSlackApp } from "./slack/app";
import { notifyBotLog } from "./slack/notify";
import type { ZoomInboundEvent } from "./zoom/types";
import { isZoomMeetingEvent } from "./zoom/types";
import { buildZoomUrlValidationResponse, verifyZoomRequest } from "./zoom/verify";

/**
 * HTTP front door. A plain method+path switch — no router dependency for ~4 routes.
 *
 * Every bot route verifies its provider signature against the raw body, before parsing:
 * the Zoom route does it inline as its FIRST step; the Slack routes delegate to the
 * `SlackApp` (`src/slack/app.ts`), which does the same internally.
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
      return handleZoomWebhook(req, env, ctx);

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

// --- Zoom webhooks → co-working room ---

async function handleZoomWebhook(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await req.text();
  if (!(await verifyZoomRequest(req, rawBody, env.ZOOM_WEBHOOK_SECRET_TOKEN))) {
    log.warn("verify.failed", { path: "/zoom/webhook" });
    return new Response("invalid signature", { status: 401 });
  }

  const body = safeJson<ZoomInboundEvent>(rawBody);
  if (!body) return new Response("bad request", { status: 400 });

  // Endpoint URL validation handshake.
  if (body.event === "endpoint.url_validation" && body.payload?.plainToken) {
    log.info("zoom.url_validation");
    const res = await buildZoomUrlValidationResponse(
      env.ZOOM_WEBHOOK_SECRET_TOKEN,
      body.payload.plainToken,
    );
    return Response.json(res, { status: 200 });
  }

  // Meeting events → the co-working DO, keyed by meeting ID so all events for one meeting
  // serialize through a single instance (race-free). Awaited so ordering is preserved.
  // The subscription is account-wide, so events arrive for every meeting under the account;
  // only the configured co-working meeting is ours — ignore the rest (still 200: Zoom retries
  // non-2xx responses and can eventually deactivate the endpoint).
  if (isZoomMeetingEvent(body)) {
    const meeting = String(body.payload.object.id);
    if (meeting !== env.ZOOM_MEETING_ID) {
      log.info("zoom.webhook.ignored", { event: body.event, meeting });
      return new Response(null, { status: 200 });
    }
    log.info("zoom.webhook", { event: body.event, meeting });
    const stub = env.COWORKING_ROOM.getByName(meeting);
    try {
      await stub.handleZoomEvent(body);
    } catch (error) {
      // Alert #bot-log, then still 200: a persistent DO/Slack failure shouldn't trigger a Zoom
      // retry-storm or risk the account-wide endpoint being deactivated. Room presence
      // self-corrects on the next participant event.
      log.error("zoom.webhook.failed", { event: body.event, meeting, error: String(error) });
      await notifyBotLog(env, "zoom.webhook.failed", {
        event: body.event,
        meeting,
        error: String(error),
      });
    }
  }
  return new Response(null, { status: 200 });
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
