import type { KernelCredentialResolver } from '../../gateway/src/kernel-credentials.js';
import { createOwnerAnthropicKeySaver } from '../../gateway/src/ai-providers/owner-anthropic-key.js';
import {
  createFundedAiCredentialManager, loadFundedAiRuntimeConfig,
  type FundedAiRuntimeConfig, type MatrixFundedCredentialProvider,
} from '../../gateway/src/funded-ai-credential-manager.js';

interface GatewayCredentials {
  model: string;
  kernelCredentialResolver?: KernelCredentialResolver;
  close(): Promise<void>;
}
const MODEL = 'claude-sonnet-5';
const unavailable = () => new Error('Matrix AI unavailable');
const SAFE_ENV = ['HOME', 'PATH', 'NODE_ENV', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'MATRIX_HOME'] as const;

/** This compatibility authority belongs only to the owner-isolated Cloudflare
 * harness. Ordinary personal SDK launches retain their existing credential gate. */
export async function prepareWorkspaceGatewayCredentials(homePath: string, env: NodeJS.ProcessEnv = process.env,
  dependencies: { createProvider?: (config: FundedAiRuntimeConfig) => MatrixFundedCredentialProvider; now?: () => number } = {},
): Promise<GatewayCredentials> {
  if (env.RUNTIME_INFERENCE_MODE === 'matrix-gateway') {
    let config: FundedAiRuntimeConfig;
    try {
      const parsed = loadFundedAiRuntimeConfig(env);
      const generation = Number(env.MATRIX_WORKSPACE_GENERATION);
      if (!parsed || !Number.isSafeInteger(generation) || generation < 1
        || !env.MATRIX_HANDLE || !/^swp-[1-9][0-9]{0,8}-[0-9a-f]{8}$/.test(env.MATRIX_HANDLE)
        || parsed.identity.runtimeSlot !== env.MATRIX_HANDLE
        || parsed.identity.ownerId !== env.MATRIX_WORKSPACE_OWNER_ID
        || parsed.identity.ownerId !== env.MATRIX_USER_ID) throw unavailable();
      config = parsed;
    } catch (error: unknown) {
      // Credential parser causes can contain private configuration. Do not log them.
      void error; throw unavailable();
    }
    const provider = (dependencies.createProvider ?? createFundedAiCredentialManager)(config);
    const now = dependencies.now ?? Date.now;
    let closed = false;
    const kernelCredentialResolver: KernelCredentialResolver = async input => {
      if (closed || input.signal?.aborted || input.model !== MODEL
        || (input.accessSourceId !== undefined && input.accessSourceId !== 'matrix_included')) throw unavailable();
      try {
        const minValidityMs = config.maxRunMs + 60_000;
        const lease = await provider.getCredential({ requestClass: 'background', minValidityMs, signal: input.signal });
        const ttl = Date.parse(lease.expiresAt) - now();
        if (closed || input.signal?.aborted || lease.requestClass !== 'background'
          || lease.relayBaseUrl !== config.relayBaseUrl || lease.maxRunMs !== config.maxRunMs
          || !Number.isFinite(ttl) || ttl < minValidityMs || ttl > 60 * 60_000
          || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(lease.tokenId)
          || lease.token.length > 256 || !lease.token.startsWith(`sk-matrix-funded-${lease.tokenId}.`)
          || !/^sk-matrix-funded-[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}\.[A-Za-z0-9_-]{43}$/.test(lease.token)) {
          provider.invalidate(lease.tokenId); throw unavailable();
        }
        // SDK environment overlays process.env. Explicitly remove every ambient
        // value, then preserve only process basics and the short-lived relay lease.
        const executionEnv: Record<string, string | undefined> = Object.fromEntries(Object.keys(env).map(key => [key, undefined]));
        for (const key of SAFE_ENV) if (env[key] !== undefined) executionEnv[key] = env[key];
        executionEnv.ANTHROPIC_API_KEY = lease.token;
        executionEnv.ANTHROPIC_BASE_URL = config.relayBaseUrl;
        executionEnv.ANTHROPIC_AUTH_TOKEN = undefined;
        executionEnv.CLAUDE_CODE_OAUTH_TOKEN = undefined;
        executionEnv.ANTHROPIC_CUSTOM_HEADERS = undefined;
        executionEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
        executionEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
        return { env: executionEnv, fundedRunTimeoutMs: config.maxRunMs };
      } catch (error: unknown) {
        // The issuer or SDK must never expose a private error/cause to the caller.
        void error; throw unavailable();
      }
    };
    return { model: MODEL, kernelCredentialResolver, close: async () => { if (!closed) { closed = true; provider.close(); } } };
  }
  if (env.RUNTIME_INFERENCE_MODE !== undefined && env.RUNTIME_INFERENCE_MODE !== 'anthropic') throw unavailable();
  if (!env.ANTHROPIC_API_KEY) throw new Error('Runtime credential missing');
  const credential = createOwnerAnthropicKeySaver({ homePath });
  await credential(env.ANTHROPIC_API_KEY);
  return { model: 'claude-haiku-4-5', close: () => credential.revoke() };
}
