export type EnvSource = Record<string, string | undefined>;

export interface PostHogClientConfig {
  token: string;
  apiHost?: string;
  uiHost?: string;
}

export interface ResolvePostHogClientApiHostOptions {
  allowRelativeApiHost?: boolean;
}

const CLIENT_TOKEN_ENV_KEYS = ["NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "NEXT_PUBLIC_POSTHOG_KEY"];
const CLIENT_API_HOST_ENV_KEYS = ["NEXT_PUBLIC_POSTHOG_API_HOST"];
const CLIENT_UI_HOST_ENV_KEYS = ["NEXT_PUBLIC_POSTHOG_HOST"];

export function getPostHogClientConfig(env: EnvSource = process.env): PostHogClientConfig | null {
  const token = firstEnv(env, CLIENT_TOKEN_ENV_KEYS);
  if (!token) return null;
  const apiHost = firstEnv(env, CLIENT_API_HOST_ENV_KEYS);
  const uiHost = firstEnv(env, CLIENT_UI_HOST_ENV_KEYS);
  return {
    token,
    ...(apiHost ? { apiHost } : {}),
    ...(uiHost ? { uiHost } : {}),
  };
}

export function resolvePostHogClientApiHost(
  config: PostHogClientConfig,
  options: ResolvePostHogClientApiHostOptions = {},
): string | undefined {
  const allowRelativeApiHost = options.allowRelativeApiHost ?? true;
  if (config.apiHost && (allowRelativeApiHost || isAbsoluteHttpUrl(config.apiHost))) {
    return config.apiHost;
  }
  return config.uiHost;
}

function firstEnv(env: EnvSource, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (err: unknown) {
    if (err instanceof TypeError) return false;
    throw err;
  }
}
