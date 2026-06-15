import type { AnyHomeTabBlock, AppHomeOpenedEvent, HomeTabView } from "slack-cloudflare-workers";
import type { Env } from "../env";
import { createSlackClient } from "../slack/client";
import { welcomeBlocks } from "./welcome";

/**
 * App Home bot — responds to `app_home_opened` by publishing the Home tab view.
 */
export async function handleAppHomeOpened(event: AppHomeOpenedEvent, env: Env): Promise<void> {
  const client = createSlackClient(env);
  await client.views.publish({ user_id: event.user, view: homeView(env) });
}

/**
 * Home tab view — mirrors the welcome message (no user → generic greeting), as the
 * old bot did. The welcome builder only emits section/header/divider blocks, all of
 * which are valid Home tab blocks.
 */
export function homeView(env: Env): HomeTabView {
  return { type: "home", blocks: welcomeBlocks(env) as AnyHomeTabBlock[] };
}
