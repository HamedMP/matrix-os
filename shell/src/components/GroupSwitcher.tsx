"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { UsersIcon, PlusIcon, ChevronDownIcon, UserIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";
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

interface GroupEntry {
  slug: string;
  name: string;
  room_id: string;
  owner_handle?: string;
}

interface GroupSwitcherProps {
  onGroupChange?: (slug: string | null) => void;
}

export function GroupSwitcher({ onGroupChange }: GroupSwitcherProps) {
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchGroups = useCallback(async () => {
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) return;
      const data = await r.json();
      setGroups(data.groups ?? []);
    } catch {
      // network error — keep stale list
    }
  }, []);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  // Read ?group= from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("group");
    if (g) setActiveSlug(g);
  }, []);

  // Close dropdown on outside click / escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function select(slug: string | null) {
    setActiveSlug(slug);
    setOpen(false);
    // Update URL ?group= param
    const url = new URL(window.location.href);
    if (slug) {
      url.searchParams.set("group", slug);
    } else {
      url.searchParams.delete("group");
    }
    window.history.replaceState({}, "", url.toString());
    onGroupChange?.(slug);
  }

  async function createGroup() {
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
      select(data.slug);
    } catch {
      // network error
    } finally {
      setCreating(false);
    }
  }

  const activeGroup = groups.find((g) => g.slug === activeSlug);
  const label = activeGroup ? activeGroup.name : "Personal";

  return (
    <>
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          data-testid="group-switcher-trigger"
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-foreground/60 ${open ? "bg-foreground/10 text-foreground/90" : "hover:bg-foreground/10"}`}
        >
          <UsersIcon className="size-3.5" />
          <span className="max-w-[120px] truncate">{label}</span>
          <ChevronDownIcon className="size-3 opacity-50" />
        </button>

        {open && (
          <div className="absolute top-full left-0 mt-0.5 min-w-[200px] py-1 rounded-lg bg-card/90 backdrop-blur-xl border border-border/40 shadow-xl z-[65]">
            {/* Personal workspace */}
            <button
              data-testid="group-switcher-item-personal"
              onClick={() => select(null)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-[13px] hover:bg-primary/10 ${
                !activeSlug ? "text-foreground font-medium" : "text-foreground/70"
              }`}
            >
              <UserIcon className="size-3.5 shrink-0" />
              <span>Personal</span>
            </button>

            {groups.length > 0 && (
              <div className="my-1 border-t border-border/40" />
            )}

            {/* Group list */}
            {groups.map((g) => (
              <button
                key={g.slug}
                data-testid={`group-switcher-item-${g.slug}`}
                onClick={() => select(g.slug)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-[13px] hover:bg-primary/10 ${
                  g.slug === activeSlug ? "text-foreground font-medium" : "text-foreground/70"
                }`}
              >
                <UsersIcon className="size-3.5 shrink-0" />
                <span className="truncate">{g.name}</span>
              </button>
            ))}

            <div className="my-1 border-t border-border/40" />

            {/* New group */}
            <button
              data-testid="group-switcher-new"
              onClick={() => { setOpen(false); setShowCreate(true); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-foreground/60 hover:bg-primary/10 hover:text-foreground"
            >
              <PlusIcon className="size-3.5 shrink-0" />
              <span>New group</span>
            </button>
          </div>
        )}
      </div>

      {/* Create group dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle>Create group</DialogTitle>
            <DialogDescription>Create a shared workspace to collaborate with others.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); createGroup(); }}>
            <Input
              autoFocus
              placeholder="Group name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              data-testid="group-create-name"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newName.trim() || creating} data-testid="group-create-submit">
                {creating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
