import { CollaborationIdSchema } from "@matrix-os/contracts";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { OnboardingGate } from "@/components/OnboardingGate";
import { ShellHome } from "@/components/ShellHome";
import { CollaborationFrame } from "@/components/collaboration/CollaborationFrame";
import { hasServerVerifiedMatrixSession } from "@/lib/platform-session";
import { isPlatformShellSurface } from "@/lib/shell-surface";

export default async function SharedFolderPage({ params }: {
  params: Promise<{ scopeId: string }>;
}) {
  const result = CollaborationIdSchema.safeParse((await params).scopeId);
  if (!result.success) notFound();
  const scopeId = result.data;
  if (await isPlatformShellSurface()) return <CollaborationFrame view={{ kind: "folder", scopeId }} />;
  const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1";
  const platformSessionActive = selfHostedMode || hasServerVerifiedMatrixSession(await headers());
  return <OnboardingGate platformSessionActive={platformSessionActive}>
    <ShellHome initialCollaborationView={{ kind: "folder", scopeId }} />
  </OnboardingGate>;
}
