"use client";

import { SignIn, SignUp } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { normalizeSharedReturnPath } from "@/lib/shared-return-path";

const appearance = {
  theme: shadcn,
  elements: {
    rootBox: "w-full",
    cardBox: "w-full !shadow-none !border-0",
    card: "!bg-transparent",
  },
};

/**
 * Clerk sign-in/sign-up that completes inside the app shell. Only a validated
 * same-origin `/shared` destination survives authentication (spec 535 FR-002);
 * every other `redirect_url` returns to `/` as before.
 */
export function ShellClerkAuth({ mode, requestedReturn }: {
  mode: "sign-in" | "sign-up";
  requestedReturn: string | null;
}) {
  const browserOrigin = useBrowserOrigin();
  if (!browserOrigin) return null;
  const destination = normalizeSharedReturnPath(requestedReturn, browserOrigin);
  if (mode === "sign-up") {
    return (
      <SignUp
        forceRedirectUrl={destination}
        fallbackRedirectUrl={destination}
        signInForceRedirectUrl={destination}
        appearance={appearance}
      />
    );
  }
  return (
    <SignIn
      forceRedirectUrl={destination}
      fallbackRedirectUrl={destination}
      signUpForceRedirectUrl={destination}
      appearance={appearance}
    />
  );
}
