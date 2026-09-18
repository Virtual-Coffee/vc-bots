import type { Env } from "../env";
import { log } from "../log";
import { notifyBotLog } from "../slack/notify";
import type { ZoomInboundEvent, ZoomMeetingEvent } from "./types";
import { isZoomMeetingEvent } from "./types";
import { buildZoomUrlValidationResponse, verifyZoomRequest } from "./verify";

/**
 * `POST /zoom/webhook` → the co-working room. Verifies Zoom's signature against the raw body
 * as its FIRST step (before parsing), answers the `endpoint.url_validation` handshake, then
 * hands meeting events to the `CoworkingRoom` Durable Object keyed by meeting ID.
 */
export async function handleZoomWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
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

  // Meeting events → the co-working DO, keyed by meeting ID. ACK now and do the work in
  // `waitUntil`; the DO orders its own handlers (ADR 0003).
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
    ctx.waitUntil(dispatchZoomEvent(env, meeting, body));
  }
  return new Response(null, { status: 200 });
}

async function dispatchZoomEvent(env: Env, meeting: string, body: ZoomMeetingEvent): Promise<void> {
  const stub = env.COWORKING_ROOM.getByName(meeting);
  try {
    await stub.handleZoomEvent(body);
  } catch (error) {
    // Alert #bot-log (we've already 200'd, so a persistent DO/Slack failure can't trigger a Zoom
    // retry-storm or risk the account-wide endpoint being deactivated). Room presence
    // self-corrects on the next participant event.
    log.error("zoom.webhook.failed", { event: body.event, meeting, error: String(error) });
    await notifyBotLog(env, "zoom.webhook.failed", {
      event: body.event,
      meeting,
      error: String(error),
    });
  }
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
