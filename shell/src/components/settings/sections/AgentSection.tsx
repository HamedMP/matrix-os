"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MarkdownEditor } from "../MarkdownEditor";
import { getGatewayUrl } from "@/lib/gateway";
import { UserIcon } from "lucide-react";

const GATEWAY = getGatewayUrl();

interface Identity {
  handle?: string;
  aiHandle?: string;
  displayName?: string;
}

export function AgentSection() {
  const [identity, setIdentity] = useState<Identity>({});
  const [soulContent, setSoulContent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${GATEWAY}/api/identity`)
      .then((r) => r.ok ? r.json() : {})
      .then(setIdentity)
      .catch(() => {});

    fetch(`${GATEWAY}/files/system/soul.md`)
      .then((r) => r.ok ? r.text() : "")
      .then(setSoulContent)
      .catch(() => {});
  }, []);

  const handleSaveSoul = useCallback(async (content: string) => {
    setSaving(true);
    try {
      await fetch(`${GATEWAY}/api/bridge/data`, {
        method: "POST",
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
  }, []);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h2 className="text-lg font-semibold">Agent</h2>

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
