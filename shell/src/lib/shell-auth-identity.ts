"use client";

import { useAuth } from "@clerk/nextjs";
import { isSelfHostedRuntime, SELF_HOSTED_SHELL_USER_ID } from "./self-host-mode";

/** The account identity a shell surface keys its requests and caches by. */
export interface ShellAuthIdentity {
  isLoaded: boolean;
  userId: string | null;
  sessionId: string | null;
  getToken(): Promise<string | null>;
}

const SELF_HOSTED_IDENTITY: ShellAuthIdentity = {
  isLoaded: true,
  userId: SELF_HOSTED_SHELL_USER_ID,
  sessionId: null,
  // Self-hosted gateways authenticate the same-origin request, not a Clerk token.
  getToken: async () => null,
};

function useSelfHostedShellAuthIdentity(): ShellAuthIdentity {
  return SELF_HOSTED_IDENTITY;
}

function useClerkShellAuthIdentity(): ShellAuthIdentity {
  const { isLoaded, userId, sessionId, getToken } = useAuth();
  return { isLoaded, userId: userId ?? null, sessionId: sessionId ?? null, getToken };
}

/**
 * Self-hosted documents render without ClerkProvider, so Clerk's useAuth must
 * never run there. The mode is fixed for the document's lifetime (the server
 * reads MATRIX_SELF_HOSTED, the client the data-matrix-self-hosted attribute the
 * root layout renders before any script), so the implementation is chosen once
 * at module load and every render calls the same hook.
 */
export const useShellAuthIdentity: () => ShellAuthIdentity = isSelfHostedRuntime()
  ? useSelfHostedShellAuthIdentity
  : useClerkShellAuthIdentity;
