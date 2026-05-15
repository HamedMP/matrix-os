"use client";

import { DesktopStandaloneFrame } from "@/components/desktop/DesktopStandaloneFrame";
import { WorkspaceApp } from "@/components/workspace/WorkspaceApp";

export default function DesktopWorkspacePage() {
  return (
    <DesktopStandaloneFrame>
      <WorkspaceApp />
    </DesktopStandaloneFrame>
  );
}
