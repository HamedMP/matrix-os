import type { Metadata } from "next";

import { RuntimeManager } from "@/components/runtime/RuntimeManager";

export const metadata: Metadata = {
  title: "Your computers | Matrix OS",
  description: "Open, build, and manage the Matrix OS computers on your account.",
};

export default function RuntimePage() {
  return <RuntimeManager />;
}
