import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod/v4";
import { decryptCustomMcpCredential, encryptCustomMcpCredential } from "../custom-mcp/crypto.js";
import { gmailOAuthRequest, NativeGmailOAuthError } from "./oauth-request.js";
import { GMAIL_SCOPE, type NativeGmailBinding, type NativeGmailConnection,
  type NativeGmailCredentials, type NativeGmailStore } from "./types.js";

const tokenSchema = z.object({
  access_token: z.string().min(1).max(16_384), refresh_token: z.string().min(1).max(16_384).optional(),
  expires_in: z.number().int().min(1).max(604_800), token_type: z.literal("Bearer"),
  scope: z.string().min(1).max(8_192).optional(),
});
const credentialSchema = z.object({ clientId: z.string().min(1).max(1024), accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384), expiresAt: z.number().finite(), scope: z.string().max(8_192) });
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const tokenBinding = (userId: string, accountId: string) => ({ userId: `native-gmail:${userId}`, serverId: `token:${accountId}` });
const stateBinding = (userId: string, stateHash: string) => ({ userId: `native-gmail:${userId}`, serverId: `pkce:${stateHash}` });
const granted = (scope: string | undefined) => scope?.split(/\s+/).includes(GMAIL_SCOPE) === true;

class RefreshLeaseBusy extends Error {}

export interface NativeGmailOAuthOptions {
  store: NativeGmailStore; clientId: string; clientSecret: string; redirectUri: string; encryptionKey: Buffer;
  fetcher?: typeof fetch; now?: () => number;
  admit?: (userId: string, persist: () => Promise<void>) => Promise<void>;
  isEligible?: (userId: string) => Promise<boolean>;
}

/** OAuth holds no plaintext credentials or replay state between operations. */
export class NativeGmailOAuthManager {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly options: NativeGmailOAuthOptions) {
    if (options.encryptionKey.length !== 32 || !options.clientId || !options.clientSecret) throw new NativeGmailOAuthError();
    const callback = new URL(options.redirectUri);
    if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash || callback.search) throw new NativeGmailOAuthError();
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async start(input: { userId: string; externalUserId: string; label?: string; redirectUri?: string }): Promise<{ url: string }> {
    if (!input.userId || !input.externalUserId || (input.redirectUri && input.redirectUri !== "matrixos://integrations")) throw new NativeGmailOAuthError();
    await this.assertEligible(input.userId);
    const labelValue = input.label === undefined ? undefined : z.string().trim().min(1).max(100).safeParse(input.label);
    if (labelValue && !labelValue.success) throw new NativeGmailOAuthError();
    // Empty durable label means no explicit rename; reconnect preserves the saved label.
    const label = labelValue?.success ? labelValue.data : "";
    const state = randomBytes(32).toString("base64url");
    const stateHash = hash(state);
    const verifier = randomBytes(32).toString("base64url");
    const now = new Date(this.now());
    await this.options.store.startState({ hash: stateHash, userId: input.userId, externalUserId: input.externalUserId,
      label, redirectUri: input.redirectUri, encryptedVerifier: encryptCustomMcpCredential({ verifier },
        this.options.encryptionKey, stateBinding(input.userId, stateHash)), now, expiresAt: new Date(now.getTime() + 600_000) });
    return { url: this.authorizationUrl(state, verifier) };
  }

  async authorization(state: string, owner: { userId: string }): Promise<{ url: string; browserProof: string }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new NativeGmailOAuthError();
    const pending = await this.options.store.inspectState(hash(state), new Date(this.now()));
    if (!pending || pending.userId !== owner.userId) throw new NativeGmailOAuthError();
    await this.assertEligible(pending.userId);
    const { verifier } = z.object({ verifier: z.string().min(43).max(128) }).parse(decryptCustomMcpCredential(
      pending.encryptedVerifier, this.options.encryptionKey, stateBinding(pending.userId, pending.hash)));
    return { url: this.authorizationUrl(state, verifier), browserProof: this.browserProof(state) };
  }

  private browserProof(state: string): string {
    return createHmac("sha256", this.options.encryptionKey).update(`matrix-native-gmail:browser-proof:v1:${state}`).digest("hex");
  }
  private validateBrowserProof(state: string, proof: string): void {
    if (!/^[0-9a-f]{64}$/.test(proof ?? "") || !timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(this.browserProof(state), "hex")))
      throw new NativeGmailOAuthError();
  }

  private authorizationUrl(state: string, verifier: string): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.options.redirectUri,
      response_type: "code", scope: GMAIL_SCOPE, access_type: "offline", prompt: "consent", state,
      code_challenge: hash(verifier), code_challenge_method: "S256" }).toString();
    return url.toString();
  }

  async cancel(state: string, browserProof: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new NativeGmailOAuthError();
    this.validateBrowserProof(state, browserProof);
    await this.options.store.consumeState(hash(state), new Date(this.now()));
  }

  async complete(state: string, code: string, browserProof: string): Promise<{ connectionId: string; accountLabel: string; redirectUri?: string }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new NativeGmailOAuthError();
    this.validateBrowserProof(state, browserProof);
    const pending = await this.options.store.consumeState(hash(state), new Date(this.now()));
    if (!pending || !code || code.length > 4096) throw new NativeGmailOAuthError();
    let connected: NativeGmailConnection | undefined;
    const persist = async () => {
      await this.assertEligible(pending.userId);
      const ownerLease = await this.options.store.acquireOwnerLease(pending.userId, new Date(this.now()));
      if (!ownerLease) throw new NativeGmailOAuthError();
      try {
        const { verifier } = z.object({ verifier: z.string().min(43).max(128) }).parse(decryptCustomMcpCredential(
          pending.encryptedVerifier, this.options.encryptionKey, stateBinding(pending.userId, pending.hash)));
        const credentials = await this.exchange(new URLSearchParams({ grant_type: "authorization_code", code,
          code_verifier: verifier, redirect_uri: this.options.redirectUri, client_id: this.options.clientId,
          client_secret: this.options.clientSecret }));
        await this.assertEligible(pending.userId);
        const response = await gmailOAuthRequest({ endpoint: "profile", fetcher: this.fetcher, accessToken: credentials.accessToken });
        if (response.status !== 200) throw new NativeGmailOAuthError();
        const profile = z.object({ emailAddress: z.email().max(254) }).parse(this.parse(response.body));
        await this.assertEligible(pending.userId);
        connected = await this.options.store.connect({ userId: pending.userId, externalUserId: pending.externalUserId,
          email: profile.emailAddress.toLowerCase(), label: pending.label || undefined, scopes: credentials.scope.split(/\s+/),
          encrypt: (accountId) => this.encrypt(credentials, pending.userId, accountId), now: new Date(this.now()), ownerLease });
      } finally { await this.options.store.releaseOwnerLease(pending.userId, ownerLease); }
    };
    try {
      if (this.options.admit) await this.options.admit(pending.userId, persist);
      else await persist();
      if (!connected) throw new NativeGmailOAuthError();
      return { connectionId: connected.connectionId, accountLabel: connected.accountLabel,
        ...(pending.redirectUri ? { redirectUri: pending.redirectUri } : {}) };
    } catch (error) {
      if (error instanceof NativeGmailOAuthError) throw error;
      throw new NativeGmailOAuthError();
    }
  }

  async token(binding: NativeGmailBinding, callerSignal?: AbortSignal): Promise<string> {
    const deadline = AbortSignal.timeout(10_000);
    const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
    try {
      // Coordination is durable: different processes reload the exact account's settled revision.
      // Poll count and deadline bound both database work and waiting; no in-memory registry is needed.
      for (let poll = 0; poll < 100; poll++) {
        signal.throwIfAborted();
        let row = await this.bounded(this.options.store.lookup(binding, new Date(this.now())), signal);
        if (!row && !await this.bounded(this.options.store.refreshPending(binding, new Date(this.now())), signal)) {
          // The refresh may have settled between these two reads. Re-read before rejecting.
          row = await this.bounded(this.options.store.lookup(binding, new Date(this.now())), signal);
          if (!row) throw new NativeGmailOAuthError();
        }
        if (row) {
          await this.bounded(this.assertEligible(row.userId), signal);
          const credentials = this.decrypt(row);
          if (!granted(credentials.scope)) throw new NativeGmailOAuthError();
          if (credentials.expiresAt <= this.now() + 60_000) {
            try { return await this.refreshRow(row, signal); }
            catch (error) { if (!(error instanceof RefreshLeaseBusy)) throw error; }
          } else {
            await this.bounded(this.assertEligible(row.userId), signal);
            if (await this.bounded(this.options.store.assertCurrent(row, new Date(this.now())), signal)) {
              signal.throwIfAborted();
              return credentials.accessToken;
            }
          }
        }
        await wait(100, undefined, { signal });
      }
      throw new NativeGmailOAuthError();
    } catch (error) {
      if (error instanceof NativeGmailOAuthError) throw error;
      throw new NativeGmailOAuthError();
    }
  }

  private async bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new NativeGmailOAuthError());
      signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([work, aborted]); }
    finally { signal.removeEventListener("abort", abort); }
  }

  async refresh(binding: { userId: string; connectionId: string }): Promise<void> {
    await this.assertEligible(binding.userId);
    const row = await this.options.store.byConnection(binding);
    if (!row || row.status !== "active") throw new NativeGmailOAuthError();
    try { await this.refreshRow(row); }
    catch (error) {
      if (!(error instanceof RefreshLeaseBusy)) throw error;
      await this.token({ externalUserId: row.externalUserId, accountId: row.accountId });
    }
  }

  private async refreshRow(row: NativeGmailConnection, signal?: AbortSignal): Promise<string> {
    await this.assertEligible(row.userId);
    const lease = await this.options.store.acquireLease(row, new Date(this.now()));
    if (!lease) throw new RefreshLeaseBusy();
    try {
      const current = this.decrypt(row);
      const updated = await this.exchange(new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken,
        client_id: this.options.clientId, client_secret: this.options.clientSecret }), current, signal);
      signal?.throwIfAborted();
      if (!await this.options.store.settle(lease, this.encrypt(updated, row.userId, row.accountId), "active", new Date(this.now()))) throw new NativeGmailOAuthError();
      // Revalidate canonical policy and revision after settlement before direct dispatch.
      await this.assertEligible(row.userId);
      if (!await this.options.store.assertCurrent({ ...row, revision: row.revision + 1 }, new Date(this.now()))) throw new NativeGmailOAuthError();
      return updated.accessToken;
    } catch (error) {
      if (error instanceof NativeGmailOAuthError && error.invalidGrant) {
        await this.options.store.settle(lease, row.encryptedCredentials, "expired", new Date(this.now()));
      }
      throw new NativeGmailOAuthError();
    } finally { await this.options.store.releaseLease(lease); }
  }

  async revoke(binding: { userId: string; connectionId: string }): Promise<boolean> {
    if (!await this.options.store.byConnection(binding)) return false;
    const ownerLease = await this.options.store.acquireOwnerLease(binding.userId, new Date(this.now()));
    if (!ownerLease) throw new NativeGmailOAuthError();
    try {
      // Re-read under owner admission: consent could have settled after the first read.
      const row = await this.options.store.byConnection(binding);
      if (!row) return false;
      const lease = await this.options.store.acquireLease(row, new Date(this.now()), "revoke");
      if (!lease) throw new NativeGmailOAuthError();
      try {
        const credentials = this.decrypt(row);
        const response = await gmailOAuthRequest({ endpoint: "revoke", fetcher: this.fetcher,
          body: new URLSearchParams({ token: credentials.refreshToken }) });
        const alreadyRevoked = response.status === 400 &&
          z.object({ error: z.literal("invalid_token") }).safeParse(this.parse(response.body)).success;
        if (!alreadyRevoked && (response.status !== 200 || response.body.trim() !== "")) throw new NativeGmailOAuthError();
        if (!await this.options.store.remove(lease, new Date(this.now()))) throw new NativeGmailOAuthError();
        return true;
      } finally { await this.options.store.releaseLease(lease); }
    } finally { await this.options.store.releaseOwnerLease(binding.userId, ownerLease); }
  }

  private async assertEligible(userId: string): Promise<void> {
    if (this.options.isEligible && !await this.options.isEligible(userId)) throw new NativeGmailOAuthError();
  }

  private async exchange(body: URLSearchParams, previous?: NativeGmailCredentials, signal?: AbortSignal): Promise<NativeGmailCredentials> {
    const response = await gmailOAuthRequest({ endpoint: "token", fetcher: this.fetcher, body, signal });
    const data = this.parse(response.body);
    if (response.status !== 200) throw new NativeGmailOAuthError(z.object({ error: z.literal("invalid_grant") }).safeParse(data).success);
    const parsed = tokenSchema.safeParse(data);
    if (!parsed.success) throw new NativeGmailOAuthError();
    const value = parsed.data;
    const scope = value.scope ?? previous?.scope;
    if (!granted(scope)) throw new NativeGmailOAuthError();
    const refreshToken = value.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw new NativeGmailOAuthError();
    return { clientId: this.options.clientId, accessToken: value.access_token, refreshToken, scope: scope!, expiresAt: this.now() + value.expires_in * 1000 };
  }
  private parse(body: string): unknown {
    try { return JSON.parse(body); }
    catch (error) { if (error instanceof SyntaxError) throw new NativeGmailOAuthError(); throw error; }
  }
  private encrypt(value: NativeGmailCredentials, userId: string, accountId: string): string {
    return encryptCustomMcpCredential(value, this.options.encryptionKey, tokenBinding(userId, accountId));
  }
  private decrypt(row: NativeGmailConnection): NativeGmailCredentials {
    try {
      const parsed = credentialSchema.parse(decryptCustomMcpCredential(row.encryptedCredentials, this.options.encryptionKey, tokenBinding(row.userId, row.accountId)));
      if (parsed.clientId !== this.options.clientId) throw new NativeGmailOAuthError();
      return parsed;
    }
    catch (error) { if (error instanceof Error) throw new NativeGmailOAuthError(); throw error; }
  }
}
