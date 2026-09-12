import { useEffect, useState } from "react";
import { useGettingStartedBlocker } from "../getting-started-visibility.js";
import type { ProviderAccessSource, ProviderGatewayPolicy, ProviderModelProvider } from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "./types.js";
import { gatewayCreditLines, money, shortDate, titleCase } from "./utils.js";

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
  onUseGateway,
  selectedAgentName = null,
  selectedAgentEnabled = false,
  selectedModelName = null,
  isSelected = false,
  savedRouteUnavailable = false,
  compatibleAgents = [],
  onChooseAgent,
}: {
  source: ProviderAccessSource | null;
  policy: ProviderGatewayPolicy | null;
  provider: ProviderModelProvider | null;
  disabled: boolean;
  canSetBudget: boolean;
  canSetAllowlist: boolean;
  canAddCredit: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => void;
  onAddCredit: (
    sourceId: string,
    packageId: "usd_5" | "usd_10" | "usd_25",
    requestId: string,
  ) => Promise<void> | void;
  onRefresh: () => void;
  onUseGateway?: () => void;
  selectedAgentName?: string | null;
  selectedAgentEnabled?: boolean;
  selectedModelName?: string | null;
  isSelected?: boolean;
  savedRouteUnavailable?: boolean;
  compatibleAgents?: ReadonlyArray<{ id: string; displayName: string }>;
  onChooseAgent?: (id: string) => void;
}) {
  const budget = policy?.monthlyBudgetMicrousd ?? null;
  const [budgetUsd, setBudgetUsd] = useState(budget === null ? "" : String(budget / 1_000_000));
  const [creditDialogOpen, setCreditDialogOpen] = useState(false);
  useGettingStartedBlocker(creditDialogOpen);
  const [creditPackage, setCreditPackage] = useState<"usd_5" | "usd_10" | "usd_25">("usd_5");
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditError, setCreditError] = useState(false);
  const [creditRequestId, setCreditRequestId] = useState("");
  useEffect(() => {
    setBudgetUsd(budget === null ? "" : String(budget / 1_000_000));
  }, [budget]);
  const credit = source ? gatewayCreditLines(source) : { primary: "Credit unavailable", secondary: null, stale: false };
  const usageAsOf = source?.usage.asOf ?? null;
  const ready = source?.readiness.state === "ready" && policy?.accessSourceId === source.id;
  const status = !source || !policy ? "Setup needed" : ready ? "Ready" : titleCase(source.readiness.state);

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

  const submitCredit = async () => {
    if (creditBusy || !source || !canAddCredit || disabled) return;
    setCreditBusy(true);
    setCreditError(false);
    try {
      await onAddCredit(source.id, creditPackage, creditRequestId);
      setCreditDialogOpen(false);
    } catch (error) {
      console.warn(
        "[provider-settings] Credit checkout failed:",
        error instanceof Error ? error.name : typeof error,
      );
      setCreditError(true);
    } finally {
      setCreditBusy(false);
    }
  };

  return (
    <section className="matrix-ap-panel matrix-ap-gateway" role="region" aria-labelledby="matrix-ap-gateway-title">
      <div className="matrix-ap-panel-head">
        <div>
          <h2 id="matrix-ap-gateway-title"><span className="matrix-ap-gateway-symbol" aria-hidden="true">✦</span>Matrix AI</h2>
          <p className="matrix-ap-help">Models included with your Matrix credit. No separate login.</p>
        </div>
        <span className="matrix-ap-status-chip" data-state={ready ? "ready" : "attention"}>
          <i aria-hidden="true" />{status}
        </span>
      </div>

      {!source || !policy ? (
        <p className="matrix-ap-help">Matrix AI is not enabled for this computer. Ask your workspace administrator.</p>
      ) : !ready ? (
        <p className="matrix-ap-help">{source.readiness.safeReason === "policy" || source.readiness.action === "contact_owner"
          ? "Matrix AI is restricted by your workspace. Ask your administrator."
          : "Matrix AI connection not verified. Check again."}</p>
      ) : null}

      <div className="matrix-ap-credit-row">
        <div>
          <strong>{credit.primary}</strong>
          {credit.secondary ? <span>{credit.secondary}</span> : null}
          {credit.stale ? <span>Credit last confirmed {shortDate(usageAsOf)}</span> : null}
        </div>
        <div className="matrix-ap-actions">
          {!ready ? (
            <button type="button" className="matrix-ap-button" disabled={disabled} onClick={onRefresh}>Check again</button>
          ) : null}
          {ready && onUseGateway && (!isSelected || !selectedAgentEnabled) ? (
            <button type="button" className="matrix-ap-button matrix-ap-button-primary" disabled={disabled} onClick={onUseGateway}>Use Matrix AI</button>
          ) : null}
          {ready && isSelected && selectedAgentEnabled ? <span className="matrix-ap-selected-tag">Selected for {selectedAgentName}</span> : null}
          {ready && !onUseGateway && !isSelected && onChooseAgent ? compatibleAgents.map((agent) => (
            <button key={agent.id} type="button" className="matrix-ap-button" onClick={() => onChooseAgent(agent.id)}>Choose {agent.displayName}</button>
          )) : null}
          {source && policy?.topUpEnabled && canAddCredit ? (
            <button
              type="button"
              className="matrix-ap-button matrix-ap-button-primary"
              onClick={() => {
                setCreditError(false);
                setCreditRequestId(crypto.randomUUID());
                setCreditDialogOpen(true);
              }}
              disabled={disabled || !canAddCredit}
              title={canAddCredit ? undefined : "Adding credit is not available yet"}
            >
              Add credit
            </button>
          ) : null}
        </div>
      </div>
      {ready && onUseGateway && !isSelected ? <p className="matrix-ap-help">{selectedAgentName} · {selectedModelName}</p> : null}
      {ready && savedRouteUnavailable ? <p className="matrix-ap-help">Saved Matrix model unavailable. Choose an allowed model.</p> : null}
      {ready && !onUseGateway && !isSelected && compatibleAgents.length === 0 ? <p className="matrix-ap-help">Connect Pi or OpenCode to use Matrix AI.</p> : null}

      {policy && source ? (
        <details className="matrix-ap-advanced"><summary>Usage &amp; available models</summary><div className="matrix-ap-policy-grid">
          {canSetBudget ? <>
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
                title={canSetBudget ? undefined : "Changing the Matrix AI budget is not available"}
                placeholder="No limit"
              />
            </span>
          </label>
          <button
            type="button"
            className="matrix-ap-button"
            disabled={disabled || !canSetBudget}
            title={canSetBudget ? undefined : "Changing the Matrix AI budget is not available"}
            onClick={saveBudget}
          >
            Save budget
          </button>
          </> : (
            <div className="matrix-ap-field"><span>Monthly budget</span><strong>{budget === null ? "No monthly limit" : money(budget)}</strong><span>Managed by your workspace</span></div>
          )}
          {canSetAllowlist ? (
          <fieldset
            className="matrix-ap-allowlist"
            disabled={disabled || !canSetAllowlist}
            title={canSetAllowlist ? undefined : "Changing the Matrix AI model list is not available"}
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
          ) : (
            <div className="matrix-ap-available-models"><span>Available models</span><ul>{provider?.models.filter((model) => model.enabled && source.eligibleModelIds.includes(model.id) && policy.allowedModelIds.includes(model.id)).map((model) => <li key={model.id}>{model.displayName}</li>)}</ul>{!provider?.models.some((model) => model.enabled && source.eligibleModelIds.includes(model.id) && policy.allowedModelIds.includes(model.id)) ? <p className="matrix-ap-help">No models are enabled for this computer.</p> : null}</div>
          )}
        </div></details>
      ) : null}

      {creditDialogOpen && source && policy?.topUpEnabled && canAddCredit ? (
        <div className="matrix-ap-dialog-backdrop" role="presentation">
          <section className="matrix-ap-dialog" role="dialog" aria-modal="true" aria-labelledby="matrix-ap-credit-title">
            <div className="matrix-ap-dialog-head">
              <div>
                <span className="matrix-ap-eyebrow">Matrix AI</span>
                <h3 id="matrix-ap-credit-title">Add Matrix AI credit</h3>
                <p className="matrix-ap-dialog-copy">
                  Credit is added to this computer after Stripe confirms payment. It does not expire.
                </p>
              </div>
            </div>
            <fieldset className="matrix-ap-credit-packages" disabled={creditBusy}>
              <legend>Choose an amount</legend>
              {([5, 10, 25] as const).map((amount) => {
                const id = `usd_${amount}` as const;
                return (
                  <label key={id} data-selected={creditPackage === id ? "true" : undefined}>
                    <input
                      type="radio"
                      name="matrix-ai-credit-package"
                      value={id}
                      checked={creditPackage === id}
                      onChange={() => setCreditPackage(id)}
                      aria-label={`$${amount} credit`}
                    />
                    <strong>${amount}</strong>
                    <span>AI credit</span>
                  </label>
                );
              })}
            </fieldset>
            {creditError ? (
              <p className="matrix-ap-credit-error" role="alert">Checkout could not be opened. Try again.</p>
            ) : null}
            <div className="matrix-ap-dialog-actions">
              <button
                type="button"
                className="matrix-ap-button"
                disabled={creditBusy}
                onClick={() => setCreditDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="matrix-ap-button matrix-ap-button-primary"
                disabled={creditBusy}
                onClick={() => { void submitCredit(); }}
              >
                {creditBusy ? "Opening checkout…" : "Continue to checkout"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
