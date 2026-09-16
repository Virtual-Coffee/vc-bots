import type { Env } from "../env";
import { log } from "../log";
import { notifyBotLog } from "../slack/notify";
import type { ZoomInboundEvent } from "./types";
import { isZoomMeetingEvent } from "./types";
import { buildZoomUrlValidationResponse, verifyZoomRequest } from "./verify";

/**
 * `POST /zoom/webhook` → the co-working room. Verifies Zoom's signature against the raw body
 * as its FIRST step (before parsing), answers the `endpoint.url_validation` handshake, then
 * hands meeting events to the `CoworkingRoom` Durable Object keyed by meeting ID.
 */
export async function handleZoomWebhook(req: Request, env: Env): Promise<Response> {
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
      // Deliberately awaited, not `ctx.waitUntil`: a meeting's webhooks must reach the DO in
      // the order Zoom sent them. A slow 200 may draw a Zoom retry — that's the accepted trade-off.
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
