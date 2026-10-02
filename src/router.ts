import { isJoinToken, parseJoinPath } from "./bots/coworking/invite-link";
import type { Env } from "./env";
import { handleGoogleNotify } from "./google/notify";
import { log } from "./log";
import { createSlackApp } from "./slack/app";
import { handleZoomWebhook } from "./zoom/webhook";

/**
 * HTTP front door. A plain method+path switch — no router dependency for ~4 routes.
 *
 * Every bot route verifies its provider signature against the raw body, before parsing:
 * the Zoom route (`src/zoom/webhook.ts`) does it as its FIRST step; the Slack routes delegate
 * to the `SlackApp` (`src/slack/app.ts`), which does the same internally.
 */
export async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Health check — handy for uptime pings and the deploy smoke test.
  if ((method === "GET" && path === "/health") || (method === "HEAD" && path === "/")) {
    return new Response("ok", { status: 200 });
  }

  // Per-user join redirect: the token (minted by the DO on a Join click) IS the credential, so
  // there's no signature to verify. Resolves to the personal Zoom url and 302s the browser there.
  const joinToken = method === "GET" ? parseJoinPath(path) : null;
  if (joinToken !== null) return handleJoinRedirect(joinToken, env);

  log.info("request", { method, path });

  switch (`${method} ${path}`) {
    case "POST /zoom/webhook":
      return handleZoomWebhook(req, env, ctx);

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
      return createSlackApp(env).run(req, ctx);
    }

    default:
      return new Response("Not found", { status: 404 });
  }
}

// --- Join-link redirect → co-working room ---

async function handleJoinRedirect(token: string, env: Env): Promise<Response> {
  const expired = new Response(
    "This join link has expired — head back to Slack and click Join again.",
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
  if (!isJoinToken(token)) {
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
