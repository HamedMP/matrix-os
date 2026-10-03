import { MATRIX_BOT_SELECTION, MATRIX_PI_CHAT_INSTANCE_ID, isManagedPiBotRoute, canonicalProviderFundingState, canonicalProviderAvailabilityReasonLabel, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
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

export function MatrixBotModelField({ id, label = "Model", selection, models, catalog, catalogLoading = false, pending, allowAutomatic = true, onSetup, onRefreshCatalog, onChange }: {
  allowAutomatic?: boolean; onSetup?: () => void; onRefreshCatalog?: () => void;
  id?: string; label?: string; selection: CanonicalChatModelSelection | null;
  models: readonly CanonicalProviderChoice[]; pending: boolean;
  catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  onChange(selection: CanonicalChatModelSelection): void;
}) {
  const rows = catalog ? deriveChatPickerModelRows(catalog, matrixBotModelChoices(models)).filter(isManagedPiBotRoute) : [];
  const choices = catalog === undefined ? matrixBotModelChoices(models) : rows.flatMap(row => row.choice ? [row.choice] : []);
  const automatic = allowAutomatic && (!selection || selection.instanceId !== MATRIX_PI_CHAT_INSTANCE_ID);
  const key = automatic || !selection ? "" : JSON.stringify([selection.instanceId, selection.model]);
  const available = automatic || choices.some((choice) => choice.instanceId === selection?.instanceId && choice.modelId === selection.model);
  const blockedRows = rows.filter(row => !row.choice);
  const savedRow = blockedRows.find(row => row.instanceId === selection?.instanceId && row.modelId === selection.model);
  const selectedInstance = catalog?.instances.find(instance => instance.id === selection?.instanceId);
  const reserved = savedRow && selectedInstance && canonicalProviderFundingState(selectedInstance) === "credit_reserved";
  const managedInstance = catalog?.instances.find(instance => isManagedPiBotRoute({ instanceId: instance.id, driverKind: instance.driverKind }));
  const unavailableReason = managedInstance ? canonicalProviderAvailabilityReasonLabel(managedInstance) : "Matrix AI unavailable";
  const noModels = !catalogLoading && choices.length === 0;
  return <div className="grid gap-1.5">
    <label className="grid gap-1.5 text-sm" htmlFor={id}>{label}
      <select id={id} className={chatAgentInputClass} value={key} disabled={pending || catalogLoading || (!allowAutomatic && noModels)} onChange={(event) => {
        if (pending || catalogLoading) return;
        if (!event.target.value) { if (allowAutomatic) onChange(MATRIX_BOT_SELECTION); return; }
        const choice = choices.find((candidate) => JSON.stringify([candidate.instanceId, candidate.modelId]) === event.target.value);
        if (choice) onChange(matrixBotModelSelection(choice));
      }}>
        {allowAutomatic ? <option value="">Automatic · managed by this computer</option> : !selection ? <option value="" disabled>Choose a Matrix AI model</option> : null}
        {selection && !available && !savedRow ? <option value={key} disabled>{selection?.model} · unavailable</option> : null}
        {choices.map((choice) => <option key={`${choice.instanceId}:${choice.modelId}`} value={JSON.stringify([choice.instanceId, choice.modelId])}>
          {choice.modelLabel} · Matrix AI</option>)}
        {blockedRows.map(row => <option key={`${row.instanceId}:${row.modelId}`} disabled value={JSON.stringify([row.instanceId, row.modelId])}>
          {row.modelLabel} · Matrix AI · {canonicalProviderUnavailableSelectionLabel(catalog?.instances.find(instance => instance.id === row.instanceId), row.modelId)}
        </option>)}
      </select>
    </label>
    {catalogLoading ? <p role="status" className="text-xs" style={chatAgentMutedStyle}>Loading available bot models…</p> : null}
    {!available && (reserved || !noModels) ? <p className="text-xs" style={chatAgentMutedStyle}>{reserved ? "Your credit is reserved while usage is confirmed."
      : "This saved Matrix AI model is unavailable. Choose another model or check Agents & providers."}</p> : null}
    {noModels ? <div className="grid gap-2 text-xs" style={chatAgentMutedStyle}>
      <p>No Matrix AI models available. {unavailableReason === "Available" ? "Check Agents & providers." : `${unavailableReason}.`}</p>
      {allowAutomatic ? <p>Automatic follows this computer’s configured route. Its availability is checked when you send.</p> : null}
      {onSetup || onRefreshCatalog ? <div className="flex flex-wrap gap-3">
        {onRefreshCatalog ? <button type="button" className="underline" disabled={pending || catalogLoading} onClick={onRefreshCatalog}>Check availability</button> : null}
        {onSetup ? <button type="button" className="underline" disabled={pending} onClick={onSetup}>Agents & providers</button> : null}
      </div> : null}
    </div> : null}
  </div>;
}
