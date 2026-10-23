import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { ChatProviderSetupPanel } from "../../../shell/src/components/chat-app-provider-setup";
import { deriveCanonicalProviderChoices } from "../../../packages/ui/src/canonical-provider-choice";
import type { CanonicalComposerSelection } from "../../../desktop/src/renderer/src/features/chat/canonical-composer-state";
import { ProviderModelPicker } from "../../../desktop/src/renderer/src/features/chat/ProviderModelPicker";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat";
import "../../../packages/ui/src/compact-chat-provider-choices.css";

const base = createCanonicalProviderCatalogFixture();
const instance = base.instances[0]!;
const catalog: CanonicalProviderCatalog = {
  ...base,
  drivers: [
    { kind: "matrix_pi", displayName: "Matrix AI", adapterVersion: "1", capabilityClass: "system_agent" },
    { kind: "hermes", displayName: "Hermes", adapterVersion: "1", capabilityClass: "system_agent" },
    ...base.drivers,
  ],
  instances: [
    { ...instance, id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix AI", workspaceRequirement: "none",
      defaultSelection: undefined, setupActions: [{ id: "settings", kind: "open_settings", label: "Agents & providers" }],
      models: Array.from({ length: 9 }, (_, i) => ({ ...instance.models[0]!, id: `matrix-${i}`, displayName: `Matrix model ${i + 1}` })) },
    { ...instance, id: "hermes_default", driverKind: "hermes", displayName: "Hermes", defaultSelection: undefined,
      models: Array.from({ length: 20 }, (_, i) => ({ ...instance.models[0]!, id: `hermes-${i}`, displayName: `Hermes model ${i + 1}` })) },
    instance,
  ],
};

function Fixture() {
  const [state, setState] = useState("ready");
  const [selection, setSelection] = useState<CanonicalComposerSelection>({ instanceId: instance.id, model: instance.models[0]!.id,
    options: [], interactionMode: "default", permissionMode: "supervised" });
  const [actions, setActions] = useState(0);
  const [open, setOpen] = useState(false);
  const web = document.documentElement.dataset.surface === "web";
  const current: CanonicalProviderCatalog = { ...catalog, instances: catalog.instances.flatMap(item => {
    if (state === "missing" && item.id === "matrix_pi_default") return [];
    if ((state === "blocked" || state === "failed") && item.id === "matrix_pi_default") return [{ ...item, availability: "unavailable", connectionState: state === "blocked" ? "credit_required" : "unavailable",
      models: item.models.map(model => ({ ...model, availability: "unavailable" })) }];
    return [item];
  }) };
  (window as unknown as { setGatewayFixtureState: typeof setState }).setGatewayFixtureState = setState;
  return <main>
    <h1>Gateway entry regression</h1><p>Synthetic catalog; no owner authentication or model calls.</p>
    <output id="gateway-state">{state}</output><output id="gateway-selection">{selection.instanceId}:{selection.model}</output>
    <output id="gateway-actions">{actions}</output>
    <div style={{ position: "fixed", bottom: 30, right: 40, ...(web ? { width: 380, height: 600 } : {}) }}>
      {web ? <><button type="button" data-chat-model-trigger aria-label="Choose model and connection" onClick={() => setOpen(value => !value)}>Choose model</button>
        {open ? <ChatProviderSetupPanel catalog={current} choices={deriveCanonicalProviderChoices(current)} selected={null}
          displaySelection={{ instanceId: selection.instanceId, modelId: selection.model }} loading={state === "loading"}
          onSelect={choice => { setSelection({ ...selection, instanceId: choice.instanceId, model: choice.modelId }); setActions(value => value + 1); }}
          onInteractionModeChange={() => {}} onPermissionModeChange={() => {}} onOptionChange={() => {}}
          onSetupAction={() => setActions(value => value + 1)} showChannels={false} channels={new Set()} onToggleChannel={() => {}} onDismiss={() => setOpen(false)} /> : null}</> : <ProviderModelPicker catalog={current} selection={selection} instanceLocked={false} loading={state === "loading"}
        onSetupAction={() => setActions(value => value + 1)} onChange={next => { setSelection(next); setActions(value => value + 1); }} />}
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
