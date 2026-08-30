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
  sessionIdRef: CurrentRef<string | null>;
  wsRef: CurrentRef<WebSocket | null>;
}

export function useTerminalFilePaste({
  containerRef,
  cwd,
  sessionIdRef,
  wsRef,
}: TerminalFilePasteOptions): void {
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- this effect only registers paste/drop listeners; the fetch runs later from those user event handlers with an AbortSignal timeout.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sendBracketedPaste = (terminalPaths: string[]) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const chunk of splitBracketedPastePayload(terminalPaths)) {
          ws.send(JSON.stringify({
            type: "input",
            data: `${BRACKETED_PASTE_OPEN}${chunk}${BRACKETED_PASTE_CLOSE}`,
          }));
        }
      }
    };

    const uploadAndPasteFiles = async (files: File[]) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }
      const terminalPaths: string[] = [];
      let authToken: string | null = null;
      try {
        authToken = await getWebSocketAuthToken();
      } catch (err: unknown) {
        console.warn("Terminal paste auth token unavailable:", err instanceof Error ? err.message : err);
      }
      for (const file of files) {
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
            console.warn(`Terminal paste upload failed: ${res.status}`);
            continue;
          }
          const payload = await res.json() as { terminalPath?: unknown };
          if (typeof payload.terminalPath === "string") {
            terminalPaths.push(payload.terminalPath);
          }
        } catch (err: unknown) {
          console.warn("Terminal paste upload failed:", err instanceof Error ? err.message : err);
        } finally {
          uploadTimeout.cleanup();
        }
      }
      if (terminalPaths.length > 0) {
        sendBracketedPaste(terminalPaths);
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
  }, [containerRef, cwd, sessionIdRef, wsRef]);
}
