/**
 * Tiny leveled logger for the Worker + Durable Object.
 *
 * Edge-native: just `console.*`, which `wrangler dev` and `wrangler tail` surface (with their own
 * timestamps). Emits concise lines: `[INFO] event key=val key=val`.
 *
 * The threshold is module-global and set once per request/DO via `setLogLevel(env.LOG_LEVEL)`.
 * It defaults to `warn` so unconfigured contexts (e.g. tests) stay quiet.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = "warn";

/** Set the minimum level to emit. Unknown/empty values are ignored (threshold unchanged). */
export function setLogLevel(level: string | undefined): void {
  if (level && level in ORDER) threshold = level as LogLevel;
}

function format(event: string, fields?: Record<string, unknown>): string {
  if (!fields) return event;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const rendered =
      value === null || typeof value === "object" ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.length ? `${event} ${parts.join(" ")}` : event;
}

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[threshold]) return;
  console[level](`[${level.toUpperCase()}] ${format(event, fields)}`);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
