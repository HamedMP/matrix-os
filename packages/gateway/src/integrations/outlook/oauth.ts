import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { GRAPH_ORIGIN, MICROSOFT_OAUTH, OutlookError, requestOutlookJson } from "./http.js";

const serviceSchema = z.enum(["microsoft_outlook", "microsoft_outlook_calendar"]);
export type OutlookService = z.infer<typeof serviceSchema>;

export function isOutlookService(service: string): service is OutlookService {
  return serviceSchema.safeParse(service).success;
}

const scopeByService: Record<OutlookService, string> = {
  microsoft_outlook: "Mail.ReadWrite",
  microsoft_outlook_calendar: "Calendars.ReadWrite",
};
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const pkceToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const opaque = z.string().min(1).max(16_384).regex(/^[^\s\x00-\x1f\x7f]+$/);
const tokenResponse = z.object({
  access_token: opaque,
  refresh_token: opaque.optional(),
  expires_in: z.number().int().min(1).max(86_400),
  token_type: z.string().regex(/^Bearer$/i),
  scope: z.string().min(1).max(4096).optional(),
});
const profileResponse = z.object({
  id: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  mail: z.string().max(320).nullish(),
  userPrincipalName: z.string().max(320).nullish(),
});
const consentError = z.object({ error: z.enum(["invalid_grant", "interaction_required", "consent_required"]) });

export interface OutlookCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface OutlookAccount {
  id: string;
  email: string | null;
}

export function createOutlookPKCE(): { state: string; verifier: string } {
  return {
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
  };
}

function requestedScopes(service: OutlookService): string {
  return `offline_access ${GRAPH_ORIGIN}/User.Read ${GRAPH_ORIGIN}/${scopeByService[service]}`;
}

function hasGrantedScopes(service: OutlookService, scope: string | undefined): boolean {
  // Microsoft documents that an omitted scope means the requested scopes.
  if (scope === undefined) return true;
  const granted = scope.toLowerCase().split(/\s+/).map(value => value.replace(/^https:\/\/graph\.microsoft\.com\//, ""));
  return granted.includes("user.read") && granted.includes(scopeByService[service].toLowerCase());
}

export function createOutlookOAuth(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const clientId = z.uuid().parse(options.clientId);
  const clientSecret = opaque.parse(options.clientSecret);
  const callback = new URL(options.redirectUri);
  if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash || callback.search) {
    throw new OutlookError("unavailable");
  }
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const deadline = (signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(10_000);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };

  async function tokenRequest(service: OutlookService, grant: Record<string, string>, signal: AbortSignal) {
    const data = await requestOutlookJson({
      url: `${MICROSOFT_OAUTH}/token`,
      request: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ ...grant, client_id: clientId, client_secret: clientSecret, scope: requestedScopes(service) }).toString(),
      },
      signal,
      fetcher,
      maxBytes: MAX_OAUTH_RESPONSE_BYTES,
      isConsentError: data => consentError.safeParse(data).success,
    });
    const parsed = tokenResponse.safeParse(data);
    if (!parsed.success) throw new OutlookError("unavailable");
    if (!hasGrantedScopes(service, parsed.data.scope)) throw new OutlookError("consent_required");
    return parsed.data;
  }

  function credentials(token: z.infer<typeof tokenResponse>, previousRefresh?: string): OutlookCredentials {
    const refreshToken = token.refresh_token ?? previousRefresh;
    if (!refreshToken) throw new OutlookError("consent_required");
    return { accessToken: token.access_token, refreshToken, expiresAt: now() + token.expires_in * 1000 };
  }

  async function profile(accessToken: string, signal: AbortSignal): Promise<OutlookAccount> {
    const data = await requestOutlookJson({
      url: `${GRAPH_ORIGIN}/v1.0/me?$select=id,mail,userPrincipalName`,
      request: { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
      signal,
      fetcher,
      maxBytes: MAX_OAUTH_RESPONSE_BYTES,
    });
    const parsed = profileResponse.safeParse(data);
    if (!parsed.success) throw new OutlookError("unavailable");
    const mail = z.email().safeParse(parsed.data.mail);
    const upn = z.email().safeParse(parsed.data.userPrincipalName);
    return { id: parsed.data.id, email: mail.success ? mail.data : upn.success ? upn.data : null };
  }

  return {
    authorize(service: OutlookService, attempt: { state: string; verifier: string }): string {
      const url = new URL(`${MICROSOFT_OAUTH}/authorize`);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callback.href,
        response_type: "code",
        response_mode: "form_post",
        scope: requestedScopes(service),
        prompt: "select_account",
        state: pkceToken.parse(attempt.state),
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(pkceToken.parse(attempt.verifier)).digest("base64url"),
      }).toString();
      return url.href;
    },
    async exchange(service: OutlookService, code: string, verifier: string, callerSignal?: AbortSignal) {
      const signal = deadline(callerSignal);
      const token = await tokenRequest(service, {
        grant_type: "authorization_code",
        code: opaque.parse(code),
        code_verifier: pkceToken.parse(verifier),
        redirect_uri: callback.href,
      }, signal);
      const grant = credentials(token);
      return { credentials: grant, account: await profile(grant.accessToken, signal) };
    },
    async refresh(service: OutlookService, refreshToken: string, callerSignal?: AbortSignal) {
      const token = await tokenRequest(service, {
        grant_type: "refresh_token",
        refresh_token: opaque.parse(refreshToken),
      }, deadline(callerSignal));
      return credentials(token, refreshToken);
    },
  };
}
