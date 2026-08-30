import { useState } from "react";
import type {
  ProviderAccount,
  ProviderAccessSource,
  ProviderGatewayPolicy,
  ProviderHarnessInstance,
} from "@matrix-os/contracts";
import { FeatureDialog } from "./FeatureDialog.js";
import type { ProviderSettingsMutationIntent } from "./types.js";
import { dependenciesTotal } from "./utils.js";

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function RemovalDialog({
  account,
  accounts,
  sources,
  harnesses,
  gatewayPolicy,
  disabled,
  canRemove,
  canReassign,
  onMutate,
  onClose,
}: {
  account: ProviderAccount;
  accounts: ProviderAccount[];
  sources: ProviderAccessSource[];
  harnesses: ProviderHarnessInstance[];
  gatewayPolicy: ProviderGatewayPolicy | null;
  disabled: boolean;
  canRemove: boolean;
  canReassign: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => void;
  onClose: () => void;
}) {
  const affectedHarnesses = harnesses.filter((harness) => harness.selectedAccountId === account.id);
  const sourceSupportsEveryRoute = (source: ProviderAccessSource) => (
    source.providerId === account.providerId
    && affectedHarnesses.every((harness) => source.eligibleModelIds.includes(harness.route.modelId))
    && (source.kind !== "matrix_gateway"
      || (gatewayPolicy?.accessSourceId === source.id
        && affectedHarnesses.every((harness) => gatewayPolicy.allowedModelIds.includes(harness.route.modelId))))
  );
  const alternatives = [
    ...sources
      .filter((source) => source.id !== account.accessSourceId
        && source.kind !== "provider_account"
        && sourceSupportsEveryRoute(source))
      .map((source) => ({
        key: `source:${source.id}`,
        label: source.displayName,
        target: { kind: "access_source" as const, accessSourceId: source.id },
      })),
    ...accounts
      .filter((candidate) => candidate.id !== account.id && candidate.providerId === account.providerId)
      .flatMap((candidate) => {
        const source = sources.find((value) => value.id === candidate.accessSourceId);
        return source && sourceSupportsEveryRoute(source) ? [{
          key: `account:${candidate.id}`,
          label: candidate.displayName,
          target: { kind: "account" as const, accountId: candidate.id },
        }] : [];
      }),
  ];
  const [targetKey, setTargetKey] = useState(alternatives[0]?.key ?? "");
  const hasDependencies = dependenciesTotal(account.dependencies) > 0;

  const reassign = () => {
    const target = alternatives.find((alternative) => alternative.key === targetKey)?.target;
    if (!target) return;
    onMutate({
      type: "reassign_account",
      fromAccountId: account.id,
      target,
      scope: "all_dependencies",
      dependencyGuard: account.dependencies,
    });
    onClose();
  };

  const remove = () => {
    onMutate({
      type: "remove_account",
      accountId: account.id,
      dependencyGuard: account.dependencies,
      confirmation: "remove_account",
    });
    onClose();
  };

  return (
    <FeatureDialog title={`Remove ${account.displayName}`} onClose={onClose}>
      {hasDependencies ? (
        <>
          <p className="matrix-ap-dialog-copy">
            This account is still used by {countLabel(account.dependencies.activeChatCount, "active chat")}, {" "}
            {countLabel(account.dependencies.resumableChatCount, "resumable chat")}, and {" "}
            {countLabel(account.dependencies.harnessInstanceCount, "harness")}.
          </p>
          <label className="matrix-ap-field">
            <span>Reassign to</span>
            <select value={targetKey} onChange={(event) => setTargetKey(event.target.value)} disabled={disabled || !canReassign}>
              {alternatives.map((alternative) => (
                <option key={alternative.key} value={alternative.key}>{alternative.label}</option>
              ))}
            </select>
          </label>
          <p className="matrix-ap-help">Reassign dependencies first. You can remove the account after the refreshed snapshot shows no remaining use.</p>
          <div className="matrix-ap-dialog-actions">
            <button type="button" className="matrix-ap-button" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="matrix-ap-button matrix-ap-button-primary"
              disabled={disabled || !canReassign || targetKey === ""}
              onClick={reassign}
              title={canReassign ? undefined : "Reassignment is not available"}
            >
              Reassign dependencies
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="matrix-ap-dialog-copy">This signs the account out and removes its saved Matrix configuration. Provider-side data is not deleted.</p>
          <div className="matrix-ap-dialog-actions">
            <button type="button" className="matrix-ap-button" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="matrix-ap-button matrix-ap-button-danger"
              disabled={disabled || !canRemove}
              onClick={remove}
              title={canRemove ? undefined : "Removing accounts is not available"}
            >
              Remove account
            </button>
          </div>
        </>
      )}
    </FeatureDialog>
  );
}
