"use client";

import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { GetStartedAnswersProvider, GettingStartedVisibilityProvider, resolveRecipeHandoff, type ChatCollaborationView } from "@matrix-os/ui";
import { useState, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAuth, useUser } from "@clerk/nextjs";
import { useTheme } from "@/hooks/useTheme";
import { useDesktopConfig } from "@/hooks/useDesktopConfig";
import { useCanonicalChatState } from "@/hooks/useCanonicalChatState";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { useCommandStore } from "@/stores/commands";
import { ChatProvider } from "@/stores/chat-context";
import { organizationDriveNavigationIdentity } from "@/stores/organization-drive-navigation";
import { capturePostHogEvent } from "@/lib/posthog-client";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability/events";

import { Desktop } from "@/components/Desktop";
import { MobileShell } from "@/components/mobile/MobileShell";
import { CommandPalette } from "@/components/CommandPalette";
import { ApprovalDialog } from "@/components/ApprovalDialog";
import { useMobileViewport } from "@/hooks/useMobileViewport";
import { createShellSnapshotScope } from "@/lib/shell-snapshot-cache";
import { createShellChatNavigationScope } from "@/lib/chat-navigation-scope";
import { getGatewayUrl } from "@/lib/gateway";
import { isSelfHostedRuntime, SELF_HOSTED_SHELL_USER_ID } from "@/lib/self-host-mode";
import { AppSiteOwnerIdentityProvider } from "@/components/app-sites/AppSiteOwnerIdentity";
import { NativeCollaborationActorProvider } from "@/lib/native-collaboration-identity";
import { OwnerCollaborationParticipantProvider } from "@/lib/owner-collaboration-participant";

const LAUNCHABLE_BUILT_IN_PATHS = new Set([
  "__terminal__",
  "__chat__",
  "__file-browser__",
  "__preview-window__",
  "__activity-monitor__",
]);

function readLaunchPathFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const chatIds = new URLSearchParams(window.location.search).getAll("chat");
  const chatId = CanonicalChatIdSchema.safeParse(chatIds.length === 1 ? chatIds[0] : null);
  if (readRecipePromptFromLocation() || chatId.success) return "__chat__";
  const launch = new URLSearchParams(window.location.search).get("launch");
  return launch && LAUNCHABLE_BUILT_IN_PATHS.has(launch) ? launch : null;
}

function readRecipePromptFromLocation(): string | null {
  const values = new URLSearchParams(window.location.search).getAll("recipe");
  return values.length === 1 ? resolveRecipeHandoff(values[0]!)?.prompt ?? null : null;
}

// The launch path lives in window.location.search (read once at load). useSyncExternalStore
// returns null on the server and during hydration (matching the server snapshot) and the real
// value on the client, so it is applied without a setState-in-effect mount cascade or a
// hydration mismatch. The URL is not mutated after load, so the subscription is a noop.
const subscribeLaunchPathNoop = () => () => {};
const getLaunchPathServerSnapshot = (): string | null => null;

function readRuntimeSlotFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get("runtime");
}

type ShellHomeProps = {
  initialCollaborationView?: ChatCollaborationView;
  nativeCollaborationActorId?: string | null;
};

const localAuthBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

export function ShellHome(props: ShellHomeProps = {}) {
  if (localAuthBypass) {
    return <ShellHomeContent {...props} userId={null} sessionId={null} ownerIdentity="local-user" />;
  }

  // Self-hosted documents render without ClerkProvider, so useAuth must never run there.
  // react-doctor-disable-next-line react-doctor/no-hydration-branch-on-browser-global -- both sides read the same MATRIX_SELF_HOSTED flag: the server from its env, the client from the data-matrix-self-hosted attribute the root layout renders from that env
  if (isSelfHostedRuntime()) {
    return (
      <ShellHomeBody
        userId={SELF_HOSTED_SHELL_USER_ID}
        sessionId={null}
        ownerIdentity={SELF_HOSTED_SHELL_USER_ID}
        initialCollaborationView={props.initialCollaborationView}
      />
    );
  }

  // Native Electron shared-app views authenticate at the trusted network
  // boundary and run in a fresh partition without Clerk cookies.
  if (props.nativeCollaborationActorId) {
    return <ShellHomeContent {...props} userId={props.nativeCollaborationActorId} sessionId={null} ownerIdentity={props.nativeCollaborationActorId} />;
  }

  return <ManagedShellHome {...props} />;
}

function ManagedShellHome(props: ShellHomeProps) {
  return <ClerkShellHome {...props} />;
}

function ClerkShellHome(props: ShellHomeProps) {
  const { userId, sessionId } = useAuth();
  const { user } = useUser();
  const ownerIdentity = user?.primaryEmailAddress?.emailAddress ?? userId ?? "signed-in-user";
  return <ShellHomeContent {...props} userId={userId} sessionId={sessionId} ownerIdentity={ownerIdentity} />;
}

function ShellHomeContent({
  initialCollaborationView,
  nativeCollaborationActorId,
  userId,
  sessionId,
  ownerIdentity,
}: ShellHomeProps & { userId: string | null | undefined; sessionId: string | null | undefined; ownerIdentity: string }) {
  return (
    <ShellHomeBody
      userId={userId}
      sessionId={sessionId}
      ownerIdentity={ownerIdentity}
      initialCollaborationView={initialCollaborationView}
      nativeCollaborationActorId={nativeCollaborationActorId}
    />
  );
}

function ShellHomeBody({
  userId,
  sessionId,
  ownerIdentity,
  initialCollaborationView,
  nativeCollaborationActorId,
}: ShellHomeProps & { userId: string | null | undefined; sessionId: string | null | undefined; ownerIdentity: string }) {
  const isMobile = useMobileViewport();
  // Canonical Chat captures this transport on mount. Shared navigation rewrites
  // history without replacing it; actual Computer switches reload the document.
  const [chatGatewayUrl] = useState(getGatewayUrl);
  const fileAuthority = organizationDriveNavigationIdentity(userId, sessionId, chatGatewayUrl);
  useLayoutEffect(() => {
    if (!localAuthBypass && !nativeCollaborationActorId) {
      usePreviewWindow.getState().setDraftAuthority(fileAuthority);
    }
  }, [fileAuthority, nativeCollaborationActorId]);
  const cachePathname = typeof window === "undefined" ? "/" : window.location.pathname;
  const cacheScope = createShellSnapshotScope({ userId, pathname: cachePathname });
  useTheme({ cacheScope });
  useDesktopConfig({ cacheScope });

  const runtimeSlot = useSyncExternalStore(subscribeLaunchPathNoop, readRuntimeSlotFromLocation, getLaunchPathServerSnapshot);
  const recipePrompt = useSyncExternalStore(subscribeLaunchPathNoop, readRecipePromptFromLocation, getLaunchPathServerSnapshot);
  const terminalCollaborationView = initialCollaborationView?.kind === "terminal" ? initialCollaborationView : undefined;
  const chatCollaborationView = terminalCollaborationView ? undefined : initialCollaborationView;
  const chat = useCanonicalChatState({
    initialDraft: recipePrompt,
    initialCollaborationView: chatCollaborationView,
    navigationScope: createShellChatNavigationScope(cacheScope, sessionId, chatGatewayUrl),
    navigationGeneration: sessionId ?? "self-hosted",
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const handoffConsumed = useRef<string | null>(null);
  useEffect(() => {
    const values = new URLSearchParams(window.location.search).getAll("chat");
    const target = CanonicalChatIdSchema.safeParse(values.length === 1 ? values[0] : null);
    const key = JSON.stringify([userId, sessionId, target.success ? target.data : null]);
    if (!userId || !target.success || initialCollaborationView || handoffConsumed.current === key) return;
    handoffConsumed.current = key;
    chat.switchConversation(target.data);
  }, [userId, sessionId, initialCollaborationView, chat.switchConversation]);
  const locationLaunchAppPath = useSyncExternalStore(
    subscribeLaunchPathNoop,
    readLaunchPathFromLocation,
    getLaunchPathServerSnapshot,
  );
  const launchAppPath = terminalCollaborationView ? "__terminal__"
    : chatCollaborationView ? "__chat__" : locationLaunchAppPath;
  const sharedTerminalScopeId = terminalCollaborationView?.scopeId ?? null;
  const shellLoadedCaptured = useRef(false);

  useGlobalShortcuts(
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity consumed by useGlobalShortcuts' useEffect dependency array ([onPalette]) which re-registers the keydown listener; a fresh function each render would re-add/remove the listener every render
    useCallback(() => setPaletteOpen(true), [setPaletteOpen]),
    paletteOpen,
  );

  const register = useCommandStore((s) => s.register);
  const unregister = useCommandStore((s) => s.unregister);

  useEffect(() => {
    register([
      {
        id: "action:new-chat",
        label: "New Chat",
        group: "Actions",
        shortcut: "Cmd+N",
        keywords: ["conversation", "session"],
        execute: () => chat.newChat(),
      },
    ]);
    return () => unregister(["action:new-chat"]);
  }, [register, unregister, chat.newChat]);

  useEffect(() => {
    if (shellLoadedCaptured.current) return;
    shellLoadedCaptured.current = true;
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.SHELL_LOADED, {
      surface: isMobile ? "mobile" : "desktop",
    });
  }, [isMobile]);

  const gettingStartedScope = JSON.stringify([cacheScope?.storageKey ?? cachePathname, sessionId, runtimeSlot]);
  return (
    <AppSiteOwnerIdentityProvider value={ownerIdentity}>
    <OwnerCollaborationParticipantProvider actorId={userId ?? (localAuthBypass ? "user_e2e" : null)}>
    <NativeCollaborationActorProvider actorId={nativeCollaborationActorId ?? null}>
    <GettingStartedVisibilityProvider scope={gettingStartedScope}>
    <GetStartedAnswersProvider scope={gettingStartedScope}>
    <ChatProvider value={chat}>
      <div className="flex h-screen w-screen flex-col overflow-hidden md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            {isMobile ? (
              <MobileShell
                launchAppPath={launchAppPath}
                sharedTerminalScopeId={sharedTerminalScopeId}
                onOpenCommandPalette={() => setPaletteOpen(true)}
                cacheScope={cacheScope}
              />
            ) : (
              <Desktop
                launchAppPath={launchAppPath}
                sharedTerminalScopeId={sharedTerminalScopeId}
                onOpenCommandPalette={() => setPaletteOpen(true)}
                chat={chat}
                cacheScope={cacheScope}
              />
            )}
          </div>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <ApprovalDialog />
      </div>
    </ChatProvider>
    </GetStartedAnswersProvider>
    </GettingStartedVisibilityProvider>
    </NativeCollaborationActorProvider>
    </OwnerCollaborationParticipantProvider>
    </AppSiteOwnerIdentityProvider>
  );
}
