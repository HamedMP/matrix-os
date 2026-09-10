import type {
  CanonicalProviderCatalog, CanonicalProviderInstanceDescriptor, CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Cpu, Settings2Icon } from "@renderer/lib/hugeicons";
import { useState } from "react";
import { CompactChatProviderChoices, canonicalProviderAvailabilityLabel, deriveCanonicalProviderChoices } from "@matrix-os/ui";
import { changeCanonicalComposerInstance, createCanonicalComposerSelection, type CanonicalComposerSelection } from "./canonical-composer-state";
import { ProviderDriverGlyph } from "./ProviderDriverGlyph";
import { openProviderSettings } from "../settings/open-provider-settings";

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
      className="z-50 w-[376px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border p-3 shadow-xl"
      style={{ maxHeight: "min(520px, calc(100vh - 32px))", borderColor: "var(--border-default)", background: "var(--bg-overlay)", color: "var(--text-primary)" }}
      data-slot="provider-model-picker" data-preferred-side={menuSide}>
      <CompactChatProviderChoices choices={deriveCanonicalProviderChoices(catalog)}
        renderIcon={(choice) => <ProviderDriverGlyph kind={choice.driverKind} size={13} />}
        selected={selection ? { instanceId: selection.instanceId, modelId: selection.model } : null}
        lockedInstanceId={instanceLocked ? selection?.instanceId : undefined}
        onSelect={(choice) => {
          if (instanceLocked && choice.instanceId !== selection?.instanceId) return;
          const base = selection ? choice.instanceId === selection.instanceId ? selection
            : changeCanonicalComposerInstance(catalog, selection, choice.instanceId)
            : createCanonicalComposerSelection(catalog, choice.instanceId);
          if (!base) return;
          onChange({ ...base, model: choice.modelId });
          setOpen(false);
        }} />
      <details className="mt-2 border-t border-[var(--border-subtle)] pt-2">
        <summary className="cursor-pointer py-2 text-sm font-medium">Manage agents</summary>
        {catalog.instances.filter((instance) => instance.availability !== "available").map((instance) => <div key={instance.id} className="py-2">
          <p className="text-xs text-[var(--text-secondary)]">{instance.displayName} — {canonicalProviderAvailabilityLabel(instance)}</p>
          {onSetupAction && instance.setupActions.map((action) => <button key={action.id} type="button"
            className="mt-1 min-h-9 rounded-lg px-2 text-sm hover:bg-[var(--bg-hover)]"
            onClick={() => { setOpen(false); onSetupAction(instance, action); }}>{action.label}</button>)}
        </div>)}
        {instanceLocked && onNewChat && <button type="button" className="min-h-9 text-sm"
          onClick={() => { setOpen(false); onNewChat(); }}>Start a new chat</button>}
      </details>
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
