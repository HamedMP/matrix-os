"use client";

import { useAuth } from "@clerk/nextjs";

export function OpenButton({ shellPort }: { shellPort?: number }) {
  const { getToken } = useAuth();
  const isLocal = typeof window !== "undefined" && window.location.hostname === "localhost";

  async function handleClick() {
    if (isLocal && shellPort) {
      window.location.href = `http://localhost:${shellPort}`;
      return;
    }
    const token = await getToken();
    if (token) {
      window.location.href = `https://app.matrix-os.com?__clerk_token=${encodeURIComponent(token)}`;
    } else {
      window.location.href = "https://app.matrix-os.com";
    }
  }

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
    >
      Open Matrix OS
    </button>
  );
}
