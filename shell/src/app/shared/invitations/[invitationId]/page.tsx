import { CollaborationIdSchema } from "@matrix-os/contracts";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { OnboardingGate } from "@/components/OnboardingGate";
import { ShellHome } from "@/components/ShellHome";
import { hasServerVerifiedMatrixSession } from "@/lib/platform-session";

export default async function SharedInvitationPage({ params }: {
  params: Promise<{ invitationId: string }>;
}) {
  const result = CollaborationIdSchema.safeParse((await params).invitationId);
  if (!result.success) notFound();
  const invitationId = result.data;
  const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1";
  const platformSessionActive = selfHostedMode || hasServerVerifiedMatrixSession(await headers());
  return <OnboardingGate platformSessionActive={platformSessionActive}>
    <ShellHome initialCollaborationView={{ kind: "invitation", invitationId }} />
  </OnboardingGate>;
}
