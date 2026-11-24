import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  botDraftPatchMatchesChoices, isManagedCustomBot, type BotCreationSnapshot, type BotRecipeSetupContext, type CanonicalProviderCatalog,
  type ChatAgent, type ChatAgentRecipeCatalog
} from "@matrix-os/contracts";
import { ChatPromptInput } from "../chat/composer/ChatPromptInput.js";
import type { AgentDraft } from "./AgentEditor.js";
import type { ChatAgentIntegrationConnection } from "./client.js";
import type { CreationConversationClient } from "./creation-conversation.js";
import { useCreationConversation } from "./useCreationConversation.js";

import { AgentSetupResources } from "./AgentSetupResources.js";
import { AgentSetupTranscript } from "./AgentSetupTranscript.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "./theme.js";

export function AgentSetupChat({ client, draft, editing, catalog, recipes, connections, pending, change,
  seed = { kind: "scratch" }, resourcesLoading = false, recipeContext, children, reviewInitially = false, onOpenResourceSettings, onRefreshResources }: {
  seed?: BotCreationSnapshot["seed"];
  resourcesLoading?: boolean;
  onRefreshResources?(): void;
  onOpenResourceSettings?(resource: "integrations" | "mcp"): void;
  recipeContext?: BotRecipeSetupContext;
  children?: ReactNode;
  reviewInitially?: boolean;
  client: CreationConversationClient;
  draft: AgentDraft;
  editing: "new" | ChatAgent;
  catalog: CanonicalProviderCatalog | null;
  recipes: ChatAgentRecipeCatalog | null;
  connections: ChatAgentIntegrationConnection[];
  pending: boolean;
  change(value: Partial<AgentDraft>): void;
}) {
  const [sessionId] = useState(() => `setup_${crypto.randomUUID().replaceAll("-", "")}`);
  const [revision, setRevision] = useState({ key: draft.requestId, number: 0 });
  let currentRevision = revision;
  if (revision.key !== draft.requestId) {
    currentRevision = { key: draft.requestId, number: revision.number + 1 };
    setRevision(currentRevision);
  }
  const [review, setReview] = useState(reviewInitially);
  const [resourceVisit, setResourceVisit] = useState(0);
  const refreshOnReturn = useEffectEvent(() => onRefreshResources?.());
  useEffect(() => {
    if (!resourceVisit) return;
    const focused = () => refreshOnReturn();
    window.addEventListener("focus", focused, { once: true });
    return () => window.removeEventListener("focus", focused);
  }, [resourceVisit]);
  const openSettings = (resource: "integrations" | "mcp") => {
    setResourceVisit(value => value + 1);
    onOpenResourceSettings?.(resource);
  };
  const lastApplied = useRef(-1);
  const editableRecipe = editing === "new" || !editing.recipeRef || isManagedCustomBot(editing) || Boolean(recipeContext);
  const { name, description, instructions, selection, recipe } = draft;
  const skills = recipes?.enabled && editableRecipe ? recipes.skills
    .filter(skill => skill.id !== "matrix-jev-email-triage").map(skill => skill.id) : [];
  const services = recipes?.enabled && editableRecipe ? recipes.services
    .filter(service => connections.some(account => account.service === service.id && account.status === "active"))
    .map(service => service.id) : [];
  const snapshot: BotCreationSnapshot = {
    sessionId, draftRevision: currentRevision.number, seed,
    draft: { name, description, instructions, selection, recipe }, choices: { skills, services },
  };
  const conversation = useCreationConversation({
    client, snapshot, catalog, ready: !resourcesLoading && !pending,
    onProposal(proposal) {
      if (pending || proposal.sessionId !== sessionId || proposal.baseDraftRevision !== snapshot.draftRevision
        || lastApplied.current === snapshot.draftRevision || !botDraftPatchMatchesChoices(snapshot, proposal.patch)) return false;
      if (proposal.patch.recipe !== undefined && (!editableRecipe || draft.recipe?.jevInboxLabeling)) return false;
      lastApplied.current = snapshot.draftRevision;
      change(proposal.patch);
      setReview(true);
      return true;
    },
  });
  const send = async () => {
    if (await conversation.send(conversation.text)) conversation.setText("");
  };
  const disabled = pending || !conversation.available || conversation.busy || Boolean(conversation.activeRunId);
  const question = conversation.question?.baseDraftRevision === currentRevision.number ? conversation.question : null;
  return <section aria-label="Agent setup conversation" className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4">
    <div className="grid min-w-0 content-start gap-4">
      {recipeContext ? <AgentSetupResources context={recipeContext} catalog={recipes} /> : null}
      <AgentSetupTranscript detail={conversation.detail} questions={conversation.questions}
        openingMessageId={conversation.openingMessageId} question={question} disabled={disabled}
        onAnswer={value => { void conversation.answer(value); }} />
      {conversation.busy ? <p role="status" className="text-sm" style={chatAgentMutedStyle}>Thinking…</p> : null}
      {resourcesLoading ? <p role="status" className="text-sm" style={chatAgentMutedStyle}>Loading setup resources…</p> : null}
      {!resourcesLoading && !pending && !conversation.available && !conversation.accessLost ? <p className="text-sm" role="status">Setup Chat is unavailable.</p> : null}
      {conversation.error ? <div className="grid justify-items-start gap-2">
        <p className="text-sm" role="alert">{conversation.error}</p>
        {conversation.retryIntent && !conversation.accessLost ? <button type="button" className={chatAgentButtonClass}
          disabled={disabled} onClick={() => void conversation.retry()}>{conversation.retryIntent === "open" ? "Retry setup" : "Retry message"}</button> : null}
      </div> : null}
      {conversation.activeRunId && !conversation.busy ? <button type="button" className={`${chatAgentButtonClass} justify-self-start`}
        onClick={() => void conversation.refresh()}>Check setup progress</button> : null}
      {children ? review ? <section className="grid gap-3 rounded-xl border p-4" aria-label="Configuration preview">
        <h3 className="text-sm font-semibold">Configuration preview</h3>
        {onOpenResourceSettings ? <div className="flex flex-wrap gap-2" aria-label="Resource settings">
          <button type="button" className={chatAgentButtonClass} disabled={pending} onClick={() => openSettings("integrations")}>Integration settings</button>
          <button type="button" className={chatAgentButtonClass} disabled={pending} onClick={() => openSettings("mcp")}>MCP settings</button>
          {resourceVisit > 0 && onRefreshResources ? <button type="button" className={chatAgentButtonClass} disabled={pending || resourcesLoading}
            onClick={onRefreshResources}>Check resources</button> : null}
        </div> : null}
        {children}
      </section> : <button type="button" className="justify-self-start text-sm underline underline-offset-4"
        disabled={pending} onClick={() => setReview(true)}>Review configuration</button> : null}
    </div>
    <div className="sticky bottom-0 mt-auto pb-4 pt-2">
      <ChatPromptInput value={conversation.text} onChange={conversation.setText} onSubmit={() => void send()}
        disabled={disabled} ariaLabel="Message about this agent" placeholder="Message about this agent…"
        sendLabel="Send setup message" layout="narrow" maxLength={8_000} busy={Boolean(conversation.activeRunId)}
        onAbort={conversation.activeRunId ? () => void conversation.abort() : undefined} />
    </div>
  </section>;
}
