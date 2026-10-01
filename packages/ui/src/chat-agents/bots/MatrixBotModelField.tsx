import { MATRIX_BOT_SELECTION, MATRIX_PI_CHAT_INSTANCE_ID, isManagedPiBotRoute, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { CanonicalProviderChoice } from "../../canonical-provider-choice.js";
import { chatAgentInputClass, chatAgentMutedStyle } from "../theme.js";

/** Only the public, owner-authorized Pi route may back an explicit recipe choice. */
export function matrixBotModelChoices(models: readonly CanonicalProviderChoice[]): CanonicalProviderChoice[] {
  return models.filter(isManagedPiBotRoute);
}

export function matrixBotModelSelection(choice: CanonicalProviderChoice): CanonicalChatModelSelection {
  return { instanceId: choice.instanceId, model: choice.modelId,
    ...(choice.selectedOptions.length ? { options: choice.selectedOptions } : {}) };
}

export function MatrixBotModelField({ id, label = "Model", selection, models, pending, onChange }: {
  id?: string; label?: string; selection: CanonicalChatModelSelection | null;
  models: readonly CanonicalProviderChoice[]; pending: boolean;
  onChange(selection: CanonicalChatModelSelection): void;
}) {
  const choices = matrixBotModelChoices(models);
  const automatic = !selection || selection.instanceId !== MATRIX_PI_CHAT_INSTANCE_ID;
  const key = automatic ? "" : JSON.stringify([selection.instanceId, selection.model]);
  const available = automatic || choices.some((choice) => choice.instanceId === selection?.instanceId && choice.modelId === selection.model);
  return <div className="grid gap-1.5">
    <label className="grid gap-1.5 text-sm" htmlFor={id}>{label}
      <select id={id} className={chatAgentInputClass} value={key} disabled={pending} onChange={(event) => {
        if (!event.target.value) return onChange(MATRIX_BOT_SELECTION);
        const choice = choices.find((candidate) => JSON.stringify([candidate.instanceId, candidate.modelId]) === event.target.value);
        if (choice) onChange(matrixBotModelSelection(choice));
      }}>
        <option value="">Automatic · managed by this computer</option>
        {!available ? <option value={key}>{selection?.model} · unavailable</option> : null}
        {choices.map((choice) => <option key={`${choice.instanceId}:${choice.modelId}`} value={JSON.stringify([choice.instanceId, choice.modelId])}>
          {choice.modelLabel} · Matrix AI · Pi</option>)}
      </select>
    </label>
    {!available ? <p className="text-xs" style={chatAgentMutedStyle}>This saved Matrix AI model is unavailable. Choose another model or check Agents &amp; providers.</p> : null}
  </div>;
}
