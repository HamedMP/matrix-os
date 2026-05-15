"use client";

import { DesktopStandaloneFrame } from "@/components/desktop/DesktopStandaloneFrame";
import { FileBrowser } from "@/components/file-browser/FileBrowser";

export default function DesktopFilesPage() {
  return (
    <DesktopStandaloneFrame>
      <FileBrowser windowId="desktop-files" />
    </DesktopStandaloneFrame>
  );
}
