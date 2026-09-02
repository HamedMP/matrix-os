import type {
  CanonicalChatResourceReference,
  CanonicalProviderCatalog,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import * as Popover from "@radix-ui/react-popover";
import { Box, ChevronDown, Paperclip, SlidersHorizontalIcon, SquareTerminal } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { PromptInput } from "./elements/prompt-input";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { ComposerResourceGlyph } from "./ComposerResourceGlyph";
import {
  listCanonicalSlashEntries,
  updateCanonicalComposerOption,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ComposerReferenceTokenRow } from "./ComposerReferenceTokenRow";
import {
  buildSharedChatComposerSubmission,
  type ComposerReferenceToken,
  type SharedChatComposerSubmission,
} from "./composer-reference-tokens";

export type { ComposerReferenceToken, SharedChatComposerSubmission } from "./composer-reference-tokens";

export function supportsNativeFileAttachments(
  instance: CanonicalProviderInstanceDescriptor | undefined,
): boolean {
  return Boolean(instance?.supports.attachments.some((kind) => kind === "file" || kind === "image"));
}

function selectedOptionValue(
  selection: CanonicalComposerSelection,
  optionId: string,
): string | boolean | undefined {
  return selection.options.find((option) => option.id === optionId)?.value;
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
  if (options.length <= 1) return null;
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
  menuSide,
  menuRef,
  children,
}: {
  label: string;
  menuSide: "top" | "bottom";
  menuRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={label}
      data-preferred-side={menuSide}
      className={`absolute left-0 right-0 z-30 max-h-80 overflow-y-auto rounded-xl border p-2 shadow-xl ${
        menuSide === "bottom" ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]"
      }`}
      style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
    >
      {children}
    </div>
  );
}

function ResourceRows({
  role,
  canAttach,
  resources,
  selectedIndex,
  onAttach,
  onResource,
}: {
  role: "menuitem" | "option";
  canAttach: boolean;
  resources: CanonicalChatResourceReference[];
  selectedIndex?: number;
  onAttach: () => void;
  onResource: (resource: CanonicalChatResourceReference) => void;
}) {
  const offset = canAttach ? 1 : 0;
  return (
    <>
      {canAttach ? (
        <button
          type="button"
          role={role}
          {...(role === "option" ? { "aria-selected": selectedIndex === 0 } : {})}
          className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-primary)" }}
          onClick={onAttach}
        >
          <Paperclip size={15} aria-hidden style={{ color: "var(--text-secondary)" }} />
          <span>Attach files</span>
        </button>
      ) : null}
      {resources.map((resource, index) => (
        <button
          key={`${resource.kind}:${resource.id}`}
          type="button"
          role={role}
          {...(role === "option" ? { "aria-selected": selectedIndex === index + offset } : {})}
          className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)]"
          onClick={() => onResource(resource)}
        >
          <span className="inline-flex shrink-0" style={{ color: "var(--text-tertiary)" }}>
            <ComposerResourceGlyph resource={resource} size={15} />
          </span>
          <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>{resource.label}</span>
          <span className="ml-auto shrink-0 text-[11px] capitalize" style={{ color: "var(--text-tertiary)" }}>{resource.kind.replace("_", " ")}</span>
        </button>
      ))}
    </>
  );
}

export function SharedChatComposer({
  value,
  onChange,
  referenceTokens = [],
  onReferenceTokensChange,
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
  onNewChat,
  attachments,
  leadingControls,
  footer,
  canSubmit,
  autoFocus,
  focusRequestId,
  maxLength,
  unavailableProviderLabel,
  menuSide = "top",
  layout = "default",
}: {
  value: string;
  onChange: (value: string) => void;
  referenceTokens?: ComposerReferenceToken[];
  onReferenceTokensChange?: (tokens: ComposerReferenceToken[]) => void;
  onSubmit: (submission: SharedChatComposerSubmission) => void;
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
  onNewChat?: () => void;
  attachments?: ReactNode;
  leadingControls?: ReactNode;
  footer?: ReactNode;
  canSubmit?: boolean;
  autoFocus?: boolean;
  focusRequestId?: number;
  maxLength?: number;
  unavailableProviderLabel?: string;
  menuSide?: "top" | "bottom";
  layout?: "default" | "narrow";
}) {
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);
  const suggestionMenuRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [cursor, setCursor] = useState(value.length);
  const lastEditorValueRef = useRef(value);
  const lastObservedValueRef = useRef(value);
  useEffect(() => {
    if (value === lastObservedValueRef.current) return;
    if (value !== lastEditorValueRef.current) setCursor(value.length);
    lastObservedValueRef.current = value;
  }, [value]);
  const instance = catalog.instances.find((candidate) => candidate.id === selection?.instanceId);
  const valueBeforeCursor = value.slice(0, cursor);
  const slashMatch = valueBeforeCursor.match(/(?:^|\s)(\/[a-z0-9_-]*)$/i);
  const resourceMatch = valueBeforeCursor.match(/(?:^|\s)@([^\s]*)$/);
  const slashQuery = slashMatch?.[1]?.slice(1).toLocaleLowerCase() ?? null;
  const resourceQuery = resourceMatch?.[1]?.toLocaleLowerCase() ?? null;
  const suggestionKey = slashQuery !== null
    ? `slash:${slashMatch?.index ?? 0}:${slashMatch?.[1] ?? ""}`
    : resourceQuery !== null
      ? `resource:${resourceMatch?.index ?? 0}:${resourceMatch?.[0] ?? ""}`
      : null;
  const suggestionDismissed = suggestionKey !== null && suggestionKey === dismissedSuggestionKey;
  const slashMenuOpen = slashQuery !== null && !suggestionDismissed;
  const resourceMenuOpen = resourceQuery !== null && !suggestionDismissed;
  useEffect(() => {
    if (suggestionKey === null) setDismissedSuggestionKey(null);
  }, [suggestionKey]);
  const slashEntries = useMemo(() => listCanonicalSlashEntries(instance), [instance]);
  const canAttach = Boolean(onAttach && supportsNativeFileAttachments(instance));
  const [remoteResources, setRemoteResources] = useState<CanonicalChatResourceReference[]>([]);
  useEffect(() => {
    let cancelled = false;
    const query = resourceMenuOpen ? resourceQuery : null;
    if (query === null || !resourceSearch) {
      setRemoteResources([]);
      return () => { cancelled = true; };
    }
    void resourceSearch(query).then((results) => {
      if (!cancelled) setRemoteResources(results.slice(0, 50));
    }).catch(() => {
      // Keep the client diagnostic coarse so provider, path, and network details
      // are not exposed through the renderer console.
      console.warn("Chat resource search failed");
      if (!cancelled) setRemoteResources([]);
    });
    return () => { cancelled = true; };
  }, [resourceMenuOpen, resourceQuery, resourceSearch]);
  const filteredSlashEntries = slashQuery === null ? [] : slashEntries.filter((entry) => (
    entry.invocation.slice(1).toLocaleLowerCase().includes(slashQuery)
    || entry.displayName.toLocaleLowerCase().includes(slashQuery)
  ));
  const availableResources = [...resources, ...remoteResources]
    .filter((resource, index, all) => all.findIndex((candidate) => (
      candidate.kind === resource.kind && candidate.id === resource.id
    )) === index);
  const filteredResources = resourceQuery === null ? [] : availableResources
    .filter((resource) => resource.label.toLocaleLowerCase().includes(resourceQuery));
  const suggestionCount = slashMenuOpen
    ? filteredSlashEntries.length
    : resourceMenuOpen
      ? filteredResources.length + (canAttach ? 1 : 0)
      : 0;
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  useEffect(() => setSuggestionIndex(0), [resourceQuery, slashQuery]);
  const currentSubmission = () => {
    const editorValue = editorRef.current?.readValue();
    return buildSharedChatComposerSubmission(
      editorValue?.value ?? value,
      editorValue?.tokens ?? referenceTokens,
    );
  };
  const applySuggestion = (index: number) => {
    if (slashQuery !== null) {
      const entry = filteredSlashEntries[index];
      if (entry) {
        // Dismiss synchronously. Lexical publishes the rewritten value on its
        // update listener, so without this guard an immediate second Enter can
        // still see the stale slash query and be swallowed by the old menu.
        setDismissedSuggestionKey(suggestionKey);
        editorRef.current?.insertToken({
          type: "invocation",
          label: entry.displayName,
          invocation: {
            kind: entry.kind,
            descriptorId: entry.id,
            invocation: entry.invocation,
          },
        }, slashMatch?.[1] ?? "", cursor);
      }
      return;
    }
    if (resourceQuery !== null && canAttach && index === 0) {
      setDismissedSuggestionKey(suggestionKey);
      onAttach?.();
      return;
    }
    const resource = filteredResources[index - (canAttach ? 1 : 0)];
    if (resourceQuery !== null && resource) {
      // Keep keyboard behavior deterministic after mouse or Enter selection:
      // the next Enter belongs to the composer, not the stale resource menu.
      setDismissedSuggestionKey(suggestionKey);
      editorRef.current?.insertToken({ type: "resource", resource }, `@${resourceMatch?.[1] ?? ""}`, cursor);
    }
  };
  const onSuggestionKeyDown = (
    event: Pick<globalThis.KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  ): boolean => {
    if (event.key === "Escape" && (slashMenuOpen || resourceMenuOpen)) {
      event.preventDefault();
      setDismissedSuggestionKey(suggestionKey);
      return true;
    }
    if (suggestionCount === 0) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (
          !slashMenuOpen
          && !resourceMenuOpen
          && !disabled
          && (canSubmit ?? (value.trim().length > 0 || referenceTokens.length > 0))
        ) {
          onSubmit(currentSubmission());
        }
        return true;
      }
      return false;
    }
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
  const insertResource = (resource: CanonicalChatResourceReference) => {
    setDismissedSuggestionKey(suggestionKey);
    editorRef.current?.insertToken(
      { type: "resource", resource },
      resourceQuery !== null ? `@${resourceMatch?.[1] ?? ""}` : "",
      cursor,
    );
  };
  const composerOptions = selection
    ? instance?.options.filter((option) => option.placement === "composer") ?? []
    : [];
  const hasSecondaryControls = composerOptions.some((option) => option.kind === "enum" && (option.values?.length ?? 0) > 1)
    || (instance?.supports.permissionModes.length ?? 0) > 1;
  useEffect(() => {
    if (!slashMenuOpen && !resourceMenuOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && suggestionMenuRef.current?.contains(target)) return;
      setDismissedSuggestionKey(suggestionKey);
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [resourceMenuOpen, slashMenuOpen, suggestionKey]);
  return (
    <div className="relative @container/chat-composer" data-slot="shared-chat-composer">
      {slashMenuOpen && filteredSlashEntries.length > 0 ? (
        <SuggestionMenu label="Skills and commands" menuSide={menuSide} menuRef={suggestionMenuRef}>
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text-tertiary)" }}>
            Skills &amp; commands
          </p>
          {filteredSlashEntries.map((entry, index) => (
            <button
              key={`${entry.kind}:${entry.id}`}
              type="button"
              role="option"
              aria-selected={suggestionIndex === index}
              className="grid min-h-10 w-full grid-cols-[1rem_minmax(12rem,16rem)_minmax(0,1fr)] items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)]"
              onClick={() => applySuggestion(index)}
            >
              <span data-slot="skill-command-icon" className="flex items-center justify-center" style={{ color: "var(--text-tertiary)" }}>
                {entry.kind === "skill" ? <Box size={15} aria-hidden /> : <SquareTerminal size={15} aria-hidden />}
              </span>
              <span data-slot="skill-command-name" className="truncate whitespace-nowrap font-medium" style={{ color: "var(--text-primary)" }}>{entry.invocation}</span>
              <span className="truncate text-sm" style={{ color: "var(--text-tertiary)" }}>{entry.description}</span>
            </button>
          ))}
        </SuggestionMenu>
      ) : resourceMenuOpen && (canAttach || filteredResources.length > 0) ? (
        <SuggestionMenu label="Add" menuSide={menuSide} menuRef={suggestionMenuRef}>
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text-tertiary)" }}>Add</p>
          <ResourceRows
            role="option"
            canAttach={canAttach}
            resources={filteredResources}
            selectedIndex={suggestionIndex}
            onAttach={() => onAttach?.()}
            onResource={insertResource}
          />
        </SuggestionMenu>
      ) : null}
      <PromptInput
        value={value}
        onChange={onChange}
        onSubmit={() => onSubmit(currentSubmission())}
        onAbort={onAbort}
        busy={busy}
        disabled={disabled}
        canSubmit={canSubmit ?? (!disabled && (value.trim().length > 0 || referenceTokens.length > 0))}
        autoFocus={autoFocus}
        focusRequestId={focusRequestId}
        layout={layout}
        maxLength={maxLength}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        editor={(
          <ComposerPromptEditor
            ref={editorRef}
            value={value}
            tokens={referenceTokens}
            onChange={(nextValue, nextTokens, nextCursor) => {
              lastEditorValueRef.current = nextValue;
              setCursor(nextCursor);
              onChange(nextValue);
              onReferenceTokensChange?.(nextTokens);
            }}
            onKeyDown={onSuggestionKeyDown}
            placeholder={placeholder}
            ariaLabel={ariaLabel}
            disabled={disabled}
            maxLength={maxLength}
            autoFocus={autoFocus}
            focusRequestId={focusRequestId}
          />
        )}
        attachments={attachments ? (
          <ComposerReferenceTokenRow
            tokens={[]}
            attachments={attachments}
          />
        ) : null}
        footer={footer}
        controls={(
          <>
            {canAttach ? (
              <button
                type="button"
                aria-label="Attach files"
                title="Attach files"
                disabled={disabled}
                className="flex h-8 w-8 items-center justify-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                style={{ color: "var(--text-secondary)" }}
                onClick={onAttach}
              >
                <Paperclip data-slot="attachment-paperclip-icon" size={15} aria-hidden />
              </button>
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
              disabled={disabled}
              unavailableProviderLabel={unavailableProviderLabel}
              menuSide={menuSide}
              onSetupAction={onProviderSetup}
              onNewChat={onNewChat}
              onChange={onSelectionChange}
            />
            <div data-slot="composer-secondary-controls" className="contents @max-[42rem]/chat-composer:hidden">
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
              {selection && (instance?.supports.permissionModes.length ?? 0) > 1 ? (
                <CompactSelect
                  label="Permission mode"
                  value={selection.permissionMode}
                  options={(instance?.supports.permissionModes ?? []).map((mode) => ({ value: mode, label: mode.replace(/_/g, " ") }))}
                  menuSide={menuSide}
                  onChange={(permissionMode) => onSelectionChange({ ...selection, permissionMode })}
                />
              ) : null}
            </div>
            {selection && hasSecondaryControls ? (
              <Popover.Root open={settingsMenuOpen} onOpenChange={setSettingsMenuOpen}>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    aria-label="Chat settings"
                    aria-haspopup="dialog"
                    aria-expanded={settingsMenuOpen}
                    className="hidden size-8 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] @max-[42rem]/chat-composer:flex"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    <SlidersHorizontalIcon size={15} aria-hidden />
                  </button>
                </Popover.Trigger>
                {settingsMenuOpen ? (
                  <Popover.Portal>
                    <Popover.Content
                      role="dialog"
                      aria-label="Chat settings"
                      side={menuSide}
                      align="end"
                      sideOffset={8}
                      collisionPadding={16}
                      className="z-50 flex min-w-56 flex-col gap-1 rounded-xl border p-2 shadow-xl"
                      style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
                    >
                      <span className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--text-tertiary)" }}>
                        Chat settings
                      </span>
                      {composerOptions.map((option) => option.kind === "enum" ? (
                        <CompactSelect
                          key={option.id}
                          label={option.label}
                          value={String(selectedOptionValue(selection, option.id) ?? option.values?.[0]?.value ?? "")}
                          options={(option.values ?? []).map((candidate) => ({ value: candidate.value, label: candidate.label }))}
                          menuSide={menuSide}
                          onChange={(next) => onSelectionChange(updateCanonicalComposerOption(catalog, selection, option.id, next))}
                        />
                      ) : null)}
                      {(instance?.supports.permissionModes.length ?? 0) > 1 ? (
                        <CompactSelect
                          label="Permission mode"
                          value={selection.permissionMode}
                          options={(instance?.supports.permissionModes ?? []).map((mode) => ({ value: mode, label: mode.replace(/_/g, " ") }))}
                          menuSide={menuSide}
                          onChange={(permissionMode) => onSelectionChange({ ...selection, permissionMode })}
                        />
                      ) : null}
                    </Popover.Content>
                  </Popover.Portal>
                ) : null}
              </Popover.Root>
            ) : null}
          </>
        )}
      />
    </div>
  );
}
