"use client";

import type { ChatCollaborationView } from "@matrix-os/ui";
import { ShellChatCollaboration } from "@/components/chat/ShellChatCollaboration";
import { NativeCollaborationActorProvider } from "@/lib/native-collaboration-identity";

type SharedAppView = Extract<ChatCollaborationView, { kind: "app" }>;

/**
 * Someone else's shared app, rendered on its own. It never boots the viewer's
 * personal desktop, onboarding, or runtime connection: the platform-owned
 * collaboration API discovers the exact shared build and owns access.
 */
export function SharedAppStandalone({ view, nativeCollaborationActorId, selfHosted }: {
  view: SharedAppView;
  nativeCollaborationActorId: string | null;
  /** Self-hosted documents have no Clerk session or platform collaboration API. */
  selfHosted: boolean;
}) {
  return <NativeCollaborationActorProvider actorId={nativeCollaborationActorId}>
    <main data-slot="shared-app-standalone" className="flex h-dvh w-screen flex-col overflow-hidden bg-[var(--bg-primary)]">
      {selfHosted
        ? <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
          Shared apps require a Matrix account.
        </div>
        : <ShellChatCollaboration view={view} />}
    </main>
  </NativeCollaborationActorProvider>;
}
