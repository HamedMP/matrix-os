import { useRef, useState } from "react";
import {
  botDraftPatchMatchesChoices, isManagedCustomBot, type BotCreationSnapshot, type CanonicalProviderCatalog,
  type ChatAgent, type ChatAgentRecipeCatalog
} from "@matrix-os/contracts";
import { ChatPromptInput } from "../chat/composer/ChatPromptInput.js";
import type { AgentDraft } from "./AgentEditor.js";
import type { ChatAgentIntegrationConnection } from "./client.js";
import type { CreationConversationClient } from "./creation-conversation.js";
import { useCreationConversation } from "./useCreationConversation.js";

export function AgentSetupChat({ client, draft, editing, catalog, recipes, connections, pending, change }: {
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
  const lastApplied = useRef(-1);
  const editableRecipe = editing === "new" || !editing.recipeRef || isManagedCustomBot(editing);
  const { name, description, instructions, selection, recipe } = draft;
  const skills = recipes?.enabled && editableRecipe ? recipes.skills
    .filter(skill => skill.id !== "matrix-jev-email-triage").map(skill => skill.id) : [];
  const services = recipes?.enabled && editableRecipe ? recipes.services
    .filter(service => connections.some(account => account.service === service.id && account.status === "active"))
    .map(service => service.id) : [];
  const snapshot: BotCreationSnapshot = {
    sessionId, draftRevision: currentRevision.number, seed: { kind: "scratch" },
    draft: { name, description, instructions, selection, recipe }, choices: { skills, services },
  };
  const conversation = useCreationConversation({
    client, snapshot, catalog,
    isCurrent: () => !pending,
    onProposal(proposal) {
      if (proposal.sessionId !== sessionId || proposal.baseDraftRevision !== snapshot.draftRevision
        || lastApplied.current === snapshot.draftRevision || !botDraftPatchMatchesChoices(snapshot, proposal.patch)) return false;
      if (proposal.patch.recipe !== undefined && (!editableRecipe || draft.recipe?.jevInboxLabeling)) return false;
      lastApplied.current = snapshot.draftRevision;
      change(proposal.patch);
      return true;
    },
  });
  const send = async () => {
    if (await conversation.send(conversation.text)) conversation.setText("");
  };
  return <section className="mt-4 grid gap-2" aria-label="Agent setup conversation">
    <p className="text-sm">{editing === "new" ? "What should this agent do?" : "What would you like to change?"}</p>
    {conversation.detail?.messages.length ? <ol aria-label="Setup messages" className="grid max-h-56 gap-2 overflow-y-auto text-sm">
      {conversation.detail.messages.filter(message => message.role === "user" || message.role === "assistant").map(message => {
        const body = message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
        return body ? <li key={message.id} className="whitespace-pre-wrap break-words">
          <strong>{message.role === "user" ? "You" : "Matrix AI"}</strong> {body}
        </li> : null;
      })}
    </ol> : null}
    <ChatPromptInput value={conversation.text} onChange={conversation.setText} onSubmit={() => void send()}
      disabled={pending || !conversation.available || conversation.busy || Boolean(conversation.activeRunId)}
      ariaLabel="Message about this agent" placeholder="Describe its role, instructions, skills or connected sources"
      sendLabel="Send setup message" layout="narrow" maxLength={8_000} busy={Boolean(conversation.activeRunId)}
      onAbort={conversation.activeRunId ? () => void conversation.abort() : undefined} />
    {!conversation.available ? <p className="text-xs" role="status">Matrix AI drafting is unavailable. You can edit the fields below.</p> : null}
    {conversation.error ? <p className="text-xs" role="alert">{conversation.error}</p> : null}
    {conversation.activeRunId && !conversation.busy ? <button type="button" className="justify-self-start text-sm underline"
      onClick={() => void conversation.refresh()}>Check setup progress</button> : null}
    <h4 className="mt-2 text-sm font-semibold">Configuration preview</h4>
  </section>;
}
