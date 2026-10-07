"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Fragment, useEffect, useRef, useState, type ReactElement } from "react";

export type ChatContextMenuAction = { label: string; disabled?: boolean; danger?: boolean; onSelect?: () => void; children?: ChatContextMenuAction[] };

const menuItemClass = "cursor-default rounded px-2.5 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-40";
function MenuActions({ items, zIndex, Menu = ContextMenu }: { items: ChatContextMenuAction[]; zIndex: number; Menu?: typeof ContextMenu | typeof DropdownMenu }) {
  return items.map(item => item.children ? <Menu.Sub key={item.label}>
    <Menu.SubTrigger disabled={item.disabled} className={`${menuItemClass} flex items-center gap-3`}>
      <span>{item.label}</span><span className="ml-auto" aria-hidden>›</span>
    </Menu.SubTrigger>
    <Menu.Portal><Menu.SubContent className="min-w-[180px] rounded-xl border p-1 shadow-lg" style={{zIndex,background:"var(--bg-overlay, var(--popover))",color:"var(--text-primary, var(--popover-foreground))",borderColor:"var(--border-default, var(--border))"}}>
      <MenuActions items={item.children} zIndex={zIndex} Menu={Menu} />
    </Menu.SubContent></Menu.Portal>
  </Menu.Sub> : <Fragment key={item.label}>{item.danger ? <Menu.Separator className="my-1 h-px" style={{background:"var(--border-default, var(--border))"}}/> : null}<Menu.Item disabled={item.disabled} onSelect={item.onSelect} className={menuItemClass} style={item.danger ? {color:"var(--danger, var(--destructive))"} : undefined}>{item.label}</Menu.Item></Fragment>);
}

export function ChatContextMenu({ chatId, children, primaryAction, items = [], zIndex = 100, dropdownTrigger, onDropdownOpenChange, onContextMenuOpenChange }: {
  dropdownTrigger?: ReactElement; onDropdownOpenChange?: (open: boolean) => void;
  onContextMenuOpenChange?: (open: boolean) => void;
  chatId?: string | null;
  children: ReactElement;
  zIndex?: number;
  primaryAction?: { label: string; disabled?: boolean; onSelect: () => void };
  items?: ChatContextMenuAction[];
}) {
  const [feedback, setFeedback] = useState<"pending" | "copied" | "failed" | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [copyTarget, setCopyTarget] = useState<"chat ID" | "selected text">("chat ID");
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setFeedback(null);
    return () => { generation.current += 1; };
  }, [chatId]);
  const copy = (value: string, target: "chat ID" | "selected text", event: Event) => {
    event.preventDefault();
    const attempt = ++generation.current;
    setCopyTarget(target);
    setFeedback("pending");
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        if (generation.current === attempt) setFeedback("copied");
      } catch (error: unknown) {
        // Clipboard permission failures are expected; never display platform error text.
        console.warn("[chat] Clipboard copy failed", error instanceof Error ? error.name : "UnknownError");
        if (generation.current === attempt) setFeedback("failed");
      }
    })();
  };
  if (!chatId) return children;
  const opened = (open: boolean) => {
    generation.current += 1;
    setFeedback(null);
    setSelectedText(open ? window.getSelection()?.toString() ?? "" : "");
  };
  const contents = (Menu: typeof ContextMenu | typeof DropdownMenu) => (
      <Menu.Portal>
        <Menu.Content className="min-w-[180px] rounded-xl border p-1 shadow-lg" style={{
          zIndex, background: "var(--bg-overlay, var(--popover))",
          color: "var(--text-primary, var(--popover-foreground))",
          borderColor: "var(--border-default, var(--border))",
        }}>
          {primaryAction ? <Menu.Item disabled={primaryAction.disabled} onSelect={primaryAction.onSelect}
            className="cursor-default rounded px-2.5 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-40">{primaryAction.label}</Menu.Item> : null}
          {selectedText && <Menu.Item disabled={feedback === "pending"}
            className="cursor-default rounded px-2.5 py-1.5 text-sm outline-none focus:bg-accent"
            onSelect={(event) => copy(selectedText, "selected text", event)}>Copy selected text</Menu.Item>}
          <Menu.Item disabled={feedback === "pending"} className="cursor-default rounded px-2.5 py-1.5 text-sm outline-none focus:bg-accent"
            onSelect={(event) => copy(chatId, "chat ID", event)}>Copy chat ID</Menu.Item>
          {feedback && <div className="px-2.5 py-1.5 text-xs" role={feedback === "failed" ? "alert" : "status"}>
            {feedback === "failed" ? `Could not copy ${copyTarget}. Try again.`
              : feedback === "copied" ? (copyTarget === "chat ID" ? "Chat ID copied" : "Text copied") : "Copying…"}
          </div>}
          <MenuActions items={items} zIndex={zIndex} Menu={Menu} />
        </Menu.Content>
      </Menu.Portal>
  );
  return <>
    <ContextMenu.Root onOpenChange={open => { opened(open); onContextMenuOpenChange?.(open); }}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      {contents(ContextMenu)}
    </ContextMenu.Root>
    {dropdownTrigger ? <DropdownMenu.Root onOpenChange={open => { opened(open); onDropdownOpenChange?.(open); }}>
      <DropdownMenu.Trigger asChild>{dropdownTrigger}</DropdownMenu.Trigger>
      {contents(DropdownMenu)}
    </DropdownMenu.Root> : null}
  </>;
}
