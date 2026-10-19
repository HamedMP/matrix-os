import { groupBotAuthority, type BotAuthorityView } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import type { ChatAgentClient } from "../client.js";
import { chatAgentMutedStyle } from "../theme.js";

function BotServiceIcon({ name, logoUrl }: { name: string; logoUrl?: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] p-2.5"
    style={{ background: "var(--surface-card-foreground-subtle, #FAFAF6)" }}>
    {logoUrl && !failed ? <img src={logoUrl} alt={name} className="size-6 object-fill" onError={() => setFailed(true)} />
      : <span aria-hidden="true" className="text-sm font-semibold" style={{ color: "var(--accent)" }}>{name.charAt(0).toUpperCase()}</span>}
  </div>;
}

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
  const needsConsent = groups.find(connection => connection.state === "connected_not_granted"
    || connection.accounts?.some(account => account.state === "connected_not_granted"));
  return <section aria-label="Bot apps" className="grid gap-2 text-xs">
    <h3 className="font-semibold">Apps</h3>
    {view ? groups.length ? <>
      {groups.map(connection => <div key={connection.service} className="rounded-lg border border-current/10 p-3">
        <div className="flex items-center gap-3">
          <BotServiceIcon key={connection.logoUrl ?? connection.service} name={connection.serviceName ?? connection.service} logoUrl={connection.logoUrl} />
          <div className="min-w-0 flex-1 font-medium">{connection.serviceName ?? connection.service.replaceAll("_", " ")}</div>
          <span style={chatAgentMutedStyle}>{connection.state === "not_connected" ? "Not connected"
            : connection.state === "granted" && !connection.accounts?.length ? "Status unavailable" : "Connected"}</span>
        </div>
        {connection.accounts?.length ? <div className="mt-2 grid gap-2 pl-14">
          {connection.accounts.map(account => <div key={account.displayKey} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1 basis-40"><div className="[overflow-wrap:anywhere]">{account.label}</div>
              {account.email && <div className="[overflow-wrap:anywhere]" style={chatAgentMutedStyle}>{account.email}</div>}</div>
            <span className="shrink-0" style={chatAgentMutedStyle}>{account.state === "granted" ? "Bot access granted" : "Permission required"}</span>
          </div>)}
        </div> : <p className="mt-2 pl-14" style={chatAgentMutedStyle}>{connection.state === "granted" ? "Saved bot permission; account status unavailable" : connection.state === "not_connected" ? "Connect an account in Integrations." : "Permission required"}</p>}
      </div>)}
      {needsConsent && <p style={chatAgentMutedStyle}>Ask this bot to use {needsConsent.serviceName ?? needsConsent.service} in Chat to choose an account and grant access.</p>}
    </> : <p style={chatAgentMutedStyle}>No app access recorded.</p>
      : <p role="status" style={chatAgentMutedStyle}>{scoped?.failed || !bots ? "App access is unavailable. Close settings and try again." : "Loading app access…"}</p>}
  </section>;
}
