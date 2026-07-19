"use client";

import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { useIsClient } from "@/hooks/useIsClient";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2Icon, LogOutIcon, ServerIcon, SettingsIcon, UserIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { useState } from "react";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { isSelfHostedDocument } from "@/lib/self-host-mode";
import {
  clearMatrixAppSession,
  clerkSignOutWithTimeout,
  getSignInRedirectUrl,
  isTimeoutError,
} from "@/lib/sign-out";

type UserButtonVariant = "dock" | "menubar" | "settings";

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

export function UserButton({
  variant = "dock",
  onOpenSettings,
}: {
  variant?: UserButtonVariant;
  onOpenSettings?: () => void;
}) {
  // SSR hydration guard: useIsClient is false on the server and during the first client render
  // (so the static Placeholder renders during SSR/first paint), then true on the client, so the
  // Clerk hooks -- which read browser-only auth state -- mount without a hydration
  // mismatch or a setState-in-effect cascade.
  const mounted = useIsClient();

  if (!mounted) {
    return <Placeholder variant={variant} />;
  }
  if (isSelfHostedDocument()) {
    return <SelfHostedUserButton variant={variant} onOpenSettings={onOpenSettings} />;
  }

  return <MountedUserButton variant={variant} onOpenSettings={onOpenSettings} />;
}

function SelfHostedUserButton({
  variant,
  onOpenSettings,
}: {
  variant: UserButtonVariant;
  onOpenSettings?: () => void;
}) {
  const isSettings = variant === "settings";
  const isMenubar = variant === "menubar";
  const label = "Self-hosted Matrix OS";
  const button = (
    <button
      type="button"
      aria-label={label}
      onClick={onOpenSettings}
      className={cn(
        "flex items-center justify-center rounded-xl border border-border/60 bg-card text-foreground shadow-sm transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isMenubar ? "size-[18px] rounded-full border-0 bg-transparent shadow-none" : "size-10",
        isSettings && "min-h-12 w-full justify-start gap-3 rounded-2xl px-2",
      )}
    >
      <span
        className={cn(
          "grid shrink-0 place-items-center rounded-full bg-emerald-600/12 text-emerald-700 dark:text-emerald-300",
          isMenubar ? "size-[18px]" : "size-10",
        )}
      >
        <ServerIcon className={cn("size-5", isMenubar && "size-3")} aria-hidden="true" />
      </span>
      {isSettings ? (
        <span className="min-w-0 truncate text-left text-sm font-semibold">
          Self-hosted
        </span>
      ) : null}
    </button>
  );

  if (isSettings) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={isMenubar ? "bottom" : "right"} sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function MountedUserButton({
  variant,
  onOpenSettings,
}: {
  variant: UserButtonVariant;
  onOpenSettings?: () => void;
}) {
  const { isLoaded, isSignedIn, signOut } = useAuth();
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
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const secondary = email && email !== displayName ? email : null;
  const isSettings = variant === "settings";
  const isMenubar = variant === "menubar";
  const itemClass =
    "flex cursor-default items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-foreground/[0.06] focus:bg-foreground/[0.06]";
  const dangerItemClass =
    "flex cursor-default items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive data-[disabled]:opacity-60";

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
          style={{ zIndex: SHELL_Z_INDEX.popover }}
          className="w-[272px] overflow-hidden rounded-[20px] border border-border/60 bg-popover p-2 text-popover-foreground shadow-[0_24px_70px_rgba(50,53,46,0.28)]"
        >
          <div className="flex items-center gap-3 rounded-2xl bg-foreground/[0.035] px-3 py-3">
            <span className="shrink-0 rounded-full ring-1 ring-black/[0.06]">
              <AccountAvatar avatarUrl={avatarUrl} displayName={displayName} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">{displayName}</p>
              {secondary ? (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{secondary}</p>
              ) : null}
            </div>
          </div>

          <div className="mt-1.5 flex flex-col gap-0.5">
            {onOpenSettings ? (
              <DropdownMenuPrimitive.Item
                className={itemClass}
                onSelect={() => {
                  onOpenSettings();
                }}
              >
                <SettingsIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                Settings
              </DropdownMenuPrimitive.Item>
            ) : null}
            <DropdownMenuPrimitive.Item
              className={itemClass}
              onSelect={() => {
                clerk.openUserProfile();
              }}
            >
              <UserIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Manage account
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item asChild>
              <Link className={itemClass} href="/runtime">
                <ServerIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                Switch computer
              </Link>
            </DropdownMenuPrimitive.Item>
          </div>

          <div className="mx-1 my-1.5 h-px bg-border/50" />

          <DropdownMenuPrimitive.Item
            className={dangerItemClass}
            aria-busy={signingOut}
            disabled={signingOut}
            onSelect={(event) => {
              event.preventDefault();
              void handleSignOut();
            }}
          >
            {signingOut ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogOutIcon className="size-4" aria-hidden="true" />
            )}
            {signingOut ? "Signing out…" : "Sign out"}
          </DropdownMenuPrimitive.Item>

          <p className="px-2.5 pb-0.5 pt-2 text-center text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/60">
            Secured by Clerk
          </p>
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
