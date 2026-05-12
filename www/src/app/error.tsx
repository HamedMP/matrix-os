"use client";

import { useEffect } from "react";
import { capturePostHogException } from "../lib/posthog-client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    capturePostHogException(error, {
      source: "www-error-boundary",
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-sm text-center">
        <h2 className="text-xl font-semibold">Something went wrong</h2>
        <p className="mt-3 text-sm text-muted-foreground">An unexpected error occurred. Please try again.</p>
        <button
          onClick={reset}
          className="mt-6 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
