import { isExpired, loadProfileAuth, type AuthData } from "../auth/token-store.js";
import type { ResolvedCliProfile } from "./profiles.js";

export type CliAuthStatus =
  | { status: "authenticated"; token: string; auth: AuthData | null }
  | { status: "expired"; auth: AuthData }
  | { status: "missing"; auth: null };

export function notAuthenticatedMessage(profileName: string): string {
  return `Not logged in for profile "${profileName}". Run \`mos login\` first.`;
}

export function authExpiredMessage(profileName: string, expiresAt: number): string {
  return `Auth for profile "${profileName}" expired on ${new Date(expiresAt).toISOString()}. Run \`mos login --profile ${profileName}\` to refresh.`;
}

export function createNotAuthenticatedError(profileName: string): Error {
  return Object.assign(new Error(notAuthenticatedMessage(profileName)), {
    code: "not_authenticated",
  });
}

export function createAuthExpiredError(profileName: string, expiresAt: number): Error {
  return Object.assign(new Error(authExpiredMessage(profileName, expiresAt)), {
    code: "auth_expired",
  });
}

export async function resolveCliAuthStatus(profile: ResolvedCliProfile): Promise<CliAuthStatus> {
  if (profile.token) {
    return { status: "authenticated", token: profile.token, auth: null };
  }
  const auth = await loadProfileAuth(profile.name);
  if (!auth) {
    return { status: "missing", auth: null };
  }
  if (isExpired(auth)) {
    return { status: "expired", auth };
  }
  return { status: "authenticated", token: auth.accessToken, auth };
}

export async function requireCliAuthToken(profile: ResolvedCliProfile): Promise<string> {
  const authStatus = await resolveCliAuthStatus(profile);
  if (authStatus.status === "authenticated") {
    return authStatus.token;
  }
  if (authStatus.status === "expired") {
    throw createAuthExpiredError(profile.name, authStatus.auth.expiresAt);
  }
  throw createNotAuthenticatedError(profile.name);
}
