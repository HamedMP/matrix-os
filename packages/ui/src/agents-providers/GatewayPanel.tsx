import { useEffect, useState } from "react";
import type { ProviderAccessSource, ProviderGatewayPolicy, ProviderModelProvider } from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "./types.js";
import { gatewayCreditLines, shortDate, titleCase } from "./utils.js";

export function GatewayPanel({
  source,
  policy,
  provider,
  disabled,
  canSetBudget,
  canSetAllowlist,
  canAddCredit,
  onMutate,
  onAddCredit,
  onRefresh,
}: {
  source: ProviderAccessSource;
  policy: ProviderGatewayPolicy | null;
  provider: ProviderModelProvider | null;
  disabled: boolean;
  canSetBudget: boolean;
  canSetAllowlist: boolean;
  canAddCredit: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => void;
  onAddCredit: (sourceId: string) => void;
  onRefresh: () => void;
}) {
  const budget = policy?.monthlyBudgetMicrousd ?? null;
  const [budgetUsd, setBudgetUsd] = useState(budget === null ? "" : String(budget / 1_000_000));
  useEffect(() => {
    setBudgetUsd(budget === null ? "" : String(budget / 1_000_000));
  }, [budget]);
  const credit = gatewayCreditLines(source);
  const usageAsOf = source.usage.asOf;
  const ready = source.readiness.state === "ready";

  const saveBudget = () => {
    const trimmed = budgetUsd.trim();
    if (trimmed === "") {
      onMutate({ type: "set_gateway_budget", monthlyBudgetMicrousd: null });
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onMutate({ type: "set_gateway_budget", monthlyBudgetMicrousd: Math.round(parsed * 1_000_000) });
  };

  return (
    <section className="matrix-ap-panel matrix-ap-gateway" aria-labelledby="matrix-ap-gateway-title">
      <div className="matrix-ap-panel-head">
        <div>
          <span className="matrix-ap-eyebrow">Access source</span>
          <h3 id="matrix-ap-gateway-title">Matrix gateway</h3>
        </div>
        <span className="matrix-ap-status-chip" data-state={ready ? "ready" : "attention"}>
          <i aria-hidden="true" />{titleCase(source.readiness.state)}
        </span>
      </div>

      <div className="matrix-ap-credit-row">
        <div>
          <strong>{credit.primary}</strong>
          {credit.secondary ? <span>{credit.secondary}</span> : null}
          {credit.stale ? <span>Credit last confirmed {shortDate(usageAsOf)}</span> : null}
        </div>
        <div className="matrix-ap-actions">
          {!ready && source.readiness.action === "retry" ? (
            <button type="button" className="matrix-ap-button" onClick={onRefresh}>Retry</button>
          ) : null}
          {policy?.topUpEnabled ? (
            <button
              type="button"
              className="matrix-ap-button matrix-ap-button-primary"
              onClick={() => onAddCredit(source.id)}
              disabled={disabled || !canAddCredit}
              title={canAddCredit ? undefined : "Adding credit is not available yet"}
            >
              Add credit
            </button>
          ) : null}
        </div>
      </div>

      {policy ? (
        <div className="matrix-ap-policy-grid">
          <label className="matrix-ap-field">
            <span>Monthly budget</span>
            <span className="matrix-ap-money-input">
              <i aria-hidden="true">$</i>
              <input
                aria-label="Monthly budget in USD"
                inputMode="decimal"
                value={budgetUsd}
                onChange={(event) => setBudgetUsd(event.target.value)}
                disabled={disabled || !canSetBudget}
                title={canSetBudget ? undefined : "Changing the gateway budget is not available"}
                placeholder="No limit"
              />
            </span>
          </label>
          <button
            type="button"
            className="matrix-ap-button"
            disabled={disabled || !canSetBudget}
            title={canSetBudget ? undefined : "Changing the gateway budget is not available"}
            onClick={saveBudget}
          >
            Save budget
          </button>
          <fieldset
            className="matrix-ap-allowlist"
            disabled={disabled || !canSetAllowlist}
            title={canSetAllowlist ? undefined : "Changing the gateway model list is not available"}
          >
            <legend>Models available through Matrix</legend>
            {provider?.models
              .filter((model) => source.eligibleModelIds.includes(model.id))
              .map((model) => {
                const checked = policy.allowedModelIds.includes(model.id);
                return (
                  <label key={model.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      aria-label={`Allow ${model.displayName}`}
                      onChange={() => onMutate({
                        type: "set_gateway_allowlist",
                        allowedModelIds: checked
                          ? policy.allowedModelIds.filter((id) => id !== model.id)
                          : [...policy.allowedModelIds, model.id],
                      })}
                    />
                    <span>{model.displayName}</span>
                  </label>
                );
              })}
          </fieldset>
          {!canSetBudget || !canSetAllowlist ? (
            <p className="matrix-ap-help">Some gateway controls are unavailable in this runtime.</p>
          ) : null}
        </div>
      ) : (
        <p className="matrix-ap-help">Budget and model controls will appear when Matrix gateway policy is available.</p>
      )}
    </section>
  );
}
