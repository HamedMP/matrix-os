import { isExpired, loadProfileAuth } from "../../auth/token-store.js";
import { resolveCliProfile, type CliProfileFlags } from "../profiles.js";
import { normalizeTuiError } from "./errors.js";

export interface AccountProfileState {
  profileName: string;
  authenticated: boolean;
  expired?: boolean;
  handle?: string;
  gatewayUrl?: string;
  platformUrl?: string;
}

export interface AccountProfileAdapterDeps {
  flags?: CliProfileFlags;
  resolveProfile?: () => Promise<{ name: string; gatewayUrl: string; platformUrl: string; token?: string }>;
  loadAuth?: (profileName: string) => Promise<{ authenticated: boolean; expired: boolean; handle?: string }>;
}

export interface AccountProfileAdapter {
  load(): Promise<AccountProfileState>;
}

async function defaultAuth(profileName: string, token?: string): Promise<{ authenticated: boolean; expired: boolean; handle?: string }> {
  if (token) {
    return { authenticated: true, expired: false };
  }
  const auth = await loadProfileAuth(profileName);
  if (!auth) {
    return { authenticated: false, expired: false };
  }
  const expired = isExpired(auth);
  return { authenticated: !expired, expired };
}

export function createAccountProfileAdapter(deps: AccountProfileAdapterDeps = {}): AccountProfileAdapter {
  return {
    async load() {
      try {
        const profile = await (deps.resolveProfile ?? (() => resolveCliProfile(deps.flags ?? {})))();
        const auth = deps.loadAuth ? await deps.loadAuth(profile.name) : await defaultAuth(profile.name, profile.token);
        return {
          profileName: profile.name,
          authenticated: auth.authenticated,
          expired: auth.expired,
          handle: auth.handle,
          gatewayUrl: profile.gatewayUrl,
          platformUrl: profile.platformUrl,
        };
      } catch (error) {
        throw normalizeTuiError(error);
      }
    },
  };
}
