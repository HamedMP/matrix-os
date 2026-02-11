"use client";

import { useTheme } from "@/hooks/useTheme";
import { Desktop } from "@/components/Desktop";
import { ChatPanel } from "@/components/ChatPanel";
import { Dock } from "@/components/Dock";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Terminal } from "@/components/Terminal";
import { ModuleGraph } from "@/components/ModuleGraph";

export default function Home() {
  useTheme();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="flex flex-1 flex-col">
        <Desktop />
        <div
          className="flex border-t"
          style={{
            height: 280,
            borderColor: "var(--color-border)",
          }}
        >
          <div className="flex-1 min-w-0">
            <Terminal />
          </div>
          <div
            className="w-[300px] border-l"
            style={{ borderColor: "var(--color-border)" }}
          >
            <ModuleGraph />
          </div>
          <div
            className="w-[240px] border-l overflow-y-auto"
            style={{ borderColor: "var(--color-border)" }}
          >
            <ActivityFeed />
          </div>
        </div>
      </div>
      <ChatPanel />
      <Dock />
    </div>
  );
}
