import { SlackDevHandleSchema, SlackDevOAuthBrowserConfigSchema, SlackThreadContextEnvelopeSchema } from "@matrix-os/contracts/slack-bridge";
import { z } from "zod/v4";

const { ownerId, botId, chatId, event } = SlackThreadContextEnvelopeSchema.shape;
const SlackDevTargetSchema = z.object({
  ownerId, botId, chatId,
  machineId: z.uuid(),
  handle: SlackDevHandleSchema,
  organizationId: SlackDevOAuthBrowserConfigSchema.shape.organizationId.optional(),
  appId: event.shape.appId,
  teamId: event.shape.teamId,
  channelId: event.shape.channelId,
}).strict();
export type SlackDevTarget = z.infer<typeof SlackDevTargetSchema> & { agentRoutes?: true };

/** Slack transport selection is independent from the core platform transport. */
export interface SlackPlatformConnection {
  platformUrl: string;
  token: string;
  handle: string;
  devTarget?: SlackDevTarget;
}
export interface SlackBotPlatform extends SlackPlatformConnection {
  machineId: string;
  runtimeSlot: string;
}
function resolveDevSlackPlatform(env: NodeJS.ProcessEnv, configured: string): SlackPlatformConnection | undefined {
  if (env.MATRIX_RUNTIME_SLOT !== "dev" || env.MATRIX_PREVIEW_RUNTIME === "true" || configured.length > 2048) return;
  let value: unknown;
  try { value = JSON.parse(configured); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
  const target = SlackDevTargetSchema.safeParse(value);
  if (!target.success) return;
  const devTarget = target.data;
  const ownerId = env.MATRIX_USER_ID?.trim() || undefined;
  const clerkOwnerId = env.MATRIX_CLERK_USER_ID?.trim() || undefined;
  if (ownerId && clerkOwnerId && ownerId !== clerkOwnerId) return;
  if (devTarget.ownerId !== (ownerId ?? clerkOwnerId) || devTarget.handle !== env.MATRIX_HANDLE
    || devTarget.machineId !== env.MATRIX_MACHINE_ID) return;

  const { MATRIX_SLACK_PLATFORM_URL: platformUrl, MATRIX_SLACK_PLATFORM_TOKEN: token } = env;
  const tag = `slack-dev-${devTarget.machineId.slice(0, 8).toLowerCase()}`;
  const taggedOrigin = new RegExp(`^https://${tag}---matrix-platform-preview-[a-z0-9]+(?:-[a-z0-9]+)*\\.a\\.run\\.app/?$`);
  if (!platformUrl || !taggedOrigin.test(platformUrl) || !token || !/^[a-f0-9]{64}$/.test(token)
    || token === env.UPGRADE_TOKEN || token === env.MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN) return;
  return { platformUrl, token, handle: devTarget.handle, devTarget: env.MATRIX_SLACK_DEV_AGENT_ROUTES === "true" ? { ...devTarget, agentRoutes: true } : devTarget };
}

export function resolveSlackPlatform(env: NodeJS.ProcessEnv): {
  connection: SlackPlatformConnection | undefined;
  botConnection: SlackBotPlatform | null;
} {
  let connection = env.PLATFORM_INTERNAL_URL && env.UPGRADE_TOKEN && env.MATRIX_HANDLE
    ? { platformUrl: env.PLATFORM_INTERNAL_URL, token: env.UPGRADE_TOKEN, handle: env.MATRIX_HANDLE } : undefined;
  const overriding = env.MATRIX_SLACK_PLATFORM_URL !== undefined || env.MATRIX_SLACK_PLATFORM_TOKEN !== undefined;
  if (env.MATRIX_SLACK_DEV_TARGET !== undefined) {
    connection = resolveDevSlackPlatform(env, env.MATRIX_SLACK_DEV_TARGET);
  } else if (overriding) {
    const handle = env.MATRIX_HANDLE, origin = env.MATRIX_SLACK_PLATFORM_URL, token = env.MATRIX_SLACK_PLATFORM_TOKEN;
    const validMachine = env.MATRIX_MACHINE_ID && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(env.MATRIX_MACHINE_ID);
    const validHandle = handle && /^pr-[1-9][0-9]{0,8}$/.test(handle) && env.MATRIX_RUNTIME_SLOT === handle;
    // Operator configuration only: accept the exact own PR tag on the existing
    // preview Cloud Run service, never arbitrary hosts, ports or URL components.
    const validOrigin = validHandle && origin && new RegExp(`^https://${handle}---matrix-platform-preview-[a-z0-9]+(?:-[a-z0-9]+)*\\.a\\.run\\.app/?$`).test(origin);
    const validToken = token && /^[a-f0-9]{64}$/.test(token)
      && (env.MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN === undefined || env.MATRIX_PREVIEW_PLATFORM_AUTH_TOKEN === token);
    connection = env.MATRIX_PREVIEW_RUNTIME === "true" && validMachine && validOrigin && validToken
      ? { platformUrl: origin!, token: token!, handle: handle! } : undefined;
  }
  return { connection, botConnection: connection && env.MATRIX_MACHINE_ID && env.MATRIX_RUNTIME_SLOT
    ? { ...connection, machineId: env.MATRIX_MACHINE_ID, runtimeSlot: env.MATRIX_RUNTIME_SLOT } : null };
}
