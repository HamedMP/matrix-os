"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { DropdownMenu } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { FileIcon, FolderPlusIcon, PlusIcon } from "@/lib/hugeicons";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

type ItemKind = "folder" | "file";

const menuItemClass = "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

function stopFileShortcuts(event: KeyboardEvent) {
  event.stopPropagation();
}

export function FileCreationMenu({ parentPath, gatewayUrl, disabled, xp, onFileCreated }: {
  parentPath: string;
  gatewayUrl: string;
  disabled: boolean;
  xp: boolean;
  onFileCreated: (path: string) => void;
}) {
  const createFolder = useFileBrowser(state => state.createFolder);
  const createFile = useFileBrowser(state => state.createFile);
  const [kind, setKind] = useState<ItemKind | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const pending = useRef<AbortController | null>(null);
  const openingDialog = useRef(false);
  const openedFile = useRef(false);
  useLayoutEffect(() => () => pending.current?.abort(), []);

  const openDialog = (next: ItemKind) => {
    openingDialog.current = true;
    openedFile.current = false;
    setName("");
    setError(null);
    setKind(next);
  };

  const closeDialog = () => {
    if (!pending.current) setKind(null);
  };

  const submit = async () => {
    if (!kind || pending.current || disabled) return;
    const controller = new AbortController();
    pending.current = controller;
    setCreating(true);
    setError(null);
    try {
      const create = kind === "folder" ? createFolder : createFile;
      const result = await create(name, { parentPath, gatewayUrl, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      openedFile.current = kind === "file";
      setKind(null);
      if (kind === "file") onFileCreated(result.path);
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn(`[file-browser] Could not finish ${kind} creation:`, error instanceof Error ? error.name : "Unknown error");
        if (!openedFile.current) setError(`Failed to create ${kind}`);
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setCreating(false);
    }
  };

  const triggerProps = { type: "button" as const, ref: trigger, disabled, "aria-label": "Create", title: "Create", onKeyDown: stopFileShortcuts };
  const plus = <PlusIcon className="size-4" aria-hidden="true" />;

  return <>
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        {xp ? <button className="xp-tool-btn" {...triggerProps}>{plus}</button>
          : <Button variant="outline" size="icon" className="size-7 shrink-0" {...triggerProps}>{plus}</Button>}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="min-w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ zIndex: SHELL_Z_INDEX.popover }}
          onKeyDown={stopFileShortcuts}
          onCloseAutoFocus={(event) => {
            if (!openingDialog.current) return;
            openingDialog.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenu.Item className={menuItemClass} onSelect={() => openDialog("folder")}>
            <FolderPlusIcon className="size-4" aria-hidden="true" /> New Folder
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} onSelect={() => openDialog("file")}>
            <FileIcon className="size-4" aria-hidden="true" /> New File
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    <Dialog open={kind !== null} onOpenChange={open => { if (!open) closeDialog(); }}>
      <DialogContent
        style={{ zIndex: SHELL_Z_INDEX.appDialog }}
        overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog }}
        onKeyDown={stopFileShortcuts}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!openedFile.current) trigger.current?.focus();
        }}
      >
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="space-y-1">
            <DialogTitle>{kind === "folder" ? "New folder" : "New file"}</DialogTitle>
            <DialogDescription>Create inside {parentPath || "Matrix home"}.</DialogDescription>
          </div>
          <Input aria-label={kind === "folder" ? "Folder name" : "File name"}
            autoFocus maxLength={128} placeholder={kind === "folder" ? "Notes" : "notes.md"}
            disabled={creating} value={name} onChange={(event) => setName(event.currentTarget.value)} />
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={creating} onClick={closeDialog}>Cancel</Button>
            <Button type="submit" disabled={creating}>{creating ? "Creating…" : `Create ${kind ?? "file"}`}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
