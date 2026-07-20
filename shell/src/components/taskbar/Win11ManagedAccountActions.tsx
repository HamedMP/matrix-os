"use client";

import { useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { Loader2Icon, LogOutIcon, UserIcon } from "lucide-react";
import {
  clearMatrixAppSession,
  clerkSignOutWithTimeout,
  getSignInRedirectUrl,
  isTimeoutError,
} from "@/lib/sign-out";

export function Win11ManagedAccountActions({ onClose }: { onClose: () => void }) {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const clerk = useClerk();
  const [signingOut, setSigningOut] = useState(false);

  if (!isLoaded || !isSignedIn) return null;

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    const redirectUrl = getSignInRedirectUrl();
    await clearMatrixAppSession();
    try {
      await clerkSignOutWithTimeout(signOut, redirectUrl);
      window.location.replace(redirectUrl);
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        console.warn("[auth] Clerk sign-out timed out");
      } else {
        console.error("[auth] Clerk sign-out failed", error instanceof Error ? error.name : typeof error);
      }
      window.location.replace(redirectUrl);
    }
  }

  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="win11-power-flyout-item"
        onClick={() => {
          onClose();
          clerk.openUserProfile();
        }}
      >
        <UserIcon aria-hidden="true" />
        <span>Manage account</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="win11-power-flyout-item"
        disabled={signingOut}
        aria-busy={signingOut}
        onClick={() => void handleSignOut()}
      >
        {signingOut ? (
          <Loader2Icon className="win11-spin" aria-hidden="true" />
        ) : (
          <LogOutIcon aria-hidden="true" />
        )}
        <span>{signingOut ? "Signing out…" : "Sign out"}</span>
      </button>
    </>
  );
}
