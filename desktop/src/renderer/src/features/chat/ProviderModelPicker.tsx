import type {
  CanonicalProviderCatalog,
  CanonicalProviderDriverKind,
  CanonicalProviderInstanceDescriptor,
} from "@matrix-os/contracts";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Cpu, Search } from "lucide-react";
import { useRef, useState } from "react";
import {
  changeCanonicalComposerInstance,
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";
import { ProviderDriverGlyph } from "./ProviderDriverGlyph";

const DRIVER_LABEL: Record<CanonicalProviderDriverKind, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  codex: "Codex",
  claude_code: "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
};

function availabilityLabel(instance: CanonicalProviderInstanceDescriptor): string {
  if (instance.availability === "setup_required") return "Setup required";
  if (instance.availability === "auth_required") return "Authentication required";
  if (instance.availability === "unavailable") return "Unavailable";
  return "Available";
}

export function ProviderModelPicker({
  catalog,
  selection,
  instanceLocked,
  unavailableProviderLabel,
  menuSide = "top",
  onChange,
}: {
  catalog: CanonicalProviderCatalog;
  selection: CanonicalComposerSelection | null;
  instanceLocked: boolean;
  unavailableProviderLabel?: string;
  menuSide?: "top" | "bottom";
  onChange: (selection: CanonicalComposerSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeInstanceId, setActiveInstanceId] = useState(selection?.instanceId ?? "");
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const selectedInstance = catalog.instances.find((instance) => instance.id === selection?.instanceId);
  const selectedModel = selectedInstance?.models.find((model) => model.id === selection?.model);
  const activeInstance = catalog.instances.find((instance) => instance.id === activeInstanceId)
    ?? selectedInstance
    ?? catalog.instances[0];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleModels = activeInstance?.models.filter((model) => (
      normalizedQuery.length === 0
      || model.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || activeInstance.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || DRIVER_LABEL[activeInstance.driverKind].toLocaleLowerCase().includes(normalizedQuery)
    )) ?? [];

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setActiveInstanceId(selectedInstance?.id ?? catalog.instances[0]?.id ?? "");
        }
      }}
    >
      <Popover.Trigger asChild>
      <button
        type="button"
        aria-label="Choose model and provider"
        aria-expanded={open}
        data-provider-instance={selectedInstance?.id ?? ""}
        data-model={selectedModel?.id ?? ""}
        title={selectedInstance && selectedModel
          ? `${selectedModel.displayName} · ${selectedInstance.displayName}`
          : unavailableProviderLabel ?? "Choose model and provider"}
        className="flex h-8 max-w-[12rem] items-center gap-1.5 rounded-lg px-2 text-sm font-medium outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        style={{ color: "var(--text-secondary)" }}
      >
        {selectedInstance ? <ProviderDriverGlyph kind={selectedInstance.driverKind} /> : <Cpu size={15} />}
        <span className="truncate">{selectedModel?.displayName ?? unavailableProviderLabel ?? "Choose model"}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      </Popover.Trigger>
      {open ? (
        <Popover.Portal>
          <Popover.Content
            side={menuSide}
            align="end"
            sideOffset={10}
            collisionPadding={16}
            className="z-50 flex w-[352px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border shadow-xl"
            style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
            data-slot="provider-model-picker"
            data-preferred-side={menuSide}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
            }}
          >
          <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r px-1.5 py-2" style={{ borderColor: "var(--border-subtle)" }}>
            {catalog.drivers.map((driver) => {
              const instance = catalog.instances.find((candidate) => candidate.driverKind === driver.kind);
              const unavailable = !instance || instance.availability !== "available";
              const locked = instanceLocked && instance?.id !== selection?.instanceId;
              const disabled = unavailable || locked;
              const availability = instance ? availabilityLabel(instance) : "Unavailable";
              return (
              <button
                type="button"
                key={driver.kind}
                aria-label={`${driver.displayName} harness, ${availability}`}
                aria-disabled={disabled}
                disabled={disabled}
                title={`${driver.displayName} — ${availability}.${unavailable ? " Authentication or setup is required." : ""}`}
                className="flex h-9 w-9 items-center justify-center rounded-lg"
                style={{
                  color: activeInstance?.driverKind === driver.kind ? "var(--text-primary)" : "var(--text-tertiary)",
                  background: activeInstance?.driverKind === driver.kind ? "var(--bg-active)" : "transparent",
                }}
                onClick={() => {
                  if (!instance || disabled) return;
                  setActiveInstanceId(instance.id);
                  setQuery("");
                  window.requestAnimationFrame(() => searchRef.current?.focus());
                }}
              >
                <ProviderDriverGlyph kind={driver.kind} size={17} />
              </button>
              );
            })}
          </div>
          <div className="min-w-0 flex-1 p-2">
            <label className="flex h-8 items-center gap-2 border-b px-2" style={{ borderColor: "var(--border-subtle)" }}>
              <Search size={14} aria-hidden style={{ color: "var(--text-tertiary)" }} />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search models"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setOpen(false);
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    listboxRef.current
                      ?.querySelector<HTMLButtonElement>('[role="option"]:not([aria-disabled="true"])')
                      ?.focus();
                  }
                }}
                placeholder="Search models…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                style={{ color: "var(--text-primary)" }}
              />
            </label>
            {instanceLocked ? (
              <p className="px-2 pt-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                Provider Instance is locked after the first Turn.
              </p>
            ) : null}
            <div ref={listboxRef} role="listbox" aria-label="Models and providers" className="mt-1 max-h-72 overflow-y-auto">
              {activeInstance ? (
                <div key={activeInstance.id} className="py-1">
                  {visibleModels.map((model) => {
                    const instance = activeInstance;
                    const instanceChangeBlocked = instanceLocked && instance.id !== selection?.instanceId;
                    const disabled = instance.availability !== "available"
                      || model.availability !== "available"
                      || instanceChangeBlocked;
                    const active = instance.id === selection?.instanceId && model.id === selection.model;
                    return (
                      <button
                        key={`${instance.id}:${model.id}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        aria-disabled={disabled}
                        className="flex min-h-14 w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
                        onClick={() => {
                          if (disabled) return;
                          const base = selection
                            ? instance.id === selection.instanceId
                              ? selection
                              : changeCanonicalComposerInstance(catalog, selection, instance.id)
                            : createCanonicalComposerSelection(catalog, instance.id);
                          if (!base) return;
                          onChange({ ...base, model: model.id });
                          setOpen(false);
                          setQuery("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setOpen(false);
                            return;
                          }
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.click();
                            return;
                          }
                          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                          event.preventDefault();
                          const options = Array.from(listboxRef.current
                            ?.querySelectorAll<HTMLButtonElement>('[role="option"]:not([aria-disabled="true"])') ?? []);
                          const index = options.indexOf(event.currentTarget);
                          const direction = event.key === "ArrowDown" ? 1 : -1;
                          options[(index + direction + options.length) % options.length]?.focus();
                        }}
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--bg-sunken)", color: "var(--text-secondary)" }}>
                          <ProviderDriverGlyph kind={instance.driverKind} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{model.displayName}</span>
                          <span className="block truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                            {instance.displayName} · {availabilityLabel(instance)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {visibleModels.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs" style={{ color: "var(--text-tertiary)" }}>No models found.</p>
              ) : null}
            </div>
          </div>
          </Popover.Content>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  );
}
