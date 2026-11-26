import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  botDraftPatchMatchesChoices, isManagedCustomBot, type BotCreationDraftPatch, type BotCreationSnapshot, type BotRecipeSetupContext, type CanonicalProviderCatalog,
  type ChatAgent, type ChatAgentRecipeCatalog
} from "@matrix-os/contracts";
import { ChatPromptInput } from "../chat/composer/ChatPromptInput.js";
import type { AgentDraft } from "./AgentEditor.js";
import type { ChatAgentIntegrationConnection } from "./client.js";
import type { CreationConversationClient } from "./creation-conversation.js";
import { useCreationConversation } from "./useCreationConversation.js";

import { AgentSetupResources, type AgentSetupResource } from "./AgentSetupResources.js";
import { AgentSetupTranscript } from "./AgentSetupTranscript.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "./theme.js";

function describeChanges(draft: AgentDraft, patch: BotCreationDraftPatch): string {
  const changed: string[] = [];
  for (const field of ["name", "description", "instructions"] as const) {
    if (patch[field] !== undefined && patch[field] !== draft[field]) changed.push(field);
  }
  if (patch.recipe !== undefined) {
    if (JSON.stringify(patch.recipe?.skills ?? []) !== JSON.stringify(draft.recipe?.skills ?? [])) changed.push("skills");
    if (JSON.stringify(patch.recipe?.integrations ?? []) !== JSON.stringify(draft.recipe?.integrations ?? [])) changed.push("sources");
    if ((patch.recipe?.output ?? "") !== (draft.recipe?.output ?? "")) changed.push("expected output");
  }
  return changed.length ? `Updated ${new Intl.ListFormat("en").format(changed)}.` : "No configuration changes.";
}

export function AgentSetupChat({ client, draft, editing, catalog, recipes, connections, pending, change,
  seed = { kind: "scratch" }, resourcesLoading = false, recipeContext, children, reviewInitially = false, onOpenResourceSettings, onRefreshResources }: {
  seed?: BotCreationSnapshot["seed"];
  resourcesLoading?: boolean;
  onRefreshResources?(): void;
  onOpenResourceSettings?(resource: AgentSetupResource): void;
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
  const [proposal, setProposal] = useState<{ id: string; revision: number; summary: string } | null>(null);

  const [resourceVisit, setResourceVisit] = useState(0);
  const refreshOnReturn = useEffectEvent(() => onRefreshResources?.());
  useEffect(() => {
    if (!resourceVisit) return;
    const focused = () => refreshOnReturn();
    window.addEventListener("focus", focused, { once: true });
    return () => window.removeEventListener("focus", focused);
  }, [resourceVisit]);
  const openSettings = (resource: AgentSetupResource) => {
    setResourceVisit(value => value + 1);
    onOpenResourceSettings?.(resource);
  };
  const lastApplied = useRef(-1);
  const editableRecipe = editing === "new" || !editing.recipeRef || isManagedCustomBot(editing) || Boolean(recipeContext);
  const { name, description, instructions, selection, recipe } = draft;
  const offeredSkills = recipes?.enabled && editableRecipe ? recipes.skills
    .filter(skill => skill.id !== "matrix-jev-email-triage") : [];
  const services = recipes?.enabled && editableRecipe ? recipes.services
    .filter(service => connections.some(account => account.service === service.id && account.status === "active"))
    .map(service => service.id) : [];
  const snapshot: BotCreationSnapshot = {
    sessionId, draftRevision: currentRevision.number, seed,
    draft: { name, description, instructions, selection, recipe }, choices: {
      skills: offeredSkills.map(skill => skill.id), services,
    },
  };
  const conversation = useCreationConversation({
    client, snapshot, catalog, ready: !resourcesLoading && !pending,
    onProposal(next) {
      if (pending || next.sessionId !== sessionId || next.baseDraftRevision !== snapshot.draftRevision
        || lastApplied.current === snapshot.draftRevision || !botDraftPatchMatchesChoices(snapshot, next.patch)) return false;
      if (next.patch.recipe !== undefined && (!editableRecipe || draft.recipe?.jevInboxLabeling)) return false;
      lastApplied.current = snapshot.draftRevision;
      setProposal({ id: next.proposalId, revision: next.baseDraftRevision + 1, summary: describeChanges(draft, next.patch) });
      change(next.patch);
      setReview(true);
      return true;
    },
  });
  const send = async (suggestion?: string) => {
    if (proposal && (suggestion || conversation.text.trim())) {
      setReview(false);
      setProposal(null);
    }
    if (suggestion) await conversation.answer(suggestion);
    else if (await conversation.send(conversation.text)) conversation.setText("");
  };
  const disabled = pending || !conversation.available || conversation.busy || Boolean(conversation.activeRunId);
  const question = conversation.question?.baseDraftRevision === currentRevision.number ? conversation.question : null;
  const questionText = conversation.question?.question;
  const currentProposal = proposal?.revision === currentRevision.number ? proposal : null;
  const proposedRun = currentProposal && conversation.detail?.activities.find(item => item.type === "bot.draft.proposed" && item.proposalId === currentProposal.id)?.runId;
  const confirmation = proposedRun && conversation.detail?.messages.filter(message => message.role === "assistant"
    && message.chatId === conversation.detail?.record.chat.id && message.runId === proposedRun).at(-1)
    ?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("").trim();
  const summary = currentProposal?.summary !== "No configuration changes." && confirmation && confirmation.length <= 140 && !/[\r\n]/.test(confirmation) ? confirmation : currentProposal?.summary;
  const changeResources = (next: AgentDraft["recipe"]) => {
    const updated = next ?? (recipe ? null : undefined);
    if (JSON.stringify(updated) !== JSON.stringify(recipe)) change({ recipe: updated });
  };
  return <section aria-label="Agent setup conversation" className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3">
    <div className="grid min-w-0 content-start gap-3">
      <AgentSetupTranscript detail={conversation.detail} questions={conversation.questions}
        openingMessageId={conversation.openingMessageId} question={question} questionText={questionText}
        reviewing={Boolean(proposal) && !disabled} disabled={disabled}
        onAnswer={value => { void send(value); }} />
      {conversation.busy ? <p role="status" className="text-sm" style={chatAgentMutedStyle}>Preparing the next reply…</p> : null}
      {resourcesLoading ? <p role="status" className="text-sm" style={chatAgentMutedStyle}>Loading setup resources…</p> : null}
      {!resourcesLoading && !pending && !conversation.available && !conversation.accessLost ? <p className="text-sm" role="status">Setup Chat is unavailable.</p> : null}
      {conversation.error ? <div className="grid justify-items-start gap-2">
        <p className="text-sm" role="alert">{conversation.error}</p>
        {conversation.retryIntent && !conversation.accessLost ? <button type="button" className={chatAgentButtonClass}
          disabled={disabled} onClick={() => void conversation.retry()}>{conversation.retryIntent === "open" ? "Retry setup" : "Retry message"}</button> : null}
      </div> : null}
      {conversation.activeRunId && !conversation.busy ? <button type="button" className={`${chatAgentButtonClass} justify-self-start`}
        onClick={() => void conversation.refresh()}>Check setup progress</button> : null}
      <AgentSetupResources context={recipeContext} recipe={recipe} catalog={recipes} connections={connections} skills={offeredSkills}
        loading={resourcesLoading} pending={pending} settingsVisited={resourceVisit > 0} revision={currentRevision.number}
        onChange={editableRecipe && !recipe?.jevInboxLabeling ? changeResources : undefined}
        onOpenSettings={onOpenResourceSettings ? openSettings : undefined} onRefresh={onRefreshResources} />
      {children ? review ? <section key={proposal?.id ?? "manual"} className="grid gap-3 rounded-xl border p-4" aria-label="Configuration preview">
        <h3 className="text-sm font-semibold">Configuration preview</h3>
        {summary ? <p className="text-sm" role="status">{summary}</p> : null}
        {children}
      </section> : <button type="button" className="justify-self-start text-sm underline underline-offset-4"
        disabled={pending} onClick={() => setReview(true)}>Review configuration</button> : null}
    </div>
    <div className="sticky bottom-0 mt-auto pb-4 pt-2">
      <ChatPromptInput value={conversation.text} onChange={conversation.setText} onSubmit={() => void send()}
        disabled={disabled} ariaLabel="Message about this agent"
        placeholder={review ? "Tell me what to change…" : questionText ? "Write your own answer…" : "Message about this agent…"}
        sendLabel="Send setup message" layout="narrow" maxLength={8_000} busy={Boolean(conversation.activeRunId)}
        onAbort={conversation.activeRunId ? () => void conversation.abort() : undefined} />
    </div>
  </section>;
}
