import { headers } from "next/headers";
import { OnboardingGate } from "@/components/OnboardingGate";
import { ShellHome } from "@/components/ShellHome";
import { CollaborationFrame } from "@/components/collaboration/CollaborationFrame";
import { hasServerVerifiedMatrixSession } from "@/lib/platform-session";
import { isPlatformShellSurface } from "@/lib/shell-surface";

export default async function SharedPage() {
  if (await isPlatformShellSurface()) return <CollaborationFrame view={{ kind: "home" }} />;
  const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1";
  const platformSessionActive = selfHostedMode || hasServerVerifiedMatrixSession(await headers());
  return <OnboardingGate platformSessionActive={platformSessionActive}>
    <ShellHome initialCollaborationView={{ kind: "home" }} />
  </OnboardingGate>;
}
