export interface PlatformIntegrationConfig {
  platformDatabaseUrl: string;
  pipedreamClientId: string;
  pipedreamClientSecret: string;
  pipedreamProjectId: string;
  pipedreamEnvironment: string;
  pipedreamWebhookSecret: string;
}

export function resolvePlatformIntegrationConfig(
  env: NodeJS.ProcessEnv,
  platformDatabaseUrl: string,
): PlatformIntegrationConfig | null {
  const {
    PIPEDREAM_CLIENT_ID,
    PIPEDREAM_CLIENT_SECRET,
    PIPEDREAM_PROJECT_ID,
  } = env;

  if (!PIPEDREAM_CLIENT_ID || !PIPEDREAM_CLIENT_SECRET || !PIPEDREAM_PROJECT_ID) {
    return null;
  }

  return {
    platformDatabaseUrl,
    pipedreamClientId: PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: env.PIPEDREAM_ENVIRONMENT ?? 'production',
    pipedreamWebhookSecret: env.PIPEDREAM_WEBHOOK_SECRET ?? '',
  };
}
