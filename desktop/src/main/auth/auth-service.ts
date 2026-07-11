import {
  RuntimeSelectionRequestSchema,
  RuntimeSelectionResponseSchema,
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

export interface ConnectionProfile {
  handle: string;
  userId: string;
  platformHost: string;
  runtimeSlot: string;
  displayName?: string;
  imageUrl?: string;
  email?: string;
}

export interface AuthStatus {
  signedIn: boolean;
  handle?: string;
  runtimeSlot: string;
  platformHost: string;
  displayName?: string;
  imageUrl?: string;
}

export type PollResult = {
  status: "pending" | "authorized" | "expired";
  profile?: { handle: string; userId: string };
};

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
  private profile: ConnectionProfile | null = null;
  private flowState: "idle" | "pending" | "authorized" | "expired" = "idle";
  private flowNonce = 0;
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
    return this.profile?.platformHost ?? this.deps.platformHost;
  }

  getStatus(): AuthStatus {
    this.expireCredentialIfNeeded();
    return this.currentStatus();
  }

  private currentStatus(): AuthStatus {
    const signedIn = this.credential !== null && !this.isExpired();
    return {
      signedIn,
      ...(signedIn && this.profile ? { handle: this.profile.handle } : {}),
      ...(signedIn && this.profile?.displayName ? { displayName: this.profile.displayName } : {}),
      ...(signedIn && this.profile?.imageUrl ? { imageUrl: this.profile.imageUrl } : {}),
      runtimeSlot: this.profile?.runtimeSlot ?? "primary",
      platformHost: this.getGatewayOrigin(),
    };
  }

  async startDeviceFlow(): Promise<Pick<DeviceCodeResponse, "userCode" | "verificationUri" | "expiresIn">> {
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
    const pendingDeviceCode = {
      userCode: code.userCode,
      verificationUri: code.verificationUri,
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
        const credential: StoredCredential = {
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
          userId: token.userId,
          handle: token.handle,
        };
        this.credential = credential;
        const profile: ConnectionProfile = {
          handle: token.handle,
          userId: token.userId,
          platformHost: baseUrl,
          runtimeSlot: this.profile?.runtimeSlot ?? "primary",
          ...(token.displayName ? { displayName: token.displayName } : {}),
          ...(token.imageUrl ? { imageUrl: token.imageUrl } : {}),
          ...(token.email ? { email: token.email } : {}),
        };
        this.profile = profile;
        try {
          if (nonce !== this.flowNonce) return;
          await this.deps.credentialStore.save(credential);
          if (nonce !== this.flowNonce) {
            await this.clearStaleFlowPersistence();
            return;
          }
        } catch (err: unknown) {
          console.warn(
            "[auth] failed to persist credential:",
            err instanceof Error ? err.message : String(err),
          );
        }
        try {
          if (nonce !== this.flowNonce) {
            await this.clearStaleFlowPersistence();
            return;
          }
          await this.deps.saveProfile(profile);
          if (nonce !== this.flowNonce) {
            await this.clearStaleFlowPersistence();
            return;
          }
        } catch (err: unknown) {
          console.warn(
            "[auth] failed to persist profile:",
            err instanceof Error ? err.message : String(err),
          );
        }
        if (nonce !== this.flowNonce) return;
        this.flowState = "authorized";
        this.pendingDeviceCode = null;
        this.deps.onAuthChanged(this.getStatus());
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

  async selectRuntime(slot: string): Promise<void> {
    this.expireCredentialIfNeeded();
    const currentCredential = this.credential;
    const currentProfile = this.profile;
    if (!currentCredential || !currentProfile) {
      throw new Error(RUNTIME_SELECTION_ERROR);
    }

    try {
      const request = RuntimeSelectionRequestSchema.parse({ slot });
      const endpoint = new URL("/api/auth/runtime-selection", this.deps.runtimeSelectionOrigin);
      const fetchFn = this.deps.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
      const response = await fetchFn(endpoint.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${currentCredential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(RUNTIME_SELECTION_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("runtime selection rejected");
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > RUNTIME_SELECTION_RESPONSE_LIMIT) {
        throw new Error("runtime selection response too large");
      }
      const text = await readBoundedResponseText(response);
      const replacement = RuntimeSelectionResponseSchema.parse(JSON.parse(text));
      if (replacement.slot !== request.slot) throw new Error("runtime selection mismatch");

      const nextCredential: StoredCredential = {
        accessToken: replacement.accessToken,
        expiresAt: replacement.expiresAt,
        userId: currentCredential.userId,
        handle: replacement.handle,
      };
      const nextProfile: ConnectionProfile = {
        ...currentProfile,
        handle: replacement.handle,
        runtimeSlot: replacement.slot,
      };
      await this.deps.credentialStore.save(nextCredential);
      try {
        await this.deps.saveProfile(nextProfile);
      } catch (err: unknown) {
        await this.deps.credentialStore.save(currentCredential).catch((rollbackErr: unknown) => {
          console.warn(
            "[auth] failed to restore credential after runtime switch:",
            rollbackErr instanceof Error ? rollbackErr.name : typeof rollbackErr,
          );
        });
        throw err;
      }
      this.credential = nextCredential;
      this.profile = nextProfile;
    } catch (err: unknown) {
      console.warn(
        "[auth] runtime switch failed:",
        err instanceof Error ? err.name : typeof err,
      );
      throw new Error(RUNTIME_SELECTION_ERROR);
    }
  }

  // The session token expired or the gateway rejected it (401). Drop the
  // credential but KEEP the profile so platformHost/runtime survive for a
  // one-click re-auth, then notify the renderer to show sign-in. Idempotent.
  async expireSession(): Promise<void> {
    if (!this.credential) return;
    this.credential = null;
    this.flowState = "idle";
    try {
      await this.deps.credentialStore.clear();
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
    this.credential = null;
    this.profile = null;
    this.flowState = "idle";
    this.deps.onAuthChanged(this.getStatus());

    let cleanupError: unknown = null;
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
    this.credential = null;
    this.flowState = "idle";
    this.deps.onAuthChanged(this.currentStatus());
    void this.deps.credentialStore.clear().catch((err: unknown) => {
      console.warn(
        "[auth] failed to clear expired credential:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }
}
