"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { XIcon, DownloadIcon, ShieldCheckIcon, AlertTriangleIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface InstallDialogProps {
  listingId: string;
  name: string;
  permissions: string[];
  integrations?: { required?: string[]; optional?: string[] };
  onClose: () => void;
  onInstalled: (result: { slug: string; status: string }) => void;
}

export function InstallDialog({
  listingId,
  name,
  permissions,
  integrations,
  onClose,
  onInstalled,
}: InstallDialogProps) {
  const [target, setTarget] = useState<"personal" | "organization">("personal");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setError(null);

    try {
      const res = await fetch(`${GATEWAY_URL}/api/apps/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingId,
          target,
          approvedPermissions: permissions,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Installation failed" }));
        setError(data.error ?? "Installation failed");
        return;
      }

      const data = await res.json();
      onInstalled(data);
    } catch {
      setError("Network error - please try again");
    } finally {
      setInstalling(false);
    }
  }, [listingId, target, permissions, onInstalled]);

  const requiredIntegrations = integrations?.required ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border shadow-xl w-full max-w-md p-6 z-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Install {name}</h2>
          <button
            onClick={onClose}
            className="size-7 flex items-center justify-center rounded-md hover:bg-muted"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* Install target */}
        <div className="mb-4">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Install to
          </label>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => setTarget("personal")}
              className={`flex-1 rounded-lg border p-3 text-sm text-left transition-colors ${
                target === "personal"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/30"
              }`}
            >
              <div className="font-medium">Personal</div>
              <div className="text-xs text-muted-foreground mt-0.5">Your desktop only</div>
            </button>
            <button
              onClick={() => setTarget("organization")}
              className={`flex-1 rounded-lg border p-3 text-sm text-left transition-colors ${
                target === "organization"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/30"
              }`}
            >
              <div className="font-medium">Organization</div>
              <div className="text-xs text-muted-foreground mt-0.5">Shared with team</div>
            </button>
          </div>
        </div>

        {/* Permissions */}
        {permissions.length > 0 && (
          <div className="mb-4">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Permissions requested
            </label>
            <ul className="mt-2 space-y-1">
              {permissions.map((perm) => (
                <li key={perm} className="flex items-center gap-2 text-sm">
                  <ShieldCheckIcon className="size-3.5 text-green-500 shrink-0" />
                  <span>{perm}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Required integrations */}
        {requiredIntegrations.length > 0 && (
          <div className="mb-4">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Required integrations
            </label>
            <ul className="mt-2 space-y-1">
              {requiredIntegrations.map((int) => (
                <li key={int} className="flex items-center gap-2 text-sm">
                  <AlertTriangleIcon className="size-3.5 text-amber-500 shrink-0" />
                  <span>{int}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground mt-1">
              You may need to configure these after installation.
            </p>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button className="flex-1" onClick={handleInstall} disabled={installing}>
            {installing ? (
              "Installing..."
            ) : (
              <>
                <DownloadIcon className="size-4 mr-2" />
                Install
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
