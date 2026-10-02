import { timingSafeEqualStrings } from "../crypto";
import type { Env } from "../env";
import { log } from "../log";
import { reportFailure } from "../slack/notify";

/**
 * `POST /google/notify`: Google Calendar push (`watch`) notifications arrive with an empty body —
 * all signal is in X-Goog-* headers. There's no body signature; authenticity is the per-channel
 * token we set when registering the watch. We ACK fast (200) and run the sync via the DO in the
 * background — non-2xx would make Google retry-storm, so even dropped notifications return 200.
 */
export async function handleGoogleNotify(
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

  // Authenticate via the per-channel token before anything else — even the info log below, so an
  // unauthenticated caller can't write its header values into our logs as a "notification". Drop
  // silently (200) on mismatch so spoofed/stale notifications don't trigger a Google retry-storm.
  // Never log the provided/expected value.
  const provided = req.headers.get("x-goog-channel-token");
  if (provided === null || !(await timingSafeEqualStrings(provided, env.GOOGLE_WATCH_TOKEN))) {
    log.warn("google.notify.bad_token", { channelId });
    return new Response(null, { status: 200 });
  }

  // Never log the channel token or the full header bag — x-goog-channel-token is a credential.
  log.info("google.notify", { state, channelId, resourceId, messageNumber });

  // Initial handshake when a watch channel is created — no change to process.
  if (state === "sync") {
    return new Response(null, { status: 200 });
  }

  const stub = env.CALENDAR_SYNC.getByName("default");
  ctx.waitUntil(
    (async () => {
      try {
        // The DO drops pushes whose channel id isn't its stored one (stale/replaced channels).
        await stub.notify(channelId ?? "");
      } catch (error) {
        await reportFailure(env, "google.notify.failed", error, { channelId });
      }
    })(),
  );
  return new Response(null, { status: 200 });
}
