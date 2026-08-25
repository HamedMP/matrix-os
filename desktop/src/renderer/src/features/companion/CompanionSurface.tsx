import { ArrowUp, ExternalLink, EyeOff, Minus, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { BrandLogo } from "../../design/BrandPanel";
import { invoke } from "../../lib/operator";
import type { CompanionHost } from "../../../../shared/companion";

type SendState = "idle" | "sending" | "sent" | "error";

export function CompanionSurface({ host = "rabbit" }: { host?: CompanionHost }) {
  const [expanded, setExpandedState] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sendState, setSendState] = useState<SendState>("idle");
  const collapseTimer = useRef<number | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.documentElement.dataset.surface = "companion";
    document.documentElement.dataset.companionHost = host;
    return () => {
      delete document.documentElement.dataset.surface;
      delete document.documentElement.dataset.companionHost;
      if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    };
  }, [host]);

  useEffect(() => {
    if (!expanded) return;
    const frame = window.requestAnimationFrame(() => promptRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [expanded]);

  const setExpanded = async (next: boolean) => {
    setMenuOpen(false);
    try {
      await invoke("companion:set-expanded", { host, expanded: next });
      setExpandedState(next);
      if (!next) setSendState("idle");
    } catch {
      setSendState("error");
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = prompt.trim();
    if (!normalized || sendState === "sending") return;
    setSendState("sending");
    try {
      await invoke("companion:submit-prompt", { prompt: normalized });
      setPrompt("");
      setSendState("sent");
      collapseTimer.current = window.setTimeout(() => {
        void setExpanded(false);
      }, 1_100);
    } catch {
      setSendState("error");
    }
  };

  const focusMain = () => {
    void invoke("companion:focus-main", {}).catch(() => setSendState("error"));
  };

  const hide = () => {
    setMenuOpen(false);
    void invoke("companion:hide", { host }).catch(() => setSendState("error"));
  };

  if (!expanded) {
    if (host === "notch") {
      return (
        <main className="companion-stage companion-stage-notch" aria-label="Matrix notch companion">
          <div
            className="companion-notch-bar titlebar-drag"
            onContextMenu={(event) => {
              event.preventDefault();
              setMenuOpen(true);
            }}
          >
            <button
              type="button"
              aria-label="Ask Hermes from the notch"
              className="companion-notch-trigger no-drag"
              onClick={() => void setExpanded(true)}
              onDoubleClick={focusMain}
            >
              <span className="companion-notch-wing" aria-hidden>
                <BrandLogo size={24} color="#fafaf5" />
              </span>
              <span className="companion-notch-camera-space" aria-hidden />
              <span className="companion-notch-wing" aria-hidden>
                <i />
              </span>
            </button>
          </div>
          {menuOpen ? (
            <div className="companion-context-menu companion-notch-menu no-drag" role="menu">
              <button type="button" role="menuitem" onClick={focusMain}>Open Matrix OS</button>
              <button type="button" role="menuitem" aria-label="Hide rabbit" onClick={hide}>Hide notch</button>
            </div>
          ) : null}
        </main>
      );
    }
    return (
      <main className="companion-stage companion-stage-collapsed" aria-label="Matrix rabbit companion">
        <div
          className="companion-orbit titlebar-drag"
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuOpen(true);
          }}
        >
          <button
            type="button"
            aria-label="Ask Hermes"
            className="companion-rabbit no-drag"
            onClick={() => void setExpanded(true)}
            onDoubleClick={focusMain}
          >
            <span className="companion-rabbit-glow" aria-hidden />
            <BrandLogo size={58} color="var(--brand-forest-foreground)" className="companion-rabbit-mark" />
            <span className="companion-presence" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Open Matrix OS"
            className="companion-open-main no-drag"
            onClick={focusMain}
          >
            <ExternalLink size={12} aria-hidden />
          </button>
        </div>
        {menuOpen ? (
          <div className="companion-context-menu no-drag" role="menu">
            <button type="button" role="menuitem" onClick={focusMain}>Open Matrix OS</button>
            <button type="button" role="menuitem" aria-label="Hide rabbit" onClick={hide}>Hide rabbit</button>
          </div>
        ) : null}
      </main>
    );
  }

  return (
    <main className={`companion-stage companion-stage-expanded ${host === "notch" ? "companion-stage-notch-expanded" : ""}`} aria-label={`Matrix ${host} companion`}>
      <section className={`companion-card ${host === "notch" ? "companion-card-notch" : ""}`}>
        <header className="companion-header titlebar-drag">
          <div className="companion-title">
            <span className="companion-mini-rabbit" aria-hidden>
              <BrandLogo size={29} color="var(--brand-forest-foreground)" />
            </span>
            <span>
              <strong>Hermes</strong>
              <small>{sendState === "sent" ? "Sent to Hermes" : "Ready when you are"}</small>
            </span>
          </div>
          <div className="companion-header-actions no-drag">
            <button type="button" aria-label="Open Matrix OS" onClick={focusMain}>
              <ExternalLink size={14} aria-hidden />
            </button>
            <button type="button" aria-label="Collapse rabbit" onClick={() => void setExpanded(false)}>
              <Minus size={15} aria-hidden />
            </button>
            <button type="button" aria-label="Hide rabbit" onClick={hide}>
              <X size={15} aria-hidden />
            </button>
          </div>
        </header>

        <form className="companion-composer" onSubmit={(event) => void submit(event)}>
          <textarea
            ref={promptRef}
            aria-label="Message Hermes"
            maxLength={4_000}
            rows={2}
            value={prompt}
            placeholder="Ask Hermes anything…"
            onChange={(event) => {
              setPrompt(event.currentTarget.value);
              if (sendState !== "idle") setSendState("idle");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button
            type="submit"
            aria-label="Send to Hermes"
            disabled={!prompt.trim() || sendState === "sending"}
          >
            <ArrowUp size={16} aria-hidden />
          </button>
        </form>

        <footer className="companion-footer">
          <span className={sendState === "error" ? "companion-error" : ""}>
            {sendState === "sending" ? "Handing off…" : sendState === "error" ? "Try again" : "⌘⇧Space toggles the rabbit"}
          </span>
          <button type="button" aria-label="Hide rabbit" onClick={hide}>
            <EyeOff size={12} aria-hidden /> Hide
          </button>
        </footer>
      </section>
    </main>
  );
}
