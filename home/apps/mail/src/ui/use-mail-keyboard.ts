/**
 * The Mail key handler. Keys go through the store's command map; "?" opens
 * the shortcut sheet. Keys typed in fields, in dialogs or with Ctrl, Cmd or
 * Alt held are left alone.
 */
import { useEffect, useRef } from "react";
import { isEditableTarget, mailCommandForKey, type MailCommandEffect, type MailStore } from "../model";

export interface MailKeyboardOptions {
  store: MailStore;
  onEffect: (effect: MailCommandEffect) => void;
  onHelp: () => void;
  /** False while a dialog or the composer owns the keyboard. */
  enabled: boolean;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function insideIgnoredRegion(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return typeof element?.closest === "function" && element.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [data-mail-keys="off"]') !== null;
}

function isActivatable(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return typeof element?.closest === "function" && element.closest('button, a[href], [role="button"], [role="tab"], [role="treeitem"]') !== null;
}

export function useMailKeyboard({ store, onEffect, onHelp, enabled }: MailKeyboardOptions): void {
  const latest = useRef({ store, onEffect, onHelp, enabled });
  useEffect(() => {
    latest.current = { store, onEffect, onHelp, enabled };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current;
      if (!current.enabled || event.defaultPrevented) return;
      // A focused checkbox (a row's select box) takes no text, so mail keys still work.
      const input = event.target as HTMLInputElement | null;
      const toggle = input?.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio");
      const editable = !toggle && isEditableTarget(event.target);
      if (editable || insideIgnoredRegion(event.target)) return;
      // Enter on a button or link activates it, not the focused conversation.
      if (event.key === "Enter" && isActivatable(event.target)) return;
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        current.onHelp();
        return;
      }
      const command = mailCommandForKey({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
        editable,
      });
      if (!command) return;
      event.preventDefault();
      current.store.runCommand(command)
        .then((result) => {
          if (result.effect) latest.current.onEffect(result.effect);
        })
        .catch((error: unknown) => console.warn(`[mail] command.failed (${errorName(error)})`));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
