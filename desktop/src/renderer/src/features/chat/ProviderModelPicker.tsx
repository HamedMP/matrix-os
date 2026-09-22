import type {
  CanonicalProviderCatalog, CanonicalProviderInstanceDescriptor, CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Cpu, Settings2Icon } from "@renderer/lib/hugeicons";
import { useState } from "react";
import { CompactChatProviderChoices, deriveCanonicalProviderChoices } from "@matrix-os/ui";
import { changeCanonicalComposerInstance, createCanonicalComposerSelection, type CanonicalComposerSelection } from "./canonical-composer-state";
import { ProviderDriverGlyph } from "./ProviderDriverGlyph";
import { openProviderSettings } from "../settings/open-provider-settings";
import { DESKTOP_Z_INDEX } from "../../design/layering";

export function ProviderModelPicker({ catalog, selection, instanceLocked, disabled = false,
  unavailableProviderLabel, menuSide = "top", onSetupAction, onNewChat, onChange,
}: {
  catalog: CanonicalProviderCatalog;
  selection: CanonicalComposerSelection | null;
  instanceLocked: boolean;
  disabled?: boolean;
  unavailableProviderLabel?: string;
  menuSide?: "top" | "bottom";
  onSetupAction?: (instance: CanonicalProviderInstanceDescriptor, action: CanonicalProviderSetupAction) => void;
  onNewChat?: () => void;
  onChange: (selection: CanonicalComposerSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedInstance = catalog.instances.find((instance) => instance.id === selection?.instanceId);
  const selectedModel = selectedInstance?.models.find((model) => model.id === selection?.model);
  return <><Popover.Root open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" disabled={disabled} aria-label="Choose model and provider"
        data-provider-instance={selectedInstance?.id ?? ""} data-model={selectedModel?.id ?? ""}
        title={selectedInstance && selectedModel ? `${selectedModel.displayName} · ${selectedInstance.displayName}` : unavailableProviderLabel}
        className="flex h-8 max-w-[18rem] items-center gap-1.5 rounded-lg px-2 text-sm font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
        style={{ color: "var(--text-secondary)" }}>
        {selectedInstance ? <ProviderDriverGlyph kind={selectedInstance.driverKind} /> : <Cpu size={15} />}
        <span className="truncate">{selectedModel?.displayName ?? unavailableProviderLabel ?? "Choose model"}{selectedInstance ? ` · ${selectedInstance.displayName}` : ""}{selectedInstance?.connectionLabel && selectedInstance.connectionLabel !== selectedInstance.displayName ? ` · ${selectedInstance.connectionLabel}` : ""}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content side={menuSide} align="end" sideOffset={10} collisionPadding={16}
      className="w-[376px] max-w-[calc(100vw-32px)] overflow-x-hidden overflow-y-auto rounded-xl border shadow-xl"
      style={{ zIndex: DESKTOP_Z_INDEX.popover, maxHeight: "min(520px, calc(100vh - 32px))", borderColor: "var(--border-default)", background: "var(--bg-overlay)", color: "var(--text-primary)" }}
      data-slot="provider-model-picker" data-preferred-side={menuSide}>
      <CompactChatProviderChoices catalog={catalog} choices={deriveCanonicalProviderChoices(catalog)}
        renderDriverIcon={(kind) => <ProviderDriverGlyph kind={kind} size={17} />}
        renderIcon={(choice) => <ProviderDriverGlyph kind={choice.driverKind} size={13} />}
        selected={selection ? { instanceId: selection.instanceId, modelId: selection.model } : null}
        lockedInstanceId={instanceLocked ? selection?.instanceId : undefined}
        onSetupAction={onSetupAction ? (instance, action) => {
          setOpen(false);
          onSetupAction(instance, action);
        } : undefined}
        onNewChat={onNewChat ? () => {
          setOpen(false);
          onNewChat();
        } : undefined}
        onSelect={(choice) => {
          if (instanceLocked && choice.instanceId !== selection?.instanceId) return;
          const base = selection ? choice.instanceId === selection.instanceId ? selection
            : changeCanonicalComposerInstance(catalog, selection, choice.instanceId)
            : createCanonicalComposerSelection(catalog, choice.instanceId);
          if (!base) return;
          onChange({ ...base, model: choice.modelId });
          setOpen(false);
        }} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>
    <button type="button" aria-label="Open Agents & providers settings" title="Agents & providers"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ color: "var(--text-secondary)" }}
      onClick={() => { setOpen(false); openProviderSettings(); }}>
      <Settings2Icon size={15} aria-hidden />
    </button>
  </>;
}
