/**
 * Refresh the vendored provider specs in `specs/` (`docs/adr/0012`). Network; runs locally:
 *
 *   pnpm specs:update            # downloads, pretty-prints, then regenerates src/generated/
 *
 * The two OAuth token fragments in `specs/` are hand-written and are not touched here.
 */
import { writeFile } from "node:fs/promises";

const SPECS = [
  {
    // APIs.guru's OpenAPI 3 conversion of Google's discovery document (openapi-typescript does
    // not read discovery documents).
    url: "https://api.apis.guru/v2/specs/googleapis.com/calendar/v3/openapi.json",
    out: "specs/google-calendar-v3.openapi.json",
  },
  {
    // Zoom's own API Hub document for the Meetings product.
    url: "https://developers.zoom.us/api-hub/meetings/methods/endpoints.json",
    out: "specs/zoom-meetings.openapi.json",
  },
];

for (const { url, out } of SPECS) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  const doc = (await res.json()) as {
    info?: { title?: string; version?: string; "x-origin"?: unknown };
  };
  await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`${out} ← ${doc.info?.title ?? "?"} ${doc.info?.version ?? "?"}`);
  if (doc.info?.["x-origin"]) console.log(`  origin: ${JSON.stringify(doc.info["x-origin"])}`);
}
