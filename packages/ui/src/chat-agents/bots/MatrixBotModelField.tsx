import {BotConnectionSelector} from "./BotConnectionSelector.js";
import {useBotConnections} from "./use-bot-connections.js";
import type {BotClient} from "./client.js";
import { MATRIX_BOT_SELECTION, MATRIX_PI_CHAT_INSTANCE_ID, isAutomaticBotSelection, isManagedPiBotRoute, canonicalProviderModelRouteLabel, canonicalProviderFundingState, canonicalProviderAvailabilityReasonLabel, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { canonicalProviderUnavailableSelectionLabel, type CanonicalProviderChoice } from "../../canonical-provider-choice.js";
import { deriveChatPickerModelRows } from "../../chat-picker-entries.js";
import { chatAgentInputClass, chatAgentMutedStyle } from "../theme.js";

/** Only the public, owner-authorized Pi route may back an explicit recipe choice. */
export function matrixBotModelChoices(models: readonly CanonicalProviderChoice[]): CanonicalProviderChoice[] {
  return models.filter(isManagedPiBotRoute);
}

/** Retained model arrays cannot override a fresh unavailable catalog snapshot. */
export function matrixBotSelectableModelChoices(models: readonly CanonicalProviderChoice[], catalog?: CanonicalProviderCatalog | null): CanonicalProviderChoice[] {
  const managed = matrixBotModelChoices(models);
  return catalog === undefined ? managed : catalog ? deriveChatPickerModelRows(catalog, managed)
    .filter(isManagedPiBotRoute).flatMap(row => row.choice ? [row.choice] : []) : [];
}

export { isAutomaticBotSelection } from "@matrix-os/contracts";

export function matrixBotModelSelection(choice: CanonicalProviderChoice): CanonicalChatModelSelection {
  return { instanceId: choice.instanceId, model: choice.modelId,
    ...(choice.selectedOptions.length ? { options: choice.selectedOptions } : {}) };
}

export function MatrixBotModelField({ botClient, id, label = "Model", selection, models, catalog, catalogLoading = false, pending, allowAutomatic = true, requireSelection = false, preservedSelection, onSetup, onRefreshCatalog, onChange }: {
  botClient?: BotClient; preservedSelection?: CanonicalChatModelSelection; allowAutomatic?: boolean; requireSelection?: boolean; onSetup?: () => void; onRefreshCatalog?: () => void;
  id?: string; label?: string; selection: CanonicalChatModelSelection | null;
  models: readonly CanonicalProviderChoice[]; pending: boolean;
  catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  onChange(selection: CanonicalChatModelSelection): void;
}) {
  const discovery = useBotConnections(botClient?.connections ? botClient as Required<Pick<BotClient,"connections">> : undefined);
  const rows = catalog ? deriveChatPickerModelRows(catalog, matrixBotModelChoices(models)).filter(isManagedPiBotRoute) : [];
  const choices = matrixBotSelectableModelChoices(models, catalog);
  const automatic = allowAutomatic && ((!selection && !requireSelection) || isAutomaticBotSelection(selection));
  const legacy = preservedSelection && preservedSelection.instanceId !== MATRIX_PI_CHAT_INSTANCE_ID && !isAutomaticBotSelection(preservedSelection)
    ? preservedSelection : undefined;
  const legacyKey = legacy ? JSON.stringify([legacy.instanceId, legacy.model]) : undefined;
  const legacyChoice = legacy ? models.find(choice => choice.instanceId === legacy.instanceId && choice.modelId === legacy.model) : undefined;
  const legacyInstance = catalog?.instances.find(instance => instance.id === legacy?.instanceId);
  const legacyModel = legacyInstance?.models.find(model => model.id === legacy?.model);
  const legacyAvailable = Boolean(legacyChoice && (catalog === undefined || legacyInstance?.availability === "available" && legacyModel?.availability === "available"));
  const legacyLabel = canonicalProviderModelRouteLabel(legacyInstance, legacyModel?.displayName ?? legacyChoice?.modelLabel ?? legacy?.model ?? "")
    + (legacyInstance ? "" : legacyChoice ? ` · ${legacyChoice.harnessLabel}` : "") + ` · Saved route${legacyAvailable ? "" : " · unavailable"}`;
  const key = requireSelection && !selection ? "unselected" : automatic || !selection ? "" : JSON.stringify([selection.instanceId, selection.model]);
  const legacySelected = Boolean(legacy && selection && JSON.stringify(selection) === JSON.stringify(legacy));
  const available = automatic || legacySelected && legacyAvailable || choices.some((choice) => choice.instanceId === selection?.instanceId && choice.modelId === selection.model);
  const blockedRows = rows.filter(row => !row.choice);
  const savedRow = blockedRows.find(row => row.instanceId === selection?.instanceId && row.modelId === selection.model);
  const selectedInstance = catalog?.instances.find(instance => instance.id === selection?.instanceId);
  const reserved = savedRow && selectedInstance && canonicalProviderFundingState(selectedInstance) === "credit_reserved";
  const managedInstance = catalog?.instances.find(instance => isManagedPiBotRoute({ instanceId: instance.id, driverKind: instance.driverKind }));
  const unavailableReason = managedInstance ? canonicalProviderAvailabilityReasonLabel(managedInstance) : "Matrix AI unavailable";
  const noModels = !catalogLoading && choices.length === 0;
  return <div className="grid gap-1.5">
    {botClient?.connections && (!selection || selection.instanceId === MATRIX_PI_CHAT_INSTANCE_ID || isAutomaticBotSelection(selection)) ? <BotConnectionSelector connections={discovery.connections} automatic={isAutomaticBotSelection(selection)} pending={pending} onSetup={onSetup}/> : null}
    <label className="grid gap-1.5 text-sm" htmlFor={id}>{label}
      <select id={id} className={chatAgentInputClass} value={key} disabled={pending || catalogLoading || (!allowAutomatic && noModels && !legacyAvailable)} onChange={(event) => {
        if (pending || catalogLoading) return;
        if (legacy && legacyAvailable && event.target.value === legacyKey) { onChange(legacy); return; }
        if (!event.target.value) { if (allowAutomatic) onChange(MATRIX_BOT_SELECTION); return; }
        const choice = choices.find((candidate) => JSON.stringify([candidate.instanceId, candidate.modelId]) === event.target.value);
        if (choice) onChange(matrixBotModelSelection(choice));
      }}>
        {requireSelection && !selection ? <option value="unselected" disabled>Choose a bot model</option> : null}
        {allowAutomatic ? <option value="">Automatic · managed by this computer</option> : !selection && !requireSelection ? <option value="" disabled>Choose a Matrix AI model</option> : null}
        {legacy ? <option value={legacyKey} disabled={!legacyAvailable}>{legacyLabel}</option> : null}
        {selection && !available && !savedRow && !legacySelected ? <option value={key} disabled>{selection?.model} · unavailable</option> : null}
        {choices.map((choice) => <option key={`${choice.instanceId}:${choice.modelId}`} value={JSON.stringify([choice.instanceId, choice.modelId])}>
          {choice.modelLabel} · Matrix AI</option>)}
        {blockedRows.map(row => <option key={`${row.instanceId}:${row.modelId}`} disabled value={JSON.stringify([row.instanceId, row.modelId])}>
          {row.modelLabel} · Matrix AI · {canonicalProviderUnavailableSelectionLabel(catalog?.instances.find(instance => instance.id === row.instanceId), row.modelId)}
        </option>)}
      </select>
    </label>
    {legacySelected ? <p className="text-xs" style={chatAgentMutedStyle}>This agent keeps its saved route until you choose a Matrix AI model.</p> : null}
    {catalogLoading ? <p role="status" className="text-xs" style={chatAgentMutedStyle}>Loading available bot models…</p> : null}
    {selection && !available && !legacySelected && (reserved || !noModels) ? <p className="text-xs" style={chatAgentMutedStyle}>{reserved ? "Your credit is reserved while usage is confirmed."
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
