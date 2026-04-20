"use client";

import { useState } from "react";
import { UserPlusIcon, CopyIcon, CheckIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;

interface InviteFormProps {
  groupSlug: string;
  roomId: string;
  onInvited: () => void;
}

export function InviteForm({ groupSlug, roomId, onInvited }: InviteFormProps) {
  const [handle, setHandle] = useState("");
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleInvite() {
    const h = handle.trim();
    if (!h || inviting) return;
    setInviting(true);
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups/${groupSlug}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: h }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (r.ok) {
        setHandle("");
        onInvited();
      }
    } catch {
      // network error
    } finally {
      setInviting(false);
    }
  }

  function copyInviteLink() {
    const link = roomId;
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // clipboard not available
    });
  }

  return (
    <div className="space-y-2">
      <form
        onSubmit={(e) => { e.preventDefault(); handleInvite(); }}
        className="flex gap-2"
      >
        <Input
          data-testid="invite-handle-input"
          placeholder="@user:matrix-os.com"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          className="h-8 text-xs flex-1"
        />
        <Button
          data-testid="invite-submit"
          type="submit"
          size="sm"
          disabled={!handle.trim() || inviting}
          className="h-8 px-2"
        >
          <UserPlusIcon className="size-3.5" />
        </Button>
      </form>
      <button
        data-testid="invite-copy-link"
        onClick={copyInviteLink}
        className="flex items-center gap-1.5 text-[11px] text-foreground/50 hover:text-foreground/80 transition-colors"
      >
        {copied ? (
          <CheckIcon className="size-3 text-green-500" />
        ) : (
          <CopyIcon className="size-3" />
        )}
        {copied ? "Copied!" : "Copy room ID for invite"}
      </button>
    </div>
  );
}
