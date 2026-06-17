import { Cloud, GitBranch, Sparkles, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandPanel } from "../../design/BrandPanel";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";

type Tab = "signin" | "create";
type Phase = "idle" | "starting" | "waiting" | "expired" | "error";

const POLL_INTERVAL_MS = 2000;

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

function GitHubGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export default function SignIn() {
  const refresh = useConnection((s) => s.refresh);
  const [tab, setTab] = useState<Tab>("signin");
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

  // Every provider button opens the same device-auth browser flow; the browser
  // presents Google/GitHub/email via Clerk. The desktop app never handles a
  // password directly.
  const start = useCallback(async () => {
    setPhase("starting");
    try {
      const code = await invoke("auth:start-device-flow", {});
      setUserCode(code.userCode);
      setVerificationUri(code.verificationUri);
      setPhase("waiting");
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

  const oauthButton = (glyph: React.ReactNode, label: string) => (
    <button
      type="button"
      disabled={phase === "starting"}
      onClick={() => void start()}
      className="no-drag flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border text-sm font-medium transition-colors duration-100 disabled:opacity-60"
      style={{ borderColor: "var(--border-default)", background: "var(--bg-surface)", color: "var(--text-primary)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-surface)")}
    >
      {glyph}
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--bg-app)" }}>
      <header className="titlebar-drag absolute inset-x-0 top-0 z-10" style={{ height: "var(--titlebar-height)" }} />
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
                Welcome to Matrix OS
              </h2>
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Sign in to your account or create a new one to get started.
              </p>
            </div>

            {phase === "waiting" && userCode ? (
              <div className="flex flex-col items-center gap-4 rounded-xl border p-6" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
                <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  Approve this code in your browser:
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
                  Waiting for approval…
                </span>
              </div>
            ) : (
              <>
                <div className="flex rounded-lg border p-1" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
                  {(["signin", "create"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTab(t)}
                      className="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors duration-100"
                      style={{
                        background: tab === t ? "var(--bg-surface)" : "transparent",
                        color: tab === t ? "var(--text-primary)" : "var(--text-secondary)",
                        boxShadow: tab === t ? "var(--shadow-1)" : "none",
                      }}
                    >
                      {t === "signin" ? "Sign in" : "Create account"}
                    </button>
                  ))}
                </div>

                <div className="flex flex-col gap-2.5">
                  {oauthButton(<GoogleGlyph />, "Continue with Google")}
                  {oauthButton(<GitHubGlyph />, "Continue with GitHub")}
                </div>

                <div className="flex items-center gap-3">
                  <div className="h-px flex-1" style={{ background: "var(--border-subtle)" }} />
                  <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>or continue with email</span>
                  <div className="h-px flex-1" style={{ background: "var(--border-subtle)" }} />
                </div>

                <button
                  type="button"
                  disabled={phase === "starting"}
                  onClick={() => void start()}
                  className="no-drag flex h-11 w-full items-center justify-center rounded-lg text-sm font-semibold transition-colors duration-100 disabled:opacity-60"
                  style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
                >
                  {phase === "starting" ? "Starting…" : tab === "signin" ? "Sign in" : "Create account"}
                </button>

                {phase === "expired" ? (
                  <p className="text-center text-sm" style={{ color: "var(--warning)" }}>
                    Sign-in request expired. Try again.
                  </p>
                ) : null}
                {phase === "error" ? (
                  <p className="text-center text-sm" style={{ color: "var(--danger)" }}>
                    Can't reach Matrix OS. Check your connection.
                  </p>
                ) : null}

                <p className="text-center text-sm" style={{ color: "var(--text-secondary)" }}>
                  {tab === "signin" ? "New to Matrix OS? " : "Already have an account? "}
                  <button type="button" className="font-medium" style={{ color: "var(--highlight)" }} onClick={() => setTab(tab === "signin" ? "create" : "signin")}>
                    {tab === "signin" ? "Create an account" : "Sign in"}
                  </button>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
