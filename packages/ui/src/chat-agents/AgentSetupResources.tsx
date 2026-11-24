import { botIntegrationAccessCopy, type BotRecipeSetupContext, type ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import { chatAgentMutedStyle } from "./theme.js";

export function AgentSetupResources({ context, catalog }: {
  context: BotRecipeSetupContext; catalog: ChatAgentRecipeCatalog | null;
}) {
  const groups = [
    ["Tools", context.capabilities],
    ["Skills", context.skills.map(id => catalog?.skills.find(skill => skill.id === id)?.name ?? id)],
    ["Integrations", context.integrations.map(item => {
      const name = catalog?.services.find(service => service.id === item.service)?.name ?? item.service;
      return `${name} (${botIntegrationAccessCopy(item.service, item.effects).summary}, ${item.required ? "required" : "optional"})`;
    })],
    ["MCP servers", context.mcpServers],
  ] as const;
  return <section className="grid gap-2 rounded-xl border p-4" aria-label="Recipe resources">
    <h3 className="text-sm font-medium">{context.name}</h3>
    {context.description ? <p className="text-sm" style={chatAgentMutedStyle}>{context.description}</p> : null}
    <dl className="grid gap-2 text-sm">
      {groups.map(([label, values]) => <div key={label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
        <dt style={chatAgentMutedStyle}>{label}</dt><dd className="break-words">{values.length ? values.join(", ") : "None included"}</dd>
      </div>)}
    </dl>
  </section>;
}
