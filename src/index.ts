import { runReminders } from "./bots/reminders";
import type { Env } from "./env";
import { log, setLogLevel } from "./log";
import { route } from "./router";

// The DO class must be exported from the Worker's main module so the runtime can bind it.
export { CoworkingRoom } from "./bots/coworking/durable-object";

/**
 * Worker entry point: the fetch() HTTP front door and the scheduled() cron handler.
 */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setLogLevel(env.LOG_LEVEL);
    return route(req, env, ctx);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    setLogLevel(env.LOG_LEVEL);
    log.info("cron.fired", { cron: controller.cron });
    return runReminders(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
