"use client";

import { useAuth } from "@clerk/nextjs";
import { ChatCollaboration, type ChatCollaborationView } from "@matrix-os/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { useShellCollaborationApi } from "@/lib/collaboration-organization";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";

export function CollaborationPage({ view }: { view: ChatCollaborationView }) {
  const { isLoaded, userId } = useAuth();
  const router = useRouter();
  const browserOrigin = useBrowserOrigin();
  const { status: organizationStatus } = useCollaborationOrganization();
  const api = useShellCollaborationApi(browserOrigin, organizationStatus !== "none");
  if (!isLoaded || !browserOrigin) return <p role="status" className="p-8">Loading collaboration…</p>;
  if (!userId) return <main className="m-auto max-w-lg p-8 text-center">
    <h1 className="text-xl font-semibold">Sign in to collaborate</h1>
    <p className="mt-2 text-sm">Shared Chats, terminals, and projects are tied to your Matrix account.</p>
    <Link href="/sign-in" className="mt-5 inline-block rounded-xl border px-4 py-2">Sign in</Link>
  </main>;
  if (organizationStatus === "none") return <main role="alert" className="m-auto max-w-lg p-8 text-center">
    <h1 className="text-xl font-semibold">Organization share unavailable</h1>
    <p className="mt-2 text-sm">This account is not currently a member of an organization.</p>
  </main>;
  if (!api) return <p role="status" className="p-8">Loading collaboration…</p>;
  return <ChatCollaboration view={view} api={api} actorId={userId}
    openInvitation={(invitationId) => router.push(`/shared/invitations/${encodeURIComponent(invitationId)}`)}
    openChat={(scopeId) => router.push(`/shared/chat/${encodeURIComponent(scopeId)}`)}
    openTerminal={(scopeId) => router.push(`/shared/terminal/${encodeURIComponent(scopeId)}`)}
    openProject={(scopeId) => router.push(`/shared/project/${encodeURIComponent(scopeId)}`)} />;
}
