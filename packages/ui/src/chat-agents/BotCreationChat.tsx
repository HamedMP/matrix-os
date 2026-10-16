import { useState, type ReactNode } from "react";
import type { BotRecipeSummary, CanonicalProviderCatalog, BotCreationSnapshot } from "@matrix-os/contracts";
import type { CanonicalProviderChoice } from "../canonical-provider-choice.js";
import { Dialog } from "../Dialog.js";
import { AgentEditor } from "./AgentEditor.js";
import type { AgentDraft, AgentDraftChange } from "./agent-draft.js";
import type { AgentInspiration } from "./agent-inspirations.generated.js";
import type { ChatAgentClient, ChatAgentIntegrationConnection } from "./client.js";
import { MatrixBotModelField } from "./bots/MatrixBotModelField.js";
import { BotTaskExecutorField } from "./bots/BotTaskExecutorField.js";
import { useBotConnections } from "./bots/use-bot-connections.js";
import { useBotCreation } from "./use-bot-creation.js";
import { chatAgentButtonClass as button, chatAgentPrimaryButtonClass as primary, chatAgentMutedStyle as muted, chatAgentSurfaceStyle } from "./theme.js";
import { RecipeRabbit } from "./RecipeRabbit.js";

export type BotCreationSeed = { kind: "scratch" } | { kind: "recipe"; recipe: BotRecipeSummary }
  | { kind: "inspiration"; inspiration: AgentInspiration };
export type BotTaskExecutorIntent = AgentDraft["taskExecutor"];
export type BotCreationChange = AgentDraftChange;
export type BotCreationChatProps = {
  draftBar?: ReactNode; snapshot: BotCreationSnapshot; sessionId: string; revision: number; draft: AgentDraft; seed: BotCreationSeed; taskExecutor: BotTaskExecutorIntent;
  client: ChatAgentClient; catalog: CanonicalProviderCatalog | null; models: readonly CanonicalProviderChoice[];
  pending: boolean; isCurrent(): boolean;
  applyDraftChange(expectedRevision: number, patch: BotCreationChange): boolean;
};
export type RenderBotCreationChat = (props: BotCreationChatProps) => ReactNode;

export function BotCreationChat({ seed, client, models, catalog, catalogLoading, recipeCatalog, connections,
  recipeLoading, recipeError, connectionError, renderCreationChat, onOpen, onCancel, onSetup, onRefreshCatalog, onRetryRecipe, onPendingChange }: {
  seed: BotCreationSeed; client: ChatAgentClient; models: readonly CanonicalProviderChoice[];
  catalog: CanonicalProviderCatalog | null; catalogLoading: boolean;
  recipeCatalog: React.ComponentProps<typeof AgentEditor>["recipeCatalog"]; connections: ChatAgentIntegrationConnection[];
  recipeLoading: boolean; recipeError: string; connectionError: string; renderCreationChat: RenderBotCreationChat;
  onOpen?: (chatId: string) => void | Promise<void>; onCancel(): void; onSetup?: () => void;
  onPendingChange?: (pending: boolean) => void;
  onRefreshCatalog(): void; onRetryRecipe(): void;
}) {
  const creation = useBotCreation({ seed, client, models, catalog, catalogLoading, recipeCatalog, onOpen, onPendingChange });
  const [mode, setMode] = useState<"chat" | "form">("chat"), [details, setDetails] = useState(false);
  const discovery = useBotConnections(client.bots?.connections ? client.bots as Required<Pick<NonNullable<ChatAgentClient["bots"]>, "connections">> : undefined);
  const { draft, revision, sessionId, pending, error, phase, retained, applyDraftChange } = creation;
  const taskExecutor = draft.taskExecutor ?? null;
  const snapshot: BotCreationSnapshot = { sessionId, draftRevision: revision,
    seed: seed.kind === "recipe" ? { kind: "template", recipeId: seed.recipe.recipeId, recipeVersion: seed.recipe.version } : { kind: "scratch" },
    draft: { name: draft.name, description: draft.description, instructions: draft.instructions, selection: draft.selection,
      ...(Object.hasOwn(draft, "recipe") ? { recipe: draft.recipe } : {}),
      ...(Object.hasOwn(draft, "taskExecutor") ? { taskExecutor: draft.taskExecutor } : {}),
      ...(Object.hasOwn(draft, "coordinatorInstanceId") ? { coordinatorInstanceId: draft.coordinatorInstanceId } : {}) },
  };
  const change = (patch: BotCreationChange) => { applyDraftChange(revision, patch); };
  const fixed = seed.kind === "recipe";
  const fixedTemplate = fixed && creation.seedReady && !creation.seedEditable;
  const name = fixed ? seed.recipe.name : seed.kind === "inspiration" ? seed.inspiration.name : "New agent";
  const draftBar = (<div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border p-3">
      <RecipeRabbit id={fixed ? seed.recipe.recipeId : seed.kind === "inspiration" ? seed.inspiration.id : sessionId} name={draft.name || name} size="small"/>
      <span className="min-w-0 flex-1 truncate text-sm">{draft.name || "Untitled agent"} <span style={muted}>· {retained ? "Saved" : "Draft"}</span></span>
      <button type="button" className={button} disabled={pending} onClick={() => setDetails(true)}>Details</button>
      <button type="button" className={primary} disabled={creation.disabled} onClick={() => { void creation.create(); }}>{pending ? "Creating…" : retained ? "Retry setup" : "Create agent"}</button>
    </div>);
  return <div className="matrix-bot-creation flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6" style={chatAgentSurfaceStyle}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button type="button" className={button} disabled={pending} onClick={onCancel}>Back to templates</button>
      <button type="button" className={button} disabled={pending} onClick={() => setMode("form")}>Use a form</button>
    </div>
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
    {creation.seedLoading ? <p role="status" className="text-xs" style={muted}>Loading template configuration…</p> : null}
    {phase !== "editing" ? <p role="status" className="text-xs" style={muted}>{phase === "saving" ? "Saving your agent…" : phase === "configuring" ? "Setting up the selected task executor…" : phase === "opening" ? "Opening its Chat…" : "Your agent and Chat are ready."}</p> : null}
    <div hidden={mode !== "chat"} inert={mode !== "chat"} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div aria-label="Agent creation introduction" className="mx-auto grid w-full max-w-3xl gap-2 py-5">
        <p className="text-sm">{seed.kind === "scratch" ? "Let’s create your agent." : `Let’s set up ${name}.`}</p>
        <p className="text-lg font-medium">{seed.kind === "scratch" ? "What should your agent do?" : draft.description || (seed.kind === "recipe" ? seed.recipe.description : seed.inspiration.description)}</p>
        {draft.recipe?.integrations.length ? <div className="flex flex-wrap gap-2 text-xs" aria-label="Draft app choices" style={muted}>{draft.recipe.integrations.map(item => <span key={`${item.service}:${item.accountLabel ?? ""}`}>{recipeCatalog?.services.find(service => service.id === item.service)?.name ?? item.service}{item.accountLabel ? ` · ${item.accountLabel}` : " · Ask when run"}</span>)}</div> : null}
        <p className="text-xs" style={muted}>Runs · When you ask</p>
        {fixedTemplate ? <p className="text-xs" style={muted}>This template keeps its required apps and default instructions. Choose its name, model and task executor.</p> : null}
      </div>
      {renderCreationChat({ draftBar, snapshot, sessionId, revision, draft, seed, taskExecutor, client, catalog, models, pending: pending || catalogLoading || creation.seedLoading || !creation.seedReady,
        isCurrent: creation.isCurrent, applyDraftChange })}
    </div>
    <Dialog open={mode === "form"} aria-label="Agent form" onClose={() => { if (!pending) setMode("chat"); }} style={chatAgentSurfaceStyle}>
      <div className="flex items-center justify-between gap-2"><h3 className="text-base font-semibold">Set up your agent</h3><button type="button" className={button} disabled={pending || creation.seedLoading} onClick={() => setDetails(true)}>Details</button></div>
      {<AgentEditor draft={draft} editing="new" pending={pending || creation.seedLoading} models={[...models]} botClient={client.bots} catalog={catalog}
        catalogLoading={catalogLoading} recipeCatalog={recipeCatalog} connections={connections} recipeLoading={recipeLoading}
        recipeError={recipeError} connectionError={connectionError} change={change} onSave={creation.create} onArchive={async () => {}}
        onBack={() => setMode("chat")} cancelLabel="Back to Chat" saveDisabledOverride={creation.disabled} fixedTemplate={fixedTemplate} allowAutomaticSelection={fixed} managedCreation hideModelField onSetup={onSetup} onRefreshCatalog={onRefreshCatalog} onRetryRecipe={onRetryRecipe}/>}
    </Dialog>
    <Dialog open={details} aria-label="Agent draft Details" onClose={() => { if (!pending) setDetails(false); }} style={chatAgentSurfaceStyle}>
      <h3 className="mb-4 text-base font-semibold">Details</h3>
      <MatrixBotModelField botClient={client.bots} selection={draft.selection} models={models} catalog={catalog} catalogLoading={catalogLoading}
        sourceIntent={draft.coordinatorInstanceId} onSourceChange={(coordinatorInstanceId, selection) => change({ coordinatorInstanceId, selection })}
        pending={pending || creation.seedLoading || (fixedTemplate && retained)} allowAutomatic={fixed} requireSelection onChange={selection => change({ selection })} onSetup={onSetup} onRefreshCatalog={onRefreshCatalog}/>
      {client.bots?.connections ? <BotTaskExecutorField connections={discovery.connections} value={taskExecutor?.model ? { connectionId: taskExecutor.connectionId, model: taskExecutor.model } : null}
        connectionIntent={taskExecutor?.connectionId ?? null} onConnectionIntentChange={connectionId => change({ taskExecutor: connectionId ? { connectionId, model: null } : null })}
        pending={pending} onChange={value => change({ taskExecutor: value })} onSetup={onSetup} onRefresh={discovery.refresh}/> : null}
      <button type="button" className={`${button} mt-4`} disabled={pending} onClick={() => setDetails(false)}>Back to draft</button>
    </Dialog>
  </div>;
}
