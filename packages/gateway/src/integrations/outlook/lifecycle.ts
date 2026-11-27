import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { ConnectedServicesTable, PlatformDb } from "../../platform-db.js";
import { decryptCustomMcpCredential, decryptCustomMcpOAuthState, encryptCustomMcpCredential, encryptCustomMcpOAuthState } from "../custom-mcp/crypto.js";
import { OutlookError } from "./http.js";
import { createOutlookPKCE, type createOutlookOAuth, type OutlookCredentials, type OutlookService } from "./oauth.js";
import { isNativeOutlookConnection, type OutlookStore } from "./store.js";

export const OUTLOOK_OAUTH_CALLBACK = "/api/integrations/outlook/oauth/callback";
export const OUTLOOK_OAUTH_AUTHORIZE = "/api/integrations/outlook/oauth/authorize";
export const OUTLOOK_MOBILE_RETURN = "matrixos://integrations";

export const outlookStateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const statePayload = z.object({
  verifier: outlookStateSchema,
  service: z.enum(["microsoft_outlook", "microsoft_outlook_calendar"]),
  label: z.string().trim().min(1).max(100).optional(),
  redirectUri: z.literal(OUTLOOK_MOBILE_RETURN).optional(),
  replace: z.object({ connectionId: z.uuid(), providerRef: z.string().min(1).max(256) }).optional(),
});
const browserPayload = z.object({ kind: z.literal("matrix-outlook"), userId: z.uuid(), hash: z.string().length(64) });
const grantPayload = z.object({
  accessToken: z.string().min(1).max(16_384).regex(/^[^\s\x00-\x1f\x7f]+$/),
  refreshToken: z.string().min(1).max(16_384).regex(/^[^\s\x00-\x1f\x7f]+$/),
  expiresAt: z.number().int().positive(),
});
export const outlookStateHash = (state: string) => createHash("sha256").update(state).digest("hex");

const credentialBinding = (userId: string, connectionId: string) => ({ userId: `matrix-outlook:${userId}`, serverId: `grant:${connectionId}` });
const stateBinding = (userId: string, hash: string) => ({ userId: `matrix-outlook:${userId}`, serverId: `attempt:${hash}` });

export type OutlookLifecycle = ReturnType<typeof createOutlookLifecycle>;

export function createOutlookLifecycle(options: {
  db: Pick<PlatformDb, "getConnectedService">;
  store: OutlookStore;
  oauth: ReturnType<typeof createOutlookOAuth>;
  encryptionKey: Buffer;
  redirectUri: string;
  now?: () => number;
  verifyLegacy?: (userId: string, connection: ConnectedServicesTable, signal: AbortSignal) => Promise<string>;
  admit?: <T>(userId: string, complete: () => Promise<T>) => Promise<T>;
}) {
  const { db, store, oauth, encryptionKey } = options;
  const now = options.now ?? Date.now;
  const authorizeUrl = new URL(OUTLOOK_OAUTH_AUTHORIZE, options.redirectUri);
  if (encryptionKey.length !== 32 || authorizeUrl.protocol !== "https:") throw new OutlookError("unavailable");

  async function requireConnection(userId: string, service: OutlookService, connectionId: string) {
    const connection = await db.getConnectedService(connectionId);
    if (!connection || connection.user_id !== userId || connection.service !== service || connection.status !== "active") {
      throw new OutlookError("consent_required");
    }
    return connection;
  }

  function sealGrant(userId: string, connectionId: string, credentials: OutlookCredentials) {
    return encryptCustomMcpCredential(credentials, encryptionKey, credentialBinding(userId, connectionId));
  }

  async function decryptGrant(userId: string, service: OutlookService, connectionId: string) {
    const stored = await store.getGrant(userId, service, connectionId);
    if (!stored) throw new OutlookError("consent_required");
    return {
      revision: stored.revision,
      credentials: grantPayload.parse(decryptCustomMcpCredential(stored.encrypted, encryptionKey, credentialBinding(userId, connectionId))),
    };
  }

  return {
    async start(input: { userId: string; service: OutlookService; label?: string; redirectUri?: string; connectionId?: string }) {
      const connection = input.connectionId ? await requireConnection(input.userId, input.service, input.connectionId) : undefined;
      const { state, verifier } = createOutlookPKCE();
      const hash = outlookStateHash(state);
      const payload = statePayload.parse({
        verifier, service: input.service, label: input.label, redirectUri: input.redirectUri,
        replace: connection && { connectionId: connection.id, providerRef: connection.pipedream_account_id },
      });
      const encryptedPayload = encryptCustomMcpCredential(payload, encryptionKey, stateBinding(input.userId, hash));
      const timestamp = now();
      await store.saveAttempt({
        hash, userId: input.userId, encryptedPayload, now: new Date(timestamp), expiresAt: new Date(timestamp + 600_000),
      });
      const url = new URL(authorizeUrl);
      url.searchParams.set("state", state);
      return url.href;
    },

    async authorization(rawState: string, userId: string) {
      const state = outlookStateSchema.parse(rawState);
      const hash = outlookStateHash(state);
      const attempt = await store.getAttempt(hash, userId, new Date(now()));
      if (!attempt) throw new OutlookError("consent_required");
      const payload = statePayload.parse(decryptCustomMcpCredential(attempt.encryptedPayload, encryptionKey, stateBinding(userId, hash)));
      return {
        url: oauth.authorize(payload.service, { state, verifier: payload.verifier }),
        browserProof: encryptCustomMcpOAuthState({ kind: "matrix-outlook", userId, hash }, encryptionKey),
      };
    },

    async complete(rawState: string, browserProof: string, code?: string, callerSignal?: AbortSignal) {
      const state = outlookStateSchema.parse(rawState);
      const hash = outlookStateHash(state);
      const proof = browserPayload.parse(decryptCustomMcpOAuthState(browserProof, encryptionKey));
      if (proof.hash !== hash) throw new OutlookError("consent_required");
      const attempt = await store.consumeAttempt(hash, proof.userId, new Date(now()));
      if (!attempt) throw new OutlookError("consent_required");
      const payload = statePayload.parse(decryptCustomMcpCredential(attempt.encryptedPayload, encryptionKey, stateBinding(attempt.userId, hash)));
      if (!code) return null;

      const { service, replace } = payload;
      const timeout = AbortSignal.timeout(15_000);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      const { account, credentials } = await oauth.exchange(service, code, payload.verifier, signal);

      let verifiedReplacement: Parameters<OutlookStore["link"]>[0]["replace"];
      if (replace) {
        const existing = await requireConnection(attempt.userId, service, replace.connectionId);
        if (existing.pipedream_account_id !== replace.providerRef) throw new OutlookError("consent_required");
        const graphAccountId = isNativeOutlookConnection(existing)
          ? (await store.getGrant(attempt.userId, service, existing.id))?.accountId
          : await options.verifyLegacy?.(attempt.userId, existing, signal);
        if (graphAccountId !== account.id) throw new OutlookError("account_mismatch");
        verifiedReplacement = { connectionId: existing.id, expectedProviderRef: replace.providerRef, graphAccountId };
      }
      const link = () => store.link({
        userId: attempt.userId, service, account, label: payload.label,
        scopes: ["User.Read", service === "microsoft_outlook" ? "Mail.ReadWrite" : "Calendars.ReadWrite"],
        encrypt: connectionId => sealGrant(attempt.userId, connectionId, credentials), replace: verifiedReplacement,
      });
      const connection = options.admit ? await options.admit(attempt.userId, link) : await link();
      return { connection, redirectUri: payload.redirectUri };
    },

    async accessToken(userId: string, service: OutlookService, connectionId: string, input?: { forceRefresh?: boolean; signal?: AbortSignal }) {
      const current = await decryptGrant(userId, service, connectionId);
      if (!input?.forceRefresh && current.credentials.expiresAt > now() + 30_000) return current.credentials.accessToken;
      const next = await oauth.refresh(service, current.credentials.refreshToken, input?.signal);
      if (await store.refreshGrant(userId, connectionId, current.revision, sealGrant(userId, connectionId, next))) {
        return next.accessToken;
      }
      // Refresh, reconnect or disconnect won the write. Read the committed grant before continuing.
      const settled = await decryptGrant(userId, service, connectionId);
      if (settled.credentials.expiresAt <= now()) throw new OutlookError("consent_required");
      return settled.credentials.accessToken;
    },
  };
}
