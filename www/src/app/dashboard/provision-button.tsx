"use client";

import { useState } from "react";
import { provisionInstance } from "./actions";

export function ProvisionButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleProvision() {
    setLoading(true);
    setError(null);
    const result = await provisionInstance();
    if (result.error) {
      setError(result.error);
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        onClick={handleProvision}
        disabled={loading}
        className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? "Provisioning..." : "Provision Instance"}
      </button>
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
