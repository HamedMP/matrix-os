import { groupBotAuthority, type BotAuthorityView } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import type { ChatAgentClient } from "../client.js";
import { chatAgentMutedStyle } from "../theme.js";

/** Read-only, authenticated app access; editing identity never grants an integration. */
export function BotEditorApps({ agentId, client, authority }: {
  agentId: string; client?: ChatAgentClient; authority?: BotAuthorityView | null;
}) {
  const bots = client?.bots;
  const [result, setResult] = useState<{ bots: typeof bots; agentId: string; view: BotAuthorityView | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (authority !== undefined || !bots) return;
    let current = true;
    void bots.authority(agentId).then(view => {
      if (current) setResult({ bots, agentId, view, failed: false });
    }).catch((error: unknown) => {
      console.warn("[bots] Editor app access unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (current) setResult({ bots, agentId, view: null, failed: true });
    });
    return () => { current = false; };
  }, [bots, agentId, authority]);
  const scoped = result && result.bots === bots && result.agentId === agentId ? result : null;
  const view = authority !== undefined ? authority : scoped?.view;
  const groups = view ? groupBotAuthority(view) : [];
  return <section aria-label="Bot apps" className="grid gap-2 text-xs">
    <h3 className="font-semibold">Apps</h3>
    {view ? groups.length ? groups.map(connection => <p key={connection.service} className="flex justify-between gap-3">
      <span>{connection.service.replaceAll("_", " ")}</span>
      <span style={chatAgentMutedStyle}>{connection.state === "granted" ? "Access granted" : connection.state === "not_connected" ? "Not connected" : "Permission required"}</span>
    </p>) : <p style={chatAgentMutedStyle}>No app access recorded.</p>
      : <p role="status" style={chatAgentMutedStyle}>{scoped?.failed || !bots ? "App access is unavailable. Close settings and try again." : "Loading app access…"}</p>}
  </section>;
}
