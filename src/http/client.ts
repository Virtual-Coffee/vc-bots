import createClient, { type Client, type Middleware } from "openapi-fetch";
import { ApiError, type ApiProvider, errorText } from "./error";

/**
 * The one way the Worker talks to a provider REST API (`docs/adr/0012`): an openapi-fetch client
 * typed by the generated `paths` of that provider's spec (`src/generated/`). Paths, params,
 * bodies and 2xx responses are checked at compile time; nothing is validated at runtime beyond
 * the adapters' own guards.
 */

export interface ApiClientOptions {
  baseUrl: string;
  /** Resolves the bearer token per request, so the caller owns caching. */
  bearer?: () => string | Promise<string>;
}

export function createApiClient<Paths extends object>(options: ApiClientOptions): Client<Paths> {
  const client = createClient<Paths>({
    baseUrl: options.baseUrl,
    // openapi-fetch captures `fetch` when the client is created; look it up per call instead so
    // a client built at module load still goes through a `fetch` stubbed later (the tests).
    fetch: (request) => globalThis.fetch(request),
  });
  const { bearer } = options;
  if (bearer) {
    const auth: Middleware = {
      async onRequest({ request }) {
        request.headers.set("Authorization", `Bearer ${await bearer()}`);
        return request;
      },
    };
    client.use(auth);
  }
  return client;
}

/** `${prefix}: ${status} ${body}` — the message shape every adapter has always thrown. */
export function apiError(
  provider: ApiProvider,
  prefix: string,
  result: { response: Response; error?: unknown },
): ApiError {
  const { status } = result.response;
  return new ApiError(
    provider,
    status,
    result.error,
    `${prefix}: ${status} ${errorText(result.error)}`,
  );
}
