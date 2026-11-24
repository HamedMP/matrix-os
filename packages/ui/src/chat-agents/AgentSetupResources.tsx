import * as Collapsible from "@radix-ui/react-collapsible";
import type { ReactNode } from "react";
import { botIntegrationAccessCopy, type BotRecipeSetupContext, type ChatAgentRecipe, type ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import { chatAgentMutedStyle } from "./theme.js";

export function AgentSetupResources({ context, recipe, catalog, children }: {
  context?: BotRecipeSetupContext; recipe?: ChatAgentRecipe | null; catalog: ChatAgentRecipeCatalog | null; children?: ReactNode;
}) {
  const skillName = (id: string) => catalog?.skills.find(skill => skill.id === id)?.name ?? id;
  const serviceName = (id: string) => catalog?.services.find(service => service.id === id)?.name ?? id;
  const groups = [
    ["Tools", context?.capabilities ?? []],
    ["Skills", [...new Set([...(context?.skills ?? []), ...(recipe?.skills ?? [])])].map(skillName)],
    ["Sources", [...(context?.integrations ?? []).map(item =>
      `${serviceName(item.service)} (${botIntegrationAccessCopy(item.service, item.effects).summary}, ${item.required ? "required" : "optional"})`),
      ...(recipe?.integrations ?? []).map(item => item.accountLabel ? `${serviceName(item.service)} · ${item.accountLabel}` : serviceName(item.service))]],
    ["MCP servers", context?.mcpServers ?? []],
  ] as const;
  return <Collapsible.Root>
    <Collapsible.Trigger className="text-sm underline underline-offset-4" type="button">Skills, sources &amp; permissions</Collapsible.Trigger>
    <Collapsible.Content><section className="mt-2 grid gap-2 rounded-xl border p-3" aria-label={context ? "Recipe resources" : "Agent resources"}>
      {context ? <h3 className="text-sm font-medium">{context.name}</h3> : null}
      <dl className="grid gap-2 text-sm">
        {groups.map(([label, values]) => <div key={label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
          <dt style={chatAgentMutedStyle}>{label}</dt><dd className="break-words">{values.length ? values.join(", ") : "None selected"}</dd>
        </div>)}
      </dl>
      <p className="text-xs" style={chatAgentMutedStyle}>Saving this configuration grants no new access.</p>
      {children}
    </section></Collapsible.Content>
  </Collapsible.Root>;
}
