import {
  MatrixComputerListSchema,
  isPrivatePreviewHandle,
  RuntimeSelectionRequestSchema,
  RuntimeSelectionResponseSchema,
  type MatrixComputerList,
} from "@matrix-os/contracts";
// Trusted-core auth orchestration: owns the device flow, the credential, and
// the connection profile. The renderer only ever sees status snapshots.
import type { CredentialStore, StoredCredential } from "./credential-store";
import {
  DeviceFlowError,
  pollForToken,
  requestDeviceCode,
  type DeviceCodeResponse,
} from "./device-auth";
import { fetchCanonicalCustomerHandle, fetchOwnerPrivateComputers, supplementPrivateComputers } from "./private-preview-computers";

export interface ConnectionProfile {
  handle: string;
  userId: string;
  platformHost: string;
  runtimeSlot: string;
  displayName?: string;
  imageUrl?: string;
  email?: string;
}

interface AuthStatusBase {
  runtimeSlot: string;
  platformHost: string;
  // Monotonic credential generation. Advances on every credential replacement
  // or drop so renderer caches keyed on identity cannot survive a session swap
  // that keeps the same handle/host/slot.
  authGeneration: number;
}

export type AuthStatus =
  | (AuthStatusBase & {
      signedIn: true;
      handle: string;
      userId: string;
      displayName?: string;
      imageUrl?: string;
      email?: string;
    })
  | (AuthStatusBase & {
      signedIn: false;
    });

export type PollResult = {
  status: "pending" | "authorized" | "expired";
  profile?: { handle: string; userId: string };
};

export type DeviceAuthIntent = "sign-up" | "sign-in";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// Re-authenticate slightly before the token's real expiry so an in-flight
// request doesn't race the cutoff.
const EXPIRY_SKEW_MS = 30_000;
const RUNTIME_SELECTION_TIMEOUT_MS = 10_000;
const RUNTIME_SELECTION_RESPONSE_LIMIT = 16 * 1024;
const RUNTIME_SELECTION_ERROR = "Computer switch failed. Try again.";

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > RUNTIME_SELECTION_RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("runtime selection response too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

interface AuthServiceDeps {
  credentialStore: CredentialStore;
  platformHost: string;
  runtimeSelectionOrigin: string;
  fetchFn?: FetchFn;
  now?: () => number;
  loadProfile: () => Promise<ConnectionProfile | null>;
  saveProfile: (profile: ConnectionProfile) => Promise<void>;
  clearProfile: () => Promise<void>;
  onAuthChanged: (status: AuthStatus) => void;
}

export class AuthService {
  private credential: StoredCredential | null = null;
  private authGeneration = 0;
  private profile: ConnectionProfile | null = null;
  private flowState: "idle" | "pending" | "authorized" | "expired" = "idle";
  private flowNonce = 0;
  private inventoryRevision = 0;
  private persistenceTail: Promise<void> = Promise.resolve();
  private pendingDeviceCode: Pick<DeviceCodeResponse, "userCode" | "verificationUri" | "expiresIn"> | null = null;
  private readonly deps: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  async init(): Promise<void> {
    this.credential = await this.deps.credentialStore.load();
    this.profile = await this.deps.loadProfile();
    if (this.isExpired()) {
      this.credential = null;
      try {
        await this.deps.credentialStore.clear();
      } catch (err: unknown) {
        console.warn(
          "[auth] failed to clear expired credential:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private runPersistence<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.persistenceTail.then(operation, operation);
    this.persistenceTail = result.then(() => undefined, () => undefined);
    return result;
  }

  // A credential past (or within the skew window of) its expiry is unusable;
  // sending it would just earn a 401, so treat it as signed-out.
  private isExpired(): boolean {
    return this.credential !== null && this.credential.expiresAt <= this.now() + EXPIRY_SKEW_MS;
  }

  getToken(): string | null {
    this.expireCredentialIfNeeded();
    if (!this.credential) return null;
    return this.credential.accessToken;
  }

  getGatewayOrigin(): string {
    const profile = this.credential && this.profile?.userId !== this.credential.userId
      ? null
      : this.profile;
    return profile?.platformHost ?? this.deps.platformHost;
  }

  getStatus(): AuthStatus {
    this.expireCredentialIfNeeded();
    return this.currentStatus();
  }

  private currentStatus(): AuthStatus {
    const signedIn = this.credential !== null && !this.isExpired();
    const credential = signedIn ? this.credential : null;
    const authenticatedProfile = credential && this.profile?.userId === credential.userId
      ? this.profile
      : null;
    if (!credential) {
      return {
        signedIn: false,
        runtimeSlot: this.profile?.runtimeSlot ?? "primary",
        platformHost: this.getGatewayOrigin(),
        authGeneration: this.authGeneration,
      };
    }
    return {
      signedIn: true,
      handle: credential.handle,
      userId: credential.userId,
      ...(authenticatedProfile?.displayName ? { displayName: authenticatedProfile.displayName } : {}),
      ...(authenticatedProfile?.imageUrl ? { imageUrl: authenticatedProfile.imageUrl } : {}),
      ...(authenticatedProfile?.email ? { email: authenticatedProfile.email } : {}),
      runtimeSlot: authenticatedProfile?.runtimeSlot ?? "primary",
      platformHost: this.getGatewayOrigin(),
      authGeneration: this.authGeneration,
    };
  }

  private replaceCredential(credential: StoredCredential | null): void {
    this.credential = credential;
    this.authGeneration += 1;
  }

  async startDeviceFlow(intent: DeviceAuthIntent = "sign-up"): Promise<Pick<DeviceCodeResponse, "userCode" | "verificationUri" | "expiresIn">> {
    if (this.flowState === "pending" && this.pendingDeviceCode) {
      return this.pendingDeviceCode;
    }
    const fetchFn = this.deps.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
    const baseUrl = this.getGatewayOrigin();
    const nonce = ++this.flowNonce;
    let code: DeviceCodeResponse;
    try {
      code = await requestDeviceCode({ fetchFn, baseUrl });
    } catch (err: unknown) {
      if (nonce !== this.flowNonce) throw new Error("Sign-in request was canceled.");
      throw err;
    }
    if (nonce !== this.flowNonce) throw new Error("Sign-in request was canceled.");
    this.flowState = "pending";
    const verificationUri = new URL(code.verificationUri);
    verificationUri.searchParams.set("mode", intent);
    const pendingDeviceCode = {
      userCode: code.userCode,
      verificationUri: verificationUri.toString(),
      expiresIn: code.expiresIn,
    };
    this.pendingDeviceCode = pendingDeviceCode;

    // Background poll loop; auth:poll reads flowState snapshots.
    void pollForToken({
      fetchFn,
      baseUrl,
      deviceCode: code.deviceCode,
      intervalSeconds: code.interval,
      expiresInSeconds: code.expiresIn,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
      .then(async (token) => {
        if (nonce !== this.flowNonce) return;
        // The encrypted credential holds only the secret token + identity; the
        // non-secret display profile lives in the plain profile store.
        let credential: StoredCredential = {
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
          userId: token.userId,
          handle: token.handle,
        };
        let runtimeSlot = token.runtimeSlot ?? this.profile?.runtimeSlot ?? "primary";
        let privateLeaseExpiresAt: number | undefined;
        const isCurrentFlow = () => nonce === this.flowNonce
          && (privateLeaseExpiresAt === undefined || privateLeaseExpiresAt > this.now());
        if (!token.runtimeSlot && runtimeSlot !== "primary") {
          let verifiedCustomer = false;
          try {
            credential = await this.exchangeRuntimeCredential(credential, runtimeSlot, isCurrentFlow,
              (admission) => {
                verifiedCustomer = admission.kind === "customer";
                privateLeaseExpiresAt = admission.kind === "private" ? admission.expiresAt : undefined;
              });
          } catch (err: unknown) {
            if (nonce !== this.flowNonce) return;
            // A private restore needs fresh owner/member/lease evidence. Never
            // silently reconnect its user to Main when that admission fails.
            if (isPrivatePreviewHandle(runtimeSlot) && !verifiedCustomer) throw err;
            runtimeSlot = "primary";
            console.warn(
              "[auth] runtime restore failed; using primary:",
              err instanceof Error ? err.name : typeof err,
            );
          }
        }
        if (nonce !== this.flowNonce) return;
        const profile: ConnectionProfile = {
          handle: credential.handle,
          userId: token.userId,
          platformHost: baseUrl,
          runtimeSlot,
          ...(token.displayName ? { displayName: token.displayName } : {}),
          ...(token.imageUrl ? { imageUrl: token.imageUrl } : {}),
          ...(token.email ? { email: token.email } : {}),
        };
        const discardInvalidPersistence = async () => {
          await this.clearStaleFlowPersistence();
          if (nonce === this.flowNonce) throw new DeviceFlowError("expired");
        };
        const persist = async () => {
          if (nonce !== this.flowNonce) return;
          if (!isCurrentFlow()) throw new DeviceFlowError("expired");
          try {
            await this.deps.credentialStore.save(credential);
          } catch (err: unknown) {
            console.warn(
              "[auth] failed to persist credential:",
              err instanceof Error ? err.message : String(err),
            );
          }
          if (!isCurrentFlow()) { await discardInvalidPersistence(); return; }
          try {
            await this.deps.saveProfile(profile);
          } catch (err: unknown) {
            console.warn(
              "[auth] failed to persist profile:",
              err instanceof Error ? err.message : String(err),
            );
          }
          if (!isCurrentFlow()) { await discardInvalidPersistence(); return; }
          if (privateLeaseExpiresAt !== undefined) {
            // Private authority stays staged until both persistence boundaries
            // settle with the same flow and an unexpired admitted lease.
            this.replaceCredential(credential);
            this.profile = profile;
          }
          this.flowState = "authorized";
          this.pendingDeviceCode = null;
          this.deps.onAuthChanged(this.getStatus());
        };
        if (privateLeaseExpiresAt !== undefined) await this.runPersistence(persist);
        else {
          // A newer flow must not persist ahead of an older private restore's
          // cleanup or queued sign-out. Legacy persistence remains best-effort.
          await this.persistenceTail;
          if (nonce !== this.flowNonce) return;
          this.replaceCredential(credential);
          this.profile = profile;
          await persist();
        }
      })
      .catch((err: unknown) => {
        if (nonce !== this.flowNonce) return;
        if (err instanceof DeviceFlowError) {
          this.flowState = "expired";
          this.pendingDeviceCode = null;
          return;
        }
        console.warn(
          "[auth] device flow failed:",
          err instanceof Error ? err.message : String(err),
        );
        this.flowState = "expired";
        this.pendingDeviceCode = null;
      });

    // Do NOT auto-open the browser. The renderer shows the user code and an
    // explicit "Open approval page" button (shell:open-external) — auto-opening
    // popped a surprise tab on every launch (and on every e2e run, which points
    // at a stub whose verification URL is unroutable).
    return pendingDeviceCode;
  }

  poll(): PollResult {
    if (this.flowState === "authorized" && this.profile) {
      return {
        status: "authorized",
        profile: { handle: this.profile.handle, userId: this.profile.userId },
      };
    }
    if (this.flowState === "expired") return { status: "expired" };
    return { status: "pending" };
  }

  private async exchangeRuntimeCredential(
    currentCredential: StoredCredential,
    slot: string,
    isCurrent: () => boolean = () => true,
    onAdmission?: (admission: { kind: "customer" } | { kind: "private"; expiresAt: number }) => void,
  ): Promise<StoredCredential> {
    const request = RuntimeSelectionRequestSchema.parse({ slot });
    const endpoint = new URL("/api/auth/runtime-selection", this.deps.runtimeSelectionOrigin);
    const fetchFn = this.deps.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
    let privateLeaseExpiresAt: number | undefined;
    let expectedHandle: string | undefined;
    if (isPrivatePreviewHandle(slot)) {
      const privateInventory = await fetchOwnerPrivateComputers({
        fetchFn, platformHost: this.deps.platformHost,
        accessToken: currentCredential.accessToken, now: () => this.now(),
      });
      if (!isCurrent()) throw new Error("stale runtime selection");
      if (privateInventory.state === "available" && privateInventory.computers.some((computer) => computer.runtimeSlot === slot)) {
        privateLeaseExpiresAt = privateInventory.expiresAtBySlot[slot];
        if (privateLeaseExpiresAt === undefined || !Number.isFinite(privateLeaseExpiresAt)) {
          throw new Error("private computer admission unavailable");
        }
        expectedHandle = slot;
        onAdmission?.({ kind: "private", expiresAt: privateLeaseExpiresAt });
      } else {
        const customerHandle = privateInventory.state === "unauthorized" ? null : await fetchCanonicalCustomerHandle({
          fetchFn, platformHost: this.deps.platformHost, accessToken: currentCredential.accessToken, slot,
        });
        if (!isCurrent() || !customerHandle) throw new Error("private computer admission unavailable");
        expectedHandle = customerHandle;
        onAdmission?.({ kind: "customer" });
      }
    }
    if (!isCurrent()) throw new Error("stale runtime selection");
    const requestInit = (): RequestInit => ({
      method: "POST",
      headers: {
        authorization: `Bearer ${currentCredential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(RUNTIME_SELECTION_TIMEOUT_MS),
    });
    let response: Response;
    try {
      response = await fetchFn(endpoint.toString(), requestInit());
    } catch (err: unknown) {
      // The dedicated API hostname can be unreachable on networks where the
      // app hostname still works. Retry only transport failures: an HTTP
      // rejection must never cause credential exchange on another origin.
      if (!isCurrent() || this.deps.platformHost === this.deps.runtimeSelectionOrigin) throw err;
      const appEndpoint = new URL("/api/auth/runtime-selection", this.deps.platformHost);
      response = await fetchFn(appEndpoint.toString(), requestInit());
    }
    if (!response.ok) throw new Error("runtime selection rejected");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > RUNTIME_SELECTION_RESPONSE_LIMIT) {
      throw new Error("runtime selection response too large");
    }
    const text = await readBoundedResponseText(response);
    const replacement = RuntimeSelectionResponseSchema.parse(JSON.parse(text));
    if (privateLeaseExpiresAt !== undefined && privateLeaseExpiresAt <= this.now()) {
      throw new Error("private computer lease expired");
    }
    if (replacement.slot !== request.slot || (expectedHandle !== undefined && replacement.handle !== expectedHandle)) {
      throw new Error("runtime selection mismatch");
    }
    return {
      accessToken: replacement.accessToken,
      expiresAt: replacement.expiresAt,
      userId: currentCredential.userId,
      handle: replacement.handle,
    };
  }

  async selectRuntime(slot: string): Promise<void> {
    this.expireCredentialIfNeeded();
    const currentCredential = this.credential;
    const currentProfile = this.profile;
    if (!currentCredential || !currentProfile || currentCredential.userId !== currentProfile.userId) {
      throw new Error(RUNTIME_SELECTION_ERROR);
    }
    const nonce = ++this.flowNonce;
    let privateLeaseExpiresAt: number | undefined;
    const isCurrentSelection = () => (
      nonce === this.flowNonce
      && this.credential === currentCredential
      && this.profile === currentProfile
      && currentCredential.expiresAt > this.now() + EXPIRY_SKEW_MS
      && (privateLeaseExpiresAt === undefined || privateLeaseExpiresAt > this.now())
    );

    try {
      const nextCredential = await this.exchangeRuntimeCredential(currentCredential, slot, isCurrentSelection,
        (admission) => { privateLeaseExpiresAt = admission.kind === "private" ? admission.expiresAt : undefined; });
      if (!isCurrentSelection()) throw new Error("stale runtime selection");
      const nextProfile: ConnectionProfile = {
        ...currentProfile,
        handle: nextCredential.handle,
        runtimeSlot: slot,
      };
      await this.runPersistence(async () => {
        if (!isCurrentSelection()) throw new Error("stale runtime selection");
        await this.deps.credentialStore.save(nextCredential);
        if (!isCurrentSelection()) {
          await this.deps.credentialStore.save(currentCredential);
          throw new Error("stale runtime selection");
        }
        try {
          await this.deps.saveProfile(nextProfile);
          if (!isCurrentSelection()) {
            await this.deps.credentialStore.save(currentCredential);
            await this.deps.saveProfile(currentProfile);
            throw new Error("stale runtime selection");
          }
        } catch (err: unknown) {
          await this.deps.credentialStore.save(currentCredential).catch((rollbackErr: unknown) => {
            console.warn(
              "[auth] failed to restore credential after runtime switch:",
              rollbackErr instanceof Error ? rollbackErr.name : typeof rollbackErr,
            );
          });
          throw err;
        }
        this.replaceCredential(nextCredential);
        this.profile = nextProfile;
      });
    } catch (err: unknown) {
      console.warn(
        "[auth] runtime switch failed:",
        err instanceof Error ? err.name : typeof err,
      );
      throw new Error(RUNTIME_SELECTION_ERROR);
    }
  }

  async listRuntimeComputers(): Promise<MatrixComputerList> {
    this.expireCredentialIfNeeded();
    const currentCredential = this.credential;
    if (!currentCredential) throw new Error("Runtime computers unavailable");
    const currentProfile = this.profile;
    const nonce = this.flowNonce;
    const revision = ++this.inventoryRevision;
    const isCurrent = () => this.credential === currentCredential && this.profile === currentProfile
      && this.flowNonce === nonce && revision === this.inventoryRevision
      && currentCredential.expiresAt > this.now() + EXPIRY_SKEW_MS;

    const endpoint = new URL("/api/auth/computers", this.deps.platformHost);
    const fetchFn = this.deps.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
    try {
      const response = await fetchFn(endpoint.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${currentCredential.accessToken}` },
        signal: AbortSignal.timeout(RUNTIME_SELECTION_TIMEOUT_MS),
      });
      // A 401 means the token was revoked or rotated server-side before the
      // local expiry: drop the session so the renderer returns to sign-in
      // instead of retrying against a dead credential forever.
      if (response.status === 401 && isCurrent()) {
        await this.expireSession();
        throw new Error("computer inventory unauthorized");
      }
      if (!response.ok) throw new Error("computer inventory rejected");
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > RUNTIME_SELECTION_RESPONSE_LIMIT) {
        throw new Error("computer inventory response too large");
      }
      const text = await readBoundedResponseText(response);
      const canonical = MatrixComputerListSchema.parse(JSON.parse(text));
      if (!isCurrent()) throw new Error("stale computer inventory");
      const privateInventory = await fetchOwnerPrivateComputers({
        fetchFn, platformHost: this.deps.platformHost,
        accessToken: currentCredential.accessToken, now: () => this.now(),
      });
      if (!isCurrent()) throw new Error("stale computer inventory");
      if (privateInventory.state === "unauthorized") {
        await this.expireSession();
        throw new Error("computer inventory unauthorized");
      }
      return supplementPrivateComputers(canonical, privateInventory.computers,
        currentProfile?.userId === currentCredential.userId ? currentProfile.runtimeSlot : undefined);
    } catch (err: unknown) {
      console.warn(
        "[auth] computer inventory unavailable:",
        err instanceof Error ? err.name : typeof err,
      );
      throw new Error("Runtime computers unavailable");
    }
  }

  // The session token expired or the gateway rejected it (401). Drop the
  // credential but KEEP the profile so platformHost/runtime survive for a
  // one-click re-auth, then notify the renderer to show sign-in. Idempotent.
  async expireSession(): Promise<void> {
    if (!this.credential) return;
    this.flowNonce += 1;
    this.replaceCredential(null);
    this.flowState = "idle";
    try {
      await this.runPersistence(() => this.deps.credentialStore.clear());
    } catch (err: unknown) {
      console.warn(
        "[auth] failed to clear expired credential:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.deps.onAuthChanged(this.getStatus());
    }
  }

  async signOut(): Promise<void> {
    this.flowNonce += 1;
    this.pendingDeviceCode = null;
    this.replaceCredential(null);
    this.profile = null;
    this.flowState = "idle";
    this.deps.onAuthChanged(this.getStatus());

    let cleanupError: unknown = null;
    await this.runPersistence(async () => {
      try {
        await this.deps.credentialStore.clear();
      } catch (err: unknown) {
        cleanupError = err;
        console.warn(
          "[auth] failed to clear credential store:",
          err instanceof Error ? err.message : String(err),
        );
      }
      try {
        await this.deps.clearProfile();
      } catch (err: unknown) {
        cleanupError ??= err;
        console.warn(
          "[auth] failed to clear connection profile:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });
    if (cleanupError) throw cleanupError;
  }

  private async clearStaleFlowPersistence(): Promise<void> {
    try {
      await this.deps.credentialStore.clear();
    } catch (err: unknown) {
      console.warn(
        "[auth] failed to clear stale credential after canceled sign-in:",
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      await this.deps.clearProfile();
    } catch (err: unknown) {
      console.warn(
        "[auth] failed to clear stale profile after canceled sign-in:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private expireCredentialIfNeeded(): void {
    if (!this.isExpired()) return;
    this.flowNonce += 1;
    this.pendingDeviceCode = null;
    this.replaceCredential(null);
    this.flowState = "idle";
    this.deps.onAuthChanged(this.currentStatus());
    void this.runPersistence(() => this.deps.credentialStore.clear()).catch((err: unknown) => {
      console.warn(
        "[auth] failed to clear expired credential:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }
}
