/// <reference path="../../../_shared/matrix-os.d.ts" />
/**
 * The parts of `window.MatrixOS` the Sheets shell uses, so tests can pass a
 * small fake. Electron Desktop may lack members: every optional one is
 * checked before use.
 */
import type { MatrixOSAi, MatrixOSDb, MatrixOSFiles } from "../../../_shared/matrix-os";

export interface SheetsBridge {
  files: Pick<MatrixOSFiles, "list" | "read" | "write" | "openRequest" | "onOpenRequest">;
  db?: Pick<MatrixOSDb, "find" | "bulkInsert" | "compareAndSwap"> | null;
  /** Key-value store private to the app; used for tab order and colours. */
  readData?: (key: string) => Promise<unknown>;
  writeData?: (key: string, value: unknown) => Promise<void>;
  /** The model behind the assistant; without it the assistant's model actions are off. */
  ai?: Pick<MatrixOSAi, "generate"> | null;
  /** What the host lets this app do; `ai` is false until the owner allows AI for Sheets. */
  capabilities?: () => Promise<{ ai?: unknown }>;
}

/** The injected bridge, or null when this window has no file access. */
export function getBridge(): SheetsBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as Partial<Window>).MatrixOS;
  if (bridge === undefined || bridge === null) return null;
  const files = bridge.files as Partial<MatrixOSFiles> | undefined;
  if (files === undefined || typeof files.read !== "function" || typeof files.write !== "function" || typeof files.list !== "function") return null;
  return bridge as unknown as SheetsBridge;
}

/** Logs a failure by name only: messages from the bridge or engine may carry paths. */
export function logFailure(message: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  console.warn(`[sheets] ${message} (${name}${code ? `, ${code}` : ""})`);
}
