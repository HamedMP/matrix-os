"use client";

import { useState } from "react";
import { KeyRoundIcon, Loader2Icon, CheckCircle2Icon } from "lucide-react";

interface ApiKeyInputProps {
  onSubmit: (key: string) => void;
  result: { valid: boolean; error?: string } | null;
  onSkip: () => void;
}

export function ApiKeyInput({ onSubmit, result, onSkip }: ApiKeyInputProps) {
  const [key, setKey] = useState("");
  const isValidating = result === null && key.length > 10;
  const isValid = result?.valid === true;
  const error = result?.valid === false ? result.error : null;

  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-md mx-auto">
      <div className="flex items-center gap-3">
        <KeyRoundIcon className="size-6 text-primary" />
        <h3 className="text-lg font-semibold text-foreground">Connect Your AI</h3>
      </div>

      <p className="text-sm text-muted-foreground text-center">
        Paste your Anthropic API key to enable the full AI experience.
      </p>

      <div className="w-full space-y-3">
        <input
          type="password"
          placeholder="sk-ant-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && key.startsWith("sk-ant-")) {
              onSubmit(key);
            }
          }}
          className="w-full px-4 py-3 rounded-xl bg-muted/50 border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all text-sm font-mono"
          disabled={isValid}
        />

        {error && (
          <p className="text-xs text-destructive text-center">{error}</p>
        )}

        <button
          onClick={() => onSubmit(key)}
          disabled={!key.startsWith("sk-ant-") || isValid}
          className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
        >
          {isValidating && <Loader2Icon className="size-4 animate-spin" />}
          {isValid && <CheckCircle2Icon className="size-4" />}
          {isValid ? "Connected" : isValidating ? "Validating..." : "Connect"}
        </button>
      </div>

      <button
        onClick={onSkip}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        Skip — use Claude Code in terminal instead
      </button>

      <p className="text-[11px] text-muted-foreground/60 text-center">
        Get your key at{" "}
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-muted-foreground"
        >
          console.anthropic.com
        </a>
      </p>
    </div>
  );
}
