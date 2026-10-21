/** Public only because authorization is an expiring, one-use stored consent state. */
export function isGmailOAuthCallback(method: string, path: string): boolean {
  return method === 'GET' && path === '/api/integrations/gmail/oauth/callback';
}
