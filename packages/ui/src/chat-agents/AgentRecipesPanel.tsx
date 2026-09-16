import { buildAgentRecipePrompt } from "./recipe-handoff.js";
import type { StartAgentChat } from "./client.js";
import { useMemo, useState } from "react";
import { agentInspirations, type AgentInspiration } from "./agent-inspirations.generated.js";
import { RecipeRabbit } from "./RecipeRabbit.js";
import { chatAgentButtonClass, chatAgentInputClass, chatAgentMutedStyle } from "./theme.js";


export function AgentRecipesPanel({ onStartChat }: { onStartChat?: StartAgentChat }) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => normalized ? agentInspirations.filter((recipe) =>
    [recipe.name, recipe.description, ...recipe.categories, ...recipe.skills, ...recipe.integrations]
      .some((value) => value.toLocaleLowerCase().includes(normalized))) : agentInspirations, [normalized]);

  return <div className="matrix-chat-agent-recipes mx-auto grid w-full max-w-5xl gap-6 py-5 sm:py-7">
    <div className="matrix-chat-agent-recipes__intro grid gap-2 rounded-3xl border p-5 sm:p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={chatAgentMutedStyle}>Agent library</p>
      <h3 className="text-2xl font-semibold tracking-[-0.035em]">Recipes</h3>
      <p className="max-w-2xl text-sm leading-6" style={chatAgentMutedStyle}>Browse {agentInspirations.length} public marketplace examples, then shape an original Matrix agent through Chat.</p>
      <p className="text-xs" style={chatAgentMutedStyle}>{agentInspirations.length} recipe ideas</p>
    </div>
    <label className="grid gap-1.5 text-xs font-medium">
      <span className="sr-only">Search recipes</span>
      <input className={chatAgentInputClass} type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search roles, skills, or integrations" aria-label="Search recipes" />
    </label>
    {matches.length ? <div className="matrix-chat-agent-recipes__grid grid gap-3">
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
