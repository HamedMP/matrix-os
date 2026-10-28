import type {
  CanonicalProviderCatalog,
  CanonicalProviderDriverKind,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import { ChevronDown, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as Popover from "@radix-ui/react-popover";
import { useRef, useState, type ReactNode } from "react";

import type { CanonicalProviderChoice } from "../../canonical-provider-choice.js";
import { ChatProviderLoadingIndicator } from "../../chat-provider-loading-indicator.js";
import { CompactChatProviderChoices } from "../../compact-chat-provider-choices.js";

/**
 * Composer-toolbar model and provider picker shared by Web and Electron Desktop
 * Chat. Hosts derive the label and status; this owns the trigger, the catalog
 * popover, and the Agents & providers settings shortcut beside it.
 */
export function ChatModelPicker({
  catalog,
  choices,
  selected,
  label,
  statusLabel,
  triggerIcon,
  instanceId,
  modelId,
  lockedInstanceId,
  disabled = false,
  loading = false,
  menuSide = "top",
  menuZIndex,
  renderDriverIcon,
  renderIcon,
  onSelect,
  onSetupAction,
  onNewChat,
  onOpenSettings,
}: {
  catalog?: CanonicalProviderCatalog;
  choices: CanonicalProviderChoice[];
  selected: Pick<CanonicalProviderChoice, "instanceId" | "modelId"> | null;
  label: string;
  statusLabel?: string | null;
  triggerIcon: ReactNode;
  instanceId?: string;
  modelId?: string;
  lockedInstanceId?: string;
  disabled?: boolean;
  loading?: boolean;
  menuSide?: "top" | "bottom";
  menuZIndex?: number;
  renderDriverIcon?: (kind: CanonicalProviderDriverKind) => ReactNode;
  renderIcon?: (choice: CanonicalProviderChoice) => ReactNode;
  onSelect: (choice: CanonicalProviderChoice) => void;
  onSetupAction?: (instance: CanonicalProviderInstanceDescriptor, action: CanonicalProviderSetupAction) => void;
  onNewChat?: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Escape returns focus to the trigger; a pointer dismissal leaves focus where the owner clicked.
  const escaped = useRef(false);
  const title = statusLabel ? `${label} · ${statusLabel}` : label;
  return <><Popover.Root open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" ref={trigger} disabled={disabled} aria-label="Choose model and provider"
        data-provider-instance={instanceId ?? ""} data-model={modelId ?? ""}
        title={title}
        aria-busy={loading}
        data-slot="provider-model-trigger"
        className="relative flex h-8 min-w-0 max-w-[18rem] items-center gap-1.5 @max-[42rem]/chat-composer:w-8 @max-[42rem]/chat-composer:shrink-0 @max-[42rem]/chat-composer:justify-center @max-[42rem]/chat-composer:gap-0 @max-[42rem]/chat-composer:px-0 rounded-lg px-2 text-sm font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--accent))] disabled:opacity-50"
        style={{ color: "var(--text-secondary)" }}>
        {triggerIcon}
        <span data-slot="provider-model-label" className="truncate @max-[42rem]/chat-composer:hidden">{label}</span>
        {loading ? <ChatProviderLoadingIndicator /> : null}
        {statusLabel ? <span className="shrink-0 @max-[42rem]/chat-composer:hidden">{statusLabel}</span> : null}
        <HugeiconsIcon icon={ChevronDown} size={13} strokeWidth={1.5} aria-hidden className="shrink-0 @max-[42rem]/chat-composer:hidden" />
        {statusLabel ? <span aria-hidden data-slot="provider-model-unavailable-indicator"
          className="absolute right-1 top-1 hidden size-1.5 rounded-full @max-[42rem]/chat-composer:block"
          style={{ background: "var(--danger)" }} /> : null}
      </button>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content ref={content} tabIndex={-1} onOpenAutoFocus={(event) => { escaped.current = false; event.preventDefault(); content.current?.focus(); }}
      onEscapeKeyDown={() => { escaped.current = true; }}
      onCloseAutoFocus={(event) => { if (!escaped.current) return; event.preventDefault(); trigger.current?.focus(); }} side={menuSide} align="end" sideOffset={10} collisionPadding={16}
      className="w-[352px] max-w-[calc(100vw-32px)] overflow-x-hidden overflow-y-auto rounded-xl border shadow-xl"
      style={{ ...(menuZIndex === undefined ? {} : { zIndex: menuZIndex }), maxHeight: "min(520px, calc(100vh - 32px))", borderColor: "var(--border-default)", background: "var(--bg-overlay)", color: "var(--text-primary)" }}
      data-slot="provider-model-picker" data-preferred-side={menuSide}>
      <CompactChatProviderChoices loading={loading} catalog={catalog} choices={choices}
        renderDriverIcon={renderDriverIcon}
        renderIcon={renderIcon}
        selected={selected}
        lockedInstanceId={lockedInstanceId}
        onSetupAction={onSetupAction ? (instance, action) => {
          setOpen(false);
          onSetupAction(instance, action);
        } : undefined}
        onNewChat={onNewChat ? () => {
          setOpen(false);
          onNewChat();
        } : undefined}
        onSelect={(choice) => {
          if (lockedInstanceId && choice.instanceId !== lockedInstanceId) return;
          onSelect(choice);
          setOpen(false);
        }} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>
    <button type="button" aria-label="Open Agents & providers settings" title="Agents & providers"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--accent))]"
      style={{ color: "var(--text-secondary)" }}
      onClick={() => { setOpen(false); onOpenSettings(); }}>
      <HugeiconsIcon icon={Settings02Icon} size={15} strokeWidth={1.5} aria-hidden />
    </button>
  </>;
}
