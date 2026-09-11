"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getGatewayUrl } from "@/lib/gateway";
import { UserIcon } from "@/lib/hugeicons";
import { MarkdownEditor } from "../MarkdownEditor";

const GATEWAY = getGatewayUrl();
const IDENTITY_FETCH_TIMEOUT_MS = 10_000;

interface Identity {
  handle?: string;
  aiHandle?: string;
  displayName?: string;
}

export function IdentityPersonalitySection() {
  const [identity, setIdentity] = useState<Identity>({});
  const [soulContent, setSoulContent] = useState("");
  const [saving, setSaving] = useState(false);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- guarded run-once mount load: requests are bounded and every state update is cancellation-gated.
  useEffect(() => {
    let cancelled = false;

    fetch(`${GATEWAY}/api/identity`, {
      signal: AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS),
    })
      .then((response) => response.ok ? response.json() : {})
      .then((data) => { if (!cancelled) setIdentity(data); })
      .catch((error: unknown) => {
        if (!cancelled) console.warn("Failed to load identity settings", error);
      });

    fetch(`${GATEWAY}/files/system/soul.md`, {
      signal: AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS),
    })
      .then((response) => response.ok ? response.text() : "")
      .then((text) => { if (!cancelled) setSoulContent(text); })
      .catch((error: unknown) => {
        if (!cancelled) console.warn("Failed to load soul settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveSoul = async (content: string) => {
    setSaving(true);
    // react-doctor-disable-next-line react-hooks-js/todo -- the finalizer must reset `saving` after every request outcome.
    try {
      const response = await fetch(`${GATEWAY}/files/system/soul.md`, {
        method: "PUT",
        signal: AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS),
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        body: content,
      });
      if (!response.ok) throw new Error("SOUL update failed");
      setSoulContent(content);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h2 className="text-lg font-semibold">Identity &amp; personality</h2>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
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
                {identity.handle ? <Badge variant="secondary">@{identity.handle}:matrix-os.com</Badge> : "Not set"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">AI Handle</span>
              <p className="font-medium">
                {identity.aiHandle ? <Badge variant="secondary">@{identity.aiHandle}:matrix-os.com</Badge> : "Not set"}
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
