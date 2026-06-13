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
  loadProfile: () => Promise<ConnectionProfile | null>;
  saveProfile: (profile: ConnectionProfile) => Promise<void>;
  clearProfile: () => Promise<void>;
  onAuthChanged: (status: AuthStatus) => void;
}

export class AuthService {
  private credential: StoredCredential | null = null;
  private profile: ConnectionProfile | null = null;
  private flowState: "idle" | "pending" | "authorized" | "expired" = "idle";
  private readonly deps: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  async init(): Promise<void> {
    this.credential = await this.deps.credentialStore.load();
    this.profile = await this.deps.loadProfile();
  }

  getToken(): string | null {
    return this.credential?.accessToken ?? null;
  }

  getGatewayOrigin(): string {
    return this.profile?.platformHost ?? this.deps.platformHost;
  }

  getStatus(): AuthStatus {
    const signedIn = this.credential !== null;
    return {
      signedIn,
      ...(signedIn && this.profile ? { handle: this.profile.handle } : {}),
      runtimeSlot: this.profile?.runtimeSlot ?? "primary",
      platformHost: this.getGatewayOrigin(),
    };
  }

  async startDeviceFlow(): Promise<Pick<DeviceCodeResponse, "userCode" | "verificationUri" | "expiresIn">> {
    const fetchFn = this.deps.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
    const baseUrl = this.getGatewayOrigin();
    const code = await requestDeviceCode({ fetchFn, baseUrl });
    this.flowState = "pending";

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
        this.credential = token;
        this.profile = {
          handle: token.handle,
          userId: token.userId,
          platformHost: baseUrl,
          runtimeSlot: this.profile?.runtimeSlot ?? "primary",
        };
        await this.deps.credentialStore.save(token);
        await this.deps.saveProfile(this.profile);
        this.flowState = "authorized";
        this.deps.onAuthChanged(this.getStatus());
      })
      .catch((err: unknown) => {
        if (err instanceof DeviceFlowError) {
          this.flowState = "expired";
          return;
        }
        console.warn(
          "[auth] device flow failed:",
          err instanceof Error ? err.message : String(err),
        );
        this.flowState = "expired";
      });

    // Do NOT auto-open the browser. The renderer shows the user code and an
    // explicit "Open approval page" button (shell:open-external) — auto-opening
    // popped a surprise tab on every launch (and on every e2e run, which points
    // at a stub whose verification URL is unroutable).
    return {
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresIn: code.expiresIn,
    };
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
    this.credential = null;
    this.profile = null;
    this.flowState = "idle";
    await this.deps.credentialStore.clear();
    await this.deps.clearProfile();
    this.deps.onAuthChanged(this.getStatus());
  }
}
