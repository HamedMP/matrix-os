"use client";

import { useState } from "react";
import posthog from "posthog-js";
import { provisionInstance } from "./actions";

export function ProvisionButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleProvision() {
    setLoading(true);
    setError(null);

    posthog.capture("provision_requested");

    const result = await provisionInstance();
    if (result.error) {
      setError(result.error);
      setLoading(false);
      posthog.capture("provision_failed", {
        error: result.error,
      });
    }
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Provision your Matrix computer</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Your account is free. Starting provisioning begins the 3-day hosted Matrix
          trial in Clerk Billing, which requires a card for the private VPS runtime.
        </p>
      </div>
      <button
        onClick={handleProvision}
        disabled={loading}
        className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {loading ? "Starting trial..." : "Start 3-day trial"}
      </button>
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
