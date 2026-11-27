/** No request-derived origin or user redirect can choose the server-only receipt destination. */
export function loadGmailPipedreamAttemptConfig(env: NodeJS.ProcessEnv): { callbackUrl: string; environment: "production" | "development" } | undefined {
  if (env.GMAIL_PIPEDREAM_ATTEMPTS_ENABLED !== "true") return undefined;
  try {
    // This is a deployment attestation, not automatic evidence. Operators must verify
    // exclusion of callback URLs from Cloud Run request logs and any other access log.
    if (env.GMAIL_PIPEDREAM_CALLBACK_LOGGING_EXCLUDED !== "true") throw new Error();
    if (!env.PLATFORM_PUBLIC_URL) throw new Error();
    const origin = new URL(env.PLATFORM_PUBLIC_URL);
    const hosts = (env.MATRIX_APP_DOMAIN_HOSTS ?? "app.matrix-os.com,app.localhost").split(",").map(host => host.trim());
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || !hosts.includes(origin.host)) throw new Error();
    const environment = env.PIPEDREAM_ENVIRONMENT ?? "production";
    if (environment !== "production" && environment !== "development") throw new Error();
    return { callbackUrl: new URL("/api/integrations/gmail/pipedream/callback", origin).href, environment };
  } catch (error) {
    console.warn("[gmail-attempt] Configuration rejected:", error instanceof Error ? error.name : "UnknownError");
    throw new Error("Gmail connection receipts unavailable");
  }
}
