const MAX_DURATION_MS = 2 * 60 * 60_000;
const MAX_CHECKOUT_BYTES = 16 * 1024;
export interface AiCreditCandidateEnv {
  AI_CREDIT_CANDIDATE_ORIGIN?: string;
  AI_CREDIT_CANDIDATE_HANDLE?: string;
  AI_CREDIT_CANDIDATE_EXPIRES_AT?: string;
}

/** Selects transport only. Platform retains owner/runtime auth and its exact
 * machine allowlist; this selector never grants purchase or funded authority. */
export function aiCreditCandidateOrigin(input: {
  request: Request; url: URL; platformOrigin: string; env: AiCreditCandidateEnv;
  body: ArrayBuffer | null;
}): string | null {
  const { request, url, platformOrigin, env, body } = input;
  if (request.method !== 'POST' || !['app.matrix-os.com','api.matrix-os.com'].includes(url.hostname)) return null;
  const handle = env.AI_CREDIT_CANDIDATE_HANDLE;
  if (!handle || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(handle)) return null;
  const expiry = env.AI_CREDIT_CANDIDATE_EXPIRES_AT;
  if (!expiry || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry)) return null;
  const remaining = Date.parse(expiry) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > MAX_DURATION_MS) return null;
  const funding = url.pathname === `/internal/containers/${handle}/ai/funding-summary`
    && url.searchParams.getAll('runtimeSlot').length === 1 && url.searchParams.get('runtimeSlot') === 'primary';
  let checkout = false;
  if (url.pathname === '/billing/ai-credit/checkout' && !url.search && body && body.byteLength <= MAX_CHECKOUT_BYTES) {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(body));
      checkout = !!value && typeof value === 'object' && !Array.isArray(value)
        && (!('runtimeSlot' in value) || value.runtimeSlot === 'primary')
        && 'packageId' in value && ['usd_5','usd_10','usd_25'].includes(String(value.packageId));
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    }
  }
  if (!funding && !checkout) return null;
  try {
    const base = new URL(platformOrigin), candidate = new URL(env.AI_CREDIT_CANDIDATE_ORIGIN ?? '');
    const suffix = `---${base.hostname}`;
    const tag = candidate.hostname.slice(0,-suffix.length);
    if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.port
      || candidate.pathname !== '/' || candidate.search || candidate.hash
      || !candidate.hostname.endsWith(suffix) || !/^pr[1-9][0-9]{0,8}(?:-[a-z0-9]+)+$/.test(tag)) return null;
    return candidate.origin;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
