import { useEffect, useRef, useState } from "react";
import { checkoutUnavailablePresentation } from "./checkout-unavailable-presentation.js";
import { useDialogFocus } from "./use-dialog-focus.js";
import { useGettingStartedBlocker } from "../getting-started-visibility.js";
import type {
  ProviderAccessSource,
  ProviderGatewayPolicy,
  ProviderModelProvider,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "./types.js";
import { gatewayChatAvailableMicrousd, gatewayCreditLines, money, shortDate, titleCase } from "./utils.js";

const capabilityLabels = {
  tools: "Tools",
  vision: "Vision",
  reasoning: "Reasoning",
  long_context: "Long context",
  audio: "Audio",
};

// Purpose labels belong to the approved Matrix catalog, not arbitrary capability badges.
const modelPurposes: Readonly<Record<string, string>> = {
  "anthropic/claude-sonnet-5": "Coding",
  "claude-sonnet-5": "Coding",
  "@cf/zai-org/glm-5.3-flash": "General",
};

export function matrixGatewayEligibleModels(
  source: ProviderAccessSource | null,
  policy: ProviderGatewayPolicy | null,
  provider: ProviderModelProvider | null,
): ProviderModelProvider["models"] {
  if (source?.kind !== "matrix_gateway" || !policy || !provider) return [];
  return provider.models.filter((model) => model.enabled
    && source.eligibleModelIds.includes(model.id)
    && policy.allowedModelIds.includes(model.id));
}

export function isMatrixGatewaySourceReady(
  source: ProviderAccessSource | null,
  policy: ProviderGatewayPolicy | null,
  provider: ProviderModelProvider | null,
): boolean {
  return isMatrixGatewayRouteVerified(source, policy, provider)
    && (gatewayChatAvailableMicrousd(source) ?? 0) > 0;
}

/** Purchase verification remains independent of spendable Chat capacity. */
function isMatrixGatewayRouteVerified(
  source: ProviderAccessSource | null,
  policy: ProviderGatewayPolicy | null,
  provider: ProviderModelProvider | null,
): boolean {
  return source?.readiness.state === "ready"
    && matrixGatewayEligibleModels(source, policy, provider).length > 0;
}

/** Server-projected discovery is display-only and cannot establish readiness. */
export function isMatrixGatewaySourceDiscoverable(
  source: ProviderAccessSource,
  policy: ProviderGatewayPolicy | null,
  provider: ProviderModelProvider | null,
): boolean {
  return source.readiness.checkedAt !== null
    && (source.readiness.state === "ready" || source.readiness.state === "unavailable")
    && source.usage.kind === "managed_credit" && source.usage.state === "current"
    && matrixGatewayEligibleModels(source, policy, provider).length > 0;
}

export function GatewayPanel({
  source,
  policy,
  provider,
  disabled,
  canSetBudget,
  modelInventory,
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
  onUsageHistory,
}: {
  source: ProviderAccessSource | null;
  policy: ProviderGatewayPolicy | null;
  provider: ProviderModelProvider | null;
  modelInventory?: ProviderSettingsSnapshot["matrixModelInventory"];
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
  onUsageHistory?: () => void;
}) {
  // Older runtimes retain their readiness-based inventory. New runtimes provide
  // an explicit policy inventory that does not imply a runnable route.
  const offeredModels = modelInventory?.filter((model, index, inventory) => model.enabled
    && inventory.findIndex(candidate => candidate.providerId === model.providerId && candidate.id === model.id) === index)
    ?? provider?.models.filter(model => model.enabled
    && source?.eligibleModelIds.includes(model.id) && policy?.allowedModelIds.includes(model.id)) ?? [];
  const budget = policy?.monthlyBudgetMicrousd ?? null;
  const [budgetUsd, setBudgetUsd] = useState(
    budget === null ? "" : String(budget / 1_000_000),
  );
  const [creditDialogOpen, setCreditDialogOpen] = useState(false);
  const [creditPackage, setCreditPackage] = useState<
    "usd_5" | "usd_10" | "usd_25"
  >("usd_5");
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditError, setCreditError] = useState(false);
  const [creditRequestId, setCreditRequestId] = useState("");
  // Scope identity prevents an old machine's checkout from settling a new dialog.
  const checkoutScope = useRef<{ sourceId: string | undefined; submit: typeof onAddCredit } | null>({ sourceId: source?.id, submit: onAddCredit });
  if (checkoutScope.current?.sourceId !== source?.id || checkoutScope.current?.submit !== onAddCredit) {
    checkoutScope.current = { sourceId: source?.id, submit: onAddCredit };
    setCreditDialogOpen(false); setCreditBusy(false); setCreditError(false); setCreditRequestId("");
  }
  useEffect(() => {
    if (!checkoutScope.current) checkoutScope.current = { sourceId: source?.id, submit: onAddCredit };
    return () => { checkoutScope.current = null; };
  }, [onAddCredit, source?.id]);
  useEffect(() => {
    setBudgetUsd(budget === null ? "" : String(budget / 1_000_000));
  }, [budget]);
  const credit = source
    ? gatewayCreditLines(source)
    : { primary: "Chat credit unavailable", secondary: null, stale: false };
  const usageAsOf = source?.usage.asOf ?? null;
  const ready = isMatrixGatewaySourceReady(source, policy, provider);
  const creditRequired = source?.readiness.safeReason === "credit_required";
  const creditReserved = source?.readiness.safeReason === "credit_reserved"
    && source.usage.kind === "managed_credit" && source.usage.state === "current";
  const reservedCredit = source?.usage.kind === "managed_credit" && source.usage.credit.reservedMicrousd > 0
    ? `${money(source.usage.credit.reservedMicrousd, source.usage.currency)} reserved${source.usage.state === "stale" ? " (last confirmed)" : ""}` : null;
  const reservedBudget = source?.usage.kind === "managed_credit" && source.usage.budget.reservedThisMonthMicrousd > 0
    && source.usage.budget.reservedThisMonthMicrousd !== source.usage.credit.reservedMicrousd
    ? `${money(source.usage.budget.reservedThisMonthMicrousd, source.usage.currency)} monthly budget reserved${source.usage.state === "stale" ? " (last confirmed)" : ""}` : null;
  const checkoutAvailable = Boolean(
    source &&
      policy?.topUpEnabled &&
      canAddCredit &&
      source.usage.kind === "managed_credit" &&
      source.usage.state === "current" &&
      (isMatrixGatewayRouteVerified(source, policy, provider) || creditRequired),
  );
  const checkoutUnavailable = checkoutUnavailablePresentation(source, policy, canAddCredit);
  const creditDialog = useRef<HTMLElement | null>(null);
  const closeCreditDialog = () => { if (!creditBusy) setCreditDialogOpen(false); };
  useDialogFocus(creditDialog, creditDialogOpen, closeCreditDialog);
  useGettingStartedBlocker(creditDialogOpen);

  const budgetExceeded = source?.readiness.safeReason === "budget_exceeded";
  const status = !source || !policy ? "Setup needed" : ready ? "Ready" : budgetExceeded ? "Monthly budget reached" : creditReserved ? "Credit reserved" : creditRequired ? "Credit needed"
    : source.readiness.state === "ready" ? "Unavailable" : titleCase(source.readiness.state);

  const saveBudget = () => {
    const trimmed = budgetUsd.trim();
    if (trimmed === "") {
      onMutate({ type: "set_gateway_budget", monthlyBudgetMicrousd: null });
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onMutate({
      type: "set_gateway_budget",
      monthlyBudgetMicrousd: Math.round(parsed * 1_000_000),
    });
  };

  const submitCredit = async () => {
    if (creditBusy || !source || !checkoutAvailable || disabled) return;
    const requestScope = checkoutScope.current;
    if (!requestScope) return;
    setCreditBusy(true);
    setCreditError(false);
    try {
      await onAddCredit(source.id, creditPackage, creditRequestId);
      if (checkoutScope.current === requestScope) setCreditDialogOpen(false);
    } catch (error) {
      console.warn(
        "[provider-settings] Credit checkout failed:",
        error instanceof Error ? error.name : typeof error,
      );
      if (checkoutScope.current === requestScope) setCreditError(true);
    } finally {
      if (checkoutScope.current === requestScope) setCreditBusy(false);
    }
  };

  return (
    <section
      className="matrix-ap-panel matrix-ap-gateway"
      role="region"
      aria-label="Matrix AI"
    >
      <div className="matrix-ap-panel-head">
        <div>
          <h2 id="matrix-ap-gateway-title">
            Matrix AI{" "}
            <span className="matrix-ap-beta">
              Beta
            </span>
          </h2>
          <p className="matrix-ap-help">
            Our models, no Claude or ChatGPT subscription needed.
          </p>
        </div>
        <span
          className="matrix-ap-status-chip"
          data-state={ready ? "ready" : "attention"}
        >
          <i aria-hidden="true" />
          {status}
        </span>
      </div>

      {creditReserved ? <p className="matrix-ap-help">Your credit is reserved while usage is confirmed.</p> : null}
      {budgetExceeded ? <p className="matrix-ap-help">This computer has reached its Matrix AI monthly budget. Contact your workspace administrator or support.</p> : null}
      {source && policy && creditRequired ? (
        <p className="matrix-ap-help">{checkoutAvailable ? "Add credit to use Matrix AI." : "Matrix AI needs spendable credit."}</p>
      ) : null}

      <div className="matrix-ap-credit-row">
        <div>
          <span>Chat credit available</span>
          <strong>{credit.primary}</strong>
          {credit.secondary ? <span>{credit.secondary}</span> : null}
          {reservedCredit ? <span>{reservedCredit}</span> : null}
          {credit.stale ? (
            <span>Credit last confirmed {shortDate(usageAsOf)}</span>
          ) : null}
        </div>
        <div className="matrix-ap-actions">
          <button
            type="button"
            className="matrix-ap-button"
            disabled={!onUsageHistory || disabled}
            onClick={onUsageHistory}
            title={
              !onUsageHistory
                ? "Usage history is unavailable on this computer"
                : undefined
            }
          >
            Usage history
          </button>
          <button
              type="button"
              className="matrix-ap-button matrix-ap-button-primary"
              onClick={() => {
                setCreditError(false);
                setCreditRequestId(crypto.randomUUID());
                setCreditDialogOpen(true);
              }}
              disabled={disabled}
            >
              Buy credit
            </button>
        </div>
      </div>

      {policy && source ? (
        <div className="matrix-ap-model-inventory">
          <h3>Available models</h3>
          <ul>
            {offeredModels
              .map((model) => (
                <li key={"accessSourceId" in model ? `${model.accessSourceId}:${model.id}` : model.id}>
                  <span>{model.displayName}</span>
                  {modelPurposes[model.id] ? <span className="matrix-ap-model-capability">{modelPurposes[model.id]}</span> : null}
                  {model.capabilities?.map(capability => (
                    <span key={capability} className="matrix-ap-model-capability">{capabilityLabels[capability]}</span>
                  ))}
                </li>
              ))}
          </ul>
          {offeredModels.length === 0 ? (
            <p className="matrix-ap-help">
              No models are enabled for this computer.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="matrix-ap-gateway-footer">
        Already have Claude or ChatGPT? Connect it on the agent instead.
      </p>
      {!policy || !source ? <details className="matrix-ap-advanced"><summary>Advanced Matrix AI settings</summary>
          {!ready ? (
            <button
              type="button"
              className="matrix-ap-button"
              disabled={disabled}
              onClick={onRefresh}
              title={source?.readiness.safeReason === "policy" || source?.readiness.action === "contact_owner"
                ? "Matrix AI is restricted by your workspace. Ask your administrator."
                : "Check Matrix AI availability"}
            >
              Check again
            </button>
          ) : null}
      </details> : null}

      {policy && source ? (
        <details className="matrix-ap-advanced">
          <summary>Advanced Matrix AI settings</summary>
          {!ready ? (
            <button
              type="button"
              className="matrix-ap-button"
              disabled={disabled}
              onClick={onRefresh}
              title={source?.readiness.safeReason === "policy" || source?.readiness.action === "contact_owner"
                ? "Matrix AI is restricted by your workspace. Ask your administrator."
                : "Check Matrix AI availability"}
            >
              Check again
            </button>
          ) : null}

          {source.usage.kind === "managed_credit" ? <p className="matrix-ap-help">{money(source.usage.usedMicrousd, source.usage.currency)} used of {money(source.usage.limitMicrousd, source.usage.currency)}</p> : null}
          {reservedBudget ? <p className="matrix-ap-help">{reservedBudget}</p> : null}
          <div className="matrix-ap-actions">
          {ready && onUseGateway && (!isSelected || !selectedAgentEnabled) ? (
            <button
              type="button"
              className="matrix-ap-button matrix-ap-button-primary"
              disabled={disabled}
              onClick={onUseGateway}
            >
              Use Matrix AI
            </button>
          ) : null}
          {ready && isSelected && selectedAgentEnabled ? (
            <span className="matrix-ap-selected-tag">
              Selected for {selectedAgentName}
            </span>
          ) : null}
          {ready && !onUseGateway && !isSelected && onChooseAgent
            ? compatibleAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="matrix-ap-button"
                  onClick={() => onChooseAgent(agent.id)}
                >
                  Choose {agent.displayName}
                </button>
              ))
            : null}
          </div>
      {ready && onUseGateway && !isSelected ? (
        <p className="matrix-ap-help">
          {selectedAgentName} · {selectedModelName}
        </p>
      ) : null}
      {ready && savedRouteUnavailable ? (
        <p className="matrix-ap-help">
          Saved Matrix model unavailable. Choose an allowed model.
        </p>
      ) : null}
      {ready &&
      !onUseGateway &&
      !isSelected &&
      compatibleAgents.length === 0 ? (
        <p className="matrix-ap-help">
          Connect Pi or OpenCode to use Matrix AI.
        </p>
      ) : null}


          <div className="matrix-ap-policy-grid">
            {canSetBudget ? (
              <>
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
                      title={
                        canSetBudget
                          ? undefined
                          : "Changing the Matrix AI budget is not available"
                      }
                      placeholder="No limit"
                    />
                  </span>
                </label>
                <button
                  type="button"
                  className="matrix-ap-button"
                  disabled={disabled || !canSetBudget}
                  title={
                    canSetBudget
                      ? undefined
                      : "Changing the Matrix AI budget is not available"
                  }
                  onClick={saveBudget}
                >
                  Save budget
                </button>
              </>
            ) : (
              <div className="matrix-ap-field">
                <span>Monthly budget</span>
                <strong>
                  {budget === null ? "No monthly limit" : money(budget)}
                </strong>
                <span>Managed by your workspace</span>
              </div>
            )}
            {canSetAllowlist ? (
              <fieldset
                className="matrix-ap-allowlist"
                disabled={disabled || !canSetAllowlist}
                title={
                  canSetAllowlist
                    ? undefined
                    : "Changing the Matrix AI model list is not available"
                }
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
                          onChange={() =>
                            onMutate({
                              type: "set_gateway_allowlist",
                              allowedModelIds: checked
                                ? policy.allowedModelIds.filter(
                                    (id) => id !== model.id,
                                  )
                                : [...policy.allowedModelIds, model.id],
                            })
                          }
                        />
                        <span>{model.displayName}</span>
                      </label>
                    );
                  })}
              </fieldset>
            ) : (
              <p className="matrix-ap-help">
                Model availability is managed by your workspace.
              </p>
            )}
          </div>
        </details>
      ) : null}

      {creditDialogOpen ? (
        <div className="matrix-ap-dialog-backdrop" role="presentation">
          <section
            ref={creditDialog}
            className="matrix-ap-dialog matrix-ap-credit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="matrix-ap-credit-title"
          >
            <header className="matrix-ap-dialog-head matrix-ap-credit-head">
              <div>
                <span className="matrix-ap-eyebrow">Matrix AI</span>
                <h3 id="matrix-ap-credit-title">Add Matrix AI credit</h3>
                <p className="matrix-ap-dialog-copy">
                  {checkoutAvailable ? "Credit is added to this computer after Stripe confirms payment. It does not expire." : "Add credit to your Matrix AI balance."}
                </p>
              </div>
              <button type="button" className="matrix-ap-icon-button" aria-label="Close" disabled={creditBusy} onClick={closeCreditDialog}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </header>
            <div className="matrix-ap-credit-content">
            {checkoutAvailable ? <fieldset
              className="matrix-ap-credit-packages"
              disabled={creditBusy || disabled || !checkoutAvailable}
            >
              <legend>Choose an amount</legend>
              {([5, 10, 25] as const).map((amount) => {
                const id = `usd_${amount}` as const;
                return (
                  <label
                    key={id}
                    data-selected={creditPackage === id ? "true" : undefined}
                  >
                    <input
                      type="radio"
                      disabled={creditBusy || disabled || !checkoutAvailable}
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
            </fieldset> : null}
            {!checkoutAvailable ? (
              <div className="matrix-ap-credit-unavailable" role="status">
                <p>{checkoutUnavailable.message}</p>
              </div>
            ) : null}
            {creditError ? (
              <p className="matrix-ap-credit-error" role="alert">
                Checkout could not be opened. Try again.
              </p>
            ) : null}
            </div>
            <footer className="matrix-ap-dialog-actions matrix-ap-credit-actions">
              {!checkoutAvailable && checkoutUnavailable.refreshable ? <button type="button" className="matrix-ap-button" disabled={disabled} onClick={onRefresh}>Check again</button> : null}
              <button
                type="button"
                className="matrix-ap-button"
                disabled={creditBusy}
                onClick={closeCreditDialog}
              >
                Cancel
              </button>
              {checkoutAvailable ? <button
                type="button"
                className="matrix-ap-button matrix-ap-button-primary"
                disabled={creditBusy || disabled || !checkoutAvailable}
                onClick={() => {
                  void submitCredit();
                }}
              >
                {creditBusy ? "Opening checkout…" : "Continue to checkout"}
              </button> : null}
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
