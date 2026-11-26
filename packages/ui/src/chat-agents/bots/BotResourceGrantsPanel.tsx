import type { BotResourceGrantList } from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";

export interface BotResourceGrantsClient {
  list(agentId: string): Promise<BotResourceGrantList>;
  grant(agentId: string, candidateId: string): Promise<unknown>;
  revoke(agentId: string, grantId: string, baseRevision: number): Promise<unknown>;
}

const resources = [
  { kind: "slack_channel", heading: "Slack channels", empty: "No approved Slack channels are available." },
  { kind: "github_repository", heading: "GitHub repositories", empty: "No approved GitHub repositories are available." },
] as const;

export function BotResourceGrantsPanel({ agentId, client }: { agentId: string; client: BotResourceGrantsClient }) {
  const [loaded, setLoaded] = useState<{ agentId: string; client: BotResourceGrantsClient; view: BotResourceGrantList } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lifecycle = useRef(0);
  const busy = useRef(false);
  const view = loaded?.agentId === agentId && loaded.client === client ? loaded.view : null;

  useEffect(() => {
    const current = ++lifecycle.current;
    setLoaded(null);
    setError("");
    setPending(false);
    busy.current = false;
    void client.list(agentId).then((data) => {
      if (current === lifecycle.current) setLoaded({ agentId, client, view: data });
    }).catch((failure: unknown) => {
      console.warn("[bots] Scoped app access unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current === lifecycle.current) setError("Could not load scoped app access.");
    });
    return () => { lifecycle.current += 1; };
  }, [agentId, client, refresh]);

  async function change(action: () => Promise<unknown>) {
    if (busy.current) return;
    const current = lifecycle.current;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await action();
      if (current !== lifecycle.current) return;
      const data = await client.list(agentId);
      if (current === lifecycle.current) setLoaded({ agentId, client, view: data });
    } catch (failure: unknown) {
      console.warn("[bots] Scoped app access change failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (current === lifecycle.current) setError("Could not confirm the change. Refresh scoped access and try again.");
    } finally {
      if (current === lifecycle.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }

  return <section aria-label="Scoped app access" className="grid gap-3 text-xs">
    <h4 className="font-semibold">Scoped app access</h4>
    <p style={chatAgentMutedStyle}>Choose what this Agent can read. To route review requests, grant its repository first.</p>
    {error ? <div className="grid justify-items-start gap-2">
      <p role="alert">{error}</p>
      <button type="button" className={chatAgentButtonClass} disabled={pending} onClick={() => setRefresh(value => value + 1)}>Refresh scoped access</button>
    </div> : null}
    {!view && !error ? <p role="status" style={chatAgentMutedStyle}>Loading scoped app access…</p> : null}
    {view ? resources.map(({ kind, heading, empty }) => {
      const grants = view.grants.filter(grant => grant.kind === kind);
      const candidates = view.candidates.filter(candidate => candidate.kind === kind);
      return <div key={kind} className="grid gap-2 rounded-lg border border-current/10 p-3">
        <h5 className="font-medium">{heading}</h5>
        {kind === "slack_channel" && view.pilotChannel ? <div>
          <p>#{view.pilotChannel.name} · Existing summary route</p>
          <p style={chatAgentMutedStyle}>Use this Agent’s private Chat to manage its summary rule.</p>
        </div> : null}
        {!grants.length && !candidates.length && !(kind === "slack_channel" && view.pilotChannel) ? <p style={chatAgentMutedStyle}>{empty}</p> : null}
        {grants.map(grant => <div key={grant.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 [overflow-wrap:anywhere]">{grant.label} · {grant.routeKind ? "Results in this Agent’s private Chat" : "Read only"}</span>
          <button type="button" className={chatAgentButtonClass} disabled={pending || Boolean(error)}
            aria-label={`Revoke read access to ${grant.label}`}
            onClick={() => { void change(() => client.revoke(agentId, grant.id, grant.revision)); }}>Revoke</button>
        </div>)}
        {candidates.map(candidate => <div key={candidate.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 [overflow-wrap:anywhere]">{candidate.label}</span>
          <button type="button" className={chatAgentButtonClass} disabled={pending || Boolean(error)}
            aria-label={candidate.routeKind ? `Assign ${candidate.label} to this Agent` : `Grant read access to ${candidate.label}`}
            onClick={() => { void change(() => client.grant(agentId, candidate.id)); }}>{candidate.routeKind ? "Assign route" : "Grant read access"}</button>
        </div>)}
      </div>;
    }) : null}
  </section>;
}
