import { CollaborationIdSchema, CollaborationRevisionSchema } from "@matrix-os/contracts";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { z } from "zod/v4";

import { SharedAppStandalone } from "@/components/shared-app/SharedAppStandalone";
import { serverVerifiedNativeActorId } from "@/lib/platform-session";

const SharedAppLaunchQuerySchema = z.object({
  expectedBuildId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedShareRevision: CollaborationRevisionSchema.optional(),
}).strict();

// Viewing another owner's app must not boot this viewer's personal desktop:
// no OnboardingGate/ShellHome, runtime connection, or dock. Electron attaches
// its native bearer only to the shared-app allowlist, so personal-runtime
// requests from a full shell would fail ("Computer unavailable").
export default async function SharedAppPage({ params, searchParams = Promise.resolve({}) }: {
  params: Promise<{ scopeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = CollaborationIdSchema.safeParse((await params).scopeId);
  if (!result.success) notFound();
  const expected = SharedAppLaunchQuerySchema.safeParse(await searchParams);
  if (!expected.success) notFound();
  const nativeCollaborationActorId = serverVerifiedNativeActorId(await headers());
  return <SharedAppStandalone
    view={{ kind: "app", scopeId: result.data,
      ...(expected.data.expectedBuildId ? { expectedBuildId: expected.data.expectedBuildId } : {}),
      ...(expected.data.expectedShareRevision ? { expectedShareRevision: expected.data.expectedShareRevision } : {}) }}
    nativeCollaborationActorId={nativeCollaborationActorId}
    selfHosted={process.env.MATRIX_SELF_HOSTED === "1"} />;
}
