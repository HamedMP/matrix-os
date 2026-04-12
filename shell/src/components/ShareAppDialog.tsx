"use client";

import { useState, useEffect, useCallback } from "react";
import { UsersIcon, Share2Icon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;

interface GroupEntry {
  slug: string;
  name: string;
  room_id: string;
}

interface ShareAppDialogProps {
  appSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareAppDialog({ appSlug, open, onOpenChange }: ShareAppDialogProps) {
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [sharing, setSharing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchGroups = useCallback(async () => {
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) return;
      const data = await r.json();
      setGroups(data.groups ?? []);
    } catch {
      // network error
    }
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      fetchGroups();
    }
  }, [open, fetchGroups]);

  async function handleShare(groupSlug: string) {
    if (sharing) return;
    setSharing(groupSlug);
    setError(null);
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups/${groupSlug}/share-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_slug: appSlug }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) {
        setError("Failed to share app");
        return;
      }
      onOpenChange(false);
    } catch {
      setError("Network error");
    } finally {
      setSharing(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>Share app</DialogTitle>
          <DialogDescription>
            Share "{appSlug}" to a group so members can use it together.
          </DialogDescription>
        </DialogHeader>

        {groups.length === 0 ? (
          <p className="text-sm text-foreground/60 py-4 text-center">
            No groups yet. Create a group first.
          </p>
        ) : (
          <div className="flex flex-col gap-1 py-2">
            {groups.map((g) => (
              <Button
                key={g.slug}
                data-testid={`share-group-${g.slug}`}
                variant="outline"
                className="justify-start gap-2 h-10"
                disabled={sharing === g.slug}
                onClick={() => handleShare(g.slug)}
              >
                <UsersIcon className="size-4 shrink-0" />
                <span className="truncate">{g.name}</span>
                {sharing === g.slug && (
                  <Share2Icon className="size-3.5 ml-auto animate-pulse" />
                )}
              </Button>
            ))}
          </div>
        )}

        {error && (
          <p data-testid="share-error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
