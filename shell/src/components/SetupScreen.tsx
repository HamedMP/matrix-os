"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { KeyRoundIcon, TerminalIcon, CheckCircleIcon, LoaderIcon, ExternalLinkIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface SetupScreenProps {
  onComplete: () => void;
  onOpenTerminal: () => void;
}

export function SetupScreen({ onComplete, onOpenTerminal }: SetupScreenProps) {
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<"idle" | "validating" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit() {
    if (!apiKey.trim()) return;
    setStatus("validating");
    setErrorMsg("");

    try {
      const res = await fetch(`${GATEWAY_URL}/api/settings/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await res.json();

      if (data.valid) {
        setStatus("success");
        setTimeout(onComplete, 800);
      } else {
        setStatus("error");
        setErrorMsg(data.error ?? "Validation failed");
      }
    } catch {
      setStatus("error");
      setErrorMsg("Could not reach the server");
    }
  }

  function handleClaudeCode() {
    onOpenTerminal();
    onComplete();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-8 max-w-2xl w-full px-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Welcome to Matrix OS
          </h1>
          <p className="text-muted-foreground">
            Choose how you want to get started
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
          {/* Card 1: API Key */}
          <Card className="relative overflow-hidden">
            <CardHeader>
              <div className="flex items-center gap-2">
                <KeyRoundIcon className="size-5 text-primary" />
                <CardTitle className="text-base">Connect Your AI</CardTitle>
              </div>
              <CardDescription>
                Paste your Anthropic API key to enable the full AI experience
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                type="password"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (status === "error") setStatus("idle");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                }}
                disabled={status === "validating" || status === "success"}
              />

              {status === "error" && (
                <p className="text-sm text-destructive">{errorMsg}</p>
              )}

              <Button
                className="w-full"
                onClick={handleSubmit}
                disabled={!apiKey.trim() || status === "validating" || status === "success"}
              >
                {status === "validating" && <LoaderIcon className="size-4 animate-spin" />}
                {status === "success" && <CheckCircleIcon className="size-4" />}
                {status === "idle" || status === "error" ? "Validate & Save" : null}
                {status === "validating" ? "Checking..." : null}
                {status === "success" ? "Connected" : null}
              </Button>

              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Get an API key <ExternalLinkIcon className="size-3" />
              </a>
            </CardContent>
          </Card>

          {/* Card 2: Claude Code */}
          <Card className="relative overflow-hidden">
            <CardHeader>
              <div className="flex items-center gap-2">
                <TerminalIcon className="size-5 text-primary" />
                <CardTitle className="text-base">Use Claude Code</CardTitle>
              </div>
              <CardDescription>
                Build apps with your existing Claude subscription via the terminal
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Open the terminal and use Claude Code to build, customize, and
                extend your OS. No API key needed.
              </p>
              <Button
                variant="outline"
                className="w-full"
                onClick={handleClaudeCode}
              >
                <TerminalIcon className="size-4" />
                Open Terminal
              </Button>
            </CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground text-center max-w-md">
          You can always add or change your API key later in Settings.
        </p>
      </div>
    </div>
  );
}
