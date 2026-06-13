import { useEffect, useRef, useState } from "react";
import { Button } from "../../design/primitives";
import { invoke, onEvent } from "../../lib/operator";

// Hosts a main-process WebContentsView positioned over this element's rect.
// The remote content renders in an isolated partition with no IPC access; this
// component only reports bounds and surfaces the inline re-auth prompt.
// Off-screen rect used to hide the native view while its tab is inactive
// (a WebContentsView is an OS overlay and would otherwise paint over the active
// tab — lesson L14).
const HIDDEN_BOUNDS = { x: -20000, y: 0, width: 800, height: 600 };

export default function EmbedHost({
  kind,
  slug,
  active = true,
}: {
  kind: "hosted-shell" | "app";
  slug?: string;
  active?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const embedIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [state, setState] = useState<"loading" | "ready" | "auth-required" | "failed">("loading");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let offState: (() => void) | null = null;

    const rect = host.getBoundingClientRect();
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    void invoke("embed:open", { kind, ...(slug ? { slug } : {}), bounds })
      .then(({ embedId }) => {
        if (disposed) {
          void invoke("embed:close", { embedId });
          return;
        }
        embedIdRef.current = embedId;
        offState = onEvent("embed:state", (payload) => {
          if (payload.embedId === embedId) setState(payload.state);
        });
      })
      .catch(() => {
        if (!disposed) setState("failed");
      });

    const reportBounds = () => {
      const id = embedIdRef.current;
      if (!id) return;
      if (!activeRef.current) {
        void invoke("embed:set-bounds", { embedId: id, bounds: HIDDEN_BOUNDS });
        return;
      }
      const r = host.getBoundingClientRect();
      void invoke("embed:set-bounds", {
        embedId: id,
        bounds: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      });
    };
    // ResizeObserver catches size changes; window resize catches position
    // shifts that don't change this element's own box.
    const observer = new ResizeObserver(reportBounds);
    observer.observe(host);
    window.addEventListener("resize", reportBounds);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", reportBounds);
      offState?.();
      const id = embedIdRef.current;
      if (id) void invoke("embed:close", { embedId: id });
    };
  }, [kind, slug]);

  // Show/hide the native view as the hosting tab activates/deactivates.
  useEffect(() => {
    const id = embedIdRef.current;
    const host = hostRef.current;
    if (!id) return;
    if (active && host) {
      const r = host.getBoundingClientRect();
      void invoke("embed:set-bounds", {
        embedId: id,
        bounds: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      });
    } else {
      void invoke("embed:set-bounds", { embedId: id, bounds: HIDDEN_BOUNDS });
    }
  }, [active]);

  return (
    <div ref={hostRef} className="relative min-h-0 flex-1" style={{ background: "var(--bg-app)" }}>
      {state === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="status-pulse text-sm" style={{ color: "var(--text-tertiary)" }}>
            Loading…
          </span>
        </div>
      ) : null}
      {state === "auth-required" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            This surface needs you to sign in again.
          </p>
          <Button
            variant="primary"
            onClick={() => {
              const id = embedIdRef.current;
              if (id) {
                setState("loading");
                void invoke("embed:retry-auth", { embedId: id });
              }
            }}
          >
            Retry sign-in
          </Button>
        </div>
      ) : null}
      {state === "failed" ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Couldn't load this surface.
          </span>
        </div>
      ) : null}
    </div>
  );
}
