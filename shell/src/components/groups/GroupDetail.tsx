"use client";

import { useState, useEffect, useCallback } from "react";
import { PencilIcon, CheckIcon, XIcon, LogOutIcon, Trash2Icon, Share2Icon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MemberRow } from "./MemberRow";
import { AppRow } from "./AppRow";
import { InviteForm } from "./InviteForm";
import { ShareAppPicker } from "./ShareAppPicker";
import type { GroupEntry } from "./GroupsApp";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;

interface Member {
  user_id: string;
  role: "owner" | "editor" | "viewer";
  membership: "join" | "invite";
}

interface SharedApp {
  slug: string;
  name: string;
  entry: string;
}

interface GroupDetailProps {
  group: GroupEntry;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
}

export function GroupDetail({ group, onRenamed, onDeleted }: GroupDetailProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [apps, setApps] = useState<SharedApp[]>([]);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(group.name);
  const [showSharePicker, setShowSharePicker] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isOwner = members.some(
    (m) => m.role === "owner" && m.user_id === group.owner_handle,
  );

  const fetchMembers = useCallback(async () => {
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups/${group.slug}/members`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) return;
      const data = await r.json();
      setMembers(data.members ?? []);
    } catch {
      // network error
    }
  }, [group.slug]);

  const fetchApps = useCallback(async () => {
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups/${group.slug}/apps`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) return;
      const data = await r.json();
      setApps(data.apps ?? []);
    } catch {
      // network error
    }
  }, [group.slug]);

  useEffect(() => {
    fetchMembers();
    fetchApps();
    setEditing(false);
    setEditName(group.name);
    setConfirmLeave(false);
    setConfirmDelete(false);
  }, [group.slug, group.name, fetchMembers, fetchApps]);

  async function handleRename() {
    const name = editName.trim();
    if (!name || name === group.name) {
      setEditing(false);
      setEditName(group.name);
      return;
    }
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups/${group.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (r.ok) {
        onRenamed(name);
      }
    } catch {
      // network error
    }
    setEditing(false);
  }

  async function handleLeave() {
    try {
      await fetch(`${GATEWAY_URL}/api/groups/${group.slug}/leave`, {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      onDeleted();
    } catch {
      // network error
    }
  }

  async function handleRoleChange(userId: string, role: string) {
    try {
      await fetch(
        `${GATEWAY_URL}/api/groups/${group.slug}/members/${encodeURIComponent(userId)}/role`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      await fetchMembers();
    } catch {
      // network error
    }
  }

  async function handleKick(userId: string) {
    try {
      await fetch(`${GATEWAY_URL}/api/groups/${group.slug}/kick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      await fetchMembers();
    } catch {
      // network error
    }
  }

  async function handleUnshare(appSlug: string) {
    try {
      await fetch(`${GATEWAY_URL}/api/groups/${group.slug}/apps/${appSlug}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      setApps((prev) => prev.filter((a) => a.slug !== appSlug));
    } catch {
      // network error
    }
  }

  function handleAppShared() {
    setShowSharePicker(false);
    fetchApps();
  }

  const ownerUserId = members.find((m) => m.role === "owner")?.user_id;

  return (
    <>
      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            {editing ? (
              <form
                className="flex items-center gap-2 flex-1"
                onSubmit={(e) => { e.preventDefault(); handleRename(); }}
              >
                <input
                  autoFocus
                  data-testid="group-rename-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="text-lg font-semibold bg-transparent border-b border-primary/40 outline-none flex-1"
                />
                <button
                  type="submit"
                  className="p-1 rounded hover:bg-foreground/10 text-green-500"
                >
                  <CheckIcon className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setEditName(group.name); }}
                  className="p-1 rounded hover:bg-foreground/10 text-foreground/40"
                >
                  <XIcon className="size-4" />
                </button>
              </form>
            ) : (
              <>
                <h2 className="text-lg font-semibold truncate" data-testid="group-detail-name">
                  {group.name}
                </h2>
                {isOwner && (
                  <button
                    data-testid="group-rename-btn"
                    onClick={() => setEditing(true)}
                    className="p-1 rounded hover:bg-foreground/10 text-foreground/40"
                    title="Rename"
                  >
                    <PencilIcon className="size-3.5" />
                  </button>
                )}
              </>
            )}
          </div>

          {/* Members */}
          <section>
            <h3 className="text-xs font-semibold text-foreground/50 uppercase tracking-wider mb-3">
              Members ({members.length})
            </h3>
            <div className="space-y-1">
              {members.map((m) => (
                <MemberRow
                  key={m.user_id}
                  member={m}
                  isOwner={isOwner}
                  isSelf={m.user_id === ownerUserId}
                  onRoleChange={(role) => handleRoleChange(m.user_id, role)}
                  onKick={() => handleKick(m.user_id)}
                />
              ))}
            </div>
            {isOwner && (
              <div className="mt-3">
                <InviteForm
                  groupSlug={group.slug}
                  roomId={group.room_id}
                  onInvited={fetchMembers}
                />
              </div>
            )}
          </section>

          {/* Shared Apps */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-foreground/50 uppercase tracking-wider">
                Shared Apps ({apps.length})
              </h3>
              {isOwner && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  data-testid="group-share-app-btn"
                  onClick={() => setShowSharePicker(true)}
                >
                  <Share2Icon className="size-3 mr-1" />
                  Share an app
                </Button>
              )}
            </div>
            {apps.length === 0 ? (
              <div className="text-center py-6">
                <Share2Icon className="size-6 mx-auto text-foreground/15 mb-2" />
                <p className="text-xs text-foreground/40">
                  {isOwner
                    ? "Share an app from your personal workspace"
                    : "No shared apps yet"}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {apps.map((a) => (
                  <AppRow
                    key={a.slug}
                    app={a}
                    isOwner={isOwner}
                    onUnshare={() => handleUnshare(a.slug)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Settings */}
          <section className="border-t border-border/20 pt-4">
            <div className="flex gap-2">
              {confirmLeave ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-foreground/60">Leave this group?</span>
                  <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={handleLeave}>
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setConfirmLeave(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  data-testid="group-leave-btn"
                  onClick={() => setConfirmLeave(true)}
                >
                  <LogOutIcon className="size-3 mr-1" />
                  Leave group
                </Button>
              )}

              {isOwner && !confirmDelete && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs text-destructive border-destructive/30"
                  data-testid="group-delete-btn"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2Icon className="size-3 mr-1" />
                  Delete
                </Button>
              )}
              {isOwner && confirmDelete && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-destructive">Delete this group?</span>
                  <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={handleLeave}>
                    Delete
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </section>
        </div>
      </ScrollArea>

      {showSharePicker && (
        <ShareAppPicker
          groupSlug={group.slug}
          existingApps={apps.map((a) => a.slug)}
          onShared={handleAppShared}
          onClose={() => setShowSharePicker(false)}
        />
      )}
    </>
  );
}
