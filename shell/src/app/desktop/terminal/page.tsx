"use client";

import { useSearchParams } from "next/navigation";
import { DesktopStandaloneFrame } from "@/components/desktop/DesktopStandaloneFrame";
import { TerminalApp } from "@/components/terminal/TerminalApp";

export default function DesktopTerminalPage() {
  const searchParams = useSearchParams();
  const initialSessionId = searchParams.get("session") ?? undefined;

  return (
    <DesktopStandaloneFrame>
      <TerminalApp initialSessionId={initialSessionId} />
    </DesktopStandaloneFrame>
  );
}
