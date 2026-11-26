import { AgentDraftReview } from "../AgentDraftReview.js";
import { useBotRecipeSetupContext } from "./use-bot-recipe-setup-context.js";
import { useState } from "react";
import { ChatAgentInputFieldsSchema, ChatAgentRecipeSchema, type BotRecipeSetupContext, type BotRecipeSummary,
  type CanonicalChatModelSelection, type CanonicalProviderCatalog, type ChatAgentRecipeCatalog, type InstantiateBotRequest } from "@matrix-os/contracts";
import type { CanonicalProviderChoice } from "../../canonical-provider-choice.js";
import { AgentSetupChat } from "../AgentSetupChat.js";
import type { AgentSetupResource } from "../AgentSetupResources.js";
import type { AgentDraft } from "../AgentEditor.js";
import type { ChatAgentIntegrationConnection } from "../client.js";
import type { CreationConversationClient } from "../creation-conversation.js";
import { chatAgentButtonClass, chatAgentInputClass, chatAgentMutedStyle, chatAgentPrimaryButtonClass } from "../theme.js";
import { BotTaskExecutorField, type BotExecutorSelection } from "./BotTaskExecutorField.js";
import { MatrixBotModelField } from "./MatrixBotModelField.js";
import type { BotClient } from "./client.js";
import { useBotConnections } from "./use-bot-connections.js";

export type RecipeConfiguration = NonNullable<InstantiateBotRequest["configuration"]>;
export type RecipeSetupResources = { loading?: boolean; onRefreshResources?: () => void; onOpenResourceSettings?: (resource: AgentSetupResource) => void; chat: CreationConversationClient; recipes: ChatAgentRecipeCatalog | null; connections: ChatAgentIntegrationConnection[] };
type SetupProps = {
  setupResources?: RecipeSetupResources; onRefreshCatalog?(): void; onSetup?(): void; botClient?: BotClient;
  creationUncertain?: boolean; creationRetained?: boolean; recipe: BotRecipeSummary; pending: boolean; createDisabled?: boolean; error: string;
  selection: CanonicalChatModelSelection | null; models: readonly CanonicalProviderChoice[];
  catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean; catalogUnavailable?: boolean;
  onSelectionChange(selection: CanonicalChatModelSelection | null): void;
  onCreate(name: string, executor?: BotExecutorSelection | null, configuration?: RecipeConfiguration): void;
  onClose(): void;
};

export function BotRecipeSetup(props: SetupProps) {
  const { recipe, setupResources, botClient } = props;
  const { loaded, key, retry } = useBotRecipeSetupContext(botClient, setupResources ? recipe : undefined);
  if (setupResources && !loaded?.context) return <section aria-label={`Set up ${recipe.name}`} className="mx-auto grid max-w-3xl gap-3 py-4">
    {loaded ? <><p role="alert">Recipe setup is unavailable.</p><button className={chatAgentButtonClass} onClick={retry}>Retry recipe setup</button></>
      : <p role="status">Loading recipe setup…</p>}
    <button className={chatAgentButtonClass} onClick={props.onClose}>Cancel</button>
  </section>;
  return <RecipeDraft key={key} {...props} context={loaded?.context ?? undefined} />;
}

function RecipeDraft({ setupResources, context, onRefreshCatalog, botClient, creationUncertain = false, creationRetained = false, onSetup, recipe, pending, createDisabled, error, selection, models, catalog, catalogLoading, catalogUnavailable, onSelectionChange, onCreate, onClose }: SetupProps & { context?: BotRecipeSetupContext }) {
  const connections = useBotConnections(botClient?.connections ? botClient as Required<Pick<BotClient, "connections">> : undefined);
  const [paused, setPaused] = useState(false);
  const setup = onSetup ? () => { setPaused(true); onSetup(); } : undefined;
  const [executorIncomplete, setExecutorIncomplete] = useState(false);
  const [executor, setExecutor] = useState<BotExecutorSelection | null>(null);
  const [fields, setFields] = useState<AgentDraft>(() => ({ name: recipe.name, description: context?.description ?? recipe.description,
    instructions: context?.instructions ?? "", selection, requestId: crypto.randomUUID() }));
  const draft = { ...fields, selection };
  const locked = pending || creationRetained || creationUncertain;
  const change = (value: Partial<AgentDraft>) => {
    if (!locked) setFields(previous => ({ ...previous, ...value, requestId: crypto.randomUUID() }));
  };
  const valid = ChatAgentInputFieldsSchema.shape.name.safeParse(fields.name).success && (!context ||
    ChatAgentInputFieldsSchema.shape.instructions.safeParse(fields.instructions).success &&
    ChatAgentInputFieldsSchema.shape.description.safeParse(fields.description).success &&
    (!fields.recipe || ChatAgentRecipeSchema.safeParse(fields.recipe).success));
  const disabled = pending || createDisabled || executorIncomplete || !selection || !valid;
  const configuration = context && (context.instructions !== fields.instructions || context.description !== fields.description || fields.recipe)
    ? { description: fields.description, instructions: fields.instructions, ...(fields.recipe ? { recipe: fields.recipe } : {}) } : undefined;
  const fieldsView = <>
    <label className="grid gap-1.5 text-sm">Name<input className={chatAgentInputClass} value={fields.name} maxLength={80} required disabled={locked} onChange={event => change({ name: event.target.value })}/></label>
    {context ? <>
      <label className="grid gap-1.5 text-sm">Description<input className={chatAgentInputClass} value={fields.description} maxLength={400} disabled={locked} onChange={event => change({ description: event.target.value })}/></label>
      <label className="grid gap-1.5 text-sm">Instructions<textarea className={chatAgentInputClass} value={fields.instructions} maxLength={8000} required disabled={locked} rows={4} onChange={event => change({ instructions: event.target.value })}/></label>
      {fields.recipe ? <dl className="grid gap-2 text-sm">
        <div><dt>Additional skills</dt><dd>{fields.recipe.skills.join(", ") || "None"}</dd></div>
        <div><dt>Additional integrations</dt><dd>{fields.recipe.integrations.map(item => item.service).join(", ") || "None"}</dd></div>
        <div><dt>Expected output</dt><dd>{fields.recipe.output}</dd></div>
      </dl> : null}
    </> : null}
    <section className="grid gap-1 text-xs"><h3 className="font-semibold">Apps</h3><p style={chatAgentMutedStyle}>App connections and permissions are requested in the bot’s Chat when needed.</p></section>
    <MatrixBotModelField botClient={botClient} label="Bot model" selection={selection} models={models} catalog={catalog} catalogLoading={catalogLoading} catalogUnavailable={catalogUnavailable} onRefreshCatalog={onRefreshCatalog} onSetup={setup} pending={locked} requireSelection onChange={value => { change({ selection: value }); onSelectionChange(value); }}/>
    {botClient?.connections ? <BotTaskExecutorField connections={connections.connections} value={executor} pending={pending} onSetup={setup} onRefresh={connections.refresh} onIncompleteChange={setExecutorIncomplete} onChange={setExecutor}/> : null}
  </>;
  const controls = <form className="grid gap-3" onSubmit={event => {
    event.preventDefault();
    if (!disabled) onCreate(fields.name.trim(), executor, configuration);
  }}>
    {setupResources ? <AgentDraftReview draft={draft} catalog={setupResources.recipes} models={models}>{fieldsView}</AgentDraftReview> : fieldsView}
    {creationRetained ? <p role="status" className="text-xs">Your bot was created. Retry task executor setup or finish without a task executor.</p> : null}
    <div className="flex flex-wrap gap-2"><button type="submit" className={chatAgentPrimaryButtonClass} disabled={disabled}>{pending ? "Creating…" : creationRetained ? "Retry task setup" : "Create bot"}</button><button type="button" className={chatAgentButtonClass} disabled={pending} onClick={onClose}>Cancel</button></div>
  </form>;
  return <section aria-label={`Set up ${recipe.name}`} className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 py-4">
    {paused ? <button type="button" className={chatAgentButtonClass} onClick={() => { onRefreshCatalog?.(); connections.refresh(); setPaused(false); }}>Resume bot setup</button> : null}
    <div hidden={paused} className="flex min-h-0 flex-1 flex-col gap-3">
      <button type="button" aria-label="Close bot setup" className="self-start text-sm hover:underline" disabled={pending} onClick={onClose}>← Templates</button>
      {setupResources && context ? <AgentSetupChat onRefreshResources={setupResources.onRefreshResources} onOpenResourceSettings={setupResources.onOpenResourceSettings} resourcesLoading={setupResources.loading} client={setupResources.chat} draft={draft} catalog={catalog ?? null} recipes={setupResources.recipes}
        connections={setupResources.connections} pending={locked} change={change} seed={{ kind: "recipe", recipeId: recipe.recipeId, version: recipe.version }}
        recipeContext={context}>{controls}</AgentSetupChat> : <><h2 className="text-base font-semibold">{recipe.name}</h2>{controls}</>}
      {error ? <p role="alert" className="text-xs">{error}</p> : null}
    </div>
  </section>;
}
