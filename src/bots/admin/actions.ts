import type { SlackAPIClient } from "slack-cloudflare-workers";
import type { Env } from "../../env";
import { log } from "../../log";
import { createSlackClient } from "../../slack/client";
import { postAvailabilityCheckIn } from "../availability";
import type { WatchStatus } from "../calendar-sync/durable-object";
import { type ReminderName, type SendResult, sendReminder } from "../reminders";
import { publishHomeTab, sendWelcomeDm } from "../welcome";

/**
 * The admin actions behind `/vc-bot-admin`, surface-agnostic. The slash command (`slash.ts`)
 * and the button panel (`panel.ts`) are adapters: each parses its own payload into an
 * `AdminAction`, hands it to `runAdminAction`, and turns the `AdminResult` into its own reply
 * (`adminReplyText` for the text; the panel decides replace-vs-dismiss on top).
 *
 * The workspace-admin gate and the catch-all error handling live here, once: an adapter never
 * sees a rejection, only a `denied` / `failed` result.
 */

export type AdminAction =
  | { kind: "reminder"; name: ReminderName; nowMs: number; source?: string }
  | { kind: "welcome"; target: string }
  | { kind: "home"; userId: string }
  | { kind: "coworking"; op: "open" | "close" }
  | { kind: "watch"; op: "status" | "start" | "stop" }
  | { kind: "availability" };

export type AdminResult =
  | { kind: "denied" }
  | { kind: "failed" }
  | { kind: "reminder"; name: ReminderName; result: SendResult }
  | { kind: "welcome"; target: string }
  | { kind: "home" }
  | { kind: "coworking"; op: "open" }
  | { kind: "coworking"; op: "close"; closed: boolean }
  | { kind: "watch"; op: "status" | "start"; status: WatchStatus }
  | { kind: "watch"; op: "stop"; stopped: boolean }
  /** `posted` is false when the feature is off (`SLACK_AVAILABILITY_CHANNEL_ID` empty). */
  | { kind: "availability"; posted: boolean };

/**
 * TEMPORARY: user IDs allowed to run admin commands without the workspace-admin role.
 * Remove once these users are granted Slack workspace-admin on the VC workspace.
 */
const ALLOWLISTED_ADMIN_IDS = new Set(["U031H1A1BGR"]);

export async function isWorkspaceAdmin(client: SlackAPIClient, userId: string): Promise<boolean> {
  if (ALLOWLISTED_ADMIN_IDS.has(userId)) return true;
  try {
    const res = await client.users.info({ user: userId });
    return Boolean(res.user?.is_admin || res.user?.is_owner);
  } catch {
    return false;
  }
}

/**
 * The workspace-admin gate. `runAdminAction` applies it itself; adapters call it directly only
 * for surfaces that do work without running an action (the slash usage/panel replies, the panel
 * buttons that open a modal). `detail` is logged alongside the denial (the action kind, the
 * command text…).
 */
export async function guardAdmin(
  env: Env,
  userId: string,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  if (await isWorkspaceAdmin(createSlackClient(env), userId)) return true;
  log.warn("admin.denied", { user: userId, ...detail });
  return false;
}

export async function runAdminAction(
  env: Env,
  userId: string,
  action: AdminAction,
): Promise<AdminResult> {
  if (!(await guardAdmin(env, userId, { kind: action.kind }))) return { kind: "denied" };
  try {
    return await perform(env, action);
  } catch (err) {
    // Adapters run past the app's ACK (ctx.waitUntil) — an escaped rejection would be an
    // uncaught error and the admin would just see silence. Hand back a result instead.
    log.error("admin.failed", { kind: action.kind, err: String(err) });
    return { kind: "failed" };
  }
}

async function perform(env: Env, action: AdminAction): Promise<AdminResult> {
  switch (action.kind) {
    case "reminder": {
      const result = await sendReminder(action.name, env, action.nowMs, action.source);
      return { kind: "reminder", name: action.name, result };
    }

    case "welcome": {
      await sendWelcomeDm(env, action.target);
      return { kind: "welcome", target: action.target };
    }

    case "home": {
      await publishHomeTab(env, action.userId);
      return { kind: "home" };
    }

    case "coworking": {
      const stub = env.COWORKING_ROOM.getByName(env.ZOOM_MEETING_ID);
      if (action.op === "open") {
        await stub.adminAnnounceOpen();
        return { kind: "coworking", op: "open" };
      }
      const { closed } = await stub.adminAnnounceClose();
      return { kind: "coworking", op: "close", closed };
    }

    case "watch": {
      const stub = env.CALENDAR_SYNC.getByName("default");
      if (action.op === "stop") {
        const { stopped } = await stub.stopWatch();
        return { kind: "watch", op: "stop", stopped };
      }
      const status = action.op === "start" ? await stub.ensureWatch() : await stub.watchStatus();
      return { kind: "watch", op: action.op, status };
    }

    case "availability": {
      const posted = await postAvailabilityCheckIn(env);
      return { kind: "availability", posted: posted !== null };
    }
  }
}

// ── Reply text ──────────────────────────────────────────────────────────────

/** The one-line reply for a result. Adapters may still substitute a surface-specific line. */
export function adminReplyText(result: AdminResult): string {
  switch (result.kind) {
    case "denied":
      return ":no_entry: This command is for workspace admins only.";
    case "failed":
      return ":warning: That failed — check the worker logs for details.";
    case "reminder":
      return reminderReply(result.name, result.result);
    case "welcome":
      return `:white_check_mark: Sent the welcome message to <@${result.target}>.`;
    case "home":
      return ":white_check_mark: Published your App Home.";
    case "coworking":
      if (result.op === "open") {
        return ":white_check_mark: Posted the co-working room-open announcement.";
      }
      return result.closed
        ? ":white_check_mark: Closed the co-working announcement."
        : ":information_source: No open announcement to close.";
    case "watch":
      if (result.op === "stop") {
        return result.stopped
          ? ":octagonal_sign: Calendar watch stopped."
          : ":information_source: No active calendar watch to stop.";
      }
      return watchStatusText(result.status);
    case "availability":
      return result.posted
        ? ":white_check_mark: Posted the availability check-in."
        : ":information_source: Availability check-in is off — `SLACK_AVAILABILITY_CHANNEL_ID` is empty.";
  }
}

function reminderReply(sub: string, result: SendResult): string {
  const events = `${result.count} event${result.count === 1 ? "" : "s"}`;
  const scheduled =
    result.scheduled === undefined
      ? ""
      : ` Scheduled ${result.scheduled} starting-soon message${result.scheduled === 1 ? "" : "s"}.`;
  if (result.posted) {
    return `:white_check_mark: Posted the *${sub}* reminder (${events}, source: *${result.source}*).${scheduled}`;
  }
  if (result.reason === "monday") {
    return `:information_source: Skipped the *daily* summary — the weekly reminder covers Mondays (source: *${result.source}*).${scheduled}`;
  }
  return `:information_source: No upcoming events for the *${sub}* window — nothing posted (source: *${result.source}*).${scheduled}`;
}

/**
 * Render a `WatchStatus` as a concise human-readable line. The expiry is shown as a Slack
 * date token (falls back to a readable UTC time outside Slack-rendered surfaces). NEVER
 * includes the watch token — only the non-secret channel id.
 */
function watchStatusText(status: WatchStatus): string {
  if (!status.active) return ":mute: Calendar watch is *not active*.";
  const parts = [":satellite_antenna: Calendar watch is *active*."];
  if (status.channelId) parts.push(`Channel: \`${status.channelId}\`.`);
  if (status.expiresAt !== null) {
    const secs = Math.floor(status.expiresAt / 1000);
    const fallback =
      new Date(status.expiresAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    parts.push(`Expires <!date^${secs}^{date_short_pretty} {time}|${fallback}>.`);
  }
  return parts.join(" ");
}
