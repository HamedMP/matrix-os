import { useId, useState, type ReactNode } from "react";
import type { ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import type { CanonicalProviderChoice } from "../canonical-provider-choice.js";
import type { AgentDraft } from "./AgentEditor.js";
import { chatAgentMutedStyle } from "./theme.js";

export function AgentDraftReview({ draft, catalog, models, children }: {
  draft: AgentDraft; catalog: ChatAgentRecipeCatalog | null; models: readonly CanonicalProviderChoice[]; children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const fieldsId = useId();
  const skillNames = draft.recipe?.skills.map(id => catalog?.skills.find(skill => skill.id === id)?.name ?? id);
  const sourceNames = draft.recipe?.integrations.map(item => {
    const name = catalog?.services.find(service => service.id === item.service)?.name ?? item.service;
    return item.accountLabel ? `${name} · ${item.accountLabel}` : name;
  });
  const model = draft.selection && models.find(choice => choice.instanceId === draft.selection?.instanceId && choice.modelId === draft.selection.model);
  const rows = [
    ["Name", draft.name], ["Description", draft.description], ["Instructions", draft.instructions],
    ["Skills", skillNames?.join(", ")], ["Integrations", sourceNames?.join(", ")], ["Expected output", draft.recipe?.output],
    ["Model", model?.modelLabel ?? draft.selection?.model],
  ].filter(([, value]) => value);
  return <>
    {!editing && rows.length > 0 ? <dl className="grid gap-2 text-sm">
      {rows.map(([label, value]) => <div key={label} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
        <dt style={chatAgentMutedStyle}>{label}</dt><dd className="min-w-0 whitespace-pre-wrap break-words">{value}</dd>
      </div>)}
    </dl> : null}
    <button type="button" className="justify-self-start text-sm underline underline-offset-4" aria-expanded={editing} aria-controls={fieldsId}
      onClick={() => setEditing(value => !value)}>{editing ? "Show preview" : "Edit configuration"}</button>
    {editing ? <div id={fieldsId} className="grid gap-3">{children}</div> : null}
  </>;
}
