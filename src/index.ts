// devarts-mail Worker entry: fetch (UI + API), email (inbound), scheduled.

import type { Env } from "./types";
import { resetD1Budget } from "./db";
import { handleApi } from "./api";
import { handleInbound } from "./inbound";
import { runScheduled } from "./scheduled";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    resetD1Budget(env);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(env, request);
    }
    // Everything else: static UI via Workers Assets.
    return env.ASSETS.fetch(request);
  },

  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    resetD1Budget(env);
    await handleInbound(message, env, ctx);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    resetD1Budget(env);
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
