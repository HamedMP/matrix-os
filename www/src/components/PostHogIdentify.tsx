"use client";

import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { identifyPostHogUser, resetPostHogIdentity } from "@/lib/posthog-client";

// Aligns the client-side PostHog person with the Clerk user so marketing
// events join the same person as signup-funnel and runtime events.
export function PostHogIdentify() {
  const { isLoaded, isSignedIn, user } = useUser();

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && user) {
      identifyPostHogUser(user.id, {
        email: user.primaryEmailAddress?.emailAddress,
        username: user.username ?? undefined,
      });
      return;
    }
    resetPostHogIdentity();
  }, [isLoaded, isSignedIn, user]);

  return null;
}
