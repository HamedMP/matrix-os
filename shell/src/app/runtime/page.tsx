import type { Metadata } from "next";
import { connection } from "next/server";

import { RuntimeManager } from "@/components/runtime/RuntimeManager";
import { SelfHostedUnavailable } from "@/components/auth/SelfHostedUnavailable";

export const metadata: Metadata = {
  robots: { index: false, follow: true },
  alternates: { canonical: "https://app.matrix-os.com/runtime" },
  title: "Your computers | Matrix OS",
  description: "Open, build, and manage the Matrix OS computers on your account.",
};

export default async function RuntimePage() {
  // MATRIX_SELF_HOSTED is a runtime host setting; render per request so neither
  // this check nor the root layout's Clerk choice is frozen at build time.
  await connection();
  // Computer management belongs to hosted accounts; a self-hosted install is its only computer.
  if (process.env.MATRIX_SELF_HOSTED === "1") return <SelfHostedUnavailable feature="Computer management" />;
  return <RuntimeManager />;
}
