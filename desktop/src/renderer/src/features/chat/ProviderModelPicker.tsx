import type {
  CanonicalProviderCatalog, CanonicalProviderInstanceDescriptor, CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import { canonicalProviderModelRouteLabel, isManagedPiBotRoute, isChatgptPlanChatRoute, isMatrixAnthropicChatRoute } from "@matrix-os/contracts";
import { Cpu } from "@renderer/lib/hugeicons";
import { ChatModelPicker, deriveCanonicalProviderChoices, canonicalProviderUnavailableSelectionLabel } from "@matrix-os/ui";
import { changeCanonicalComposerInstance, createCanonicalComposerSelection, canonicalComposerSelectionIsAvailable, type CanonicalComposerSelection } from "./canonical-composer-state";
import { ProviderDriverGlyph } from "./ProviderDriverGlyph";
import { openProviderSettings } from "../settings/open-provider-settings";
import { DESKTOP_Z_INDEX } from "../../design/layering";

export function ProviderModelPicker({ catalog, selection, instanceLocked, disabled = false, loading = false,
  unavailableProviderLabel, menuSide = "top", onSetupAction, onNewChat, onChange,
}: {
  catalog: CanonicalProviderCatalog;
  selection: CanonicalComposerSelection | null;
  instanceLocked: boolean;
  disabled?: boolean;
  loading?: boolean;
  unavailableProviderLabel?: string;
  menuSide?: "top" | "bottom";
  onSetupAction?: (instance: CanonicalProviderInstanceDescriptor, action: CanonicalProviderSetupAction) => void;
  onNewChat?: () => void;
  onChange: (selection: CanonicalComposerSelection) => void;
}) {
  const selectedInstance = catalog.instances.find((instance) => instance.id === selection?.instanceId);
  const selectedModel = selectedInstance?.models.find((model) => model.id === selection?.model);
  const unavailable = Boolean(selection && !canonicalComposerSelectionIsAvailable(catalog, selection));
  const routeLabel = canonicalProviderModelRouteLabel(selectedInstance, selectedModel?.displayName ?? selection?.model ?? unavailableProviderLabel ?? "Choose model");
  const unavailableLabel = canonicalProviderUnavailableSelectionLabel(selectedInstance, selection?.model);
  const showUnavailable = unavailable && (!loading || unavailableLabel === "Credit reserved");
  return <ChatModelPicker catalog={catalog} choices={deriveCanonicalProviderChoices(catalog)}
    selected={selection ? { instanceId: selection.instanceId, modelId: selection.model } : null}
    label={routeLabel} statusLabel={showUnavailable ? unavailableLabel : null}
    instanceId={selectedInstance?.id ?? selection?.instanceId} modelId={selectedModel?.id ?? selection?.model}
    triggerIcon={selectedInstance ? <ProviderDriverGlyph kind={isManagedPiBotRoute({ instanceId: selectedInstance.id, driverKind: selectedInstance.driverKind }) || isChatgptPlanChatRoute({ instanceId: selectedInstance.id, driverKind: selectedInstance.driverKind }) || isMatrixAnthropicChatRoute({ instanceId: selectedInstance.id, driverKind: selectedInstance.driverKind }) ? "kernel" : selectedInstance.driverKind} /> : <Cpu size={15} />}
    lockedInstanceId={instanceLocked ? selection?.instanceId : undefined}
    disabled={disabled} loading={loading} menuSide={menuSide} menuZIndex={DESKTOP_Z_INDEX.popover}
    renderDriverIcon={(kind) => <ProviderDriverGlyph kind={kind} size={17} />}
    renderIcon={(choice) => <ProviderDriverGlyph kind={isManagedPiBotRoute({ instanceId: choice.instanceId, driverKind: choice.driverKind }) || (isChatgptPlanChatRoute(choice) || isMatrixAnthropicChatRoute(choice)) ? "kernel" : choice.driverKind} size={13} />}
    onSetupAction={onSetupAction} onNewChat={onNewChat} onOpenSettings={openProviderSettings}
    onSelect={(choice) => {
      if (instanceLocked && choice.instanceId !== selection?.instanceId) return;
      const base = selection ? choice.instanceId === selection.instanceId ? selection
        : changeCanonicalComposerInstance(catalog, selection, choice.instanceId)
        : createCanonicalComposerSelection(catalog, choice.instanceId);
      if (!base) return;
      onChange({ ...base, model: choice.modelId,
        ...((isChatgptPlanChatRoute(choice) || isMatrixAnthropicChatRoute(choice)) ? { options: choice.selectedOptions,
          interactionMode: choice.interactionModes.includes(base.interactionMode) ? base.interactionMode : choice.interactionMode,
          permissionMode: choice.permissionModes.includes(base.permissionMode) ? base.permissionMode : choice.permissionMode,
        } : {}),
      });
    }} />;
}
