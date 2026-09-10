import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatAgent, CanonicalProviderCatalog, CanonicalChatModelSelection } from "@matrix-os/contracts";
import { Dialog } from "../Dialog.js";
import { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { AgentEditor } from "./AgentEditor.js";
import type { ChatAgentClient } from "./client.js";

const button = "rounded-lg border px-3 py-2 text-sm outline-none hover:enabled:bg-[var(--bg-hover,var(--matrix-secondary))] focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))] disabled:opacity-50";
const muted = { color: "var(--text-secondary, var(--matrix-muted-fg))" };
const requestId = () => `req_${crypto.randomUUID().replaceAll("-", "")}`;
type Draft = { name: string; description: string; instructions: string; selection: CanonicalChatModelSelection | null; requestId: string };
type Library = {
  agents: ChatAgent[]; catalog: CanonicalProviderCatalog | null; enabled: boolean;
  loading: boolean; pending: boolean; error: string; notice: string;
  editing: ChatAgent | "new" | null; draft: Draft | null;
};

function AgentLibraryBody({ state, models, edit, change, save, archive, back, setup }: {
  state: Library; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  edit(agent: ChatAgent | "new"): void; change(value: Partial<Draft>): void;
  save(): Promise<void>; archive(): Promise<void>; back(): void; setup?: () => void;
}) {
  if (state.loading) return <p role="status" className="mt-5 text-sm">Loading Agents…</p>;
  if (!state.enabled) return <p className="mt-5 text-sm">Agents are disabled for this computer.</p>;
  if (state.draft && state.editing) return <AgentEditor draft={state.draft} editing={state.editing} pending={state.pending} models={models}
    change={change} onSave={save} onArchive={archive} onBack={back} onSetup={setup} />;
  return <div className="mt-5 grid gap-3">
      <button type="button" className={`${button} justify-self-start`} disabled={!state.catalog || state.agents.length >= 100} onClick={() => edit("new")}>New Agent</button>
      {!state.agents.length && !state.error ? <div className="rounded-xl border px-4 py-6 text-sm" style={muted}>No Agents yet. Create a reusable role for meeting briefs, reviews, or other work you repeat.</div> : null}
      {state.agents.map((agent) => <button key={agent.id} type="button" aria-label={`Edit ${agent.name}`} className={`${button} flex flex-col gap-1 text-left`} onClick={() => edit(agent)}>
        <span className="w-full min-w-0 truncate font-medium" title={agent.name}>{agent.name}</span>
        <span className="w-full min-w-0 truncate text-xs" title={agent.description} style={muted}>{agent.description || "Saved Hermes role"}</span>
      </button>)}
    </div>;
}

function AgentLibrary({ client, onClose, onSetup }: { client: ChatAgentClient; onClose(): void; onSetup?: () => void }) {
  const [state, setState] = useState<Library>({ agents: [], catalog: null, enabled: true,
    loading: true, pending: false, error: "", notice: "", editing: null, draft: null });
  const patch = (value: Partial<Library>) => setState((current) => ({ ...current, ...value }));
  useEffect(() => {
    let current = true;
    void Promise.all([client.list(), client.catalog()]).then(([library, catalog]) => {
      if (current) setState((previous) => ({ ...previous, agents: library.agents, enabled: library.enabled, catalog, loading: false }));
    }).catch((failure: unknown) => {
      console.warn("[chat-agents] Library unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setState((previous) => ({ ...previous, loading: false, error: "Agents could not be loaded. Close and try again." }));
    });
    return () => { current = false; };
  }, [client]);
  const models = useMemo(() => state.catalog ? deriveCanonicalProviderChoices(state.catalog).filter((choice) =>
    choice.driverKind === "hermes" && choice.interactionModes.includes("default") && choice.permissionModes.includes("full_access")) : [], [state.catalog]);
  const edit = (agent: ChatAgent | "new") => {
    const choice = models[0];
    patch({ editing: agent, notice: "", error: "", draft: agent === "new" ? {
      name: "", description: "", instructions: "", requestId: requestId(),
      selection: choice ? { instanceId: choice.instanceId, model: choice.modelId,
        ...(choice.selectedOptions.length ? { options: choice.selectedOptions } : {}) } : null,
    } : { name: agent.name, description: agent.description, instructions: agent.instructions, selection: agent.selection, requestId: requestId() } });
  };
  const change = (value: Partial<Draft>) => {
    const nextRequestId = requestId();
    setState((current) => ({ ...current, error: "",
      draft: current.draft ? { ...current.draft, ...value, requestId: nextRequestId } : null,
    }));
  };
  const save = async () => {
    const draft = state.draft;
    if (state.pending || !draft?.selection || !draft.name.trim() || !draft.instructions.trim()) return;
    patch({ pending: true, error: "" });
    try {
      const fields = { name: draft.name, description: draft.description, instructions: draft.instructions, selection: draft.selection };
      const saved = state.editing === "new"
        ? await client.create({ ...fields, clientRequestId: draft.requestId })
        : await client.update(state.editing!.id, { ...fields, baseRevision: state.editing!.revision });
      setState((current) => ({ ...current, pending: false, editing: null, draft: null,
        agents: [...current.agents.filter((agent) => agent.id !== saved.id), saved],
        notice: `Saved. Type @${saved.name} in a Chat to give this Agent a request.`,
      }));
    } catch (failure: unknown) {
      console.warn("[chat-agents] Save failed:", failure instanceof Error ? failure.name : "UnknownError");
      patch({ pending: false, error: "Agent could not be saved. Your changes are still here. Try again or reopen the Agent to refresh." });
    }
  };
  const archive = async () => {
    if (state.pending || !state.editing || state.editing === "new") return;
    const agent = state.editing;
    patch({ pending: true, error: "" });
    try {
      await client.update(agent.id, { baseRevision: agent.revision, archived: true });
      setState((current) => ({ ...current, pending: false, editing: null, draft: null,
        agents: current.agents.filter((candidate) => candidate.id !== agent.id), notice: "Agent archived. Previous Chat replies are preserved.",
      }));
    } catch (failure: unknown) {
      console.warn("[chat-agents] Archive failed:", failure instanceof Error ? failure.name : "UnknownError");
      patch({ pending: false, error: "Agent could not be archived. Try again." });
    }
  };
  return <Dialog open onClose={() => { if (!state.pending) onClose(); }} aria-label="Agents" className="ph-no-capture" style={{
    background: "var(--bg-surface, var(--matrix-card))", color: "var(--text-primary, var(--matrix-card-fg))",
    border: "1px solid var(--border-default, var(--matrix-border))", maxWidth: "600px", width: "min(92vw, 600px)",
  }}>
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">{state.editing === "new" ? "New Agent" : state.editing ? "Edit Agent" : "Agents"}</h2>
      <button type="button" className={button} disabled={state.pending} onClick={onClose} aria-label="Close Agents">Close</button>
    </div>
    <p className="mt-2 text-sm" style={muted}>Save a role and call it with @ in any Chat. Each request runs through Hermes on this computer.</p>
    <AgentLibraryBody state={state} models={models} edit={edit} change={change} save={save} archive={archive}
      back={() => patch({ editing: null, draft: null, error: "" })} setup={onSetup ? () => { onClose(); onSetup(); } : undefined} />
    {state.error ? <p role="alert" className="mt-4 text-sm">{state.error}</p> : state.notice ? <p role="status" className="mt-4 text-sm">{state.notice}</p> : null}
  </Dialog>;
}

export function ChatAgentsEntry({ client, onSetup, icon, className = "" }: {
  client?: ChatAgentClient; onSetup?: () => void; icon?: ReactNode; className?: string;
}) {
  const [availability, setAvailability] = useState<{ client: ChatAgentClient; enabled: boolean } | null>(null);
  const [opened, setOpened] = useState<ChatAgentClient | null>(null);
  useEffect(() => {
    if (!client) return;
    let current = true;
    const refresh = () => { void client.list().then((result) => {
      if (current) setAvailability({ client, enabled: result.enabled });
    }).catch((failure: unknown) => {
      console.warn("[chat-agents] Feature state unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setAvailability({ client, enabled: false });
    }); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { current = false; window.removeEventListener("focus", refresh); };
  }, [client]);
  if (!client || availability?.client !== client || !availability.enabled) return null;
  return <>
    <button type="button" className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover,var(--matrix-secondary))] focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))] ${className}`} style={{ color: "var(--text-secondary, var(--matrix-muted-fg))" }} onClick={() => setOpened(client)}>{icon}Agents</button>
    {opened === client ? <AgentLibrary client={client} onSetup={onSetup} onClose={() => setOpened(null)} /> : null}
  </>;
}
