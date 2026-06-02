"use client";

import { useState } from "react";
import { CheckIcon, ClipboardIcon } from "lucide-react";

type AgentSetupCopyButtonProps = {
  text: string;
};

export function AgentSetupCopyButton({ text }: AgentSetupCopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copyPrompt() {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopied(false);
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      const message = error instanceof Error ? error.message : "clipboard unavailable";
      console.warn("Failed to copy Matrix agent setup prompt", { message });
      setCopied(false);
    }
  }

  const Icon = copied ? CheckIcon : ClipboardIcon;

  return (
    <button
      type="button"
      onClick={copyPrompt}
      className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[11px] font-medium uppercase tracking-[0.12em] transition-opacity hover:opacity-80"
      style={{ backgroundColor: "#434E3F", color: "#E2E2CF" }}
      aria-label={copied ? "Copied agent setup prompt" : "Copy agent setup prompt"}
      title={copied ? "Copied" : "Copy prompt"}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
