import {useState} from "react";
import {BotConnectionSelector} from "./BotConnectionSelector.js";
import {useBotConnections} from "./use-bot-connections.js";
import type {BotClient} from "./client.js";
import { MATRIX_BOT_SELECTION, MATRIX_PI_CHAT_INSTANCE_ID, MATRIX_CHATGPT_PLAN_INSTANCE_ID, MATRIX_ANTHROPIC_API_INSTANCE_ID, isMatrixAnthropicBotRoute, matrixAnthropicSelectionBinding, sameMatrixAnthropicSelectionBinding, isAutomaticBotSelection, isManagedPiBotRoute, isPiBotCoordinatorRoute, isChatgptPlanBotRoute, chatgptPlanSelectionBinding, sameChatgptPlanSelectionBinding, canonicalProviderModelRouteLabel, canonicalProviderFundingState, canonicalProviderAvailabilityReasonLabel, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { canonicalProviderUnavailableSelectionLabel, type CanonicalProviderChoice } from "../../canonical-provider-choice.js";
import { deriveChatPickerModelRows } from "../../chat-picker-entries.js";
import { chatAgentInputClass, chatAgentMutedStyle } from "../theme.js";

/** Only the public, owner-authorized Pi route may back an explicit recipe choice. */
export function matrixBotModelChoices(models: readonly CanonicalProviderChoice[]): CanonicalProviderChoice[] {
  return models.filter(choice => isManagedPiBotRoute(choice) || isMatrixAnthropicBotRoute(choice) && !!matrixAnthropicSelectionBinding(choice.selectedOptions) || isChatgptPlanBotRoute(choice) && !!chatgptPlanSelectionBinding(choice.selectedOptions));
}

/** Retained model arrays cannot override a fresh unavailable catalog snapshot. */
export function matrixBotSelectableModelChoices(models: readonly CanonicalProviderChoice[], catalog?: CanonicalProviderCatalog | null, includeSubscription = true): CanonicalProviderChoice[] {
  const managed = matrixBotModelChoices(models).filter(choice => includeSubscription || !isChatgptPlanBotRoute(choice));
  const scoped = catalog ? managed.filter(choice => {
    const current = catalog.instances.find(instance => instance.id === choice.instanceId)?.defaultSelection?.options;
    return isMatrixAnthropicBotRoute(choice) ? sameMatrixAnthropicSelectionBinding(choice.selectedOptions, current)
      : !isChatgptPlanBotRoute(choice) || sameChatgptPlanSelectionBinding(choice.selectedOptions, current);
  }) : managed;
  return catalog === undefined ? managed : catalog ? deriveChatPickerModelRows(catalog, scoped)
    .filter(isPiBotCoordinatorRoute).flatMap(row => row.choice ? [row.choice] : []) : [];
}

export function botModelChoiceMatchesSelection(choice: CanonicalProviderChoice, selection: CanonicalChatModelSelection | null | undefined): boolean {
  return choice.instanceId === selection?.instanceId && choice.modelId === selection.model
    && (!isChatgptPlanBotRoute(choice) || sameChatgptPlanSelectionBinding(choice.selectedOptions, selection.options))
    && (!isMatrixAnthropicBotRoute(choice) || sameMatrixAnthropicSelectionBinding(choice.selectedOptions, selection.options));
}

export { isAutomaticBotSelection } from "@matrix-os/contracts";

export function matrixBotModelSelection(choice: CanonicalProviderChoice): CanonicalChatModelSelection {
  return { instanceId: choice.instanceId, model: choice.modelId,
    ...(choice.selectedOptions.length ? { options: choice.selectedOptions } : {}) };
}

function modelSelectionKey(selection: CanonicalChatModelSelection): string {
  return selection.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID || selection.instanceId === MATRIX_ANTHROPIC_API_INSTANCE_ID
    ? JSON.stringify([selection.instanceId, selection.model, selection.options ?? []])
    : JSON.stringify([selection.instanceId, selection.model]);
}

export function MatrixBotModelField({ botClient, id, label = "Model", selection, models, catalog, catalogLoading = false, pending, allowAutomatic = true, allowSubscription = true, requireSelection = false, preservedSelection, onSetup, onRefreshCatalog, onChange }: {
  botClient?: BotClient; preservedSelection?: CanonicalChatModelSelection; allowAutomatic?: boolean; allowSubscription?: boolean; requireSelection?: boolean; onSetup?: () => void; onRefreshCatalog?: () => void;
  id?: string; label?: string; selection: CanonicalChatModelSelection | null;
  models: readonly CanonicalProviderChoice[]; pending: boolean;
  catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  onChange(selection: CanonicalChatModelSelection | null): void;
}) {
  const discovery = useBotConnections(botClient?.connections ? botClient as Required<Pick<BotClient,"connections">> : undefined);
  const [connectionIntent, setConnectionIntent] = useState<string | null>(null);
  const automatic = allowAutomatic && ((!selection && !requireSelection && !connectionIntent) || isAutomaticBotSelection(selection));
  const sourceId = selection ? isAutomaticBotSelection(selection) ? "computer" : selection.instanceId
    : connectionIntent ?? MATRIX_PI_CHAT_INSTANCE_ID;
  const allChoices = matrixBotSelectableModelChoices(models, catalog, allowSubscription);
  const coordinatorSource = sourceId === MATRIX_PI_CHAT_INSTANCE_ID || sourceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID || sourceId === MATRIX_ANTHROPIC_API_INSTANCE_ID;
  const rows = catalog ? deriveChatPickerModelRows(catalog, matrixBotModelChoices(models)).filter(isPiBotCoordinatorRoute)
    .filter(row => !coordinatorSource || row.instanceId === sourceId) : [];
  const choices = allChoices.filter(choice => !coordinatorSource || choice.instanceId === sourceId);
  const legacy = preservedSelection && preservedSelection.instanceId !== MATRIX_PI_CHAT_INSTANCE_ID && preservedSelection.instanceId !== MATRIX_CHATGPT_PLAN_INSTANCE_ID && preservedSelection.instanceId !== MATRIX_ANTHROPIC_API_INSTANCE_ID && !isAutomaticBotSelection(preservedSelection)
    ? preservedSelection : undefined;
  const legacyKey = legacy ? JSON.stringify([legacy.instanceId, legacy.model]) : undefined;
  const legacyChoice = legacy ? models.find(choice => choice.instanceId === legacy.instanceId && choice.modelId === legacy.model) : undefined;
  const legacyInstance = catalog?.instances.find(instance => instance.id === legacy?.instanceId);
  const legacyModel = legacyInstance?.models.find(model => model.id === legacy?.model);
  const legacyAvailable = Boolean(legacyChoice && (catalog === undefined || legacyInstance?.availability === "available" && legacyModel?.availability === "available"));
  const legacyLabel = canonicalProviderModelRouteLabel(legacyInstance, legacyModel?.displayName ?? legacyChoice?.modelLabel ?? legacy?.model ?? "")
    + (legacyInstance ? "" : legacyChoice ? ` · ${legacyChoice.harnessLabel}` : "") + ` · Saved route${legacyAvailable ? "" : " · unavailable"}`;
  const unselected = !selection && (requireSelection || !!connectionIntent || !allowAutomatic);
  const key = unselected ? "unselected" : automatic || !selection ? "" : modelSelectionKey(selection);
  const legacySelected = Boolean(legacy && selection && JSON.stringify(selection) === JSON.stringify(legacy));
  const available = automatic || legacySelected && legacyAvailable || choices.some((choice) => botModelChoiceMatchesSelection(choice, selection));
  const blockedRows = rows.filter(row => !row.choice);
  const savedRow = blockedRows.find(row => row.instanceId === selection?.instanceId && row.modelId === selection.model);
  const selectedInstance = catalog?.instances.find(instance => instance.id === selection?.instanceId);
  const reserved = savedRow && selectedInstance && canonicalProviderFundingState(selectedInstance) === "credit_reserved";
  const managedInstance = catalog?.instances.find(instance => instance.id === (sourceId === "computer" ? MATRIX_PI_CHAT_INSTANCE_ID : sourceId));
  const unavailableReason = managedInstance ? canonicalProviderAvailabilityReasonLabel(managedInstance) : sourceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID ? "ChatGPT subscription unavailable" : "Matrix AI unavailable";
  const noModels = !catalogLoading && choices.length === 0;
  const sourceName = sourceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID ? "ChatGPT subscription" : sourceId === MATRIX_ANTHROPIC_API_INSTANCE_ID ? "Anthropic API" : "Matrix AI";
  const showApi = sourceId === MATRIX_ANTHROPIC_API_INSTANCE_ID || !!catalog?.instances.some(instance => instance.id === MATRIX_ANTHROPIC_API_INSTANCE_ID);
  const showConnection = showApi || !!botClient?.connections || sourceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID
    || allowSubscription && !!catalog?.instances.some(instance => instance.id === MATRIX_CHATGPT_PLAN_INSTANCE_ID);
  return <div className="grid gap-1.5">
    {showConnection ? <BotConnectionSelector connections={discovery.connections} value={sourceId} showApi={showApi} apiAvailable={allChoices.some(choice => choice.instanceId === MATRIX_ANTHROPIC_API_INSTANCE_ID)} showSubscription={sourceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID || allowSubscription && (!!catalog?.instances.some(instance => instance.id === MATRIX_CHATGPT_PLAN_INSTANCE_ID) || !!discovery.connections?.connections.some(item => item.id === MATRIX_CHATGPT_PLAN_INSTANCE_ID))}
      subscriptionAvailable={allChoices.some(choice => choice.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID)} pending={pending || catalogLoading} onSetup={onSetup} onChange={value => {
        if (value !== MATRIX_PI_CHAT_INSTANCE_ID && value !== MATRIX_CHATGPT_PLAN_INSTANCE_ID && value !== MATRIX_ANTHROPIC_API_INSTANCE_ID && value !== "computer") return;
        setConnectionIntent(value); onChange(value === "computer" ? MATRIX_BOT_SELECTION : null);
      }}/> : null}
    <label className="grid gap-1.5 text-sm" htmlFor={id}>{label}
      <select id={id} className={chatAgentInputClass} value={key} disabled={pending || catalogLoading || (!allowAutomatic && noModels && !legacyAvailable)} onChange={(event) => {
        if (pending || catalogLoading) return;
        if (legacy && legacyAvailable && event.target.value === legacyKey) { onChange(legacy); return; }
        if (!event.target.value) { if (allowAutomatic) onChange(MATRIX_BOT_SELECTION); return; }
        const choice = choices.find((candidate) => modelSelectionKey(matrixBotModelSelection(candidate)) === event.target.value);
        if (choice) onChange(matrixBotModelSelection(choice));
      }}>
        {unselected ? <option value="unselected" disabled>Choose a bot model</option> : null}
        {allowAutomatic ? <option value="">Automatic · managed by this computer</option> : null}
        {legacy ? <option value={legacyKey} disabled={!legacyAvailable}>{legacyLabel}</option> : null}
        {selection && !available && !savedRow && !legacySelected ? <option value={key} disabled>{selection?.model} · unavailable</option> : null}
        {choices.map((choice) => <option key={`${choice.instanceId}:${choice.modelId}`} value={modelSelectionKey(matrixBotModelSelection(choice))}>
          {choice.modelLabel} · {choice.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID ? "ChatGPT subscription" : choice.instanceId === MATRIX_ANTHROPIC_API_INSTANCE_ID ? "Anthropic API" : "Matrix AI"}</option>)}
        {blockedRows.map(row => <option key={`${row.instanceId}:${row.modelId}`} disabled value={JSON.stringify([row.instanceId, row.modelId])}>
          {row.modelLabel} · {sourceName} · {canonicalProviderUnavailableSelectionLabel(catalog?.instances.find(instance => instance.id === row.instanceId), row.modelId)}
        </option>)}
      </select>
    </label>
    {legacySelected ? <p className="text-xs" style={chatAgentMutedStyle}>This agent keeps its saved route until you choose a Matrix AI model.</p> : null}
    {catalogLoading ? <p role="status" className="text-xs" style={chatAgentMutedStyle}>Loading available bot models…</p> : null}
    {selection && !available && !legacySelected && (reserved || !noModels) ? <p className="text-xs" style={chatAgentMutedStyle}>{reserved ? "Your credit is reserved while usage is confirmed."
      : "This saved bot model is unavailable. Choose another model or check Agents & providers."}</p> : null}
    {noModels ? <div className="grid gap-2 text-xs" style={chatAgentMutedStyle}>
      <p>No {sourceName} models available. {unavailableReason === "Available" ? "Check Agents & providers." : `${unavailableReason}.`}</p>
      {allowAutomatic ? <p>Automatic follows this computer’s configured route. Its availability is checked when you send.</p> : null}
      {onSetup || onRefreshCatalog ? <div className="flex flex-wrap gap-3">
        {onRefreshCatalog ? <button type="button" className="underline" disabled={pending || catalogLoading} onClick={onRefreshCatalog}>Check availability</button> : null}
        {onSetup ? <button type="button" className="underline" disabled={pending} onClick={onSetup}>Agents & providers</button> : null}
      </div> : null}
    </div> : null}
  </div>;
}
