import { runReminders } from "./bots/reminders";
import { runJobsOfTheDay } from "./bots/jobs-of-day";
import type { Env } from "./env";
import { log, setLogLevel } from "./log";
import { route } from "./router";

// The DO class must be exported from the Worker's main module so the runtime can bind it.
export { CoworkingRoom } from "./bots/coworking/durable-object";
export { JobsOfTheDay } from "./bots/jobs-of-day";

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
    await Promise.all([
      runReminders(controller, env, ctx),
      runJobsOfTheDay(controller, env),
    ]);
  },
} satisfies ExportedHandler<Env>;
