import React, { useId, useRef, useState, type ReactNode } from "react";
import type { CanonicalProviderChoice } from "./canonical-provider-choice.js";
import "./compact-chat-provider-choices.css";

function modelProviderLabel(modelId: string): string | null {
  const provider = modelId.includes(":") ? modelId.split(":")[0] : undefined;
  if (!provider) return null;
  return ({ "openai-codex": "OpenAI Codex", openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter" } as Record<string, string>)[provider] ?? provider;
}

/** Presentation only: readiness, accounts and funded routes come from the canonical catalog. */
export function CompactChatProviderChoices({ choices, selected, lockedInstanceId, onSelect, renderIcon }: {
  choices: CanonicalProviderChoice[];
  selected: Pick<CanonicalProviderChoice, "instanceId" | "modelId"> | null;
  lockedInstanceId?: string;
  onSelect: (choice: CanonicalProviderChoice) => void;
  renderIcon?: (choice: CanonicalProviderChoice) => ReactNode;
}) {
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
