"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ShieldAlertIcon } from "lucide-react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";

interface ApprovalRequest {
  id: string;
  toolName: string;
  args: unknown;
  timeout: number;
}

function formatArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => {
      const str = String(value ?? "");
      return `${key}: ${str.length > 120 ? str.slice(0, 120) + "..." : str}`;
    })
    .join("\n");
}

export function ApprovalDialog() {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [remaining, setRemaining] = useState(0);
  const { subscribe, send } = useSocket();
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const deadlineRef = useRef(0);

  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      if (msg.type === "approval:request") {
        setRequest({
          id: msg.id,
          toolName: msg.toolName,
          args: msg.args,
          timeout: msg.timeout,
        });
        deadlineRef.current = Date.now() + msg.timeout;
        setRemaining(Math.ceil(msg.timeout / 1000));
      }
    });
  }, [subscribe]);

  useEffect(() => {
    if (!request) return;

    timerRef.current = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) {
        setRequest(null);
      }
    }, 250);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [request]);

  const respond = useCallback(
    (approved: boolean) => {
      if (!request) return;
      send({ type: "approval_response", id: request.id, approved } as any);
      setRequest(null);
    },
    [request, send],
  );

  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) respond(false); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-5 text-amber-500" />
            Approval Required
          </DialogTitle>
          <DialogDescription>
            The AI wants to use <strong>{request?.toolName}</strong>.
            Review the details and approve or deny.
          </DialogDescription>
        </DialogHeader>

        {request && (
          <pre className="rounded-md bg-muted p-3 text-xs overflow-auto max-h-48 whitespace-pre-wrap">
            {formatArgs(request.args)}
          </pre>
        )}

        <div className="text-xs text-muted-foreground text-center">
          Auto-denying in {remaining}s
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => respond(false)}>
            Deny
          </Button>
          <Button onClick={() => respond(true)}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
