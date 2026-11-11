"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useFileBrowser } from "@/hooks/useFileBrowser";

export function NewFileAction({ parentPath, gatewayUrl, disabled, xp, onCreated }: {
  parentPath: string;
  gatewayUrl: string;
  disabled: boolean;
  xp: boolean;
  onCreated: (path: string) => void;
}) {
  const createFile = useFileBrowser(state => state.createFile);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const created = useRef(false);
  useLayoutEffect(() => () => pending.current?.abort(), []);

  const changeOpen = (next: boolean) => {
    if (pending.current) return;
    setOpen(next);
    if (next) {
      created.current = false;
      setName("");
      setError(null);
    }
  };

  const submit = async () => {
    if (pending.current || disabled) return;
    const controller = new AbortController();
    pending.current = controller;
    setCreating(true);
    setError(null);
    try {
      const result = await createFile(name, { parentPath, gatewayUrl, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      created.current = true;
      setOpen(false);
      onCreated(result.path);
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn("[file-browser] Could not finish file creation:", error instanceof Error ? error.name : "Unknown error");
        if (!created.current) setError("Failed to create file");
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setCreating(false);
    }
  };

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild>
      {xp ? <button type="button" className="xp-tool-btn" disabled={disabled}>New file</button>
        : <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" disabled={disabled}>New file</Button>}
    </DialogTrigger>
    <DialogContent onCloseAutoFocus={(event) => { if (created.current) event.preventDefault(); }}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="space-y-1">
          <DialogTitle>New file</DialogTitle>
          <DialogDescription>Create inside {parentPath || "Matrix home"}.</DialogDescription>
        </div>
        <Input aria-label="File name" autoFocus maxLength={128} placeholder="notes.md" disabled={creating}
          value={name} onChange={(event) => setName(event.currentTarget.value)} />
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={creating} onClick={() => changeOpen(false)}>Cancel</Button>
          <Button type="submit" disabled={creating}>{creating ? "Creating…" : "Create file"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
