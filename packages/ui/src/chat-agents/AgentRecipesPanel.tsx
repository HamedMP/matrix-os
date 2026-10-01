import { MatrixBotModelField, matrixBotModelChoices } from "./bots/MatrixBotModelField.js";
import type { CanonicalProviderChoice } from "../canonical-provider-choice.js";
import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import { buildAgentRecipePrompt, isLaunchBotRecipeId, LAUNCH_BOT_RECIPE_IDS } from "./recipe-handoff.js";
import type { ChatAgentIntegrationConnection, StartAgentChat } from "./client.js";
import { activeConnections } from "./recipe-integrations.js";
import { JEV_AGENT_DESCRIPTION, JEV_AGENT_NAME } from "./jev-agent-template.js";
import { useMemo, useState } from "react";
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

export function AgentRecipesPanel({ onStartChat, onCreateJev, connections = [], jevUnavailable = "", jevPending = false, jevError = "",
  botRecipes = EMPTY_BOT_RECIPES, matrixModels = [], onInstantiateBot, onOpenBotChat }: {
  onStartChat?: StartAgentChat; onCreateJev?: (accountLabel: string, labeling: boolean) => Promise<void>;
  connections?: ChatAgentIntegrationConnection[]; jevUnavailable?: string; jevPending?: boolean; jevError?: string;
  botRecipes?: BotRecipeSummary[]; matrixModels?: readonly CanonicalProviderChoice[];
  onInstantiateBot?: (recipe: BotRecipeRef, clientRequestId: string, selection?: CanonicalChatModelSelection) => Promise<string>;
  onOpenBotChat?: (chatId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedGmail, setSelectedGmail] = useState("");
  const [labeling, setLabeling] = useState(false);
  const [botSelection, setBotSelection] = useState<CanonicalChatModelSelection | null>(null);
  const [botPending, setBotPending] = useState<string | null>(null);
  const [botError, setBotError] = useState("");
  const botAttempt = useRef<{ key: string; requestId: string } | null>(null);
  const botModelAvailable = !botSelection || matrixBotModelChoices(matrixModels).some((choice) =>
    choice.instanceId === botSelection.instanceId && choice.modelId === botSelection.model);
  const createBot = async (recipe: BotRecipeSummary) => {
    if (!onInstantiateBot || !onOpenBotChat || botPending || !botModelAvailable) return;
    const key = `${recipe.recipeId}@${recipe.version}:${JSON.stringify(botSelection)}`;
    if (botAttempt.current?.key !== key) {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      botAttempt.current = { key, requestId: `req_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` };
    }
    setBotPending(key);
    setBotError("");
    try {
      const ref = { recipeId: recipe.recipeId, version: recipe.version };
      const chatId = await (botSelection
        ? onInstantiateBot(ref, botAttempt.current.requestId, botSelection)
        : onInstantiateBot(ref, botAttempt.current.requestId));
      botAttempt.current = null;
      onOpenBotChat(chatId);
    } catch (error: unknown) {
      console.warn("[chat-agents] Bot creation failed:", error instanceof Error ? error.name : "UnknownError");
      setBotError("Bot could not be created. Try again.");
    } finally {
      setBotPending(null);
    }
  };
  const gmailAccounts = activeConnections("gmail", connections);
  const accountLabel = gmailAccounts.length === 1 ? gmailAccounts[0]!.account_label
    : gmailAccounts.some((account) => account.account_label === selectedGmail) ? selectedGmail : "";
  const normalized = query.trim().toLocaleLowerCase();
  const botMode = !!onInstantiateBot;
  const launchIds = useMemo(() => Object.fromEntries(botRecipes.map((recipe) => [recipe.recipeId, true] as const)), [botRecipes]);
  const visibleBotRecipes = botRecipes.filter((recipe) => !normalized || [recipe.name, recipe.description, recipe.output]
    .some((value) => value.toLocaleLowerCase().includes(normalized)));
  const showJev = !botMode && !Object.hasOwn(launchIds, jevRecipe.id) && (!normalized || [jevRecipe.name, jevRecipe.description, jevRecipe.category,
    ...jevRecipe.skills, ...jevRecipe.integrations].some((value) => value.toLocaleLowerCase().includes(normalized)));
  const matches = useMemo(() => normalized ? agentInspirations.filter((recipe) =>
    (!botMode || !isLaunchBotRecipeId(recipe.id)) && !Object.hasOwn(launchIds, recipe.id) &&
    [recipe.name, recipe.description, ...recipe.categories, ...recipe.skills, ...recipe.integrations]
      .some((value) => value.toLocaleLowerCase().includes(normalized))) : agentInspirations.filter((recipe) =>
      (!botMode || !isLaunchBotRecipeId(recipe.id)) && !Object.hasOwn(launchIds, recipe.id)), [normalized, launchIds, botMode]);

  return <div className="matrix-chat-agent-recipes mx-auto grid w-full max-w-5xl gap-6 py-5 sm:py-7">
    <div className="matrix-chat-agent-recipes__intro grid gap-2 rounded-3xl border p-5 sm:p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={chatAgentMutedStyle}>Agent library</p>
      <h3 className="text-2xl font-semibold tracking-[-0.035em]">Recipes</h3>
      <p className="max-w-2xl text-sm leading-6" style={chatAgentMutedStyle}>Create a Matrix bot from a ready recipe, or explore public marketplace examples.</p>
      <p className="text-xs" style={chatAgentMutedStyle}>{botMode ? BOT_RECIPE_COUNT : AGENT_RECIPE_COUNT} recipe ideas</p>
    </div>
    <label className="grid gap-1.5 text-xs font-medium">
      <span className="sr-only">Search recipes</span>
      <input className={chatAgentInputClass} type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search roles, skills, or integrations" aria-label="Search recipes" />
    </label>
    {botMode ? <MatrixBotModelField label="Bot model" selection={botSelection} models={matrixModels} pending={!!botPending}
      onChange={(selection) => { setBotSelection(selection.instanceId === "matrix_bot_default" ? null : selection); setBotError(""); }} /> : null}
    {botError ? <p role="alert" className="text-xs">{botError}</p> : null}
    {showJev || matches.length || visibleBotRecipes.length ? <div className="matrix-chat-agent-recipes__grid grid gap-3">
      {visibleBotRecipes.map((recipe) => <article key={`${recipe.recipeId}@${recipe.version}`} data-matrix-recipe={recipe.recipeId}
        className="matrix-chat-agent-card matrix-chat-agent-recipe-card grid min-w-0 gap-4 rounded-2xl border p-4">
        <div className="flex min-w-0 items-start gap-4"><RecipeRabbit id={recipe.recipeId} name={recipe.name} category="Matrix" />
          <div className="min-w-0 flex-1"><h4 className="text-base font-semibold">{recipe.name}</h4>
            <p className="mt-2 text-xs leading-5" style={chatAgentMutedStyle}>{recipe.description}</p></div></div>
        <p className="text-xs" style={chatAgentMutedStyle}>Creates: {recipe.output}</p>
        <button type="button" aria-label={`Use ${recipe.name}`} disabled={!onInstantiateBot || !onOpenBotChat || !!botPending || !botModelAvailable}
          className={`${chatAgentButtonClass} justify-self-start`} onClick={() => { void createBot(recipe); }}>
          {botPending?.startsWith(`${recipe.recipeId}@${recipe.version}:`) ? "Creating…" : "Build in Chat"}</button>
      </article>)}
      {showJev ? <article data-matrix-recipe={jevRecipe.id} className="matrix-chat-agent-card matrix-chat-agent-recipe-card grid min-w-0 gap-4 rounded-2xl border p-4">
        <div className="flex min-w-0 items-start gap-4">
          <RecipeRabbit id={jevRecipe.id} name={jevRecipe.name} category={jevRecipe.category} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <h4 className="min-w-0 text-base font-semibold tracking-[-0.015em]">{jevRecipe.name}</h4>
              <span className="matrix-chat-agent-chip shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em]">Matrix</span>
            </div>
            <p className="mt-2 text-xs leading-5" style={chatAgentMutedStyle}>{jevRecipe.description}</p>
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
          className={`${chatAgentButtonClass} justify-self-start`} onClick={() => { if (accountLabel) void onCreateJev?.(accountLabel, labeling); }}>
          {jevPending ? "Creating…" : "Build in Chat"}</button>
      </article> : null}
      {matches.map((recipe) => {
        const category = recipe.categories.find((value) => value !== "From Grok Bot Team") ?? recipe.categories[0];
        return <article key={recipe.id} className="matrix-chat-agent-card matrix-chat-agent-recipe-card grid min-w-0 gap-4 rounded-2xl border p-4">
          <div className="flex min-w-0 items-start gap-4">
            <RecipeRabbit id={recipe.id} name={recipe.name} category={category} />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <h4 className="min-w-0 text-base font-semibold tracking-[-0.015em]">{recipe.name}</h4>
                {category ? <span className="matrix-chat-agent-chip shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em]">{category}</span> : null}
              </div>
              <p className="mt-2 text-xs leading-5" style={chatAgentMutedStyle}>{recipe.description}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[10px]" style={chatAgentMutedStyle}>
            {recipe.skills.slice(0, 3).map((skill) => <span key={skill} className="matrix-chat-agent-chip rounded-full border px-2 py-1">{skill}</span>)}
            {recipe.skills.length > 3 ? <span className="px-1 py-1">+{recipe.skills.length - 3}</span> : null}
          </div>
          <button type="button" aria-label={`Use ${recipe.name}`} disabled={!onStartChat} className={`${chatAgentButtonClass} justify-self-start`} onClick={() => onStartChat?.(buildAgentRecipePrompt(recipe))}>Build in Chat</button>
        </article>;
      })}
    </div> : <div className="rounded-2xl border border-dashed px-5 py-10 text-center"><p className="text-sm font-medium">No recipes match that search.</p><p className="mt-1 text-xs" style={chatAgentMutedStyle}>Try a role, skill, or integration name.</p></div>}
  </div>;
}
