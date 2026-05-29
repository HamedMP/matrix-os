import { isExpired, loadProfileAuth } from "../../auth/token-store.js";
import { resolveCliProfile, type CliProfileFlags } from "../profiles.js";
import { createShellClient } from "../shell-client.js";
import { createTuiGatewayClient } from "./gateway-client.js";
import { getTuiDaemonStatus } from "./daemon-client.js";
import { normalizeTuiError, type TuiSafeError } from "./errors.js";

export type TuiHealthState = "healthy" | "degraded" | "offline" | "unknown" | "unauthenticated";
export type TuiOverallState = "healthy" | "degraded" | "unauthenticated" | "blocked";

export interface TuiProfileStatus {
  name: string;
  gatewayUrl: string;
  platformUrl: string;
  state: TuiHealthState;
}

export interface TuiAuthStatus {
  state: "authenticated" | "unauthenticated" | "expired" | "unknown";
  handle?: string;
}

export interface TuiSubsystemStatus {
  state: TuiHealthState;
  label: string;
}

export interface TuiSessionSummary {
  state: TuiHealthState;
  count: number;
}

export interface TuiStatusSnapshot {
  overall: TuiOverallState;
  profile: TuiProfileStatus;
  auth: TuiAuthStatus;
  gateway: TuiSubsystemStatus;
  daemon: TuiSubsystemStatus;
  sync: TuiSubsystemStatus;
  sessions: TuiSessionSummary;
  blockingActions: string[];
  refreshedAt: string;
  safeError?: TuiSafeError;
}

export interface TuiStatusDeps {
  flags?: CliProfileFlags;
  now?: () => Date;
  resolveProfile?: () => Promise<{ name: string; gatewayUrl: string; platformUrl: string; token?: string }>;
  loadAuth?: (profileName: string) => Promise<{ authenticated: boolean; expired: boolean; handle?: string }>;
  checkGateway?: () => Promise<TuiSubsystemStatus>;
  checkDaemon?: () => Promise<TuiSubsystemStatus>;
  listShellSessions?: () => Promise<unknown[]>;
}

const unknownProfile: TuiProfileStatus = {
  name: "unknown",
  gatewayUrl: "unknown",
  platformUrl: "unknown",
  state: "unknown",
};

function overallFromParts(auth: TuiAuthStatus, parts: TuiSubsystemStatus[], sessions: TuiSessionSummary): TuiOverallState {
  if (auth.state === "unauthenticated" || auth.state === "expired") {
    return "unauthenticated";
  }
  if (auth.state === "unknown") {
    return "blocked";
  }
  if (parts.some((part) => part.state === "degraded" || part.state === "offline" || part.state === "unknown") || sessions.state === "degraded") {
    return "degraded";
  }
  return "healthy";
}

async function defaultResolveProfile(flags: CliProfileFlags = {}) {
  return resolveCliProfile(flags);
}

async function defaultLoadAuth(profileName: string, token?: string): Promise<TuiAuthStatus> {
  if (token) {
    return { state: "authenticated" };
  }
  const auth = await loadProfileAuth(profileName);
  if (!auth) {
    return { state: "unauthenticated" };
  }
  return isExpired(auth) ? { state: "expired" } : { state: "authenticated" };
}

export async function aggregateTuiStatusSnapshot(deps: TuiStatusDeps = {}): Promise<TuiStatusSnapshot> {
  const now = deps.now ?? (() => new Date());
  let profile = unknownProfile;
  let token: string | undefined;
  let auth: TuiAuthStatus = { state: "unknown" };
  let safeError: TuiSafeError | undefined;
  const recordSafeError = (error: unknown) => {
    safeError ??= normalizeTuiError(error);
  };

  try {
    const resolved = await (deps.resolveProfile ?? (() => defaultResolveProfile(deps.flags)))();
    profile = {
      name: resolved.name,
      gatewayUrl: resolved.gatewayUrl,
      platformUrl: resolved.platformUrl,
      state: "healthy",
    };
    token = resolved.token;
  } catch (error) {
    recordSafeError(error);
  }

  try {
    if (deps.loadAuth) {
      const loaded = await deps.loadAuth(profile.name);
      auth = loaded.expired
        ? { state: "expired", handle: loaded.handle }
        : { state: loaded.authenticated ? "authenticated" : "unauthenticated", handle: loaded.handle };
    } else if (profile.name !== "unknown") {
      auth = await defaultLoadAuth(profile.name, token);
    }
  } catch (error) {
    recordSafeError(error);
    auth = { state: "unknown" };
  }

  const checkGatewayStatus = async (): Promise<TuiSubsystemStatus> => deps.checkGateway
    ? deps.checkGateway()
    : profile.gatewayUrl !== "unknown"
      ? createTuiGatewayClient({ gatewayUrl: profile.gatewayUrl, token }).requestJson("/health").then(() => ({ state: "healthy", label: "ok" }))
      : { state: "unknown", label: "gateway unknown" };

  const checkDaemonStatus = async (): Promise<TuiSubsystemStatus> => deps.checkDaemon
    ? deps.checkDaemon()
    : getTuiDaemonStatus().then((status) => ({
      state: status.state === "running" ? "healthy" : status.state === "stopped" ? "offline" : "degraded",
      label: status.state,
    }));

  const listSessions = async (): Promise<TuiSessionSummary> => {
    const rows = deps.listShellSessions
      ? await deps.listShellSessions()
      : token && profile.gatewayUrl !== "unknown"
        ? await createShellClient({ gatewayUrl: profile.gatewayUrl, token }).listSessions()
        : [];
    return { state: "healthy", count: rows.length };
  };

  const [gatewayResult, daemonResult, sessionsResult] = await Promise.allSettled([
    checkGatewayStatus(),
    checkDaemonStatus(),
    listSessions(),
  ]);

  let gateway: TuiSubsystemStatus = { state: "unknown", label: "gateway unknown" };
  if (gatewayResult.status === "fulfilled") {
    gateway = gatewayResult.value;
  } else {
    recordSafeError(gatewayResult.reason);
    gateway = { state: "degraded", label: "gateway degraded" };
  }

  let daemon: TuiSubsystemStatus = { state: "unknown", label: "daemon unknown" };
  if (daemonResult.status === "fulfilled") {
    daemon = daemonResult.value;
  } else {
    recordSafeError(daemonResult.reason);
    daemon = { state: "degraded", label: "daemon degraded" };
  }

  let sessions: TuiSessionSummary = { state: "unknown", count: 0 };
  if (sessionsResult.status === "fulfilled") {
    sessions = sessionsResult.value;
  } else {
    recordSafeError(sessionsResult.reason);
    sessions = { state: "degraded", count: 0 };
  }

  const sync: TuiSubsystemStatus = { state: daemon.state, label: daemon.state === "healthy" ? "sync ready" : "sync unknown" };
  const blockingActions = auth.state === "unauthenticated" || auth.state === "expired"
    ? ["login"]
    : profile.state === "unknown"
      ? ["profile"]
      : auth.state === "unknown"
        ? ["login"]
        : [];
  const parts = [gateway, daemon, sync];

  return {
    overall: overallFromParts(auth, parts, sessions),
    profile,
    auth,
    gateway,
    daemon,
    sync,
    sessions,
    blockingActions,
    refreshedAt: now().toISOString(),
    ...(safeError ? { safeError } : {}),
  };
}
