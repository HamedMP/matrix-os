import { Cloud, ExternalLink, GitBranch, MonitorCheck, ShieldCheck, Sparkles } from "@renderer/lib/hugeicons";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandPanel } from "../../design/BrandPanel";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";

type Phase = "idle" | "starting" | "waiting" | "expired" | "error";

const POLL_INTERVAL_MS = 2000;

export default function SignIn() {
  const refresh = useConnection((s) => s.refresh);
  const [phase, setPhase] = useState<Phase>("idle");
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
      // Browser launch is best-effort. The verification code and reopen action
      // remain available if the OS blocks the first attempt.
      void invoke("shell:open-external", { url: code.verificationUri }).catch((error: unknown) => {
        console.warn(
          "[signin] browser approval open failed",
          error instanceof Error ? error.name : "Unknown error",
        );
      });
      stopPolling();
      pollTimer.current = setInterval(() => {
        void invoke("auth:poll", {})
          .then((result) => {
            if (result.status === "authorized") {
              stopPolling();
              void refresh();
            } else if (result.status === "expired") {
              stopPolling();
              setPhase("expired");
            }
          })
          .catch(() => {
            stopPolling();
            setPhase("error");
          });
      }, POLL_INTERVAL_MS);
    } catch {
      setPhase("error");
    }
  }, [refresh, stopPolling]);

  const waitingForApproval = phase === "waiting" && userCode !== null;

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--bg-app)" }}>
      <header className="native-titlebar titlebar-drag absolute inset-x-0 top-0 z-10" style={{ height: "var(--titlebar-height)" }} />
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <BrandPanel
          title={<>Code on your<br />cloud computer</>}
          subtitle="Every user gets a private VPS with shell, files, apps, and AI agents."
          bullets={[
            { icon: <Cloud size={16} />, label: "No local setup required" },
            { icon: <GitBranch size={16} />, label: "Works with GitHub" },
            { icon: <Sparkles size={16} />, label: "Claude / Codex / OpenCode ready" },
          ]}
        />

        <div className="flex items-center justify-center p-8">
          <div className="fade-in flex w-[360px] flex-col gap-5">
            <div className="flex flex-col items-center gap-1.5 text-center">
              <h2 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
                {waitingForApproval ? "Finish in your browser" : "Connect Matrix Desktop"}
              </h2>
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                {waitingForApproval
                  ? "Approve this desktop in your browser. The page returns you to Matrix Desktop automatically."
                  : "Sign in or create an account in your browser, choose a Matrix computer, and the approval page returns you to Matrix Desktop automatically."}
              </p>
              {!waitingForApproval ? (
                <p className="mt-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
                  Eligible first-time hosted accounts may receive a free trial—3 days by default. Stripe Checkout confirms eligibility, trial length, and price before setup.
                </p>
              ) : null}
            </div>

            {waitingForApproval ? (
              <div className="flex flex-col items-center gap-4 rounded-xl border p-6" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
                <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  Confirm this code on the approval page:
                </span>
                <div
                  className="rounded-lg border px-5 py-3 font-mono text-xl tracking-[0.25em]"
                  style={{ borderColor: "var(--border-default)", background: "var(--bg-surface)", color: "var(--text-primary)" }}
                  data-selectable
                >
                  {userCode}
                </div>
                {verificationUri ? (
                  <button
                    type="button"
                    className="no-drag flex h-10 w-full items-center justify-center rounded-lg text-sm font-semibold transition-colors duration-100"
                    style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
                    onClick={() => void invoke("shell:open-external", { url: verificationUri })}
                  >
                    Open approval page
                  </button>
                ) : null}
                <span className="status-pulse text-xs" style={{ color: "var(--text-tertiary)" }}>
                  Waiting for browser approval…
                </span>
              </div>
            ) : (
              <>
                <div
                  className="flex flex-col gap-4 rounded-xl border p-5"
                  style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
                >
                  <div className="flex gap-3">
                    <ShieldCheck className="mt-0.5 shrink-0" size={18} aria-hidden style={{ color: "var(--accent)" }} />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                        Secure browser sign-in
                      </span>
                      <span className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                        Use your preferred sign-in method. Matrix Desktop never handles your password.
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <MonitorCheck className="mt-0.5 shrink-0" size={18} aria-hidden style={{ color: "var(--accent)" }} />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                        Choose your Matrix computer
                      </span>
                      <span className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                        Review the connection in your browser, then return here automatically.
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={phase === "starting"}
                  onClick={() => void start()}
                  className="no-drag flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors duration-100 disabled:opacity-60"
                  style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
                >
                  {phase === "starting" ? null : <ExternalLink size={16} aria-hidden />}
                  {phase === "starting" ? "Opening browser…" : "Continue in browser"}
                </button>

                {phase === "expired" ? (
                  <p className="text-center text-sm" style={{ color: "var(--warning)" }}>
                    Browser approval expired. Start a new request to try again.
                  </p>
                ) : null}
                {phase === "error" ? (
                  <p className="text-center text-sm" style={{ color: "var(--danger)" }}>
                    Couldn't start browser approval. Check your connection and try again.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
