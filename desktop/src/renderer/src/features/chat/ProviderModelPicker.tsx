import type {
  CanonicalProviderCatalog,
  CanonicalProviderDriverKind,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ChevronDown, Cpu, Search } from "@renderer/lib/hugeicons";
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

const DRIVER_GROUPS: Array<{
  capabilityClass: CanonicalProviderCatalog["drivers"][number]["capabilityClass"];
  label: string;
  shortLabel: string;
}> = [
  { capabilityClass: "system_agent", label: "General agents", shortLabel: "General" },
  { capabilityClass: "coding_agent", label: "Coding agents", shortLabel: "Coding" },
];

function availabilityLabel(instance: CanonicalProviderInstanceDescriptor): string {
  if (instance.availability === "setup_required") return "Setup required";
  if (instance.availability === "auth_required") return "Authentication required";
  if (instance.availability === "unavailable") return "Unavailable";
  return "Available";
}

function modelProviderPresentation(
  instance: CanonicalProviderInstanceDescriptor,
  modelId: string,
): { label: string; glyph: CanonicalProviderDriverKind | null } {
  const separator = modelId.indexOf(":");
  if (separator < 1) return { label: instance.displayName, glyph: instance.driverKind };
  const providerId = modelId.slice(0, separator).toLocaleLowerCase();
  if (providerId === "openai" || providerId === "openai-codex") {
    return { label: "OpenAI Codex", glyph: "codex" };
  }
  if (providerId === "anthropic") return { label: "Anthropic", glyph: "claude_code" };
  if (providerId === "openrouter") return { label: "OpenRouter", glyph: null };
  return {
    label: providerId.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
    glyph: null,
  };
}

export function ProviderModelPicker({
  catalog,
  selection,
  instanceLocked,
  unavailableProviderLabel,
  menuSide = "top",
  onSetupAction,
  onNewChat,
  onChange,
}: {
  catalog: CanonicalProviderCatalog;
  selection: CanonicalComposerSelection | null;
  instanceLocked: boolean;
  unavailableProviderLabel?: string;
  menuSide?: "top" | "bottom";
  onSetupAction?: (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => void;
  onNewChat?: () => void;
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
  const visibleModels = activeInstance?.availability === "available"
    ? activeInstance.models.filter((model) => (
      normalizedQuery.length === 0
      || model.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || activeInstance.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || DRIVER_LABEL[activeInstance.driverKind].toLocaleLowerCase().includes(normalizedQuery)
    ))
    : [];

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
            className="z-50 flex w-[376px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border shadow-xl"
            style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
            data-slot="provider-model-picker"
            data-preferred-side={menuSide}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
            }}
          >
          <Tooltip.Provider delayDuration={300} skipDelayDuration={150}>
          <div className="flex w-16 shrink-0 flex-col border-r px-1.5 py-2" style={{ borderColor: "var(--border-subtle)" }}>
            {DRIVER_GROUPS.map((group, groupIndex) => {
              const drivers = catalog.drivers.filter((driver) => driver.capabilityClass === group.capabilityClass);
              if (drivers.length === 0) return null;
              return (
                <div
                  key={group.capabilityClass}
                  role="group"
                  aria-label={group.label}
                  className={groupIndex === 0 ? "flex flex-col items-center gap-1" : "mt-2 flex flex-col items-center gap-1 border-t pt-2"}
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <span
                    aria-hidden
                    className="text-[8px] font-semibold uppercase tracking-[0.06em]"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {group.shortLabel}
                  </span>
                  {drivers.map((driver) => {
                    const instance = catalog.instances.find((candidate) => candidate.driverKind === driver.kind);
                    const unavailable = !instance || instance.availability !== "available";
                    const locked = instanceLocked && instance?.id !== selection?.instanceId;
                    const setupBrowsable = unavailable
                      && Boolean(onSetupAction && instance?.setupActions.length);
                    const disabled = !instance
                      || (locked && !setupBrowsable)
                      || (unavailable && instance.setupActions.length === 0);
                    const availability = instance ? availabilityLabel(instance) : "Unavailable";
                    const tooltipLabel = unavailable
                      ? `${driver.displayName} — ${availability}`
                      : locked
                        ? `${driver.displayName} — Locked after the first Turn`
                        : `${driver.displayName} — ${availability}`;
                    return (
                      <Tooltip.Root key={driver.kind}>
                        <Tooltip.Trigger asChild>
                          <button
                            type="button"
                            aria-label={`${driver.displayName} harness, ${availability}`}
                            aria-disabled={disabled}
                            data-availability={instance?.availability ?? "unavailable"}
                            title={tooltipLabel}
                            className={`flex h-9 w-9 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${unavailable || locked ? "opacity-35" : ""} ${disabled ? "cursor-not-allowed" : ""}`}
                            style={{
                              color: disabled
                                ? "var(--text-tertiary)"
                                : activeInstance?.driverKind === driver.kind
                                  ? "var(--text-primary)"
                                  : "var(--text-tertiary)",
                              background: !disabled && activeInstance?.driverKind === driver.kind
                                ? "var(--bg-active)"
                                : "transparent",
                            }}
                            onClick={() => {
                              if (!instance || (locked && !setupBrowsable)) return;
                              setActiveInstanceId(instance.id);
                              setQuery("");
                              window.requestAnimationFrame(() => searchRef.current?.focus());
                            }}
                          >
                            <ProviderDriverGlyph kind={driver.kind} size={17} />
                          </button>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            side="left"
                            sideOffset={8}
                            className="z-[100] rounded-md px-2 py-1 text-xs"
                            style={{
                              background: "var(--forest-deep)",
                              color: "var(--forest-foreground)",
                              boxShadow: "var(--shadow-2)",
                            }}
                          >
                            {tooltipLabel}
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    );
                  })}
                </div>
              );
            })}
          </div>
          </Tooltip.Provider>
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
              <div className="flex items-center justify-between gap-2 px-2 pt-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                <span>Provider Instance is locked after the first Turn.</span>
                {onNewChat ? (
                  <button
                    type="button"
                    aria-label="Start a new chat"
                    className="shrink-0 rounded-md px-2 py-1 font-medium hover:bg-[var(--bg-hover)]"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() => {
                      setOpen(false);
                      onNewChat();
                    }}
                  >
                    New chat
                  </button>
                ) : null}
              </div>
            ) : null}
            <div ref={listboxRef} role="listbox" aria-label="Models and providers" className="mt-1 max-h-72 overflow-y-auto">
              {activeInstance ? (
                <div key={activeInstance.id} className="py-1">
                  {visibleModels.map((model) => {
                    const instance = activeInstance;
                    const provider = modelProviderPresentation(instance, model.id);
                    const instanceChangeBlocked = instanceLocked && instance.id !== selection?.instanceId;
                    const disabled = instance.availability !== "available"
                      || model.availability !== "available"
                      || instanceChangeBlocked;
                    const active = instance.id === selection?.instanceId && model.id === selection.model;
                    return (
                      <button
                        key={`${instance.id}:${model.id}`}
                        type="button"
                        data-instant-list-hover
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
                        <span data-slot="model-provider-glyph" className="flex size-4 shrink-0 items-center justify-center" style={{ color: "var(--text-secondary)" }}>
                          {provider.glyph
                            ? <ProviderDriverGlyph kind={provider.glyph} size={13} />
                            : <Cpu size={13} aria-hidden />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{model.displayName}</span>
                          <span className="block truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                            {provider.label} · {availabilityLabel(instance)}
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
            {activeInstance && activeInstance.availability !== "available" ? (
              <div className="mt-1 border-t px-2 pt-2" style={{ borderColor: "var(--border-subtle)" }}>
                <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {availabilityLabel(activeInstance)}
                </p>
                {onSetupAction ? activeInstance.setupActions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="mt-1 flex min-h-9 w-full items-center rounded-lg px-2 text-left text-sm font-medium hover:bg-[var(--bg-hover)]"
                    style={{ color: "var(--text-primary)" }}
                    onClick={() => {
                      setOpen(false);
                      setQuery("");
                      onSetupAction(activeInstance, action);
                    }}
                  >
                    {action.label}
                  </button>
                )) : null}
              </div>
            ) : null}
          </div>
          </Popover.Content>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  );
}
