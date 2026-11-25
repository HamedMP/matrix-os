import {
  SLACK_DEV_OAUTH_CONFIG_PATH,
  SLACK_DEV_OAUTH_FINISH_PATH,
  SLACK_DEV_OAUTH_TICKET_MAX_LENGTH,
  SlackDevHandleSchema,
  SlackDevOAuthBrowserConfigSchema,
  SlackDevOAuthTicketSchema,
  type SlackDevOAuthBrowserConfig,
} from '@matrix-os/contracts/slack-bridge';
import {
  refreshSlackOAuthToken,
  slackOAuthFailure,
  type SlackOAuthResult,
  type SlackOAuthTokenReader,
} from './slack-oauth-completion';
import { slackDevOAuthHandle } from './slack-dev-oauth-privacy';

type SlackOAuthFailure = Exclude<SlackOAuthResult, 'connected'>;

export function readSlackDevOAuthLocation(url: URL): {
  handle: string;
  ticket?: string;
  error?: 'cancelled' | 'invalid';
} | null {
  const handle = slackDevOAuthHandle(url);
  if (!handle || url.search) return null;
  if (!url.hash) return { handle };
  if (url.hash === '#error=access_denied') return { handle, error: 'cancelled' };
  if (url.hash.length > '#ticket='.length + SLACK_DEV_OAUTH_TICKET_MAX_LENGTH) return { handle, error: 'invalid' };
  const params = new URLSearchParams(url.hash.slice(1));
  if (params.size !== 1) return { handle, error: 'invalid' };
  const parsed = SlackDevOAuthTicketSchema.safeParse({ ticket: params.get('ticket') });
  return parsed.success ? { handle, ticket: parsed.data.ticket } : { handle, error: 'invalid' };
}

export async function loadSlackDevOAuthConfig(handle: string,
  fetchImpl: typeof fetch = fetch): Promise<SlackDevOAuthBrowserConfig | null> {
  if (!SlackDevHandleSchema.safeParse(handle).success) return null;
  try {
    const response = await fetchImpl(`/vm/${handle}${SLACK_DEV_OAUTH_CONFIG_PATH}`, {
      credentials: 'same-origin', signal: AbortSignal.timeout(10_000),
      redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return null;
    const parsed = SlackDevOAuthBrowserConfigSchema.safeParse(await response.json());
    return parsed.success && parsed.data.handle === handle ? parsed.data : null;
  } catch (error: unknown) {
    console.warn('[slack-dev] setup unavailable', error instanceof Error ? error.name : 'UnknownError');
    return null;
  }
}

async function postSlackDevOAuth(config: SlackDevOAuthBrowserConfig, path: '/api/slack/install' | typeof SLACK_DEV_OAUTH_FINISH_PATH,
  body: object, getToken: SlackOAuthTokenReader, fetchImpl: typeof fetch): Promise<{ data: unknown } | { status: SlackOAuthFailure }> {
  if (!SlackDevOAuthBrowserConfigSchema.safeParse(config).success) return { status: 'unavailable' };
  try {
    const token = await refreshSlackOAuthToken(getToken);
    if (!token) return { status: 'signed_out' };
    const response = await fetchImpl(config.platformOrigin + path, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), credentials: 'omit', signal: AbortSignal.timeout(10_000),
      redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return { status: slackOAuthFailure(response.status) };
    return { data: await response.json() };
  } catch (error: unknown) {
    console.warn('[slack-dev] OAuth request unavailable', error instanceof Error ? error.name : 'UnknownError');
    return { status: 'unavailable' };
  }
}

export async function startSlackDevOAuth(config: SlackDevOAuthBrowserConfig,
  getToken: SlackOAuthTokenReader, fetchImpl: typeof fetch = fetch): Promise<{ status: SlackOAuthFailure } | { authorizationUrl: string }> {
  const result = await postSlackDevOAuth(config, '/api/slack/install', { organizationId: config.organizationId }, getToken, fetchImpl);
  if ('status' in result) return result;
  const payload = result.data;
  if (payload && typeof payload === 'object' && 'url' in payload && typeof payload.url === 'string'
    && payload.url.length <= 4_096 && URL.canParse(payload.url)) {
    const url = new URL(payload.url);
    if (url.origin === 'https://slack.com' && url.pathname === '/oauth/v2/authorize'
      && !url.username && !url.password && !url.hash
      && url.searchParams.get('redirect_uri') === config.platformOrigin + '/api/slack/oauth/callback'
      && url.searchParams.get('scope') === 'channels:history,channels:read' && !url.searchParams.has('user_scope')) {
      return { authorizationUrl: url.href };
    }
  }
  return { status: 'unavailable' };
}

export async function finishSlackDevOAuth(config: SlackDevOAuthBrowserConfig, ticket: string,
  getToken: SlackOAuthTokenReader, fetchImpl: typeof fetch = fetch): Promise<SlackOAuthResult> {
  const request = SlackDevOAuthTicketSchema.safeParse({ ticket });
  if (!request.success) return 'unavailable';
  const result = await postSlackDevOAuth(config, SLACK_DEV_OAUTH_FINISH_PATH, request.data, getToken, fetchImpl);
  if ('status' in result) return result.status;
  const data = result.data;
  return data !== null && typeof data === 'object' && 'connected' in data && data.connected === true ? 'connected' : 'unavailable';
}
