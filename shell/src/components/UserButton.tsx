"use client";

import { UserButton as ClerkUserButton, useAuth } from "@clerk/nextjs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserIcon } from "lucide-react";

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
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) {
    return <Placeholder />;
  }

  return (
    <ClerkUserButton
      appearance={{
        elements: {
          avatarBox: "size-10 rounded-xl",
          userButtonTrigger: "rounded-xl shadow-sm border border-border/60",
        },
      }}
      afterSignOutUrl="https://matrix-os.com/login"
    />
  );
}
