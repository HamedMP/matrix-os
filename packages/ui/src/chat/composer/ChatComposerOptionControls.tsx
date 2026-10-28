import { Plus, SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";

import { ChatComposerSelect, type ChatComposerSelectOption } from "./ChatComposerSelect.js";

export interface ChatComposerOptionControl {
  id: string;
  label: string;
  value: string;
  options: ChatComposerSelectOption[];
  openRequest?: number;
  onChange: (value: string) => void;
}

/**
 * Effort/access pickers in the composer toolbar. Under a 42rem composer they
 * collapse into one "Chat settings" popover so the toolbar stays on one row.
 */
export function ChatComposerOptionControls({
  controls,
  openRequest = 0,
  menuSide,
  menuZIndex,
}: {
  controls: ChatComposerOptionControl[];
  openRequest?: number;
  menuSide: "top" | "bottom";
  menuZIndex?: number;
}) {
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (openRequest > 0 && settingsTrigger.current?.getClientRects().length) setSettingsMenuOpen(true); }, [openRequest]);
  const visible = controls.filter((control) => control.options.length > 1);
  const select = (control: ChatComposerOptionControl) => (
    <ChatComposerSelect
      key={control.id}
      openRequest={control.openRequest}
      label={control.label}
      value={control.value}
      options={control.options}
      menuSide={menuSide}
      menuZIndex={menuZIndex}
      onChange={control.onChange}
    />
  );
  return (
    <>
      <div data-slot="composer-secondary-controls" className="contents @max-[42rem]/chat-composer:hidden">
        {controls.map(select)}
      </div>
      {visible.length ? (
        <Popover.Root open={settingsMenuOpen} onOpenChange={setSettingsMenuOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              ref={settingsTrigger}
              aria-label="Chat settings"
              aria-haspopup="dialog"
              aria-expanded={settingsMenuOpen}
              className="hidden size-8 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--accent))] @max-[42rem]/chat-composer:flex"
              style={{ color: "var(--text-secondary)" }}
            >
              <HugeiconsIcon icon={SlidersHorizontalIcon} size={15} strokeWidth={1.5} aria-hidden />
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
                className="matrix-chat-composer-menu z-50 flex min-w-56 flex-col gap-1 rounded-xl border p-2 shadow-xl"
                style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)", ...(menuZIndex === undefined ? {} : { zIndex: menuZIndex }) }}
              >
                <span className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--text-tertiary)" }}>
                  Chat settings
                </span>
                {controls.map(select)}
              </Popover.Content>
            </Popover.Portal>
          ) : null}
        </Popover.Root>
      ) : null}
    </>
  );
}

/** The composer's attach (+) control; hosts render it only when attachments can be sent. */
export function ChatComposerAttachButton({ disabled = false, title = "Attach files", onClick }: {
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Attach files"
      title={title}
      disabled={disabled}
      className="flex h-7 w-8 items-center justify-center rounded-[8px] border outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--accent))] disabled:opacity-40"
      style={{ color: "var(--text-secondary)", borderColor: "var(--border-subtle)" }}
      onClick={onClick}
    >
      <HugeiconsIcon data-slot="attachment-plus-icon" icon={Plus} size={15} strokeWidth={1.5} aria-hidden />
    </button>
  );
}
