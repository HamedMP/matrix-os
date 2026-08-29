import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../design/primitives";
import { invoke, onEvent } from "../../lib/operator";
import { useConnection } from "../../stores/connection";

// Hosts a main-process WebContentsView positioned over this element's rect.
// The remote content renders in an isolated partition with no IPC access.
// A WebContentsView is a native overlay that always paints above the renderer,
// so when this host's tab is inactive the view is DETACHED from the window
// (embed:set-active false) rather than moved off-screen (lesson L14).
interface EmbedHostCommonProps {
  active?: boolean;
  refreshRequest?: number;
  layoutRevision?: string;
  visualScale?: number;
}

type EmbedHostProps = EmbedHostCommonProps & (
  | { kind: "hosted-shell" }
  | { kind: "app"; slug: string; appIdentity?: string }
  | { kind: "browser"; url: string }
);

export default function EmbedHost({
  ...props
}: EmbedHostProps) {
  const {
    kind,
  active = true,
  refreshRequest,
  layoutRevision,
  visualScale = 1,
  } = props;
  const slug = props.kind === "app" ? props.slug : undefined;
  const appIdentity = props.kind === "app" ? props.appIdentity : undefined;
  const url = props.kind === "browser" ? props.url : undefined;
  const runtimeSlot = useConnection((connection) => connection.runtimeSlot);
  const hostRef = useRef<HTMLDivElement>(null);
  const embedIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const lastRefreshRequestRef = useRef(refreshRequest);
  activeRef.current = active;
  const [openedEmbedRevision, setOpenedEmbedRevision] = useState(0);
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "auth-required" | "failed">("loading");

  const reportBounds = useCallback((): void => {
    const id = embedIdRef.current;
    const host = hostRef.current;
    if (!id || !host || !activeRef.current) return;
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
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    embedIdRef.current = null;
    setState("loading");
    let disposed = false;
    let offState: (() => void) | null = null;
    const pendingStates = new Map<string, typeof state>();

    offState = onEvent("embed:state", (payload) => {
      const currentId = embedIdRef.current;
      if (payload.embedId === currentId) {
        setState(payload.state);
        return;
      }
      pendingStates.set(payload.embedId, payload.state);
    });

    const r = host.getBoundingClientRect();
    const bounds = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };

    const openRequest = kind === "hosted-shell"
      ? { kind, bounds, active: activeRef.current }
      : kind === "browser"
        ? { kind, url: url!, bounds, active: activeRef.current }
        : {
            kind,
            slug: slug!,
            ...(appIdentity ? { appIdentity } : {}),
            bounds,
            active: activeRef.current,
          };

    void invoke("embed:open", openRequest)
      .then(({ embedId, state: initialState }) => {
        if (disposed) {
          void invoke("embed:close", { embedId });
          return;
        }
        embedIdRef.current = embedId;
        setOpenedEmbedRevision((revision) => revision + 1);
        setState(pendingStates.get(embedId) ?? initialState);
        pendingStates.delete(embedId);
        // Apply the current active state (handles a tab switch mid-open).
        void invoke("embed:set-active", { embedId, active: activeRef.current });
        if (activeRef.current) reportBounds();
      })
      .catch(() => {
        if (!disposed) setState("failed");
      });

    // ResizeObserver catches size changes; window resize catches position
    // shifts that don't change this element's own box.
    const observer = new ResizeObserver(() => reportBounds());
    observer.observe(host);
    const onWindowResize = () => reportBounds();
    window.addEventListener("resize", onWindowResize);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      offState?.();
      const id = embedIdRef.current;
      embedIdRef.current = null;
      if (id) void invoke("embed:close", { embedId: id });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appIdentity, kind, retryRevision, runtimeSlot, slug, url]);

  // Attach/detach the native view as the hosting tab activates/deactivates.
  useEffect(() => {
    const id = embedIdRef.current;
    // While embed:open is pending there is no native view to attach yet. The
    // open resolution path applies activeRef.current before reporting bounds.
    if (!id) return;
    void invoke("embed:set-active", { embedId: id, active });
    if (active) reportBounds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ResizeObserver sees size changes but not a pure move of the renderer host.
  // Native desktop surfaces pass their layout identity so position-only drags
  // also synchronize the main-process WebContentsView bounds.
  useEffect(() => {
    if (layoutRevision === undefined) return;
    const id = embedIdRef.current;
    if (id) void invoke("embed:set-scale", { embedId: id, factor: visualScale });
    reportBounds();
  }, [layoutRevision, openedEmbedRevision, reportBounds, visualScale]);

  useEffect(() => {
    if (refreshRequest === undefined || refreshRequest === lastRefreshRequestRef.current) return;
    const id = embedIdRef.current;
    if (!id || !activeRef.current) return;
    lastRefreshRequestRef.current = refreshRequest;
    setState("loading");
    void invoke("embed:reload", { embedId: id })
      .then((result) => {
        if (embedIdRef.current !== id) return;
        if (result.ok) reportBounds();
        else setState("failed");
      })
      .catch(() => {
        if (embedIdRef.current === id) setState("failed");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, openedEmbedRevision, refreshRequest]);

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
                void invoke("embed:retry-auth", { embedId: id })
                  .then((result) => {
                    if (embedIdRef.current !== id) return;
                    if (result.ok) reportBounds();
                    else setState("auth-required");
                  })
                  .catch(() => {
                    if (embedIdRef.current === id) setState("auth-required");
                  });
              }
            }}
          >
            Retry sign-in
          </Button>
        </div>
      ) : null}
      {state === "failed" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Couldn't load this surface.
          </span>
          <Button
            variant="primary"
            onClick={() => {
              setState("loading");
              setRetryRevision((revision) => revision + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
