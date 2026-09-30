import type { Kysely } from "kysely";
import { z } from "zod/v4";
import { createSlackApi } from "./api.js";
import { bootstrapSlackDatabase, type SlackDatabase } from "./database.js";
import { SlackRepository } from "./repository.js";
import { createSlackAppRoutes } from "./routes.js";
import { encryptSlackToken } from "./security.js";
import { SlackAppIdSchema, type SlackApi, type SlackAppConfig, type SlackAuthorityDependencies } from "./types.js";

export function loadSlackAppConfig(env: Record<string, string | undefined>): SlackAppConfig | null {
  const names = ["SLACK_APP_ID", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET", "SLACK_TOKEN_ENCRYPTION_KEY", "SLACK_PUBLIC_BASE_URL"] as const;
  if (names.every((name) => !env[name])) return null;
  const config = { appId: SlackAppIdSchema.parse(env.SLACK_APP_ID), clientId: z.string().regex(/^\d+\.\d+$/).parse(env.SLACK_CLIENT_ID),
    clientSecret: z.string().min(16).max(256).parse(env.SLACK_CLIENT_SECRET), signingSecret: z.string().min(16).max(256).parse(env.SLACK_SIGNING_SECRET),
    tokenEncryptionKey: z.string().min(1).parse(env.SLACK_TOKEN_ENCRYPTION_KEY), publicBaseUrl: z.url().parse(env.SLACK_PUBLIC_BASE_URL) };
  const origin = new URL(config.publicBaseUrl);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new Error("Slack public origin unavailable");
  encryptSlackToken("configuration-probe", config.tokenEncryptionKey, "configuration-probe");
  return config;
}

/** The caller owns the shared database. close() drains this component only, never destroys the pool. */
export async function createSlackApp(options: SlackAuthorityDependencies & {
  db: Kysely<SlackDatabase>; config: SlackAppConfig; api?: SlackApi; fetchImpl?: typeof fetch; now?: () => Date; startCleanup?: boolean;
}) {
  await bootstrapSlackDatabase(options.db);
  const repository = new SlackRepository(options.db, { now: options.now });
  const api = options.api ?? createSlackApi({ clientId: options.config.clientId, clientSecret: options.config.clientSecret, fetchImpl: options.fetchImpl });
  const routes = createSlackAppRoutes({ ...options, repository, api });
  let closed = false;
  let sweeping: Promise<void> | undefined;
  const cleanup = () => {
    if (closed || sweeping) return;
    sweeping = repository.cleanup().catch((error: unknown) => console.warn("[slack] cleanup failed", error instanceof Error ? error.name : "UnknownError"))
      .finally(() => { sweeping = undefined; });
  };
  cleanup();
  const timer = options.startCleanup === false ? undefined : setInterval(cleanup, 60_000);
  timer?.unref();
  return { routes, repository, api, async close() { closed = true; if (timer) clearInterval(timer); await routes.shutdownSlack(); await sweeping; } };
}
