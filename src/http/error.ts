/**
 * A non-2xx answer from a provider API (`docs/adr/0012`). `body` is whatever the provider sent,
 * as openapi-fetch parsed it: a string when it was not JSON. The `message` keeps the historical
 * `"<what failed>: <status> <body>"` shape the adapters have always thrown.
 */
export type ApiProvider = "google" | "zoom";

export class ApiError extends Error {
  readonly provider: ApiProvider;
  readonly status: number;
  readonly body: unknown;

  constructor(provider: ApiProvider, status: number, body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}

/** The error body as text: raw text stays raw, a parsed JSON body is re-stringified, none → "". */
export function errorText(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}
