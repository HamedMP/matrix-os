"use client";

import { useAuth } from "@clerk/nextjs";
import { ChatCollaboration, type ChatCollaborationView } from "@matrix-os/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi } from "@/lib/collaboration";

export function CollaborationPage({ view }: { view: ChatCollaborationView }) {
  const { isLoaded, userId } = useAuth();
  const router = useRouter();
  const browserOrigin = useBrowserOrigin();
  if (!isLoaded || !browserOrigin) return <p role="status" className="p-8">Loading collaboration…</p>;
  if (!userId) return <main className="m-auto max-w-lg p-8 text-center">
    <h1 className="text-xl font-semibold">Sign in to collaborate</h1>
    <p className="mt-2 text-sm">Shared Chats are tied to your Matrix account.</p>
    <Link href="/sign-in" className="mt-5 inline-block rounded-xl border px-4 py-2">Sign in</Link>
  </main>;
  return <ChatCollaboration view={view} api={createShellCollaborationApi(browserOrigin)} actorId={userId}
    openInvitation={(invitationId) => router.push(`/shared/invitations/${encodeURIComponent(invitationId)}`)}
    openChat={(scopeId) => router.push(`/shared/chat/${encodeURIComponent(scopeId)}`)} />;
}
