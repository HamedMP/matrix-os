"use client";

import { useState, useRef, useEffect } from "react";
import { useIdentity } from "@/hooks/useIdentity";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserIcon, LogOutIcon, SettingsIcon } from "lucide-react";

function getInitial(displayName: string, handle: string): string {
  if (displayName) return displayName.charAt(0).toUpperCase();
  if (handle) return handle.charAt(0).toUpperCase();
  return "U";
}

function isCloudEnvironment(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hostname.endsWith(".matrix-os.com");
}

export function UserButton() {
  const identity = useIdentity();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const displayName = identity?.displayName || "User";
  const handle = identity?.handle || "";
  const initial = getInitial(displayName, handle);
  const isCloud = isCloudEnvironment();

  return (
    <div ref={ref} className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setOpen((prev) => !prev)}
            className={`flex size-10 items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
              open
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card border-border/60"
            }`}
          >
            {identity ? (
              <span className="text-sm font-semibold">{initial}</span>
            ) : (
              <UserIcon className="size-4" />
            )}
          </button>
        </TooltipTrigger>
        {!open && (
          <TooltipContent side="right" sideOffset={8}>
            {displayName}
          </TooltipContent>
        )}
      </Tooltip>

      {open && (
        <div className="absolute left-12 bottom-0 z-50 w-56 rounded-lg border border-border bg-card shadow-xl p-3 space-y-3 animate-in fade-in slide-in-from-left-2 duration-150">
          <div className="space-y-1">
            <p className="text-sm font-medium truncate">{displayName}</p>
            {handle && (
              <p className="text-xs text-muted-foreground truncate">
                @{handle}
              </p>
            )}
          </div>

          <div className="border-t border-border/40" />

          <div className="space-y-1">
            <button
              onClick={() => {
                setOpen(false);
                window.location.href = "/settings/agent";
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <SettingsIcon className="size-3.5" />
              Account Settings
            </button>

            {isCloud && (
              <button
                onClick={() => {
                  setOpen(false);
                  window.location.href = "https://matrix-os.com/login";
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <LogOutIcon className="size-3.5" />
                Log Out
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
