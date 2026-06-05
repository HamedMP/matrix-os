"use client";

import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { useIsClient } from "@/hooks/useIsClient";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LogOutIcon, ServerIcon, SettingsIcon, UserIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { useState } from "react";

const SIGN_OUT_TIMEOUT_MS = 10_000;

type UserButtonVariant = "dock" | "menubar" | "settings";

function getSignInRedirectUrl(): string {
  const configured = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? "/sign-in";
  return new URL(configured, window.location.origin).toString();
}

async function clearMatrixAppSession(): Promise<void> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), SIGN_OUT_TIMEOUT_MS);
  try {
    const response = await fetch("/api/auth/app-session", {
      method: "DELETE",
      credentials: "include",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("[auth] Matrix app session clear returned non-OK status", response.status);
    }
  } catch (error: unknown) {
    console.warn("[auth] Matrix app session clear failed", error instanceof Error ? error.name : typeof error);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function clerkSignOutWithTimeout(
  signOut: (options: { redirectUrl: string }) => Promise<unknown> | unknown,
  redirectUrl: string,
): Promise<void> {
  let timeoutId: number | undefined;
  try {
    await Promise.race([
      Promise.resolve(signOut({ redirectUrl })),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          const error = new Error("Clerk sign-out timed out");
          error.name = "TimeoutError";
          reject(error);
        }, SIGN_OUT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function Placeholder({ variant = "dock" }: { variant?: UserButtonVariant }) {
  const isSettings = variant === "settings";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "flex items-center justify-center rounded-xl border border-border/60 bg-card shadow-sm",
            variant === "menubar" ? "size-[18px] rounded-full border-0 shadow-none" : "size-10",
            isSettings && "min-h-12 w-full justify-start gap-3 rounded-2xl px-2",
          )}
        >
          <UserIcon className={cn("size-4", variant === "menubar" && "size-[14px]")} />
          {isSettings ? (
            <span className="min-w-0 truncate text-sm font-semibold text-foreground">Account</span>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        Sign in
      </TooltipContent>
    </Tooltip>
  );
}

export function UserButton({ variant = "dock" }: { variant?: UserButtonVariant }) {
  // SSR hydration guard: useIsClient is false on the server and during the first client render
  // (so the static Placeholder renders during SSR/first paint), then true on the client, so the
  // Clerk hooks -- which read browser-only auth state -- mount without a hydration
  // mismatch or a setState-in-effect cascade.
  const mounted = useIsClient();

  if (!mounted) {
    return <Placeholder variant={variant} />;
  }

  return <MountedUserButton variant={variant} />;
}

function MountedUserButton({ variant }: { variant: UserButtonVariant }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const [signingOut, setSigningOut] = useState(false);

  if (!isLoaded || !isSignedIn) {
    return <Placeholder variant={variant} />;
  }

  const displayName =
    user?.fullName ??
    user?.username ??
    user?.primaryEmailAddress?.emailAddress ??
    "Account";
  const avatarUrl = user?.imageUrl || null;
  const isSettings = variant === "settings";
  const isMenubar = variant === "menubar";

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    const redirectUrl = getSignInRedirectUrl();
    await clearMatrixAppSession();
    try {
      await clerkSignOutWithTimeout(clerk.signOut, redirectUrl);
    } catch (error: unknown) {
      setSigningOut(false);
      if (isTimeoutError(error)) {
        console.warn("[auth] Clerk sign-out timed out");
        return;
      }
      console.error("[auth] Clerk sign-out failed", error instanceof Error ? error.name : typeof error);
      window.location.replace(redirectUrl);
    }
  }

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${displayName}`}
          className={cn(
            "flex items-center justify-center rounded-xl border border-border/60 bg-card text-foreground shadow-sm transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isMenubar ? "size-[18px] rounded-full border-0 bg-transparent shadow-none" : "size-10",
            isSettings && "min-h-12 w-full justify-start gap-3 rounded-2xl px-2",
          )}
        >
          <AccountAvatar
            avatarUrl={avatarUrl}
            displayName={displayName}
            compact={isMenubar}
          />
          {isSettings ? (
            <span className="min-w-0 truncate text-left text-sm font-semibold">
              {displayName}
            </span>
          ) : null}
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={isMenubar ? "end" : "start"}
          side={isMenubar ? "bottom" : "top"}
          sideOffset={10}
          className="z-50 w-[280px] overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-2xl"
        >
          <div className="flex items-center gap-3 border-b border-border/60 px-4 py-4">
            <AccountAvatar avatarUrl={avatarUrl} displayName={displayName} />
            <span className="min-w-0 truncate text-sm font-semibold">{displayName}</span>
          </div>
          <DropdownMenuPrimitive.Item
            className="flex cursor-default items-center gap-3 px-4 py-3 text-sm font-medium outline-none transition-colors hover:bg-muted/70 focus:bg-muted/70"
            onSelect={() => {
              clerk.openUserProfile();
            }}
          >
            <SettingsIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Manage account
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item asChild>
            <Link
              className="flex cursor-default items-center gap-3 border-t border-border/60 px-4 py-3 text-sm font-medium outline-none transition-colors hover:bg-muted/70 focus:bg-muted/70"
              href="/runtime"
            >
              <ServerIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Switch computer
            </Link>
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            className="flex cursor-default items-center gap-3 border-t border-border/60 px-4 py-3 text-sm font-medium outline-none transition-colors hover:bg-muted/70 focus:bg-muted/70"
            disabled={signingOut}
            onSelect={(event) => {
              event.preventDefault();
              void handleSignOut();
            }}
          >
            <LogOutIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            {signingOut ? "Signing out..." : "Sign out"}
          </DropdownMenuPrimitive.Item>
          <div className="border-t border-border/60 px-4 py-3 text-center text-xs font-semibold text-muted-foreground">
            Secured by Clerk
          </div>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function AccountAvatar({
  avatarUrl,
  displayName,
  compact = false,
}: {
  avatarUrl: string | null;
  displayName: string;
  compact?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#4b3b86] text-white",
        compact ? "size-[18px]" : "size-10",
      )}
    >
      {avatarUrl ? (
        <Image
          src={avatarUrl}
          alt=""
          width={compact ? 18 : 40}
          height={compact ? 18 : 40}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          unoptimized
        />
      ) : (
        <UserIcon className={cn("size-5", compact && "size-3")} aria-hidden="true" />
      )}
      <span className="sr-only">{displayName}</span>
    </span>
  );
}
