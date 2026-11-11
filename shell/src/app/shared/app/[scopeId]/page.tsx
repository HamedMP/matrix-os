import { CollaborationIdSchema, CollaborationRevisionSchema } from "@matrix-os/contracts";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { z } from "zod/v4";

import { OnboardingGate } from "@/components/OnboardingGate";
import { ShellHome } from "@/components/ShellHome";
import { hasServerVerifiedMatrixSession, serverVerifiedNativeActorId } from "@/lib/platform-session";

const SharedAppLaunchQuerySchema = z.object({
  expectedBuildId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedShareRevision: CollaborationRevisionSchema.optional(),
}).strict();

export default async function SharedAppPage({ params, searchParams = Promise.resolve({}) }: {
  params: Promise<{ scopeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = CollaborationIdSchema.safeParse((await params).scopeId);
  if (!result.success) notFound();
  const expected = SharedAppLaunchQuerySchema.safeParse(await searchParams);
  if (!expected.success) notFound();
  const requestHeaders = await headers();
  const nativeCollaborationActorId = serverVerifiedNativeActorId(requestHeaders);
  const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1";
  const platformSessionActive = selfHostedMode || hasServerVerifiedMatrixSession(requestHeaders);
  return <OnboardingGate platformSessionActive={platformSessionActive}>
    <ShellHome initialCollaborationView={{ kind: "app", scopeId: result.data,
      ...(expected.data.expectedBuildId ? { expectedBuildId: expected.data.expectedBuildId } : {}),
      ...(expected.data.expectedShareRevision ? { expectedShareRevision: expected.data.expectedShareRevision } : {}) }}
      nativeCollaborationActorId={nativeCollaborationActorId} />
  </OnboardingGate>;
}
