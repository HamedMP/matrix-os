"use client";

import { useState } from "react";
import { CheckIcon, ClipboardIcon } from "lucide-react";
import { palette as c, fonts } from "./theme";

type CopyPromptButtonProps = {
  text: string;
  label?: string;
  compact?: boolean;
};

export function CopyPromptButton({ text, label = "Copy agent prompt", compact = false }: CopyPromptButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copyPrompt() {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopied(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
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
      data-ph-event="marketing_agent_prompt_copied"
      className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-[0.625rem] leading-none transition-opacity hover:opacity-80"
      style={{
        backgroundColor: "rgba(252,252,248,0.7)",
        border: `1px solid ${c.border}`,
        color: c.deep,
        fontFamily: fonts.sans,
        padding: compact ? "0.5rem 0.75rem" : "0.75rem 1.125rem",
        fontSize: compact ? "0.875rem" : "0.9375rem",
      }}
      aria-label={copied ? "Copied agent setup prompt" : "Copy agent setup prompt"}
    >
      <Icon className="size-4" aria-hidden="true" style={copied ? { color: c.forest } : undefined} />
      {copied ? "Copied — paste it into your agent" : label}
    </button>
  );
}
