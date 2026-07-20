import type { Metadata } from "next";

import { AddComputerOnboarding } from "@/components/runtime/RuntimeManager";

export const metadata: Metadata = {
  title: "Add a computer | Matrix OS",
  description: "Configure and build another Matrix OS computer.",
};

export default function AddComputerOnboardingPage() {
  return <AddComputerOnboarding />;
}
