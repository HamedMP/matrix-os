/** Opening a file or folder by its typed name, in a folder whose listing left entries out. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserFiles } from "./MatrixFileBrowser";
import { typedTarget, type TypedTarget } from "./start-model";

/** The `code` of a files bridge error, or null. */
export function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;
}

type TypedOpen = { status: "idle" } | { status: "looking" } | { status: "missing" | "forbidden" | "failed"; name: string };
const TYPED_IDLE: TypedOpen = { status: "idle" };

type Found = { kind: "file" | "folder"; path: string } | { kind: "missing" | "forbidden" } | { kind: "failed"; code: unknown };

function notThere(error: unknown): Found {
  const code = errorCode(error);
  if (code === "not_found" || code === "invalid_request") return { kind: "missing" };
  return code === "forbidden" ? { kind: "forbidden" } : { kind: "failed", code };
}

/** Where a typed name leads: a file that is there, else a folder that is there, else why neither. */
async function findTyped(files: BrowserFiles, target: TypedTarget): Promise<Found> {
  if (files.stat) {
    for (const path of target.files) {
      try {
        await files.stat(path);
        return { kind: "file", path };
      } catch (error) {
        const found = notThere(error);
        if (found.kind !== "missing") return found;
      }
    }
  }
  if (target.folder !== null) {
    try {
      await files.list(target.folder, { limit: 1 });
      return { kind: "folder", path: target.folder };
    } catch (error) {
      const found = notThere(error);
      if (found.kind !== "missing" || files.stat) return found;
    }
  }
  // Without `stat` a file cannot be checked first; the app reports one that is not there.
  return files.stat ? { kind: "missing" } : { kind: "file", path: target.files[0] };
}

function typedMessage(typed: TypedOpen, appName: string): string {
  if (typed.status === "missing") return `Nothing named “${typed.name}” in this folder.`;
  if (typed.status === "forbidden") return `${appName} is not allowed to open “${typed.name}”.`;
  if (typed.status === "failed") return `“${typed.name}” could not be opened. Try again in a moment.`;
  return "";
}

export interface TypedOpenOptions {
  files: BrowserFiles;
  /** The current listing; a typed name is offered only once it is ready and left entries out. */
  listing: { status: string; dir: string; truncated?: boolean };
  query: string;
  /** Accepted extensions joined with commas, so an inline array does not recompute the target. */
  acceptKey: string;
  disabled: boolean | undefined;
  appName: string;
  onFile: (path: string) => void;
  onFolder: (path: string) => void;
}

export interface TypedOpenState {
  /** The ready listing left entries out. */
  truncated: boolean;
  /** What the typed name could open, or null when none is offered. */
  target: TypedTarget | null;
  busy: boolean;
  /** Why the last lookup opened nothing; "" when there is nothing to say. */
  message: string;
  /** Looks the name up and opens what is there; undefined when nothing is offered. */
  open: (() => void) | undefined;
  /** Forgets the last lookup. Call it whenever the query or the folder changes. */
  reset: () => void;
}

export function useTypedOpen({ files, listing, query, acceptKey, disabled, appName, onFile, onFolder }: TypedOpenOptions): TypedOpenState {
  const [typed, setTyped] = useState<TypedOpen>(TYPED_IDLE);
  // Bumped on every reset and lookup, so the answer to a stale lookup is ignored.
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );
  const truncated = listing.status === "ready" && listing.truncated === true;
  const dir = listing.dir;
  const target = useMemo(() => (truncated ? typedTarget(dir, query, acceptKey.split(",")) : null), [truncated, dir, query, acceptKey]);
  const busy = typed.status === "looking";

  const lookUp = async (name: TypedTarget) => {
    if (disabled || busy) return;
    const mine = (run.current += 1);
    setTyped({ status: "looking" });
    const found = await findTyped(files, name);
    if (run.current !== mine) return;
    if (found.kind === "file" || found.kind === "folder") {
      setTyped(TYPED_IDLE);
      (found.kind === "file" ? onFile : onFolder)(found.path);
      return;
    }
    if (found.kind === "failed") console.warn(`[${appName.toLowerCase()}] could not open a typed name`, found.code ?? "unknown");
    setTyped({ status: found.kind, name: name.name });
  };

  return {
    truncated,
    target,
    busy,
    message: typedMessage(typed, appName),
    open: target ? () => void lookUp(target) : undefined,
    reset: () => {
      run.current += 1;
      setTyped(TYPED_IDLE);
    },
  };
}
