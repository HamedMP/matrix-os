import { useEffect } from "react";
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

type CurrentRef<T> = { current: T };

interface TerminalFilePasteOptions {
  containerRef: CurrentRef<HTMLDivElement | null>;
  cwd: string;
  operationGenerationRef: CurrentRef<number>;
  sessionIdRef: CurrentRef<string | null>;
  setPasteError: (message: string | null) => void;
  socketGenerationRef: CurrentRef<number>;
  wsRef: CurrentRef<WebSocket | null>;
}

export function useTerminalFilePaste({
  containerRef,
  cwd,
  operationGenerationRef,
  sessionIdRef,
  setPasteError,
  socketGenerationRef,
  wsRef,
}: TerminalFilePasteOptions): void {
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- this effect only registers paste/drop listeners; the fetch runs later from those user event handlers with an AbortSignal timeout.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sendBracketedPaste = (terminalPaths: string[], ws: WebSocket | null): boolean => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          for (const chunk of splitBracketedPastePayload(terminalPaths)) {
            ws.send(JSON.stringify({
              type: "input",
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

    const uploadAndPasteFiles = async (files: File[]) => {
      const operation = ++operationGenerationRef.current;
      const sessionId = sessionIdRef.current;
      const initiatingSocket = wsRef.current;
      const initiatingSocketGeneration = socketGenerationRef.current;
      const canCommit = () => operationGenerationRef.current === operation
        && sessionIdRef.current === sessionId
        && wsRef.current === initiatingSocket
        && socketGenerationRef.current === initiatingSocketGeneration;
      if (!sessionId || !initiatingSocket) {
        if (canCommit()) setPasteError("Image paste failed. Try again.");
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
        const mimeType = terminalPasteMimeType(file);
        if (!mimeType) {
          continue;
        }
        const uploadTimeout = terminalPasteUploadTimeout();
        // react-doctor-disable-next-line react-doctor/react-compiler-unsupported-syntax, react-hooks-js/todo -- try/finally guarantees each paste upload timeout is cleaned up after this user-triggered event handler finishes.
        try {
          const headers: Record<string, string> = {
            "Content-Type": mimeType,
            "X-Matrix-Filename": file.name,
          };
          if (authToken) {
            headers.Authorization = `Bearer ${authToken}`;
          }
          const url = new URL(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(sessionId)}/paste-assets`);
          url.searchParams.set("cwd", cwd || "projects");
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- paste uploads are intentionally sequential to preserve terminal insertion order and avoid multiple simultaneous file bodies.
          const res = await fetch(url.toString(), {
            method: "POST",
            credentials: "same-origin",
            headers,
            signal: uploadTimeout.signal,
            body: file,
          });
          if (!res.ok) {
            console.warn("[terminal] image paste upload failed", { category: "upload-error" });
            failed = true;
            continue;
          }
          const payload = await res.json() as { terminalPath?: unknown };
          if (typeof payload.terminalPath === "string") {
            terminalPaths.push(payload.terminalPath);
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
        setPasteError("Image paste failed. Try again.");
        return;
      }
      setPasteError(sendBracketedPaste(terminalPaths, initiatingSocket)
        ? null
        : "Image paste failed. Try again.");
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

    const onPaste = (event: ClipboardEvent) => {
      const files = captureImagePayload(event);
      if (files.length > 0) {
        void uploadAndPasteFiles(files);
      }
    };
    const onDrag = (event: DragEvent) => {
      captureImagePayload(event);
    };
    const onDrop = (event: DragEvent) => {
      const files = captureImagePayload(event);
      if (files.length > 0) {
        void uploadAndPasteFiles(files);
      }
    };

    container.addEventListener("paste", onPaste, { capture: true });
    container.addEventListener("dragenter", onDrag, { capture: true });
    container.addEventListener("dragover", onDrag, { capture: true });
    container.addEventListener("drop", onDrop, { capture: true });
    return () => {
      container.removeEventListener("paste", onPaste, { capture: true });
      container.removeEventListener("dragenter", onDrag, { capture: true });
      container.removeEventListener("dragover", onDrag, { capture: true });
      container.removeEventListener("drop", onDrop, { capture: true });
    };
  }, [
    containerRef,
    cwd,
    operationGenerationRef,
    sessionIdRef,
    setPasteError,
    socketGenerationRef,
    wsRef,
  ]);
}
