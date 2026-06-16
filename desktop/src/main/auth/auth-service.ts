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
}

export interface AuthStatus {
  signedIn: boolean;
  handle?: string;
  runtimeSlot: string;
  platformHost: string;
}

export type PollResult = {
  status: "pending" | "authorized" | "expired";
  profile?: { handle: string; userId: string };
};

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface AuthServiceDeps {
  credentialStore: CredentialStore;
  platformHost: string;
  fetchFn?: FetchFn;
  openExternal: (url: string) => Promise<void>;
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
    if (this.credential && !this.isCredentialValid(this.credential)) {
      this.credential = null;
      this.profile = null;
      try {
        await this.deps.credentialStore.clear();
      } catch (err: unknown) {
        console.warn(
          "[auth] failed to clear expired credential:",
          err instanceof Error ? err.message : String(err),
        );
      }
      try {
        await this.deps.clearProfile();
      } catch (err: unknown) {
        console.warn(
          "[auth] failed to clear expired profile:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
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
    const signedIn = this.credential !== null && this.isCredentialValid(this.credential);
    return {
      signedIn,
      ...(signedIn && this.profile ? { handle: this.profile.handle } : {}),
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
    this.pendingDeviceCode = {
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresIn: code.expiresIn,
    };

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
        const profile = {
          handle: token.handle,
          userId: token.userId,
          platformHost: baseUrl,
          runtimeSlot: this.profile?.runtimeSlot ?? "primary",
        };
        this.credential = token;
        this.profile = profile;
        try {
          await this.deps.credentialStore.save(token);
        } catch (err: unknown) {
          console.warn(
            "[auth] failed to persist credential:",
            err instanceof Error ? err.message : String(err),
          );
        }
        try {
          await this.deps.saveProfile(profile);
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

    void this.deps.openExternal(code.verificationUri).catch((err: unknown) => {
      console.warn(
        "[auth] failed to open verification url:",
        err instanceof Error ? err.message : String(err),
      );
    });

    return this.pendingDeviceCode;
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
    if (!this.profile) return;
    this.profile = { ...this.profile, runtimeSlot: slot };
    await this.deps.saveProfile(this.profile);
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

  private isCredentialValid(credential: StoredCredential): boolean {
    return credential.expiresAt > Date.now();
  }

  private expireCredentialIfNeeded(): void {
    if (!this.credential || this.isCredentialValid(this.credential)) return;
    this.flowNonce += 1;
    this.pendingDeviceCode = null;
    this.credential = null;
    this.profile = null;
    this.flowState = "idle";
    this.deps.onAuthChanged(this.currentStatus());
    void this.deps.credentialStore.clear().catch((err: unknown) => {
      console.warn(
        "[auth] failed to clear expired credential:",
        err instanceof Error ? err.message : String(err),
      );
    });
    void this.deps.clearProfile().catch((err: unknown) => {
      console.warn(
        "[auth] failed to clear expired profile:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }
}
