"use client";
import type { CanonicalProviderInstanceDescriptor, CanonicalProviderSetupAction } from "@matrix-os/contracts";
import { canonicalProviderModelRouteLabel, isChatgptPlanChatRoute, isManagedPiBotRoute, isMatrixAnthropicChatRoute } from "@matrix-os/contracts";
import { ChatComposerOptionControls, ChatModelPicker, chatPermissionModeLabel, type ChatComposerOptionControl } from "@matrix-os/ui";
import { Cpu } from "@/lib/hugeicons";
import { openProviderSettings } from "@/lib/canonical-provider-setup";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { WebProviderDriverIcon, type useChatProviderState } from "../chat-app-provider-setup";

type ChatProviderState = ReturnType<typeof useChatProviderState>;

function glyphKind(route: { instanceId: string; driverKind: CanonicalProviderInstanceDescriptor["driverKind"] }) {
  return isManagedPiBotRoute(route) || isChatgptPlanChatRoute(route) || isMatrixAnthropicChatRoute(route) ? "kernel" : route.driverKind;
}

/** Model, effort and access pickers for the Web Chat composer toolbar, matching Electron Desktop. */
export function WebChatComposerControls({ providerState, lockedInstanceId, permissionModeRequest = 0, onSetupAction }: {
  providerState: ChatProviderState;
  lockedInstanceId?: string;
  /** Bumping this opens the Permission mode picker (or the narrow Chat settings menu). */
  permissionModeRequest?: number;
  onSetupAction: (instance: CanonicalProviderInstanceDescriptor, action: CanonicalProviderSetupAction) => void;
}) {
  const { selected, activeInstance } = providerState;
  const label = canonicalProviderModelRouteLabel(activeInstance ?? undefined, providerState.displayModelLabel ?? "Choose model");
  const statusLabel = providerState.loading && providerState.selectionStatus !== "Credit reserved" ? null : providerState.selectionStatus;
  const controls: ChatComposerOptionControl[] = selected ? [
    ...selected.options.flatMap((option) => option.kind === "enum" && option.placement === "composer" ? [{
      id: option.id,
      label: option.label,
      value: String(selected.selectedOptions.find((value) => value.id === option.id)?.value ?? option.values?.[0]?.value ?? ""),
      options: (option.values ?? []).map((value) => ({ value: value.value, label: value.label })),
      onChange: (value: string) => providerState.selectOption(option.id, value),
    }] : []),
    {
      id: "permission-mode",
      label: "Permission mode",
      value: selected.permissionMode,
      options: selected.permissionModes.map((mode) => ({ value: mode, label: chatPermissionModeLabel(mode) })),
      openRequest: permissionModeRequest,
      onChange: providerState.selectPermissionMode,
    },
  ] : [];
  return (
    <>
      <ChatModelPicker
        catalog={providerState.catalog ?? undefined}
        choices={providerState.choices}
        selected={providerState.displaySelection ?? null}
        label={label}
        statusLabel={statusLabel}
        instanceId={providerState.displaySelection?.instanceId}
        modelId={providerState.displaySelection?.modelId}
        triggerIcon={activeInstance
          ? <WebProviderDriverIcon kind={glyphKind({ instanceId: activeInstance.id, driverKind: activeInstance.driverKind })} />
          : <Cpu size={15} aria-hidden="true" />}
        lockedInstanceId={lockedInstanceId}
        loading={providerState.loading}
        menuZIndex={SHELL_Z_INDEX.popover}
        renderDriverIcon={(kind) => <WebProviderDriverIcon kind={kind} />}
        renderIcon={(choice) => <WebProviderDriverIcon kind={glyphKind(choice)} small />}
        onSelect={providerState.select}
        onSetupAction={onSetupAction}
        onOpenSettings={openProviderSettings}
      />
      <ChatComposerOptionControls controls={controls} openRequest={permissionModeRequest} menuSide="top" menuZIndex={SHELL_Z_INDEX.popover} />
    </>
  );
}
