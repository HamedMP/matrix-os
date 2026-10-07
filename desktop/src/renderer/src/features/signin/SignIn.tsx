import { ArrowRight, ExternalLink, ShieldCheck } from "@renderer/lib/hugeicons";
import { BrandCard, desktopFonts, desktopPalette, palette } from "@matrix-os/brand";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { WelcomeScene } from "./WelcomeScene";
import "./signin.css";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";

type Phase = "idle" | "starting" | "waiting" | "expired" | "error";
type AuthIntent = "sign-up" | "sign-in";

const POLL_INTERVAL_MS = 2000;

export default function SignIn() {
  const refresh = useConnection((s) => s.refresh);
  const [intent, setIntent] = useState<AuthIntent>("sign-up");
  const [browserOpenFailed, setBrowserOpenFailed] = useState(false);
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

  const openBrowser = useCallback(async (url: string) => {
    setBrowserOpenFailed(false);
    try {
      await invoke("shell:open-external", { url });
    } catch (error: unknown) {
      console.warn("[signin] browser approval open failed", error instanceof Error ? error.name : "Unknown error");
      setBrowserOpenFailed(true);
    }
  }, []);

  const start = useCallback(async (intent: AuthIntent) => {
    setIntent(intent);
    setBrowserOpenFailed(false);
    setPhase("starting");
    try {
      const code = await invoke("auth:start-device-flow", { intent });
      setUserCode(code.userCode);
      setVerificationUri(code.verificationUri);
      setPhase("waiting");
      // Browser launch is best-effort. The verification code and reopen action
      // remain available if the OS blocks the first attempt.
      void openBrowser(code.verificationUri);
      stopPolling();
      pollTimer.current = setInterval(() => {
        void invoke("auth:poll", {})
          .then((result) => {
            if (result.status === "authorized") {
              stopPolling();
              void refresh().catch(() => setPhase("error"));
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
  }, [openBrowser, refresh, stopPolling]);

  const waitingForApproval = phase === "waiting" && userCode !== null;

  const brandStyle = {
    "--signin-teal": desktopPalette.forest,
    "--signin-hover": desktopPalette.forestHover,
    "--signin-paper": desktopPalette.paper,
    "--signin-canvas": desktopPalette.canvas,
    "--signin-ink": palette.brandInk,
    "--signin-muted": desktopPalette.textMuted,
    "--signin-border": palette.cream,
    "--signin-green": desktopPalette.green,
    "--signin-gold": desktopPalette.gold,
    "--signin-danger": desktopPalette.danger,
    "--signin-heading": desktopFonts.display,
    fontFamily: desktopFonts.sans,
  } as CSSProperties;

  return (
    <div className="signin" style={brandStyle}>
      <header className="native-titlebar titlebar-drag signin-titlebar" />
      <WelcomeScene />
      <main className="signin-main" aria-labelledby="signin-title">
        <div className="signin-content">
          <div className="signin-intro">
            <span className="signin-eyebrow">YOUR SPACE TO BEGIN</span>
            <h1 id="signin-title">{waitingForApproval ? "One more step." : "Welcome to Matrix OS"}</h1>
            <p className="signin-description">
              {waitingForApproval
                ? `${intent === "sign-up" ? "Create your account" : "Sign in"} in your browser. We'll bring you back here when you're ready.`
                : "A home for your ideas, your work, and your AI. Let's get you settled in."}
            </p>
          </div>

          {waitingForApproval ? (
            <>
              <BrandCard className="signin-approval" style={{ borderColor: palette.cream, boxShadow: "none", borderRadius: 16 }}>
                <div className="signin-step-icon"><ExternalLink size={22} aria-hidden /></div>
                <h2>Check your browser</h2>
                <p>Match this code on the approval page, then connect your computer.</p>
                <div className="signin-code" data-selectable aria-label="Approval code">{userCode}</div>
                {verificationUri ? (
                  <button type="button" className="no-drag signin-button signin-primary" onClick={() => void openBrowser(verificationUri)}>
                    Open browser again <ExternalLink size={16} aria-hidden />
                  </button>
                ) : null}
                <span role="status" className="signin-waiting"><span aria-hidden />Waiting for you to finish…</span>
              </BrandCard>
              {browserOpenFailed ? (
                <div role="alert" className="signin-error">
                  Couldn't open your browser. Try again, or copy this link into your browser:
                  <p className="signin-error-link" data-selectable>{verificationUri}</p>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="signin-actions" aria-busy={phase === "starting"}>
                <button type="button" disabled={phase === "starting"} onClick={() => void start("sign-up")} className="no-drag signin-button signin-primary">
                  {phase === "starting" && intent === "sign-up" ? "Opening browser…" : "Create account"}
                  <ArrowRight size={18} aria-hidden />
                </button>
                <span className="signin-existing">Already have an account?</span>
                <button type="button" disabled={phase === "starting"} onClick={() => void start("sign-in")} className="no-drag signin-button signin-secondary">
                  {phase === "starting" && intent === "sign-in" ? "Opening browser…" : "Sign in"}
                </button>
              </div>
              {phase === "expired" ? <p role="alert" className="signin-error">This sign-in request expired. Choose Create account or Sign in to try again.</p> : null}
              {phase === "error" ? <p role="alert" className="signin-error">Couldn't connect. Check your connection and try again.</p> : null}
              <div className="signin-browser-note">
                <ShieldCheck size={18} aria-hidden />
                <p>Continue securely in your browser.<br />You'll come back here automatically.</p>
              </div>
            </>
          )}
        </div>
        <p className="signin-footer">Your ideas. Your computer. Your rules.</p>
      </main>
    </div>
  );
}
