"use client";

import { useEffect, useState } from "react";
import { UserButton as ClerkUserButton, useAuth } from "@clerk/nextjs";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CreditCardIcon, ServerIcon, UserIcon } from "lucide-react";

function Placeholder() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex size-10 items-center justify-center rounded-xl border border-border/60 bg-card shadow-sm">
          <UserIcon className="size-4" />
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        Sign in
      </TooltipContent>
    </Tooltip>
  );
}

export function UserButton() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-initialize-state -- intentional SSR hydration guard: `mounted` must be false on the server and flip to true only after mount so the Clerk <UserButton> (which reads browser-only auth state) renders the static Placeholder during SSR/first paint and avoids a hydration mismatch. A lazy initializer cannot express "false on server, true on client".
    setMounted(true);
  }, []);

  if (!mounted) {
    return <Placeholder />;
  }

  return <MountedUserButton />;
}

function MountedUserButton() {
  const { isLoaded, isSignedIn } = useAuth();
  const { active: billingActive } = useMatrixBillingAccess();

  if (!isLoaded || !isSignedIn) {
    return <Placeholder />;
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <ClerkUserButton
        appearance={{
          elements: {
            avatarBox: "size-10 rounded-xl",
            userButtonTrigger: "rounded-xl shadow-sm border border-border/60",
          },
        }}
        afterSignOutUrl="https://app.matrix-os.com/sign-in"
      >
        <ClerkUserButton.MenuItems>
          <ClerkUserButton.Link
            label="Switch computer"
            labelIcon={<ServerIcon className="size-4" aria-hidden="true" />}
            href="/runtime"
          />
        </ClerkUserButton.MenuItems>
      </ClerkUserButton>
      <div
        className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
          billingActive === true
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        }`}
      >
        <CreditCardIcon className="size-3" aria-hidden="true" />
        {billingActive === true ? "Active" : "Billing"}
      </div>
    </div>
  );
}
