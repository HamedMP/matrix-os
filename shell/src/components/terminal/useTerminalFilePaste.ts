import { useCallback, useEffect, useRef } from "react";
import { captureTerminalFileDrag, terminalDropFiles, terminalDropMimeType, MAX_TERMINAL_DROP_FILES, MAX_TERMINAL_DROP_FILE_BYTES } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { getWebSocketAuthToken } from "@/lib/websocket-auth";
import {
  BRACKETED_PASTE_CLOSE,
  BRACKETED_PASTE_OPEN,
  filesFromTerminalFilePayload,
  splitBracketedPastePayload,
  terminalPasteMimeType,
  terminalPasteUploadTimeout,
} from "./terminal-file-paste";
import { parseTerminalRefKey } from "./terminal-session-id";

type CurrentRef<T> = { current: T };

interface TerminalFilePasteOptions {
  containerRef: CurrentRef<HTMLDivElement | null>;
  cwd: string;
  feedbackSequenceRef: CurrentRef<number>;
  operationGenerationRef: CurrentRef<number>;
  reportPasteFailure: (sequence: number, message: string) => void;
  reportPasteSuccess: (sequence: number) => void;
  sessionIdRef: CurrentRef<string | null>;
  socketGenerationRef: CurrentRef<number>;
  wsRef: CurrentRef<WebSocket | null>;
}

export function useTerminalFilePaste({
  containerRef,
  feedbackSequenceRef,
  operationGenerationRef,
  reportPasteFailure,
  reportPasteSuccess,
  sessionIdRef,
  socketGenerationRef,
  wsRef,
}: TerminalFilePasteOptions): (files: File[]) => void {
  const selectionRef = useRef<(files: File[]) => void>(() => undefined);
  const selectFiles = useCallback((files: File[]) => selectionRef.current(files), []);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- this effect only registers paste/drop listeners; the fetch runs later from those user event handlers with an AbortSignal timeout.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sendBracketedPaste = (terminalPaths: string[], ws: WebSocket | null, sessionId: string): boolean => {
      const terminalRef = parseTerminalRefKey(sessionId);
      if (!terminalRef) return false;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          for (const chunk of splitBracketedPastePayload(terminalPaths)) {
            ws.send(JSON.stringify({
              type: "input",
              terminalRef,
              data: `${BRACKETED_PASTE_OPEN}${chunk}${BRACKETED_PASTE_CLOSE}`,
            }));
          }
          return true;
        } catch (error: unknown) {
          console.warn("[terminal] image paste transport failed", {
            category: error instanceof DOMException ? error.name : "transport-error",
          });
        }
      }
      return false;
    };

    const uploadAndPasteFiles = async (files: File[], kind: "image" | "file" = "image") => {
      const operation = ++operationGenerationRef.current;
      const feedbackSequence = ++feedbackSequenceRef.current;
      const sessionId = sessionIdRef.current;
      const initiatingSocket = wsRef.current;
      const initiatingSocketGeneration = socketGenerationRef.current;
      const canCommit = () => operationGenerationRef.current === operation
        && sessionIdRef.current === sessionId
        && wsRef.current === initiatingSocket
        && socketGenerationRef.current === initiatingSocketGeneration;
      const failureMessage = kind === "file" ? "File upload failed. Try again." : "Image paste failed. Try again.";
      if (files.length > MAX_TERMINAL_DROP_FILES) {
        reportPasteFailure(feedbackSequence, "Upload up to 8 files at a time.");
        return;
      }
      if (files.some((file) => file.size > MAX_TERMINAL_DROP_FILE_BYTES)) {
        reportPasteFailure(feedbackSequence, kind === "file" ? "Files are limited to 10 MB." : "Images are limited to 10 MB.");
        return;
      }
      if (!sessionId || !initiatingSocket) {
        if (canCommit()) reportPasteFailure(feedbackSequence, failureMessage);
        return;
      }
      const terminalRef = parseTerminalRefKey(sessionId);
      if (!terminalRef) {
        if (canCommit()) reportPasteFailure(feedbackSequence, failureMessage);
        return;
      }
      const terminalPaths: string[] = [];
      let failed = false;
      let authToken: string | null = null;
      try {
        authToken = await getWebSocketAuthToken();
      } catch (err: unknown) {
        console.warn("[terminal] paste authentication unavailable", {
          category: err instanceof DOMException ? err.name : "auth-error",
        });
      }
      for (const file of files) {
        if (!canCommit()) return;
        const mimeType = kind === "file" ? terminalDropMimeType(file) : terminalPasteMimeType(file);
        if (!mimeType) {
          continue;
        }
        const uploadTimeout = terminalPasteUploadTimeout();
        // react-doctor-disable-next-line react-doctor/react-compiler-unsupported-syntax, react-hooks-js/todo -- try/finally guarantees each paste upload timeout is cleaned up after this user-triggered event handler finishes.
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (authToken) {
            headers.Authorization = `Bearer ${authToken}`;
          }
          const url = new URL(`${getGatewayUrl()}/api/terminal/workspaces/${encodeURIComponent(terminalRef.workspaceId)}/tabs/${encodeURIComponent(terminalRef.tabId)}/paste-assets`);
          const fileBytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < fileBytes.length; offset += 32_768) {
            binary += String.fromCharCode(...fileBytes.subarray(offset, offset + 32_768));
          }
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- paste uploads are intentionally sequential to preserve terminal insertion order and avoid multiple simultaneous file bodies.
          const res = await fetch(url.toString(), {
            method: "POST",
            credentials: "same-origin",
            headers,
            signal: uploadTimeout.signal,
            body: JSON.stringify({
              ...(kind === "file" ? { kind } : {}),
              assets: [{ name: file.name, mimeType, dataBase64: btoa(binary) }],
            }),
          });
          if (!res.ok) {
            console.warn("[terminal] image paste upload failed", { category: "upload-error" });
            failed = true;
            continue;
          }
          const payload = await res.json() as { assets?: Array<{ terminalPath?: unknown }> };
          const terminalPath = payload.assets?.[0]?.terminalPath;
          if (typeof terminalPath === "string") {
            terminalPaths.push(terminalPath);
          } else {
            failed = true;
          }
        } catch (err: unknown) {
          console.warn("[terminal] image paste upload failed", {
            category: err instanceof DOMException ? err.name : "upload-error",
          });
          failed = true;
        } finally {
          uploadTimeout.cleanup();
        }
      }
      if (!canCommit()) return;
      if (failed || terminalPaths.length === 0) {
        reportPasteFailure(feedbackSequence, failureMessage);
        return;
      }
      if (sendBracketedPaste(terminalPaths, initiatingSocket, sessionId)) {
        reportPasteSuccess(feedbackSequence);
      } else {
        reportPasteFailure(feedbackSequence, failureMessage);
      }
    };

    const captureImagePayload = (event: ClipboardEvent | DragEvent): File[] => {
      const files = "clipboardData" in event
        ? filesFromTerminalFilePayload(event.clipboardData)
        : filesFromTerminalFilePayload(event.dataTransfer);
      if (files.length === 0) {
        return [];
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return files;
    };

    const uploadSelection = (files: File[]) => {
      container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
      void uploadAndPasteFiles(files, "file");
    };
    selectionRef.current = uploadSelection;
    const onPaste = (event: ClipboardEvent) => {
      const files = captureImagePayload(event);
      if (files.length > 0) {
        void uploadAndPasteFiles(files);
      }
    };
    const onDrag = captureTerminalFileDrag;
    const onDrop = (event: DragEvent) => {
      const files = terminalDropFiles(event.dataTransfer);
      if (files === null) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        operationGenerationRef.current += 1;
        reportPasteFailure(++feedbackSequenceRef.current, "Drop individual files only. Some items could not be read.");
        return;
      }
      if (files.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void uploadAndPasteFiles(files, "file");
      }
    };

    container.addEventListener("paste", onPaste, { capture: true });
    container.addEventListener("dragenter", onDrag, { capture: true });
    container.addEventListener("dragover", onDrag, { capture: true });
    container.addEventListener("drop", onDrop, { capture: true });
    return () => {
      if (selectionRef.current === uploadSelection) selectionRef.current = () => undefined;
      container.removeEventListener("paste", onPaste, { capture: true });
      container.removeEventListener("dragenter", onDrag, { capture: true });
      container.removeEventListener("dragover", onDrag, { capture: true });
      container.removeEventListener("drop", onDrop, { capture: true });
    };
  }, [
    containerRef,
    feedbackSequenceRef,
    operationGenerationRef,
    reportPasteFailure,
    reportPasteSuccess,
    sessionIdRef,
    socketGenerationRef,
    wsRef,
  ]);
  return selectFiles;
}
