import {CompanyDriveContextControl} from "./CompanyDriveContextControl";
import { chatResourceKey, canAddChatMention, isChatMention, orderChatResources, chatSlashStatusMessage, filterCanonicalSlashEntries, matchChatSlashToken, ProjectSkillDraftChips, useProjectChatSlashSkills, useProjectSkillDraft, type ProjectChatSlashScope } from "@matrix-os/ui";
import type {
  CanonicalChatResourceReference,
  CanonicalProviderCatalog,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import { ChatComposerAttachButton, ChatComposerOptionControls, ChatSpeechInputButton, ChatSpeechQuotaStatus, chatPermissionModeLabel, platformSpeechControlState, type ChatComposerOptionControl } from "@matrix-os/ui";
import * as Popover from "@radix-ui/react-popover";
import { Box, SquareTerminal } from "@renderer/lib/hugeicons";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { PromptInput } from "./elements/prompt-input";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { ResourceRows } from "./ComposerResourceRows";
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
import { useConnectedDesktopSpeechInput } from "./DesktopSpeechInputControl";
import { DESKTOP_Z_INDEX } from "../../design/layering";

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

function SuggestionMenu({
  label,
  menuSide,
  anchorRef,
  children,
}: {
  label: string;
  menuSide: "top" | "bottom";
  anchorRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <Popover.Portal>
      <Popover.Content
        role="listbox"
        aria-label={label}
        data-preferred-side={menuSide}
        side={menuSide}
        align="start"
        sideOffset={8}
        collisionPadding={8}
        hideWhenDetached
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => {
          const target = event.target;
          const editor = target instanceof Element && target.closest('[data-slot="prompt-input-content"]');
          if (editor && anchorRef.current?.contains(editor)) event.preventDefault();
        }}
        onMouseDown={(event) => {
          // Keep the editor's selection while the pointer activates an option.
          if (event.button === 0 && event.target instanceof Element && event.target.closest('[role="option"]')) {
            event.preventDefault();
          }
        }}
        className="matrix-chat-composer-menu overflow-y-auto rounded-xl border p-2 shadow-xl"
        style={{
          zIndex: DESKTOP_Z_INDEX.popover,
          width: "var(--radix-popover-trigger-width)",
          maxWidth: "var(--radix-popover-content-available-width)",
          maxHeight: "min(20rem, var(--radix-popover-content-available-height))",
          borderColor: "var(--border-default)",
          background: "var(--bg-overlay)",
        }}
      >
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

export function SharedChatComposer({
  permissionModeRequest = 0,
  value,
  onChange,
  draftScopeKey,
  projectSlashScope,
  projectSkillSubmitEnabled = true,
  referenceTokens = [],
  onReferenceTokensChange,
  onAgentMention,
  onSubmit,
  onAbort,
  busy,
  submitWhileBusy = false,
  disabled = false,
  placeholder = "How can I help you today?",
  ariaLabel = "Message chat",
  catalog,
  selection,
  onSelectionChange,
  instanceLocked,
  automaticRouting = false,
  botControls,
  resources = [],
  resourceSearch,
  onAttach, attachmentsEnabled,
  onProviderSetup,
  providerCatalogLoading = false,
  onNewChat,
  attachments,
  leadingControls,
  footer,
  runActions,
  canSubmit,
  autoFocus,
  focusRequestId,
  maxLength,
  unavailableProviderLabel,
  menuSide = "top",
  layout = "default",
  speech,
}: {
  permissionModeRequest?: number;
  value: string;
  onChange: (value: string) => void;
  draftScopeKey?: string;
  projectSlashScope?: ProjectChatSlashScope;
  projectSkillSubmitEnabled?: boolean;
  referenceTokens?: ComposerReferenceToken[];
  onReferenceTokensChange?: (tokens: ComposerReferenceToken[]) => void;
  onAgentMention?: (resource: CanonicalChatResourceReference, text: string, insertLegacy: () => void) => boolean;
  onSubmit: (submission: SharedChatComposerSubmission) => void;
  onAbort?: () => void;
  busy: boolean;
  submitWhileBusy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  catalog: CanonicalProviderCatalog;
  selection: CanonicalComposerSelection | null;
  onSelectionChange: (selection: CanonicalComposerSelection) => void;
  instanceLocked: boolean;
  automaticRouting?: boolean;
  botControls?: ReactNode;
  resources?: CanonicalChatResourceReference[];
  resourceSearch?: (query: string) => Promise<CanonicalChatResourceReference[]>;
  onAttach?: () => void;
  attachmentsEnabled?: boolean;
  onProviderSetup?: (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => void;
  onNewChat?: () => void;
  providerCatalogLoading?: boolean;
  attachments?: ReactNode;
  leadingControls?: ReactNode;
  footer?: ReactNode;
  runActions?: ReactNode;
  canSubmit?: boolean;
  autoFocus?: boolean;
  focusRequestId?: number;
  maxLength?: number;
  unavailableProviderLabel?: string;
  menuSide?: "top" | "bottom";
  layout?: "default" | "narrow";
  speech?: { scopeKey: string; onDraft: (text: string) => void };
}) {
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [cursor, setCursor] = useState(value.length);
  const speechDraft = useConnectedDesktopSpeechInput(speech);
  const speechActive = speechDraft ? platformSpeechControlState(speechDraft).active : false;
  const lastEditorValueRef = useRef(value);
  const lastObservedValueRef = useRef(value);
  useEffect(() => {
    if (value === lastObservedValueRef.current) return;
    if (value !== lastEditorValueRef.current) setCursor(value.length);
    lastObservedValueRef.current = value;
  }, [value]);
  const instance = catalog.instances.find((candidate) => candidate.id === selection?.instanceId);
  const driveContextEnabled = !automaticRouting && instance?.supports.resources.includes("organization_drive") === true;
  const selectedResources = referenceTokens.flatMap(token => token.type === "resource" ? [token.resource] : []);
  const blockedDriveContext = selectedResources.some(resource => resource.kind === "organization_drive") && !driveContextEnabled;
  const valueBeforeCursor = value.slice(0, cursor);
  const slashMatch = matchChatSlashToken(value, cursor);
  const resourceMatch = valueBeforeCursor.match(/(?:^|\s)@([^\s]*)$/);
  const slashQuery = slashMatch?.query ?? null;
  const resourceQuery = resourceMatch?.[1]?.toLocaleLowerCase() ?? null;
  const skillBinding = JSON.stringify([draftScopeKey, projectSlashScope?.scope, projectSlashScope?.projectId, Boolean(projectSlashScope?.read), instance?.id]);
  const projectSkillDraft = useProjectSkillDraft(skillBinding);
  const suggestionKey = slashQuery !== null
    ? `slash:${skillBinding}:${slashMatch?.start ?? 0}:${slashMatch?.token ?? ""}`
    : resourceQuery !== null
      ? `resource:${resourceMatch?.index ?? 0}:${resourceMatch?.[0] ?? ""}`
      : null;
  const suggestionDismissed = suggestionKey !== null && suggestionKey === dismissedSuggestionKey;
  const slashMenuOpen = slashQuery !== null && !suggestionDismissed;
  const resourceMenuOpen = resourceQuery !== null && !suggestionDismissed;
  useEffect(() => {
    if (suggestionKey === null) setDismissedSuggestionKey(null);
  }, [suggestionKey]);
  const projectSkills = useProjectChatSlashSkills(projectSlashScope, slashMenuOpen);
  const slashLoading = providerCatalogLoading || projectSkills.loading;
  const slashEntries = listCanonicalSlashEntries(instance, projectSkills.catalog);
  const draftCanSubmit = canSubmit ?? (value.trim().length > 0 || referenceTokens.length > 0);
  const canSendProjectSkill = Boolean(projectSkillSubmitEnabled && projectSkillDraft.paths.length && projectSlashScope?.read);
  const canAttach = Boolean(onAttach && (attachmentsEnabled ?? supportsNativeFileAttachments(instance)));
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
  const filteredSlashEntries = slashQuery === null || slashLoading ? [] : filterCanonicalSlashEntries(slashEntries, slashQuery);
  const availableResources = orderChatResources([...resources, ...remoteResources])
    .filter((resource, index, all) => all.findIndex((candidate) => (
      chatResourceKey(candidate) === chatResourceKey(resource)
    )) === index)
    .filter((resource) => !isChatMention(resource) || canAddChatMention(referenceTokens.flatMap((token) => token.type === "resource" ? [token.resource] : []), resource));
  const filteredResources = resourceQuery === null ? [] : availableResources
    .filter((resource) => resource.label.toLocaleLowerCase().includes(resourceQuery));
  const suggestionCount = slashMenuOpen
    ? filteredSlashEntries.length
    : resourceMenuOpen
      ? filteredResources.length + (canAttach ? 1 : 0)
      : 0;
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const activeSuggestionIndex = Math.min(suggestionIndex, Math.max(0, suggestionCount - 1));
  useEffect(() => setSuggestionIndex(0), [resourceQuery, slashQuery, selection?.instanceId, draftScopeKey]);
  const currentSubmission = () => {
    const editorValue = editorRef.current?.readValue();
    const submission = buildSharedChatComposerSubmission(
      editorValue?.value ?? value,
      editorValue?.tokens ?? referenceTokens,
    );
    if (!canSendProjectSkill || !projectSlashScope) return submission;
    const prompt = projectSkillDraft.prompt(submission.text);
    return {
      ...submission, text: prompt, agentPrompt: prompt,
      projectSkill: { projectId: projectSlashScope.projectId, isCurrent: projectSkillDraft.isCurrent, onAccepted: projectSkillDraft.clear },
    };
  };
  const applySuggestion = (index: number) => {
    if (slashQuery !== null) {
      const entry = filteredSlashEntries[index];
      if (entry) {
        if (entry.kind === "project_skill") {
          if (!slashMatch || !projectSkillDraft.select(entry.path)) return;
          const suffix = value.slice(slashMatch.end).match(/^[a-z0-9_.-]*/i)?.[0] ?? "";
          setDismissedSuggestionKey(suggestionKey);
          editorRef.current?.removeTrigger(slashMatch.token + suffix, cursor + suffix.length);
          return;
        }
        // Dismiss synchronously before Lexical publishes its rewritten value.
        setDismissedSuggestionKey(suggestionKey);
        editorRef.current?.insertToken({
          type: "invocation",
          label: entry.displayName,
          invocation: {
            kind: entry.kind,
            descriptorId: entry.id,
            invocation: entry.invocation,
          },
        }, slashMatch?.token ?? "", cursor);
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
      const insert = () => editorRef.current?.insertToken({ type: "resource", resource }, `@${resourceMatch?.[1] ?? ""}`, cursor);
      const token = `@${resourceMatch?.[1] ?? ""}`;
      const text = value.slice(0, cursor - token.length) + value.slice(cursor);
      if (!onAgentMention?.(resource, text.trimEnd(), insert)) insert();
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
          && !speechActive
          && !blockedDriveContext
          && (draftCanSubmit || canSendProjectSkill)
        ) {
          if (!providerCatalogLoading) onSubmit(currentSubmission());
        }
        return true;
      }
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSuggestionIndex((activeSuggestionIndex + direction + suggestionCount) % suggestionCount);
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      applySuggestion(activeSuggestionIndex);
      return true;
    }
    return false;
  };
  const insertResource = (resource: CanonicalChatResourceReference) => {
    setDismissedSuggestionKey(suggestionKey);
    const token = resourceQuery !== null ? `@${resourceMatch?.[1] ?? ""}` : "";
    const insert = () => editorRef.current?.insertToken({ type: "resource", resource }, token, cursor);
    const text = token ? value.slice(0, cursor - token.length) + value.slice(cursor) : value;
    if (!onAgentMention?.(resource, text.trimEnd(), insert)) insert();
  };
  const composerOptions = selection
    ? instance?.options.filter((option) => option.placement === "composer") ?? []
    : [];
  const optionControls: ChatComposerOptionControl[] = selection ? [
    ...composerOptions.flatMap((option) => option.kind === "enum" ? [{
      id: option.id,
      label: option.label,
      value: String(selectedOptionValue(selection, option.id) ?? option.values?.[0]?.value ?? ""),
      options: (option.values ?? []).map((candidate) => ({ value: candidate.value, label: candidate.label })),
      onChange: (next: string) => onSelectionChange(updateCanonicalComposerOption(catalog, selection, option.id, next)),
    }] : []),
    {
      id: "permission-mode",
      label: "Permission mode",
      value: selection.permissionMode,
      options: (instance?.supports.permissionModes ?? []).map((mode) => ({ value: mode, label: chatPermissionModeLabel(mode) })),
      openRequest: permissionModeRequest,
      onChange: (permissionMode: string) => onSelectionChange({ ...selection, permissionMode }),
    },
  ] : [];
  const showResourceSuggestions = resourceMenuOpen && (canAttach || filteredResources.length > 0);
  const suggestionMenuOpen = slashMenuOpen || showResourceSuggestions;
  const suggestionSessionOpen = slashMenuOpen || resourceMenuOpen;
  const dismissSuggestion = useEffectEvent(() => setDismissedSuggestionKey(suggestionKey));
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!suggestionSessionOpen || !anchor) return;

    // A retained desktop surface can become inert before a pending search has rows.
    const dismissIfInactive = () => {
      if (anchor.closest('[inert], [hidden], [aria-hidden="true"]')) dismissSuggestion();
    };
    const observer = new MutationObserver(dismissIfInactive);
    for (let ancestor: HTMLElement | null = anchor; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ["inert", "hidden", "aria-hidden"] });
    }
    dismissIfInactive();
    return () => observer.disconnect();
  }, [suggestionSessionOpen]);
  const searchingWithoutMenu = Boolean(resourceSearch) && resourceMenuOpen && !suggestionMenuOpen;
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!searchingWithoutMenu || !anchor) return;

    // While the menu has no rows, Radix has no layer to dismiss.
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !anchor.contains(event.target)) dismissSuggestion();
    };
    const document = anchor.ownerDocument;
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside, true);
    };
  }, [searchingWithoutMenu]);
  const composer = (
    <Popover.Anchor ref={anchorRef} className="matrix-chat-composer relative @container/chat-composer" data-slot="shared-chat-composer">
      {slashMenuOpen ? (
        <SuggestionMenu label="Skills and commands" menuSide={menuSide} anchorRef={anchorRef}>
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text-tertiary)" }}>
            {projectSkills.catalog ? "Project skills & commands" : "Skills & commands"}
          </p>
          {!filteredSlashEntries.length ? <p role="status" className="px-2 py-2 text-xs" style={{color:"var(--text-secondary)"}}>{chatSlashStatusMessage({loading:slashLoading,instance,entryCount:slashEntries.length,projectSkills:projectSkills.catalog})}</p> : null}
          {filteredSlashEntries.map((entry, index) => (
            <button
              key={`${entry.kind}:${entry.id}`}
              type="button"
              role="option"
              aria-selected={activeSuggestionIndex === index}
              className="grid min-h-10 w-full grid-cols-[1rem_minmax(12rem,16rem)_minmax(0,1fr)] items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)]"
              onClick={() => applySuggestion(index)}
            >
              <span data-slot="skill-command-icon" className="flex items-center justify-center" style={{ color: "var(--text-tertiary)" }}>
                {entry.kind !== "command" ? <Box size={15} aria-hidden /> : <SquareTerminal size={15} aria-hidden />}
              </span>
              <span data-slot="skill-command-name" className="truncate whitespace-nowrap font-medium" style={{ color: "var(--text-primary)" }}>{entry.invocation}</span>
              <span className="truncate text-sm" style={{ color: "var(--text-tertiary)" }}>{entry.description}</span>
            </button>
          ))}
        </SuggestionMenu>
      ) : showResourceSuggestions ? (
        <SuggestionMenu label="Add" menuSide={menuSide} anchorRef={anchorRef}>
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text-tertiary)" }}>Add</p>
          <ResourceRows
            role="option"
            canAttach={canAttach}
            resources={filteredResources}
            selectedIndex={activeSuggestionIndex}
            onAttach={() => onAttach?.()}
            onResource={insertResource}
          />
        </SuggestionMenu>
      ) : null}
      <CompanyDriveContextControl botContext={automaticRouting} resources={selectedResources} enabled={driveContextEnabled} disabled={disabled} query={resourceMenuOpen ? resourceQuery : null} onSelect={insertResource}/>
      <PromptInput
        value={value}
        onChange={onChange}
        onSubmit={() => {
          if (!blockedDriveContext && !speechActive) {
            const submission = currentSubmission();
            if (!providerCatalogLoading) onSubmit(submission);
          }
        }}
        onAbort={onAbort}
        busy={busy}
        submitWhileBusy={submitWhileBusy}
        disabled={disabled}
        canSubmit={!providerCatalogLoading && !blockedDriveContext && !speechActive && !disabled && (draftCanSubmit || canSendProjectSkill)}
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
        attachments={attachments || projectSkillDraft.paths.length ? (
          <>
            <ProjectSkillDraftChips paths={projectSkillDraft.paths} onRemove={projectSkillDraft.remove} />
            {attachments ? <ComposerReferenceTokenRow tokens={[]} attachments={attachments} /> : null}
          </>
        ) : null}
        footer={footer}
        status={speechDraft ? <ChatSpeechQuotaStatus speech={speechDraft} /> : undefined}
        controls={(
          <>
            {canAttach ? <ChatComposerAttachButton disabled={disabled} onClick={() => onAttach?.()} /> : null}
            {leadingControls}
          </>
        )}
        trailingControls={(
          <>
            {speechDraft ? <ChatSpeechInputButton speech={speechDraft} disabled={disabled || busy} /> : null}
            {runActions}
            {automaticRouting ? botControls : <ProviderModelPicker
              catalog={catalog}
              selection={selection}
              instanceLocked={instanceLocked}
              disabled={disabled}
              loading={providerCatalogLoading}
              unavailableProviderLabel={unavailableProviderLabel}
              menuSide={menuSide}
              onSetupAction={onProviderSetup}
              onNewChat={onNewChat}
              onChange={onSelectionChange}
            />}
            <ChatComposerOptionControls controls={optionControls} openRequest={permissionModeRequest} menuSide={menuSide} />
          </>
        )}
      />
    </Popover.Anchor>
  );
  return (
    <Popover.Root open={suggestionMenuOpen} onOpenChange={(open) => {
      if (!open) setDismissedSuggestionKey(suggestionKey);
    }}>
      {composer}
    </Popover.Root>
  );
}
