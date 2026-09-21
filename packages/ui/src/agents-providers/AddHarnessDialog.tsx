import { useState } from "react";
import {
  isSupportedGenericHarnessCredentialRoute,
  type ProviderGenericHarnessKind,
  type ProviderHarnessKind,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { FeatureDialog } from "./FeatureDialog.js";
import type { ProviderSettingsMutationIntent } from "./types.js";

function routesFor(snapshot: ProviderSettingsSnapshot, harness: ProviderGenericHarnessKind) {
  return snapshot.accessSources.flatMap((source) => {
    const provider = snapshot.modelProviders.find((item) => item.id === source.providerId);
    return (provider?.models ?? []).filter((model) => model.enabled
      && source.eligibleModelIds.includes(model.id)
      && (source.kind !== "matrix_gateway" || snapshot.gatewayPolicy?.allowedModelIds.includes(model.id))
      && isSupportedGenericHarnessCredentialRoute({
        harness, accessSourceId: source.id, route: { kind: "configurable", providerId: source.providerId, modelId: model.id },
      }, source)).map((model) => ({ source, model, provider: provider! }));
  });
}

export function AddHarnessDialog({ snapshot, onMutate, onClose, onRefresh, onSetupHarness, busy = false, error }: {
  snapshot: ProviderSettingsSnapshot;
  onMutate: (intent: ProviderSettingsMutationIntent) => Promise<boolean> | void;
  onClose: () => void;
  onRefresh?: () => void;
  onSetupHarness?: (harness: ProviderHarnessKind) => Promise<boolean>;
  busy?: boolean;
  error?: string | null;
}) {
  const first = snapshot.harnessCatalog.find((entry) => entry.available && entry.runnable)
    ?? snapshot.harnessCatalog.find((entry) => entry.available) ?? snapshot.harnessCatalog[0];
  const [kind, setKind] = useState<ProviderGenericHarnessKind>(first?.harness ?? "pi");
  const [step, setStep] = useState(0);
  const [sourceId, setSourceId] = useState("");
  const [modelId, setModelId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const catalog = snapshot.harnessCatalog.find((entry) => entry.harness === kind);
  const routes = routesFor(snapshot, kind);
  const sources = snapshot.accessSources.filter((source) => routes.some((route) => route.source.id === source.id));
  const source = sourceId !== "" ? sources.find((item) => item.id === sourceId)
    : sources.find((item) => item.kind === "matrix_gateway" && item.readiness.state === "ready")
      ?? sources.find((item) => item.readiness.state === "ready") ?? sources[0];
  const sourceRoutes = routes.filter((route) => route.source.id === source?.id);
  const providers = snapshot.modelProviders.filter((item) => sourceRoutes.some((route) => route.provider.id === item.id));
  const provider = providerId !== "" ? providers.find((item) => item.id === providerId) : providers[0];
  const models = sourceRoutes.filter((route) => route.provider.id === provider?.id).map((route) => route.model);
  const model = modelId !== "" ? models.find((item) => item.id === modelId) : models[0];
  const writable = snapshot.access.mode === "writable";
  const installed = catalog?.installState === "installed";
  const ready = catalog?.runnable && source?.readiness.state === "ready" && model !== undefined;
  const disabled = pending || busy || !writable;
  const setupLabel = installed ? `Connect ${catalog?.displayName ?? "agent"} in Terminal`
    : `Install ${catalog?.displayName ?? "agent"} in Terminal`;
  const next = () => {
    if (step === 1) {
      if (!ready || !source || !provider || !model) return;
      setSourceId(source.id);
      setProviderId(provider.id);
      setModelId(model.id);
    }
    setStep(step + 1);
  };

  const setup = async () => {
    if (!onSetupHarness || disabled) return;
    setPending(true);
    setLocalError(null);
    try {
      if (!await onSetupHarness(kind)) {
        setLocalError("Setup could not open. Check again or open this agent from Terminal.");
        return;
      }
      setNotice("Terminal is open. Finish setup there, then return here and check again.");
    } catch (caught) {
      console.warn("[provider-settings] Setup failed:", caught instanceof Error ? caught.name : typeof caught);
      setLocalError("Setup could not open. Check again or open this agent from Terminal.");
    } finally { setPending(false); }
  };

  const add = async () => {
    if (disabled || !ready || !source || !provider || !model || !catalog) return;
    setPending(true);
    setLocalError(null);
    try {
      const saved = await onMutate({ type: "add_harness", harness: kind, displayName: catalog.displayName,
        route: { kind: "configurable", providerId: provider.id, modelId: model.id },
        accessSourceId: source.id, accountId: source.accountId });
      if (saved === true) onClose();
      else setLocalError("Changes were not saved. Your choices are kept; try again.");
    } catch (caught) {
      console.warn("[provider-settings] Add agent failed:", caught instanceof Error ? caught.name : typeof caught);
      setLocalError("Changes were not saved. Your choices are kept; try again.");
    } finally { setPending(false); }
  };

  return (
    <FeatureDialog title="Add agent" onClose={() => { if (!pending) onClose(); }}>
      <ol className="matrix-ap-setup-steps" aria-label="Setup steps">
        {["Agent", "Connect", "Model"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}>{index + 1}. {label}</li>)}
      </ol>
      {localError || error ? <p className="matrix-ap-notice" role="alert">{localError ?? "Changes were not saved. Refresh and try again."}</p> : null}
      {step === 0 ? <>
        <p className="matrix-ap-help">Installed agents appear automatically. Add a configured instance when you need a different model or connection.</p>
        <div className="matrix-ap-driver-grid">
          {snapshot.harnessCatalog.map((entry) => <label key={entry.harness} data-selected={kind === entry.harness ? "true" : undefined}>
            <input type="radio" name="harness-kind" aria-label={entry.displayName} aria-describedby={`matrix-ap-setup-${entry.harness}`} checked={kind === entry.harness} disabled={!entry.available || disabled}
              onChange={() => { setKind(entry.harness); setSourceId(""); setProviderId(""); setModelId(""); setNotice(null); setLocalError(null); }} />
            <span>{entry.displayName}</span>
            <small id={`matrix-ap-setup-${entry.harness}`}>{!entry.available ? "Unavailable on this computer" : entry.installState === "installed" ? "Installed" : entry.installState === "missing" ? "Install required" : "Check installation"}</small>
          </label>)}
        </div>
        <p className="matrix-ap-help">Claude and Codex are detected separately. Connect their existing entries in Agents &amp; providers; additional isolated accounts are not supported here yet.</p>
      </> : null}
      {step === 1 ? <>
        <h4>{installed ? `Connect ${catalog?.displayName}` : `Install ${catalog?.displayName}`}</h4>
        {kind === "hermes" || kind === "openclaw" ? <p className="matrix-ap-help">Matrix AI funding is not supported for this agent yet. Connect your own provider account using Terminal.</p> : null}
        {!installed || !catalog?.runnable ? <p className="matrix-ap-help">{installed ? "Finish agent setup, then check again." : "Installation runs in a visible Terminal. This page will only continue after the computer reports the agent ready."}</p> : null}
        {onSetupHarness && (!ready || source?.kind === "harness_profile") ? <button type="button" className="matrix-ap-button" disabled={disabled || !catalog?.available} onClick={() => void setup()}>{setupLabel}</button> : null}
        {notice ? <p role="status" className="matrix-ap-help">{notice}</p> : null}
        {onRefresh ? <button type="button" className="matrix-ap-button" disabled={disabled} onClick={onRefresh}>Check again</button> : null}
        <label className="matrix-ap-field"><span>Use AI through</span>
          <select value={source?.id ?? ""} disabled={disabled || !installed} onChange={(event) => { setSourceId(event.target.value); setProviderId(""); setModelId(""); }}>
            {!source ? <option value="">{sources.length === 0 ? "No connections available" : "Choose a connection again"}</option> : null}
            {sources.map((item) => <option key={item.id} value={item.id}>{item.displayName}{item.readiness.state === "ready" ? "" : " · setup required"}</option>)}
          </select>
        </label>
        {source?.kind === "matrix_gateway" ? <p className="matrix-ap-help">{source.readiness.state === "ready" ? "Uses your Matrix AI credit. No provider login is needed." : "Matrix AI is not ready on this computer. Its gateway configuration and credit must be enabled before you can use it."}</p>
          : source?.kind === "harness_profile" ? <p className="matrix-ap-help">This agent uses its own saved login. Manage it in Terminal; Matrix does not create extra account profiles.</p>
          : <p className="matrix-ap-help">Use a connected account from Agents &amp; providers. Only connections reported ready can continue.</p>}
        {!snapshot.accessSources.some((item) => item.kind === "matrix_gateway") ? <p className="matrix-ap-help">Matrix AI is not ready on this computer. See the Matrix AI section for its setup status.</p> : null}
      </> : null}
      {step === 2 ? <>
        <h4>Choose a model</h4>
        <p className="matrix-ap-help">{catalog?.displayName} · {source?.displayName}. Only models available through this connection are shown.</p>
        {source?.kind !== "matrix_gateway" ? <label className="matrix-ap-field"><span>Model provider</span><select value={provider?.id ?? ""} disabled={disabled} onChange={(event) => { setProviderId(event.target.value); setModelId(""); }}>
          {!provider ? <option value="">Choose a provider again</option> : null}
          {providers.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select></label> : null}
        <label className="matrix-ap-field"><span>Model</span><select value={model?.id ?? ""} disabled={disabled} onChange={(event) => setModelId(event.target.value)}>
          {!model ? <option value="">Choose a model again</option> : null}
          {models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select></label>
        <p className="matrix-ap-help">Adding saves this configuration. Send a message in Chat to verify a real response.</p>
      </> : null}
      <div className="matrix-ap-dialog-actions">
        <button type="button" className="matrix-ap-button" disabled={pending} onClick={onClose}>Cancel</button>
        {step > 0 ? <button type="button" className="matrix-ap-button" disabled={disabled} onClick={() => setStep(step - 1)}>Back</button> : null}
        {step < 2 ? <button type="button" className="matrix-ap-button matrix-ap-button-primary" disabled={disabled || !catalog?.available || (step === 1 && !ready)} onClick={next}>Next</button>
          : <button type="button" className="matrix-ap-button matrix-ap-button-primary" disabled={disabled || !ready} onClick={() => void add()}>{pending ? "Adding…" : "Add agent"}</button>}
      </div>
    </FeatureDialog>
  );
}
