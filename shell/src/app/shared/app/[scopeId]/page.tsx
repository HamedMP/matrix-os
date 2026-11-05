import { CollaborationIdSchema } from "@matrix-os/contracts";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { OnboardingGate } from "@/components/OnboardingGate";
import { ShellHome } from "@/components/ShellHome";
import { hasServerVerifiedMatrixSession } from "@/lib/platform-session";

export default async function SharedAppPage({ params, searchParams = Promise.resolve({}) }: {
  params: Promise<{ scopeId: string }>;
  searchParams?: Promise<{ expectedBuildId?: string; expectedShareRevision?: string }>;
}) {
  const result = CollaborationIdSchema.safeParse((await params).scopeId);
  if (!result.success) notFound();
  const expected = await searchParams;
  const expectedBuildId = /^[a-f0-9]{64}$/.test(expected.expectedBuildId ?? "")
    ? expected.expectedBuildId : undefined;
  const expectedShareRevision = /^\d+$/.test(expected.expectedShareRevision ?? "")
    ? expected.expectedShareRevision : undefined;
  const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1";
  const platformSessionActive = selfHostedMode || hasServerVerifiedMatrixSession(await headers());
  return <OnboardingGate platformSessionActive={platformSessionActive}>
    <ShellHome initialCollaborationView={{ kind: "app", scopeId: result.data,
      ...(expectedBuildId ? { expectedBuildId } : {}),
      ...(expectedShareRevision ? { expectedShareRevision } : {}) }} />
  </OnboardingGate>;
}
