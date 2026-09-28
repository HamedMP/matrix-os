"use client";

import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { cardShadow, lightFg, palette } from "@matrix-os/brand";
import {
  ChatCollaboration,
  type ChatCollaborationView,
  type CollaborationApi,
  type CollaborationDirectApi,
} from "@matrix-os/ui";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi } from "@/lib/collaboration";
import { LogOutIcon, ServerIcon, UserIcon, UsersIcon } from "@/lib/hugeicons";
import { platformShellAssetPath } from "@/lib/platform-shell-assets";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  clearMatrixAppSession,
  clerkSignOutWithTimeout,
  getSignInRedirectUrl,
  isTimeoutError,
} from "@/lib/sign-out";

interface CollaborationFrameAccount {
  userId: string;
  displayName: string;
  secondary: string | null;
}

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";
const E2E_ACCOUNT: CollaborationFrameAccount = { userId: "user_e2e", displayName: "E2E User", secondary: null };
const COLLABORATION_LAYERS = { dialog: SHELL_Z_INDEX.appDialog, popover: SHELL_Z_INDEX.popover };
const SHARED_HOME = "/shared";

const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

// packages/ui collaboration views read these OS theme variables. The frame
// mounts no OS theme provider, so it supplies brand values directly.
const FRAME_THEME = {
  "--text-primary": palette.deep,
  "--text-secondary": palette.mutedFg,
  "--text-tertiary": palette.subtle,
  "--bg-surface": palette.card,
  "--bg-hover": tint(palette.forest, 7),
  "--border-default": palette.border,
  "--background": palette.pageBg,
  "--matrix-card": palette.card,
  "--matrix-card-fg": palette.deep,
  "--matrix-border": palette.border,
} as CSSProperties;

const menuItemClass =
  "flex w-full cursor-default items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm outline-none transition-colors data-[highlighted]:bg-forest/[0.06] data-[disabled]:opacity-50";

function BrandLockup() {
  return (
    <Link href={SHARED_HOME} aria-label="Matrix OS, Shared with me" className="inline-flex shrink-0 items-center gap-2.5 text-forest no-underline">
      <Image
        src={platformShellAssetPath("/matrix-logo.svg")}
        alt=""
        width={18}
        height={24}
        unoptimized
        className="h-6 w-[18px] shrink-0"
      />
      <span
        className="text-[13px] font-semibold leading-none tracking-[0.16em]"
        style={{ color: palette.deep, fontFamily: "var(--font-orbitron), Orbitron, sans-serif" }}
      >
        MATRIX OS
      </span>
    </Link>
  );
}

function SharedNavLink({ active, compact }: { active: boolean; compact?: boolean }) {
  return (
    <Link
      href={SHARED_HOME}
      aria-current={active ? "page" : undefined}
      className={compact
        ? "flex min-h-12 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-forest/70 aria-[current=page]:text-deep"
        : "inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium text-forest/75 transition-colors hover:bg-forest/[0.06] aria-[current=page]:bg-forest/[0.08] aria-[current=page]:text-deep"}
    >
      <UsersIcon className="size-4" aria-hidden="true" />
      Shared with me
    </Link>
  );
}

function AccountMenu({ account, signingOut, onManageAccount, onSignOut }: {
  account: CollaborationFrameAccount;
  signingOut: boolean;
  onManageAccount?: () => void;
  onSignOut: () => void;
}) {
  const initial = account.displayName.trim().charAt(0).toUpperCase() || "M";
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${account.displayName}`}
          className="flex size-9 items-center justify-center rounded-full border border-forest/15 bg-white text-sm font-semibold text-deep shadow-sm transition-colors hover:bg-cream/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/60"
        >
          {initial}
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-forest/12 p-2 text-deep"
          style={{ zIndex: SHELL_Z_INDEX.popover, backgroundColor: palette.card, boxShadow: cardShadow }}
        >
          <div className="rounded-xl bg-forest/[0.04] px-3 py-2.5">
            <p className="truncate text-sm font-semibold">{account.displayName}</p>
            {account.secondary ? <p className="mt-0.5 truncate text-xs text-forest/65">{account.secondary}</p> : null}
          </div>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {onManageAccount ? (
              <DropdownMenuPrimitive.Item className={menuItemClass} onSelect={onManageAccount}>
                <UserIcon className="size-4 text-forest/60" aria-hidden="true" />
                Manage account
              </DropdownMenuPrimitive.Item>
            ) : null}
            <DropdownMenuPrimitive.Item asChild>
              <Link className={menuItemClass} href="/?billing=setup">
                <ServerIcon className="size-4 text-forest/60" aria-hidden="true" />
                Get a Matrix computer
              </Link>
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Separator className="my-1 h-px bg-forest/10" />
            <DropdownMenuPrimitive.Item className={menuItemClass} disabled={signingOut} onSelect={onSignOut}>
              <LogOutIcon className="size-4 text-forest/60" aria-hidden="true" />
              {signingOut ? "Signing out…" : "Sign out"}
            </DropdownMenuPrimitive.Item>
          </div>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/**
 * Account-only chrome for machine-free collaboration (spec 535 D2): brand mark,
 * Shared with me and the account menu. Below 768px it becomes a single column
 * with bottom navigation (Web Mobile).
 */
function CollaborationFrameChrome({
  account,
  sharedActive,
  signingOut = false,
  signOutFailed = false,
  onManageAccount,
  onSignOut,
  children,
}: {
  account: CollaborationFrameAccount | null;
  sharedActive: boolean;
  signingOut?: boolean;
  signOutFailed?: boolean;
  onManageAccount?: () => void;
  onSignOut?: () => void;
  children: ReactNode;
}) {
  return (
    <div data-matrix-collaboration-frame="true" className="flex h-dvh flex-col bg-page-bg text-deep" style={FRAME_THEME}>
      <header
        className="flex h-14 shrink-0 items-center gap-5 border-b border-forest/10 px-4 backdrop-blur md:px-6"
        style={{ backgroundColor: tint(palette.card, 80) }}
      >
        <BrandLockup />
        {account ? (
          <nav aria-label="Collaboration" className="hidden md:flex">
            <SharedNavLink active={sharedActive} />
          </nav>
        ) : null}
        <div className="ml-auto flex items-center">
          {account && onSignOut ? (
            <AccountMenu account={account} signingOut={signingOut} onManageAccount={onManageAccount} onSignOut={onSignOut} />
          ) : null}
        </div>
      </header>
      {signOutFailed ? (
        <p role="alert" className="shrink-0 border-b border-ember/30 bg-ember/10 px-4 py-2 text-sm md:px-6">
          Sign-out did not finish. Try again.
        </p>
      ) : null}
      <main className={account ? "min-h-0 flex-1 overflow-y-auto pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0" : "min-h-0 flex-1 overflow-y-auto"}>
        {children}
      </main>
      {account ? (
        <nav
          aria-label="Collaboration"
          className="fixed inset-x-0 bottom-0 flex border-t border-forest/10 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
          style={{ backgroundColor: tint(palette.card, 95) }}
        >
          <SharedNavLink active={sharedActive} compact />
        </nav>
      ) : null}
    </div>
  );
}

function sharedPath(kind: "chat" | "terminal" | "project" | "file" | "invitations", id: string): string {
  return `${SHARED_HOME}/${kind}/${encodeURIComponent(id)}`;
}

// Starting hosted work is always a separate, explicit choice (spec 535 Story 1.5).
const getComputerAction = (
  <Link href="/?billing=setup" className="inline-flex rounded-xl border border-forest/20 px-4 py-2 text-sm font-medium hover:bg-forest/[0.06]">
    Get a Matrix computer
  </Link>
);

function FrameStatus() {
  return <p role="status" className="p-8 text-sm text-forest/70">Loading shared work…</p>;
}

const ROLE_LABEL = { owner: "Owner", editor: "Contributor", viewer: "Viewer" } as const;

interface SharedChatMetadata {
  title: string;
  role: keyof typeof ROLE_LABEL;
}

interface SharedChatSessionSlots {
  headerContainer: HTMLElement | null;
  onChatMetadata: (metadata: SharedChatMetadata) => void;
}

/** Shared Chats render their title and session controls in this row, like the OS Chat header. */
function SharedChatSession({ children }: { children: (session: SharedChatSessionSlots) => ReactNode }) {
  const [headerContainer, setHeaderContainer] = useState<HTMLElement | null>(null);
  const [metadata, setMetadata] = useState<SharedChatMetadata | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-forest/10 px-4">
        <Link href={SHARED_HOME} className="shrink-0 text-sm text-forest/70 hover:text-deep" aria-label="Back to Shared with me">
          <span aria-hidden="true">←</span>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{metadata?.title ?? "Shared Chat"}</h1>
          {metadata ? <p className="text-xs text-forest/65">{ROLE_LABEL[metadata.role]}</p> : null}
        </div>
        <div ref={setHeaderContainer} className="shrink-0" />
      </div>
      <div className="min-h-0 flex-1">{children({ headerContainer, onChatMetadata: setMetadata })}</div>
    </div>
  );
}

function SignedOutFrame() {
  const pathname = usePathname();
  const returnTo = encodeURIComponent(pathname?.startsWith(SHARED_HOME) ? pathname : SHARED_HOME);
  return (
    <CollaborationFrameChrome account={null} sharedActive={false}>
      <section className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">Sign in to open shared work</h1>
        <p className="text-sm text-forest/70">
          Shared Chats, terminals and projects open with your Matrix account. You do not need a Matrix computer.
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Link
            href={`/sign-in?redirect_url=${returnTo}`}
            className="rounded-xl bg-deep px-4 py-2 text-sm font-medium"
            style={{ color: lightFg }}
          >
            Sign in
          </Link>
          <Link href={`/sign-up?redirect_url=${returnTo}`} className="rounded-xl border border-forest/20 px-4 py-2 text-sm font-medium">
            Create account
          </Link>
        </div>
      </section>
    </CollaborationFrameChrome>
  );
}

function FrameCollaboration({ view, api, actorId, session }: {
  view: ChatCollaborationView;
  api: CollaborationApi;
  actorId: string;
  session?: SharedChatSessionSlots;
}) {
  const router = useRouter();
  return (
    <ChatCollaboration
      view={view}
      api={api}
      actorId={actorId}
      layers={COLLABORATION_LAYERS}
      headerContainer={session?.headerContainer}
      onChatMetadata={session?.onChatMetadata}
      emptyStateAction={getComputerAction}
      openInvitation={(invitationId) => router.push(sharedPath("invitations", invitationId))}
      openChat={(scopeId) => router.push(sharedPath("chat", scopeId))}
      openTerminal={(scopeId) => router.push(sharedPath("terminal", scopeId))}
      openProject={(scopeId) => router.push(sharedPath("project", scopeId))}
      openFile={(scopeId) => router.push(sharedPath("file", scopeId))}
    />
  );
}

/**
 * The frame owns its direct API for one actor and one session generation. A
 * new actor or a restart after an unconfirmed sign-out gets a fresh API; the
 * previous one is closed, and so is the current one when the frame unmounts
 * (for example when Clerk reports the account signed out).
 */
function useFrameCollaborationApi(actorId: string, sessionGeneration: number): CollaborationDirectApi | null {
  const browserOrigin = useBrowserOrigin();
  const [api, setApi] = useState<CollaborationDirectApi | null>(null);
  useEffect(() => {
    if (!browserOrigin) return;
    const created = createShellCollaborationApi(browserOrigin);
    // Created in the effect (not a memo) so StrictMode's effect replay closes one API and keeps its replacement live.
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- publishes an external resource owned by this effect; the cleanup closes it.
    setApi(created);
    return () => {
      created.direct.close();
      setApi((current) => current === created ? null : current);
    };
  }, [browserOrigin, actorId, sessionGeneration]);
  return api;
}

function CollaborationFrameSurface({
  view,
  account,
  sessionGeneration,
  signingOut,
  signOutFailed,
  onManageAccount,
  onSignOut,
}: {
  view: ChatCollaborationView;
  account: CollaborationFrameAccount;
  sessionGeneration: number;
  signingOut?: boolean;
  signOutFailed?: boolean;
  onManageAccount?: () => void;
  onSignOut: () => void;
}) {
  const api = useFrameCollaborationApi(account.userId, sessionGeneration);
  return (
    <CollaborationFrameChrome
      account={account}
      sharedActive={view.kind === "home"}
      signingOut={signingOut}
      signOutFailed={signOutFailed}
      onManageAccount={onManageAccount}
      onSignOut={onSignOut}
    >
      {!api ? <FrameStatus /> : view.kind === "chat" ? (
        <SharedChatSession>
          {(session) => <FrameCollaboration view={view} api={api} actorId={account.userId} session={session} />}
        </SharedChatSession>
      ) : <FrameCollaboration view={view} api={api} actorId={account.userId} />}
    </CollaborationFrameChrome>
  );
}

function ClerkCollaborationFrame({ view }: { view: ChatCollaborationView }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [sessionGeneration, setSessionGeneration] = useState(0);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutFailed(false);
    const signIn = new URL(getSignInRedirectUrl());
    signIn.searchParams.set("redirect_url", SHARED_HOME);
    const redirectUrl = signIn.toString();
    // Sign-out is one-way: end every direct session first so nothing runs under an identity that is
    // leaving, then clear the app session (the platform also revokes the Clerk session), then Clerk.
    const { clerkSessionRevoked } = await clearMatrixAppSession();
    let clientSignedOut = false;
    try {
      await clerkSignOutWithTimeout(clerk.signOut, redirectUrl);
      clientSignedOut = true;
    } catch (error: unknown) {
      if (isTimeoutError(error)) console.warn("[collaboration-frame] Clerk sign-out timed out");
      else console.error("[collaboration-frame] Clerk sign-out failed", error instanceof Error ? error.name : typeof error);
    }
    if (clerkSessionRevoked || clientSignedOut) {
      window.location.replace(redirectUrl);
      return;
    }
    // Neither the platform nor Clerk confirmed sign-out, so the account may still be signed in. Say so,
    // and restart shared work on fresh sessions because the previous ones were already ended.
    setSigningOut(false);
    setSignOutFailed(true);
    setSessionGeneration((generation) => generation + 1);
  }

  if (!isLoaded) {
    return <CollaborationFrameChrome account={null} sharedActive={false}><FrameStatus /></CollaborationFrameChrome>;
  }
  if (!isSignedIn || !userId) return <SignedOutFrame />;
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const account: CollaborationFrameAccount = {
    userId,
    displayName: user?.fullName || user?.username || email || "Matrix account",
    secondary: email,
  };
  return (
    <CollaborationFrameSurface
      view={view}
      account={account}
      sessionGeneration={sessionGeneration}
      signingOut={signingOut}
      signOutFailed={signOutFailed}
      onManageAccount={() => clerk.openUserProfile()}
      onSignOut={() => void handleSignOut()}
    />
  );
}

/**
 * Account-only collaboration frame served by the platform for `/shared*`
 * (spec 535 M1 D2). It mounts no OS shell: no onboarding, journey, runtime,
 * theme or gateway request. Only Clerk and collaboration routes are used.
 */
export function CollaborationFrame({ view }: { view: ChatCollaborationView }) {
  if (e2eBypass) {
    return <CollaborationFrameSurface view={view} account={E2E_ACCOUNT} sessionGeneration={0} onSignOut={() => undefined} />;
  }
  return <ClerkCollaborationFrame view={view} />;
}
