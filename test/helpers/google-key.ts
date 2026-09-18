/**
 * A throwaway RSA service-account key as the JSON string `GOOGLE_SERVICE_ACCOUNT_KEY` holds.
 * Web Crypto only (no `node:*`), so it runs both in `vitest.config.ts` (Node, for the pinned
 * DO binding) and inside workerd test files. The PKCS8 PEM imports cleanly via jose
 * `importPKCS8`.
 */

export const TEST_CLIENT_EMAIL = "sa@test.iam.gserviceaccount.com";

export interface ServiceAccountKeyFixture {
  /** `JSON.stringify({ client_email, private_key })` — what the secret holds. */
  json: string;
  /** The PEM alone, for "never leaks the key" assertions. */
  privateKeyPem: string;
}

export async function generateServiceAccountKey(
  clientEmail = TEST_CLIENT_EMAIL,
): Promise<ServiceAccountKeyFixture> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const privateKeyPem = toPem(pkcs8);
  return {
    json: JSON.stringify({ client_email: clientEmail, private_key: privateKeyPem }),
    privateKeyPem,
  };
}

function toPem(der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
