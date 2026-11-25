import { SlackOAuthCallbackQuerySchema, type SlackOAuthCallbackQuery } from '@matrix-os/contracts/slack-bridge';

export function readSlackOAuthQuery(search: string): SlackOAuthCallbackQuery | null {
  if (search.length > 4096) return null;
  const params = new URLSearchParams(search);
  if ([...params.keys()].length !== 2) return null;
  const parsed = SlackOAuthCallbackQuerySchema.safeParse(Object.fromEntries(params));
  return parsed.success ? parsed.data : null;
}

export type SlackOAuthResult = 'connected' | 'signed_out' | 'forbidden' | 'expired' | 'unavailable';
export type SlackOAuthTokenReader = (options: { skipCache: boolean }) => Promise<string | null>;

export async function refreshSlackOAuthToken(getToken: SlackOAuthTokenReader): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([getToken({ skipCache: true }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Session unavailable')), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function slackOAuthFailure(status: number): Exclude<SlackOAuthResult, 'connected'> {
  if (status === 401) return 'signed_out';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'expired';
  return 'unavailable';
}

export async function finishSlackOAuth(query: SlackOAuthCallbackQuery,
  getToken: SlackOAuthTokenReader, fetchImpl: typeof fetch = fetch): Promise<SlackOAuthResult> {
  try {
    const token = await refreshSlackOAuthToken(getToken);
    if (!token) return 'signed_out';
    const response = await fetchImpl('/api/slack/oauth/callback?' + new URLSearchParams(query), {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' }, credentials: 'omit',
      signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return slackOAuthFailure(response.status);
    const payload: unknown = await response.json();
    return payload !== null && typeof payload === 'object' && 'connected' in payload && payload.connected === true ? 'connected' : 'unavailable';
  } catch (error: unknown) {
    console.warn('[slack] completion unavailable', error instanceof Error ? error.name : 'UnknownError');
    return 'unavailable';
  }
}
