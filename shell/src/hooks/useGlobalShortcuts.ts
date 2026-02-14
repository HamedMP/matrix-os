"use client";

import { useEffect } from "react";
import { useCommandStore } from "@/stores/commands";

export function matchShortcut(shortcut: string, e: KeyboardEvent): boolean {
  const parts = shortcut.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));

  const needsMod = modifiers.has("cmd") || modifiers.has("ctrl");
  const hasMod = e.metaKey || e.ctrlKey;
  if (needsMod !== hasMod) return false;

  const needsShift = modifiers.has("shift");
  if (needsShift !== e.shiftKey) return false;

  const needsAlt = modifiers.has("alt");
  if (needsAlt !== e.altKey) return false;

  return e.key.toLowerCase() === key;
}

function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  return el.isContentEditable;
}

export function useGlobalShortcuts(onPalette: () => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchShortcut("Cmd+K", e)) {
        e.preventDefault();
        onPalette();
        return;
      }

      if (isTextInput(e.target)) return;

      const commands = useCommandStore.getState().commands;
      for (const cmd of commands.values()) {
        if (cmd.shortcut && matchShortcut(cmd.shortcut, e)) {
          e.preventDefault();
          cmd.execute();
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onPalette]);
}
