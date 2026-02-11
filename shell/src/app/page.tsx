"use client";

import { useTheme } from "@/hooks/useTheme";
import { Desktop } from "@/components/Desktop";
import { ChatPanel } from "@/components/ChatPanel";
import { Dock } from "@/components/Dock";
import { ActivityFeed } from "@/components/ActivityFeed";

export default function Home() {
  useTheme();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="flex flex-1 flex-col">
        <Desktop />
        <ActivityFeed />
      </div>
      <ChatPanel />
      <Dock />
    </div>
  );
}
