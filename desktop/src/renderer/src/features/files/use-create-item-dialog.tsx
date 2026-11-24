import { toast } from "sonner";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileLeafNameSchema } from "@matrix-os/contracts";
import { Button, Dialog } from "../../design/primitives";
import { AppError, toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { openExactFileInDesktopEditor } from "../editor/desktop-editor-store";

const SAFE_FOLDER_NAME = /^[^/\\\u0000-\u001f]{1,128}$/;

export type NewItemKind = "file" | "folder";
interface NewItemRequest {
  kind: NewItemKind;
  generation: number;
  parentPath: string;
  tabId: string;
  runtimeSlot: string;
  authGeneration: number;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * The New file / New folder dialog shared by both Files layouts. Creation is
 * bound to the computer and session it was requested on; a runtime switch
 * aborts it, and a new file opens in the desktop editor.
 */
export function useCreateItemDialog(onCreated: (tabId: string) => void) {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [newItemRequest, setNewItemRequest] = useState<NewItemRequest | null>(null);
  const [newItemName, setNewItemName] = useState("");
  const [newItemError, setNewItemError] = useState<string | null>(null);
  const [creatingItem, setCreatingItem] = useState(false);
  const newItemInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCreation = useRef<{ request: NewItemRequest; controller: AbortController } | null>(null);

  useLayoutEffect(() => () => {
    const operation = pendingCreation.current;
    pendingCreation.current = null;
    operation?.controller.abort();
  }, [runtimeSlot, authGeneration]);

  useEffect(() => {
    setNewItemRequest(null);
    setNewItemName("");
    setNewItemError(null);
    setCreatingItem(false);
  }, [runtimeSlot, authGeneration]);

  useEffect(() => {
    if (newItemRequest !== null) newItemInputRef.current?.focus();
  }, [newItemRequest]);

  const request = useCallback((kind: NewItemKind, tabId: string, parentPath: string) => {
    if (pendingCreation.current) return;
    setNewItemRequest({ kind, parentPath, tabId, runtimeSlot, authGeneration, generation: captureRuntimeGeneration() });
    setNewItemName("");
    setNewItemError(null);
  }, [authGeneration, runtimeSlot]);

  const cancelForTab = useCallback((tabId: string) => {
    if (pendingCreation.current?.request.tabId === tabId) {
      pendingCreation.current.controller.abort();
      pendingCreation.current = null;
      setCreatingItem(false);
    }
    setNewItemRequest((current) => current?.tabId === tabId ? null : current);
  }, []);

  const createItem = async () => {
    const pending = newItemRequest;
    if (!pending || pendingCreation.current) return;
    const name = newItemName.trim();
    const validName = pending.kind === "file"
      ? FileLeafNameSchema.safeParse(name).success
      : SAFE_FOLDER_NAME.test(name) && name !== "." && name !== "..";
    if (!validName) {
      setNewItemError(`Enter a ${pending.kind} name without slashes.`);
      return;
    }

    const connection = useConnection.getState();
    const currentAuthority = () => {
      const current = useConnection.getState();
      return isCurrentRuntimeGeneration(pending.generation)
        && current.runtimeSlot === pending.runtimeSlot && current.authGeneration === pending.authGeneration;
    };
    if (!connection.api || !currentAuthority()) {
      setNewItemError(`This computer changed. Reopen New ${pending.kind} and try again.`);
      return;
    }
    const operation = { request: pending, controller: new AbortController() };
    pendingCreation.current = operation;
    const requestStillCurrent = () => pendingCreation.current === operation && currentAuthority();
    const path = joinPath(pending.parentPath, name);
    setCreatingItem(true);
    setNewItemError(null);
    try {
      if (pending.kind === "file") {
        const response = await connection.api.forRuntime(pending.runtimeSlot).post<{ ok?: boolean }>("/api/files/touch", { path }, {
          signal: operation.controller.signal, maxBytes: 4096, omitErrorBody: true,
        });
        if (!response.ok) throw new Error("File creation failed");
      } else {
        await connection.api.post("/api/files/mkdir", { path });
      }
      if (!requestStillCurrent()) return;
      onCreated(pending.tabId);
      setNewItemRequest(null);
      if (pending.kind === "file" && !openExactFileInDesktopEditor(path)) {
        toast.error("File created, but it could not be opened in the editor.");
      }
    } catch (error: unknown) {
      if (requestStillCurrent()) {
        setNewItemError(pending.kind === "file" && error instanceof AppError && error.httpStatus === 409
          ? "The file name or folder is unavailable. Check the name and try again."
          : toUserMessage(error));
      }
    } finally {
      if (requestStillCurrent()) setCreatingItem(false);
      if (pendingCreation.current === operation) pendingCreation.current = null;
    }
  };

  const itemKind = newItemRequest?.kind ?? "folder";
  const itemLabel = itemKind === "file" ? "File" : "Folder";
  const closeCreationDialog = () => { if (!pendingCreation.current) setNewItemRequest(null); };

  const dialog = (
    <Dialog open={newItemRequest !== null} onClose={closeCreationDialog} title={`New ${itemKind}`} width={400} placement="center">
      <form className="p-5" onSubmit={(event) => { event.preventDefault(); void createItem(); }}>
        <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>New {itemKind}</h2>
        <p className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>Create inside {newItemRequest?.parentPath || "Matrix home"}.</p>
        <input ref={newItemInputRef} aria-label={`${itemLabel} name`} maxLength={128} disabled={creatingItem} value={newItemName} onChange={(event) => setNewItemName(event.target.value)} className="mt-4 h-10 w-full rounded-lg border px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]" style={{ borderColor: "var(--border-default)", background: "var(--bg-surface)", color: "var(--text-primary)" }} />
        {newItemError ? <p role="alert" className="mt-2 text-xs" style={{ color: "var(--danger-text)" }}>{newItemError}</p> : null}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={closeCreationDialog} disabled={creatingItem}>Cancel</Button><Button type="submit" variant="primary" disabled={creatingItem}>{creatingItem ? "Creating…" : `Create ${itemKind}`}</Button></div>
      </form>
    </Dialog>
  );

  return { request, cancelForTab, dialog };
}
