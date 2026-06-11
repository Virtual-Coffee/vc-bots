import type { Env } from "./env";
import { ADMIN_COMMAND, handleAdminCommand, parseSlashCommand } from "./bots/admin";
import {
  handleJoinClick,
  handleJoinDismiss,
  isJoinClick,
  isJoinDismissClick,
} from "./bots/coworking/join";
import { dispatchSlackEvent } from "./bots/slack-events";
import { log } from "./log";
import { verifySlackRequest } from "./slack/verify";
import type { SlackBlockActionsPayload, SlackEventsRequest } from "./slack/types";
import type { ZoomInboundEvent } from "./zoom/types";
import { isZoomMeetingEvent } from "./zoom/types";
import { buildZoomUrlValidationResponse, verifyZoomRequest } from "./zoom/verify";

/**
 * HTTP front door. A plain method+path switch — no router dependency for ~4 routes.
 *
 * Every bot route verifies its provider signature as the FIRST step (against the raw body,
 * before parsing), then handles the provider handshake, then dispatches.
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

    case "POST /slack/events":
      return handleSlackEvents(req, env, ctx);

    case "POST /slack/interactivity":
      return handleSlackInteractivity(req, env, ctx);

    case "POST /slack/commands":
      return handleSlackCommand(req, env, ctx);

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
    await stub.handleZoomEvent(body);
  }
  return new Response(null, { status: 200 });
}

// --- Slack events → welcome + App Home ---

async function handleSlackEvents(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await req.text();
  if (!(await verifySlackRequest(req, rawBody, env.SLACK_SIGNING_SECRET))) {
    log.warn("verify.failed", { path: "/slack/events" });
    return new Response("invalid signature", { status: 401 });
  }

  const body = safeJson<SlackEventsRequest>(rawBody);
  if (!body) return new Response("bad request", { status: 400 });

  // Events API URL handshake.
  if (body.type === "url_verification") {
    log.debug("slack.url_verification");
    return Response.json({ challenge: body.challenge }, { status: 200 });
  }

  // ACK within Slack's 3s window; run the bot handler after responding.
  if (body.type === "event_callback") {
    log.info("slack.event", { type: body.event.type });
    ctx.waitUntil(dispatchSlackEvent(body.event, env));
  }
  return new Response(null, { status: 200 });
}

// --- Slack interactivity → co-working join ---

async function handleSlackInteractivity(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await req.text();
  if (!(await verifySlackRequest(req, rawBody, env.SLACK_SIGNING_SECRET))) {
    log.warn("verify.failed", { path: "/slack/interactivity" });
    return new Response("invalid signature", { status: 401 });
  }

  // Interactivity arrives as form-encoded `payload=<json>`.
  const payloadJson = new URLSearchParams(rawBody).get("payload");
  const payload = payloadJson ? safeJson<SlackBlockActionsPayload>(payloadJson) : null;

  // ACK immediately (Slack's 3s limit); do any follow-up work after responding.
  if (payload && isJoinClick(payload)) {
    log.info("slack.interactivity", { action: "join", user: payload.user.id });
    // Surface the join link under the public base URL (the Netlify rewrite), not workers.dev.
    const base = (env.PUBLIC_BASE_URL || new URL(req.url).origin).replace(/\/+$/, "");
    ctx.waitUntil(handleJoinClick(payload, env, base));
  } else if (payload && isJoinDismissClick(payload)) {
    // ☕ Join (url button — the browser is already opening Zoom) or Cancel: delete the ephemeral.
    log.info("slack.interactivity", { action: "join_dismiss", user: payload.user.id });
    ctx.waitUntil(handleJoinDismiss(payload, env));
  }
  return new Response(null, { status: 200 });
}

// --- Slack slash commands → /vc-bot-admin ---

async function handleSlackCommand(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await req.text();
  if (!(await verifySlackRequest(req, rawBody, env.SLACK_SIGNING_SECRET))) {
    log.warn("verify.failed", { path: "/slack/commands" });
    return new Response("invalid signature", { status: 401 });
  }

  const cmd = parseSlashCommand(new URLSearchParams(rawBody));
  if (!cmd || cmd.command !== ADMIN_COMMAND) {
    return new Response(null, { status: 200 });
  }

  log.info("slack.command", {
    command: cmd.command,
    sub: cmd.text.trim().split(/\s+/)[0] || "(none)",
    user: cmd.user_id,
  });

  // ACK immediately (Slack's 3s limit); do the work + final reply async via response_url.
  ctx.waitUntil(handleAdminCommand(cmd, env));
  return new Response(null, { status: 200 });
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
