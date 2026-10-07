import { loadNativeGmailPilotIds } from './policy.js';
import { parseCustomMcpEncryptionKey } from '../custom-mcp/crypto.js';
export function loadNativeGmailConfig(env: NodeJS.ProcessEnv) {
  const retained = [env.GMAIL_OAUTH_CLIENT_ID, env.GMAIL_OAUTH_CLIENT_SECRET,
    env.GMAIL_OAUTH_CALLBACK_URL, env.GMAIL_CREDENTIAL_ENCRYPTION_KEY].some(value => Boolean(value?.trim()));
  if (env.GMAIL_OAUTH_ENABLED !== 'true' && !retained) return null;
  try {
    const clientId = env.GMAIL_OAUTH_CLIENT_ID;
    const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET;
    const redirectUri = env.GMAIL_OAUTH_CALLBACK_URL;
    const rawKey = env.GMAIL_CREDENTIAL_ENCRYPTION_KEY;
    if (!clientId || clientId.length > 512 || !clientSecret || clientSecret.length > 2048 || !redirectUri || !rawKey) throw new Error();
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash
      || redirect.pathname !== '/api/integrations/gmail/oauth/callback') throw new Error();
    const encryptionKey = parseCustomMcpEncryptionKey(rawKey);
    const others = [env.PLATFORM_SECRET, env.MCP_CREDENTIAL_ENCRYPTION_KEY, env.PIPEDREAM_CLIENT_SECRET, env.STRIPE_SECRET_KEY, env.ACCOUNT_DELETION_SECRET, clientSecret];
    if (others.some(secret => Boolean(secret) && secret === rawKey)) throw new Error();
    if (env.MCP_CREDENTIAL_ENCRYPTION_KEY
      && encryptionKey.equals(parseCustomMcpEncryptionKey(env.MCP_CREDENTIAL_ENCRYPTION_KEY))) throw new Error();
    const pilotClerkIds = env.GMAIL_OAUTH_ENABLED === 'true' ? loadNativeGmailPilotIds(env.GMAIL_OAUTH_INTERNAL_CLERK_IDS) : Object.freeze([] as string[]);
    return { clientId, clientSecret, redirectUri, encryptionKey, pilotClerkIds };
  } catch (error) {
    console.error('[native-gmail] Configuration rejected:', error instanceof Error ? error.name : 'Unknown error');
    throw new Error('Gmail OAuth configuration unavailable');
  }
}
