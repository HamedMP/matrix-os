/** Public only because authorization is an expiring, one-use stored consent state. */
export function isGmailOAuthCallback(method: string, path: string): boolean {
  return method === 'GET' && path === '/api/integrations/gmail/oauth/callback';
}

/** Secret-bound receipt authentication happens inside this exact POST handler. */
export function isGmailPipedreamCallback(method: string, path: string): boolean {
  return method === "POST" && path === "/api/integrations/gmail/pipedream/callback";
}
