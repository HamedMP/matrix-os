import type { Metadata } from "next";
import { headers } from "next/headers";
import { OnboardingGate } from "@/components/OnboardingGate";
import { ShellHome } from "@/components/ShellHome";
import { hasServerVerifiedMatrixSession } from "@/lib/platform-session";

export const metadata: Metadata = {
  title: "Matrix OS",
  description: "Your AI operating system: desktop, messaging, social, and agents in one computer you own.",
};

export default async function Home() {
  const platformSessionActive = hasServerVerifiedMatrixSession(await headers());

  return (
    <OnboardingGate platformSessionActive={platformSessionActive}>
      <ShellHome />
    </OnboardingGate>
  );
}
