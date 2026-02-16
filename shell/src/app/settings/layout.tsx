"use client";

import { useRouter } from "next/navigation";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, XIcon } from "lucide-react";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();

  return (
    <div className="flex h-screen w-screen bg-background">
      {/* Sidebar -- desktop */}
      <aside className="hidden md:flex flex-col w-[200px] lg:w-[220px] border-r border-border bg-card/50 shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h1 className="text-sm font-semibold">Settings</h1>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => router.push("/")}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
        <SettingsSidebar />
      </aside>

      {/* Mobile header */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex md:hidden items-center gap-2 px-3 py-2 border-b border-border">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => router.back()}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <h1 className="text-sm font-semibold">Settings</h1>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
