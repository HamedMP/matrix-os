/** Slack transport selection is independent from the core platform transport. */
export interface SlackPlatformConnection {
  platformUrl: string;
  token: string;
  handle: string;
}
export interface SlackBotPlatform extends SlackPlatformConnection {
  machineId: string;
  runtimeSlot: string;
}
export function resolveSlackPlatform(env: NodeJS.ProcessEnv): {
  connection: SlackPlatformConnection | undefined;
  botConnection: SlackBotPlatform | null;
} {
  let connection = env.PLATFORM_INTERNAL_URL && env.UPGRADE_TOKEN && env.MATRIX_HANDLE
    ? { platformUrl: env.PLATFORM_INTERNAL_URL, token: env.UPGRADE_TOKEN, handle: env.MATRIX_HANDLE } : undefined;
  const overriding = env.MATRIX_SLACK_PLATFORM_URL !== undefined || env.MATRIX_SLACK_PLATFORM_TOKEN !== undefined;
  if (overriding) {
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
