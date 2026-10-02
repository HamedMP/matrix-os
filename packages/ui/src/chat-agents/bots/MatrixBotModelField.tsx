import { MATRIX_BOT_SELECTION, MATRIX_PI_CHAT_INSTANCE_ID, isManagedPiBotRoute, canonicalProviderFundingState, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { canonicalProviderUnavailableSelectionLabel, type CanonicalProviderChoice } from "../../canonical-provider-choice.js";
import { deriveChatPickerModelRows } from "../../chat-picker-entries.js";
import { chatAgentInputClass, chatAgentMutedStyle } from "../theme.js";

/** Only the public, owner-authorized Pi route may back an explicit recipe choice. */
export function matrixBotModelChoices(models: readonly CanonicalProviderChoice[]): CanonicalProviderChoice[] {
  return models.filter(isManagedPiBotRoute);
}

export function matrixBotModelSelection(choice: CanonicalProviderChoice): CanonicalChatModelSelection {
  return { instanceId: choice.instanceId, model: choice.modelId,
    ...(choice.selectedOptions.length ? { options: choice.selectedOptions } : {}) };
}

export function MatrixBotModelField({ id, label = "Model", selection, models, catalog, pending, onChange }: {
  id?: string; label?: string; selection: CanonicalChatModelSelection | null;
  models: readonly CanonicalProviderChoice[]; pending: boolean;
  catalog?: CanonicalProviderCatalog | null;
  onChange(selection: CanonicalChatModelSelection): void;
}) {
  const rows = catalog ? deriveChatPickerModelRows(catalog, matrixBotModelChoices(models)).filter(isManagedPiBotRoute) : [];
  const choices = catalog === undefined ? matrixBotModelChoices(models) : rows.flatMap(row => row.choice ? [row.choice] : []);
  const automatic = !selection || selection.instanceId !== MATRIX_PI_CHAT_INSTANCE_ID;
  const key = automatic ? "" : JSON.stringify([selection.instanceId, selection.model]);
  const available = automatic || choices.some((choice) => choice.instanceId === selection?.instanceId && choice.modelId === selection.model);
  const blockedRows = rows.filter(row => !row.choice);
  const savedRow = blockedRows.find(row => row.instanceId === selection?.instanceId && row.modelId === selection.model);
  const selectedInstance = catalog?.instances.find(instance => instance.id === selection?.instanceId);
  const reserved = savedRow && selectedInstance && canonicalProviderFundingState(selectedInstance) === "credit_reserved";
  return <div className="grid gap-1.5">
    <label className="grid gap-1.5 text-sm" htmlFor={id}>{label}
      <select id={id} className={chatAgentInputClass} value={key} disabled={pending} onChange={(event) => {
        if (!event.target.value) return onChange(MATRIX_BOT_SELECTION);
        const choice = choices.find((candidate) => JSON.stringify([candidate.instanceId, candidate.modelId]) === event.target.value);
        if (choice) onChange(matrixBotModelSelection(choice));
      }}>
        <option value="">Automatic · managed by this computer</option>
        {!available && !savedRow ? <option value={key} disabled>{selection?.model} · unavailable</option> : null}
        {choices.map((choice) => <option key={`${choice.instanceId}:${choice.modelId}`} value={JSON.stringify([choice.instanceId, choice.modelId])}>
          {choice.modelLabel} · Matrix AI</option>)}
        {blockedRows.map(row => <option key={`${row.instanceId}:${row.modelId}`} disabled value={JSON.stringify([row.instanceId, row.modelId])}>
          {row.modelLabel} · Matrix AI · {canonicalProviderUnavailableSelectionLabel(catalog?.instances.find(instance => instance.id === row.instanceId), row.modelId)}
        </option>)}
      </select>
    </label>
    {!available ? <p className="text-xs" style={chatAgentMutedStyle}>{reserved ? "Your credit is reserved while usage is confirmed."
      : "This saved Matrix AI model is unavailable. Choose another model or check Agents & providers."}</p> : null}
  </div>;
}
