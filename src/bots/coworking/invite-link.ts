import { type Env, publicBaseUrl } from "../../env";
import { log } from "../../log";
import type { InviteLinkPort } from "../../zoom/invite-links";

/**
 * The invite-link lifecycle, owned in one place: the TTL, the join-token format, the
 * `/join/<token>` URL (built and parsed), and the store over the co-working DO's `invite_link`
 * and `member_link` tables. The DO, the router and the join handler are thin callers.
 *
 * A Join click `request`s an invite link: Zoom mints the member's personal link (name
 * pre-filled), the member is remembered by display name for correlation, and the click gets back
 * the bot-hosted `/join/<token>` url — the token-bearing Zoom url never reaches the Slack UI;
 * only this module mints, validates and resolves tokens. The table DDL stays in the DO's
 * `migrate()`.
 */

/** Invite link lifetime. Only needs to cover click→join; it bounds the `/join/<token>`
 *  redirect, the Zoom link (`ttl`) and the display-name correlation window alike. */
export const INVITE_LINK_TTL_SECONDS = 7200;
const INVITE_LINK_TTL_MS = INVITE_LINK_TTL_SECONDS * 1000;

/** Zoom pre-fill name when the member's Slack profile couldn't be read. Only ever sent to Zoom —
 *  it is never stored in `member_link`, so it can't correlate anyone. */
const FALLBACK_DISPLAY_NAME = "VirtualCoffee member";

const JOIN_PATH_PREFIX = "/join/";

/** 128-bit random token: 32 lowercase hex chars (Web Crypto only). */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether `value` has the shape of a minted join token — exactly what `randomToken` produces. */
export function isJoinToken(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

/** The Worker path a join token is served under; the router parses it back with `parseJoinPath`. */
export function joinPath(token: string): string {
  return `${JOIN_PATH_PREFIX}${token}`;
}

/** The path segment after `/join/`, or null when `path` is not a join path. Not yet validated:
 *  hand it to `isJoinToken`. */
export function parseJoinPath(path: string): string | null {
  return path.startsWith(JOIN_PATH_PREFIX) ? path.slice(JOIN_PATH_PREFIX.length) : null;
}

export interface InviteLinks {
  /**
   * Slack Join click → mint a personal Zoom invite link and return the bot-hosted join url for
   * it. `displayName` is null when the caller couldn't read the member's Slack profile: Zoom gets
   * a generic pre-fill and no `member_link` row is written, since the generic name would match
   * every Zoom joiner who shows up under it to whichever member clicked Join last.
   */
  request(input: { slackUserId: string; displayName: string | null }): Promise<{ joinUrl: string }>;
  /** Resolve a join token to its personal Zoom url, or null if unknown/expired. */
  resolve(token: string): { joinUrl: string } | null;
  /**
   * Best-effort correlation: the slack user id of whoever minted a *recent* invite link with this
   * name. Invite-link joiners carry no registrant id, so the baked-in name is all we have to
   * match on. Bounded by the TTL: a member who joins Zoom directly more than a TTL after their
   * last Join click shows as a guest, and a same-named joiner months later can't inherit their
   * mention.
   */
  findMember(name: string): string | null;
}

/** The store over the DO's `sql`; Zoom is reached through `port`. */
export function createInviteLinks(
  sql: SqlStorage,
  port: InviteLinkPort,
  env: Pick<Env, "PUBLIC_BASE_URL">,
): InviteLinks {
  return {
    async request({ slackUserId, displayName }) {
      const base = publicBaseUrl(env);
      if (!base) throw new Error("PUBLIC_BASE_URL must be set to build join links");

      log.debug("coworking.join.invite_link", { user: slackUserId });
      const { joinUrl } = await port.mint(
        displayName ?? FALLBACK_DISPLAY_NAME,
        INVITE_LINK_TTL_SECONDS,
      );

      const now = Date.now();
      if (displayName !== null) {
        log.debug("coworking.join.store", { user: slackUserId });
        sql.exec(
          `INSERT INTO member_link (slack_user_id, display_name, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(slack_user_id) DO UPDATE SET
             display_name = excluded.display_name, created_at = excluded.created_at`,
          slackUserId,
          displayName,
          now,
        );
      }

      // Sweep what's dead anyway so the tables stay small.
      sql.exec("DELETE FROM invite_link WHERE expires_at < ?", now);
      sql.exec("DELETE FROM member_link WHERE created_at < ?", now - INVITE_LINK_TTL_MS);
      const token = randomToken();
      sql.exec(
        "INSERT INTO invite_link (token, join_url, slack_user_id, expires_at) VALUES (?, ?, ?, ?)",
        token,
        joinUrl,
        slackUserId,
        now + INVITE_LINK_TTL_MS,
      );

      log.info("coworking.member_link", { user: slackUserId });
      return { joinUrl: `${base}${joinPath(token)}` };
    },

    resolve(token) {
      const row = sql
        .exec<{ join_url: string }>(
          "SELECT join_url FROM invite_link WHERE token = ? AND expires_at >= ?",
          token,
          Date.now(),
        )
        .toArray()[0];
      log.info("coworking.join.resolve", { found: Boolean(row) }); // never log the token or url
      return row ? { joinUrl: row.join_url } : null;
    },

    findMember(name) {
      const row = sql
        .exec<{ slack_user_id: string }>(
          `SELECT slack_user_id FROM member_link WHERE display_name = ? AND created_at >= ?
           ORDER BY created_at DESC LIMIT 1`,
          name,
          Date.now() - INVITE_LINK_TTL_MS,
        )
        .toArray()[0];
      return row?.slack_user_id ?? null;
    },
  };
}
