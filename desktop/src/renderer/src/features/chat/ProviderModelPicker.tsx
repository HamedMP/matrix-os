import type {
  CanonicalProviderCatalog,
  CanonicalProviderDriverKind,
  CanonicalProviderInstanceDescriptor,
} from "@matrix-os/contracts";
import { Bot, ChevronDown, Code2, Cpu, Pi, Search, Sparkles, SquareTerminal } from "lucide-react";
import { useRef, useState } from "react";
import {
  changeCanonicalComposerInstance,
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";

const DRIVER_LABEL: Record<CanonicalProviderDriverKind, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  codex: "Codex",
  claude_code: "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
};

function DriverIcon({ kind, size = 15 }: { kind: CanonicalProviderDriverKind; size?: number }) {
  const Icon = kind === "hermes" || kind === "claude_code"
    ? Sparkles
    : kind === "openclaw"
      ? Bot
      : kind === "codex"
        ? SquareTerminal
        : kind === "opencode"
          ? Code2
          : kind === "pi"
            ? Pi
            : Cpu;
  return <Icon size={size} aria-hidden />;
}

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
  onChange,
}: {
  catalog: CanonicalProviderCatalog;
  selection: CanonicalComposerSelection | null;
  instanceLocked: boolean;
  unavailableProviderLabel?: string;
  onChange: (selection: CanonicalComposerSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const selectedInstance = catalog.instances.find((instance) => instance.id === selection?.instanceId);
  const selectedModel = selectedInstance?.models.find((model) => model.id === selection?.model);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleInstances = catalog.instances.map((instance) => ({
    instance,
    models: instance.models.filter((model) => (
      normalizedQuery.length === 0
      || model.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || instance.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || DRIVER_LABEL[instance.driverKind].toLocaleLowerCase().includes(normalizedQuery)
    )),
  })).filter(({ models }) => models.length > 0);

  return (
    <div className="relative shrink-0">
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
        onClick={() => {
          setOpen((current) => !current);
          window.requestAnimationFrame(() => searchRef.current?.focus());
        }}
      >
        {selectedInstance ? <DriverIcon kind={selectedInstance.driverKind} /> : <Cpu size={15} />}
        <span className="truncate">{selectedModel?.displayName ?? unavailableProviderLabel ?? "Choose model"}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {open ? (
        <div
          className="absolute bottom-[calc(100%+10px)] right-0 z-40 flex w-[352px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border shadow-xl"
          style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
          data-slot="provider-model-picker"
        >
          <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r px-1.5 py-2" style={{ borderColor: "var(--border-subtle)" }}>
            {catalog.drivers.map((driver) => (
              <span
                key={driver.kind}
                title={driver.displayName}
                className="flex h-9 w-9 items-center justify-center rounded-lg"
                style={{
                  color: selectedInstance?.driverKind === driver.kind ? "var(--text-primary)" : "var(--text-tertiary)",
                  background: selectedInstance?.driverKind === driver.kind ? "var(--bg-active)" : "transparent",
                }}
              >
                <DriverIcon kind={driver.kind} size={17} />
              </span>
            ))}
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
              {visibleInstances.map(({ instance, models }) => (
                <div key={instance.id} className="py-1">
                  {models.map((model) => {
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
                          <DriverIcon kind={instance.driverKind} />
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
              ))}
              {visibleInstances.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs" style={{ color: "var(--text-tertiary)" }}>No models found.</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
