import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  INVITE_LINK_TTL_SECONDS,
  type InviteLinks,
  createInviteLinks,
  isJoinToken,
  joinPath,
  parseJoinPath,
  randomToken,
} from "../src/bots/coworking/invite-link";
import { publicBaseUrl } from "../src/env";
import { createInviteLinkFake } from "./helpers/invite-link-fake";

/**
 * The invite-link module: the store over the co-working DO's `invite_link` / `member_link`
 * tables (the DO creates them on boot; each test takes its own instance), driven with the Zoom
 * mint faked through the store's constructor.
 */

const TTL_MS = INVITE_LINK_TTL_SECONDS * 1000;

let n = 0;

/** Run `fn` against a fresh store over a fresh DO's SQLite. */
function withStore(
  fn: (
    links: InviteLinks,
    sql: SqlStorage,
    fake: ReturnType<typeof createInviteLinkFake>,
  ) => Promise<void> | void,
): Promise<void> {
  const fake = createInviteLinkFake();
  return runInDurableObject(env.COWORKING_ROOM.getByName(`invite-link-${n++}`), (_i, state) =>
    fn(createInviteLinks(state.storage.sql, fake, env), state.storage.sql, fake),
  );
}

const tokenOf = (joinUrl: string) => joinUrl.split("/").at(-1)!;
const rows = (sql: SqlStorage, table: string) => sql.exec(`SELECT * FROM ${table}`).toArray();

describe("join token and path", () => {
  it("randomToken mints what isJoinToken accepts", () => {
    expect(isJoinToken(randomToken())).toBe(true);
    expect(randomToken()).not.toBe(randomToken());
  });

  it("isJoinToken is exactly 32 lowercase hex", () => {
    expect(isJoinToken("0".repeat(32))).toBe(true);
    expect(isJoinToken("0".repeat(31))).toBe(false);
    expect(isJoinToken("0".repeat(33))).toBe(false);
    expect(isJoinToken("A".repeat(32))).toBe(false);
    expect(isJoinToken("not%20a%20token!")).toBe(false);
  });

  it("parseJoinPath inverts joinPath and ignores other paths", () => {
    const token = randomToken();
    expect(parseJoinPath(joinPath(token))).toBe(token);
    expect(parseJoinPath("/health")).toBeNull();
    expect(parseJoinPath("/slack/events")).toBeNull();
  });
});

describe("InviteLinks.request", () => {
  it("mints with the TTL, stores the slack_user_id ↔ name mapping, and returns the bot-hosted url", async () => {
    await withStore(async (links, sql, fake) => {
      const { joinUrl } = await links.request({ slackUserId: "U1", displayName: "Xavier" });

      // Zoom gets the name to pre-fill and the module's TTL, nothing else.
      expect(fake.mints).toEqual(["Xavier"]);
      expect(fake.ttls).toEqual([INVITE_LINK_TTL_SECONDS]);
      expect(joinUrl).toMatch(new RegExp(`^${publicBaseUrl(env)}/join/[0-9a-f]{32}$`));
      expect(rows(sql, "member_link")[0]).toMatchObject({
        slack_user_id: "U1",
        display_name: "Xavier",
      });
    });
  });

  it("with no display name, pre-fills a generic name and stores no member_link", async () => {
    await withStore(async (links, sql, fake) => {
      await links.request({ slackUserId: "U1", displayName: null });
      expect(fake.mints).toEqual(["VirtualCoffee member"]);
      expect(rows(sql, "member_link")).toHaveLength(0);
      expect(links.findMember("VirtualCoffee member")).toBeNull();
    });
  });

  it("propagates a failed mint and records nothing", async () => {
    await withStore(async (links, sql, fake) => {
      fake.failNext();
      await expect(links.request({ slackUserId: "U1", displayName: "Xavier" })).rejects.toThrow(
        "Zoom invite-links failed",
      );
      expect(rows(sql, "invite_link")).toHaveLength(0);
      expect(rows(sql, "member_link")).toHaveLength(0);
    });
  });

  it("refuses to mint when PUBLIC_BASE_URL is unset (no request-origin fallback)", async () => {
    const fake = createInviteLinkFake();
    await runInDurableObject(env.COWORKING_ROOM.getByName(`invite-link-${n++}`), (_i, state) =>
      expect(
        createInviteLinks(state.storage.sql, fake, { PUBLIC_BASE_URL: "" }).request({
          slackUserId: "U1",
          displayName: "Xavier",
        }),
      ).rejects.toThrow("PUBLIC_BASE_URL"),
    );
    expect(fake.mints).toEqual([]); // checked before Zoom is called
  });

  it("trims trailing slashes off the base", async () => {
    const fake = createInviteLinkFake();
    await runInDurableObject(
      env.COWORKING_ROOM.getByName(`invite-link-${n++}`),
      async (_i, state) => {
        const links = createInviteLinks(state.storage.sql, fake, {
          PUBLIC_BASE_URL: "https://bots.example/bots//",
        });
        const { joinUrl } = await links.request({ slackUserId: "U1", displayName: "Xavier" });
        expect(joinUrl).toMatch(/^https:\/\/bots\.example\/bots\/join\/[0-9a-f]{32}$/);
      },
    );
  });
});

describe("InviteLinks.resolve", () => {
  it("round-trips the token to the personal join url; an unknown token is null", async () => {
    await withStore(async (links, _sql, fake) => {
      fake.joinUrl = "https://zoom.us/w/personal-X";
      const { joinUrl } = await links.request({ slackUserId: "U1", displayName: "Xavier" });

      expect(links.resolve(tokenOf(joinUrl))).toEqual({ joinUrl: "https://zoom.us/w/personal-X" });
      expect(links.resolve("0".repeat(32))).toBeNull();
    });
  });

  it("expires with the TTL", async () => {
    await withStore(async (links, sql) => {
      const { joinUrl } = await links.request({ slackUserId: "U1", displayName: "Xavier" });
      sql.exec("UPDATE invite_link SET expires_at = ?", Date.now() - 1);
      expect(links.resolve(tokenOf(joinUrl))).toBeNull();
    });
  });

  it("stamps the row with the same TTL the Zoom link got", async () => {
    await withStore(async (links, sql) => {
      const before = Date.now();
      await links.request({ slackUserId: "U1", displayName: "Xavier" });
      const expiresAt = rows(sql, "invite_link")[0]!.expires_at as number;
      expect(expiresAt).toBeGreaterThanOrEqual(before + TTL_MS);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + TTL_MS);
    });
  });
});

describe("InviteLinks sweep", () => {
  it("drops expired invite_link rows on the next request", async () => {
    await withStore(async (links, sql) => {
      const first = await links.request({ slackUserId: "U1", displayName: "Xavier" });
      sql.exec("UPDATE invite_link SET expires_at = ?", Date.now() - 1);

      const second = await links.request({ slackUserId: "U2", displayName: "Yan" });
      const left = rows(sql, "invite_link");
      expect(left).toHaveLength(1);
      expect(left[0]?.token).toBe(tokenOf(second.joinUrl));
      expect(left[0]?.token).not.toBe(tokenOf(first.joinUrl));
    });
  });

  it("drops member_link rows older than the TTL, keeps fresh ones", async () => {
    await withStore(async (links, sql) => {
      await links.request({ slackUserId: "U1", displayName: "Xavier" });
      await links.request({ slackUserId: "U2", displayName: "Yan" });
      sql.exec(
        "UPDATE member_link SET created_at = ? WHERE slack_user_id = 'U1'",
        Date.now() - TTL_MS - 1000,
      );

      await links.request({ slackUserId: "U3", displayName: "Zed" });
      expect(
        rows(sql, "member_link")
          .map((r) => r.slack_user_id)
          .sort(),
      ).toEqual(["U2", "U3"]);
    });
  });
});

describe("InviteLinks.findMember", () => {
  it("matches the most recent member by display name", async () => {
    await withStore(async (links, sql) => {
      await links.request({ slackUserId: "U1", displayName: "Ada" });
      await links.request({ slackUserId: "U2", displayName: "Ada" });
      sql.exec("UPDATE member_link SET created_at = created_at - 1000 WHERE slack_user_id = 'U1'");
      expect(links.findMember("Ada")).toBe("U2");
      expect(links.findMember("Nobody")).toBeNull();
    });
  });

  it("is bounded by the TTL", async () => {
    await withStore(async (links, sql) => {
      await links.request({ slackUserId: "U1", displayName: "Ada" });
      sql.exec("UPDATE member_link SET created_at = ?", Date.now() - TTL_MS - 1000);
      expect(links.findMember("Ada")).toBeNull();
    });
  });
});
