import {configureCreatedExecutor} from "./bots/configure-created-executor.js";
import type {BotExecutorSelection} from "./bots/BotTaskExecutorField.js";
import type {BotClient} from "./bots/client.js";
import { BotRecipeSetup } from "./bots/BotRecipeSetup.js";
import { botModelChoiceMatchesSelection, isAutomaticBotSelection, matrixBotSelectableModelChoices, matrixBotModelSelection } from "./bots/MatrixBotModelField.js";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { CanonicalProviderChoice } from "../canonical-provider-choice.js";
import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import { buildAgentRecipePrompt, isLaunchBotRecipeId, LAUNCH_BOT_RECIPE_IDS } from "./recipe-handoff.js";
import type { ChatAgentIntegrationConnection, StartAgentChat } from "./client.js";
import { activeConnections } from "./recipe-integrations.js";
import { JEV_AGENT_DESCRIPTION, JEV_AGENT_NAME } from "./jev-agent-template.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agentInspirations, type AgentInspiration } from "./agent-inspirations.generated.js";
import { RecipeRabbit } from "./RecipeRabbit.js";
import { JevLabelPermission } from "./JevLabelPermission.js";
import { chatAgentButtonClass, chatAgentInputClass, chatAgentMutedStyle } from "./theme.js";
import type { BotRecipeRef, BotRecipeSummary } from "@matrix-os/contracts";
import { useRef } from "react";


const jevRecipe = {
  id: "jev-inbox-triage", name: JEV_AGENT_NAME, category: "Productivity",
  description: JEV_AGENT_DESCRIPTION,
  skills: ["matrix-jev-email-triage", "matrix-integrations"], integrations: ["Gmail"],
};
export const AGENT_RECIPE_COUNT = agentInspirations.length + 1;
export const BOT_RECIPE_COUNT = agentInspirations.filter((recipe) => !isLaunchBotRecipeId(recipe.id)).length + LAUNCH_BOT_RECIPE_IDS.length;
const EMPTY_BOT_RECIPES: BotRecipeSummary[] = [];

export function AgentRecipesPanel({ onSetup, botClient, onStartChat, onCreateJev, connections = [], jevUnavailable = "", jevPending = false, jevError = "",
  botRecipes = EMPTY_BOT_RECIPES, matrixModels = [], catalog, catalogLoading = false, onInstantiateBot, onOpenBotChat }: {
  onSetup?:()=>void; botClient?: BotClient; onStartChat?: StartAgentChat; onCreateJev?: (accountLabel: string, labeling: boolean) => Promise<void>;
  connections?: ChatAgentIntegrationConnection[]; jevUnavailable?: string; jevPending?: boolean; jevError?: string;
  botRecipes?: BotRecipeSummary[]; matrixModels?: readonly CanonicalProviderChoice[];
  catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  onInstantiateBot?: (recipe: BotRecipeRef, clientRequestId: string, selection?: CanonicalChatModelSelection, name?: string) => Promise<string>;
  onOpenBotChat?: (chatId: string) => void;
}) {
  const [setupRecipe, setSetupRecipe] = useState<BotRecipeSummary | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [selectedGmail, setSelectedGmail] = useState("");
  const [labeling, setLabeling] = useState(false);
  const [chosenBotSelection, setBotSelection] = useState<CanonicalChatModelSelection | null | undefined>(undefined);
  const [botPending, setBotPending] = useState<string | null>(null);
  const [botError, setBotError] = useState("");
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const transportScope=botClient ?? onInstantiateBot;
  const owner=useRef({transportScope});
  if(owner.current.transportScope !== transportScope) owner.current={transportScope};
  const botAttempt = useRef<{ key: string; requestId: string; chatId?:string; executorAttempted?:boolean } | null>(null);
  useEffect(() => {botAttempt.current=null; setBotPending(null); setBotError("");},[transportScope]);
  const selectableModels = matrixBotSelectableModelChoices(matrixModels, catalog);
  // Initialize the unsaved form once when its catalog arrives; later refreshes preserve intent.
  if (setupRecipe && chosenBotSelection === undefined && !catalogLoading && selectableModels[0]) {
    setBotSelection(matrixBotModelSelection(selectableModels[0]));
  }
  const botSelection = chosenBotSelection ?? null;
  const botModelAvailable = Boolean(botSelection && (isAutomaticBotSelection(botSelection) || selectableModels.some((choice) =>
    botModelChoiceMatchesSelection(choice, botSelection))));
  const createBot = async (recipe: BotRecipeSummary, name = recipe.name, executor:BotExecutorSelection | null = null) => {
    if (!onInstantiateBot || !onOpenBotChat || botPending || !botSelection || !botModelAvailable || catalogLoading) return;
    const scope=owner.current, current=()=>mounted.current && owner.current===scope;
    const key = `${recipe.recipeId}@${recipe.version}:${JSON.stringify(botSelection)}:${name}`;
    if (!botAttempt.current?.chatId && botAttempt.current?.key !== key) {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      botAttempt.current = { key, requestId: `req_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` };
    }
    setBotPending(key);
    setBotError("");
    try {
      const ref = { recipeId: recipe.recipeId, version: recipe.version };
      const chatId = botAttempt.current.chatId ?? await (name !== recipe.name
        ? onInstantiateBot(ref, botAttempt.current.requestId, botSelection, name)
        : onInstantiateBot(ref, botAttempt.current.requestId, botSelection));
      if(!current()) return;
      botAttempt.current.chatId = chatId;
      if (executor || botAttempt.current.executorAttempted) {if (!botClient) throw new Error("Task execution unavailable"); botAttempt.current.executorAttempted=true; await configureCreatedExecutor(botClient,chatId,executor,current,true);}
      if (!current()) return;
      await onOpenBotChat(chatId);
      if (!current()) return;
      botAttempt.current = null;
      setSetupRecipe(null);
    } catch (error: unknown) {
      console.warn("[chat-agents] Bot creation failed:", error instanceof Error ? error.name : "UnknownError");
      if (current()) setBotError(botAttempt.current?.chatId ? "Your bot was created. Task setup could not complete. Retry to continue." : "Bot could not be created. Try again.");
    } finally {
      if (current()) setBotPending(null);
    }
  };
  const gmailAccounts = activeConnections("gmail", connections);
  const accountLabel = gmailAccounts.length === 1 ? gmailAccounts[0]!.account_label
    : gmailAccounts.some((account) => account.account_label === selectedGmail) ? selectedGmail : "";
  const normalized = query.trim().toLocaleLowerCase();
  const categories = ["All", ...new Set(agentInspirations.flatMap(recipe => recipe.categories.filter(value => value !== "From Grok Bot Team")))].slice(0, 8);
  const fitsCategory = useCallback((recipe: AgentInspiration) => category === "All" || recipe.categories.includes(category), [category]);
  const botMode = !!onInstantiateBot;
  const launchIds = useMemo(() => Object.fromEntries(botRecipes.map((recipe) => [recipe.recipeId, true] as const)), [botRecipes]);
  const visibleBotRecipes = botRecipes.filter((recipe) => (category === "All" || agentInspirations.some(idea => idea.id === recipe.recipeId && fitsCategory(idea))) && (!normalized || [recipe.name, recipe.description, recipe.output]
    .some((value) => value.toLocaleLowerCase().includes(normalized))));
  const showJev = Boolean(onCreateJev || !botMode) && !Object.hasOwn(launchIds, jevRecipe.id) && (!normalized || [jevRecipe.name, jevRecipe.description, jevRecipe.category,
    ...jevRecipe.skills, ...jevRecipe.integrations].some((value) => value.toLocaleLowerCase().includes(normalized)));
  const matches = useMemo(() => normalized ? agentInspirations.filter((recipe) =>
    fitsCategory(recipe) && (!botMode || !isLaunchBotRecipeId(recipe.id)) && !Object.hasOwn(launchIds, recipe.id) &&
    [recipe.name, recipe.description, ...recipe.categories, ...recipe.skills, ...recipe.integrations]
      .some((value) => value.toLocaleLowerCase().includes(normalized))) : agentInspirations.filter((recipe) =>
      fitsCategory(recipe) && (!botMode || !isLaunchBotRecipeId(recipe.id)) && !Object.hasOwn(launchIds, recipe.id)), [normalized, launchIds, botMode, fitsCategory]);

  const featured = !showAll && !normalized && category === "All";
  const shownBots = featured ? visibleBotRecipes.slice(0, 6) : visibleBotRecipes;
  const shownIdeas = featured ? matches.slice(0, Math.max(0, 6 - shownBots.length - (showJev ? 1 : 0))) : matches;
  const total = visibleBotRecipes.length + matches.length + (showJev ? 1 : 0);
  return <div className="matrix-chat-agent-recipes mx-auto grid w-full">
    <div className="matrix-chat-agent-recipes__intro grid gap-2">
      <h3 className="text-2xl font-semibold tracking-[-0.035em]">What should your agent do?</h3>
    </div>
    <label className="matrix-template-search">
      <span className="sr-only">Search recipes</span>
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.5"/><path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      <input className={chatAgentInputClass} type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search templates" aria-label="Search recipes" />
    </label>
    <div className="matrix-template-categories flex flex-wrap" role="group" aria-label="Template categories">{categories.map(value => <button type="button" key={value} aria-pressed={category === value} className="matrix-chat-agent-category rounded-full border px-3 py-1 text-xs" onClick={() => setCategory(value)}>{value}</button>)}</div>
    {setupRecipe ? <BotRecipeSetup onSetup={onSetup} botClient={botClient} creationRetained={!!botAttempt.current?.chatId} key={setupRecipe.recipeId} recipe={setupRecipe} selection={botSelection} models={matrixModels} catalog={catalog} pending={!!botPending} createDisabled={!botModelAvailable || catalogLoading} catalogLoading={catalogLoading} error={botError} onSelectionChange={selection => { setBotSelection(selection); setBotError(""); }} onCreate={(name,executor) => { void createBot(setupRecipe, name,executor); }} onClose={() => { setSetupRecipe(null); setBotError(""); }}/> : null}
    {botError && !setupRecipe ? <p role="alert" className="text-xs">{botError}</p> : null}
    {showJev || matches.length || visibleBotRecipes.length ? <div className="matrix-chat-agent-recipes__grid grid gap-3">
      {shownBots.map((recipe) => <article key={`${recipe.recipeId}@${recipe.version}`} data-matrix-recipe={recipe.recipeId}
        className="matrix-chat-agent-card matrix-chat-agent-recipe-card flex min-w-0 flex-col gap-3 rounded-xl border p-3">
        <div className="matrix-template-card-heading flex min-w-0 items-start gap-2"><RecipeRabbit id={recipe.recipeId} name={recipe.name} category="Matrix" size="small" />
          <div className="min-w-0 flex-1"><h4 className="text-sm font-semibold">{recipe.name}</h4>
            <p className="matrix-template-description mt-1 text-xs leading-5" style={chatAgentMutedStyle}>{recipe.description}</p></div></div>
        <div className="matrix-template-footer"><p className="matrix-template-output text-xs" style={chatAgentMutedStyle} title={recipe.output}>{recipe.output}</p>
        <button type="button" aria-label={`Use ${recipe.name}`} disabled={!onInstantiateBot || !onOpenBotChat || !!botPending}
          className={`${chatAgentButtonClass} matrix-template-action self-start`} onClick={() => { botAttempt.current=null; setBotSelection(undefined); setSetupRecipe(recipe); setBotError(""); }}>
          {botPending?.startsWith(`${recipe.recipeId}@${recipe.version}:`) ? "Creating…" : "Set up bot"}</button></div>
      </article>)}
      {showJev ? <article data-matrix-recipe={jevRecipe.id} className="matrix-chat-agent-card matrix-chat-agent-recipe-card flex min-w-0 flex-col gap-3 rounded-xl border p-3">
        <div className="matrix-template-card-heading flex min-w-0 items-start gap-2">
          <RecipeRabbit id={jevRecipe.id} name={jevRecipe.name} category={jevRecipe.category} size="small" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <h4 className="min-w-0 text-sm font-semibold tracking-[-0.015em]">{jevRecipe.name}</h4>
              <span className="matrix-chat-agent-chip shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em]">Matrix</span>
            </div>
            <p className="matrix-template-description mt-1 text-xs leading-5" style={chatAgentMutedStyle}>{jevRecipe.description}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px]" style={chatAgentMutedStyle}>
          {jevRecipe.skills.map((skill) => <span key={skill} className="matrix-chat-agent-chip rounded-full border px-2 py-1">{skill}</span>)}
        </div>
        {gmailAccounts.length === 1 ? <p className="text-xs" style={chatAgentMutedStyle}>Gmail: {gmailAccounts[0]!.account_email ?? gmailAccounts[0]!.account_label}</p> :
          gmailAccounts.length > 1 ? <label className="grid gap-1.5 text-xs">Gmail account for Jev
            <select className={chatAgentInputClass} aria-label="Gmail account for Jev" value={accountLabel} disabled={jevPending}
              onChange={(event) => { setSelectedGmail(event.currentTarget.value); setLabeling(false); }}>
              <option value="">Choose an account</option>
              {gmailAccounts.map((account) => <option key={account.account_label} value={account.account_label}>
                {account.account_email ?? account.account_label}</option>)}
            </select></label> : null}
        {jevUnavailable || (gmailAccounts.length === 0 ? "Connect Gmail in Services to use this recipe." : "") ?
          <p className="text-xs" role="status" style={chatAgentMutedStyle}>{jevUnavailable || "Connect Gmail in Services to use this recipe."}</p> : null}
        {jevError ? <p role="alert" className="text-xs">{jevError}</p> : null}
        <JevLabelPermission enabled={labeling} disabled={jevPending || !accountLabel} onChange={setLabeling} />
        <button type="button" aria-label="Use Jev Inbox Triage" disabled={!onCreateJev || !accountLabel || !!jevUnavailable || jevPending}
          className={`${chatAgentButtonClass} matrix-template-action self-start`} onClick={() => { if (accountLabel) void onCreateJev?.(accountLabel, labeling); }}>
          {jevPending ? "Creating…" : "Build in Chat"}</button>
      </article> : null}
      {shownIdeas.map((recipe) => {
        const category = recipe.categories.find((value) => value !== "From Grok Bot Team") ?? recipe.categories[0];
        return <article key={recipe.id} className="matrix-chat-agent-card matrix-chat-agent-recipe-card flex min-w-0 flex-col gap-3 rounded-xl border p-3">
          <div className="matrix-template-card-heading flex min-w-0 items-start gap-2">
            <RecipeRabbit id={recipe.id} name={recipe.name} category={category} size="small" />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <h4 className="min-w-0 text-sm font-semibold tracking-[-0.015em]">{recipe.name}</h4>
                {category ? <span className="matrix-chat-agent-chip shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em]">{category}</span> : null}
              </div>
              <p className="matrix-template-description mt-1 text-xs leading-5" style={chatAgentMutedStyle}>{recipe.description}</p>
            </div>
          </div>
          <div className="matrix-template-footer"><p className="matrix-template-output text-xs" style={chatAgentMutedStyle} title={recipe.integrations.join(", ")}>{recipe.integrations.slice(0,2).join(" · ") || "Customize in Chat"}</p>
          <button type="button" aria-label={`Use ${recipe.name}`} disabled={!onStartChat} className={`${chatAgentButtonClass} matrix-template-action self-start`} onClick={() => onStartChat?.(buildAgentRecipePrompt(recipe))}>Build in Chat</button></div>
        </article>;
      })}
    </div> : <div className="rounded-2xl border border-dashed px-5 py-10 text-center"><p className="text-sm font-medium">No recipes match that search.</p><p className="mt-1 text-xs" style={chatAgentMutedStyle}>Try a role, skill, or integration name.</p></div>}
    {!normalized && category === "All" && total > 6 ? <button type="button" className="justify-self-start text-xs underline underline-offset-2" onClick={() => setShowAll(value => !value)}>{showAll ? "Show featured templates" : `See all ${total} templates`}</button> : null}
  </div>;
}
