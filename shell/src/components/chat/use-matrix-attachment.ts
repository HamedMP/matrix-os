import { useLayoutEffect, useRef, useState } from "react";
import { FileResourceRefSchema, MAX_AGENT_ATTACHMENT_BYTES } from "@matrix-os/contracts";
import { filePreviewContentUrl } from "@matrix-os/ui";
import { readBoundedFileBlob } from "@/lib/read-bounded-file-blob";
import { ATTACHMENT_COUNT_LIMIT } from "@/components/ai-elements/attachments-utils";

export function useMatrixAttachment({
  authority,
  enabled,
  files,
  gatewayUrl,
  isCurrentAuthority,
  policy,
  scope,
  onAdd,
}: {
  authority: string | null;
  enabled: boolean;
  files: readonly File[];
  gatewayUrl?: string;
  isCurrentAuthority?: () => boolean;
  policy?: (files: readonly File[]) => string | null;
  scope: string;
  onAdd: (file: File) => void;
}) {
  const context = useRef({ enabled, files, policy, onAdd, isCurrentAuthority });
  useLayoutEffect(() => {
    context.current = { enabled, files, policy, onAdd, isCurrentAuthority };
  }, [enabled, files, policy, onAdd, isCurrentAuthority]);
  const running = useRef<AbortController | null>(null);
  const origins = useRef(new WeakMap<File, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => () => running.current?.abort(), [authority, gatewayUrl, scope, enabled]);

  async function attach(path: string): Promise<boolean> {
    if (!enabled || !gatewayUrl || (isCurrentAuthority && !isCurrentAuthority()) || running.current) return false;
    const resource = FileResourceRefSchema.safeParse({ kind: "home", path });
    if (!resource.success) {
      setError("This Matrix file is unavailable.");
      return false;
    }
    const key = JSON.stringify([authority, gatewayUrl, path]);
    if (files.some(file => origins.current.get(file) === key)) {
      setError("This Matrix file is already attached.");
      return false;
    }
    if (files.length >= ATTACHMENT_COUNT_LIMIT) {
      setError(`A message carries up to ${ATTACHMENT_COUNT_LIMIT} attachments.`);
      return false;
    }
    const request = new AbortController();
    running.current = request;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${gatewayUrl}${filePreviewContentUrl(resource.data, { download: true })}`, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      });
      const blob = await readBoundedFileBlob(response, MAX_AGENT_ATTACHMENT_BYTES);
      if (request.signal.aborted || !context.current.enabled
        || !(isCurrentAuthority?.() ?? true) || !(context.current.isCurrentAuthority?.() ?? true)) return false;
      const file = new File([blob], path.split("/").at(-1)!, { type: blob.type.split(";")[0] || "application/octet-stream" });
      const current = context.current;
      if (current.files.length >= ATTACHMENT_COUNT_LIMIT) {
        setError(`A message carries up to ${ATTACHMENT_COUNT_LIMIT} attachments.`);
        return false;
      }
      const refusal = current.policy?.([...current.files, file]);
      if (refusal) {
        setError(refusal);
        return false;
      }
      origins.current.set(file, key);
      current.onAdd(file);
      return true;
    } catch (cause: unknown) {
      if (!request.signal.aborted && (isCurrentAuthority?.() ?? true) && (context.current.isCurrentAuthority?.() ?? true)) {
        setError(cause instanceof Error && cause.message === "FileTooLarge"
          ? "This Matrix file exceeds the attachment size limit."
          : "Could not read this Matrix file. Try again.");
      }
      return false;
    } finally {
      if (running.current === request) {
        running.current = null;
        setPending(false);
      }
    }
  }

  function clear() {
    running.current?.abort();
    running.current = null;
    setError(null);
    setPending(false);
  }

  return { attach, pending, error, clear };
}
