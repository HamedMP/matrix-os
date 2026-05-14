"use client";

import { useEffect, useState } from "react";
import { openAppSession } from "@/lib/app-session";

interface BrowserStandaloneFrameProps {
  src: string;
}

export function BrowserStandaloneFrame({ src }: BrowserStandaloneFrameProps) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    openAppSession("browser")
      .then(() => {
        if (!cancelled) {
          setReady(true);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        console.warn("[browser-route] session bootstrap failed:", err instanceof Error ? err.message : String(err));
        if (!cancelled) {
          setReady(true);
          setError("Browser session could not be prepared. Sign in and reload this page.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return <div className="grid h-full w-full place-items-center bg-background text-sm text-muted-foreground" />;
  }

  return (
    <>
      {error ? (
        <div className="absolute inset-x-0 top-0 z-10 bg-destructive px-4 py-2 text-sm text-destructive-foreground">
          {error}
        </div>
      ) : null}
      <iframe
        title="Matrix Browser"
        src={src}
        className="h-full w-full border-0"
        allow="autoplay; fullscreen"
      />
    </>
  );
}
