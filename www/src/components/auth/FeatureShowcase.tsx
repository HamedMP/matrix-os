"use client";

import { useState, useEffect, useCallback } from "react";
import {
  CheckCircle2Icon,
  TerminalIcon,
  FolderTreeIcon,
  ShieldIcon,
  MonitorSmartphoneIcon,
  FingerprintIcon,
  SparklesIcon,
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
      "Apps, config, AI personality: all stored as real files. Back up your OS by copying a folder.",
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
      "Same kernel, every platform. Web desktop, Telegram, WhatsApp, Discord, Slack. All connected to one identity.",
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
    <div className="flex flex-col text-center lg:text-left">
      <div className="mx-auto mb-6 max-w-xl lg:mx-0 lg:mb-9">
        <div className="mb-6 flex items-center justify-center gap-3 lg:justify-start">
          <img
            src="/rabbit.svg"
            alt="Matrix OS"
            className="size-9 rounded-xl border border-forest/10 bg-white/72 p-1.5 shadow-sm"
          />
          <span className="font-mono text-sm font-semibold tracking-[-0.03em] text-forest">
            matrix-os
          </span>
        </div>
        <h1 className="text-balance text-[clamp(2.7rem,8vw,5.4rem)] font-semibold leading-[0.9] tracking-[-0.06em] text-forest lg:max-w-[10ch]">
          {heading}
        </h1>
        <p className="mx-auto mt-5 max-w-[46ch] text-[15px] leading-8 text-muted-foreground md:text-base lg:mx-0">
          {subheading}
        </p>
      </div>

      <style>{`
        @keyframes authFade {
          0% { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes authProgressFill {
          0% { width: 0%; }
          100% { width: 100%; }
        }
      `}</style>

      <div
        className="hidden max-w-[540px] lg:block"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {/* eyebrow + counter */}
        <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2 rounded-full border border-ember/18 bg-ember/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] text-ember">
              <SparklesIcon className="size-3.5" aria-hidden="true" />
              Why Matrix OS
            </span>
            <span className="font-mono text-xs tabular-nums text-forest/45">
              {String(active + 1).padStart(2, "0")} / {String(features.length).padStart(2, "0")}
            </span>
          </div>

          {/* editorial keynote slide */}
          <div className="relative mt-7 min-h-[300px]">
            <div key={active} style={{ animation: "authFade 600ms cubic-bezier(0.22,1,0.36,1)" }}>
              <Icon className="size-7 text-ember" aria-hidden="true" strokeWidth={1.6} />

              <h3 className="mt-7 text-balance text-left text-[clamp(2rem,3.4vw,2.9rem)] font-semibold leading-[1.02] tracking-[-0.04em] text-forest">
                {current.title}
              </h3>
              <p className="mt-5 max-w-[40ch] text-left text-[17px] leading-8 text-muted-foreground">
                {current.description}
              </p>

              {/* one quiet supporting visual */}
              <div className="mt-9 border-l-2 border-ember/45 pl-4">
                {current.visual}
              </div>
            </div>
          </div>

        {/* timed progress segments */}
        <div className="mt-10 flex items-center gap-2">
          {features.map((feature, i) => (
            <button
              key={feature.title}
                type="button"
                onClick={() => setActive(i)}
                className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-forest/14"
                aria-label={`Show ${feature.title}`}
                aria-current={i === active}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-forest"
                style={
                  i < active
                    ? { width: "100%" }
                    : i === active
                      ? {
                          width: "0%",
                          animation: "authProgressFill 5s linear forwards",
                          animationPlayState: paused ? "paused" : "running",
                        }
                      : { width: "0%" }
                }
              />
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-md gap-2 lg:hidden">
        {["Free account first", "Provision only when ready", "Your runtime, your files"].map((item) => (
          <div
            key={item}
              className="flex items-center gap-2 rounded-2xl border border-forest/10 bg-white/62 px-4 py-3 text-sm font-medium text-forest"
            >
              <CheckCircle2Icon className="size-4 text-ember" aria-hidden="true" />
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
