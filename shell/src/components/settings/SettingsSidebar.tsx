"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  UserIcon,
  MessageSquareIcon,
  SparklesIcon,
  ShieldIcon,
  ClockIcon,
  PuzzleIcon,
  MonitorIcon,
} from "lucide-react";

const sections = [
  { id: "agent", label: "Agent", icon: UserIcon, href: "/settings/agent" },
  { id: "channels", label: "Channels", icon: MessageSquareIcon, href: "/settings/channels" },
  { id: "skills", label: "Skills", icon: SparklesIcon, href: "/settings/skills" },
  { id: "security", label: "Security", icon: ShieldIcon, href: "/settings/security" },
  { id: "cron", label: "Cron", icon: ClockIcon, href: "/settings/cron" },
  { id: "plugins", label: "Plugins", icon: PuzzleIcon, href: "/settings/plugins" },
  { id: "system", label: "System", icon: MonitorIcon, href: "/settings/system" },
];

export function SettingsSidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 p-3">
      {sections.map((section) => {
        const Icon = section.icon;
        const active = pathname === section.href;
        return (
          <Link
            key={section.id}
            href={section.href}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-primary/10 text-primary font-medium border-l-2 border-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            <Icon className="size-4 shrink-0" />
            <span className="hidden lg:inline">{section.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function SettingsMobileNav() {
  return (
    <div className="grid grid-cols-2 gap-3 p-4">
      {sections.map((section) => {
        const Icon = section.icon;
        return (
          <Link
            key={section.id}
            href={section.href}
            className="flex items-center gap-3 rounded-lg border border-border p-4 hover:bg-muted/50 transition-colors"
          >
            <Icon className="size-5 text-primary" />
            <span className="text-sm font-medium">{section.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
