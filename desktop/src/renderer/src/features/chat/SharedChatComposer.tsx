import type {
  CanonicalChatResourceReference,
  CanonicalProviderCatalog,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, FolderOpen, Paperclip } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { PromptInput } from "./elements/prompt-input";
import {
  listCanonicalSlashEntries,
  updateCanonicalComposerOption,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";
import { ProviderModelPicker } from "./ProviderModelPicker";

function replaceActiveToken(value: string, token: string, replacement: string): string {
  const index = value.lastIndexOf(token);
  if (index < 0) return value;
  return `${value.slice(0, index)}${replacement}${value.slice(index + token.length)}`;
}

function selectedOptionValue(
  selection: CanonicalComposerSelection,
  optionId: string,
): string | boolean | undefined {
  return selection.options.find((option) => option.id === optionId)?.value;
}

function FixedCapability({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled
      title={description}
      className="flex h-8 max-w-[9rem] items-center truncate rounded-lg px-2 text-sm capitalize disabled:cursor-default disabled:opacity-70"
      style={{ color: "var(--text-secondary)" }}
    >
      <span className="truncate">{value}</span>
    </button>
  );
}

function CompactSelect({
  label,
  value,
  options,
  menuSide,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  menuSide: "top" | "bottom";
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (options.length === 0) return null;
  if (options.length === 1) {
    return (
      <FixedCapability
        label={label}
        value={options[0]!.label}
        description={`${label} is fixed for this harness.`}
      />
    );
  }
  const selected = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex h-8 max-w-[9rem] items-center gap-1.5 truncate rounded-lg px-2 text-sm capitalize outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-secondary)" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <span className="truncate">{selected.label}</span>
          <ChevronDown size={12} aria-hidden className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
        </button>
      </Popover.Trigger>
      {open ? (
        <Popover.Portal>
          <Popover.Content
            role="menu"
            aria-label={`${label} options`}
            side={menuSide}
            align="end"
            sideOffset={8}
            collisionPadding={16}
            data-preferred-side={menuSide}
            className="z-50 min-w-48 rounded-xl border p-1.5 shadow-xl"
            style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
          >
            <span className="block px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--text-tertiary)" }}>
              {label}
            </span>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === selected.value}
                className="flex min-h-9 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--bg-hover)] aria-checked:bg-[var(--bg-active)]"
                style={{ color: "var(--text-primary)" }}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </Popover.Content>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  );
}

function SuggestionMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="listbox"
      aria-label={label}
      className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-30 max-h-80 overflow-y-auto rounded-xl border p-2 shadow-xl"
      style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
    >
      {children}
    </div>
  );
}

export function SharedChatComposer({
  value,
  onChange,
  onSubmit,
  onAbort,
  busy,
  disabled = false,
  placeholder = "How can I help you today?",
  ariaLabel = "Message chat",
  catalog,
  selection,
  onSelectionChange,
  instanceLocked,
  resources = [],
  resourceSearch,
  onAttach,
  onProviderSetup,
  attachments,
  leadingControls,
  footer,
  canSubmit,
  autoFocus,
  focusRequestId,
  maxLength,
  unavailableProviderLabel,
  menuSide = "top",
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onAbort?: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  catalog: CanonicalProviderCatalog;
  selection: CanonicalComposerSelection | null;
  onSelectionChange: (selection: CanonicalComposerSelection) => void;
  instanceLocked: boolean;
  resources?: CanonicalChatResourceReference[];
  resourceSearch?: (query: string) => Promise<CanonicalChatResourceReference[]>;
  onAttach?: () => void;
  onProviderSetup?: (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => void;
  attachments?: ReactNode;
  leadingControls?: ReactNode;
  footer?: ReactNode;
  canSubmit?: boolean;
  autoFocus?: boolean;
  focusRequestId?: number;
  maxLength?: number;
  unavailableProviderLabel?: string;
  menuSide?: "top" | "bottom";
}) {
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const instance = catalog.instances.find((candidate) => candidate.id === selection?.instanceId);
  const slashMatch = value.match(/(?:^|\s)(\/[a-z0-9_-]*)$/i);
  const resourceMatch = value.match(/(?:^|\s)@([^\s]*)$/);
  const slashQuery = slashMatch?.[1]?.slice(1).toLocaleLowerCase() ?? null;
  const resourceQuery = resourceMatch?.[1]?.toLocaleLowerCase() ?? null;
  const slashEntries = useMemo(() => listCanonicalSlashEntries(instance), [instance]);
  const [remoteResources, setRemoteResources] = useState<CanonicalChatResourceReference[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (resourceQuery === null || !resourceSearch) {
      setRemoteResources([]);
      return () => { cancelled = true; };
    }
    void resourceSearch(resourceQuery).then((results) => {
      if (!cancelled) setRemoteResources(results.slice(0, 50));
    }).catch(() => {
      if (!cancelled) setRemoteResources([]);
    });
    return () => { cancelled = true; };
  }, [resourceQuery, resourceSearch]);
  const filteredSlashEntries = slashQuery === null ? [] : slashEntries.filter((entry) => (
    entry.invocation.slice(1).toLocaleLowerCase().includes(slashQuery)
    || entry.displayName.toLocaleLowerCase().includes(slashQuery)
  ));
  const filteredResources = resourceQuery === null ? [] : [...resources, ...remoteResources]
    .filter((resource, index, all) => all.findIndex((candidate) => (
      candidate.kind === resource.kind && candidate.id === resource.id
    )) === index)
    .filter((resource) => resource.label.toLocaleLowerCase().includes(resourceQuery));
  const suggestionCount = slashQuery !== null
    ? filteredSlashEntries.length
    : resourceQuery !== null
      ? filteredResources.length
      : 0;
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  useEffect(() => setSuggestionIndex(0), [resourceQuery, slashQuery]);
  const applySuggestion = (index: number) => {
    if (slashQuery !== null) {
      const entry = filteredSlashEntries[index];
      if (entry) onChange(replaceActiveToken(value, slashMatch?.[1] ?? "", `${entry.invocation} `));
      return;
    }
    const resource = filteredResources[index];
    if (resourceQuery !== null && resource) {
      onChange(replaceActiveToken(value, `@${resourceMatch?.[1] ?? ""}`, `@${resource.label} `));
    }
  };
  const onSuggestionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (suggestionCount === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSuggestionIndex((current) => (current + direction + suggestionCount) % suggestionCount);
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      applySuggestion(suggestionIndex);
      return true;
    }
    return false;
  };
  const canAttach = Boolean(onAttach && (!instance || instance.supports.attachments.length));
  const composerOptions = selection
    ? instance?.options.filter((option) => option.placement === "composer") ?? []
    : [];
  const hasEffortOption = composerOptions.some((option) => option.id === "effort");

  return (
    <div className="relative" data-slot="shared-chat-composer">
      {slashQuery !== null && filteredSlashEntries.length > 0 ? (
        <SuggestionMenu label="Skills and commands">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text-tertiary)" }}>
            Skills &amp; commands
          </p>
          {filteredSlashEntries.map((entry, index) => (
            <button
              key={`${entry.kind}:${entry.id}`}
              type="button"
              role="option"
              aria-selected={suggestionIndex === index}
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)]"
              onClick={() => applySuggestion(index)}
            >
              <span className="font-medium" style={{ color: "var(--text-primary)" }}>{entry.invocation}</span>
              <span className="truncate text-sm" style={{ color: "var(--text-tertiary)" }}>{entry.description}</span>
            </button>
          ))}
        </SuggestionMenu>
      ) : resourceQuery !== null && filteredResources.length > 0 ? (
        <SuggestionMenu label="Resources">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text-tertiary)" }}>Resources</p>
          {filteredResources.map((resource, index) => (
            <button
              key={`${resource.kind}:${resource.id}`}
              type="button"
              role="option"
              aria-selected={suggestionIndex === index}
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)]"
              onClick={() => applySuggestion(index)}
            >
              <FolderOpen size={15} aria-hidden style={{ color: "var(--text-tertiary)" }} />
              <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>{resource.label}</span>
              <span className="ml-auto text-[11px] capitalize" style={{ color: "var(--text-tertiary)" }}>{resource.kind.replace("_", " ")}</span>
            </button>
          ))}
        </SuggestionMenu>
      ) : null}
      <PromptInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onAbort={onAbort}
        busy={busy}
        disabled={disabled}
        canSubmit={canSubmit ?? (!disabled && value.trim().length > 0)}
        autoFocus={autoFocus}
        focusRequestId={focusRequestId}
        maxLength={maxLength}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        onTextareaKeyDown={onSuggestionKeyDown}
        attachments={attachments}
        footer={footer}
        controls={(
          <>
            {canAttach ? (
              <Popover.Root open={attachmentMenuOpen} onOpenChange={setAttachmentMenuOpen}>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    aria-label="Add files and more"
                    className="flex h-8 w-8 items-center justify-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    <Paperclip size={15} aria-hidden />
                  </button>
                </Popover.Trigger>
                {attachmentMenuOpen ? (
                  <Popover.Portal>
                    <Popover.Content
                      role="menu"
                      aria-label="Add"
                      side={menuSide}
                      align="start"
                      sideOffset={8}
                      collisionPadding={16}
                      className="z-50 min-w-64 rounded-xl border p-1.5 shadow-xl"
                      style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
                    >
                      <span className="block px-2 py-1 text-xs" style={{ color: "var(--text-tertiary)" }}>Add</span>
                      <button
                        type="button"
                        role="menuitem"
                        className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-[var(--bg-hover)]"
                        style={{ color: "var(--text-primary)" }}
                        onClick={() => {
                          setAttachmentMenuOpen(false);
                          onAttach?.();
                        }}
                      >
                        <Paperclip size={15} aria-hidden style={{ color: "var(--text-secondary)" }} />
                        <span>Files and folders</span>
                      </button>
                    </Popover.Content>
                  </Popover.Portal>
                ) : null}
              </Popover.Root>
            ) : null}
            {leadingControls}
          </>
        )}
        trailingControls={(
          <>
            <ProviderModelPicker
              catalog={catalog}
              selection={selection}
              instanceLocked={instanceLocked}
              unavailableProviderLabel={unavailableProviderLabel}
              menuSide={menuSide}
              onSetupAction={onProviderSetup}
              onChange={onSelectionChange}
            />
            {selection && !hasEffortOption ? (
              <FixedCapability
                label="Reasoning effort"
                value="Default"
                description={`${instance?.displayName ?? "This harness"} does not expose a reasoning-effort control.`}
              />
            ) : null}
            {selection ? composerOptions.map((option) => option.kind === "enum" ? (
              <CompactSelect
                key={option.id}
                label={option.label}
                value={String(selectedOptionValue(selection, option.id) ?? option.values?.[0]?.value ?? "")}
                options={(option.values ?? []).map((candidate) => ({ value: candidate.value, label: candidate.label }))}
                menuSide={menuSide}
                onChange={(next) => onSelectionChange(updateCanonicalComposerOption(catalog, selection, option.id, next))}
              />
            ) : null) : null}
            {selection ? (
              <>
                <CompactSelect
                  label="Permission mode"
                  value={selection.permissionMode}
                  options={(instance?.supports.permissionModes ?? []).map((mode) => ({ value: mode, label: mode.replace(/_/g, " ") }))}
                  menuSide={menuSide}
                  onChange={(permissionMode) => onSelectionChange({ ...selection, permissionMode })}
                />
              </>
            ) : null}
          </>
        )}
      />
    </div>
  );
}
