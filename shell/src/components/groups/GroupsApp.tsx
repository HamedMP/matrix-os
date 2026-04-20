"use client";

import { useState, useEffect, useCallback } from "react";
import { UsersIcon, PlusIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";
import { GroupList } from "./GroupList";
import { GroupDetail } from "./GroupDetail";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;

export interface GroupEntry {
  slug: string;
  name: string;
  room_id: string;
  owner_handle?: string;
}

interface GroupsAppProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GroupsApp({ open, onOpenChange }: GroupsAppProps) {
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) return;
      const data = await r.json();
      setGroups(data.groups ?? []);
    } catch {
      // network error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchGroups();
  }, [open, fetchGroups]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) return;
      const data = await r.json();
      setShowCreate(false);
      setNewName("");
      await fetchGroups();
      setSelectedSlug(data.slug);
    } catch {
      // network error
    } finally {
      setCreating(false);
    }
  }

  function handleGroupDeleted(slug: string) {
    setGroups((prev) => prev.filter((g) => g.slug !== slug));
    if (selectedSlug === slug) setSelectedSlug(null);
  }

  function handleGroupRenamed(slug: string, name: string) {
    setGroups((prev) => prev.map((g) => (g.slug === slug ? { ...g, name } : g)));
  }

  if (!open) return null;

  const selectedGroup = groups.find((g) => g.slug === selectedSlug) ?? null;

  return (
    <>
      <div
        data-testid="groups-app"
        className="fixed inset-0 z-[80] flex bg-background/80 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) onOpenChange(false);
        }}
      >
        <div className="m-auto flex w-full max-w-4xl h-[80vh] rounded-2xl border border-border/40 bg-card shadow-2xl overflow-hidden">
          {/* Left panel: group list */}
          <div className="w-64 shrink-0 border-r border-border/30 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/20">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <UsersIcon className="size-4" />
                Groups
              </h2>
              <button
                data-testid="groups-create-btn"
                onClick={() => setShowCreate(true)}
                className="p-1 rounded hover:bg-foreground/10 text-foreground/60 hover:text-foreground"
                title="New group"
              >
                <PlusIcon className="size-4" />
              </button>
            </div>
            <GroupList
              groups={groups}
              loading={loading}
              selectedSlug={selectedSlug}
              onSelect={setSelectedSlug}
            />
          </div>

          {/* Right panel: group detail */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedGroup ? (
              <GroupDetail
                group={selectedGroup}
                onRenamed={(name) => handleGroupRenamed(selectedGroup.slug, name)}
                onDeleted={() => handleGroupDeleted(selectedGroup.slug)}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
                <UsersIcon className="size-10 text-foreground/15" />
                {groups.length === 0 && !loading ? (
                  <>
                    <p className="text-sm font-medium text-foreground/60">
                      Create your first group to collaborate with others
                    </p>
                    <Button
                      size="sm"
                      onClick={() => setShowCreate(true)}
                      data-testid="groups-empty-cta"
                    >
                      <PlusIcon className="size-3.5 mr-1" />
                      New group
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-foreground/40">Select a group</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle>Create group</DialogTitle>
            <DialogDescription>Create a shared workspace to collaborate with others.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); handleCreate(); }}>
            <Input
              autoFocus
              placeholder="Group name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              data-testid="groups-create-name"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newName.trim() || creating} data-testid="groups-create-submit">
                {creating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
