import * as Collapsible from "@radix-ui/react-collapsible";
import { useId, useState } from "react";
import { botIntegrationAccessCopy, ChatAgentRecipeSchema, type BotRecipeSetupContext,
  type ChatAgentRecipe, type ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import { AgentRecipeIntegrations } from "./AgentRecipeIntegrations.js";
import { AgentRecipeSkills } from "./AgentRecipeSkills.js";
import type { ChatAgentIntegrationConnection } from "./client.js";
import { recipeSkillsFit } from "./recipe-skills.js";
import { chatAgentInputClass, chatAgentMutedStyle } from "./theme.js";

type ResourceGroup = "skills" | "integrations";
export type AgentSetupResource = ResourceGroup | "mcp";
type SetupResources = {
  context?: BotRecipeSetupContext;
  recipe?: ChatAgentRecipe | null;
  catalog: ChatAgentRecipeCatalog | null;
  connections: ChatAgentIntegrationConnection[];
  skills: ChatAgentRecipeCatalog["skills"];
  loading: boolean;
  pending: boolean;
  onChange?(recipe: ChatAgentRecipe | undefined): void;
  onOpenSettings?(resource: AgentSetupResource): void;
  onRefresh?(): void;
};

const compactActionClass = "min-h-8 max-w-full whitespace-normal text-left focus-visible:outline-2! focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]!";

function RecipeResources({ context, catalog }: Pick<SetupResources, "catalog"> & { context: BotRecipeSetupContext }) {
  const groups = [
    ["Skills", context.skills.map(id => catalog?.skills.find(skill => skill.id === id)?.name ?? id)],
    ["Integrations", context.integrations.map(item => {
      const name = catalog?.services.find(service => service.id === item.service)?.name ?? item.service;
      return `${name} (${botIntegrationAccessCopy(item.service, item.effects).summary}${item.required ? ", required" : ""})`;
    })],
    ["MCP servers", context.mcpServers],
  ] as const;
  const included = groups.filter(([, values]) => values.length > 0);
  if (!included.length) return null;

  return <Collapsible.Root>
    <Collapsible.Trigger type="button" asChild>
      <Button size="sm" variant="ghost" className={compactActionClass}>Included in this recipe</Button>
    </Collapsible.Trigger>
    <Collapsible.Content>
      <section aria-label="Recipe resources" className="mt-1 rounded-lg border px-3 py-2">
        <dl className="grid gap-2 text-xs">
          {included.map(([label, values]) => <div key={label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
            <dt style={chatAgentMutedStyle}>{label}</dt><dd className="[overflow-wrap:anywhere]">{values.join(", ")}</dd>
          </div>)}
        </dl>
      </section>
    </Collapsible.Content>
  </Collapsible.Root>;
}

function ResourcePicker({ id, group, context, recipe, catalog, connections, skills, loading, pending,
  onChange, onOpenSettings, onRefresh, onCancel }: SetupResources & {
  id: string;
  group: ResourceGroup;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState<ChatAgentRecipe>(() => recipe ?? { skills: [], integrations: [], output: context?.output ?? "" });
  const choosingSkills = group === "skills";
  const hasSources = draft.skills.length > 0 || draft.integrations.length > 0;
  const fits = recipeSkillsFit(draft.skills, skills);
  const canSave = Boolean(!pending && !loading && catalog?.enabled && fits
    && (ChatAgentRecipeSchema.safeParse(draft).success || (!hasSources && !draft.output.trim())));
  const save = () => {
    if (!canSave) return;
    onChange?.(!hasSources && !draft.output.trim() ? undefined : draft);
    onCancel();
  };

  return <section id={id} aria-label={choosingSkills ? "Choose skills" : "Choose integrations"}
    className="grid min-w-0 gap-3 rounded-lg border px-3 py-3">
    {choosingSkills ? <AgentRecipeSkills skills={skills} selected={draft.skills} pending={pending}
      loading={loading} unavailable={!catalog} onChange={next => setDraft(current => ({ ...current, skills: next }))}
      onRefresh={onRefresh ?? (() => {})} /> : <AgentRecipeIntegrations recipe={draft} catalog={catalog} connections={connections}
      connectionError="" pending={pending} onChange={setDraft} />}
    {onOpenSettings ? <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" className={compactActionClass} disabled={pending}
        onClick={() => onOpenSettings(group)}>{choosingSkills ? "Open Skills settings" : "Connect an app"}</Button>
      {!choosingSkills ? <p className="text-xs" style={chatAgentMutedStyle}>App access is approved separately.</p> : null}
    </div> : null}
    {!loading && !catalog ? <p role="status" className="text-xs">Resources are unavailable. Refresh to try again.</p> : null}
    {!recipe?.output && !context?.output && hasSources ? <label className="grid gap-1 text-xs" htmlFor={`${id}-output`}>Expected output
      <input id={`${id}-output`} className={chatAgentInputClass} value={draft.output} maxLength={1000} required
        placeholder="What should the agent deliver?" disabled={pending}
        onChange={event => setDraft(current => ({ ...current, output: event.target.value }))} />
    </label> : null}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" className={compactActionClass} disabled={!canSave} onClick={save}>Add to configuration</Button>
      <Button size="sm" variant="ghost" className={compactActionClass} aria-label="Cancel resource changes" onClick={onCancel}>Cancel</Button>
    </div>
  </section>;
}

export function AgentSetupResources({ revision, settingsVisited, picker, setPicker, ...props }: SetupResources & {
  revision: number; settingsVisited: boolean; picker: ResourceGroup | null; setPicker(group: ResourceGroup | null): void;
}) {
  const pickerId = useId();
  const { context, recipe, catalog, loading, pending, onChange, onOpenSettings, onRefresh } = props;
  const skillLabels = (recipe?.skills ?? []).map(id => catalog?.skills.find(skill => skill.id === id)?.name ?? id);
  const sourceLabels = (recipe?.integrations ?? []).map(item => {
    const name = catalog?.services.find(service => service.id === item.service)?.name ?? item.service;
    return item.accountLabel ? `${name} · ${item.accountLabel}` : name;
  });
  if (!context && !onChange && !onOpenSettings) return null;

  const toggle = (group: ResourceGroup) => setPicker(picker === group ? null : group);
  return <section aria-label="Setup resources" className="grid min-w-0 gap-2">
    <div className="flex flex-wrap gap-2">
      {onChange && (catalog?.enabled || picker || settingsVisited) ? <>
        <Button size="sm" variant="secondary" className={compactActionClass} aria-controls={picker === "skills" ? pickerId : undefined}
          aria-expanded={picker === "skills"} disabled={pending || loading}
          onClick={() => toggle("skills")}>{skillLabels.length ? "Manage skills" : "Add skills"}</Button>
        <Button size="sm" variant="secondary" className={compactActionClass} aria-controls={picker === "integrations" ? pickerId : undefined}
          aria-expanded={picker === "integrations"} disabled={pending || loading}
          onClick={() => toggle("integrations")}>{sourceLabels.length ? "Manage integrations" : "Add integrations"}</Button>
      </> : null}
      {onOpenSettings ? <Button size="sm" variant="secondary" className={compactActionClass} disabled={pending}
        title="Manage MCP connections on this computer" onClick={() => onOpenSettings("mcp")}>MCP settings</Button> : null}
      {settingsVisited && onRefresh ? <Button size="sm" variant="ghost" className={compactActionClass} disabled={pending || loading}
        onClick={onRefresh}>Check resources</Button> : null}
      {!settingsVisited && !catalog && !loading && onChange && onRefresh
        ? <Button size="sm" variant="secondary" className={compactActionClass} disabled={pending}
          onClick={onRefresh}>Retry setup resources</Button> : null}
    </div>
    {skillLabels.length || sourceLabels.length ? <ul aria-label="Selected resources" className="flex flex-wrap gap-1.5">
      {[...skillLabels, ...sourceLabels].map((label, index) => <li key={`${index}:${label}`}
        className="max-w-full rounded-md bg-[var(--bg-surface,var(--muted))] px-2 py-1 text-xs [overflow-wrap:anywhere]">{label}</li>)}
    </ul> : null}
    {picker && onChange ? <ResourcePicker key={`${revision}:${picker}`} {...props} id={pickerId} group={picker} onCancel={() => setPicker(null)} /> : null}
    {context ? <RecipeResources context={context} catalog={catalog} /> : null}
  </section>;
}
