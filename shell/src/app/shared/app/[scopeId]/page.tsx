import { CollaborationIdSchema, CollaborationRevisionSchema } from "@matrix-os/contracts";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { z } from "zod/v4";

import { ShellChatCollaboration } from "@/components/chat/ShellChatCollaboration";
import { NativeCollaborationActorProvider } from "@/lib/native-collaboration-identity";
import { serverVerifiedNativeActorId } from "@/lib/platform-session";

const SharedAppLaunchQuerySchema = z.object({
  expectedBuildId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedShareRevision: CollaborationRevisionSchema.optional(),
}).strict();

// Render only the shared app. The viewer's personal desktop is not booted here.
export default async function SharedAppPage({ params, searchParams = Promise.resolve({}) }: {
  params: Promise<{ scopeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = CollaborationIdSchema.safeParse((await params).scopeId);
  if (!result.success) notFound();
  const expected = SharedAppLaunchQuerySchema.safeParse(await searchParams);
  if (!expected.success) notFound();
  // Self-hosted documents have no Clerk session or platform collaboration API.
  if (process.env.MATRIX_SELF_HOSTED === "1") {
    return <p role="alert" className="m-auto p-8 text-center">Shared apps require a Matrix account.</p>;
  }
  return <NativeCollaborationActorProvider actorId={serverVerifiedNativeActorId(await headers())}>
    <main className="flex h-dvh w-screen flex-col overflow-hidden">
      <ShellChatCollaboration view={{ kind: "app", scopeId: result.data,
        ...(expected.data.expectedBuildId ? { expectedBuildId: expected.data.expectedBuildId } : {}),
        ...(expected.data.expectedShareRevision ? { expectedShareRevision: expected.data.expectedShareRevision } : {}) }} />
    </main>
  </NativeCollaborationActorProvider>;
}
