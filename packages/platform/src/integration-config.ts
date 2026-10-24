export interface PlatformIntegrationConfig {
  platformDatabaseUrl: string;
  pipedreamClientId: string;
  pipedreamClientSecret: string;
  pipedreamProjectId: string;
  pipedreamEnvironment: string;
  pipedreamWebhookSecret: string;
}

export interface GitHubIntegrationConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  webCompletionUrl: string;
  mobileCompletionUrl: "matrixos://integrations";
  encryptionKey: string;
}

function parseFixedHttpsUrl(value: string, expectedPath: string, errorMessage: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(errorMessage);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || url.pathname !== expectedPath || url.search || url.hash) throw new Error(errorMessage);
  return url;
}

export function resolveGitHubIntegrationConfig(env: NodeJS.ProcessEnv): GitHubIntegrationConfig | null {
  if (env.GITHUB_INTEGRATION_OAUTH_ENABLED !== 'true') return null;
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  const callbackValue = env.GITHUB_OAUTH_CALLBACK_URL?.trim();
  const completionValue = env.GITHUB_OAUTH_WEB_COMPLETION_URL?.trim();
  const encryptionKey = env.GITHUB_OAUTH_ENCRYPTION_KEY?.trim();
  if (!clientId || clientId.length > 256 || !clientSecret || clientSecret.length > 4096
    || !callbackValue || !completionValue || !encryptionKey) {
    throw new Error('GitHub OAuth configuration unavailable');
  }
  const callbackUrl = parseFixedHttpsUrl(
    callbackValue,
    '/api/integrations/oauth/github/callback',
    'GitHub OAuth callback URL is invalid',
  );
  const webCompletionUrl = parseFixedHttpsUrl(
    completionValue,
    '/integrations',
    'GitHub OAuth completion URL is invalid',
  );
  if (callbackUrl.origin !== webCompletionUrl.origin) {
    throw new Error('GitHub OAuth completion URL is invalid');
  }
  const reservedSecrets = [
    clientSecret,
    env.PLATFORM_SECRET,
    env.PLATFORM_JWT_SECRET,
    env.PIPEDREAM_CLIENT_SECRET,
    env.MCP_CREDENTIAL_ENCRYPTION_KEY,
    env.STRIPE_SECRET_KEY,
    env.UPGRADE_TOKEN,
    env.ACCOUNT_DELETION_SECRET,
  ];
  if (reservedSecrets.some((secret) => Boolean(secret) && secret === encryptionKey)) {
    throw new Error('GITHUB_OAUTH_ENCRYPTION_KEY must not reuse another platform secret');
  }
  return {
    clientId,
    clientSecret,
    callbackUrl: callbackUrl.toString(),
    webCompletionUrl: webCompletionUrl.toString(),
    mobileCompletionUrl: 'matrixos://integrations',
    encryptionKey,
  };
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
