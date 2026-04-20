"use client";

import { UserMinusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Member {
  user_id: string;
  role: "owner" | "editor" | "viewer";
  membership: "join" | "invite";
}

interface MemberRowProps {
  member: Member;
  isOwner: boolean;
  isSelf: boolean;
  onRoleChange: (role: string) => void;
  onKick: () => void;
}

const ROLES = ["owner", "editor", "viewer"] as const;

export function MemberRow({ member, isOwner, isSelf, onRoleChange, onKick }: MemberRowProps) {
  return (
    <div
      data-testid={`member-row-${member.user_id}`}
      className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-foreground/5 group"
    >
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm truncate">{member.user_id}</span>
        <div className="flex items-center gap-1.5 mt-0.5">
          {isOwner && !isSelf ? (
            <select
              data-testid={`member-role-select-${member.user_id}`}
              value={member.role}
              onChange={(e) => onRoleChange(e.target.value)}
              className="text-[10px] bg-transparent border border-border/40 rounded px-1 py-0 cursor-pointer hover:border-border"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          ) : (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {member.role}
            </Badge>
          )}
          {member.membership === "invite" && (
            <span className="text-[10px] text-foreground/50 italic">invited</span>
          )}
        </div>
      </div>
      {isOwner && !isSelf && (
        <button
          data-testid={`member-kick-${member.user_id}`}
          onClick={onKick}
          className="p-1 rounded text-foreground/30 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Remove member"
        >
          <UserMinusIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
