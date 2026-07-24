import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ADD_COMPUTER_ONBOARDING_PATH } from "@/lib/runtime-routes";

export const metadata: Metadata = {
  title: "Add a computer | Matrix OS",
  description: "Configure and build another Matrix OS computer.",
};

export default function AddComputerOnboardingPage() {
  redirect(ADD_COMPUTER_ONBOARDING_PATH);
}
