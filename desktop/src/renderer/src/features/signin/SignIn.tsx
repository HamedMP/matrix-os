import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";

type FlowPhase = "idle" | "starting" | "waiting" | "expired" | "error";

const POLL_INTERVAL_MS = 2000;

export default function SignIn() {
  const refresh = useConnection((s) => s.refresh);
  const [phase, setPhase] = useState<FlowPhase>("idle");
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const start = useCallback(async () => {
    setPhase("starting");
    try {
      const code = await invoke("auth:start-device-flow", {});
      setUserCode(code.userCode);
      setVerificationUri(code.verificationUri);
      setPhase("waiting");
      stopPolling();
      pollTimer.current = setInterval(() => {
        void invoke("auth:poll", {}).then((result) => {
          if (result.status === "authorized") {
            stopPolling();
            void refresh();
          } else if (result.status === "expired") {
            stopPolling();
            setPhase("expired");
          }
        });
      }, POLL_INTERVAL_MS);
    } catch {
      setPhase("error");
    }
  }, [refresh, stopPolling]);

  return (
    <div className="flex flex-1 items-center justify-center">
      <div
        className="fade-in flex w-[380px] flex-col items-center gap-6 rounded-xl border p-10"
        style={{
          background: "var(--bg-surface)",
          borderColor: "var(--border-subtle)",
          boxShadow: "var(--shadow-2)",
        }}
      >
        <div className="flex flex-col items-center gap-1.5">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-semibold"
            style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
          >
            M
          </div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Matrix OS
          </h1>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Sign in to connect to your computer
          </p>
        </div>

        {phase === "waiting" && userCode ? (
          <div className="flex flex-col items-center gap-4">
            <div
              className="rounded-lg border px-5 py-3 font-mono text-xl tracking-[0.2em]"
              style={{
                borderColor: "var(--border-default)",
                background: "var(--bg-raised)",
                color: "var(--text-primary)",
              }}
              data-selectable
            >
              {userCode}
            </div>
            <p className="max-w-[280px] text-center text-sm" style={{ color: "var(--text-secondary)" }}>
              Approve this code in the browser window that just opened.
            </p>
            {verificationUri ? (
              <button
                type="button"
                className="text-sm underline-offset-2 hover:underline"
                style={{ color: "var(--accent)" }}
                onClick={() => void invoke("shell:open-external", { url: verificationUri })}
              >
                Open approval page again
              </button>
            ) : null}
            <span className="status-pulse text-xs" style={{ color: "var(--text-tertiary)" }}>
              Waiting for approval…
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {phase === "expired" ? (
              <p className="text-sm" style={{ color: "var(--warning)" }}>
                Sign-in request expired. Start again.
              </p>
            ) : null}
            {phase === "error" ? (
              <p className="text-sm" style={{ color: "var(--danger)" }}>
                Can't reach Matrix OS. Check your connection.
              </p>
            ) : null}
            <button
              type="button"
              autoFocus
              disabled={phase === "starting"}
              onClick={() => void start()}
              className="rounded-md px-5 py-2 text-sm font-medium transition-colors disabled:opacity-60"
              style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
            >
              {phase === "starting" ? "Starting…" : "Sign in with Matrix OS"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
