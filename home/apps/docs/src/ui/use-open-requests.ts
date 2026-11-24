/**
 * "Open with" from Files: read the pending request once on load and listen
 * for requests that arrive while the app runs. Each request is handled once
 * (by nonce), also under StrictMode's doubled effects.
 */

import { useEffect, useRef } from "react";
import type { MatrixOSFiles, OpenRequest } from "../../../_shared/matrix-os";
import { useLatest } from "./hooks";

const MAX_SEEN_NONCES = 50;

export function useOpenRequests(files: Pick<MatrixOSFiles, "openRequest" | "onOpenRequest"> | null, onRequest: (path: string) => void): void {
  const handler = useLatest(onRequest);
  const requested = useRef(false);
  const seen = useRef<string[]>([]);

  useEffect(() => {
    if (files === null) return undefined;
    const deliver = (request: OpenRequest | null): void => {
      if (request === null || typeof request.path !== "string") return;
      if (seen.current.includes(request.nonce)) return;
      seen.current = [...seen.current, request.nonce].slice(-MAX_SEEN_NONCES);
      handler.current(request.path);
    };
    if (!requested.current) {
      requested.current = true;
      // Resolves null and never rejects by contract; a failure is logged all the same.
      files.openRequest().then(deliver, (error: unknown) => console.warn("docs: could not read the open request", error));
    }
    return files.onOpenRequest(deliver);
  }, [files, handler]);
}
