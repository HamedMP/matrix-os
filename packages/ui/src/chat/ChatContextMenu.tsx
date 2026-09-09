"use client";

import * as ContextMenu from "@radix-ui/react-context-menu";
import { useEffect, useRef, useState, type ReactElement } from "react";

export function ChatContextMenu({ chatId, children, items = [], zIndex = 100 }: {
  chatId?: string | null;
  children: ReactElement;
  zIndex?: number;
  items?: { label: string; disabled?: boolean; danger?: boolean; onSelect: () => void }[];
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
  return (
    <ContextMenu.Root onOpenChange={(open) => {
      generation.current += 1;
      setFeedback(null);
      setSelectedText(open ? window.getSelection()?.toString() ?? "" : "");
    }}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] rounded-xl border p-1 shadow-lg" style={{
          zIndex, background: "var(--bg-overlay, var(--popover))",
          color: "var(--text-primary, var(--popover-foreground))",
          borderColor: "var(--border-default, var(--border))",
        }}>
          {selectedText && <ContextMenu.Item disabled={feedback === "pending"}
            className="cursor-default rounded px-2.5 py-1.5 text-sm outline-none focus:bg-accent"
            onSelect={(event) => copy(selectedText, "selected text", event)}>Copy selected text</ContextMenu.Item>}
          <ContextMenu.Item disabled={feedback === "pending"} className="cursor-default rounded px-2.5 py-1.5 text-sm outline-none focus:bg-accent"
            onSelect={(event) => copy(chatId, "chat ID", event)}>Copy chat ID</ContextMenu.Item>
          {feedback && <div className="px-2.5 py-1.5 text-xs" role={feedback === "failed" ? "alert" : "status"}>
            {feedback === "failed" ? `Could not copy ${copyTarget}. Try again.`
              : feedback === "copied" ? (copyTarget === "chat ID" ? "Chat ID copied" : "Text copied") : "Copying…"}
          </div>}
          {items.map((item) => <ContextMenu.Item key={item.label} disabled={item.disabled} onSelect={item.onSelect}
            className="cursor-default rounded px-2.5 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-40"
            style={item.danger ? { color: "var(--danger, var(--destructive))" } : undefined}>{item.label}</ContextMenu.Item>)}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
