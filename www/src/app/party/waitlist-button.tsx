"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MailIcon, XIcon } from "lucide-react";

export function WaitlistButton() {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, close]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  // Load Tally widget script once
  useEffect(() => {
    if (!open) return;
    if (document.querySelector('script[src="https://tally.so/widgets/embed.js"]')) {
      // Script already loaded, re-trigger Tally to process new iframes
      if (typeof window !== "undefined" && (window as any).Tally) {
        (window as any).Tally.loadEmbeds();
      }
      return;
    }
    const script = document.createElement("script");
    script.src = "https://tally.so/widgets/embed.js";
    script.async = true;
    document.head.appendChild(script);
  }, [open]);

  return (
    <>
      <Button
        size="lg"
        className="h-10 px-6 text-sm rounded-xl"
        onClick={() => setOpen(true)}
      >
        <MailIcon className="size-4" />
        Join waitlist
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-card">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
            <span className="text-sm font-semibold">Join the waitlist</span>
            <button
              onClick={close}
              className="size-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <XIcon className="size-5" />
            </button>
          </div>
          {/* Tally embed — uses their official widget script */}
          <div className="flex-1 relative">
            <iframe
              data-tally-src="https://tally.so/r/rj6pl5?formEventsForwarding=1"
              width="100%"
              height="100%"
              frameBorder={0}
              marginHeight={0}
              marginWidth={0}
              title="Matrix Signup"
              className="absolute inset-0 border-0"
            />
          </div>
        </div>
      )}
    </>
  );
}
