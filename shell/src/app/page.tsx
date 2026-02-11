"use client";

import { useTheme } from "@/hooks/useTheme";
import { Desktop } from "@/components/Desktop";
import { ChatPanel } from "@/components/ChatPanel";
import { Dock } from "@/components/Dock";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Terminal } from "@/components/Terminal";
import { ModuleGraph } from "@/components/ModuleGraph";
import { Separator } from "@/components/ui/separator";

export default function Home() {
  useTheme();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="flex flex-1 flex-col">
        <Desktop />
        <Separator />
        <div className="flex h-[280px]">
          <div className="flex-1 min-w-0">
            <Terminal />
          </div>
          <Separator orientation="vertical" />
          <div className="w-[300px]">
            <ModuleGraph />
          </div>
          <Separator orientation="vertical" />
          <div className="w-[240px] overflow-y-auto">
            <ActivityFeed />
          </div>
        </div>
      </div>
      <ChatPanel />
      <Dock />
    </div>
  );
}
