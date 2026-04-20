"use client";

import { useState, useEffect, useCallback } from "react";
import { XIcon, UserPlusIcon, UserMinusIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;

interface Member {
  user_id: string;
  role: "owner" | "editor" | "viewer";
  membership: "join" | "invite";
}

interface MembersPanelProps {
  groupSlug: string;
  isOwner: boolean;
  onClose: () => void;
}

export function MembersPanel({ groupSlug, isOwner, onClose }: MembersPanelProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteHandle, setInviteHandle] = useState("");
  const [inviting, setInviting] = useState(false);

  const fetchMembers = useCallback(async () => {
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups/${groupSlug}/members`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) return;
      const data = await r.json();
      setMembers(data.members ?? []);
    } catch {
      // network error — keep stale list
    }
  }, [groupSlug]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleInvite() {
    const handle = inviteHandle.trim();
    if (!handle || inviting) return;
    setInviting(true);
    try {
      await fetch(`${GATEWAY_URL}/api/groups/${groupSlug}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: handle }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      setInviteHandle("");
      await fetchMembers();
    } catch {
      // network error
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(userId: string) {
    try {
      await fetch(`${GATEWAY_URL}/api/groups/${groupSlug}/kick`, {
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

  const ownerUserId = members.find((m) => m.role === "owner")?.user_id;

  return (
    <div className="fixed right-0 top-7 bottom-0 w-80 bg-card/95 backdrop-blur-xl border-l border-border/40 shadow-2xl z-[70] flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
        <h2 className="text-sm font-semibold">Members</h2>
        <button
          data-testid="members-close"
          onClick={onClose}
          className="p-1 rounded hover:bg-foreground/10"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      {isOwner && (
        <div className="px-4 py-3 border-b border-border/20">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleInvite();
            }}
            className="flex gap-2"
          >
            <Input
              data-testid="members-invite-input"
              placeholder="@user:matrix-os.com"
              value={inviteHandle}
              onChange={(e) => setInviteHandle(e.target.value)}
              className="h-8 text-xs"
            />
            <Button
              data-testid="members-invite-submit"
              type="submit"
              size="sm"
              disabled={!inviteHandle.trim() || inviting}
              className="h-8 px-2"
            >
              <UserPlusIcon className="size-3.5" />
            </Button>
          </form>
        </div>
      )}

      <ScrollArea className="flex-1 px-4 py-2">
        {members.map((member) => (
          <div
            key={member.user_id}
            className="flex items-center justify-between py-2 gap-2"
          >
            <div className="flex flex-col min-w-0">
              <span className="text-xs truncate">{member.user_id}</span>
              <div className="flex items-center gap-1.5 mt-0.5">
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {member.role}
                </Badge>
                {member.membership === "invite" && (
                  <span className="text-[10px] text-foreground/50 italic">invited</span>
                )}
              </div>
            </div>
            {isOwner && member.user_id !== ownerUserId && (
              <button
                data-testid="members-remove"
                onClick={() => handleRemove(member.user_id)}
                className="p-1 rounded text-foreground/40 hover:text-destructive hover:bg-destructive/10"
                title="Remove member"
              >
                <UserMinusIcon className="size-3.5" />
              </button>
            )}
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
