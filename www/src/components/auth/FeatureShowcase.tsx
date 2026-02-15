"use client";

import { useState, useEffect, useCallback } from "react";
import {
  TerminalIcon,
  FolderTreeIcon,
  ShieldIcon,
  MonitorSmartphoneIcon,
  FingerprintIcon,
} from "lucide-react";

const features = [
  {
    icon: TerminalIcon,
    title: "Describe it, it builds it",
    description:
      "Tell the OS what you need in natural language. It generates real software, saved as files you own.",
    visual: (
      <div className="space-y-2 font-mono text-xs text-muted-foreground">
        <div className="text-foreground">
          <span className="text-primary">$</span> Build me an expense tracker
          with categories
        </div>
        <div>
          <span className="text-primary">writing</span>{" "}
          ~/apps/expense-tracker.html
        </div>
        <div className="text-success">done in 4.2s</div>
      </div>
    ),
  },
  {
    icon: FolderTreeIcon,
    title: "Everything is a file",
    description:
      "Apps, config, AI personality -- all stored as real files. Back up your OS by copying a folder.",
    visual: (
      <div className="grid grid-cols-2 gap-1 font-mono text-[11px] text-muted-foreground">
        {[
          "apps/notes.html",
          "system/soul.md",
          "data/expenses/items.json",
          "agents/builder.md",
        ].map((f) => (
          <div key={f} className="truncate">
            {f}
          </div>
        ))}
      </div>
    ),
  },
  {
    icon: ShieldIcon,
    title: "Self-healing OS",
    description:
      "Break something? The healer agent detects, diagnoses, and repairs it. Git-backed snapshots mean nothing is lost.",
    visual: (
      <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
        <div>
          <span className="text-destructive">error</span> notes.html corrupted
        </div>
        <div>
          <span className="text-primary">healer</span> diagnosing...
        </div>
        <div>
          <span className="text-success">restored</span> from git snapshot
        </div>
      </div>
    ),
  },
  {
    icon: MonitorSmartphoneIcon,
    title: "Multi-channel",
    description:
      "Same kernel, every platform. Web desktop, Telegram, WhatsApp, Discord, Slack -- all connected to one identity.",
    visual: (
      <div className="flex flex-wrap gap-1.5">
        {["Web", "Telegram", "WhatsApp", "Discord", "Slack"].map((ch) => (
          <span
            key={ch}
            className="rounded-full border border-border bg-secondary/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            {ch}
          </span>
        ))}
      </div>
    ),
  },
  {
    icon: FingerprintIcon,
    title: "Your AI, your identity",
    description:
      "Federated identity via Matrix protocol. One handle everywhere. Your AI has its own identity too.",
    visual: (
      <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
        <div>
          <span className="text-primary">you</span>@you:matrix-os.com
        </div>
        <div>
          <span className="text-primary">ai</span>@you_ai:matrix-os.com
        </div>
      </div>
    ),
  },
];

interface FeatureShowcaseProps {
  heading?: string;
  subheading?: string;
}

export function FeatureShowcase({
  heading = "The OS that builds itself",
  subheading = "Sign up to get your personal Matrix OS instance.",
}: FeatureShowcaseProps) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  const next = useCallback(() => {
    setActive((prev) => (prev + 1) % features.length);
  }, []);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(next, 5000);
    return () => clearInterval(timer);
  }, [paused, next]);

  const current = features[active];
  const Icon = current.icon;

  return (
    <div className="flex flex-col">
      {/* Logo + tagline */}
      <div className="mb-8 md:mb-12">
        <div className="mb-4 flex items-center gap-2.5">
          <img
            src="/logo.png"
            alt="Matrix OS"
            className="size-8 rounded-lg shadow-sm"
          />
          <span className="font-mono text-sm font-semibold tracking-tight text-foreground">
            matrix-os
          </span>
        </div>
        <h1 className="mb-2 text-2xl font-bold tracking-tight text-foreground md:text-3xl lg:text-4xl">
          {heading}
        </h1>
        <p className="text-sm text-muted-foreground md:text-base">
          {subheading}
        </p>
      </div>

      {/* Feature slider (desktop) */}
      <div
        className="hidden md:block"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div className="rounded-2xl border border-border/60 bg-card/80 p-6 shadow-sm backdrop-blur-sm transition-all duration-300">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <Icon className="size-5 text-primary" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {current.title}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {current.description}
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-border/50 bg-secondary/70 p-3">
            {current.visual}
          </div>
        </div>

        {/* Dots */}
        <div className="mt-4 flex items-center gap-2">
          {features.map((_, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === active
                  ? "w-6 bg-primary"
                  : "w-1.5 bg-foreground/20 hover:bg-foreground/40"
              }`}
              aria-label={`Feature ${i + 1}`}
            />
          ))}
        </div>
      </div>

      {/* Mobile: condensed badges */}
      <div className="flex flex-wrap gap-2 md:hidden">
        {features.slice(0, 3).map((feature) => {
          const FeatureIcon = feature.icon;
          return (
            <div
              key={feature.title}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/80 px-3 py-2"
            >
              <FeatureIcon className="size-3.5 text-primary" />
              <span className="text-xs font-medium text-foreground">
                {feature.title}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
