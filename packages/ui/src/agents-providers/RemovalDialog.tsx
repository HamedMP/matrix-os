import { useState } from "react";
import type { ProviderAccount, ProviderAccessSource } from "@matrix-os/contracts";
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
  disabled,
  canRemove,
  canReassign,
  onMutate,
  onClose,
}: {
  account: ProviderAccount;
  accounts: ProviderAccount[];
  sources: ProviderAccessSource[];
  disabled: boolean;
  canRemove: boolean;
  canReassign: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => void;
  onClose: () => void;
}) {
  const alternatives = [
    ...sources.filter((source) => source.id !== account.accessSourceId),
    ...accounts.filter((candidate) => candidate.id !== account.id && candidate.providerId === account.providerId),
  ];
  const [targetId, setTargetId] = useState(alternatives[0]?.id ?? "");
  const hasDependencies = dependenciesTotal(account.dependencies) > 0;

  const reassign = () => {
    const targetAccount = accounts.find((candidate) => candidate.id === targetId);
    const target = targetAccount
      ? { kind: "account" as const, accountId: targetAccount.id }
      : { kind: "access_source" as const, accessSourceId: targetId };
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
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={disabled || !canReassign}>
              {alternatives.map((alternative) => (
                <option key={alternative.id} value={alternative.id}>{alternative.displayName}</option>
              ))}
            </select>
          </label>
          <p className="matrix-ap-help">Reassign dependencies first. You can remove the account after the refreshed snapshot shows no remaining use.</p>
          <div className="matrix-ap-dialog-actions">
            <button type="button" className="matrix-ap-button" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="matrix-ap-button matrix-ap-button-primary"
              disabled={disabled || !canReassign || targetId === ""}
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
