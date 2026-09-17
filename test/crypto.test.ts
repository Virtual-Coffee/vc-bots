import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, hmacSha256Hex, verifyHmacSha256 } from "../src/crypto";

const SECRET = "shared-secret";
const MESSAGE = "v0:1700000000:{}";

describe("hexToBytes", () => {
  it("parses upper- and lowercase hex and round-trips through bytesToHex", () => {
    expect(hexToBytes("00ff7A")).toEqual(new Uint8Array([0, 255, 122]));
    expect(bytesToHex(hexToBytes("deadbeef")!)).toBe("deadbeef");
  });

  it("returns null for an empty, odd-length, or non-hex string", () => {
    expect(hexToBytes("")).toBeNull();
    expect(hexToBytes("abc")).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
    expect(hexToBytes("0x00")).toBeNull();
  });
});

describe("hmacSha256Hex", () => {
  it("is a 64-char lowercase digest that verifies under the same secret", async () => {
    const hex = await hmacSha256Hex(SECRET, MESSAGE);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyHmacSha256(SECRET, MESSAGE, hex)).toBe(true);
  });
});

describe("verifyHmacSha256", () => {
  it("returns false, never throws, for malformed hex", async () => {
    await expect(verifyHmacSha256(SECRET, MESSAGE, "")).resolves.toBe(false);
    await expect(verifyHmacSha256(SECRET, MESSAGE, "abc")).resolves.toBe(false);
    await expect(verifyHmacSha256(SECRET, MESSAGE, "not-hex-at-all")).resolves.toBe(false);
  });

  it("returns false for a well-formed but wrong signature", async () => {
    const hex = await hmacSha256Hex(SECRET, MESSAGE);
    expect(await verifyHmacSha256(SECRET, "tampered", hex)).toBe(false);
    expect(await verifyHmacSha256("other-secret", MESSAGE, hex)).toBe(false);
    expect(await verifyHmacSha256(SECRET, MESSAGE, "0".repeat(64))).toBe(false);
  });
});
