import React, { useId, useRef, useState, type ReactNode } from "react";
import type {
  CanonicalProviderCatalog,
  CanonicalProviderDriverKind,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import type { CanonicalProviderChoice } from "./canonical-provider-choice.js";
import { canonicalProviderAvailabilityLabel } from "./canonical-provider-choice.js";
import { useLocalObservationExpiry } from "./local-observation-expiry.js";
import "./compact-chat-provider-choices.css";

function modelProviderLabel(modelId: string): string | null {
  const provider = modelId.includes(":") ? modelId.split(":")[0] : undefined;
  if (!provider) return null;
  return ({ "openai-codex": "OpenAI Codex", openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter" } as Record<string, string>)[provider] ?? provider;
}

interface CompactChatProviderChoicesProps {
  choices: CanonicalProviderChoice[];
  selected: Pick<CanonicalProviderChoice, "instanceId" | "modelId"> | null;
  lockedInstanceId?: string;
  onSelect: (choice: CanonicalProviderChoice) => void;
  renderIcon?: (choice: CanonicalProviderChoice) => ReactNode;
  catalog?: CanonicalProviderCatalog;
  renderDriverIcon?: (kind: CanonicalProviderDriverKind) => ReactNode;
  onSetupAction?: (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => void;
  onNewChat?: () => void;
}

const DRIVER_GROUPS: Array<{
  capabilityClass: CanonicalProviderCatalog["drivers"][number]["capabilityClass"];
  label: string;
  shortLabel: string;
}> = [
  { capabilityClass: "system_agent", label: "General agents", shortLabel: "General" },
  { capabilityClass: "coding_agent", label: "Coding agents", shortLabel: "Coding" },
];

function SearchGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" /><path d="m16.2 16.2 4 4" />
  </svg>;
}

function FlatChatProviderChoices({ choices, selected, lockedInstanceId, onSelect, renderIcon }: CompactChatProviderChoicesProps) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const visible = choices.filter((choice) => `${choice.modelLabel} ${choice.harnessLabel} ${choice.connectionLabel ?? ""} ${choice.modelId}`
    .toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const focusOption = (direction: number, current?: HTMLButtonElement) => {
    const options = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = current ? options.indexOf(current) : -1;
    options[(index + direction + options.length) % options.length]?.focus();
  };
  return <div className="matrix-chat-model-choices min-w-0">
    <input type="search" aria-label="Search models and connections" aria-controls={listId}
      autoFocus maxLength={160} placeholder="Search models or Matrix AI…" value={query}
      onChange={(event) => setQuery(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); focusOption(1); }
      }}
      className="matrix-chat-model-search mb-2 min-h-10 w-full rounded-lg border bg-transparent px-3 text-sm" />
    {lockedInstanceId && <p className="matrix-chat-model-secondary mb-2 text-xs">This chat keeps its agent. Start a new chat to switch.</p>}
    <div id={listId} ref={list} role="listbox" aria-label="Models and connections"
      style={{ maxHeight: 240, overflowY: "auto" }}>
      {visible.map((choice) => {
        const active = choice.instanceId === selected?.instanceId && choice.modelId === selected.modelId;
        const locked = lockedInstanceId !== undefined && choice.instanceId !== lockedInstanceId;
        return <button key={`${choice.instanceId}:${choice.modelId}`} type="button" role="option"
          aria-label={`${choice.modelLabel} via ${choice.harnessLabel}${choice.connectionLabel && choice.connectionLabel !== choice.harnessLabel ? ` · ${choice.connectionLabel}` : ""}`} aria-selected={active} disabled={locked}
          className="matrix-chat-model-option flex min-h-12 w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm disabled:opacity-40"
          onClick={() => onSelect(choice)} onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.click(); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); focusOption(event.key === "ArrowDown" ? 1 : -1, event.currentTarget);
            }
          }}>
          {renderIcon && <span data-slot="model-provider-glyph" className="flex size-4 shrink-0 items-center justify-center">{renderIcon(choice)}</span>}
          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{choice.modelLabel}</span>
            <span className="matrix-chat-model-secondary block truncate text-xs">{choice.harnessLabel}{choice.connectionLabel && choice.connectionLabel !== choice.harnessLabel ? ` · ${choice.connectionLabel}` : ""}{modelProviderLabel(choice.modelId) ? ` · ${modelProviderLabel(choice.modelId)}` : ""}</span></span>
          {active && <span aria-hidden="true">✓</span>}
        </button>;
      })}
      {visible.length === 0 && <p role="status" className="matrix-chat-model-secondary px-3 py-4 text-sm">{choices.length ? "No matching models." : "No ready connections. Open Manage agents to connect."}</p>}
    </div>
  </div>;
}

function TwoPaneChatProviderChoices({
  catalog, choices, selected, lockedInstanceId, onSelect, renderIcon, renderDriverIcon, onSetupAction, onNewChat,
}: CompactChatProviderChoicesProps & { catalog: CanonicalProviderCatalog }) {
  const [query, setQuery] = useState("");
  const [activeInstanceId, setActiveInstanceId] = useState(selected?.instanceId ?? catalog.instances[0]?.id ?? "");
  const listId = useId();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const activeInstance = catalog.instances.find((instance) => instance.id === activeInstanceId)
    ?? catalog.instances.find((instance) => instance.id === selected?.instanceId)
    ?? catalog.instances[0];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const activeChoices = choices.filter((choice) => choice.instanceId === activeInstance?.id
    && (normalizedQuery.length === 0
      || `${choice.modelLabel} ${choice.harnessLabel} ${choice.connectionLabel ?? ""} ${choice.modelId}`
        .toLocaleLowerCase().includes(normalizedQuery)));
  const focusOption = (direction: number, current?: HTMLButtonElement) => {
    const options = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = current ? options.indexOf(current) : -1;
    options[(index + direction + options.length) % options.length]?.focus();
  };

  return <div className="matrix-chat-model-choices matrix-chat-model-two-pane">
    <div className="matrix-chat-provider-rail">
      {DRIVER_GROUPS.map((group) => {
        const driverKinds = catalog.drivers
          .filter((driver) => driver.capabilityClass === group.capabilityClass)
          .map((driver) => driver.kind);
        const instances = driverKinds.flatMap((kind) => catalog.instances.filter((instance) => instance.driverKind === kind));
        if (instances.length === 0) return null;
        return <div key={group.capabilityClass} role="group" aria-label={group.label}
          className="matrix-chat-provider-group">
          <span aria-hidden="true" className="matrix-chat-provider-group-label">{group.shortLabel}</span>
          {instances.map((instance) => {
            const unavailable = instance.availability !== "available";
            const locked = lockedInstanceId !== undefined && instance.id !== lockedInstanceId;
            const setupBrowsable = unavailable && Boolean(onSetupAction && instance.setupActions.length);
            const disabledReasonBrowsable = instance.unavailabilityReason === "disabled_in_settings";
            const disabled = (locked || unavailable) && !setupBrowsable && !disabledReasonBrowsable;
            const active = activeInstance?.id === instance.id;
            const availability = canonicalProviderAvailabilityLabel(instance);
            return <button key={instance.id} type="button"
              aria-label={`${instance.displayName} agent, ${availability}`}
              aria-pressed={active} disabled={disabled}
              title={`${instance.displayName} — ${locked && !unavailable ? "Locked after the first turn" : availability}`}
              data-availability={instance.availability}
              className="matrix-chat-provider-button"
              onClick={() => {
                setActiveInstanceId(instance.id);
                setQuery("");
                window.requestAnimationFrame(() => search.current?.focus());
              }}>
              {renderDriverIcon?.(instance.driverKind) ?? <span aria-hidden="true">●</span>}
            </button>;
          })}
        </div>;
      })}
    </div>
    <div className="matrix-chat-model-pane">
      <label className="matrix-chat-model-search-row">
        <SearchGlyph />
        <input ref={search} type="search" aria-label="Search models and connections" aria-controls={listId}
          autoFocus maxLength={160} placeholder="Search models…" value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); focusOption(1); }
          }}
          className="matrix-chat-model-search min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      {lockedInstanceId && <div className="matrix-chat-model-lock-note">
        <span>This chat keeps its agent. Start a new chat to switch.</span>
        {onNewChat ? <button type="button" onClick={onNewChat}>New chat</button> : null}
      </div>}
      <div id={listId} ref={list} role="listbox" aria-label="Models and connections" className="matrix-chat-model-list">
        {activeChoices.map((choice) => {
          const active = choice.instanceId === selected?.instanceId && choice.modelId === selected.modelId;
          const locked = lockedInstanceId !== undefined && choice.instanceId !== lockedInstanceId;
          const choiceInstance = catalog.instances.find((instance) => instance.id === choice.instanceId);
          return <button key={`${choice.instanceId}:${choice.modelId}`} type="button" role="option"
            aria-label={`${choice.modelLabel} via ${choice.harnessLabel}${choice.connectionLabel && choice.connectionLabel !== choice.harnessLabel ? ` · ${choice.connectionLabel}` : ""}`}
            aria-selected={active} disabled={locked}
            className="matrix-chat-model-option flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm disabled:opacity-40"
            onClick={() => onSelect(choice)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.click(); }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault(); focusOption(event.key === "ArrowDown" ? 1 : -1, event.currentTarget);
              }
            }}>
            <span data-slot="model-provider-glyph" className="flex size-4 shrink-0 items-center justify-center">
              {renderIcon?.(choice) ?? renderDriverIcon?.(choice.driverKind) ?? <span aria-hidden="true">●</span>}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{choice.modelLabel}</span>
              <span className="matrix-chat-model-secondary block truncate text-xs">
                {modelProviderLabel(choice.modelId) ? `${modelProviderLabel(choice.modelId)} · ` : ""}{choice.harnessLabel}{choice.connectionLabel && choice.connectionLabel !== choice.harnessLabel ? ` · ${choice.connectionLabel}` : ""} · {choiceInstance ? canonicalProviderAvailabilityLabel(choiceInstance) : "Access not verified"}
              </span>
            </span>
            {active && <span aria-hidden="true">✓</span>}
          </button>;
        })}
        {activeChoices.length === 0 && activeInstance?.availability === "available"
          ? <p role="status" className="matrix-chat-model-secondary px-2 py-6 text-center text-xs">{normalizedQuery ? "No matching models." : "No models found."}</p>
          : null}
        {!activeInstance ? <p role="status" className="matrix-chat-model-secondary px-2 py-6 text-center text-xs">
          No ready connections. Open Agents &amp; providers settings to connect.
        </p> : null}
      </div>
      {activeInstance && activeInstance.availability !== "available" ? <div className="matrix-chat-provider-setup">
        <p>{canonicalProviderAvailabilityLabel(activeInstance)}</p>
        {onSetupAction ? activeInstance.setupActions.map((action) => <button key={action.id} type="button"
          onClick={() => onSetupAction(activeInstance, action)}>{action.label}</button>) : null}
      </div> : null}
    </div>
  </div>;
}

/** Shared presentation: readiness, accounts and funded routes come from the canonical catalog. */
export function CompactChatProviderChoices(props: CompactChatProviderChoicesProps) {
  useLocalObservationExpiry(props.catalog?.instances.map((instance) => instance.localObservation?.staleAfter) ?? []);
  return props.catalog
    ? <TwoPaneChatProviderChoices {...props} catalog={props.catalog} />
    : <FlatChatProviderChoices {...props} />;
}
