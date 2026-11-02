"use client";

import { useEffect, useMemo } from "react";
import { ErrorRecovery } from "../components/ErrorRecovery";
import { createErrorId } from "../lib/error-boundary-utils";
import { openShellRepairChat } from "../lib/app-repair";
import { capturePostHogException, reportClientError } from "../lib/posthog-client";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable ID for the telemetry effect.
  const errorId = useMemo(() => createErrorId(error), [error]);

  useEffect(() => {
    capturePostHogException(error, { source: "shell-error-boundary", digest: error.digest, errorId });
    reportClientError(error, { source: "shell-error-boundary", digest: error.digest, errorId });
  }, [error, errorId]);

  return <div className="flex h-screen w-screen items-center justify-center bg-background p-4 text-foreground">
    <ErrorRecovery title="Something went wrong" description="Matrix hit an unexpected state. You can retry or ask Matrix for help."
      details={`Error ID: ${errorId}`}
      onRetry={reset}
      onRepair={async () => {
        const result = await openShellRepairChat({ app: "Matrix OS", surface: "Matrix shell", operation: "render", message: `Error ID ${errorId}; ${error.name}` });
        window.location.assign(`/?launch=__chat__&repairChat=${encodeURIComponent(result.chatId)}`);
      }} />
  </div>;
}
