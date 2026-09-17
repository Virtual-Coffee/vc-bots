/**
 * One-off calendar migration for the Join Link / Markdown cutover (`docs/adr/0001`
 * §Consequences). Runs locally, never in the Worker:
 *
 *   pnpm fix-calendar            # dry-run: prints every change it would make, writes nothing
 *   pnpm fix-calendar --apply    # PATCHes the series masters
 *
 * For every live series master and standalone event it
 *   - sets `location` to the retired `extendedProperties.private.joinLink` when they differ,
 *   - converts an HTML description to Markdown (`scripts/html-to-markdown.ts`),
 *   - deletes the `joinLink` property (`null` in a PATCH removes it).
 * Instance exceptions (an occurrence with its own location/description) are reported, not
 * patched; so is a Zoom Join Link with no `hostCode`. Re-running after `--apply` is all no-ops.
 *
 * Needs `GOOGLE_SERVICE_ACCOUNT_KEY` in the environment (mise exports `.dev.vars`; the value
 * must be single-quoted there, see `.dev.vars.example`). The service account is an owner of
 * the calendar, so the write scope is granted; the Worker itself stays read-only.
 */
import { importPKCS8, SignJWT } from "jose";
import { parseZoomMeetingId } from "../src/zoom/join-link.ts";
import { UnsupportedHtmlError, htmlToMarkdown } from "./html-to-markdown.ts";

// The Worker tsconfig has no Node globals on purpose; this is the slice the script touches.
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_ID =
  "c_9605915e57e591ee12b82c98dc4c5e0aae1829024e1bc15e4026f5ee5b41d2f8@group.calendar.google.com";
const DAY_MS = 86_400_000;

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  recurrence?: string[];
  recurringEventId?: string;
  start?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

interface Patch {
  location?: string;
  description?: string;
  extendedProperties?: { private: { joinLink: null } };
}

async function accessToken(): Promise<string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set");
  const { client_email, private_key } = JSON.parse(raw) as {
    client_email: string;
    private_key: string;
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 600)
    .sign(await importPKCS8(private_key, "RS256"));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token)
    throw new Error(`token exchange failed: ${body.error ?? res.status}`);
  return body.access_token;
}

const eventsUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

async function listEvents(token: string, params: Record<string, string>): Promise<CalendarEvent[]> {
  const items: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(eventsUrl);
    for (const [k, v] of Object.entries({ ...params, maxResults: "250" }))
      url.searchParams.set(k, v);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`events.list failed: HTTP ${res.status} ${await res.text()}`);
    const page = (await res.json()) as { items?: CalendarEvent[]; nextPageToken?: string };
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items.filter((e) => e.status !== "cancelled");
}

function planPatch(event: CalendarEvent): { patch: Patch; skipped?: string } {
  const patch: Patch = {};
  let skipped: string | undefined;
  const joinLink = event.extendedProperties?.private?.joinLink;

  if (joinLink && joinLink !== event.location) patch.location = joinLink;

  if (event.description) {
    try {
      const markdown = htmlToMarkdown(event.description);
      if (markdown !== event.description) patch.description = markdown;
    } catch (err) {
      if (!(err instanceof UnsupportedHtmlError)) throw err;
      skipped = `description left as is: ${err.message}`;
    }
  }

  if (joinLink !== undefined) patch.extendedProperties = { private: { joinLink: null } };

  return { patch, skipped };
}

function label(event: CalendarEvent): string {
  const start = event.start?.dateTime ?? event.start?.date ?? "?";
  const kind = event.recurrence ? "series" : "single";
  return `${event.summary ?? "(untitled)"} | ${event.id} | ${kind} from ${start}`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const token = await accessToken();
  const now = Date.now();

  const masters = await listEvents(token, {
    singleEvents: "false",
    timeMin: new Date(now - 90 * DAY_MS).toISOString(),
  });

  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${masters.length} live series/standalone events\n`);

  const patches: { event: CalendarEvent; patch: Patch }[] = [];
  let noops = 0;
  let skips = 0;
  for (const event of masters) {
    const { patch, skipped } = planPatch(event);
    const lines: string[] = [];
    if (patch.location !== undefined) {
      lines.push(`  location:    ${event.location ?? "(none)"}`);
      lines.push(`            → ${patch.location}`);
    }
    if (patch.description !== undefined) {
      lines.push(`  description: ${JSON.stringify(event.description)}`);
      lines.push(`            → ${JSON.stringify(patch.description)}`);
    }
    if (patch.extendedProperties) {
      lines.push(`  joinLink:    ${event.extendedProperties?.private?.joinLink} → (deleted)`);
    }
    if (skipped) {
      skips++;
      lines.push(`  SKIP ${skipped}`);
    }
    if (lines.length === 0) {
      noops++;
      console.log(`no-op  ${label(event)}`);
      continue;
    }
    console.log(`${Object.keys(patch).length ? "PATCH " : "      "} ${label(event)}`);
    for (const line of lines) console.log(line);
    if (Object.keys(patch).length) patches.push({ event, patch });
  }

  // Warnings: things the script won't fix but someone should know about.
  console.log("");
  for (const event of masters) {
    const location = event.location ?? event.extendedProperties?.private?.joinLink;
    if (location && parseZoomMeetingId(location) && !event.extendedProperties?.private?.hostCode) {
      console.log(`WARN Zoom Join Link with no hostCode: ${label(event)}`);
    }
  }
  const byId = new Map(masters.map((e) => [e.id, e]));
  const instances = await listEvents(token, {
    singleEvents: "true",
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + 90 * DAY_MS).toISOString(),
  });
  let exceptions = 0;
  for (const instance of instances) {
    const master = instance.recurringEventId ? byId.get(instance.recurringEventId) : undefined;
    if (!master) continue;
    const diffs = [
      instance.location !== master.location ? "location" : null,
      instance.description !== master.description ? "description" : null,
    ].filter((d) => d !== null);
    if (diffs.length) {
      exceptions++;
      console.log(`WARN instance overrides ${diffs.join(", ")} (not patched): ${label(instance)}`);
    }
  }

  console.log(
    `\n${patches.length} to patch, ${noops} no-op, ${skips} skipped, ${exceptions} instance exception(s) in the next 90 days`,
  );

  if (!apply) {
    console.log("Dry run — nothing written. Re-run with --apply to write.");
    return;
  }

  let failed = 0;
  for (const { event, patch } of patches) {
    const res = await fetch(`${eventsUrl}/${encodeURIComponent(event.id)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      console.log(`ok     ${label(event)}`);
    } else {
      failed++;
      console.log(`FAILED ${label(event)}: HTTP ${res.status} ${await res.text()}`);
    }
  }
  console.log(`\n${patches.length - failed} patched, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
