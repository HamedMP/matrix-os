"use client";

import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkdownEditor } from "../MarkdownEditor";
import { getGatewayUrl } from "@/lib/gateway";
import { UserIcon } from "lucide-react";
import { AgentRuntimePanel } from "./AgentRuntimePanel";
import type { TerminalLaunchAction } from "@/lib/terminal-launch";

const GATEWAY = getGatewayUrl();
const AGENT_FETCH_TIMEOUT_MS = 10_000;

interface Identity {
  handle?: string;
  aiHandle?: string;
  displayName?: string;
}

export function AgentSection({
  onOpenTerminal,
}: {
  onOpenTerminal?: (action: TerminalLaunchAction) => void;
}) {
  const [identity, setIdentity] = useState<Identity>({});
  const [soulContent, setSoulContent] = useState("");
  const [saving, setSaving] = useState(false);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- guarded run-once mount load (empty deps): both requests carry AbortSignal.timeout, the `cancelled` flag gates every setState, and the controller aborts in cleanup, so this is the correct fetch-on-mount pattern; a data-fetching library would add no safety here.
  useEffect(() => {
    let cancelled = false;

    fetch(`${GATEWAY}/api/identity`, {
      signal: AbortSignal.timeout(AGENT_FETCH_TIMEOUT_MS),
    })
      .then((r) => r.ok ? r.json() : {})
      .then((data) => { if (!cancelled) setIdentity(data); })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn("Failed to load identity settings", error);
        }
      });

    fetch(`${GATEWAY}/files/system/soul.md`, {
      signal: AbortSignal.timeout(AGENT_FETCH_TIMEOUT_MS),
    })
      .then((r) => r.ok ? r.text() : "")
      .then((text) => { if (!cancelled) setSoulContent(text); })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn("Failed to load soul settings", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveSoul = async (content: string) => {
    setSaving(true);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to reset `saving` on every path; the code is correct and the finalizer must run whether the request resolves, rejects, or throws.
    try {
      await fetch(`${GATEWAY}/api/bridge/data`, {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_FETCH_TIMEOUT_MS),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write",
          app: "_system",
          key: "soul-backup",
          value: content,
        }),
      });
      setSoulContent(content);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h2 className="text-lg font-semibold">Agent</h2>

      <AgentRuntimePanel onOpenTerminal={onOpenTerminal} />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <UserIcon className="size-4" />
            Identity
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Display Name</span>
              <p className="font-medium">{identity.displayName || "Not set"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Handle</span>
              <p className="font-medium">
                {identity.handle ? (
                  <Badge variant="secondary">@{identity.handle}:matrix-os.com</Badge>
                ) : "Not set"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">AI Handle</span>
              <p className="font-medium">
                {identity.aiHandle ? (
                  <Badge variant="secondary">@{identity.aiHandle}:matrix-os.com</Badge>
                ) : "Not set"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">SOUL (Personality)</CardTitle>
        </CardHeader>
        <CardContent>
          <MarkdownEditor
            content={soulContent}
            onSave={handleSaveSoul}
            saving={saving}
            placeholder="Define your agent's personality, tone, and boundaries..."
          />
        </CardContent>
      </Card>
    </div>
  );
}
