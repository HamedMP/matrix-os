/** Keep the production runtime credential while delegating only Custom MCP to
 * a PR-tagged staging broker. These values are installed on a disposable
 * Preview VPS by the preview-platform connector workflow. */
export interface CustomMcpRuntimeRouting {
  internalPlatformUrl: string | undefined;
  internalPlatformToken: string | undefined;
  clerkUserId: string | undefined;
  projectionToken: string | undefined;
}

export function resolveCustomMcpRuntimeRouting(
  env: NodeJS.ProcessEnv,
  base: CustomMcpRuntimeRouting,
): CustomMcpRuntimeRouting {
  if (env.MATRIX_PREVIEW_RUNTIME !== 'true') return base;
  const origin = env.MATRIX_PREVIEW_CUSTOM_MCP_ORIGIN;
  const token = env.MATRIX_PREVIEW_CUSTOM_MCP_TOKEN;
  const ownerId = env.MATRIX_PREVIEW_CUSTOM_MCP_OWNER_ID;
  if (!origin && !token && !ownerId) return base;

  const handle = env.MATRIX_HANDLE;
  const invalid = () => new Error('Invalid preview Custom MCP routing configuration');
  if (!handle || !/^pr-[1-9][0-9]{0,8}$/.test(handle)
    || !token || !/^[a-f0-9]{64}$/.test(token)
    || ownerId !== `chat-share-preview-fixture-${handle}`
    || !origin) throw invalid();
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw invalid();
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash
    || !parsed.hostname.startsWith(`${handle}---matrix-platform-preview-`)
    || !parsed.hostname.endsWith('.a.run.app')) throw invalid();
  return {
    internalPlatformUrl: parsed.origin,
    internalPlatformToken: token,
    clerkUserId: ownerId,
    projectionToken: token,
  };
}
